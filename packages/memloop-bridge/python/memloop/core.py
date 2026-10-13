"""memloop core: append-only event log + claim cards.

Stdlib only (sqlite3, json, subprocess). Storage and invariants live here;
loop policy lives in loops.py.

Six invariants (enforced here, tested in tests/test_invariants.py):
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
  I6 evidence attribution  add_evidence() needs an existing claim and a
                       non-empty episode_id. Episode ids stay opaque strings:
                       no episode entity is validated.

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
from pathlib import Path
from typing import Any, Iterable, Sequence

# --- lifecycle constants -------------------------------------------------
# lean: single global window set; per-claim ttl override possible later if
# a real workload shows need.

DEFAULT_TTL_S = 14 * 24 * 3600  # unused claims live 14 days
HEARSAY_TTL_S = 3 * 24 * 3600   # unverifiable claims live 3 days (I2 decay)
DORMANT_AFTER_UNUSED_S = 7 * 24 * 3600  # used-once-then-silent goes dormant

# ⑤ reserve (plan 3.4): a correction-retracted PROMOTED card carries this
# status_reason prefix (written by the 4.1 handler). The anchor collector
# reads the marker, never PROMOTED status alone.
CORRECTED_REASON_PREFIX = "corrected:"

# --- notices (plan 4.1) ---------------------------------------------------
# Deliverable rows carry a bare kind. Audit rows carry the same kind with
# NOTICE_AUDIT_SUFFIX: they bind a past episode, live in the retention area
# only and never join a flush.

NOTICE_KINDS = ("retracted", "corrected", "superseded", "deleted", "instructed")
NOTICE_AUDIT_SUFFIX = ":audit"
# strongest first: undelivered rows of one (claim, episode) keep the highest
NOTICE_PRIORITY = {k: i for i, k in enumerate(NOTICE_KINDS)}
NOTICE_TEXT_MAX_CHARS = 300
NOTICE_QUEUE_LIMIT = 20          # undelivered deliverable rows (audit exempt)
NOTICE_RETENTION_ROWS = 200      # delivered + audit rows kept newest
NOTICE_RETENTION_S = 30 * 24 * 3600

# --- promotion queue (plan 4.5) -------------------------------------------
# Candidate state of one promotion decision, independent of ClaimStatus:
# the queue never touches the card (a candidate stays ACTIVE and injectable,
# a rejection rolls nothing back -- 拒绝零回退).

PROMOTION_DECISIONS = ("auto_ok", "requires_confirm")
PROMOTION_STATES = ("pending", "approved", "rejected")


def notice_base_kind(kind: str) -> str:
    """The dedup-priority key of a notice kind (audit suffix stripped)."""
    if kind.endswith(NOTICE_AUDIT_SUFFIX):
        return kind[: -len(NOTICE_AUDIT_SUFFIX)]
    return kind


def build_notice_text(
    kind: str,
    claim_id: str,
    claim_text: str = "",
    new_id: str | None = None,
    episode_id: str | None = None,
) -> str:
    """Fixed notice wording (plan 4.1): a deliverable row says what happened
    to the card and calls for a re-check of the steps that cited it. An audit
    row binds the original episode. corrected rows carry the successor card
    id (4.1: 成卡之后正文含新卡 id)."""
    base = notice_base_kind(kind)
    card = f"（卡 {claim_id}）"
    if kind.endswith(NOTICE_AUDIT_SUFFIX):
        text = f"任务 {episode_id} 中曾注入该卡，相关步骤请复核{card}"
        return text if new_id is None else f"{text}，新卡 {new_id}"
    if base == "instructed":
        return f"新指令{card}：{claim_text}"
    if base == "retracted":
        return f"该卡已证伪，引用过它的步骤请复核{card}"
    if base == "corrected":
        return f"该卡已纠正（新卡 {new_id}），引用过它的步骤请复核{card}"
    if base == "superseded":
        return f"该卡已被取代（新卡 {new_id}），引用过它的步骤请复核{card}"
    return f"该卡已删除，引用过它的步骤请复核{card}"


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
            CREATE TABLE IF NOT EXISTS claim_evidence (
                claim_id TEXT NOT NULL,
                episode_id TEXT NOT NULL,
                rubric_pass INTEGER,
                outcome INTEGER,
                rubric_updated_at REAL,
                outcome_updated_at REAL,
                created_at REAL NOT NULL,
                PRIMARY KEY (claim_id, episode_id)
            );
            CREATE TABLE IF NOT EXISTS claim_lineage (
                claim_id TEXT PRIMARY KEY,
                anchor TEXT NOT NULL,
                skill_path TEXT,
                last_version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS claim_embeddings (
                claim_id TEXT PRIMARY KEY,
                vector TEXT,
                model TEXT,
                ts REAL
            );
            CREATE TABLE IF NOT EXISTS notices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                claim_id TEXT NOT NULL,
                lineage_anchor TEXT,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
                episode_id TEXT,
                created_at REAL NOT NULL,
                delivered_at REAL
            );
            CREATE TABLE IF NOT EXISTS promotion_queue (
                claim_id TEXT PRIMARY KEY,
                decision TEXT NOT NULL,
                created_at REAL NOT NULL,
                state TEXT NOT NULL
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
        self._assign_lineage(claim)
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

    # --- evidence rows (plan 3.2) ----------------------------------------

    def add_evidence(
        self,
        claim_id: str,
        episode_id: str,
        rubric_pass: bool | None = None,
        outcome: bool | None = None,
        ts: float | None = None,
    ) -> None:
        """Record the evidence row of (claim, episode) with single-column
        merge writes (plan 3.2): a write carrying only rubric_pass leaves
        outcome untouched and the reverse. A later write to the same column
        wins. I6: the claim must exist and episode_id must be non-empty;
        episode ids stay opaque, no episode entity is checked. Each claim
        keeps its 50 newest rows; eviction drops the oldest created_at
        first. Returns nothing.
        """
        if not episode_id:
            raise ValueError("episode_id must be non-empty (I6)")
        self._require(claim_id)  # I6: no evidence for a missing claim
        now = time.time() if ts is None else ts
        self._db.execute(
            "INSERT INTO claim_evidence (claim_id, episode_id, rubric_pass,"
            " outcome, rubric_updated_at, outcome_updated_at, created_at)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(claim_id, episode_id) DO UPDATE SET"
            " rubric_pass=COALESCE(excluded.rubric_pass,"
            "   claim_evidence.rubric_pass),"
            " rubric_updated_at=CASE WHEN excluded.rubric_pass IS NOT NULL"
            "   THEN excluded.rubric_updated_at"
            "   ELSE claim_evidence.rubric_updated_at END,"
            " outcome=COALESCE(excluded.outcome, claim_evidence.outcome),"
            " outcome_updated_at=CASE WHEN excluded.outcome IS NOT NULL"
            "   THEN excluded.outcome_updated_at"
            "   ELSE claim_evidence.outcome_updated_at END",
            (
                claim_id, episode_id,
                None if rubric_pass is None else int(rubric_pass),
                None if outcome is None else int(outcome),
                now if rubric_pass is not None else None,
                now if outcome is not None else None,
                now,
            ),
        )
        self._db.execute(
            "DELETE FROM claim_evidence WHERE claim_id=? AND episode_id NOT IN ("
            " SELECT episode_id FROM claim_evidence WHERE claim_id=?"
            " ORDER BY created_at DESC, episode_id ASC LIMIT 50)",
            (claim_id, claim_id),
        )
        self._db.commit()

    def evidence(self, claim_id: str) -> list[dict]:
        """All evidence rows of one claim, oldest created_at first. Nothing
        hidden: a claim without evidence gets an empty list (INV-1)."""
        rows = self._db.execute(
            "SELECT episode_id, rubric_pass, outcome, rubric_updated_at,"
            " outcome_updated_at, created_at FROM claim_evidence"
            " WHERE claim_id=? ORDER BY created_at, episode_id",
            (claim_id,),
        ).fetchall()
        return [
            {
                "episode_id": r[0],
                "rubric_pass": None if r[1] is None else bool(r[1]),
                "outcome": None if r[2] is None else bool(r[2]),
                "rubric_updated_at": r[3],
                "outcome_updated_at": r[4],
                "created_at": r[5],
            }
            for r in rows
        ]

    # --- lineage (plan 3.4) ----------------------------------------------

    def lineage(self, claim_id: str) -> dict | None:
        """One lineage row (claim_id, anchor, skill_path, last_version), or
        None when the claim has none. Claims get a row at creation; legacy
        rows come from migrate_lineage()."""
        row = self._db.execute(
            "SELECT claim_id, anchor, skill_path, last_version"
            " FROM claim_lineage WHERE claim_id=?",
            (claim_id,),
        ).fetchone()
        if row is None:
            return None
        return {"claim_id": row[0], "anchor": row[1], "skill_path": row[2],
                "last_version": row[3]}

    def set_lineage_version(self, claim_id: str, version: int) -> None:
        """Record the contract generation last written for this claim
        (plan 4.4 rule B write side). Rule A's archive move names its
        directory after this value."""
        self._db.execute(
            "UPDATE claim_lineage SET last_version=? WHERE claim_id=?",
            (version, claim_id),
        )
        self._db.commit()

    def set_lineage_skill_path(self, claim_id: str,
                               skill_path: str | None) -> None:
        """Record the claim's contract path (plan 4.5 commit writeback):
        promote_commit stamps it after write_skill so locate_contract finds
        the live file first."""
        self._db.execute(
            "UPDATE claim_lineage SET skill_path=? WHERE claim_id=?",
            (skill_path, claim_id),
        )
        self._db.commit()

    def _displaced_anchors(self, key: str, exclude_id: str) -> set[str]:
        """Anchors of the displaced same-key siblings (plan 3.4 operation
        definition): claims resolve_conflict() set SUPERSEDED, plus the
        correction-marked PROMOTED cards of (5) (collected by the
        CORRECTED_REASON_PREFIX marker in status_reason, never by PROMOTED
        status alone). The (5) write side lands in 4.1; this read side is
        live so successors already share the slug."""
        out: set[str] = set()
        for c in self.claims(key=key):
            if c.id == exclude_id:
                continue
            if c.status == ClaimStatus.SUPERSEDED or (
                c.status == ClaimStatus.PROMOTED
                and c.status_reason.startswith(CORRECTED_REASON_PREFIX)
            ):
                line = self.lineage(c.id)
                if line is not None:
                    out.add(line["anchor"])
        return out

    def _assign_lineage(self, c: Claim) -> str:
        """Create or refresh c's lineage row and return its anchor (3.4).
        One unique displaced-sibling anchor is inherited. Several distinct
        anchors, or no displaced sibling, self-anchor the claim. skill_path
        and last_version survive a re-home (4.1 writes them)."""
        anchors = self._displaced_anchors(c.key, c.id)
        anchor = c.id if len(anchors) != 1 else next(iter(anchors))
        row = self._db.execute(
            "SELECT claim_id FROM claim_lineage WHERE claim_id=?", (c.id,)
        ).fetchone()
        if row is None:
            self._db.execute(
                "INSERT INTO claim_lineage (claim_id, anchor, skill_path,"
                " last_version) VALUES (?,?,?,?)",
                (c.id, anchor, None, 0),
            )
        else:
            self._db.execute(
                "UPDATE claim_lineage SET anchor=? WHERE claim_id=?",
                (anchor, c.id),
            )
        self._db.commit()
        return anchor

    def _backfill_lineage_rows(self) -> None:
        """Insert a self-anchored lineage row for every claim that has none."""
        known = {r[0] for r in self._db.execute(
            "SELECT claim_id FROM claim_lineage").fetchall()}
        for c in self.claims(include_evicted=True):
            if c.id not in known:
                self._db.execute(
                    "INSERT INTO claim_lineage (claim_id, anchor, skill_path,"
                    " last_version) VALUES (?,?,?,?)",
                    (c.id, c.id, None, 0),
                )

    def _probe_legacy_skill_paths(self, project_root: str) -> None:
        """Write skill_path for the newest promoted claim of each key when
        the pre-slug layout still holds a SKILL.md under project_root."""
        # late import: _safe_key lives in promote_skill, which imports Claim
        from .promote_skill import _safe_key

        newest: dict[str, Claim] = {}
        for c in self.claims(status=ClaimStatus.PROMOTED,
                             include_evicted=True):
            cur = newest.get(c.key)
            if cur is None or c.created_at > cur.created_at:
                newest[c.key] = c
        for key, c in newest.items():
            line = self.lineage(c.id)
            if line is not None and line["skill_path"] is None:
                legacy = (Path(project_root) / ".pi" / "skills"
                          / _safe_key(key) / "SKILL.md")
                if legacy.is_file():
                    self._db.execute(
                        "UPDATE claim_lineage SET skill_path=?"
                        " WHERE claim_id=?",
                        (str(legacy), c.id),
                    )

    def migrate_lineage(self, project_root: str | None = None) -> None:
        """Startup backfill for pre-upgrade databases (plan 3.2). Idempotent.

        A claim without a lineage row gets one with anchor = own id: a
        legacy card is self-anchored by definition, it never inherits.
        Promoted legacy cards probe the pre-slug directory layout
        (_safe_key) under project_root; skill_path is written only for the
        newest promoted claim of each key. last_version starts at 0.
        """
        self._backfill_lineage_rows()
        if project_root is not None:
            self._probe_legacy_skill_paths(project_root)
        self._db.commit()

    # --- embeddings (plan 3.5) -------------------------------------------

    def set_embedding(self, claim_id: str, vector: list[float], model: str,
                      ts: float | None = None) -> None:
        """Store one claim's embedding vector (one row per claim). The
        model name stamps which embedder produced the vector: at query
        time a different model means the stored vector is out of
        distribution and must not be cosined against (sem=None)."""
        self._require(claim_id)
        self._db.execute(
            "INSERT OR REPLACE INTO claim_embeddings (claim_id, vector,"
            " model, ts) VALUES (?,?,?,?)",
            (claim_id, json.dumps(vector), model,
             time.time() if ts is None else ts),
        )
        self._db.commit()

    def embedding(self, claim_id: str) -> dict | None:
        """One claim's stored embedding {vector, model, ts}, or None when
        the claim has none (or only a NULL vector). The vector is decoded
        JSON; a malformed blob raises and never half-reads."""
        row = self._db.execute(
            "SELECT vector, model, ts FROM claim_embeddings WHERE claim_id=?",
            (claim_id,),
        ).fetchone()
        if row is None or row[0] is None:
            return None
        return {"vector": json.loads(row[0]), "model": row[1], "ts": row[2]}

    # --- notices (plan 4.1) ----------------------------------------------

    def add_notice(
        self,
        claim_id: str,
        kind: str,
        text: str,
        episode_id: str | None = None,
        ts: float | None = None,
    ) -> int:
        """One notice row (plan 4.1). text is truncated to
        NOTICE_TEXT_MAX_CHARS. Undelivered rows of one (claim, episode) keep
        the highest-priority kind only. The undelivered deliverable queue is
        capped at NOTICE_QUEUE_LIMIT (oldest dropped first, id breaks ties);
        audit rows bypass the cap. Delivered and audit rows are pruned to the
        newest NOTICE_RETENTION_ROWS or NOTICE_RETENTION_S. Returns the row
        id (0 when the row lost the priority dedup)."""
        base = notice_base_kind(kind)
        if base not in NOTICE_PRIORITY:
            raise ValueError(f"unknown notice kind {kind!r}")
        line = self.lineage(claim_id)
        anchor = claim_id if line is None else line["anchor"]
        now = time.time() if ts is None else ts
        cur = self._db.execute(
            "INSERT INTO notices (claim_id, lineage_anchor, kind, text,"
            " episode_id, created_at, delivered_at) VALUES (?,?,?,?,?,?,?)",
            (claim_id, anchor, kind, text[:NOTICE_TEXT_MAX_CHARS],
             episode_id, now, None),
        )
        row_id = int(cur.lastrowid)
        self._dedupe_notice_group(claim_id, episode_id)
        self._cap_notice_queue()
        self._prune_notice_retention(now)
        self._db.commit()
        return row_id

    def _dedupe_notice_group(self, claim_id: str,
                             episode_id: str | None) -> None:
        """Keep the single highest-priority undelivered row of one
        (claim, episode) (plan 4.1 dedup). A tie keeps the newer row."""
        rows = self._db.execute(
            "SELECT id, kind FROM notices WHERE claim_id=? AND episode_id IS ?"
            " AND delivered_at IS NULL ORDER BY id",
            (claim_id, episode_id),
        ).fetchall()
        if len(rows) <= 1:
            return
        keep_id, keep_kind = rows[0]
        for rid, kind in rows[1:]:
            # lower NOTICE_PRIORITY index wins; the larger id wins a tie
            if (NOTICE_PRIORITY[notice_base_kind(kind)], -rid) < (
                NOTICE_PRIORITY[notice_base_kind(keep_kind)], -keep_id
            ):
                keep_id, keep_kind = rid, kind
        for rid, _ in rows:
            if rid != keep_id:
                self._db.execute("DELETE FROM notices WHERE id=?", (rid,))

    def _cap_notice_queue(self) -> None:
        """Drop the oldest undelivered deliverable rows beyond the 20-row
        queue cap (same created_at drops the lower id first). Audit rows are
        not counted: their volume is bounded by the 50-row evidence cap."""
        while True:
            row = self._db.execute(
                "SELECT COUNT(*) FROM notices WHERE delivered_at IS NULL"
                " AND kind NOT LIKE ?",
                ("%" + NOTICE_AUDIT_SUFFIX,),
            ).fetchone()
            if row[0] <= NOTICE_QUEUE_LIMIT:
                return
            victim = self._db.execute(
                "SELECT id FROM notices WHERE delivered_at IS NULL"
                " AND kind NOT LIKE ? ORDER BY created_at, id LIMIT 1",
                ("%" + NOTICE_AUDIT_SUFFIX,),
            ).fetchone()
            self._db.execute("DELETE FROM notices WHERE id=?", (victim[0],))

    def _prune_notice_retention(self, now: float) -> None:
        """Retention (plan 4.1): delivered and audit rows keep the newest
        NOTICE_RETENTION_ROWS rows or anything younger than
        NOTICE_RETENTION_S. Undelivered deliverable rows are queue-managed,
        never retention-pruned."""
        rows = self._db.execute(
            "SELECT id, created_at FROM notices WHERE delivered_at IS NOT NULL"
            " OR kind LIKE ? ORDER BY created_at DESC, id DESC",
            ("%" + NOTICE_AUDIT_SUFFIX,),
        ).fetchall()
        for i, (rid, created) in enumerate(rows):
            if i < NOTICE_RETENTION_ROWS or now - created < NOTICE_RETENTION_S:
                continue
            self._db.execute("DELETE FROM notices WHERE id=?", (rid,))

    def notices(self, claim_id: str | None = None,
                include_audit: bool = True,
                undelivered_only: bool = False) -> list[dict]:
        """Notice rows, oldest first. Nothing hidden (INV-1): an empty
        result is an empty list."""
        sql = ("SELECT id, claim_id, lineage_anchor, kind, text, episode_id,"
               " created_at, delivered_at FROM notices")
        clauses, args = [], []
        if claim_id is not None:
            clauses.append("claim_id=?")
            args.append(claim_id)
        if not include_audit:
            clauses.append("kind NOT LIKE ?")
            args.append("%" + NOTICE_AUDIT_SUFFIX)
        if undelivered_only:
            clauses.append("delivered_at IS NULL")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at, id"
        return [self._row_to_notice(r)
                for r in self._db.execute(sql, args).fetchall()]

    @staticmethod
    def _row_to_notice(row: tuple) -> dict:
        return {
            "id": row[0], "claim_id": row[1], "lineage_anchor": row[2],
            "kind": row[3], "text": row[4], "episode_id": row[5],
            "created_at": row[6], "delivered_at": row[7],
        }

    def notice_enqueue(
        self,
        claim_id: str,
        kind: str,
        episode_id: str | None = None,
        claim_text: str = "",
        new_id: str | None = None,
        ts: float | None = None,
    ) -> list[int]:
        """The 4.1 enqueue shape: one deliverable row bound to the active
        episode (NULL between tasks) plus one audit row per evidence episode
        other than the active one. Best-effort first in the falsify chain:
        a failed INSERT is a fatal trace and never raises (plan 4.1 order:
        notice INSERT first, file handling after)."""
        ids: list[int] = []
        try:
            ids.append(self.add_notice(
                claim_id, kind,
                build_notice_text(kind, claim_id, claim_text, new_id),
                episode_id=episode_id, ts=ts,
            ))
            audit_kind = kind + NOTICE_AUDIT_SUFFIX
            for row in self.evidence(claim_id):
                ep = row["episode_id"]
                if ep == episode_id:
                    continue  # the active episode gets the deliverable row
                ids.append(self.add_notice(
                    claim_id, audit_kind,
                    build_notice_text(audit_kind, claim_id, claim_text,
                                      new_id, episode_id=ep),
                    episode_id=ep, ts=ts,
                ))
        except Exception as exc:
            self.log_trace("notice_insert_failed", {
                "fatal": True, "claim": claim_id, "kind": kind,
                "error": f"{type(exc).__name__}: {exc}",
            })
        return ids

    def notices_flush(self, episode_id: str | None = None) -> list[dict]:
        """Select-and-mark delivery (plan 4.1): in one transaction, return
        every undelivered deliverable row bound to ``episode_id`` or NULL and
        stamp delivered_at. Audit rows never flush."""
        now = time.time()
        with self._db:
            rows = self._db.execute(
                "SELECT id, claim_id, lineage_anchor, kind, text, episode_id,"
                " created_at, delivered_at FROM notices"
                " WHERE delivered_at IS NULL AND kind NOT LIKE ?"
                " AND (episode_id = ? OR episode_id IS NULL)"
                " ORDER BY created_at, id",
                ("%" + NOTICE_AUDIT_SUFFIX, episode_id),
            ).fetchall()
            self._db.executemany(
                "UPDATE notices SET delivered_at=? WHERE id=?",
                [(now, r[0]) for r in rows],
            )
        return [self._row_to_notice(r) for r in rows]

    def rebind_episode_notices(self, episode_id: str | None) -> int:
        """⑥ second half: a closing episode's undelivered deliverable rows
        come back to the cross-task queue (bound to NULL) instead of dying
        with the episode stamp."""
        if not episode_id:
            return 0
        cur = self._db.execute(
            "UPDATE notices SET episode_id=NULL WHERE episode_id=?"
            " AND delivered_at IS NULL AND kind NOT LIKE ?",
            (episode_id, "%" + NOTICE_AUDIT_SUFFIX),
        )
        self._db.commit()
        return cur.rowcount

    # --- promotion queue (plan 4.5) --------------------------------------

    def put_promotion(self, claim_id: str, decision: str, state: str,
                      ts: float | None = None) -> dict:
        """Upsert one promotion_queue row (plan 4.5). ``decision`` is the
        promotion_decision outcome, ``state`` the candidate state machine
        (pending -> approved | rejected); ``created_at`` stamps the proposal.
        The row never touches the claim itself (候选保持 ACTIVE)."""
        if decision not in PROMOTION_DECISIONS:
            raise ValueError(f"unknown promotion decision {decision!r}")
        if state not in PROMOTION_STATES:
            raise ValueError(f"unknown promotion state {state!r}")
        self._require(claim_id)
        now = time.time() if ts is None else ts
        self._db.execute(
            "INSERT INTO promotion_queue (claim_id, decision, created_at,"
            " state) VALUES (?,?,?,?)"
            " ON CONFLICT(claim_id) DO UPDATE SET"
            " decision=excluded.decision, created_at=excluded.created_at,"
            " state=excluded.state",
            (claim_id, decision, now, state),
        )
        self._db.commit()
        return {"claim_id": claim_id, "decision": decision,
                "created_at": now, "state": state}

    def promotion_row(self, claim_id: str) -> dict | None:
        """One promotion_queue row, or None when the claim was never a
        candidate (INV-1: nothing hidden, nothing invented)."""
        row = self._db.execute(
            "SELECT claim_id, decision, created_at, state FROM promotion_queue"
            " WHERE claim_id=?",
            (claim_id,),
        ).fetchone()
        return self._row_to_promotion(row) if row is not None else None

    def promotion_queue(self, state: str | None = None) -> list[dict]:
        """Candidate rows, oldest proposal first. ``state`` filters the
        state machine (pending|approved|rejected)."""
        sql = ("SELECT claim_id, decision, created_at, state"
               " FROM promotion_queue")
        args: list = []
        if state is not None:
            sql += " WHERE state=?"
            args.append(state)
        sql += " ORDER BY created_at, claim_id"
        return [self._row_to_promotion(r)
                for r in self._db.execute(sql, args).fetchall()]

    @staticmethod
    def _row_to_promotion(row: tuple) -> dict:
        return {"claim_id": row[0], "decision": row[1], "created_at": row[2],
                "state": row[3]}

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

    def resolve_conflict(self, key: str, keep_id: str, reason: str = "",
                         episode_id: str | None = None) -> None:
        """Keep one claim for ``key``; others become SUPERSEDED.

        Raises KeyError if keep_id is not a claim of this key -- a typo must
        never silently clear the key (I4: resolution is explicit).
        A terminal claim (FALSIFIED/EVICTED) is never revived by resolution.
        Each displaced sibling gets a superseded notice fan-out (plan 4.1;
        the kind is near-dead: cardify's correction path re-dedupes it to
        corrected). ``episode_id`` binds the deliverable row to the active
        episode, NULL between tasks. Rule A file retraction is not triggered
        here: that is the Memory layer's wrapper (plan 8.19).
        """
        siblings = self.claims(key=key)
        if not any(c.id == keep_id for c in siblings):
            raise KeyError(f"{keep_id} is not a claim of key {key!r}")
        displaced = self._resolve_siblings(siblings, keep_id, reason)
        for c in displaced:
            self.notice_enqueue(c.id, "superseded", episode_id=episode_id,
                                claim_text=c.text, new_id=keep_id)
        keep = self.claim(keep_id)
        if keep is not None and keep.status in (
            ClaimStatus.ACTIVE,
            ClaimStatus.CONFLICTED,
            ClaimStatus.DORMANT,
        ):
            # plan 3.4: with the displaced siblings settled, the keeper
            # adopts their unique anchor (its own claim step ran earlier)
            self._assign_lineage(keep)

    def _resolve_siblings(self, siblings: list[Claim], keep_id: str,
                          reason: str) -> list[Claim]:
        """Settle every claim of the contested key in one pass. Returns the
        displaced siblings for the superseded-notice fan-out."""
        displaced: list[Claim] = []
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
                displaced.append(c)
            self._save_claim(c)
        return displaced

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

    def delete_claim(self, claim_id: str, purge_events: bool = False,
                     episode_id: str | None = None) -> bool:
        """Physically drop one claim row with its evidence and embedding
        rows (plan 3.2 cascade).

        I3 reserves automatic deletion for falsified claims; this is the
        explicit human entry point and bypasses the lifecycle ladder on
        purpose. With purge_events the claim's source events are deleted
        too. Returns False when the claim does not exist. Traces are never
        touched (append-only replay log).

        Plan 4.1 order: the deleted-notice fan-out runs first (it reads this
        card's evidence rows), then the cascade deletes evidence and
        embeddings. Rule A file retraction is the Memory layer's wrapper.
        """
        c = self.claim(claim_id)
        if c is None:
            return False
        self.notice_enqueue(claim_id, "deleted", episode_id=episode_id,
                            claim_text=c.text)
        self._db.execute("DELETE FROM claims WHERE id=?", (claim_id,))
        self._db.execute("DELETE FROM claim_evidence WHERE claim_id=?",
                         (claim_id,))
        self._db.execute("DELETE FROM claim_embeddings WHERE claim_id=?",
                         (claim_id,))
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
