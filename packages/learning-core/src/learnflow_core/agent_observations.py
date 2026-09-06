"""Scoped, answer-free observations for the Tutor Agent harness."""

from __future__ import annotations

from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AgentSession, LearningAttempt, RemediationCase, ReviewSchedule
from app.models.project import Checkpoint, Project, Roadmap, Source
from app.services.review import schedule_bucket
from app.services.source_knowledge import flatten_repository_knowledge_domains


def _attempt_outcome(attempt: LearningAttempt) -> str:
    if attempt.status == "abstained":
        return "abstained"
    if attempt.status != "evaluated":
        return "pending"
    result = dict(attempt.result or {})
    if "correct" in result:
        return "passed" if bool(result.get("correct")) else "failed"
    if "passed" in result and "total" in result:
        total = int(result.get("total") or 0)
        return "passed" if total > 0 and int(result.get("passed") or 0) == total else "failed"
    return "evaluated"


async def _resolve_scope(
    db: AsyncSession,
    learner_id: int,
    *,
    session_id: int | None,
    project_id: int | None,
    checkpoint_id: int | None,
) -> tuple[int | None, int | None]:
    if session_id is not None:
        session = await db.get(AgentSession, session_id)
        if not session or session.learner_id != learner_id:
            raise ValueError("agent session not found")
        if project_id is not None and session.project_id not in {None, project_id}:
            raise ValueError("project scope does not match session")
        if checkpoint_id is not None and session.checkpoint_id not in {None, checkpoint_id}:
            raise ValueError("checkpoint scope does not match session")
        project_id = project_id or session.project_id
        checkpoint_id = checkpoint_id or session.checkpoint_id

    if project_id is not None:
        project = await db.get(Project, project_id)
        if not project or project.learner_id != learner_id or project.visibility != "visible":
            raise ValueError("project not found")

    if checkpoint_id is not None:
        row = (await db.execute(
            select(Checkpoint.id, Roadmap.project_id)
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .join(Project, Project.id == Roadmap.project_id)
            .where(Checkpoint.id == checkpoint_id, Project.learner_id == learner_id)
        )).one_or_none()
        if not row:
            raise ValueError("checkpoint not found")
        if project_id is not None and row.project_id != project_id:
            raise ValueError("checkpoint does not belong to project scope")
        project_id = project_id or row.project_id
    return project_id, checkpoint_id


async def build_learning_workspace_observation(
    db: AsyncSession,
    *,
    learner_id: int,
    session_id: int | None = None,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
) -> dict[str, Any]:
    """Build one bounded projection without exposing answers or submissions."""
    project_id, checkpoint_id = await _resolve_scope(
        db,
        learner_id,
        session_id=session_id,
        project_id=project_id,
        checkpoint_id=checkpoint_id,
    )

    attempt_query = select(LearningAttempt).where(LearningAttempt.learner_id == learner_id)
    remediation_query = select(RemediationCase).where(
        RemediationCase.learner_id == learner_id,
        RemediationCase.status != "completed",
    )
    review_query = select(ReviewSchedule).where(ReviewSchedule.learner_id == learner_id)
    if project_id is not None:
        attempt_query = attempt_query.where(LearningAttempt.project_id == project_id)
        remediation_query = remediation_query.where(RemediationCase.project_id == project_id)
        review_query = review_query.where(ReviewSchedule.project_id == project_id)
    if checkpoint_id is not None:
        attempt_query = attempt_query.where(LearningAttempt.checkpoint_id == checkpoint_id)
        remediation_query = remediation_query.where(RemediationCase.checkpoint_id == checkpoint_id)
        review_query = review_query.where(ReviewSchedule.checkpoint_id == checkpoint_id)

    attempts = list((await db.execute(
        attempt_query.order_by(LearningAttempt.evaluated_at.desc(), LearningAttempt.id.desc()).limit(12)
    )).scalars().all())
    remediations = list((await db.execute(
        remediation_query.order_by(RemediationCase.updated_at.desc(), RemediationCase.id.desc()).limit(8)
    )).scalars().all())
    reviews = list((await db.execute(review_query.order_by(ReviewSchedule.due_at, ReviewSchedule.id))).scalars().all())
    review_buckets = Counter(schedule_bucket(item) for item in reviews)
    review_items = sorted(
        reviews,
        key=lambda item: (
            {"wrong": 0, "overdue": 1, "due": 2, "upcoming": 3, "stable": 4, "suspended": 5}.get(schedule_bucket(item), 9),
            item.due_at,
            item.id,
        ),
    )[:8]

    sources: list[Source] = []
    if project_id is not None:
        sources = list((await db.execute(
            select(Source).where(Source.project_id == project_id).order_by(Source.id)
        )).scalars().all())
    domains = flatten_repository_knowledge_domains([item for item in sources if item.status == "processed"])

    return {
        "authority": "LearningAttempt + RemediationCase + ReviewSchedule + scoped project sources",
        "scope": {
            "learner_id": learner_id,
            "session_id": session_id,
            "project_id": project_id,
            "checkpoint_id": checkpoint_id,
        },
        "recent_attempts": [{
            "id": item.id,
            "project_id": item.project_id,
            "checkpoint_id": item.checkpoint_id,
            "item_type": item.item_type,
            "item_id": item.item_id,
            "attempt_role": item.attempt_role,
            "status": item.status,
            "outcome": _attempt_outcome(item),
            "assistance_level": item.assistance_level,
            "independent": item.assistance_level == "none",
            "evaluated_at": item.evaluated_at.isoformat() if item.evaluated_at else None,
        } for item in attempts],
        "open_remediations": [{
            "id": item.id,
            "project_id": item.project_id,
            "checkpoint_id": item.checkpoint_id,
            "item_type": item.item_type,
            "item_id": item.item_id,
            "status": item.status,
            "error_class": item.error_class,
            "misconception_tag": item.misconception_tag,
            "delivery_mode": item.current_delivery_mode,
            "ineffective_modes": list(item.ineffective_modes or [])[:8],
        } for item in remediations],
        "review": {
            "summary": {
                "total": len(reviews),
                "due": sum(review_buckets[key] for key in ("wrong", "overdue", "due")),
                "overdue": review_buckets["overdue"],
                "wrong": review_buckets["wrong"],
                "upcoming": review_buckets["upcoming"],
                "stable": review_buckets["stable"],
                "suspended": review_buckets["suspended"],
                "policy_version": "review-policy-v1",
            },
            "items": [{
                "id": item.id,
                "project_id": item.project_id,
                "checkpoint_id": item.checkpoint_id,
                "item_type": item.item_type,
                "item_id": item.item_id,
                "subject_key": item.subject_key,
                "bucket": schedule_bucket(item),
                "due_at": item.due_at.isoformat(),
                "last_grade": item.last_grade,
                "successful_reviews": item.successful_reviews,
                "lapse_count": item.lapse_count,
                "last_question_form": item.last_question_form,
            } for item in review_items],
        },
        "project_sources": [{
            "id": item.id,
            "type": item.type,
            "role": item.role,
            "status": item.status,
            "error": item.error[:240] if item.error else "",
        } for item in sources[:12]],
        "knowledge_domains": domains,
        "boundaries": [
            "Attempt 和判题结果是实践证据；任务完成、讲解完成和来源覆盖都不是掌握证据",
            "有提示成功与独立成功必须区分，原题成功与变式迁移必须区分",
            "ReviewSchedule 是可重建调度投影，不是第六个 Kernel",
            "项目来源领域只约束当前项目路线与讲解，不代表学习者已经理解",
            "该投影不包含题目答案、提交正文、解决方案或测试用例",
        ],
        "manifest": {
            "answer_free": True,
            "read_only": True,
            "attempt_count": len(attempts),
            "open_remediation_count": len(remediations),
            "review_item_count": len(reviews),
            "project_source_count": len(sources),
            "knowledge_domain_count": len(domains),
        },
    }
