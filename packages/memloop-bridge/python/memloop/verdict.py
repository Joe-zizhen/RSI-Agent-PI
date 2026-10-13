"""World verdict layer: where memloop's error signals come from.

Three sources, one gate. T1 is an executable verdict command run at task
end (win on exit 0; a non-zero exit re-runs once to separate failure from
flakiness). T2 is explicit user feedback: correction books a loss at full
weight, affirmation books a win at half weight (politeness noise). Anything
else is UNKNOWN and books nothing: silence is not success (I5), and an LLM
grading itself never reaches confidence.

classify_signal is a deterministic high-precision fast path (pattern table
below). A miss classifies as "none" and books nothing -- a false negative
costs a delayed update, a false positive would pollute confidence.
"""

from __future__ import annotations

import re
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .loops import Memory

# Fast-path table (plan 3.5 8): keep only unambiguous words that cannot
# appear in ordinary narrative sentences. Misses classify "none" and are
# not booked. Retry language ("repeat") is T3: observation only, never a
# Laplace entry.
#
# Per-word sign-off (rewrite list 11). Retained vocabulary and cut
# vocabulary with one reason per cut word. This block mirrors the sample
# assertions in tests/test_verdict.py. Change a table only together with a
# matching test change.
#
# RETAINED (signed)
#   CORRECTION   不对, 别用
#     Both are exact feedback phrases. Neither appears in narrative prose.
#   AFFIRMATION  lgtm
#     A pure approval token. It carries no narrative meaning.
#   REPEAT (full table, signed)
#     重来, 再来一次, 再来, 还是不行, 还是错, again, retry, still failing
#     The T3 table stays whole. A repeat is observation only and never
#     books confidence.
#
# CUT (signed), one reason per word
#   错了        Narrative use ("打错了字"). 还是错 covers the repeat case.
#   不是这样     Narrative explanation ("它的用法不是这样").
#   应该是       Speculation ("端口应该是 8080"). Speculation is not a verdict.
#   别          Too broad. It also hits "特别" and "别忘了".
#   不要         Narrative rule quoting ("文档说不要重试").
#   wrong       Narrative use ("the wrong port").
#   no,         A comma-bound fragment. It also hits "no, wait".
#   not what    Narrative use ("that is not what I meant").
#   do not      Narrative rule quoting ("do not use X").
#   don't       Narrative use ("we don't support X"). See the apostrophe test.
#   instead     Advisory use ("use X instead"). Advisory is not a verdict.
#   actually    Filler ("actually the port is 9090"). Filler is not a verdict.
#   解决了       Outcome report. Also narrative ("上次的问题解决了").
#   可以了       Politeness noise. lgtm alone is the signed affirmation.
#   没问题       Politeness noise. Also narrative ("部署没问题的时候").
#   好了         Narrative use ("好了之后再跑").
#   谢谢         Politeness. It carries no verdict content.
#   就这样       Completion noise. Also narrative ("就这样定了").
#   合并吧       Action request ("合并吧"). A request is not a verdict.
#   looks good  Review comment on a diff. lgtm alone is the signed affirmation.
#   fixed       Changelog narrative ("fixed in #12").
#   works       Narrative use ("works with python3.12").
#   done        Task-list narrative ("when done, run tests").
#
# Mirror anchors (tests/test_verdict.py):
#   "不对，端口应该是 9090" -> correction  "别用 make，重来" -> correction
#   "还是错了，不是这样" -> repeat         "解决了，谢谢" -> none
#   "可以了 就这样" -> none                "this is wrong, do not use make" -> none
#   "actually the port is 9090" -> none    "don't merge yet, instead rebase" -> none
#   "lgtm, looks good" -> affirmation      "the build is fixed, works now" -> none
CORRECTION_PATTERNS = (
    "不对", "别用",
)
REPEAT_PATTERNS = (
    "重来", "再来一次", "再来", "还是不行", "还是错",
    "again", "retry", "still failing",
)
AFFIRMATION_PATTERNS = (
    "lgtm",
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
) -> dict[str, bool | None]:
    """Book one world verdict onto an episode's attribution set.

    win -> success at ``win_weight`` (T2b passes 0.5), loss -> failure at
    1.0 (corrections are not softened), anything else -> nothing at all
    (the UNKNOWN gate). An overridden claim is booked the other way round
    (section 4.3 override protocol): override + win means the block was
    noise, so the card gets a failure; override + loss means the block was
    right, so the card gets a success. Only overrides of this episode flip
    (the flip must not leak into the next task). The trace keeps the task
    verdict either way so the replay can see what happened even when
    nothing was booked.

    Returns the booked success flag per claim (True/False), or None when
    the gate booked nothing: this is the value evidence rows record as
    ``outcome`` (plan 3.3)."""
    if episode_id is None:
        episode_id = memory.current_episode_id
    booked_map: dict[str, bool | None] = {}
    for cid in claim_ids:
        booked = verdict
        if memory.overridden(cid):
            booked = {"win": "loss", "loss": "win"}.get(verdict, verdict)
        success: bool | None = None
        if booked == "win":
            memory.report_outcome(
                cid, True, weight=win_weight, verdict=verdict, source=source,
                episode_id=episode_id,
            )
            success = True
        elif booked == "loss":
            memory.report_outcome(
                cid, False, weight=1.0, verdict=verdict, source=source,
                episode_id=episode_id,
            )
            success = False
        booked_map[cid] = success
    payload: dict = {
        "source": source, "verdict": verdict, "claim_ids": list(claim_ids),
    }
    if episode_id is not None:
        payload["episode_id"] = episode_id
    memory.store.log_trace("verdict", payload)
    return booked_map
