"""Bounded, deterministic navigation over a device's allowed project files.

No model, subprocess, persisted index, cloud write, or learner evidence is produced.
The existing Broker owns exclusion policy; this reader only adds resource budgets.
"""
from __future__ import annotations

from collections import deque
from itertools import islice
import os
from pathlib import Path, PurePosixPath
import re
import stat

from app.services.workspace_files import WorkspaceError, canonical_root, resolve_workspace_path

SCHEMA_VERSION = "learnflow.workspace-recommendations.v1"
MAX_FILES = 500
MAX_DIRECTORIES = 128
MAX_DEPTH = 8
MAX_ENTRIES = 4096
MAX_DIRECTORY_ENTRIES = 512
MAX_READ_FILES = 32
MAX_FILE_BYTES = 64 * 1024
MAX_READ_BYTES = 1024 * 1024
MAX_SEEDS = 2


def select_stage(workflow: dict, checkpoint_id: int | None, project_mode: str) -> dict | None:
    """Use only the authoritative workflow projection, including its unlock status."""
    composed = project_mode in {"experiment", "practice"}
    if composed and (workflow.get("schema_version") != "learnflow.project-workflow.v1"
                     or workflow.get("project_mode") != project_mode or not workflow.get("initialized")):
        raise WorkspaceError(409, "请先建立当前项目的正式阶段路线", "workflow_required")
    if checkpoint_id is None:
        if composed:
            raise WorkspaceError(400, "请先选择当前项目阶段", "checkpoint_required")
        return None
    stage = next((item for item in workflow.get("milestones", [])
                  if isinstance(item, dict) and item.get("checkpoint_id") == checkpoint_id), None)
    if not stage:
        raise WorkspaceError(404, "当前项目没有这个阶段", "checkpoint_not_found")
    if stage.get("status") not in {"available", "accepted"}:
        raise WorkspaceError(403, "请先完成前置阶段，再查看相关文件", "checkpoint_locked")
    return stage


def _allowed_file(root: Path, relative: str) -> tuple[Path, os.stat_result] | None:
    # Import the host's existing policy, including any subsequently added exclusions.
    from app.services.local_agent_broker import _directory_skip_reason, _file_skip_reason
    try:
        relative, path = resolve_workspace_path(root, relative, actor="agent")
        parts = PurePosixPath(relative).parts
        for index in range(1, len(parts)):
            parent = root.joinpath(*parts[:index])
            if _directory_skip_reason("/".join(parts[:index]), parent, parent.stat(follow_symlinks=False)):
                return None
        info = path.stat(follow_symlinks=False)
        return None if _file_skip_reason(relative, path, info) else (path, info)
    except (OSError, WorkspaceError):
        return None


def _files(root: Path) -> tuple[dict[str, os.stat_result], bool]:
    from app.services.local_agent_broker import _directory_skip_reason, _file_skip_reason
    queue = deque([(root, 0)])
    found: dict[str, os.stat_result] = {}
    directories = entries = 0
    truncated = False
    while queue and directories < MAX_DIRECTORIES and entries < MAX_ENTRIES and len(found) < MAX_FILES:
        directory, depth = queue.popleft()
        if directory != root:
            try:
                relative, checked = resolve_workspace_path(root, directory.relative_to(root).as_posix(), actor="agent")
                if _directory_skip_reason(relative, checked, checked.stat(follow_symlinks=False)):
                    continue
            except (OSError, WorkspaceError):
                continue
        directories += 1
        try:
            with os.scandir(directory) as iterator:
                children = list(islice(iterator, min(MAX_DIRECTORY_ENTRIES, MAX_ENTRIES - entries) + 1))
            # Skip an oversized directory instead of letting filesystem enumeration order pick winners.
            if len(children) > min(MAX_DIRECTORY_ENTRIES, MAX_ENTRIES - entries):
                truncated = True
                entries += len(children) - 1
                continue
            entries += len(children)
            for child in sorted(children, key=lambda item: (item.name.casefold(), item.name)):
                path = Path(child.path)
                relative = path.relative_to(root).as_posix()
                try:
                    info = child.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(info.st_mode):
                    if not _directory_skip_reason(relative, path, info):
                        if depth < MAX_DEPTH:
                            queue.append((path, depth + 1))
                        else:
                            truncated = True
                elif not _file_skip_reason(relative, path, info):
                    if len(found) >= MAX_FILES:
                        truncated = True
                        break
                    found[relative] = info
        except OSError:
            continue
    return found, truncated or bool(queue)


def _read_text(root: Path, relative: str, expected: os.stat_result) -> str | None:
    allowed = _allowed_file(root, relative)
    if not allowed or expected.st_size > MAX_FILE_BYTES:
        return None
    path, info = allowed
    identity = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns)
    if identity(info) != identity(expected):
        return None
    descriptors: list[int] = []
    try:
        if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
            # Open each component relative to an already-open directory; never follow a swapped link.
            flags = os.O_RDONLY | os.O_NOFOLLOW
            descriptors.append(os.open(root, flags | os.O_DIRECTORY))
            parts = PurePosixPath(relative).parts
            for part in parts[:-1]:
                descriptors.append(os.open(part, flags | os.O_DIRECTORY, dir_fd=descriptors[-1]))
            descriptor = os.open(parts[-1], flags | getattr(os, "O_NONBLOCK", 0), dir_fd=descriptors[-1])
        else:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        descriptors.append(descriptor)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode) or identity(os.fstat(descriptor)) != identity(info):
            return None
        raw = os.read(descriptor, info.st_size + 1)
        checked = _allowed_file(root, relative)
        if len(raw) != info.st_size or identity(os.fstat(descriptor)) != identity(info) or not checked or identity(checked[1]) != identity(info):
            return None
        if b"\x00" in raw:
            return None
        return raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z][a-z0-9]{2,63}", value.casefold()))


def _neighbors(relative: str, text: str, allowed: dict) -> list[tuple[str, int]]:
    """One-hop literal local includes/imports only; no package or dynamic resolution."""
    result: list[tuple[str, int]] = []
    comments = re.compile(r'("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')|(//[^\n]*|/\*[\s\S]*?\*/)')
    text = comments.sub(lambda match: match.group(1) or "\n" * match.group(0).count("\n"), text)
    for line_number, line in enumerate(text.splitlines(), 1):
        include = re.match(r'\s*#\s*include\s*"([^"\n]+)"', line)
        imported = re.match(r'\s*(?:import\s+(?:[^\n;]*?\s+from\s*)?|export\s+[^\n;]*?\s+from\s*|(?:const|let|var)\s+[\w$]+\s*=\s*require\(\s*)[\'"](\.[^\'"\n]+)[\'"]', line)
        target = include.group(1) if include else imported.group(1) if imported else None
        if not target or "\\" in target or target.startswith("/"):
            continue
        # Resolve .. lexically inside the root; the allowed inventory still grants access.
        parts = list(PurePosixPath(relative).parent.parts)
        for part in target.split("/"):
            if part in {"", "."}:
                continue
            if part == "..":
                if not parts:
                    parts = []
                    break
                parts.pop()
            else:
                parts.append(part)
        else:
            name = "/".join(parts)
            options = [name] if include or PurePosixPath(name).suffix else [name + suffix for suffix in (".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js")]
            matches = [item for item in options if item in allowed]
            if len(matches) == 1 and matches[0] != relative:
                result.append((matches[0], line_number))
        if len(result) >= 12:
            break
    return result


def recommend_files(root: Path, stage: dict | None, *, project_id: int,
                    checkpoint_id: int | None, limit: int = 6, project_context: dict | None = None) -> dict:
    result = {"schema_version": SCHEMA_VERSION, "project_id": project_id,
              "checkpoint_id": checkpoint_id, "stage_key": stage.get("key") if stage else None,
              "items": [], "truncated": False, "status": "no_stage" if not stage else "no_matches",
              "learning_evidence": False}
    if not stage:
        return result
    root = canonical_root(str(root))
    hints = []
    # An explicit stage file must not disappear merely because another directory exhausts discovery.
    files = {}
    for hint in (stage.get("related_files") or [])[:8]:
        if not isinstance(hint, dict) or not isinstance(hint.get("path"), str):
            continue
        checked = _allowed_file(root, hint["path"])
        if checked:
            path = checked[0].relative_to(root).as_posix()
            files[path] = checked[1]
            hints.append({**hint, "path": path})
    discovered, result["truncated"] = _files(root)
    for path, info in discovered.items():
        if path in files:
            continue
        if len(files) >= MAX_FILES:
            result["truncated"] = True
            break
        files[path] = info
    ranked: dict[str, dict] = {}
    stage_key = str(stage.get("key") or "")[:120]

    def add(path: str, score: int, reason: str, provenance: dict):
        if path not in files:
            return
        item = ranked.setdefault(path, {"path": path, "reason": reason[:240], "provenance": [], "size": files[path].st_size, "score": score})
        item["score"] = max(item["score"], score)
        if len(item["provenance"]) < 3 and provenance not in item["provenance"]:
            item["provenance"].append({"stage_key": stage_key, **provenance})

    for index, hint in enumerate(hints):
        add(hint["path"], 1000 - index, str(hint.get("reason") or "当前阶段关联的工程文件"), {"rule": "stage_related_file"})
    materials = [item for item in (stage.get("materials") or [])[:12] if isinstance(item, dict)]
    text = "\n".join([str(stage.get("title") or ""), str(stage.get("objective") or "")]
                     + [str(item.get("body") or "")[:8000] for item in materials])[:24000]
    keywords = _tokens(text)
    project_text = "\n".join(str((project_context or {}).get(key) or "")[:500] for key in ("name", "objective"))
    project_keywords = _tokens(project_text)
    for path in files:
        for material in materials:
            body = str(material.get("body") or "")[:8000]
            if re.search(r"(?<![\w./-])" + re.escape(path) + r"(?![\w./-])", body):
                add(path, 800, "当前阶段材料明确提到此文件", {"rule": "stage_path", "material_id": str(material.get("id") or "")[:120]})
        stem = PurePosixPath(path).stem
        matches = sorted(_tokens(stem) & (keywords | project_keywords))
        chinese = bool(re.search(r"[\u4e00-\u9fff]", stem)) and len(stem) >= 2 and stem in text + "\n" + project_text
        if matches or chinese:
            add(path, 100 + min(len(matches), 5), "文件名与项目或当前阶段主题相符", {"rule": "filename_keyword", "terms": matches[:5] or [stem[:80]]})
    order = lambda item: (-item["score"], item["path"].casefold(), item["path"])
    read: dict[str, str | None] = {}
    read_bytes = 0

    def content(path: str) -> str | None:
        nonlocal read_bytes
        if path not in read:
            size = files[path].st_size
            if len(read) >= MAX_READ_FILES or size > MAX_FILE_BYTES or read_bytes + size > MAX_READ_BYTES:
                result["truncated"] = True
                return None
            read_bytes += size
            read[path] = _read_text(root, path, files[path])
        return read[path]

    seeds = 0
    for item in sorted(list(ranked.values()), key=order):
        source = content(item["path"])
        if source is None:
            continue
        for neighbor, line in _neighbors(item["path"], source, files):
            add(neighbor, 50, f"{item['path']} 直接引用的本地文件", {"rule": "local_import", "source_path": item["path"], "line": line})
        seeds += 1
        if seeds >= MAX_SEEDS:
            break
    for item in sorted(ranked.values(), key=order):
        if content(item["path"]) is not None:
            result["items"].append({key: value for key, value in item.items() if key != "score"})
            if len(result["items"]) >= max(1, min(6, limit)):
                break
    if result["items"]:
        result["status"] = "ready"
    return result
