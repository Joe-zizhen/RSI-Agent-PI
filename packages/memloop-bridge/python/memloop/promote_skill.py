"""Deterministic promotion: a proven EXPERIENCE claim becomes a PI skill.

Why a template and not a model: promotion must be reproducible from the
claim alone. The skill file is memory turned into loadable procedure --
the terminal state of an experience card (Q12).
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .core import Claim


def _safe_key(key: str) -> str:
    """Legacy directory rule (pre-slug layout): anything outside
    [a-zA-Z0-9_-] becomes a dash. Kept only so the startup migration and
    the 4.1 fallback can probe directories older versions wrote. New writes
    use _slug."""
    return re.sub(r"[^a-zA-Z0-9_-]", "-", key)


def _slug(anchor: str) -> str:
    """Lineage identity (plan 3.4): exp- plus the first 8 lowercase hex
    chars of sha256(anchor). ASCII-only (loader constraint), and stable
    across revisions: one lineage shares one slug."""
    return "exp-" + hashlib.sha256(anchor.encode("utf-8")).hexdigest()[:8]


def parse_frontmatter(text: str) -> dict:
    """Flat key: value pairs of the leading --- block. A file without
    frontmatter parses as empty (the 4.1 retraction still finds it)."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    meta: dict = {}
    for line in text[3:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip()
    return meta


def set_frontmatter_status(text: str, status: str) -> str:
    """Insert or replace the status: line of the leading --- block (plan
    4.1: status: superseded is the audit marker of a retracted contract).
    A file without frontmatter gets a minimal one so the marker is always
    readable."""
    if not text.startswith("---"):
        return f"---\nstatus: {status}\n---\n\n{text}"
    end = text.find("\n---", 3)
    if end < 0:
        return f"---\nstatus: {status}\n---\n\n{text}"
    head, rest = text[3:end], text[end:]
    lines = [ln for ln in head.splitlines()
             if not ln.strip().startswith("status:")]
    lines.append(f"status: {status}")
    return "---\n" + "\n".join(lines) + rest


def _same_file(a: str, b: Path) -> bool:
    return Path(a).resolve() == b.resolve()


_FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
_SPAN_RE = re.compile(r"`([^`\n]+)`")


def extract_commands(text: str) -> list[str]:
    """Deterministic command-list extraction (plan 4.4). Only code-styled
    text counts: fenced blocks contribute their non-empty lines, single
    backtick spans outside fences contribute their content, document order
    kept. Prose is never mined -- imperative sentences are not recognized
    (宁漏提不误提). verify_cmd is not an input here: it renders under
    ## verify. An empty result renders 无."""
    hits: list[tuple[int, int, list[str]]] = []
    for m in _FENCE_RE.finditer(text):
        items = [ln.strip() for ln in m.group(1).splitlines() if ln.strip()]
        hits.append((m.start(), m.end(), items))
    for m in _SPAN_RE.finditer(text):
        if any(s <= m.start() < e for s, e, _ in hits):
            continue  # a span inside a fence is fence content, not a span
        item = m.group(1).strip()
        if item:
            hits.append((m.start(), m.end(), [item]))
    out: list[str] = []
    for _, _, items in sorted(hits):
        out.extend(items)
    return out


def locate_contract(project_root: str, claim: "Claim",
                    line: dict | None) -> Path | None:
    """Find the claim's contract SKILL.md (plan 4.1 location fallback):
    claim_lineage.skill_path first, then the lineage slug directory, then
    the legacy _safe_key(key) directory. None when no file matches."""
    anchor = claim.id if line is None else line["anchor"]
    skill_path = None if line is None else line["skill_path"]
    root = Path(project_root) / ".pi" / "skills"
    candidates = [root / _slug(anchor) / "SKILL.md",
                  root / _safe_key(claim.key) / "SKILL.md"]
    if skill_path:
        candidates.insert(0, Path(skill_path))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def contract_in_scope(claim: "Claim", path: Path, line: dict | None) -> bool:
    """Rule A scope gate (plan 4.1): only the card the contract names as
    source_claim may move the file. A pre-source_claim contract (存量) passes
    only when claim_lineage.skill_path names it: with one slug shared across
    a lineage that record is the sole ownership proof."""
    meta = parse_frontmatter(path.read_text(encoding="utf-8"))
    src = meta.get("source_claim", "")
    if src:
        return src == claim.id
    skill_path = None if line is None else line["skill_path"]
    return bool(skill_path) and _same_file(skill_path, path)


def mark_description_void(text: str) -> str:
    """Fallback void marker: the frontmatter description keeps the
    「[已作废]」 prefix on its first line. A file without a description line
    gets one; a file without frontmatter gets a minimal block so the marker
    is always readable."""
    if not text.startswith("---"):
        return f'---\ndescription: "[已作废]"\n---\n\n{text}'
    end = text.find("\n---", 3)
    if end < 0:
        return f'---\ndescription: "[已作废]"\n---\n\n{text}'
    head, rest = text[3:end], text[end:]
    lines: list[str] = []
    seen = False
    for ln in head.splitlines():
        if ln.strip().startswith("description:"):
            seen = True
            value = ln.split(":", 1)[1].strip()
            if value.startswith('"'):
                value = '"[已作废]' + value[1:]
            else:
                value = "[已作废]" + value
            lines.append(f"description: {value}")
        else:
            lines.append(ln)
    if not seen:
        lines.append('description: "[已作废]"')
    return "---\n" + "\n".join(lines) + rest


def evict_contract(path: Path, project_root: str, slug: str,
                   version: int) -> str:
    """Fallback when the archive move fails: the contract directory moves
    out of the .pi/skills tree to .pi/skills_retired/<slug>-v<version>/ and
    its description carries the 「[已作废]」 prefix. The loader scans only
    .pi/skills/, so the fallback file is off the discovery surface without
    relying on .ignore or on a status line the loader does not read.
    Returns the evicted SKILL.md path; raises when nothing can be written."""
    target = (Path(project_root) / ".pi" / "skills_retired"
              / f"{slug}-v{version}")
    if target.exists():
        raise FileExistsError(f"evict target already exists: {target}")
    path.write_text(
        mark_description_void(path.read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    path.parent.rename(target)
    return str(target / "SKILL.md")


def archive_contract(path: Path, project_root: str, slug: str,
                     version: int) -> str:
    """The 4.3 retraction move: the contract directory goes to
    .pi/skills/_retired/<slug>-v<version>/, its frontmatter keeps the audit
    marker (status: superseded), and .pi/skills/.ignore gains _retired/ so
    the loader and the discovery layer skip the archive. .ignore is written
    BEFORE the rename: the loader reads no status line, so an archive that
    lands without its .ignore cover would still load. Returns the archived
    SKILL.md path; raises on any failure before the rename (the Memory
    layer retries once, then falls back to evict_contract)."""
    skills = Path(project_root) / ".pi" / "skills"
    target = skills / "_retired" / f"{slug}-v{version}"
    if target.exists():
        raise FileExistsError(f"archive target already exists: {target}")
    ignore = skills / ".ignore"
    existing = ignore.read_text(encoding="utf-8") if ignore.exists() else ""
    lines = existing.splitlines()
    if "_retired/" not in lines:
        body = existing + ("" if not existing or existing.endswith("\n")
                           else "\n") + "_retired/\n"
        ignore.write_text(body, encoding="utf-8")
    path.write_text(
        set_frontmatter_status(path.read_text(encoding="utf-8"), "superseded"),
        encoding="utf-8",
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    path.parent.rename(target)
    return str(target / "SKILL.md")


def _description(claim: Claim) -> str:
    """Loader blurb (plan 4.4): monolingual, three facets always present,
    hard cap 1024 chars. The content is the user's own words (claim.text,
    claim.key); the facet labels and the 无 marker are fixed product display
    copy, the same register as the empty-section marker. No bilingual pair
    and no language-marker field: the frontmatter key set is fixed at seven.
    Truncation shrinks the what-facet only, deterministically."""
    what = " ".join(claim.text.split())
    tail = f"。何时用：{claim.key}。何时不要用：无"
    head = "做什么："
    room = 1024 - len(head) - len(tail)
    if room <= 0:
        what = ""
    elif len(what) > room:
        what = what[:room]
    return (head + what + tail)[:1024]


def _render(claim: Claim, slug: str, anchor: str, version: int) -> str:
    """The fixed contract template (plan 4.4). Pure in (claim state, source
    events, evidence snapshot, version): no timestamps, no write order.
    Template-generated empty sections render 无, never the English "none";
    ## procedure renders claim.text verbatim and is exempt. provenance keeps
    the pinned `- successes: N` line plus claim key and source events."""
    sources = ", ".join(claim.source_event_ids)
    verify = f"`{claim.verify_cmd}`" if claim.verify_cmd else "无"
    commands = extract_commands(claim.text)
    cmd_block = ("```sh\n" + "\n".join(commands) + "\n```") if commands else "无"
    return (
        "---\n"
        f"name: {slug}\n"
        f"title: {json.dumps(claim.key, ensure_ascii=False)}\n"
        f"description: {json.dumps(_description(claim), ensure_ascii=False)}\n"
        f"version: {version}\n"
        f"source_claim: {claim.id}\n"
        f"lineage_anchor: {anchor}\n"
        "status: active\n"
        "---\n\n"
        "## procedure\n\n"
        f"{claim.text}\n\n"
        "## when-not\n\n"
        "无\n\n"
        "## verify\n\n"
        f"{verify}\n\n"
        "## commands\n\n"
        f"{cmd_block}\n\n"
        "## provenance\n\n"
        f"- claim key: {claim.key}\n"
        f"- successes: {claim.success_count}\n"
        f"- source events: {sources}\n"
    )


def contract_version(project_root: str, slug: str, claim_id: str) -> int:
    """Rule B write side (plan 4.4): the generation this write stamps.

    A rewrite over the claim's own live contract (same source_claim) keeps
    that contract's version, so the same input state yields the same bytes.
    Any other write is a successor card: version = one past the highest
    generation found in the live directory and the _retired/<slug>-v<N>/
    archives. 0-start: no history writes version 0, matching
    claim_lineage.last_version's initial value and the 4.1 archive fixture
    naming."""
    skills = Path(project_root) / ".pi" / "skills"
    live = skills / slug / "SKILL.md"
    history: set[int] = set()
    if live.is_file():
        meta = parse_frontmatter(live.read_text(encoding="utf-8"))
        raw = meta.get("version", "")
        if meta.get("source_claim") == claim_id:
            return int(raw) if raw.isdigit() else 0
        if raw.isdigit():
            history.add(int(raw))
    retired = skills / "_retired"
    if retired.is_dir():
        prefix = f"{slug}-v"
        for child in retired.iterdir():
            tail = child.name[len(prefix):] if child.name.startswith(prefix) else ""
            if tail.isdigit():
                history.add(int(tail))
    return max(history) + 1 if history else 0


def plan_skill(claim: Claim, project_root: str, anchor: str | None = None,
               version: int | None = None) -> dict:
    """The write plan of one contract (plan 4.5), pure and side-effect
    free: where write_skill would write, which bytes it would carry, the
    sha256 of those bytes (the confirm binding of promote_request), and the
    extracted command list. Same resolution rules as write_skill: anchor
    defaults to self-anchor, version resolves per rule B's write side."""
    anchor_val = claim.id if anchor is None else anchor
    slug = _slug(anchor_val)
    if version is None:
        version = contract_version(project_root, slug, claim.id)
    content = _render(claim, slug, anchor_val, version)
    return {
        "slug": slug,
        "anchor": anchor_val,
        "version": version,
        "path": str(Path(project_root) / ".pi" / "skills" / slug / "SKILL.md"),
        "content": content,
        "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "commands": extract_commands(claim.text),
    }


def write_skill(claim: Claim, project_root: str, anchor: str | None = None,
                version: int | None = None, store=None) -> str:
    """Write ``<project_root>/.pi/skills/<slug>/SKILL.md`` from a claim via
    the fixed template. ``anchor`` is the claim's claim_lineage anchor; when
    it is omitted the claim id is the anchor (self-anchored). ``version``
    stamps the generation; omitted it resolves per rule B's write side (see
    contract_version). ``store`` when given records the generation in
    claim_lineage.last_version so rule A's archive move names the directory
    after it. Overwrites an existing file (byte-idempotent for one input
    state: claim state, source events, evidence snapshot, version). Returns
    the path written."""
    plan = plan_skill(claim, project_root, anchor, version)
    path = Path(plan["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    # LF bytes on disk, exactly the bytes plan_skill hashed: Path.write_text
    # translates newlines to CRLF on Windows, which would break the
    # content_hash binding the confirm approved.
    path.write_bytes(plan["content"].encode("utf-8"))
    if store is not None:
        store.set_lineage_version(claim.id, plan["version"])
    return plan["path"]
