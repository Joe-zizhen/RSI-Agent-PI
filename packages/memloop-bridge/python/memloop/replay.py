"""Offline replay evaluator: score candidate policies against recorded
history before deploying anything (Dream-RSI's dreaming phase, applied to
memloop's loop parameters).

The trace log (Store.log_trace) records every loop step with its inputs and
outputs. From it we reconstruct *episodes*: a retrieval moment, the candidate
claims in front of the agent, which claim was used, and the world's verdict
(I5: the only error signal). A candidate Policy re-ranks each recorded
candidate set; a policy scores by agreeing with recorded outcomes.

select_policy() always includes the incumbent in the candidate pool and
breaks ties toward it -- so the winner is never worse than what is running
on the replay score (the same never-worse trick as Dream-RSI, arXiv:2609.14858).

Known limit (same identifiability gap the memory literature keeps hitting):
outcomes exist only for claims that were actually used. Picks the replay
never made are unscoreable -- the evaluator measures "would this policy have
agreed with decisions the world already graded", not counterfactual quality.

Consequence of that limit: a 0 score conflates "would have picked something
else good" with "would have picked garbage", so a policy can improve its
score by *abstaining* (never matching any graded decision) -- on
failure-heavy history the do-nothing policy beats everything. select_policy
therefore requires a challenger to show >=1 graded agreement before it may
displace the incumbent: an untested policy is not a validated policy.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .core import Store
from .policy import Policy


@dataclass(frozen=True)
class Episode:
    """One graded decision: context + candidates + what was used + verdict.

    ``injected_ids`` is the L0 picked set of that moment; ``guard_events``
    holds the action-time gate decisions of the same window
    ({claim_id, level, overridden, call_key}); ``verdict`` is the booked
    world outcome ("win"/"loss"/None) and ``verdict_source`` where it came
    from ("t1"/"t2a"/"t2b")."""

    context: str
    candidates: tuple[dict, ...]   # snapshot dicts from the retrieve trace
    used_id: str | None
    success: bool | None
    ts: float
    injected_ids: tuple[str, ...] = ()
    guard_events: tuple[dict, ...] = ()
    verdict: str | None = None
    verdict_source: str | None = None


def _guard_events(window: list[tuple[str, dict]]) -> list[dict]:
    """Guard/override traces of one window into guard-event dicts. An
    override marks every earlier hit on the same claim as overridden."""
    out: list[dict] = []
    for op, payload in window:
        if op == "guard":
            out.append({
                "claim_id": payload.get("claim"),
                "level": payload.get("level"),
                "overridden": False,
                "call_key": payload.get("call_key"),
            })
            continue
        cid = payload.get("claim")
        for ev in out:
            if ev["claim_id"] == cid:
                ev["overridden"] = True
    return out


def _episode_from_outcome(r_ts: float, r_payload: dict, payload: dict,
                         window: list[tuple[str, dict]]) -> Episode | None:
    """One outcome trace into an Episode, or None when the used claim is
    missing from the paired retrieve's candidates (no guessing)."""
    candidates = tuple(r_payload.get("candidates", ()))
    used = payload.get("claim")
    if used is None or not any(c.get("id") == used for c in candidates):
        return None
    success = payload.get("success")
    success = success if isinstance(success, bool) else None
    verdict = payload.get("verdict")
    if verdict not in ("win", "loss"):
        # legacy outcome rows carry only success: a boolean success IS the
        # world verdict
        verdict = ("win" if success else "loss") if success is not None else None
    return Episode(
        context=str(r_payload.get("context", "")),
        candidates=candidates,
        used_id=used,
        success=success,
        ts=r_ts,
        injected_ids=tuple(r_payload.get("picked", ())),
        guard_events=tuple(_guard_events(window)),
        verdict=verdict,
        verdict_source=payload.get("source"),
    )


def _window_retrieve(state: "_WindowState", payload: dict) -> None:
    state.context = state.context or str(payload.get("context", ""))
    for c in payload.get("candidates", ()):
        state.candidates.setdefault(c["id"], c)
    for cid in payload.get("picked", ()):
        if cid not in state.injected:
            state.injected.append(cid)


def _absorb_window_row(state: "_WindowState", op: str, row_ts: float,
                       payload: dict) -> None:
    """Fold one window trace row into the accumulating episode state."""
    if op == "episode_start":
        state.ts = row_ts
        state.context = str(payload.get("prompt", ""))
    elif op == "retrieve":
        _window_retrieve(state, payload)
    elif op in ("guard", "override"):
        state.guard.append((op, payload))
    elif op == "outcome":
        if state.used_id is None:
            state.used_id = payload.get("claim")
            s = payload.get("success")
            state.success = s if isinstance(s, bool) else None
    elif op in ("verdict", "episode_end"):
        v = payload.get("verdict")
        if v in ("win", "loss", "unknown"):
            # last world verdict wins; pending/repeat book nothing
            state.verdict, state.source = v, payload.get("source")


@dataclass
class _WindowState:
    ts: float = 0.0
    context: str = ""
    candidates: dict = field(default_factory=dict)
    injected: list = field(default_factory=list)
    guard: list = field(default_factory=list)
    used_id: str | None = None
    success: bool | None = None
    verdict: str | None = None
    source: str | None = None


def _episode_from_window(rows: list[tuple[int, float, str, dict]]) -> Episode:
    """One task window into one Episode (plan 5.2: one task = one episode).
    The window spans episode_start .. episode_end plus any late trace
    stamped with the same episode_id (T2 bookings after close). Multiple
    booked claims stay one episode: the window is the graded unit."""
    state = _WindowState()
    for _, row_ts, op, payload in rows:
        _absorb_window_row(state, op, row_ts, payload)
    return Episode(
        context=state.context,
        candidates=tuple(state.candidates.values()),
        used_id=state.used_id,
        success=state.success,
        ts=state.ts,
        injected_ids=tuple(state.injected),
        guard_events=tuple(_guard_events(state.guard)),
        verdict=state.verdict,
        verdict_source=state.source,
    )


def _legacy_episodes(rows: list[tuple[int, float, str, dict]]) -> list[Episode]:
    """Pre-episode-window traces: pair each outcome with the nearest
    preceding retrieve (kept verbatim for bench/demo logs without windows)."""
    episodes: list[Episode] = []
    last_retrieve: tuple[float, dict] | None = None
    window: list[tuple[str, dict]] = []
    for _, ts, op, payload in rows:
        if op == "retrieve":
            last_retrieve = (ts, payload)
        elif op in ("guard", "override"):
            window.append((op, payload))
        elif op == "outcome" and last_retrieve is not None:
            ep = _episode_from_outcome(last_retrieve[0], last_retrieve[1],
                                       payload, window)
            if ep is not None:
                episodes.append(ep)
                window = []
    return episodes


def episodes_from_traces(traces: list[tuple[int, float, str, dict]]) -> list[Episode]:
    """Rebuild episodes from the trace log.

    Rows carrying an episode_id (or the episode_start/episode_end markers)
    form one Episode per task window: every outcome of the window belongs to
    that episode, and its guard/override rows become the guard_events. Rows
    without window markers fall back to the legacy nearest-retrieve pairing,
    so pre-window bench logs keep their old meaning.
    """
    windows: dict[str, list[tuple[int, float, str, dict]]] = {}
    order: list[str] = []
    legacy: list[tuple[int, float, str, dict]] = []
    for row in traces:
        _, ts, op, payload = row
        eid = payload.get("episode_id") if isinstance(payload, dict) else None
        if op in ("episode_start", "episode_end"):
            eid = payload.get("episode_id") or eid
        if eid is None:
            legacy.append(row)
            continue
        if eid not in windows:
            windows[eid] = []
            order.append(eid)
        windows[eid].append(row)
    episodes = [_episode_from_window(windows[eid]) for eid in order]
    episodes.extend(_legacy_episodes(legacy))
    return episodes


def _rank(policy: Policy, ep: Episode) -> list[str]:
    """Re-rank one recorded candidate set under a policy, mirroring the live
    retriever exactly: score > 0 gate first, then older-first tie break.
    A policy that would have injected nothing live must rank nothing here."""
    scored = []
    for c in ep.candidates:
        s = policy.score(
            key=c["key"], text=c["text"], confidence=c["confidence"],
            hearsay=c["hearsay"], created_at=c["created_at"],
            ctx=ep.context, now=ep.ts,
            sem=c.get("sem"),
        )
        if s > 0:
            scored.append((s, c["created_at"], c["id"]))
    scored.sort(key=lambda t: (-t[0], t[1]))  # tie-break: older first, live order
    return [cid for _, _, cid in scored]


def _guard_points(ep: Episode) -> float:
    """L2 channel for one episode. Only real interceptions (level l2)
    score: a passing L1 reminder is not a block decision. Overridden + win
    -> -1 (the block was noise); overridden + loss -> +1 (the block was
    right); standing block that was never overridden + win -> +1."""
    total = 0.0
    for ev in ep.guard_events:
        if ev.get("level") != "l2":
            continue
        overridden = bool(ev.get("overridden"))
        if overridden and ep.verdict == "win":
            total -= 1.0
        elif overridden and ep.verdict == "loss":
            total += 1.0
        elif not overridden and ep.verdict == "win":
            total += 1.0
    return total


def replay_score(policy: Policy, episodes: list[Episode]) -> float:
    """Mean agreement with recorded outcomes over graded episodes.

    L0 (unchanged): +1 top pick == used claim and success, -1 on failure,
    0 on a different pick (counterfactual: unscoreable).
    L2: each guard event of a verdicted episode scores per _guard_points.
    Total = the graded-count weighted mean of the two channel means, i.e.
    (L0 points + L2 points) / (L0 graded + L2 graded). Episodes without a
    verdict are never scored and never dilute. Returns 0.0 on an empty or
    fully ungraded history.
    """
    l0_points, l0_n = 0.0, 0
    l2_points, l2_n = 0.0, 0
    for ep in episodes:
        if ep.used_id is not None and ep.success is not None:
            l0_n += 1
            ranked = _rank(policy, ep)
            if ranked and ranked[0] == ep.used_id:
                l0_points += 1.0 if ep.success else -1.0
        pts, n = _l2_totals(ep)
        l2_points += pts
        l2_n += n
    total_n = l0_n + l2_n
    return (l0_points + l2_points) / total_n if total_n else 0.0


def _l2_totals(ep: Episode) -> tuple[float, int]:
    """L2 channel of one episode: points and 1 when the episode is
    L2-graded (a verdict plus at least one real interception), else 0, 0 --
    an episode without interceptions never dilutes the L2 mean."""
    if ep.verdict not in ("win", "loss"):
        return 0.0, 0
    if not any(ev.get("level") == "l2" for ev in ep.guard_events):
        return 0.0, 0
    return _guard_points(ep), 1


def select_policy(
    incumbent: Policy,
    candidates: list[Policy],
    episodes: list[Episode],
) -> tuple[Policy, dict[str, float]]:
    """Pick the best-scoring policy on the replay. Guarantees:

    * the incumbent is always in the pool and ties favor it, so
      score(winner) >= score(incumbent) -- a validated change is never a
      regression on recorded history;
    * a challenger may only displace the incumbent with at least one graded
      agreement (its top pick matched a claim the world actually graded).
      A policy that never touches graded history scores by abstention alone
      and has no evidence -- it cannot be deployed.

    Name is identity: a later candidate whose name is already in the pool is
    ignored (first occurrence wins), so ``scores[name]`` always describes the
    object that can actually be selected.

    Returns (winner, {policy_name: score}) for the audit trail.
    """
    pool: list[Policy] = []
    seen: set[str] = set()
    for p in [incumbent, *candidates]:
        if p.name in seen:
            continue
        seen.add(p.name)
        pool.append(p)
    scores = {p.name: replay_score(p, episodes) for p in pool}
    best = incumbent
    for p in pool[1:]:
        if _agreements(p, episodes) < 1:
            continue  # no graded agreement -> abstention score is not evidence
        if scores[p.name] > scores[best.name]:
            best = p
    return best, scores


def _agreements(policy: Policy, episodes: list[Episode]) -> int:
    """How many graded episodes had this policy's top pick == the used claim.
    This is the evidence count: episodes where the world graded what the
    policy would have committed to."""
    n = 0
    for ep in episodes:
        if ep.used_id is None or ep.success is None:
            continue
        ranked = _rank(policy, ep)
        if ranked and ranked[0] == ep.used_id:
            n += 1
    return n


# --- dreaming: generate candidates, run the loop, publish policy.json -----


def _mutants(incumbent: Policy, field_name: str, steps: tuple[float, ...],
             lo: float | None, hi: float | None) -> list[Policy]:
    """One field, +/- each step, clamped to [lo, hi]. No-op values are
    dropped so every candidate differs from the incumbent on its axis."""
    out: list[Policy] = []
    base = getattr(incumbent, field_name)
    for step in steps:
        for sign in (1.0, -1.0):
            val = base + sign * step
            if lo is not None:
                val = max(lo, val)
            if hi is not None:
                val = min(hi, val)
            if isinstance(base, int) and not isinstance(base, bool):
                val = int(round(val))
            if val == base:
                continue
            out.append(incumbent.variant(
                f"cand_{field_name}_{val:g}", **{field_name: val}))
    return out


def generate_candidates(incumbent: Policy) -> list[Policy]:
    """Single-field grid mutants of the incumbent: the five guidance fields
    plus the ranking weights, each jittered 1-2 steps up and down. One axis
    per candidate so the replay can attribute a score change to one knob."""
    out: list[Policy] = []
    out += _mutants(incumbent, "w_overlap", (0.5, 1.0), None, None)
    out += _mutants(incumbent, "w_confidence", (0.5, 1.0), None, None)
    out += _mutants(incumbent, "w_recency", (0.5, 1.0), None, None)
    out += _mutants(incumbent, "w_semantic", (0.25, 0.5), 0.0, None)
    out += _mutants(incumbent, "hearsay_penalty", (0.25, 0.5), None, None)
    out += _mutants(incumbent, "l1_min_confidence", (0.05, 0.1), 0.0, 1.0)
    out += _mutants(incumbent, "l2_min_confidence", (0.05, 0.1), 0.0, 1.0)
    out += _mutants(incumbent, "l2_min_outcomes", (1.0, 2.0), 0.0, None)
    out += _mutants(incumbent, "injection_max_chars", (400.0, 800.0), 200.0, None)
    out.append(incumbent.variant(
        f"cand_l2_require_verify_{not incumbent.l2_require_verify}",
        l2_require_verify=not incumbent.l2_require_verify))
    return out


def _graded_count(episodes: list[Episode]) -> int:
    return sum(1 for e in episodes if e.verdict in ("win", "loss"))


def _last_dream_graded(store: Store) -> int:
    rows = store.traces("dream")
    return int(rows[-1][3].get("graded_total", 0)) if rows else 0


def _policy_dir(store: Store) -> Path | None:
    """Directory holding policy.json (next to the database). A memory-backed
    store has none: nothing is published there."""
    if not store.path or store.path == ":memory:":
        return None
    return Path(store.path).resolve().parent


def _publish_policy(store: Store, winner: Policy, previous: Policy) -> bool:
    """Atomic publish: park the incumbent in policy.prev.json first so
    /dreaming can veto and roll back, then swap in policy.json."""
    d = _policy_dir(store)
    if d is None:
        return False
    (d / "policy.prev.json").write_text(
        json.dumps(asdict(previous), indent=2), encoding="utf-8")
    path = d / "policy.json"
    tmp = path.with_name("policy.json.tmp")
    tmp.write_text(json.dumps(asdict(winner), indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return True


def _rollback_policy(store: Store, incumbent: Policy) -> dict:
    """Human veto path: restore policy.prev.json over policy.json and hand
    the restored fields back for the /dreaming report."""
    d = _policy_dir(store)
    prev = d / "policy.prev.json" if d is not None else None
    if prev is None or not prev.is_file():
        return {"ran": False, "winner": incumbent.name, "scores": {},
                "changed": False, "policy": None}
    data = json.loads(prev.read_text(encoding="utf-8"))
    path = d / "policy.json"
    tmp = path.with_name("policy.json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return {"ran": False, "winner": data.get("name", ""),
            "scores": {}, "changed": True, "policy": data}


def run_dream(store: Store, incumbent: Policy, episodes: list[Episode],
              force: bool = False, rollback: bool = False) -> dict:
    """One dreaming pass: gate on fresh evidence, mutate, replay, publish.

    Runs only when the graded episodes added since the last dream reach 20,
    or when forced -- below that the replay cannot tell a real improvement
    from noise. The winner is published to policy.json (previous kept in
    policy.prev.json) only when it beats the incumbent; the running process
    keeps its policy until restart, so a human can veto -- rollback=True
    restores the parked previous policy. Returns the audit dict
    {ran, winner, scores, changed} (rollback also returns the policy fields).
    """
    if rollback:
        return _rollback_policy(store, incumbent)
    graded_total = _graded_count(episodes)
    if not force and graded_total - _last_dream_graded(store) < 20:
        return {"ran": False, "winner": incumbent.name, "scores": {},
                "changed": False}
    winner, scores = select_policy(incumbent, generate_candidates(incumbent),
                                   episodes)
    changed = False
    if winner.name != incumbent.name:
        changed = _publish_policy(store, winner, incumbent)
    store.log_trace("dream", {
        "ran": True, "winner": winner.name, "scores": scores,
        "changed": changed, "graded_total": graded_total,
    })
    return {"ran": True, "winner": winner.name, "scores": scores,
            "changed": changed}
