"""Read-only project-source knowledge-domain projections.

These projections describe what processed sources contain.  They are context
for route and content decisions, never learner-state or mastery evidence.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.models.project import Chunk, Source


_MARKDOWN_HEADING = re.compile(r"^\s{0,3}#{1,4}\s+(.+?)\s*$")


def derive_source_knowledge_domains(
    source: Source,
    chunks: list[Chunk],
) -> list[dict[str, str]]:
    """Derive a bounded, inspectable domain index for every source type.

    This is intentionally deterministic.  It indexes headings and source
    structure for retrieval, but never turns source contents into learner
    knowledge or mastery evidence.
    """
    meta = source.meta_data or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            meta = {}
    analysis = dict(meta.get("repo_analysis") or {})
    domains: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(label: object, evidence: str, summary: object = "") -> None:
        value = " ".join(str(label or "").split())[:160]
        key = value.casefold()
        if not value or key in seen or len(domains) >= 18:
            return
        seen.add(key)
        domains.append({
            "label": value,
            "evidence": evidence,
            "summary": " ".join(str(summary or "").split())[:360],
        })

    for item in analysis.get("readme_toc") or []:
        if isinstance(item, dict):
            add(item.get("title"), "README 目录")
    for group in analysis.get("dir_groups") or []:
        if isinstance(group, dict) and group.get("is_chapter"):
            add(group.get("name") or group.get("dir"), "章节目录")

    for chunk in sorted(chunks, key=lambda item: item.index):
        chunk_meta = chunk.meta_data or {}
        for key in ("heading", "title", "section", "chapter"):
            add(chunk_meta.get(key), f"内容块 {chunk.index + 1} 元数据")
        for line in str(chunk.content or "").splitlines()[:80]:
            match = _MARKDOWN_HEADING.match(line)
            if match:
                add(match.group(1), f"内容块 {chunk.index + 1} 标题")
        if len(domains) >= 18:
            break

    if not domains:
        upload = dict(meta.get("upload") or {})
        source_name = upload.get("original_filename") or source.url
        add(source_name, "来源名称", str(chunks[0].content if chunks else "")[:240])
    return domains


def repository_knowledge_domains(sources: list[Source]) -> list[dict[str, Any]]:
    """Return the legacy grouped domain shape used by the roadmap planner."""
    result: list[dict[str, Any]] = []
    for source in sources:
        meta = source.meta_data or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except json.JSONDecodeError:
                meta = {}
        analysis = dict(meta.get("repo_analysis") or {})
        seen: set[str] = set()
        domains: list[dict[str, str]] = []

        def add(label: object, evidence: str) -> None:
            value = " ".join(str(label or "").split())[:160]
            key = value.casefold()
            if value and key not in seen and len(domains) < 12:
                seen.add(key)
                domains.append({"label": value, "evidence": evidence})

        for item in meta.get("knowledge_domains") or []:
            if isinstance(item, dict):
                add(item.get("label"), str(item.get("evidence") or "来源索引"))
        for item in analysis.get("readme_toc") or []:
            if isinstance(item, dict):
                add(item.get("title"), "README 目录")
        for group in analysis.get("dir_groups") or []:
            if isinstance(group, dict) and group.get("is_chapter"):
                add(group.get("name") or group.get("dir"), "章节目录")
        if not domains:
            for path in (analysis.get("file_summaries") or {}).keys():
                add(path, "文件摘要路径")

        if domains:
            result.append({
                "source_id": source.id,
                "role": source.role or "main",
                "type": source.type,
                "structure_logic": analysis.get("structure_logic", "document"),
                "domains": domains,
            })
    return result


def flatten_repository_knowledge_domains(sources: list[Source]) -> list[dict[str, Any]]:
    """Return the bounded ACI shape consumed by the vNext Tutor runtime."""
    flattened: list[dict[str, Any]] = []
    for source in repository_knowledge_domains(sources):
        for index, domain in enumerate(source["domains"]):
            label = str(domain["label"])
            flattened.append({
                "id": f"project-source:{source['source_id']}:domain:{index + 1}",
                "title": label,
                "summary": (
                    f"由来源 {source['source_id']} 的{domain['evidence']}支持；"
                    f"来源角色 {source['role']}，结构 {source['structure_logic']}。"
                ),
                "labels": [label, str(source["type"]), str(source["role"])],
                "source_ids": [str(source["source_id"])],
            })
    return flattened[:30]
