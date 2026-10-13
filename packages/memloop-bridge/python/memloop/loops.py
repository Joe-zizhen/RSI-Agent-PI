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

import math
import subprocess
import time
from dataclasses import dataclass, field
from typing import Sequence

from .core import (
    CORRECTED_REASON_PREFIX,
    Claim,
    ClaimKind,
    ClaimStatus,
    Event,
    EventKind,
    Store,
)
from .policy import DEFAULT_POLICY, Policy, match_count
from .promote_skill import (
    _slug,
    archive_contract,
    contract_in_scope,
    evict_contract,
    extract_commands,
    locate_contract,
    plan_skill,
    write_skill,
)

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
# Decision criteria (this gate and the 4.6 evidence gate) stay out of the
# dream's evolvable axes; the knob lives in Policy but is never mutated.
PROMOTE_AFTER_SUCCESSES = 3  # legacy alias; the knob lives in Policy

# evidence-gate window (plan 4.6): a loss among the newest
# VETO_RECENT_OUTCOMES non-null outcome rows vetoes the candidate
VETO_RECENT_OUTCOMES = 5

# display budget per card in the injection block; storage is never truncated
CARD_DISPLAY_MAX_CHARS = 600

# notice section budget (plan 4.1): independent of injection_max_chars, so
# notices never squeeze the card budget
NOTICE_DISPLAY_MAX_CHARS = 600

# standing usage rules; injected with every non-empty block so the model is
# taught how to treat the cards, not just handed data
# Localized strings on the Python side are intentionally not migrated this
# round (the TS bridge owns the bilingual surface via packages/memloop-bridge/
# src/t.ts). USAGE_RULES is an injection block kept in lockstep with
# memloop.ts; it stays Chinese until the Python sidecar is localized.
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
    notices: list[dict] = field(default_factory=list)  # flushed deliverable rows


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
    candidates: list[str] = field(default_factory=list)


class PromoteHashMismatch(ValueError):
    """promote_commit refusal (user-confirmation gate): a commands-carrying
    commit binds to the exact draft bytes, so a missing or stale content
    hash refuses the write. The serve layer maps it to code=hash_mismatch."""


def promotion_veto(evidence: Sequence[dict]) -> list[str]:
    """Evidence-gate veto reasons (plan 4.6, 否决式). Empty list = no veto;
    an empty evidence list never vetoes (空 evidence 不否决).

    "counterexample" -- a row with rubric_pass true and outcome false (过宽
    反例: the oracle passed but the world lost; the lesson is too broad).
    "recent_loss" -- a loss among the VETO_RECENT_OUTCOMES most recent rows
    that carry a non-null outcome. A row is judged on the columns it has
    (single-column merge rows count once)."""
    reasons: list[str] = []
    for row in evidence:
        if row.get("rubric_pass") is True and row.get("outcome") is False:
            reasons.append("counterexample")
            break
    with_outcome = [r for r in evidence if r.get("outcome") is not None]
    if any(r.get("outcome") is False
           for r in with_outcome[-VETO_RECENT_OUTCOMES:]):
        reasons.append("recent_loss")
    return reasons


def promotion_decision(claim: Claim, evidence: Sequence[dict] = (),
                       promote_after: int = PROMOTE_AFTER_SUCCESSES) -> str:
    """The promotion classifier (plan 4.5/4.6): returns "auto_ok",
    "requires_confirm" or "rejected". Pure in (claim state, evidence
    snapshot, threshold): no store, no clock, and nothing here is a dream
    axis (决策口径不进梦境进化).

    Eligibility is the four current conditions: EXPERIENCE + verify_cmd +
    success_count >= promote_after + ACTIVE. AUTO_OK = eligible + no veto +
    empty command list. REQUIRES_CONFIRM = a non-empty command list
    (mandatory, attack-surface gate) or CONFIG / user-preference semantics
    (含 correction 修订升格: preferences never auto-promote). A veto, or a
    claim outside both tracks, is 拒出候选 ("rejected"); only the user's
    explicit request (Memory.promote_request) re-grades a vetoed card, and
    that override is traced."""
    if claim.status != ClaimStatus.ACTIVE:
        return "rejected"
    if promotion_veto(evidence):
        return "rejected"
    if claim.kind == ClaimKind.CONFIG:
        return "requires_confirm"
    eligible = (claim.kind == ClaimKind.EXPERIENCE
                and claim.verify_cmd is not None
                and claim.success_count >= promote_after
                and claim.status == ClaimStatus.ACTIVE)
    if not eligible:
        return "rejected"
    return "auto_ok" if not extract_commands(claim.text) else "requires_confirm"


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


def feedback_key(text: str) -> str:
    """Deterministic claim key for a feedback-derived card: the first 24
    characters of the user's words, whitespace-collapsed and lowercased.
    Mirrors the TypeScript input path's normalizeKey(text.slice(0, 24)) so
    the same words cardified from either channel share a key and the
    correction chain's same-key supersede can hit (plan 8)."""
    return " ".join(text[:24].split()).lower()


def _cosine(a: list[float], b: list[float]) -> float | None:
    """Cosine similarity of two embedding vectors (stdlib math only).
    Dimension mismatch, empty vectors and zero-norm vectors return None:
    an incomparable pair must degrade to "no semantic signal", never
    raise (plan 3.5)."""
    if len(a) != len(b) or not a:
        return None
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return None
    return dot / math.sqrt(na * nb)


def _card_line(c: Claim, conflicted: bool) -> str:
    conf = f"{c.confidence:.2f}"
    tag = "HEARSAY" if c.hearsay else f"verify: {c.verify_cmd}"
    flag = " CONFLICTED" if conflicted else ""
    text = c.text
    if len(text) > CARD_DISPLAY_MAX_CHARS:
        text = text[:CARD_DISPLAY_MAX_CHARS] + "（全文见 memory_search）"
    return f"- ({c.key}) {text} [{conf} {tag}]{flag}"


def _notice_block(notices: list[dict]) -> str:
    """The <memloop-notice> section of the injection block (plan 4.1). The
    same tag opens the mid-task tool-result prefix. Independent
    NOTICE_DISPLAY_MAX_CHARS budget; empty input renders nothing."""
    if not notices:
        return ""
    parts: list[str] = []
    size = 0
    for n in notices:
        text = n["text"] if isinstance(n, dict) else str(n)
        line = f"- {text}"
        if parts and size + 1 + len(line) > NOTICE_DISPLAY_MAX_CHARS:
            break
        parts.append(line)
        size += 1 + len(line)
    return "<memloop-notice>" + "".join("\n" + p for p in parts) \
        + "\n</memloop-notice>"


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
        self.store.migrate_lineage(project_root)  # startup backfill (plan 3.2)
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
        # which would otherwise revive into a zombie conflict) and runs the
        # 4.1 chain on every displaced sibling
        if ev.kind == EventKind.USER_CORRECTION:
            self._correction_supersede(claim, event_id)
        elif ev.kind == EventKind.EXPLICIT_INSTRUCTION:
            # plan 4.2: instruction cards push mid-task over the notice channel
            self._notice(claim, "instructed", claim_text=claim_text)
        self.store.log_trace("cardify", {
            "claim": claim.id, "key": key, "event": event_id,
            "kind": claim.kind.value,
        }, ts=ts)
        return claim

    def _correction_supersede(self, claim: Claim, event_id: str) -> None:
        """The correction chain (plan 4.1 + (5)): same-key displaced siblings
        are superseded through resolve_conflict, each gets a corrected notice
        naming the successor card (the dedup keeps corrected over
        resolve_conflict's superseded rows), and rule A retracts their
        contracts. A PROMOTED sibling keeps its status and records the
        correction source in status_reason -- the (5) write side the anchor
        collector reads."""
        key = claim.key
        displaced: list[Claim] = []
        for other in self.store.claims(key=key):
            if other.id == claim.id:
                continue
            if other.status == ClaimStatus.PROMOTED:
                self.store.set_status(
                    other.id, ClaimStatus.PROMOTED,
                    f"{CORRECTED_REASON_PREFIX}{claim.id}",
                )
                displaced.append(other)
            elif other.status in (
                ClaimStatus.ACTIVE,
                ClaimStatus.CONFLICTED,
                ClaimStatus.DORMANT,
            ):
                displaced.append(other)
        if not displaced:
            return
        self.store.resolve_conflict(
            key, claim.id, reason=f"correction event {event_id}",
            episode_id=self._episode_id,
        )
        for other in displaced:
            # plan 4.1 order: notice INSERT first, file handling after
            self._notice(other, "corrected", new_id=claim.id)
            self._retract(other, source=f"corrected:{claim.id}")

    # -- loop 3: retrieve -------------------------------------------------

    def retrieve(
        self,
        context: str,
        limit: int | None = None,
        now: float | None = None,
        include_dormant: bool = False,
        ctx_embedding: list[float] | None = None,
        ctx_model: str | None = None,
    ) -> RetrieveResult:
        """Situational injection. Ranking is whatever ``self.policy`` says
        (deterministic rules; the offline replay may swap the policy).
        Conflicts surface instead of being hidden.

        Dormant (demoted) claims are excluded by default but recoverable:
        pass include_dormant=True to resurface them -- usage revives them
        (I3: demotion is reversible, deletion is not).

        ``ctx_embedding`` is the query vector from the embedder (plan 3.5).
        A card joins the semantic channel only when it has a stored
        embedding of the same model/dimension; otherwise its sem is None
        and the lexical path scores it exactly as before."""
        now = time.time() if now is None else now
        ctx = context.lower()
        # plan 4.1 carry-over injection: retrieve flushes the deliverable
        # notice queue for the current episode (NULL rows included) so a
        # task-internal falsify with no later tool call still reaches the
        # next task's injection block
        notices = self.store.notices_flush(self._episode_id)
        allowed = {ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED}
        if include_dormant:
            allowed.add(ClaimStatus.DORMANT)
        scored = self._rank_candidates(ctx, now, allowed,
                                       ctx_embedding, ctx_model)
        scored.sort(key=lambda t: (-t[0], t[1].created_at))
        picked = [c for _, c, _ in scored[: self.policy.limit if limit is None else limit]]
        conflicts = self.store.active_conflicts()
        # structured log: candidate snapshot, so the offline replay can
        # re-rank exactly what was in front of the agent at that moment.
        # sem is the cosine in force at that moment, or null (plan 3.5)
        self._log("retrieve", {
            "context": context,
            "policy": self.policy.name,
            "picked": [c.id for c in picked],
            "notices": [n["id"] for n in notices],
            "candidates": [
                {"id": c.id, "key": c.key, "text": c.text,
                 "confidence": c.confidence, "hearsay": c.hearsay,
                 "created_at": c.created_at, "sem": sem}
                for _, c, sem in scored
            ],
        }, ts=now)
        return RetrieveResult(
            claims=picked,
            conflicts=conflicts,
            injected=self.render(picked, conflicts, notices),
            notices=notices,
        )

    def _rank_candidates(
        self,
        ctx: str,
        now: float,
        allowed: set[ClaimStatus],
        ctx_embedding: list[float] | None,
        ctx_model: str | None,
    ) -> list[tuple[float, Claim, float | None]]:
        """Score every allowed card against the context. Zero-score cards
        never enter the candidate snapshot."""
        scored: list[tuple[float, Claim, float | None]] = []
        for c in self.store.claims():
            if c.status not in allowed:
                continue
            sem = self._sem_for(c, ctx_embedding, ctx_model)
            score = self._score(c, ctx, now, sem=sem)
            if score > 0:
                scored.append((score, c, sem))
        return scored

    def _sem_for(self, c: Claim, ctx_embedding: list[float] | None,
                 ctx_model: str | None) -> float | None:
        """Cosine of one card against the query vector, or None when the
        card has no embedding or its vector is incomparable (dimension or
        model mismatch, judged via the model column). None never raises:
        the card falls back to the lexical path (plan 3.5)."""
        if not ctx_embedding:
            return None
        emb = self.store.embedding(c.id)
        if emb is None:
            return None
        if (ctx_model is not None and emb["model"] is not None
                and emb["model"] != ctx_model):
            return None
        return _cosine(emb["vector"], ctx_embedding)

    def _score(self, c: Claim, ctx: str, now: float,
               sem: float | None = None) -> float:
        return self.policy.score(
            key=c.key, text=c.text, confidence=c.confidence,
            hearsay=c.hearsay, created_at=c.created_at, ctx=ctx, now=now,
            sem=sem,
        )

    def render(self, claims: list[Claim], conflicts: dict[str, list[str]],
               notices: list[dict] | None = None) -> str:
        """Prompt block: standing usage rules + one line per claim carrying
        provenance, confidence and verify path (or HEARSAY). Display is
        budgeted per card and in total; storage is never truncated -- the
        cutoff only redirects the reader to memory_search. The notice section
        (plan 4.1) sits inside the same wrapper under its own
        NOTICE_DISPLAY_MAX_CHARS budget and never squeezes
        injection_max_chars."""
        notice_block = _notice_block(notices or [])
        if not claims and not notice_block:
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
        body = head + "".join("\n" + p for p in parts)
        if notice_block:
            body += "\n" + notice_block
        return body + tail

    def search(self, query: str, k: int = 5,
               ctx_embedding: list[float] | None = None,
               ctx_model: str | None = None) -> list[Claim]:
        """Deep retrieval for the memory_search tool. Only the overlap==0
        hard gate filters; ranking is policy.score and truncation redirects
        here, so hearsay and dormant cards stay reachable. Returned cards
        join the episode attribution set (plan 3); the search path never
        calls record_use, so use_count keeps its retrieve mark_used
        semantics.

        The lexical pre-filter softens with semantics (plan 3.5): a
        zero-overlap card is skipped only when its sem is missing or below
        semantic_floor. Without a query embedding every card has sem=None
        and the original hard filter holds."""
        now = time.time()
        ctx = query.lower()
        scored: list[tuple[float, float, Claim]] = []
        for c in self.store.claims():
            sem = self._sem_for(c, ctx_embedding, ctx_model)
            if match_count(f"{c.key} {c.text}", ctx) == 0:
                if sem is None or sem < self.policy.semantic_floor:
                    continue
            scored.append((self._score(c, ctx, now, sem=sem), c.created_at, c))
        scored.sort(key=lambda t: (-t[0], t[1]))
        picked = [c for _, _, c in scored[:k]]
        for c in picked:
            self._episode_claims.setdefault(c.id, None)
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
        # PROMOTED stays live (plan 5.2): promotion must not disarm the
        # guard; a superseded card leaves the set and stops firing.
        if c.status not in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED,
                            ClaimStatus.PROMOTED):
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
        has no oracle (hearsay -- cannot be verified, only decayed) or the
        oracle timed out (plan 1 behavior (1): UNKNOWN, no falsify, no
        retraction, no notice). Only a deterministic non-zero exit falsifies
        the claim and runs the 4.1 chain. A real result fills the
        rubric_pass column of the open episode's evidence row (single-column
        merge, plan 3.3); outside a task there is no episode to attribute
        to (I6)."""
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
            self.store.log_trace("verify", {
                "claim": claim_id, "ok": None, "status": "unknown",
            })
            return None
        if not ok:
            self.store.falsify(claim_id, reason=f"verify failed: {c.verify_cmd}")
            # plan 4.1 order: notice INSERT first, file handling after
            self._notice(c, "retracted")
            self._retract(c, source="falsified")
        self.store.log_trace("verify", {"claim": claim_id, "ok": ok})
        if self._episode_id is not None:
            self.book_evidence(claim_id, self._episode_id, rubric_pass=ok)
        return ok

    def delete_claim(self, claim_id: str, purge_events: bool = False) -> bool:
        """Explicit deletion entry (plan 4.1): the store's notice-first
        cascade runs, then rule A retracts the card's contract. Returns
        False when the claim does not exist."""
        c = self.store.claim(claim_id)
        if c is None:
            return False
        line = self.store.lineage(claim_id)
        deleted = self.store.delete_claim(
            claim_id, purge_events=purge_events, episode_id=self._episode_id)
        if deleted:
            self._retract(c, source="deleted", line=line)
        return deleted

    def _notice(self, c: Claim, kind: str, new_id: str | None = None,
                claim_text: str = "") -> None:
        """Plan 4.1 enqueue, best-effort and first in the chain: the store
        fans out the deliverable row (active episode or NULL) and the audit
        rows, and traces a failed INSERT as fatal without raising."""
        self.store.notice_enqueue(
            c.id, kind, episode_id=self._episode_id,
            claim_text=claim_text or c.text, new_id=new_id,
        )

    def _retract(self, c: Claim, source: str = "",
                 line: dict | None = None) -> None:
        """Rule A file side (plan 4.1, move per the 4.3 decision). Scope
        gate: only a contract this card owns moves. Best-effort: one retry,
        then a trace; the notice chain already ran and is never blocked
        from here."""
        if self.project_root is None:
            return
        if line is None:
            line = self.store.lineage(c.id)
        try:
            self._retract_once(c, line, source)
            return
        except Exception as exc:
            first = f"{type(exc).__name__}: {exc}"
        try:
            self._retract_once(c, line, source)
        except Exception as exc:
            self._log("retract_failed", {
                "claim": c.id, "source": source, "error": first,
                "retry_error": f"{type(exc).__name__}: {exc}",
            })

    def _retract_once(self, c: Claim, line: dict | None,
                      source: str = "") -> None:
        """One retraction attempt: locate -> scope gate -> archive move.
        A file that cannot be archived keeps no loadable copy: the fallback
        evicts it out of the .pi/skills tree (evict_contract). Raises only
        when nothing can be written at all."""
        path = locate_contract(self.project_root, c, line)
        if path is None:
            self._log("retract_skipped", {
                "claim": c.id, "source": source,
                "reason": "contract_not_found",
            })
            return
        if not contract_in_scope(c, path, line):
            self._log("retract_skipped", {
                "claim": c.id, "source": source, "reason": "out_of_scope",
                "path": str(path),
            })
            return
        anchor = c.id if line is None else line["anchor"]
        version = 0 if line is None else int(line["last_version"])
        try:
            archived = archive_contract(path, self.project_root,
                                        _slug(anchor), version)
        except Exception:
            archived = evict_contract(path, self.project_root,
                                      _slug(anchor), version)
        self._log("retract", {
            "claim": c.id, "source": source, "archived": archived,
            "version": version,
        })

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

    def book_evidence(self, claim_id: str, episode_id: str,
                      rubric_pass: bool | None = None,
                      outcome: bool | None = None) -> None:
        """Best-effort evidence row write (plan 3.3): the usage/verdict
        record must never roll back a booked verdict, so a failed write is
        traced and swallowed. Single-column merge: only the columns passed
        here change; a later write to the same column wins."""
        try:
            self.store.add_evidence(claim_id, episode_id,
                                    rubric_pass=rubric_pass, outcome=outcome)
        except Exception as exc:
            self.store.log_trace("evidence_write_failed", {
                "claim": claim_id, "episode_id": episode_id,
                "error": f"{type(exc).__name__}: {exc}",
            })

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

    def end_episode(self) -> None:
        """Close the open episode (behavior 6): after a successful
        close_episode nothing may claim this episode id any more. The
        episode's undelivered deliverable notices rebind to NULL so they
        stay deliverable in later tasks (plan 4.1 carry-over)."""
        self.store.rebind_episode_notices(self._episode_id)
        self._episode_id = None

    @property
    def current_episode_id(self) -> str | None:
        """The episode stamp applied to loop traces, if a task is open."""
        return self._episode_id

    @property
    def episode_claim_ids(self) -> list[str]:
        """Claims attributed to the current episode: picked + guard hits +
        overridden + verified + search-returned cards. The world verdict
        lands on exactly this set."""
        return list(self._episode_claims)

    def _log(self, op: str, payload: dict, ts: float | None = None) -> int:
        """Trace stamped with the current episode id, so the replay can
        group one task's decisions into one episode."""
        if self._episode_id is not None and "episode_id" not in payload:
            payload = {**payload, "episode_id": self._episode_id}
        return self.store.log_trace(op, payload, ts=ts)

    # -- loop 6: consolidate / forget / promote ---------------------------

    def promote_request(self, claim_id: str) -> dict:
        """Plan 4.5 proposal: the contract draft behind the confirm path
        (the P3 UI shows commands 全文 + content hash; the hash binds the
        approval to exact bytes). A request on a veto-rejected card is the
        user's explicit request: the decision re-grades to REQUIRES_CONFIRM
        and the override is traced (留审计). A card outside both tracks
        raises ValueError: 拒出候选 stands. Writes the pending queue row
        and a promote_request trace."""
        c = self.store.claim(claim_id)
        if c is None:
            raise KeyError(claim_id)
        if self.project_root is None:
            raise ValueError("promote_request needs a project_root")
        evidence = self.store.evidence(claim_id)
        decision = promotion_decision(c, evidence,
                                      self.policy.promote_after_successes)
        veto = promotion_veto(evidence)
        override = False
        if decision == "rejected":
            if not veto:
                raise ValueError(
                    f"claim {claim_id} is not a promotion candidate")
            override = True
            decision = "requires_confirm"
        line = self.store.lineage(claim_id)
        plan = plan_skill(c, self.project_root,
                          anchor=None if line is None else line["anchor"])
        self.store.put_promotion(claim_id, decision, "pending")
        self._log("promote_request", {
            "claim": claim_id, "decision": decision, "override": override,
            "veto": veto, "commands": plan["commands"],
            "content_hash": plan["content_hash"],
            "version": plan["version"],
        })
        return {
            "claim_id": claim_id, "decision": decision,
            "suggest": "auto" if decision == "auto_ok" else "confirm",
            "override": override, "veto": veto,
            "slug": plan["slug"], "anchor": plan["anchor"],
            "version": plan["version"], "path": plan["path"],
            "commands": plan["commands"],
            "content_hash": plan["content_hash"],
        }

    def promote_commit(self, claim_id: str, approved: bool,
                       content_hash: str | None = None) -> dict:
        """Plan 4.5: the single skill-write port. The consolidate auto path
        and the user confirm path both land here; nothing else writes
        .pi/skills contracts.

        content_hash binds a commands-carrying commit to the exact draft
        bytes the approval saw: when the command list is non-empty, a
        missing or stale hash refuses the commit (PromoteHashMismatch ->
        op code hash_mismatch). Empty-command cards (the AUTO_OK path) are
        not gated.

        approved=True: write_skill (stamps set_lineage_version) + claim
        PROMOTED/promoted_to + claim_lineage.skill_path writeback.
        approved=False: the queue row goes rejected and the card is
        untouched (拒绝零回退). A commit on a rejected-decision card is a
        user override and is traced as one. Every approval and rejection
        writes a promote_commit trace carrying commands 全文 and the content
        hash."""
        c = self.store.claim(claim_id)
        if c is None:
            raise KeyError(claim_id)
        evidence = self.store.evidence(claim_id)
        raw = promotion_decision(c, evidence,
                                 self.policy.promote_after_successes)
        veto = promotion_veto(evidence)
        override = raw == "rejected"
        decision = "requires_confirm" if override else raw
        plan, anchor, commands, plan_hash = self._promote_plan(c)
        if commands and (plan_hash is None or content_hash != plan_hash):
            raise PromoteHashMismatch(
                f"claim {claim_id}: content hash mismatch; the draft "
                f"changed since the request, re-request it")
        content_hash = plan_hash
        path = None
        if approved:
            if plan is not None:
                path = write_skill(c, self.project_root, anchor=anchor,
                                   version=plan["version"], store=self.store)
                self.store.set_lineage_skill_path(claim_id, path)
            self.store.promote(claim_id, target=f"procedure:{c.key}")
        self.store.put_promotion(
            claim_id, decision, "approved" if approved else "rejected")
        self._log("promote_commit", {
            "claim": claim_id, "approved": approved, "decision": decision,
            "override": override, "veto": veto, "path": path,
            "commands": commands, "content_hash": content_hash,
        })
        return {
            "claim_id": claim_id, "decision": decision,
            "override": override, "veto": veto,
            "state": "approved" if approved else "rejected",
            "path": path, "commands": commands,
            "content_hash": content_hash,
        }

    def _promote_plan(self, c: Claim) -> tuple[dict | None, str | None,
                                               list[str], str | None]:
        """Build the skill plan for one promotion, or fall back to command
        extraction when there is no project_root. The commands and content
        hash feed the promote traces either way."""
        line = self.store.lineage(c.id)
        anchor = None if line is None else line["anchor"]
        plan = (plan_skill(c, self.project_root, anchor=anchor)
                if self.project_root is not None else None)
        commands = (plan["commands"] if plan is not None
                    else extract_commands(c.text))
        content_hash = None if plan is None else plan["content_hash"]
        return plan, anchor, commands, content_hash

    def consolidate(self, now: float | None = None) -> ConsolidateReport:
        """Periodic replay. Deletion is reserved for falsified claims (I3):
        unused claims are demoted out of the default injection set, never
        deleted -- "never used" is indistinguishable from "never retrieved".
        Promotes proven lessons to procedures (and, with a project_root, to
        loadable skill files) through the single commit port; a lesson that
        requires confirm becomes a pending candidate and is not written.
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
            "candidates": report.candidates,
        }, ts=now)
        return report

    def _consolidate_one(self, c: Claim, now: float) -> tuple[str | None, str | None]:
        """One claim through the drop ladder. Returns (report bucket, skill
        path written on promotion).

        Order matters: a proven lesson is promoted before silence can demote
        it, and terminal statuses are left alone (idempotent reruns).
        Promotion is decision-driven (plan 4.5): AUTO_OK commits through the
        single write port, REQUIRES_CONFIRM becomes a pending candidate with
        nothing written, and a decided queue row is never re-proposed
        (拒绝零回退). The drop ladder then applies as before.
        """
        if c.status == ClaimStatus.FALSIFIED:
            self.store.set_status(c.id, ClaimStatus.EVICTED, "falsified cleanup")
            return "evicted", None
        if c.status not in (ClaimStatus.ACTIVE, ClaimStatus.CONFLICTED):
            return None, None
        if self.store.promotion_row(c.id) is None:
            decision = promotion_decision(
                c, self.store.evidence(c.id),
                self.policy.promote_after_successes)
            if decision == "auto_ok":
                res = self.promote_commit(c.id, approved=True)
                return "promoted", res["path"]
            if decision == "requires_confirm":
                self.store.put_promotion(c.id, decision, "pending", ts=now)
                self._log("promote_request", {
                    "claim": c.id, "decision": decision, "override": False,
                    "source": "consolidate",
                }, ts=now)
                return "candidates", None
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
