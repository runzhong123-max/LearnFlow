"""Safe workspace removal for conversations and projects.

Deletion removes an item from the learner's active workspace and stops its
unfinished operational flows.  Graded attempts, review schedules and the
append-only evidence ledger remain authoritative and are never erased here.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    AgentAction,
    AgentSession,
    LearningProjectProposal,
    LearningSkillRun,
    LearningTask,
    MicroLearningRun,
)
from app.models.project import LocalAgentRun, Project, Task
from app.services.learning_runtime import record_event
from app.services.learning_tasks import ACTIVE_STATUSES, act_on_learning_task
from app.services.task_manager import manager


DELETED_SESSION_STATUS = "deleted"
DELETED_PROJECT_VISIBILITY = "deleted"


def _append_run_action(run: LearningSkillRun, marker: str) -> None:
    run.action_log = [*list(run.action_log or []), marker][-200:]


async def _cancel_learning_tasks(
    db: AsyncSession,
    tasks: list[LearningTask],
    *,
    reason: str,
) -> int:
    canceled = 0
    for task in tasks:
        if task.status not in ACTIVE_STATUSES:
            continue
        await act_on_learning_task(
            db,
            task=task,
            action="cancel",
            expected_version=task.version,
            client_action_id=f"workspace-delete:{reason}:task:{task.id}",
        )
        canceled += 1
    return canceled


async def _retire_sessions(
    db: AsyncSession,
    sessions: list[AgentSession],
    *,
    reason: str,
) -> tuple[int, int]:
    if not sessions:
        return 0, 0
    session_ids = [item.id for item in sessions]
    now = datetime.utcnow()
    skill_runs = list((await db.execute(select(LearningSkillRun).where(
        LearningSkillRun.session_id.in_(session_ids),
        LearningSkillRun.status.in_({"active", "paused", "verification"}),
    ))).scalars().all())
    for run in skill_runs:
        run.status = "canceled"
        run.state = "canceled"
        run.completed_at = now
        run.version += 1
        _append_run_action(run, f"workspace-delete:{reason}")

    actions = list((await db.execute(select(AgentAction).where(
        AgentAction.session_id.in_(session_ids),
        AgentAction.status.in_({"proposed", "pending_confirmation", "queued", "running"}),
    ))).scalars().all())
    for action in actions:
        if action.task_id:
            manager.cancel(action.task_id)
            task = await db.get(Task, action.task_id)
            if task and task.status in {"queued", "running"}:
                task.status = "canceled"
                task.finished_at = now
        action.status = "canceled"
        action.finished_at = now

    proposals = list((await db.execute(select(LearningProjectProposal).where(
        LearningProjectProposal.session_id.in_(session_ids),
        LearningProjectProposal.status.notin_({"accepted", "dismissed"}),
    ))).scalars().all())
    for proposal in proposals:
        proposal.status = "dismissed"
        proposal.last_change_summary = "来源对话已从学习工作区删除"

    for session in sessions:
        summary = dict(session.context_summary or {})
        summary["workspace_deletion"] = {
            "deleted_at": now.isoformat(),
            "reason": reason,
            "previous_status": session.status,
        }
        session.context_summary = summary
        session.pending_action_id = None
        session.status = DELETED_SESSION_STATUS
        session.updated_at = now
    return len(sessions), len(skill_runs)


async def delete_conversation_workspace(
    db: AsyncSession,
    *,
    session: AgentSession,
) -> dict:
    if session.session_type != "global":
        raise RuntimeError("project_session_managed_by_project")
    if session.status == DELETED_SESSION_STATUS:
        return {
            "status": "already_deleted",
            "kind": "conversation",
            "id": session.id,
            "title": session.title,
            "evidence_retained": True,
        }

    await record_event(
        db,
        learner_id=session.learner_id,
        event_type="conversation_deleted",
        source="ui",
        session_id=session.id,
        payload={"session_id": session.id, "title": session.title},
        provenance={"endpoint": "DELETE /api/agent/sessions/{session_id}"},
        client_event_id=f"conversation:{session.id}:deleted",
    )
    tasks = list((await db.execute(select(LearningTask).where(
        LearningTask.learner_id == session.learner_id,
        LearningTask.session_id == session.id,
    ))).scalars().all())
    canceled_tasks = await _cancel_learning_tasks(
        db, tasks, reason=f"conversation:{session.id}",
    )
    micro_runs = list((await db.execute(select(MicroLearningRun).where(
        MicroLearningRun.learner_id == session.learner_id,
        MicroLearningRun.session_id == session.id,
        MicroLearningRun.status == "active",
    ))).scalars().all())
    now = datetime.utcnow()
    for run in micro_runs:
        run.status = "paused"
        run.action_log = [
            *list(run.action_log or []),
            {"action": "conversation_deleted", "at": now.isoformat()},
        ][-200:]
        run.version += 1
    retired_sessions, canceled_skill_runs = await _retire_sessions(
        db, [session], reason=f"conversation:{session.id}",
    )
    return {
        "status": "deleted",
        "kind": "conversation",
        "id": session.id,
        "title": session.title,
        "retired_sessions": retired_sessions,
        "canceled_learning_tasks": canceled_tasks,
        "canceled_skill_runs": canceled_skill_runs,
        "paused_learning_runs": len(micro_runs),
        "evidence_retained": True,
    }


async def delete_project_workspace(
    db: AsyncSession,
    *,
    project: Project,
) -> dict:
    if project.visibility == DELETED_PROJECT_VISIBILITY:
        return {
            "status": "already_deleted",
            "kind": "project",
            "id": project.id,
            "name": project.name,
            "evidence_retained": True,
        }

    active_local_runs = list((await db.execute(select(LocalAgentRun).where(
        LocalAgentRun.project_id == project.id,
        LocalAgentRun.status.in_({"proposed", "queued", "running", "awaiting_confirmation"}),
    ))).scalars().all())
    if active_local_runs:
        from app.services.local_agent_broker import cancel_run
        for run in active_local_runs:
            await cancel_run(db, run)

    await record_event(
        db,
        learner_id=project.learner_id,
        event_type="project_deleted",
        source="ui",
        project_id=project.id,
        payload={"project_id": project.id, "name": project.name},
        provenance={"endpoint": "DELETE /api/projects/{project_id}"},
        client_event_id=f"project:{project.id}:deleted",
    )
    tasks = list((await db.execute(select(LearningTask).where(
        LearningTask.learner_id == project.learner_id,
        LearningTask.project_id == project.id,
    ))).scalars().all())
    canceled_tasks = await _cancel_learning_tasks(
        db, tasks, reason=f"project:{project.id}",
    )

    sessions = list((await db.execute(select(AgentSession).where(
        AgentSession.learner_id == project.learner_id,
        AgentSession.project_id == project.id,
        AgentSession.status == "active",
    ))).scalars().all())
    retired_sessions, canceled_skill_runs = await _retire_sessions(
        db, sessions, reason=f"project:{project.id}",
    )

    micro_runs = list((await db.execute(select(MicroLearningRun).where(
        MicroLearningRun.learner_id == project.learner_id,
        MicroLearningRun.project_id == project.id,
        MicroLearningRun.status == "active",
    ))).scalars().all())
    now = datetime.utcnow()
    for run in micro_runs:
        run.status = "paused"
        run.action_log = [
            *list(run.action_log or []),
            {"action": "workspace_deleted", "at": now.isoformat()},
        ][-200:]
        run.version += 1

    background_tasks = list((await db.execute(select(Task).where(
        Task.project_id == project.id,
        Task.status.in_({"queued", "running"}),
    ))).scalars().all())
    for task in background_tasks:
        manager.cancel(task.id)
        task.status = "canceled"
        task.finished_at = now

    project.visibility = DELETED_PROJECT_VISIBILITY
    project.updated_at = now
    return {
        "status": "deleted",
        "kind": "project",
        "id": project.id,
        "name": project.name,
        "retired_sessions": retired_sessions,
        "canceled_learning_tasks": canceled_tasks,
        "canceled_skill_runs": canceled_skill_runs,
        "paused_learning_runs": len(micro_runs),
        "canceled_background_tasks": len(background_tasks),
        "canceled_local_agent_runs": len(active_local_runs),
        "evidence_retained": True,
    }
