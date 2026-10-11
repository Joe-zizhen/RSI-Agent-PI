"""World verdict layer: where memloop's error signals come from.

Three sources, one gate. T1 is an executable verdict command run at task
end (win on exit 0; a non-zero exit re-runs once to separate failure from
flakiness). T2 is explicit user feedback: correction books a loss at full
weight, affirmation books a win at half weight (politeness noise). Anything
else is UNKNOWN and books nothing: silence is not success (I5), and an LLM
grading itself never reaches confidence.

classify_signal is a deterministic heuristic (pattern table below). A miss
classifies as "none" and books nothing -- a false negative costs a delayed
update, a false positive would pollute confidence.
"""

from __future__ import annotations

import re
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .loops import Memory

# Deterministic heuristics. Misses classify "none" and are not booked.
# Retry language ("repeat") is T3: observation only, never a Laplace entry.
CORRECTION_PATTERNS = (
    "不对", "错了", "不是这样", "应该是", "别", "不要",
    "wrong", "no,", "not what", "do not", "don't", "instead", "actually",
)
REPEAT_PATTERNS = (
    "重来", "再来一次", "再来", "还是不行", "还是错",
    "again", "retry", "still failing",
)
AFFIRMATION_PATTERNS = (
    "解决了", "可以了", "没问题", "好了", "谢谢", "就这样", "合并吧",
    "lgtm", "looks good", "fixed", "works", "done",
)


def classify_signal(text: str) -> str:
    """Classify explicit user feedback as "correction", "repeat",
    "affirmation" or "none". Correction wins when several pattern sets hit
    (asymmetric design: a correction is the stronger signal). Matching is
    case-insensitive literal substring over the tables above."""
    lowered = text.lower().replace("’", "'")
    for pat in CORRECTION_PATTERNS:
        if pat.lower() in lowered:
            return "correction"
    for pat in REPEAT_PATTERNS:
        if pat.lower() in lowered:
            return "repeat"
    for pat in AFFIRMATION_PATTERNS:
        if pat.lower() in lowered:
            return "affirmation"
    return "none"


def _run_once(cmd: str, timeout_s: float) -> int | None:
    """One verdict run. None means the run itself failed (timeout/OS error):
    that is UNKNOWN evidence, never a loss."""
    try:
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout_s,
        )
        return proc.returncode
    except (subprocess.TimeoutExpired, OSError):
        return None


def run_task_verdict(cmd: str, timeout_s: float = 120.0) -> str:
    """T1 world verdict from the project verdict command.

    First run exit 0 -> "win", and the command runs only once (plan 5.1
    row one; a verdict command may have side effects, and 0-then-non-0 is
    not a plan signal). A non-zero first exit re-runs once: second exit 0 ->
    "unknown" (flaky), second non-zero -> "loss". Timeout or OS error ->
    "unknown". Only win/loss are booked downstream."""
    first = _run_once(cmd, timeout_s)
    if first is None:
        return "unknown"
    if first == 0:
        return "win"
    second = _run_once(cmd, timeout_s)
    if second is None:
        return "unknown"
    if second == 0:
        return "unknown"  # flaky: non-zero then zero
    return "loss"


def apply_verdict(
    memory: "Memory",
    claim_ids: list[str],
    verdict: str,
    source: str,
    win_weight: float = 1.0,
    episode_id: str | None = None,
) -> None:
    """Book one world verdict onto an episode's attribution set.

    win -> success at ``win_weight`` (T2b passes 0.5), loss -> failure at
    1.0 (corrections are not softened), anything else -> nothing at all
    (the UNKNOWN gate). An overridden claim is booked the other way round
    (section 4.3 override protocol): override + win means the block was
    noise, so the card gets a failure; override + loss means the block was
    right, so the card gets a success. Only overrides of this episode flip
    (the flip must not leak into the next task). The trace keeps the task
    verdict either way so the replay can see what happened even when
    nothing was booked."""
    if episode_id is None:
        episode_id = memory.current_episode_id
    for cid in claim_ids:
        booked = verdict
        if memory.overridden(cid):
            booked = {"win": "loss", "loss": "win"}.get(verdict, verdict)
        if booked == "win":
            memory.report_outcome(
                cid, True, weight=win_weight, verdict=verdict, source=source,
                episode_id=episode_id,
            )
        elif booked == "loss":
            memory.report_outcome(
                cid, False, weight=1.0, verdict=verdict, source=source,
                episode_id=episode_id,
            )
    payload: dict = {
        "source": source, "verdict": verdict, "claim_ids": list(claim_ids),
    }
    if episode_id is not None:
        payload["episode_id"] = episode_id
    memory.store.log_trace("verdict", payload)
