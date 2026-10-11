"""memloop: a five-loop memory system for coding agents.

Not a vector store. Not a chat summarizer. An append-only event log plus
claim cards with provenance, usage-time verification, outcome-driven
confidence, and deliberate forgetting.
"""

from .core import (
    Claim,
    ClaimKind,
    ClaimStatus,
    ConfidenceWriteError,
    Event,
    EventKind,
    ProvenanceError,
    Store,
)
from .loops import ConsolidateReport, Memory, RetrieveResult
from .policy import DEFAULT_POLICY, Policy
from .replay import Episode, episodes_from_traces, replay_score, select_policy

__all__ = [
    "Claim",
    "ClaimKind",
    "ClaimStatus",
    "ConfidenceWriteError",
    "ConsolidateReport",
    "Episode",
    "Event",
    "EventKind",
    "Memory",
    "Policy",
    "DEFAULT_POLICY",
    "ProvenanceError",
    "RetrieveResult",
    "Store",
    "episodes_from_traces",
    "replay_score",
    "select_policy",
]
