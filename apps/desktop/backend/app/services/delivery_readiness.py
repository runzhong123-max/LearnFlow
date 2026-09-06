"""Rebuild checkpoint delivery readiness from existing authoritative objects."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AssessmentBlueprint, AssessmentRubric, LearningTask
from app.models.project import Checkpoint, CheckpointChunk, Chunk, ConceptQuestion, Exercise, Lecture, Source


DELIVERY_READINESS_POLICY = "checkpoint-delivery-readiness.v2"
PACKAGE_READINESS_POLICY = "teaching-package-readiness.v1"
TASK_READINESS_POLICY = "atomic-learning-task-readiness.v1"
LEVELS = (
    "outline_only",
    "content_ready",
    "guided_learning_ready",
    "practice_ready",
    "verification_ready",
)
RUNNABLE_TASK_STATUSES = {"queued", "active", "paused"}


def project_package_readiness(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Project teaching-asset maturity without depending on a learner task."""
    source_ready = bool(snapshot.get("processed_source_chunks"))
    content_ready = bool(snapshot.get("published_lecture_sections"))
    practice_ready = bool(
        int(snapshot.get("concept_question_count") or 0)
        + int(snapshot.get("exercise_count") or 0)
    )
    deterministic_answer = bool(snapshot.get("deterministic_answer_count"))
    blueprint_ready = bool(snapshot.get("active_blueprint_count"))
    rubric_ready = bool(snapshot.get("active_rubric_count"))
    verification_ready = (
        content_ready and practice_ready and deterministic_answer
        and blueprint_ready and rubric_ready
    )

    if verification_ready:
        overall = "verification_ready"
    elif content_ready and practice_ready:
        overall = "practice_ready"
    elif content_ready:
        overall = "content_ready"
    else:
        overall = "outline_only"

    gaps: list[str] = []
    next_capabilities: list[str] = []
    if not source_ready:
        gaps.append("缺少当前关卡可定位的已处理来源")
    if not content_ready:
        gaps.append("缺少已发布且非空的讲义")
        next_capabilities.append("generate_learning_files")
    if not practice_ready:
        gaps.append("缺少正式概念题或实践任务")
        next_capabilities.append("generate_dynamic_practice")
    if practice_ready and not deterministic_answer:
        gaps.append("练习缺少可确定性判定的答案或测试契约")
    if not blueprint_ready:
        gaps.append("缺少有效 AssessmentBlueprint")
        next_capabilities.append("design_assessment_blueprint")
    if not rubric_ready:
        gaps.append("缺少有效 AssessmentRubric")
        next_capabilities.append("design_assessment_blueprint")
    return {
        "policy_version": PACKAGE_READINESS_POLICY,
        "overall": overall,
        "sources": "ready" if source_ready else "gap",
        "content": "ready" if content_ready else "gap",
        "practice": "ready" if practice_ready else "gap",
        "verification": "ready" if verification_ready else "gap",
        "gaps": gaps,
        "next_capabilities": list(dict.fromkeys(next_capabilities)),
        "fallback_allowed": True,
        "mastery_inference": False,
    }


def project_task_readiness(
    snapshot: dict[str, Any], package: dict[str, Any],
) -> dict[str, Any]:
    """Project whether one atomic task can consume the available package."""
    task_status = str(snapshot.get("learning_task_status") or "")
    bound = bool(snapshot.get("learning_task_count")) or bool(task_status)
    runnable = bound and (not task_status or task_status in RUNNABLE_TASK_STATUSES)
    package_stage = str(package.get("overall") or "outline_only")

    if not bound:
        overall = "unbound"
        fallback = "create_or_bind_task"
    elif task_status == "proposed":
        overall = "awaiting_acceptance"
        fallback = "await_learner_acceptance"
    elif task_status == "completed":
        overall = "completed"
        fallback = "none"
    elif task_status == "canceled":
        overall = "canceled"
        fallback = "create_or_bind_task"
    elif package_stage == "verification_ready":
        overall = "verification_ready"
        fallback = "full_loop"
    elif package_stage == "practice_ready":
        overall = "practice_ready"
        fallback = "practice_without_mastery_claim"
    elif package_stage == "content_ready":
        overall = "guided_learning_ready"
        fallback = "guided_learning_only"
    else:
        overall = "runnable_with_fallback"
        fallback = "minimum_teaching_fallback"

    available_phases: list[str] = []
    if runnable:
        # Teaching Contract guarantees a minimum answer-safe learning artifact,
        # so an accepted task can start even when the package is incomplete.
        available_phases.append("learn")
        if package_stage in {"practice_ready", "verification_ready"}:
            available_phases.append("practice")
        if package_stage == "verification_ready":
            available_phases.append("verify")

    gaps: list[str] = []
    if not bound:
        gaps.append("尚未绑定当前学习者的原子 LearningTask")
    elif task_status == "proposed":
        gaps.append("LearningTask 正在等待学习者接受")
    elif task_status == "canceled":
        gaps.append("当前 LearningTask 已取消")
    if runnable and package_stage == "outline_only":
        gaps.append("教学包未就绪；任务将从确定性最小讲解开始")
    elif runnable and package_stage == "content_ready":
        gaps.append("任务可带领学习，但尚不能进入正式练习")
    elif runnable and package_stage == "practice_ready":
        gaps.append("任务可练习，但尚不能进入独立验证")
    return {
        "policy_version": TASK_READINESS_POLICY,
        "overall": overall,
        "task_status": task_status or None,
        "bound": bound,
        "can_start_or_resume": runnable,
        "available_phases": available_phases,
        "fallback": fallback,
        "gaps": gaps,
        "operational_completion_is_mastery": False,
    }


def project_delivery_readiness(snapshot: dict[str, Any]) -> dict[str, Any]:
    package = project_package_readiness(snapshot)
    task = project_task_readiness(snapshot, package)

    # Compatibility projection retained for existing clients.  New consumers
    # should use package_readiness and task_readiness so asset maturity is not
    # confused with learner execution state.
    source_ready = bool(snapshot.get("processed_source_chunks"))
    content_ready = bool(snapshot.get("published_lecture_sections"))
    task_ready = bool(snapshot.get("learning_task_count"))
    question_count = int(snapshot.get("concept_question_count") or 0)
    exercise_count = int(snapshot.get("exercise_count") or 0)
    practice_ready = question_count + exercise_count > 0
    blueprint_ready = bool(snapshot.get("active_blueprint_count"))
    rubric_ready = bool(snapshot.get("active_rubric_count"))
    deterministic_answer = bool(snapshot.get("deterministic_answer_count"))
    guided_ready = content_ready and task_ready
    practice_stage_ready = guided_ready and practice_ready
    verification_ready = practice_stage_ready and deterministic_answer and blueprint_ready and rubric_ready

    if verification_ready:
        overall = "verification_ready"
    elif practice_stage_ready:
        overall = "practice_ready"
    elif guided_ready:
        overall = "guided_learning_ready"
    elif content_ready:
        overall = "content_ready"
    else:
        overall = "outline_only"

    gaps: list[str] = []
    if not source_ready:
        gaps.append("缺少当前关卡可定位的已处理来源")
    if not content_ready:
        gaps.append("缺少已发布且非空的讲义")
    if not task_ready:
        gaps.append("缺少绑定当前关卡的 LearningTask")
    if not practice_ready:
        gaps.append("缺少正式概念题或实践任务")
    if practice_ready and not deterministic_answer:
        gaps.append("练习缺少可确定性判定的答案或测试契约")
    if not blueprint_ready:
        gaps.append("缺少有效 AssessmentBlueprint")
    if not rubric_ready:
        gaps.append("缺少有效 AssessmentRubric")

    return {
        "policy_version": DELIVERY_READINESS_POLICY,
        "overall": overall,
        "sources": "ready" if source_ready else "gap",
        "content": "ready" if content_ready else "gap",
        "guided_learning": "ready" if guided_ready else "gap",
        "practice": "ready" if practice_ready else "gap",
        "verification": "ready" if verification_ready else "gap",
        "gaps": gaps,
        "package_readiness": package,
        "task_readiness": task,
        "mastery_inference": False,
    }


async def checkpoint_delivery_readiness(
    db: AsyncSession,
    checkpoint: Checkpoint,
    *,
    learner_id: int,
) -> dict[str, Any]:
    processed_source_chunks = int((await db.scalar(
        select(func.count(CheckpointChunk.id))
        .join(Chunk, Chunk.id == CheckpointChunk.chunk_id)
        .join(Source, Source.id == Chunk.source_id)
        .where(CheckpointChunk.checkpoint_id == checkpoint.id, Source.status == "processed")
    )) or 0)
    lecture = (await db.execute(select(Lecture).where(
        Lecture.checkpoint_id == checkpoint.id,
    ))).scalar_one_or_none()
    questions = list((await db.execute(select(ConceptQuestion).where(
        ConceptQuestion.checkpoint_id == checkpoint.id,
    ))).scalars().all())
    exercises = list((await db.execute(select(Exercise).where(
        Exercise.checkpoint_id == checkpoint.id,
    ))).scalars().all())
    blueprint_ids = list((await db.execute(select(AssessmentBlueprint.id).where(
        AssessmentBlueprint.learner_id == learner_id,
        AssessmentBlueprint.checkpoint_id == checkpoint.id,
        AssessmentBlueprint.status.in_(["draft", "active", "published"]),
    ))).scalars().all())
    rubric_count = 0
    if blueprint_ids:
        rubric_count = int((await db.scalar(select(func.count(AssessmentRubric.id)).where(
            AssessmentRubric.blueprint_id.in_(blueprint_ids),
            AssessmentRubric.status.in_(["draft", "active", "published"]),
        ))) or 0)
    task = (await db.execute(select(LearningTask).where(
        LearningTask.learner_id == learner_id,
        LearningTask.checkpoint_id == checkpoint.id,
    ))).scalar_one_or_none()
    task_count = int(task is not None and task.status != "canceled")
    deterministic_answers = sum(
        1 for item in questions
        if list(item.answer_indexes or []) or bool(str(item.expected_output or "").strip())
    ) + sum(
        1 for item in exercises
        if list(item.test_cases or []) or bool(dict(item.judge_config or {}))
    )
    return project_delivery_readiness({
        "processed_source_chunks": processed_source_chunks,
        "published_lecture_sections": len(lecture.sections or []) if lecture and lecture.status == "published" else 0,
        "learning_task_count": task_count,
        "learning_task_status": task.status if task else "",
        "concept_question_count": len(questions),
        "exercise_count": len(exercises),
        "deterministic_answer_count": deterministic_answers,
        "active_blueprint_count": len(blueprint_ids),
        "active_rubric_count": rubric_count,
    })
