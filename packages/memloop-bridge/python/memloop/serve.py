"""stdio JSONL sidecar for the PI extension (memloop's only bridge).

One request per stdin line, one response per stdout line. Envelope:

  request  {"id": <int>, "op": "<op>", "args": {...}}
  response {"id": <int>, "ok": true, "result": {...}}
           {"id": <int>, "ok": false, "error": "<msg>"}

Protocol (single source of truth; the TypeScript side codes against this
table and nothing else):

  ping              {}                          -> {"pong": true}
  capture           {kind, payload, ts?, origin_key?, session?}
                                                -> {"event_id", "deduped"}
  cardify           {event_id, key, text?, claim_kind?, verify_cmd?,
                     match_pattern?, ts?}       -> {"claim": {...}|null}
  retrieve          {context, limit?, include_dormant?}
                     -> {"picked":[claim摘要...], "conflicts", "injected"}
                     (picked ids are auto mark_used; conflicts is the array
                      [{"key", "claim_ids"}] -- the bridge renderer's shape)
  guard             {tool_name, args, call_key}
                     -> {"level", "claim_id", "message", "blocked"}
  override          {claim_id, reason, call_key?}
                     -> {"claim"}
  verify            {claim_id}                  -> {"ok": bool|null, "falsified": bool}
  search            {query, k?}                 -> {"claims":[claim摘要...]}
  get_claim         {claim_id}                  -> {"claim": {...}|null}
  delete_claim      {claim_id, purge_events?}   -> {"deleted": bool}
                     (physical delete: the user's right to forget (Q3).
                      I3's "deletion is reserved for falsified claims"
                      constrains the automatic lifecycle; this explicit
                      human deletion is a separate entry point. With
                      purge_events=true the claim's source_event_ids event
                      rows are deleted too (still-cited events are kept);
                      default deletes only the card. Unknown -> deleted false.)
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
                      verified cards of this task; with a verdict_cmd the T1
                      verdict is booked at win weight 1.0, without one
                      nothing is booked and verdict is "pending" until
                      episode_signal; writes op="episode_end")
  episode_signal    {signal: "correction"|"affirmation"|"repeat", episode_id?}
                     -> {"applied", "claim_ids"}
                     (books the most recent episode: correction = loss w1.0
                      via t2a, affirmation = win w0.5 via t2b; independent
                      of T1, both may book the same episode. repeat is T3:
                      traced and counted in stats.t3_observations, booked
                      never)
  consolidate       {}    -> {"evicted","decayed","promoted","skills_written"}
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
  get_state         {session_key}               -> {"watermark_seq"}

claim 摘要对象统一字段：
  {id, key, text, confidence, hearsay, verify_cmd, status, match_pattern,
   source_event_ids}

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
from memloop.loops import Memory
from memloop.policy import DEFAULT_POLICY, Policy, policy_from_dict
from memloop.replay import (
    episodes_from_traces,
    generate_candidates,
    run_dream,
    select_policy,
)
from memloop.verdict import apply_verdict, classify_signal, run_task_verdict

POLICY_FILE = "policy.json"


def claim_summary(c: Claim) -> dict:
    """The one claim shape every op returns to the TypeScript side."""
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
    }


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
        self._ops = {
            "ping": self._op_ping,
            "capture": self._op_capture,
            "cardify": self._op_cardify,
            "retrieve": self._op_retrieve,
            "guard": self._op_guard,
            "override": self._op_override,
            "verify": self._op_verify,
            "search": self._op_search,
            "get_claim": self._op_get_claim,
            "delete_claim": self._op_delete_claim,
            "report_outcome": self._op_report_outcome,
            "replay": self._op_replay,
            "classify_signal": self._op_classify_signal,
            "begin_task": self._op_begin_task,
            "close_episode": self._op_close_episode,
            "episode_signal": self._op_episode_signal,
            "consolidate": self._op_consolidate,
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
            return {"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def _dispatch(self, op: str, args: dict) -> dict:
        handler = self._ops.get(op)
        if handler is None:
            raise ValueError(f"unknown op {op!r}")
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
        return {"claim": claim_summary(claim) if claim else None}

    def _op_retrieve(self, args: dict) -> dict:
        res = self.memory.retrieve(
            args["context"],
            limit=args.get("limit"),
            include_dormant=bool(args.get("include_dormant", False)),
        )
        self.memory.mark_used([c.id for c in res.claims])
        return {
            "picked": [claim_summary(c) for c in res.claims],
            # array shape is what the bridge renderer consumes (Array.isArray)
            "conflicts": [{"key": k, "claim_ids": ids}
                          for k, ids in sorted(res.conflicts.items())],
            "injected": res.injected,
        }

    def _op_guard(self, args: dict) -> dict:
        d = self.memory.guard(args["tool_name"], args.get("args") or {},
                              args["call_key"])
        return {"level": d.level, "claim_id": d.claim_id,
                "message": d.message, "blocked": d.blocked}

    def _op_override(self, args: dict) -> dict:
        c = self.memory.override(args["claim_id"], args["reason"],
                                 call_key=args.get("call_key"))
        return {"claim": claim_summary(c)}

    def _op_verify(self, args: dict) -> dict:
        ok = self.memory.verify(args["claim_id"])
        c = self.store.claim(args["claim_id"])
        falsified = c is not None and c.status == ClaimStatus.FALSIFIED
        return {"ok": ok, "falsified": falsified}

    def _op_search(self, args: dict) -> dict:
        claims = self.memory.search(args["query"], k=int(args.get("k", 5)))
        return {"claims": [claim_summary(c) for c in claims]}

    def _op_get_claim(self, args: dict) -> dict:
        c = self.store.claim(args["claim_id"])
        return {"claim": claim_summary(c) if c is not None else None}

    def _op_delete_claim(self, args: dict) -> dict:
        deleted = self.store.delete_claim(
            args["claim_id"],
            purge_events=bool(args.get("purge_events", False)),
        )
        return {"deleted": deleted}

    def _op_report_outcome(self, args: dict) -> dict:
        c = self.memory.report_outcome(
            args["claim_id"], bool(args["success"]),
            weight=float(args.get("weight", 1.0)),
        )
        return {"claim": claim_summary(c)}

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
            "claim_ids": None,
        })
        self.memory.store.log_trace("episode_start", {
            "episode_id": episode_id, "prompt": args.get("prompt", ""),
        })
        return {"episode_id": episode_id}

    def _op_close_episode(self, args: dict) -> dict:
        claim_ids = self.memory.episode_claim_ids
        episode_id = self._episodes[-1]["id"] if self._episodes else None
        if self._episodes:
            self._episodes[-1]["claim_ids"] = claim_ids
        verdict_cmd = args.get("verdict_cmd") or self.verdict_cmd
        if not verdict_cmd:
            verdict = "pending"
        else:
            verdict = run_task_verdict(verdict_cmd)
            apply_verdict(self.memory, claim_ids, verdict,
                          source="t1", win_weight=1.0, episode_id=episode_id)
        self.memory.store.log_trace("episode_end", {
            "episode_id": episode_id, "verdict": verdict,
            "claim_ids": claim_ids,
        })
        return {"verdict": verdict, "claim_ids": claim_ids,
                "applied": verdict in ("win", "loss")}

    def _op_episode_signal(self, args: dict) -> dict:
        signal = args.get("signal")
        if signal not in ("correction", "affirmation", "repeat"):
            raise ValueError(f"unknown signal {signal!r}")
        ep = self._find_episode(args.get("episode_id"))
        if ep is None:
            return {"applied": False, "claim_ids": []}
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
            apply_verdict(self.memory, claim_ids, "loss",
                          source="t2a", win_weight=1.0, episode_id=eid)
        else:
            apply_verdict(self.memory, claim_ids, "win",
                          source="t2b", win_weight=0.5, episode_id=eid)
        return {"applied": True, "claim_ids": claim_ids}

    def _find_episode(self, episode_id: str | None) -> dict | None:
        if episode_id is None:
            return self._episodes[-1] if self._episodes else None
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
        }

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
        return {"watermark_seq": self.store.get_watermark(args["session_key"])}


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
