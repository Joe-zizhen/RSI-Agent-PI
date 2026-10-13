"""stdio JSONL sidecar for the PI extension (memloop's only bridge).

One request per stdin line, one response per stdout line. Envelope:

  request  {"id": <int>, "op": "<op>", "args": {...}}
  response {"id": <int>, "ok": true, "result": {...}}
           {"id": <int>, "ok": false, "error": "<msg>", "code"?: "<code>"}
           (code is optional and machine-readable; unknown_op is set for
            an op outside the table below)

Protocol (single source of truth; the TypeScript side codes against this
table and nothing else):

  ping              {}                          -> {"pong": true}
  capture           {kind, payload, ts?, origin_key?, session?}
                                                -> {"event_id", "deduped"}
  cardify           {event_id, key, text?, claim_kind?, verify_cmd?,
                     match_pattern?, ts?}       -> {"claim": {...}|null}
  retrieve          {context, limit?, include_dormant?, ctx_embedding?,
                     ctx_model?}
                     -> {"picked":[claim摘要...], "conflicts", "injected",
                         "notices": [通告行...]}
                     (picked ids are auto mark_used; conflicts is the array
                      [{"key", "claim_ids"}] -- the bridge renderer's shape.
                      ctx_embedding is the query vector for semantic
                      scoring; ctx_model names the embedder and judges
                      model mismatch against claim_embeddings.model.
                      notices are the deliverable notice rows flushed for
                      the current episode (plan 4.1 carry-over injection);
                      a row is {id, claim_id, lineage_anchor, kind, text,
                      episode_id, created_at, delivered_at})
  guard             {tool_name, args, call_key}
                     -> {"level", "claim_id", "message", "blocked"}
  override          {claim_id, reason, call_key?}
                     -> {"claim"}
  verify            {claim_id}                  -> {"ok": bool|null,
                                                    "falsified": bool,
                                                    "status": "ok"|"falsified"|
                                                              "unknown"|"hearsay"}
                     (status is the four-way read: ok on a zero exit,
                      falsified on a deterministic non-zero exit, unknown on
                      a timeout (plan 1 behavior (1): no falsify), hearsay
                      when the card has no oracle)
  search            {query, k?, ctx_embedding?, ctx_model?}
                     -> {"claims":[claim摘要...]}
                     (same semantic channel as retrieve: ctx_embedding
                      softens the lexical pre-filter when present)
  set_embedding     {claim_id, vector, model}   -> {"stored": true}
                     (stores one claim's embedding in claim_embeddings;
                      the model column stamps the embedder so a later
                      model change degrades to sem=None, never raises)
  evidence          {claim_id}                  -> {"evidence": [证据行...]}
                     (per-episode (rubric_pass, outcome) history of one
                      claim, oldest created_at first; a row is
                      {episode_id, rubric_pass, outcome, rubric_updated_at,
                       outcome_updated_at, created_at}; unknown claim ->
                      empty list)
  get_claim         {claim_id}                  -> {"claim": {...}|null}
  delete_claim      {claim_id, purge_events?}   -> {"deleted": bool}
                     (physical delete: the user's right to forget (Q3).
                      I3's "deletion is reserved for falsified claims"
                      constrains the automatic lifecycle; this explicit
                      human deletion is a separate entry point. With
                      purge_events=true the claim's source_event_ids event
                      rows are deleted too (still-cited events are kept);
                      default deletes only the card. Unknown -> deleted
                      false. Plan 4.1: the deleted notice fan-out runs
                      before the evidence/embeddings cascade, then rule A
                      retracts the card's contract)
  notices_flush     {episode_id?}               -> {"notices": [通告行...]}
                     (select-and-mark delivery of undelivered deliverable
                      notice rows bound to episode_id or NULL (plan 4.1);
                      episode_id defaults to the active episode. Audit rows
                      never flush. Each row is delivered once)
  report_outcome    {claim_id, success, weight?}
                     -> {"claim"} (thin wrap of Memory.report_outcome)
  replay            {}    -> {"incumbent", "scores"}
                     (evaluate-only: scores the incumbent and candidates,
                      never writes policy.json)
  classify_signal   {text}   -> {"signal"}
                     ("correction"|"repeat"|"affirmation"|"none")
  begin_task        {prompt, session?}          -> {"episode_id"}
                     (clears and starts a fresh episode attribution set;
      writes op="episode_start")
  close_episode     {verdict_cmd?}
                     -> {"verdict": "win"|"loss"|"unknown"|"pending",
                         "claim_ids": [...], "applied": bool}
                     (attribution = picked + guard hits + overridden +
                      verified + search-returned cards of this task; with a
                      verdict_cmd the T1 verdict is booked at win weight 1.0,
                      without one nothing is booked and verdict is "pending"
                      until episode_signal; then one evidence row per claim
                      is written (outcome = the actually booked flag incl.
                      the override flip; a failed evidence write is traced,
                      never rolled back); writes op="episode_end" and ends
                      the open episode stamp (6))
  episode_signal    {signal: "correction"|"affirmation"|"repeat", episode_id?}
                     -> {"applied", "claim_ids"}
                     | {"applied": false, "claim_ids": []}
                     (books the most recent CLOSED episode, the same
                      target as memory_signal. An explicit episode_id wins.
                      correction = loss w1.0 via t2a, affirmation = win
                      w0.5 via t2b. Independent of T1, both may book the
                      same episode. Idempotent on (episode, signal) with
                      memory_signal: if either channel already processed
                      that pair the whole entry skips and the response is
                      {"applied": false, "claim_ids": []}. No closed
                      episode gives the same skip shape. repeat is T3:
                      traced and counted in stats.t3_observations, booked
                      never, and never enters the dedup table so T3 stays
                      repeatable)
  memory_signal     {signal: "correction"|"affirmation", text,
                     reason?, episode_id?}
                     -> {"skipped": true}
                     | {"skipped": false, "applied", "claim_ids", "claim"}
                     (model-labeled feedback, plan 8. text is the user's
                      exact words (the TS side passes its stashed input
                      line); reason is audit-trace only and never claim
                      text. correction runs the existing correction chain
                      first (capture user_correction -> cardify ->
                      resolve_conflict supersede on same-key siblings) and
                      then books through the same accounting path as
                      episode_signal; affirmation books only, no card.
                      The target is the most recent CLOSED episode (an
                      explicit episode_id wins). Idempotent on
                      (episode, signal): if either channel already
                      processed that pair, capture, cardify and booking
                      all skip and the response is {"skipped": true})
  consolidate       {}    -> {"evicted","decayed","promoted","skills_written",
                              "candidates"}
                     (the auto path writes AUTO_OK skills through
                      promote_commit; a REQUIRES_CONFIRM lesson only lands in
                      candidates + promotion_queue, never on disk)
  promote_candidates {}
                     -> {"candidates": [{"id", "lineage", "suggest",
                                         "evidence"}]}
                     (live listing of promotion candidates, plan 4.5: id,
                      lineage {anchor, skill_path, last_version}, suggest
                      "auto"|"confirm", evidence summary {rows, wins, losses,
                      veto}. Claims the gate refuses are absent -- 拒出候选)
  promote_request   {claim_id}  -> {"draft": {...}}
                     (the contract draft for the confirm path: decision,
                      suggest, override, veto, slug, anchor, version, path,
                      commands (full text), content_hash (sha256 of the
                      exact contract bytes the approval binds to). A request
                      on a veto-rejected card is the user's explicit
                      request: decision re-grades to requires_confirm with
                      override=true, traced for audit. An ineligible card ->
                      error code not_promotable)
  promote_commit    {claim_id, approved, content_hash?}
                     -> {"claim_id", "decision", "override", "veto",
                         "state": "approved"|"rejected", "path", "commands",
                         "content_hash", "claim"}
                     (the single skill-write port, plan 4.5: both the
                      consolidate auto path and this confirm path land here;
                      approved=true writes the contract + claim_lineage
                      skill_path and sets PROMOTED/promoted_to; approved=
                      false only marks promotion_queue rejected and never
                      touches the card (拒绝零回退). commands 全文 +
                      content_hash ride every commit payload. For a
                      non-empty command list the payload's content_hash must
                      equal the current draft hash, else the commit refuses
                      with error code hash_mismatch; empty-command cards
                      (AUTO_OK) are not gated)
  audit             {}    -> {"missed": [{"claim_id", "key", "count"}],
                              "false_triggers": [{"claim_id", "key",
                                                  "episode_id"}]}
                     (P3 /memory audit, plan 5.3. missed is the retrieve
                      trace set difference candidates minus picked,
                      counted per claim: no re-scoring. A false trigger is
                      a claim injected in an episode whose booked verdict
                      was a loss)
  claim_detail      {claim_id}
                     -> {"claim", "lineage", "chain", "contract",
                         "evidence", "notices"}
                     (P3 /memory show backing, plan 5.3. lineage is the
                      claim_lineage row {anchor, skill_path,
                      last_version}; chain is every claim sharing the
                      anchor, oldest first, rows {id, key, status,
                      status_reason, created_at}; contract is {path,
                      status} of the located SKILL.md (live directory or
                      _retired/ archive) or null; evidence rows oldest
                      first; notices are the claim's retention rows,
                      audit rows included -- nothing is hidden)
  run_dream         {force?: bool, rollback?: bool}
                     -> {"ran": bool, "winner": str, "scores": {...},
                         "changed": bool, "policy"?: {...}}
                     (publish parks the old policy in policy.prev.json;
      rollback=true restores it and returns its fields)
  stats             {}    -> {"events","claims_by_status","episodes",
                              "watermarks","t3_observations"}
  import_events     {session_key, events: [{seq, kind, payload, ts?, origin_key?}]}
                     -> {"imported","deduped"}
                     (idempotent on origin_key; watermark advances to max seq)
  get_state         {session_key}               -> {"watermark_seq",
                                                    "protocol": 2}

claim 摘要对象统一字段：
  {id, key, text, confidence, hearsay, verify_cmd, status, match_pattern,
   source_event_ids, skill_path}
  (skill_path comes from claim_lineage: the promoted contract path once
   one is recorded for the card, else null)

CLI: python serve.py --db <path> --project <root> [--verdict-cmd <cmd>]
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

if __package__ in (None, ""):  # script mode: `python serve.py --db ...`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memloop.core import Claim, ClaimKind, ClaimStatus, EventKind, Store
from memloop.loops import (
    Memory,
    PromoteHashMismatch,
    feedback_key,
    promotion_decision,
    promotion_veto,
)
from memloop.policy import DEFAULT_POLICY, Policy, policy_from_dict
from memloop.promote_skill import _slug, locate_contract, parse_frontmatter
from memloop.replay import (
    episodes_from_traces,
    generate_candidates,
    run_dream,
    select_policy,
)
from memloop.verdict import apply_verdict, classify_signal, run_task_verdict

POLICY_FILE = "policy.json"


class OpError(ValueError):
    """Envelope failure that carries a machine-readable ``code`` (protocol
    2). Unknown ops raise it with code="unknown_op"; other errors keep the
    optional code field absent."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def claim_summary(c: Claim, store: Store) -> dict:
    """The one claim shape every op returns to the TypeScript side.
    skill_path comes from claim_lineage: the promoted contract path once
    one is recorded for the card (else None)."""
    line = store.lineage(c.id)
    return {
        "id": c.id,
        "key": c.key,
        "text": c.text,
        "confidence": c.confidence,
        "hearsay": c.hearsay,
        "verify_cmd": c.verify_cmd,
        "status": c.status.value,
        "match_pattern": c.match_pattern,
        "source_event_ids": list(c.source_event_ids),
        "skill_path": None if line is None else line["skill_path"],
    }


def _ctx_vector(args: dict) -> list[float] | None:
    """The request's query embedding, or None for absent/non-list values:
    the JSON boundary must degrade to the lexical path, not raise (3.5)."""
    vec = args.get("ctx_embedding")
    return vec if isinstance(vec, list) else None


def _ctx_model(args: dict) -> str | None:
    model = args.get("ctx_model")
    return model if isinstance(model, str) else None


def _evidence_summary(evidence: list[dict]) -> dict:
    """The promote_candidates evidence digest (plan 4.5): row and outcome
    counts plus the gate's veto reasons, nothing hidden."""
    wins = sum(1 for r in evidence if r.get("outcome") is True)
    losses = sum(1 for r in evidence if r.get("outcome") is False)
    return {"rows": len(evidence), "wins": wins, "losses": losses,
            "veto": promotion_veto(evidence)}


def load_policy(db_path: str) -> Policy:
    """Incumbent policy: policy.json next to the database (written by the
    dreaming loop), else the default. A corrupt file falls back to default
    rather than blocking the sidecar."""
    path = Path(db_path).resolve().parent / POLICY_FILE
    if not path.is_file():
        return DEFAULT_POLICY
    try:
        return policy_from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return DEFAULT_POLICY


class Server:
    """One sidecar process: a Store, a Memory, and episode bookkeeping.

    Episode records are in-process only (id, prompt, claim-id snapshot at
    close); the durable evidence is the trace log underneath."""

    def __init__(self, db_path: str, project_root: str | None = None,
                 verdict_cmd: str | None = None) -> None:
        self.store = Store(db_path)
        self.project_root = project_root
        self.verdict_cmd = verdict_cmd
        self.memory = Memory(self.store, policy=load_policy(db_path),
                             project_root=project_root)
        self._episodes: list[dict] = []
        # (episode_id, signal) feedback pairs already processed by either
        # channel (input-time vocab or model memory_signal): plan 8's
        # whole-pipeline idempotence key
        self._signal_done: set[tuple[str, str]] = set()
        self._ops = {
            "ping": self._op_ping,
            "capture": self._op_capture,
            "cardify": self._op_cardify,
            "retrieve": self._op_retrieve,
            "guard": self._op_guard,
            "override": self._op_override,
            "verify": self._op_verify,
            "search": self._op_search,
            "set_embedding": self._op_set_embedding,
            "evidence": self._op_evidence,
            "get_claim": self._op_get_claim,
            "delete_claim": self._op_delete_claim,
            "notices_flush": self._op_notices_flush,
            "report_outcome": self._op_report_outcome,
            "replay": self._op_replay,
            "classify_signal": self._op_classify_signal,
            "begin_task": self._op_begin_task,
            "close_episode": self._op_close_episode,
            "episode_signal": self._op_episode_signal,
            "memory_signal": self._op_memory_signal,
            "consolidate": self._op_consolidate,
            "promote_candidates": self._op_promote_candidates,
            "promote_request": self._op_promote_request,
            "promote_commit": self._op_promote_commit,
            "audit": self._op_audit,
            "claim_detail": self._op_claim_detail,
            "run_dream": self._op_run_dream,
            "stats": self._op_stats,
            "import_events": self._op_import_events,
            "get_state": self._op_get_state,
        }

    # -- envelope ---------------------------------------------------------

    def handle(self, request: dict) -> dict:
        rid = request.get("id")
        try:
            result = self._dispatch(request.get("op", ""), request.get("args") or {})
            return {"id": rid, "ok": True, "result": result}
        except Exception as exc:  # one failed request must not kill the loop
            resp = {"id": rid, "ok": False,
                    "error": f"{type(exc).__name__}: {exc}"}
            if isinstance(exc, OpError):
                resp["code"] = exc.code
            return resp

    def _dispatch(self, op: str, args: dict) -> dict:
        handler = self._ops.get(op)
        if handler is None:
            raise OpError("unknown_op", f"unknown op {op!r}")
        return handler(args)

    # -- ops --------------------------------------------------------------

    def _op_ping(self, args: dict) -> dict:
        return {"pong": True}

    def _op_capture(self, args: dict) -> dict:
        ev = self.memory.capture(
            EventKind(args["kind"]),
            args.get("payload") or {},
            ts=args.get("ts"),
            origin_key=args.get("origin_key"),
            session=args.get("session"),
        )
        return {"event_id": ev.id, "deduped": ev.deduped}

    def _op_cardify(self, args: dict) -> dict:
        kind = args.get("claim_kind")
        claim = self.memory.cardify(
            args["event_id"],
            key=args["key"],
            text=args.get("text"),
            claim_kind=ClaimKind(kind) if kind else None,
            verify_cmd=args.get("verify_cmd"),
            match_pattern=args.get("match_pattern"),
            ts=args.get("ts"),
        )
        return {"claim": claim_summary(claim, self.store) if claim else None}

    def _op_retrieve(self, args: dict) -> dict:
        res = self.memory.retrieve(
            args["context"],
            limit=args.get("limit"),
            include_dormant=bool(args.get("include_dormant", False)),
            ctx_embedding=_ctx_vector(args),
            ctx_model=_ctx_model(args),
        )
        self.memory.mark_used([c.id for c in res.claims])
        return {
            "picked": [claim_summary(c, self.store) for c in res.claims],
            # array shape is what the bridge renderer consumes (Array.isArray)
            "conflicts": [{"key": k, "claim_ids": ids}
                          for k, ids in sorted(res.conflicts.items())],
            "injected": res.injected,
            # deliverable notices flushed for this episode (plan 4.1)
            "notices": res.notices,
        }

    def _op_guard(self, args: dict) -> dict:
        d = self.memory.guard(args["tool_name"], args.get("args") or {},
                              args["call_key"])
        return {"level": d.level, "claim_id": d.claim_id,
                "message": d.message, "blocked": d.blocked}

    def _op_override(self, args: dict) -> dict:
        c = self.memory.override(args["claim_id"], args["reason"],
                                 call_key=args.get("call_key"))
        return {"claim": claim_summary(c, self.store)}

    def _op_verify(self, args: dict) -> dict:
        ok = self.memory.verify(args["claim_id"])
        c = self.store.claim(args["claim_id"])
        falsified = c is not None and c.status == ClaimStatus.FALSIFIED
        if ok is True:
            status = "ok"
        elif ok is False:
            status = "falsified"
        elif c is not None and c.hearsay:
            status = "hearsay"
        else:
            status = "unknown"  # plan 1 behavior (1): a timeout is UNKNOWN
        return {"ok": ok, "falsified": falsified, "status": status}

    def _op_search(self, args: dict) -> dict:
        claims = self.memory.search(args["query"], k=int(args.get("k", 5)),
                                    ctx_embedding=_ctx_vector(args),
                                    ctx_model=_ctx_model(args))
        return {"claims": [claim_summary(c, self.store) for c in claims]}

    def _op_set_embedding(self, args: dict) -> dict:
        """Store one claim's embedding (plan 3.5). Unknown claim raises,
        like override/verify; the vector is coerced to floats here so a
        malformed write fails at the boundary, not at cosine time."""
        self.store.set_embedding(
            args["claim_id"],
            [float(x) for x in args["vector"]],
            args["model"],
        )
        return {"stored": True}

    def _op_evidence(self, args: dict) -> dict:
        """Per-episode (rubric_pass, outcome) history of one claim (P1
        acceptance 1). Unknown claim -> empty list, nothing hidden."""
        return {"evidence": self.store.evidence(args["claim_id"])}

    def _op_get_claim(self, args: dict) -> dict:
        c = self.store.claim(args["claim_id"])
        return {"claim": claim_summary(c, self.store) if c is not None else None}

    def _op_delete_claim(self, args: dict) -> dict:
        deleted = self.memory.delete_claim(
            args["claim_id"],
            purge_events=bool(args.get("purge_events", False)),
        )
        return {"deleted": deleted}

    def _op_notices_flush(self, args: dict) -> dict:
        """Select-and-mark notice delivery (plan 4.1). The parameter is the
        current active episode; an absent one falls back to the open
        episode stamp, then to NULL-bound rows only."""
        episode_id = args.get("episode_id")
        if episode_id is None:
            episode_id = self.memory.current_episode_id
        return {"notices": self.store.notices_flush(episode_id)}

    def _op_report_outcome(self, args: dict) -> dict:
        c = self.memory.report_outcome(
            args["claim_id"], bool(args["success"]),
            weight=float(args.get("weight", 1.0)),
        )
        return {"claim": claim_summary(c, self.store)}

    def _op_replay(self, args: dict) -> dict:
        """Evaluate-only replay for /dreaming: score the incumbent and every
        candidate, write nothing (deployment stays behind run_dream)."""
        episodes = episodes_from_traces(self.store.traces())
        _, scores = select_policy(
            self.memory.policy,
            generate_candidates(self.memory.policy),
            episodes,
        )
        return {"incumbent": self.memory.policy.name, "scores": scores}

    def _op_classify_signal(self, args: dict) -> dict:
        return {"signal": classify_signal(args["text"])}

    def _op_begin_task(self, args: dict) -> dict:
        if args.get("session") is not None:
            self.memory.session = args["session"]
        episode_id = uuid.uuid4().hex[:8]
        self.memory.begin_episode(episode_id)
        self._episodes.append({
            "id": episode_id, "prompt": args.get("prompt", ""),
            "claim_ids": None, "closed": False,
        })
        self.memory.store.log_trace("episode_start", {
            "episode_id": episode_id, "prompt": args.get("prompt", ""),
        })
        return {"episode_id": episode_id}

    def _book_evidence(self, claim_ids: list[str], episode_id: str | None,
                       booked: dict[str, bool | None]) -> None:
        """One evidence row per attributed claim, written after the verdict
        booking (plan 3.3). outcome is apply_verdict's booked value; without
        an episode id there is nothing to key a row on (I6)."""
        if episode_id is None:
            return
        for cid in claim_ids:
            self.memory.book_evidence(cid, episode_id, outcome=booked.get(cid))

    def _op_close_episode(self, args: dict) -> dict:
        claim_ids = self.memory.episode_claim_ids
        episode_id = self._episodes[-1]["id"] if self._episodes else None
        if self._episodes:
            self._episodes[-1]["claim_ids"] = claim_ids
            self._episodes[-1]["closed"] = True
        verdict_cmd = args.get("verdict_cmd") or self.verdict_cmd
        if not verdict_cmd:
            verdict = "pending"
            booked: dict[str, bool | None] = {}
        else:
            verdict = run_task_verdict(verdict_cmd)
            booked = apply_verdict(self.memory, claim_ids, verdict,
                                   source="t1", win_weight=1.0,
                                   episode_id=episode_id)
        # plan 3.3 order: apply_verdict books the verdict first, the
        # evidence rows follow. book_evidence swallows and traces a failed
        # write: the booked verdict is never rolled back for it.
        self._book_evidence(claim_ids, episode_id, booked)
        self.memory.store.log_trace("episode_end", {
            "episode_id": episode_id, "verdict": verdict,
            "claim_ids": claim_ids,
        })
        self.memory.end_episode()  # (6): a closed episode keeps no stamp
        return {"verdict": verdict, "claim_ids": claim_ids,
                "applied": verdict in ("win", "loss")}

    def _account_signal(self, ep: dict, signal: str) -> dict:
        """The one accounting path behind episode_signal and memory_signal
        (plan 8: one set of books, never a second ledger). correction =
        loss w1.0 via t2a, affirmation = win w0.5 via t2b, repeat = T3
        observation only. A booked correction/affirmation marks
        (episode, signal) processed so either channel skips that feedback
        whole. Both ops check _signal_processed before they reach here."""
        claim_ids = ep.get("claim_ids")
        if claim_ids is None:
            claim_ids = self.memory.episode_claim_ids
        eid = ep["id"]
        if signal == "repeat":
            # T3 observation: traced and counted, never booked (plan 5.1)
            self.memory.store.log_trace("verdict", {
                "source": "t3", "verdict": "repeat",
                "claim_ids": list(claim_ids), "episode_id": eid,
            })
            return {"applied": False, "claim_ids": claim_ids}
        if signal == "correction":
            booked = apply_verdict(self.memory, claim_ids, "loss",
                                   source="t2a", win_weight=1.0, episode_id=eid)
        else:
            booked = apply_verdict(self.memory, claim_ids, "win",
                                   source="t2b", win_weight=0.5, episode_id=eid)
        # plan 3.3: the outcome column gets the booked flag; a later write
        # to the same (claim, episode) row wins (single-column merge).
        self._book_evidence(claim_ids, eid, booked)
        self._signal_done.add((eid, signal))
        return {"applied": True, "claim_ids": claim_ids}

    def _op_episode_signal(self, args: dict) -> dict:
        signal = args.get("signal")
        if signal not in ("correction", "affirmation", "repeat"):
            raise ValueError(f"unknown signal {signal!r}")
        ep = self._find_signal_episode(args.get("episode_id"))
        if ep is None:
            return {"applied": False, "claim_ids": []}
        if self._signal_processed(ep["id"], signal):
            return {"applied": False, "claim_ids": []}
        return self._account_signal(ep, signal)

    def _find_signal_episode(self, episode_id: str | None) -> dict | None:
        """The accounting target of episode_signal and memory_signal
        (plan 8): an explicit episode_id wins. Otherwise the most recent
        CLOSED episode. With an active episode B open that is the task
        before B -- the just finished task the feedback refers to -- and
        with no active episode it is _episodes[-1]. No closed episode ->
        None."""
        if episode_id is not None:
            return self._find_episode(episode_id)
        for ep in reversed(self._episodes):
            if ep.get("closed"):
                return ep
        return None

    def _signal_processed(self, eid: str | None, signal: str) -> bool:
        """True when (episode, signal) is already in the dedup table (plan 8
        idempotence). Either channel checks this before it books, so one
        feedback is processed once. repeat never enters the table (T3)."""
        return eid is not None and (eid, signal) in self._signal_done

    def _memory_signal_dedup(self, eid: str | None,
                             signal: str, reason: object) -> bool:
        """True when (episode, signal) was already processed by either
        channel (plan 8 idempotence); the skip is traced here."""
        if self._signal_processed(eid, signal):
            # one (episode, signal) feedback is processed once across both
            # channels -- capture, cardify, notices and booking all skip
            # (notices arrive in 4.1).
            self.memory.store.log_trace("memory_signal", {
                "signal": signal, "episode_id": eid, "reason": reason,
                "skipped": True,
            })
            return True
        return False

    def _memory_signal_cardify(self, ep: dict | None, signal: str,
                               text: str) -> tuple[Claim | None, str | None]:
        """The correction chain's capture -> cardify half; affirmation
        makes no card. Returns (claim, source event id)."""
        claim = None
        event_id = None
        if ep is not None and signal == "correction":
            ev = self.memory.capture_correction(text)
            event_id = ev.id
            claim = self.memory.cardify(ev.id, key=feedback_key(text))
        return claim, event_id

    def _op_memory_signal(self, args: dict) -> dict:
        """Model-labeled feedback (plan 8). The booking half delegates to
        _account_signal, the episode_signal books; the correction half runs
        the existing correction chain (capture_correction -> cardify ->
        same-key supersede). text is the user's exact words, reason is
        audit-trace only (I1: a model's wording never becomes claim text)."""
        signal = args.get("signal")
        if signal not in ("correction", "affirmation"):
            raise ValueError(f"unknown signal {signal!r}")
        text = args.get("text")
        if not isinstance(text, str) or not text:
            raise ValueError("memory_signal requires text (the user's exact words)")
        reason = args.get("reason")
        ep = self._find_signal_episode(args.get("episode_id"))
        eid = None if ep is None else ep["id"]
        if self._memory_signal_dedup(eid, signal, reason):
            return {"skipped": True}
        claim, event_id = self._memory_signal_cardify(ep, signal, text)
        self.memory.store.log_trace("memory_signal", {
            "signal": signal, "episode_id": eid, "reason": reason,
            "event": event_id,
            "claim": None if claim is None else claim.id,
        })
        if ep is None:
            return {"skipped": False, "applied": False,
                    "claim_ids": [], "claim": None}
        res = self._account_signal(ep, signal)
        return {
            "skipped": False, "applied": res["applied"],
            "claim_ids": res["claim_ids"],
            "claim": None if claim is None else claim_summary(claim, self.store),
        }

    def _find_episode(self, episode_id: str) -> dict:
        """Resolve an explicit episode_id. Raises KeyError when unknown."""
        for ep in self._episodes:
            if ep["id"] == episode_id:
                return ep
        raise KeyError(f"unknown episode {episode_id!r}")

    def _op_consolidate(self, args: dict) -> dict:
        report = self.memory.consolidate()
        return {
            "evicted": report.evicted,
            "decayed": report.decayed,
            "promoted": report.promoted,
            "skills_written": report.skills_written,
            "candidates": report.candidates,
        }

    def _op_promote_candidates(self, args: dict) -> dict:
        """Plan 4.5 listing: live candidates with suggestion, lineage and an
        evidence summary. A claim the gate refuses is absent (拒出候选)."""
        out = []
        for c in self.store.claims():
            if c.status != ClaimStatus.ACTIVE:
                continue
            ev = self.store.evidence(c.id)
            decision = promotion_decision(
                c, ev, self.memory.policy.promote_after_successes)
            if decision == "rejected":
                continue
            line = self.store.lineage(c.id)
            out.append({
                "id": c.id,
                "lineage": (None if line is None else {
                    "anchor": line["anchor"],
                    "skill_path": line["skill_path"],
                    "last_version": line["last_version"],
                }),
                "suggest": "auto" if decision == "auto_ok" else "confirm",
                "evidence": _evidence_summary(ev),
            })
        return {"candidates": out}

    def _op_promote_request(self, args: dict) -> dict:
        """The confirm-path draft (plan 4.5 / P2 acceptance 3): commands 全文
        plus the content hash of the exact contract bytes. An ineligible
        card is refused with a machine-readable code."""
        try:
            draft = self.memory.promote_request(args["claim_id"])
        except ValueError as exc:
            raise OpError("not_promotable", str(exc)) from exc
        return {"draft": draft}

    def _op_promote_commit(self, args: dict) -> dict:
        """The single skill-write port (plan 4.5). The payload carries
        commands 全文 and the content hash on both outcomes. A
        commands-carrying commit binds to the draft's content hash; a
        missing or stale one is refused with code hash_mismatch (三权分立:
        the approval covers exact bytes only)."""
        try:
            res = self.memory.promote_commit(args["claim_id"],
                                             bool(args["approved"]),
                                             args.get("content_hash"))
        except PromoteHashMismatch as exc:
            raise OpError("hash_mismatch", str(exc)) from exc
        c = self.store.claim(args["claim_id"])
        return {**res, "claim": claim_summary(c, self.store)}

    def _op_audit(self, args: dict) -> dict:
        """P3 /memory audit (plan 5.3). missed is the retrieve trace set
        difference candidates minus picked, counted per claim: the trace
        snapshot is the record, nothing is re-scored. A false trigger is a
        claim injected in an episode whose booked verdict was a loss."""
        traces = self.store.traces("retrieve")
        return {
            "missed": self._audit_missed(traces),
            "false_triggers": self._audit_false_triggers(traces),
        }

    def _audit_missed(self, traces: list) -> list:
        """candidates minus picked per retrieve trace, counted per claim."""
        missed: dict = {}
        for _, _, _, payload in traces:
            picked = set(payload.get("picked") or [])
            for cand in payload.get("candidates") or []:
                cid = cand.get("id")
                if cid is None or cid in picked:
                    continue
                row = missed.setdefault(cid, {
                    "claim_id": cid, "key": cand.get("key") or "", "count": 0})
                row["count"] += 1
        return sorted(missed.values(),
                      key=lambda r: (-r["count"], str(r["claim_id"])))

    def _audit_false_triggers(self, traces: list) -> list:
        """Claims injected in an episode whose booked verdict was a loss."""
        loss_eps = {p.get("episode_id")
                    for _, _, _, p in self.store.traces("verdict")
                    if p.get("verdict") == "loss" and p.get("episode_id")}
        out: dict = {}
        for _, _, _, payload in traces:
            ep = payload.get("episode_id")
            if ep in loss_eps:
                for cid in set(payload.get("picked") or []):
                    out.setdefault((cid, ep), {
                        "claim_id": cid, "key": self._claim_key(cid),
                        "episode_id": ep})
        return sorted(out.values(),
                      key=lambda r: (str(r["episode_id"]), str(r["claim_id"])))

    def _claim_key(self, claim_id) -> str | None:
        c = self.store.claim(claim_id)
        return None if c is None else c.key

    def _op_claim_detail(self, args: dict) -> dict:
        """P3 /memory show backing (plan 5.3): one claim's evidence rows,
        lineage chain, contract path + frontmatter status, and its notice
        retention rows including audit rows (INV-1: nothing hidden)."""
        cid = args["claim_id"]
        c = self.store.claim(cid)
        empty = {"claim": None, "lineage": None, "chain": [],
                 "contract": None, "evidence": [], "notices": []}
        if c is None:
            return empty
        line = self.store.lineage(cid)
        anchor = c.id if line is None else line["anchor"]
        chain = []
        for other in self.store.claims(include_evicted=True):
            oline = self.store.lineage(other.id)
            if (other.id if oline is None else oline["anchor"]) != anchor:
                continue
            chain.append({
                "id": other.id, "key": other.key,
                "status": other.status.value,
                "status_reason": other.status_reason,
                "created_at": other.created_at,
            })
        chain.sort(key=lambda r: (r["created_at"], str(r["id"])))
        return {
            "claim": claim_summary(c, self.store),
            "lineage": (None if line is None else {
                "anchor": line["anchor"],
                "skill_path": line["skill_path"],
                "last_version": line["last_version"],
            }),
            "chain": chain,
            "contract": self._contract_info(c, line),
            "evidence": self.store.evidence(cid),
            "notices": self.store.notices(claim_id=cid),
        }

    def _contract_info(self, c: Claim, line: dict | None) -> dict | None:
        """The claim's contract {path, status}: the live SKILL.md when one
        is still in place, else the rule A archive of the lineage's current
        version. None when no file matches (no contract was ever written)."""
        if self.project_root is None:
            return None
        path = locate_contract(self.project_root, c, line)
        if path is None and line is not None:
            archived = (Path(self.project_root) / ".pi" / "skills" / "_retired"
                        / f"{_slug(line['anchor'])}-v{line['last_version']}"
                        / "SKILL.md")
            if archived.is_file():
                path = archived
        if path is None:
            return None
        meta = parse_frontmatter(path.read_text(encoding="utf-8"))
        return {"path": str(path), "status": meta.get("status")}

    def _op_run_dream(self, args: dict) -> dict:
        episodes = episodes_from_traces(self.store.traces())
        return run_dream(self.store, self.memory.policy, episodes,
                         force=bool(args.get("force", False)),
                         rollback=bool(args.get("rollback", False)))

    def _op_stats(self, args: dict) -> dict:
        by_status: dict[str, int] = {}
        for c in self.store.claims(include_evicted=True):
            by_status[c.status.value] = by_status.get(c.status.value, 0) + 1
        t3 = sum(1 for _, _, op, p in self.store.traces("verdict")
                 if p.get("verdict") == "repeat")
        return {
            "events": len(self.store.events()),
            "claims_by_status": by_status,
            "episodes": len(episodes_from_traces(self.store.traces())),
            "watermarks": self.store.watermarks(),
            "t3_observations": t3,
        }

    def _op_import_events(self, args: dict) -> dict:
        session_key = args["session_key"]
        imported = 0
        deduped = 0
        max_seq: int | None = None
        for item in args.get("events") or []:
            seq = int(item["seq"])
            ev = self.memory.capture(
                EventKind(item["kind"]),
                item.get("payload") or {},
                ts=item.get("ts"),
                origin_key=item.get("origin_key"),
                session=session_key,
            )
            if ev.deduped:
                deduped += 1
            else:
                imported += 1
            max_seq = seq if max_seq is None else max(max_seq, seq)
        if max_seq is not None:
            self.store.set_watermark(session_key, max_seq)
        return {"imported": imported, "deduped": deduped}

    def _op_get_state(self, args: dict) -> dict:
        return {"watermark_seq": self.store.get_watermark(args["session_key"]),
                "protocol": 2}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="memloop-serve",
                                     description="memloop stdio JSONL sidecar")
    parser.add_argument("--db", required=True, help="sqlite database path")
    parser.add_argument("--project", required=True, help="project root")
    parser.add_argument("--verdict-cmd", default=None,
                        help="project verdict command (T1 world verdict)")
    ns = parser.parse_args(argv)
    # JSONL stdio is UTF-8 by contract (RFC 8259). Windows pipes otherwise
    # default to the ANSI code page and corrupt CJK text in both directions.
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    server = Server(ns.db, project_root=ns.project, verdict_cmd=ns.verdict_cmd)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": f"bad json: {exc}"}
        else:
            response = server.handle(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
