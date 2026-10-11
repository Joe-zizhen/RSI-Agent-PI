"""memloop loops: the five-loop policy around core.Store.

  capture     deterministic event append + narrow salience tagging
  cardify     turn salient events into claim cards (provenance required)
  retrieve    situational injection: context match + confidence + verify_cmd
  guard       action-time gate: L2 hard block / L1 reminder on tool calls
  verify      usage-time fact check against an external oracle (command)
  consolidate periodic replay: evict unused, decay hearsay, promote lessons
  outcome     world feedback -> confidence (the only confidence writer)

The LLM is a *labeler* here, not a decider: nothing in this module asks a
model "is this worth saving". Salience comes from friction signals only.
"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass, field

from .core import (
    Claim,
    ClaimKind,
    ClaimStatus,
    Event,
    EventKind,
    Store,
)
from .policy import DEFAULT_POLICY, Policy, match_count
from .promote_skill import write_skill

# Salience: everything except chatter. Objective events (observations of
# file/cmd/test state, corrections, instructions, failure->fix) are always
# cardifiable -- capture is deterministic; the LLM only labels.
SALIENT_KINDS = frozenset(
    {
        EventKind.USER_CORRECTION,
        EventKind.EXPLICIT_INSTRUCTION,
        EventKind.FAILURE_FIX,
        EventKind.TASK_OUTCOME,
        EventKind.OBSERVATION,
    }
)

# kind of claim expected per salient event kind
_EVENT_TO_CLAIM_KIND = {
    EventKind.USER_CORRECTION: ClaimKind.CONFIG,
    EventKind.EXPLICIT_INSTRUCTION: ClaimKind.CONFIG,
    EventKind.FAILURE_FIX: ClaimKind.EXPERIENCE,
    EventKind.TASK_OUTCOME: ClaimKind.EXPERIENCE,
    EventKind.OBSERVATION: ClaimKind.KNOWLEDGE,
}

# promotion threshold: a lesson used this many times with a verify_cmd
# becomes a procedure (code/test/check) and leaves the claim store.
PROMOTE_AFTER_SUCCESSES = 3  # legacy alias; the knob lives in Policy

# display budget per card in the injection block; storage is never truncated
CARD_DISPLAY_MAX_CHARS = 600

# standing usage rules; injected with every non-empty block so the model is
# taught how to treat the cards, not just handed data
USAGE_RULES = (
    "长期记忆卡。每条带置信度（0 至 1）与验证方式。\n"
    "使用规则：置信度低于 0.70 时先执行 verify 命令确认。hearsay 条目仅作线索。\n"
    "与当前任务无关的条目请忽略。需要更多记忆时调用 memory_search。"
)

# only these tool families carry a machine-decidable argument to match
_GUARD_COMMAND_TOOLS = frozenset({"bash", "powershell"})
_GUARD_PATH_TOOLS = frozenset({"read", "edit", "write"})


@dataclass
class RetrieveResult:
    claims: list[Claim]
    conflicts: dict[str, list[str]]
    injected: str  # what actually goes into the prompt


@dataclass
class GuardDecision:
    """One action-time gate decision. level is "none" (free pass), "l1"
    (soft reminder, not blocked) or "l2" (hard block)."""

    level: str
    claim_id: str | None
    message: str | None
    blocked: bool


@dataclass
class ConsolidateReport:
    evicted: list[str] = field(default_factory=list)
    decayed: list[str] = field(default_factory=list)
    promoted: list[str] = field(default_factory=list)
    skills_written: list[str] = field(default_factory=list)


def _guard_target(tool_name: str, args: dict) -> str | None:
    """The single machine-checkable argument of a tool call, or None for
    every tool without one (those get level=none, zero semantic judgment)."""
    if tool_name in _GUARD_COMMAND_TOOLS:
        val = args.get("command")
    elif tool_name in _GUARD_PATH_TOOLS:
        val = args.get("path")
    else:
        return None
    return val if isinstance(val, str) and val else None


def _card_line(c: Claim, conflicted: bool) -> str:
    conf = f"{c.confidence:.2f}"
    tag = "HEARSAY" if c.hearsay else f"verify: {c.verify_cmd}"
    flag = " CONFLICTED" if conflicted else ""
    text = c.text
    if len(text) > CARD_DISPLAY_MAX_CHARS:
        text = text[:CARD_DISPLAY_MAX_CHARS] + "（全文见 memory_search）"
    return f"- ({c.key}) {text} [{conf} {tag}]{flag}"


def _l2_message(c: Claim) -> str:
    return (
        "[memloop 硬拦截] 命中已验证的失败模式。\n"
        f"记忆卡 ({c.key}) 置信度 {c.confidence:.2f}"
        f"（{len(c.outcomes)} 次世界判决）。\n"
        f"原文：{c.text}\n"
        f"建议：先运行 verify 确认 {c.verify_cmd} 仍有效，"
        "改用卡片中的正确做法。\n"
        f"例外通道：如确认本次属例外，调用 memory_override"
        f'(claim_id="{c.id}", reason="...") 后重试本命令。'
    )


def _l1_message(c: Claim) -> str:
    check = (f"verify: {c.verify_cmd}" if c.verify_cmd
             else "无 verify_cmd（HEARSAY 条目仅作线索）")
    return (
        f"[memloop 提醒] 本次调用命中记忆卡 ({c.key}) 的失败模式"
        f" [{c.confidence:.2f}]。\n"
        f"建议核对：{check}"
    )


class Memory:
    def __init__(self, store: Store, session: str = "",
                 policy: "Policy | None" = None,
                 project_root: str | None = None) -> None:
        self.store = store
        self.session = session
        self.policy = policy if policy is not None else DEFAULT_POLICY
        self.project_root = project_root
        # session-scoped guard state, never persisted: one block per
        # (claim, call_key), plus the explicit-override allowlist
        self._blocked_once: set[tuple[str, str]] = set()
        self._override_allowlist: set[str] = set()
        self._overridden_this_episode: set[str] = set()
        self._episode_id: str | None = None
        # episode attribution set (insertion ordered)
        self._episode_claims: dict[str, None] = {}

    # -- loop 1: capture --------------------------------------------------

    def capture(
        self,
        kind: EventKind,
        payload: dict,
        ts: float | None = None,
        origin_key: str | None = None,
        session: str | None = None,
    ) -> Event:
        """Append-only objective log. Never fails, never summarizes.
        origin_key makes re-imports idempotent (at-least-once delivery)."""
        return self.store.append_event(
            kind, payload, ts=ts,
            session=self.session if session is None else session,
            origin_key=origin_key,
        )

    def capture_correction(self, text: str, ts: float | None = None) -> Event:
        return self.capture(EventKind.USER_CORRECTION, {"text": text}, ts=ts)

    def capture_instruction(self, text: str, ts: float | None = None) -> Event:
        return self.capture(EventKind.EXPLICIT_INSTRUCTION, {"text": text}, ts=ts)

    def capture_failure_fix(
        self, text: str, verify_cmd: str | None = None, ts: float | None = None
    ) -> Event:
        return self.capture(
            EventKind.FAILURE_FIX, {"text": text, "verify_cmd": verify_cmd}, ts=ts
        )

    def capture_chatter(self, text: str, ts: float | None = None) -> Event:
        return self.capture(EventKind.CHATTER, {"text": text}, ts=ts)

    # -- loop 2: cardify --------------------------------------------------

    def cardify(
        self,
        event_id: str,
        key: str,
        text: str | None = None,
        claim_kind: ClaimKind | None = None,
        verify_cmd: str | None = None,
        match_pattern: str | None = None,
        ts: float | None = None,
    ) -> Claim | None:
        """Make a claim card from a salient event.

        Returns None for non-salient events (chatter stays in the log only).
        LLM may supply ``text``/``key``/``verify_cmd`` as *labels*; the
        decision of what to store was already made by the event's kind.
        """
        ev = self.store.event(event_id)
        if ev is None:
            raise KeyError(event_id)
        if ev.kind not in SALIENT_KINDS:
            return None
        claim_text = text if text is not None else ev.text
        verify = verify_cmd if verify_cmd is not None else ev.payload.get("verify_cmd")
        claim = self.store.add_claim(
            key=key,
            text=claim_text,
            kind=claim_kind or _EVENT_TO_CLAIM_KIND[ev.kind],
            source_event_ids=[event_id],
            created_at=ts,
            verify_cmd=verify,
            ttl_s=self.policy.ttl_s,
            match_pattern=match_pattern,
        )
        # a correction supersedes prior non-terminal claims on the same key
        # (I4: explicit, not silent coexistence -- including dormant ones,
        # which would otherwise revive into a zombie conflict)
        if ev.kind == EventKind.USER_CORRECTION:
            for other in self.store.claims(key=key):
                if other.id != claim.id and other.status in (
                    ClaimStatus.ACTIVE,
                    ClaimStatus.CONFLICTED,
                    ClaimStatus.DORMANT,
                ):
                    self.store.resolve_conflict(
                        key, claim.id, reason=f"correction event {event_id}"
                    )
                    break
        self.store.log_trace("cardify", {
            "claim": claim.id, "key": key, "event": event_id,
            "kind": claim.kind.value,
        }, ts=ts)
        return claim

    # -- loop 3: retrieve -------------------------------------------------

    def retrieve(
        self,
        context: str,
        limit: int | None = None,
        now: float | None = None,
        include_dormant: bool = False,
    ) -> RetrieveResult:
        """Situational injection. Ranking is whatever ``self.policy`` says
        (deterministic rules; the offline replay may swap the policy).
        Conflicts surface instead of being hidden.

        Dormant (demoted) claims are excluded by default but recoverable:
        pass include_dormant=True to resurface them -- usage revives them
        (I3: demotion is reversible, deletion is not).
        """
        now = time.time() if now is None else now
        ctx = context.lower()
        allowed = {ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED}
        if include_dormant:
            allowed.add(ClaimStatus.DORMANT)
        scored: list[tuple[float, Claim]] = []
        for c in self.store.claims():
            if c.status not in allowed:
                continue
            score = self._score(c, ctx, now)
            if score > 0:
                scored.append((score, c))
        scored.sort(key=lambda t: (-t[0], t[1].created_at))
        picked = [c for _, c in scored[: self.policy.limit if limit is None else limit]]
        conflicts = self.store.active_conflicts()
        # structured log: candidate snapshot, so the offline replay can
        # re-rank exactly what was in front of the agent at that moment
        self._log("retrieve", {
            "context": context,
            "policy": self.policy.name,
            "picked": [c.id for c in picked],
            "candidates": [
                {"id": c.id, "key": c.key, "text": c.text,
                 "confidence": c.confidence, "hearsay": c.hearsay,
                 "created_at": c.created_at}
                for _, c in scored
            ],
        }, ts=now)
        return RetrieveResult(
            claims=picked,
            conflicts=conflicts,
            injected=self.render(picked, conflicts),
        )

    def _score(self, c: Claim, ctx: str, now: float) -> float:
        return self.policy.score(
            key=c.key, text=c.text, confidence=c.confidence,
            hearsay=c.hearsay, created_at=c.created_at, ctx=ctx, now=now,
        )

    def render(self, claims: list[Claim], conflicts: dict[str, list[str]]) -> str:
        """Prompt block: standing usage rules + one line per claim carrying
        provenance, confidence and verify path (or HEARSAY). Display is
        budgeted per card and in total; storage is never truncated -- the
        cutoff only redirects the reader to memory_search."""
        if not claims:
            return ""
        conflicted_keys = set(conflicts)
        head = "<memloop>\n" + USAGE_RULES
        tail = "\n</memloop>"
        budget = self.policy.injection_max_chars
        parts: list[str] = []
        size = len(head) + len(tail)
        for c in claims:
            line = _card_line(c, c.key in conflicted_keys)
            if parts and size + 1 + len(line) > budget:
                break  # fill in score order, stop at the budget
            parts.append(line)
            size += 1 + len(line)
        return head + "".join("\n" + p for p in parts) + tail

    def search(self, query: str, k: int = 5) -> list[Claim]:
        """Deep retrieval for the memory_search tool. Only the overlap==0
        hard gate filters; ranking is policy.score and truncation redirects
        here, so hearsay and dormant cards stay reachable."""
        now = time.time()
        ctx = query.lower()
        scored: list[tuple[float, float, Claim]] = []
        for c in self.store.claims():
            if match_count(f"{c.key} {c.text}", ctx) == 0:
                continue
            scored.append((self._score(c, ctx, now), c.created_at, c))
        scored.sort(key=lambda t: (-t[0], t[1]))
        picked = [c for _, _, c in scored[:k]]
        self.store.log_trace("search", {
            "query": query, "k": k, "picked": [c.id for c in picked],
        })
        return picked

    # -- guard: L2 hard block / L1 reminder --------------------------------

    def guard(self, tool_name: str, args: dict, call_key: str) -> GuardDecision:
        """Action-time gate against recorded failure patterns.

        Matching is a literal prefix test on the tool's command/path argument
        (machine-decidable, zero semantic judgment). Noise control: a claim
        blocks at most once per call_key, and an overridden claim is on the
        session allowlist. L2/L1 hits are traced and join the episode's
        attribution set.
        """
        target = _guard_target(tool_name, args)
        if target is None:
            return GuardDecision("none", None, None, False)
        hit = self._best_guard_hit(target, call_key)
        if hit is None:
            return GuardDecision("none", None, None, False)
        level, c = hit
        blocked = level == "l2"
        if blocked:
            self._blocked_once.add((c.id, call_key))
        self._episode_claims.setdefault(c.id, None)
        self._log("guard", {
            "call_key": call_key, "level": level, "claim": c.id,
            "blocked": blocked,
        })
        message = _l2_message(c) if blocked else _l1_message(c)
        return GuardDecision(level, c.id, message, blocked)

    def _best_guard_hit(self, target: str, call_key: str) -> tuple[str, Claim] | None:
        """Strongest live hit: L2 over L1, then higher confidence, then the
        older claim (deterministic, mirrors retrieve's tie-break)."""
        hits: list[tuple[int, float, float, str, str, Claim]] = []
        for c in self.store.claims():
            level = self._guard_level(c, target, call_key)
            if level is not None:
                hits.append((0 if level == "l2" else 1, -c.confidence,
                             c.created_at, c.id, level, c))
        if not hits:
            return None
        hits.sort(key=lambda h: h[:4])
        return hits[0][4], hits[0][5]

    def _guard_level(self, c: Claim, target: str, call_key: str) -> str | None:
        """L2 / L1 / None for one claim against one call. L1 is the band
        [l1_min, l2_min) (plan 3.2): a high-confidence claim that fails the
        L2 gates gets no reminder at all, never a downgrade."""
        if not self._guard_matches(c, target, call_key):
            return None
        if self._l2_eligible(c):
            return "l2"
        if c.confidence >= self.policy.l2_min_confidence:
            return None
        if c.confidence >= self.policy.l1_min_confidence:
            return "l1"
        return None

    def _guard_matches(self, c: Claim, target: str, call_key: str) -> bool:
        """Prefix match + liveness + suppression. Allowlisted claims and
        claims already blocked for this call_key never fire again."""
        if not c.match_pattern:
            return False
        # A trailing-space pattern ("pytest ") also matches the bare command
        # ("pytest"): same tool, no arguments.
        if not (target.startswith(c.match_pattern)
                or target == c.match_pattern.rstrip()):
            return False
        if c.status not in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED):
            return False
        if c.id in self._override_allowlist:
            return False
        return (c.id, call_key) not in self._blocked_once

    def _l2_eligible(self, c: Claim) -> bool:
        """The three hard-block gates: confidence, world-verdict count, and
        (unless waived) an oracle to run."""
        return (c.confidence >= self.policy.l2_min_confidence
                and len(c.outcomes) >= self.policy.l2_min_outcomes
                and (not self.policy.l2_require_verify or bool(c.verify_cmd)))

    def override(self, claim_id: str, reason: str,
                 call_key: str | None = None) -> Claim:
        """Explicit bypass of a hard block: traced and confidence untouched
        (I5) -- the world verdict grades the card, not the agent that
        overrode it. The card joins this episode's attribution set, and the
        verdict flip applies to it; the session allowlist keeps the bypass
        itself (plan 4.3) across tasks."""
        c = self.store.claim(claim_id)
        if c is None:
            raise KeyError(claim_id)
        self._override_allowlist.add(claim_id)
        self._overridden_this_episode.add(claim_id)
        self._episode_claims.setdefault(claim_id, None)
        self._log("override", {
            "claim": claim_id, "reason": reason, "call_key": call_key,
        })
        return c

    def overridden(self, claim_id: str) -> bool:
        """True when the agent overrode this claim within the current
        episode: the scope of the verdict flip, not the session bypass."""
        return claim_id in self._overridden_this_episode

    # -- loop 4: verify ---------------------------------------------------

    def verify(self, claim_id: str, timeout_s: float = 30.0) -> bool | None:
        """Usage-time fact check. Returns True/False, or None if the claim
        has no oracle (hearsay -- cannot be verified, only decayed).
        False (including timeout) falsifies the claim: the oracle said no.
        """
        c = self.store.claim(claim_id)
        if c is None:
            raise KeyError(claim_id)
        self._episode_claims.setdefault(claim_id, None)
        if c.hearsay:
            return None
        try:
            proc = subprocess.run(
                c.verify_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
            ok = proc.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        if not ok:
            self.store.falsify(claim_id, reason=f"verify failed: {c.verify_cmd}")
        self.store.log_trace("verify", {"claim": claim_id, "ok": ok})
        return ok

    # -- loop 5: outcome -> confidence (I5) -------------------------------

    def report_outcome(
        self,
        claim_id: str,
        success: bool,
        weight: float = 1.0,
        ts: float | None = None,
        verdict: str | None = None,
        source: str | None = None,
        episode_id: str | None = None,
    ) -> Claim:
        """World feedback into confidence (I5). ``weight`` lets a half-weight
        affirmation move confidence less than a full-weight verdict;
        ``verdict``/``source`` travel on the outcome trace for the replay,
        stamped with the episode so one task stays one episode."""
        payload: dict = {"claim": claim_id, "success": success, "weight": weight}
        if verdict is not None:
            payload["verdict"] = verdict
        if source is not None:
            payload["source"] = source
        if episode_id is not None:
            payload["episode_id"] = episode_id
        self._log("outcome", payload, ts=ts)
        return self.store.record_outcome(claim_id, success, weight=weight, ts=ts)

    def mark_used(self, claim_ids: list[str]) -> int:
        """Record usage per claim (I3 revival) and fold the ids into the
        episode's attribution set. Unknown ids are skipped; the return value
        is how many were recorded."""
        n = 0
        for cid in claim_ids:
            if self.store.claim(cid) is None:
                continue
            self.store.record_use(cid)
            self._episode_claims.setdefault(cid, None)
            n += 1
        return n

    def begin_episode(self, episode_id: str | None = None) -> None:
        """Start a fresh episode (task boundary). Clears the attribution
        set, this episode's override set (the verdict flip must not leak
        into the next task) and the blocked-once set (a new task re-blocks
        the same command). The override allowlist stays session-wide
        (plan 4.3: the bypass is per session)."""
        self._episode_claims.clear()
        self._overridden_this_episode.clear()
        self._blocked_once.clear()
        self._episode_id = episode_id

    @property
    def current_episode_id(self) -> str | None:
        """The episode stamp applied to loop traces, if a task is open."""
        return self._episode_id

    @property
    def episode_claim_ids(self) -> list[str]:
        """Claims attributed to the current episode: picked + guard hits +
        overridden + verified cards. The world verdict lands on exactly
        this set."""
        return list(self._episode_claims)

    def _log(self, op: str, payload: dict, ts: float | None = None) -> int:
        """Trace stamped with the current episode id, so the replay can
        group one task's decisions into one episode."""
        if self._episode_id is not None and "episode_id" not in payload:
            payload = {**payload, "episode_id": self._episode_id}
        return self.store.log_trace(op, payload, ts=ts)

    # -- loop 6: consolidate / forget / promote ---------------------------

    def consolidate(self, now: float | None = None) -> ConsolidateReport:
        """Periodic replay. Deletion is reserved for falsified claims (I3):
        unused claims are demoted out of the default injection set, never
        deleted -- "never used" is indistinguishable from "never retrieved".
        Promotes proven lessons to procedures (and, with a project_root, to
        loadable skill files).
        """
        now = time.time() if now is None else now
        report = ConsolidateReport()
        for c in self.store.claims():
            bucket, skill_path = self._consolidate_one(c, now)
            if bucket is not None:
                getattr(report, bucket).append(c.id)
            if skill_path is not None:
                report.skills_written.append(skill_path)
        self.store.log_trace("consolidate", {
            "policy": self.policy.name,
            "evicted": report.evicted, "decayed": report.decayed,
            "promoted": report.promoted,
            "skills_written": report.skills_written,
        }, ts=now)
        return report

    def _consolidate_one(self, c: Claim, now: float) -> tuple[str | None, str | None]:
        """One claim through the drop ladder. Returns (report bucket, skill
        path written on promotion).

        Order matters: a proven lesson is promoted before silence can demote
        it, and terminal statuses are left alone (idempotent reruns).
        Thresholds come from the policy (the offline-replay-swappable part).
        """
        if c.status == ClaimStatus.FALSIFIED:
            self.store.set_status(c.id, ClaimStatus.EVICTED, "falsified cleanup")
            return "evicted", None
        if c.status not in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED):
            return None, None
        if self._is_promotable(c):
            skill_path = (write_skill(c, self.project_root)
                          if self.project_root is not None else None)
            self.store.promote(c.id, target=f"procedure:{c.key}")
            return "promoted", skill_path
        if self._is_expired_unused(c, now):
            self.store.set_status(c.id, ClaimStatus.DORMANT, "unused demoted")
            return "decayed", None
        if self._is_long_silent(c, now):
            self.store.set_status(c.id, ClaimStatus.DORMANT, "long silent")
            return "decayed", None
        return None, None

    def _is_expired_unused(self, c: Claim, now: float) -> bool:
        # CONFIG is a standing instruction ("until explicitly updated"):
        # neither non-use nor silence demotes it. Forgetting a user's
        # convention because the topic didn't come up is a bug, not hygiene.
        if c.kind == ClaimKind.CONFIG:
            return False
        return (c.use_count == 0
                and now - c.created_at > self.policy.effective_ttl_s(
                    c.hearsay, c.ttl_s))

    def _is_long_silent(self, c: Claim, now: float) -> bool:
        # CONFIG is a standing instruction: silence does not demote it,
        # only non-use (never adopted), correction or falsification does.
        if c.status != ClaimStatus.ACTIVE or c.kind == ClaimKind.CONFIG:
            return False
        last_used = c.used_at[-1] if c.used_at else c.created_at
        return now - last_used > self.policy.dormant_after_s

    def _is_promotable(self, c: Claim) -> bool:
        return (
            c.kind == ClaimKind.EXPERIENCE
            and c.verify_cmd is not None
            and c.success_count >= self.policy.promote_after_successes
            and c.status == ClaimStatus.ACTIVE
        )
