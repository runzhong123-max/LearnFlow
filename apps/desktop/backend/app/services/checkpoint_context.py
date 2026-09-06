from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import (
    Checkpoint, CheckpointChunk, Chunk, Exercise, Lecture, Project,
    ProjectWorkspace, Roadmap,
)
from app.services.five_kernel_context import (
    build_five_kernel_context,
    compact_projection_from_packet,
    resolve_context_policy,
)
from app.services.workspace_files import WorkspaceError, canonical_root, scan_workspace_tree


def _short(value: object, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit]


def _flatten_workspace_nodes(nodes: list[dict], limit: int = 300) -> list[dict]:
    result: list[dict] = []

    def visit(items: list[dict]):
        for item in items:
            if len(result) >= limit:
                return
            result.append({
                "path": item.get("path"),
                "kind": item.get("kind"),
                "size": item.get("size", 0),
                "is_directory": item.get("is_directory", False),
            })
            children = item.get("children")
            if isinstance(children, list):
                visit(children)

    visit(nodes)
    return result


async def checkpoint_artifacts(
    db: AsyncSession, *, learner_id: int, checkpoint_id: int,
) -> dict[str, Any] | None:
    checkpoint = (await db.execute(
        select(Checkpoint, Roadmap, Project)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(Checkpoint.id == checkpoint_id, Project.learner_id == learner_id)
    )).one_or_none()
    if not checkpoint:
        return None
    checkpoint_row, roadmap, project = checkpoint
    lecture = (await db.execute(select(Lecture).where(
        Lecture.checkpoint_id == checkpoint_id,
    ))).scalar_one_or_none()
    exercises = list((await db.execute(select(Exercise).where(
        Exercise.checkpoint_id == checkpoint_id,
    ).order_by(Exercise.order, Exercise.id))).scalars().all())
    return {
        "project": {"id": project.id, "name": project.name},
        "checkpoint": {
            "id": checkpoint_row.id,
            "title": checkpoint_row.title,
            "description": checkpoint_row.description or "",
            "status": checkpoint_row.learning_status or "not_started",
        },
        "managed_lecture": ({
            "kind": "managed_lecture",
            "id": lecture.id,
            "checkpoint_id": checkpoint_id,
            "status": lecture.status,
            "version": int(lecture.version or 1),
            "logical_filename": f"{checkpoint_row.order:02d}-{checkpoint_row.title}.lflecture",
            "open_target": f"/projects/{project.id}/checkpoints/{checkpoint_id}",
            "allowed_operations": ["read", "annotate", "edit_versioned", "view_versions"],
            "section_count": len(lecture.sections or []),
        } if lecture else None),
        "managed_exercises": [{
            "kind": "managed_exercise",
            "id": item.id,
            "checkpoint_id": checkpoint_id,
            "title": item.title,
            "order": item.order,
            "version": 1,
            "logical_filename": f"{item.order + 1:02d}-{item.title}.lfexercise",
            "open_target": f"/projects/{project.id}/checkpoints/{checkpoint_id}/exercises?exercise={item.id}",
            "allowed_operations": ["read", "annotate", "edit_draft", "run", "submit"],
            "virtual_files": [
                {"name": value.get("name"), "read_only": bool(value.get("read_only"))}
                for value in (item.files or []) if isinstance(value, dict)
            ],
        } for item in exercises],
        "authority": {
            "lecture_and_exercise": "database",
            "ordinary_project_files": "local_workspace",
        },
    }


async def build_checkpoint_tutor_context(
    db: AsyncSession,
    *,
    learner_id: int,
    project_id: int,
    checkpoint_id: int,
    session_id: int | None = None,
    query: str = "",
    surface_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    artifacts = await checkpoint_artifacts(
        db, learner_id=learner_id, checkpoint_id=checkpoint_id,
    )
    if not artifacts or int(artifacts["project"]["id"]) != project_id:
        raise ValueError("关卡不属于当前项目")

    checkpoint = await db.get(Checkpoint, checkpoint_id)
    lecture = (await db.execute(select(Lecture).where(
        Lecture.checkpoint_id == checkpoint_id,
    ))).scalar_one_or_none()
    exercises = list((await db.execute(select(Exercise).where(
        Exercise.checkpoint_id == checkpoint_id,
    ).order_by(Exercise.order, Exercise.id))).scalars().all())
    assigned = list((await db.execute(
        select(CheckpointChunk, Chunk)
        .join(Chunk, Chunk.id == CheckpointChunk.chunk_id)
        .where(CheckpointChunk.checkpoint_id == checkpoint_id)
        .order_by(CheckpointChunk.id)
    )).all())
    workspace_nodes: list[dict] = []
    workspace = (await db.execute(select(ProjectWorkspace).where(
        ProjectWorkspace.project_id == project_id,
        ProjectWorkspace.learner_id == learner_id,
        ProjectWorkspace.status == "linked",
    ))).scalar_one_or_none()
    if workspace:
        try:
            root = canonical_root(workspace.root_path)
            workspace_nodes = _flatten_workspace_nodes(scan_workspace_tree(root))
        except WorkspaceError:
            # A disconnected folder must not make the Tutor session unusable.
            workspace_nodes = []

    incoming = dict(surface_context or {})
    selected_text = incoming.get("selected_text")
    if isinstance(selected_text, str):
        incoming["selected_text"] = selected_text[:12000]
    for content_key in ("code", "content", "file_content"):
        incoming.pop(content_key, None)
    allowed_surface = {
        key: incoming[key]
        for key in (
            "surface", "resource_kind", "resource_id", "title", "section_index",
            "selected_text", "selected_path", "open_file", "language",
        )
        if key in incoming
    }
    subject_keys = [f"checkpoint:{checkpoint_id}"]
    selected_path = allowed_surface.get("selected_path")
    if selected_path:
        subject_keys.append(f"file:{selected_path}")
    packet = await build_five_kernel_context(
        db,
        learner_id=learner_id,
        policy=resolve_context_policy(session_type="checkpoint"),
        project_id=project_id,
        checkpoint_id=checkpoint_id,
        session_id=session_id,
        subject_keys=subject_keys,
        query=query or str(allowed_surface.get("selected_text") or ""),
    )

    from app.services.project_workflows import workflow_view
    project = await db.get(Project, project_id)
    project_workflow = await workflow_view(db, project, compact=True, checkpoint_id=checkpoint_id)
    return {
        "project_workflow": project_workflow,
        "scope": {
            "learner_id": learner_id,
            "project_id": project_id,
            "checkpoint_id": checkpoint_id,
            "history_policy": "this_checkpoint_session_only",
        },
        "five_kernel_projection": compact_projection_from_packet(
            packet, project_id=project_id, checkpoint_id=checkpoint_id,
        ),
        "five_kernel_context": packet,
        "checkpoint": {
            **artifacts["checkpoint"],
            "brief": dict(checkpoint.brief or {}) if checkpoint else {},
        },
        "assigned_resources": [{
            "chunk_id": chunk.id,
            "source_id": chunk.source_id,
            "index": chunk.index,
            "summary": _short(chunk.content),
            "metadata": dict(chunk.meta_data or {}),
        } for _, chunk in assigned[:24]],
        "lecture_summary": ({
            "id": lecture.id,
            "status": lecture.status,
            "sections": [{
                "title": _short(section.get("title", ""), 120),
                "summary": _short(section.get("content", ""), 180),
            } for section in (lecture.sections or [])[:18] if isinstance(section, dict)],
        } if lecture else None),
        "exercise_summaries": [{
            "id": item.id,
            "title": item.title,
            "summary": _short(item.description, 180),
            "judge_mode": item.judge_mode,
            "virtual_files": [
                {"name": value.get("name"), "read_only": bool(value.get("read_only"))}
                for value in (item.files or []) if isinstance(value, dict)
            ],
        } for item in exercises[:24]],
        "project_file_tree": workspace_nodes[:120],
        "current_surface": allowed_surface,
        "content_policy": (
            "Do not infer file contents from the tree. Read ordinary files on demand. "
            "Never use ordinary file writes to modify official lecture or exercise objects."
        ),
    }
