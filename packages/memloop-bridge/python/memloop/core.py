"""memloop core: append-only event log + claim cards.

Stdlib only (sqlite3, json, subprocess). Storage and invariants live here;
loop policy lives in loops.py.

Five invariants (enforced here, tested in tests/test_invariants.py):
  I1 provenance        every claim cites >=1 existing event; no silent claims.
  I2 hearsay marking   claims without verify_cmd are flagged and decay faster.
  I3 usage demotion    unused claims are demoted out of the default injection
                       set, never deleted (unused != worthless: it may just be
                       unretrievable). Physical deletion is reserved for
                       claims falsified by external verification.
  I4 explicit conflicts same-key active claims surface as conflicts;
                       only resolve()/supersede() may silence them.
  I5 outcome-only confidence  confidence mutates solely via record_outcome()
                       (world feedback). There is no set_confidence().

Trust boundary: verify_cmd strings are executed by loops.use() via
subprocess. They come from the capture pipeline (project checks the agent
was told to run), never from raw untrusted chat text pasted as a command.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Sequence

# --- lifecycle constants -------------------------------------------------
# lean: single global window set; per-claim ttl override possible later if
# a real workload shows need.

DEFAULT_TTL_S = 14 * 24 * 3600  # unused claims live 14 days
HEARSAY_TTL_S = 3 * 24 * 3600   # unverifiable claims live 3 days (I2 decay)
DORMANT_AFTER_UNUSED_S = 7 * 24 * 3600  # used-once-then-silent goes dormant


class EventKind(str, Enum):
    USER_CORRECTION = "user_correction"      # friction signal: high salience
    EXPLICIT_INSTRUCTION = "explicit_instruction"
    FAILURE_FIX = "failure_fix"              # friction: failed -> fixed
    TASK_OUTCOME = "task_outcome"
    OBSERVATION = "observation"              # objective capture (file/cmd/test)
    CHATTER = "chatter"                      # noise channel


class ClaimKind(str, Enum):
    STATE = "state"          # session/task state
    CONFIG = "config"        # user preference, project convention
    KNOWLEDGE = "knowledge"  # fact/claim about the world
    EXPERIENCE = "experience"  # lesson; candidate for promotion to procedure


class ClaimStatus(str, Enum):
    ACTIVE = "active"
    CONFLICTED = "conflicted"
    FALSIFIED = "falsified"
    SUPERSEDED = "superseded"
    DORMANT = "dormant"
    EVICTED = "evicted"
    PROMOTED = "promoted"  # turned into a procedure (code/test/check)


class ProvenanceError(ValueError):
    """I1 violation: claim with no source event."""


class ConfidenceWriteError(PermissionError):
    """I5 violation: attempt to set confidence outside record_outcome."""


@dataclass(frozen=True)
class Event:
    id: str
    ts: float
    kind: EventKind
    payload: dict
    session: str = ""
    # True only when append_event returned an existing event for a repeated
    # origin_key instead of inserting a new one (at-least-once imports).
    deduped: bool = False

    @property
    def text(self) -> str:
        return str(self.payload.get("text", ""))


@dataclass
class Claim:
    id: str
    key: str                      # topic key, e.g. "test_cmd"; conflict scope
    text: str
    kind: ClaimKind
    source_event_ids: tuple[str, ...]   # I1: non-empty
    created_at: float
    confidence: float             # only record_outcome() may change it (I5)
    verify_cmd: str | None        # None => hearsay (I2)
    ttl_s: float
    status: ClaimStatus = ClaimStatus.ACTIVE
    status_reason: str = ""
    used_at: list[float] = field(default_factory=list)
    outcomes: list[tuple[float, bool, float]] = field(default_factory=list)
    promoted_to: str | None = None
    match_pattern: str | None = None  # literal command/path prefix for guard

    @property
    def hearsay(self) -> bool:
        # falsy verify_cmd (None or "") = no oracle (I2)
        return not self.verify_cmd

    @property
    def use_count(self) -> int:
        return len(self.used_at)

    @property
    def success_count(self) -> int:
        return sum(1 for o in self.outcomes if o[1])

    @property
    def effective_ttl_s(self) -> float:
        return HEARSAY_TTL_S if self.hearsay else self.ttl_s


class Store:
    """Append-only event log + claim table on sqlite.

    Default-filter disclosure (INV-1): ``claims()`` hides EVICTED claims
    unless ``include_evicted=True``; ``events()`` hides nothing.
    """

    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        self._db = sqlite3.connect(path)
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                ts REAL NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                session TEXT NOT NULL DEFAULT '',
                origin_key TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_events_origin_key
                ON events(origin_key);
            CREATE TABLE IF NOT EXISTS claims (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL,
                text TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_event_ids TEXT NOT NULL,
                created_at REAL NOT NULL,
                confidence REAL NOT NULL,
                verify_cmd TEXT,
                ttl_s REAL NOT NULL,
                status TEXT NOT NULL,
                status_reason TEXT NOT NULL DEFAULT '',
                used_at TEXT NOT NULL DEFAULT '[]',
                outcomes TEXT NOT NULL DEFAULT '[]',
                promoted_to TEXT,
                match_pattern TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_claims_key ON claims(key);
            CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
            CREATE TABLE IF NOT EXISTS traces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                op TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_state (
                session_key TEXT PRIMARY KEY,
                watermark_seq INTEGER NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )

    # --- events (append-only) --------------------------------------------

    def append_event(
        self,
        kind: EventKind,
        payload: dict,
        ts: float | None = None,
        session: str = "",
        origin_key: str | None = None,
    ) -> Event:
        """Append one event. A repeated non-null origin_key returns the
        earlier event with deduped=True and inserts nothing: at-least-once
        import stays idempotent without losing the original id. The dedup
        is INSERT OR IGNORE + post-SELECT (plan section 7), so concurrent
        importers of the same key are absorbed by the UNIQUE index instead
        of raising IntegrityError."""
        ev = Event(
            id=uuid.uuid4().hex,
            ts=time.time() if ts is None else ts,
            kind=kind,
            payload=payload,
            session=session,
        )
        if origin_key is not None:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)",
                (ev.id, ev.ts, ev.kind.value, json.dumps(ev.payload),
                 ev.session, origin_key),
            )
            self._db.commit()
            if cur.rowcount == 1:
                return ev
            row = self._db.execute(
                "SELECT id, ts, kind, payload, session FROM events"
                " WHERE origin_key=?",
                (origin_key,),
            ).fetchone()
            if row is not None:
                found = self._row_to_event(row)
                return Event(
                    id=found.id, ts=found.ts, kind=found.kind,
                    payload=found.payload, session=found.session,
                    deduped=True,
                )
        self._db.execute(
            "INSERT INTO events VALUES (?,?,?,?,?,?)",
            (ev.id, ev.ts, ev.kind.value, json.dumps(ev.payload), ev.session,
             origin_key),
        )
        self._db.commit()
        return ev

    def event(self, event_id: str) -> Event | None:
        row = self._db.execute(
            "SELECT id, ts, kind, payload, session FROM events WHERE id=?",
            (event_id,),
        ).fetchone()
        return self._row_to_event(row) if row else None

    def events(self, kind: EventKind | None = None) -> list[Event]:
        if kind is None:
            rows = self._db.execute(
                "SELECT id, ts, kind, payload, session FROM events ORDER BY ts"
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT id, ts, kind, payload, session FROM events"
                " WHERE kind=? ORDER BY ts",
                (kind.value,),
            ).fetchall()
        return [self._row_to_event(r) for r in rows]

    @staticmethod
    def _row_to_event(row: tuple) -> Event:
        return Event(
            id=row[0], ts=row[1], kind=EventKind(row[2]),
            payload=json.loads(row[3]), session=row[4],
        )

    # --- traces (structured loop log; feeds the offline replay) -----------

    def log_trace(self, op: str, payload: dict, ts: float | None = None) -> int:
        """Append one structured record of a loop step. What happened, when,
        with which inputs/outputs -- the exploration history a replay
        evaluator needs. Append-only (never rewrites); raises TypeError on
        a payload json cannot encode. Payloads may contain raw user/task
        text: the traces table is as sensitive as the events table."""
        cur = self._db.execute(
            "INSERT INTO traces (ts, op, payload) VALUES (?,?,?)",
            (time.time() if ts is None else ts, op, json.dumps(payload)),
        )
        self._db.commit()
        return int(cur.lastrowid)

    def traces(self, op: str | None = None) -> list[tuple[int, float, str, dict]]:
        """Read the trace log back (id, ts, op, payload). Nothing hidden."""
        if op is None:
            rows = self._db.execute(
                "SELECT id, ts, op, payload FROM traces ORDER BY id"
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT id, ts, op, payload FROM traces WHERE op=? ORDER BY id",
                (op,),
            ).fetchall()
        return [(r[0], r[1], r[2], json.loads(r[3])) for r in rows]

    # --- claims ----------------------------------------------------------

    def add_claim(
        self,
        key: str,
        text: str,
        kind: ClaimKind,
        source_event_ids: Sequence[str],
        created_at: float | None = None,
        verify_cmd: str | None = None,
        ttl_s: float | None = None,
        match_pattern: str | None = None,
    ) -> Claim:
        """Create a claim. Raises ProvenanceError if sources are empty or
        unknown (I1). Confidence starts at 0.5 (prior); only
        record_outcome() moves it afterwards (I5).
        """
        if not source_event_ids:
            raise ProvenanceError("claim needs >=1 source event (I1)")
        for eid in source_event_ids:
            if self.event(eid) is None:
                raise ProvenanceError(f"unknown source event {eid} (I1)")
        claim = Claim(
            id=uuid.uuid4().hex,
            key=key,
            text=text,
            kind=kind,
            source_event_ids=tuple(source_event_ids),
            created_at=time.time() if created_at is None else created_at,
            confidence=0.5,
            verify_cmd=verify_cmd,
            ttl_s=DEFAULT_TTL_S if ttl_s is None else ttl_s,
            match_pattern=match_pattern,
        )
        self._insert_claim(claim)
        return claim

    def _insert_claim(self, c: Claim) -> None:
        self._db.execute(
            "INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                c.id, c.key, c.text, c.kind.value,
                json.dumps(list(c.source_event_ids)),
                c.created_at, c.confidence, c.verify_cmd, c.ttl_s,
                c.status.value, c.status_reason,
                json.dumps(c.used_at), json.dumps(c.outcomes), c.promoted_to,
                c.match_pattern,
            ),
        )
        self._db.commit()

    def claim(self, claim_id: str) -> Claim | None:
        row = self._db.execute(
            "SELECT * FROM claims WHERE id=?", (claim_id,)
        ).fetchone()
        return self._row_to_claim(row) if row else None

    def claims(
        self,
        key: str | None = None,
        status: ClaimStatus | None = None,
        include_evicted: bool = False,
    ) -> list[Claim]:
        """List claims. Default hides EVICTED (see class docstring)."""
        sql = "SELECT * FROM claims"
        clauses, args = [], []
        if key is not None:
            clauses.append("key=?")
            args.append(key)
        if status is not None:
            clauses.append("status=?")
            args.append(status.value)
        if not include_evicted:
            clauses.append("status != ?")
            args.append(ClaimStatus.EVICTED.value)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at"
        return [self._row_to_claim(r) for r in self._db.execute(sql, args)]

    @staticmethod
    def _row_to_claim(row: tuple) -> Claim:
        return Claim(
            id=row[0], key=row[1], text=row[2], kind=ClaimKind(row[3]),
            source_event_ids=tuple(json.loads(row[4])),
            created_at=row[5], confidence=row[6], verify_cmd=row[7],
            ttl_s=row[8], status=ClaimStatus(row[9]), status_reason=row[10],
            used_at=json.loads(row[11]),
            outcomes=[tuple(o) for o in json.loads(row[12])],
            promoted_to=row[13], match_pattern=row[14],
        )

    def _save_claim(self, c: Claim) -> None:
        self._db.execute(
            "UPDATE claims SET status=?, status_reason=?, used_at=?,"
            " outcomes=?, confidence=?, promoted_to=? WHERE id=?",
            (
                c.status.value, c.status_reason,
                json.dumps(c.used_at), json.dumps(c.outcomes),
                c.confidence, c.promoted_to, c.id,
            ),
        )
        self._db.commit()

    # --- I3: usage -------------------------------------------------------

    def record_use(self, claim_id: str, ts: float | None = None) -> Claim:
        c = self._require(claim_id)
        c.used_at.append(time.time() if ts is None else ts)
        if c.status == ClaimStatus.DORMANT:
            c.status = ClaimStatus.ACTIVE  # I3: demotion is reversible
            c.status_reason = "revived by use"
        self._save_claim(c)
        return c

    # --- I5: outcome-only confidence ------------------------------------

    def record_outcome(
        self, claim_id: str, success: bool, weight: float = 1.0,
        ts: float | None = None,
    ) -> Claim:
        """The ONLY writer of ``confidence``. World feedback, not LLM mood.

        Weighted Laplace: confidence = (sum(w*win) + 1) / (sum(w) + 2).
        A half-weight affirmation therefore moves confidence half as far as
        a full-weight verdict (T2b is deliberately weaker than T1/T2a).
        """
        c = self._require(claim_id)
        c.outcomes.append((time.time() if ts is None else ts, success, weight))
        wins = sum(w for _, ok, w in c.outcomes if ok)
        total = sum(w for _, _, w in c.outcomes)
        c.confidence = (wins + 1) / (total + 2)
        self._save_claim(c)
        return c

    # --- import watermarks (at-least-once delivery) -----------------------

    def set_watermark(self, session_key: str, seq: int) -> None:
        """Record how far an import stream has been consumed."""
        self._db.execute(
            "INSERT INTO import_state (session_key, watermark_seq, updated_at)"
            " VALUES (?,?,?)"
            " ON CONFLICT(session_key) DO UPDATE SET"
            " watermark_seq=excluded.watermark_seq,"
            " updated_at=excluded.updated_at",
            (session_key, int(seq), time.time()),
        )
        self._db.commit()

    def get_watermark(self, session_key: str) -> int | None:
        row = self._db.execute(
            "SELECT watermark_seq FROM import_state WHERE session_key=?",
            (session_key,),
        ).fetchone()
        return int(row[0]) if row is not None else None

    def watermarks(self) -> dict[str, int]:
        rows = self._db.execute(
            "SELECT session_key, watermark_seq FROM import_state"
        ).fetchall()
        return {k: int(v) for k, v in rows}

    # --- I4: explicit conflict resolution --------------------------------

    def active_conflicts(self) -> dict[str, list[str]]:
        """Keys with >1 non-terminal claim -> conflict must be resolved."""
        out: dict[str, list[str]] = {}
        for c in self.claims():
            if c.status in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED):
                out.setdefault(c.key, []).append(c.id)
        return {k: ids for k, ids in out.items() if len(ids) > 1}

    def resolve_conflict(self, key: str, keep_id: str, reason: str = "") -> None:
        """Keep one claim for ``key``; others become SUPERSEDED.

        Raises KeyError if keep_id is not a claim of this key -- a typo must
        never silently clear the key (I4: resolution is explicit).
        A terminal claim (FALSIFIED/EVICTED) is never revived by resolution.
        """
        siblings = self.claims(key=key)
        if not any(c.id == keep_id for c in siblings):
            raise KeyError(f"{keep_id} is not a claim of key {key!r}")
        for c in siblings:
            if c.id == keep_id:
                if c.status in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED):
                    c.status = ClaimStatus.ACTIVE
                    c.status_reason = reason or "conflict resolved"
            elif c.status in (
                ClaimStatus.ACTIVE,
                ClaimStatus.CONFLICTED,
                ClaimStatus.DORMANT,
            ):
                c.status = ClaimStatus.SUPERSEDED
                c.status_reason = f"superseded by {keep_id}: {reason}"
            self._save_claim(c)

    def falsify(self, claim_id: str, reason: str = "") -> Claim:
        c = self._require(claim_id)
        c.status = ClaimStatus.FALSIFIED
        c.status_reason = reason or "falsified by verification"
        self._save_claim(c)
        return c

    def set_status(self, claim_id: str, status: ClaimStatus, reason: str = "") -> Claim:
        c = self._require(claim_id)
        c.status = status
        c.status_reason = reason
        self._save_claim(c)
        return c

    def promote(self, claim_id: str, target: str) -> Claim:
        c = self._require(claim_id)
        c.status = ClaimStatus.PROMOTED
        c.promoted_to = target
        c.status_reason = f"promoted to {target}"
        self._save_claim(c)
        return c

    def delete_claim(self, claim_id: str, purge_events: bool = False) -> bool:
        """Physically drop one claim row (the user's right to forget, Q3).

        I3 reserves automatic deletion for falsified claims; this is the
        explicit human entry point and bypasses the lifecycle ladder on
        purpose. With purge_events the claim's source events are deleted
        too; without it only the card goes. Returns False when the claim
        does not exist. Traces are never touched (append-only replay log).
        """
        c = self.claim(claim_id)
        if c is None:
            return False
        self._db.execute("DELETE FROM claims WHERE id=?", (claim_id,))
        if purge_events:
            for eid in c.source_event_ids:
                if not self._event_still_referenced(eid):
                    self._db.execute("DELETE FROM events WHERE id=?", (eid,))
        self._db.commit()
        return True

    def _event_still_referenced(self, event_id: str) -> bool:
        """I1 safety net: an event another claim cites is never purged, or
        that claim would dangle on a missing source."""
        for other in self.claims(include_evicted=True):
            if event_id in other.source_event_ids:
                return True
        return False

    def _require(self, claim_id: str) -> Claim:
        c = self.claim(claim_id)
        if c is None:
            raise KeyError(claim_id)
        return c
