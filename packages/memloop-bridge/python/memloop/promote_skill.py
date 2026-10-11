"""Deterministic promotion: a proven EXPERIENCE claim becomes a PI skill.

Why a template and not a model: promotion must be reproducible from the
claim alone. The skill file is memory turned into loadable procedure --
the terminal state of an experience card (Q12).
"""

from __future__ import annotations

import re
from pathlib import Path

from .core import Claim


def _safe_key(key: str) -> str:
    """Filesystem-safe directory name: anything outside [a-zA-Z0-9_-]
    becomes a dash, so a Chinese or punctuated key cannot escape the
    skills directory."""
    return re.sub(r"[^a-zA-Z0-9_-]", "-", key)


def _render(claim: Claim, safe_key: str) -> str:
    sources = ", ".join(claim.source_event_ids)
    verify = claim.verify_cmd or ""
    return (
        "---\n"
        f"name: {safe_key}\n"
        f"description: memloop promoted experience card ({safe_key})\n"
        "---\n\n"
        f"# {safe_key}\n\n"
        f"{claim.text}\n\n"
        "## verify\n\n"
        f"`{verify}`\n\n"
        "## provenance\n\n"
        f"- successes: {claim.success_count}\n"
        f"- source events: {sources}\n"
    )


def write_skill(claim: Claim, project_root: str) -> str:
    """Write ``<project_root>/.pi/skills/<key>/SKILL.md`` from a claim via
    the fixed template. Overwrites an existing file (idempotent: same claim
    yields the same bytes). Returns the path written."""
    safe = _safe_key(claim.key)
    path = Path(project_root) / ".pi" / "skills" / safe / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_render(claim, safe), encoding="utf-8")
    return str(path)
