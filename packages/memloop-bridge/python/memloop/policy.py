"""The strategy layer: everything here is what an offline replay may evolve.

Dream-RSI's key separation (arXiv:2609.14858): only the policy code changes;
models, evaluator, and interfaces stay fixed. In memloop the "policy" is
this module -- deterministic ranking/lifecycle rules with no LLM inside.
`replay.py` evaluates candidate policies offline against recorded decisions
before anything is deployed (see select_policy: the incumbent is always in
the candidate pool, so the winner is never worse than what is running).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, fields, replace

from .core import (
    DEFAULT_TTL_S,
    DORMANT_AFTER_UNUSED_S,
    HEARSAY_TTL_S,
)


def _tokens(text: str) -> set[str]:
    """Split into matchable units: latin words plus CJK bigrams.

    Why bigrams: CJK text has no spaces, so word splitting is unavailable
    and a latin-only tokenizer scores Chinese at zero -- a hard retrieval
    miss on a Chinese-first workload. A 2-char window is the smallest unit
    that still discriminates; a single-character CJK string degrades to
    that character as its own token.
    """
    out = set()
    for tok in re.split(r"[^a-z0-9]+", text.lower()):
        if len(tok) >= 2:
            out.add(tok)
            if len(tok) > 3 and tok.endswith("s"):
                out.add(tok[:-1])  # crude stem: tests -> test
    for run in re.findall(r"[\u3400-\u9fff]+", text):
        if len(run) == 1:
            out.add(run)
        else:
            out.update(run[i:i + 2] for i in range(len(run) - 1))
    return out


def match_count(hay: str, ctx: str) -> int:
    hay_toks = _tokens(hay)
    return sum(1 for tok in _tokens(ctx) if tok in hay_toks)


@dataclass(frozen=True)
class Policy:
    """Deterministic retrieval + lifecycle rules. Frozen so a replay run
    cannot mutate the policy it is scoring."""

    name: str = "default"
    # retrieval ranking weights
    w_overlap: float = 1.0
    w_confidence: float = 2.0
    w_recency: float = 1.0
    w_semantic: float = 0.3
    semantic_floor: float = 0.3
    hearsay_penalty: float = 0.5
    limit: int = 8
    # lifecycle thresholds
    ttl_s: float = DEFAULT_TTL_S
    hearsay_ttl_s: float = HEARSAY_TTL_S
    dormant_after_s: float = DORMANT_AFTER_UNUSED_S
    promote_after_successes: int = 3
    # guidance thresholds: L0 injection budget, L1 reminder floor,
    # L2 hard-block gate (confidence + world-verdict count + oracle)
    l1_min_confidence: float = 0.6
    l2_min_confidence: float = 0.8
    l2_min_outcomes: int = 3
    l2_require_verify: bool = True
    injection_max_chars: int = 1800

    def score(
        self,
        *,
        key: str,
        text: str,
        confidence: float,
        hearsay: bool,
        created_at: float,
        ctx: str,
        now: float,
        sem: float | None = None,
    ) -> float:
        overlap = match_count(f"{key} {text}", ctx)
        if sem is None:
            if overlap == 0:
                return 0.0
        elif overlap == 0 and sem < self.semantic_floor:
            return 0.0
        recency = 1.0 / (1.0 + max(0.0, now - created_at) / 86400.0)
        score = (self.w_overlap * overlap
                 + self.w_confidence * confidence
                 + self.w_recency * recency)
        if sem is not None:
            score += self.w_semantic * sem
        if hearsay:
            score -= self.hearsay_penalty
        return score

    def effective_ttl_s(self, hearsay: bool, ttl_s: float | None) -> float:
        if hearsay:
            return self.hearsay_ttl_s
        return self.ttl_s if ttl_s is None else ttl_s

    def variant(self, name: str, **changes) -> "Policy":
        return replace(self, name=name, **changes)


def policy_from_dict(d: dict) -> Policy:
    """Rebuild a Policy from a decoded policy.json object. Unknown keys are
    dropped so a file written by an older version still loads."""
    known = {f.name for f in fields(Policy)}
    return Policy(**{k: v for k, v in d.items() if k in known})


DEFAULT_POLICY = Policy()
