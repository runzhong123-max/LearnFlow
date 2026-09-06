from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import LearningTask, ReviewSchedule
from app.schemas.learning_task import (
    LearningTaskActionRequest,
    LearningTaskCreate,
    LearningTaskMaterializeRequest,
    LearningTaskReorderRequest,
    LearningTaskReplanRequest,
    LearningTaskUpdate,
)
from app.services.auth import CurrentLearner, get_current_learner
from app.services.learning_tasks import (
    act_on_learning_task,
    create_learning_task,
    ensure_all_checkpoint_learning_tasks,
    learning_task_view,
    load_owned_learning_task,
    materialize_learning_task,
    reorder_learning_tasks,
    replan_learning_task,
)


router = APIRouter(prefix="/learning-tasks", tags=["Learning Tasks"])


def _runtime_error(error: RuntimeError) -> HTTPException:
    code = str(error)
    mapping = {
        "version_conflict": (409, "学习任务已经更新，请刷新后重试"),
        "invalid_state": (409, "当前任务状态不能执行这个操作"),
        "invalid_scope": (404, "学习任务关联的会话、项目或关卡不存在"),
        "invalid_order": (400, "只能重排你当前学习队列中的任务"),
        "practice_required": (409, "练习阶段需要至少一次真实作答、复述诊断或可检查产物"),
        "verification_required": (409, "独立验证阶段需要正式评估证据，讲解或自述不能代替"),
        "review_handoff_required": (409, "还没有可转交到复习队列的正式评估项"),
        "learning_run_incomplete": (409, "当前学习现场还有题目或纠错未完成，请先完成整组学习与验证"),
        "incomplete_plan": (409, "任务计划仍有必做阶段未完成"),
    }
    status, detail = mapping.get(code, (400, "无法更新学习任务"))
    return HTTPException(status, detail)


async def _owned_task_or_404(
    db: AsyncSession, learner_id: int, task_id: int,
) -> LearningTask:
    task = await load_owned_learning_task(db, learner_id, task_id)
    if not task:
        raise HTTPException(404, "学习任务不存在")
    return task


@router.get("/summary")
async def get_queue_summary(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    await ensure_all_checkpoint_learning_tasks(db, learner_id=current.learner.id)
    rows = (await db.execute(
        select(LearningTask.status, func.count(LearningTask.id))
        .where(LearningTask.learner_id == current.learner.id)
        .group_by(LearningTask.status)
    )).all()
    due_reviews = (await db.execute(select(func.count(ReviewSchedule.id)).where(
        ReviewSchedule.learner_id == current.learner.id,
        ReviewSchedule.phase == "active",
        ReviewSchedule.due_at <= datetime.utcnow(),
    ))).scalar_one()
    await db.commit()
    counts = {status: count for status, count in rows}
    return {
        "learning": {
            "proposed": counts.get("proposed", 0),
            "queued": counts.get("queued", 0),
            "active": counts.get("active", 0),
            "paused": counts.get("paused", 0),
            "completed": counts.get("completed", 0),
        },
        "review": {"due": due_reviews},
        "queues": [
            {"id": "learning", "surface": "/tasks"},
            {"id": "review", "surface": "/review"},
        ],
    }


@router.get("")
async def list_learning_tasks(
    status: str | None = Query(default=None),
    project_id: int | None = Query(default=None),
    session_id: int | None = Query(default=None),
    include_terminal: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=300),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    await ensure_all_checkpoint_learning_tasks(
        db, learner_id=current.learner.id, project_id=project_id,
    )
    query = select(LearningTask).where(LearningTask.learner_id == current.learner.id)
    if status:
        allowed = {"proposed", "queued", "active", "paused", "completed", "canceled"}
        statuses = {item.strip() for item in status.split(",") if item.strip()}
        if not statuses or statuses - allowed:
            raise HTTPException(400, "不支持的学习任务状态")
        query = query.where(LearningTask.status.in_(statuses))
    elif not include_terminal:
        query = query.where(LearningTask.status.in_({"proposed", "queued", "active", "paused"}))
    if project_id:
        query = query.where(LearningTask.project_id == project_id)
    if session_id:
        query = query.where(LearningTask.session_id == session_id)
    tasks = list((await db.execute(query.order_by(
        LearningTask.priority.desc(),
        LearningTask.queue_position,
        LearningTask.created_at,
    ).limit(limit))).scalars().all())
    items = [await learning_task_view(db, task) for task in tasks]
    await db.commit()
    return {"items": items}


@router.post("")
async def create_task(
    request: LearningTaskCreate,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    try:
        task, _ = await create_learning_task(
            db,
            learner_id=current.learner.id,
            title=request.title,
            objective=request.objective,
            client_request_id=request.client_request_id,
            origin_kind="manual" if not request.session_id else "conversation",
            created_by="user",
            status="queued",
            session_id=request.session_id,
            project_id=request.project_id,
            checkpoint_id=request.checkpoint_id,
            priority=request.priority,
            estimated_minutes=request.estimated_minutes,
            due_at=request.due_at,
            preferred_skills=request.preferred_skills,
            source_refs=request.source_refs,
            success_criteria=request.success_criteria,
        )
    except RuntimeError as error:
        raise _runtime_error(error) from error
    view = await learning_task_view(db, task)
    await db.commit()
    return view


@router.post("/reorder")
async def reorder_queue(
    request: LearningTaskReorderRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    try:
        tasks = await reorder_learning_tasks(
            db,
            learner_id=current.learner.id,
            task_ids=request.task_ids,
            client_request_id=request.client_request_id,
        )
    except RuntimeError as error:
        raise _runtime_error(error) from error
    items = [await learning_task_view(db, task) for task in tasks]
    await db.commit()
    return {"items": items}


@router.get("/{task_id}")
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    task = await _owned_task_or_404(db, current.learner.id, task_id)
    view = await learning_task_view(db, task)
    await db.commit()
    return view


@router.patch("/{task_id}")
async def update_task(
    task_id: int,
    request: LearningTaskUpdate,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    task = await _owned_task_or_404(db, current.learner.id, task_id)
    if task.version != request.expected_version:
        raise _runtime_error(RuntimeError("version_conflict"))
    if task.status in {"completed", "canceled"}:
        raise _runtime_error(RuntimeError("invalid_state"))
    patch = request.model_dump(exclude_unset=True, exclude={"expected_version"})
    for key, value in patch.items():
        if key == "success_criteria" and value is not None:
            value = [str(item).strip()[:500] for item in value if str(item).strip()]
        setattr(task, key, value)
    task.version += 1
    view = await learning_task_view(db, task)
    await db.commit()
    return view


@router.post("/{task_id}/actions")
async def task_action(
    task_id: int,
    request: LearningTaskActionRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    task = await _owned_task_or_404(db, current.learner.id, task_id)
    try:
        await act_on_learning_task(
            db,
            task=task,
            action=request.action,
            expected_version=request.expected_version,
            client_action_id=request.client_action_id,
            phase_id=request.phase_id,
            evidence_refs=request.evidence_refs,
        )
    except RuntimeError as error:
        raise _runtime_error(error) from error
    view = await learning_task_view(db, task)
    await db.commit()
    return view


@router.post("/{task_id}/replan")
async def replan_task(
    task_id: int,
    request: LearningTaskReplanRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    task = await _owned_task_or_404(db, current.learner.id, task_id)
    try:
        await replan_learning_task(
            db,
            task=task,
            reason=request.reason,
            learner_direction=request.learner_direction,
            preferred_skills=request.preferred_skills,
            expected_version=request.expected_version,
            client_request_id=request.client_request_id,
        )
    except RuntimeError as error:
        raise _runtime_error(error) from error
    view = await learning_task_view(db, task)
    await db.commit()
    return view


@router.post("/{task_id}/materialize")
async def materialize_task(
    task_id: int,
    request: LearningTaskMaterializeRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    task = await _owned_task_or_404(db, current.learner.id, task_id)
    try:
        await materialize_learning_task(
            db,
            task=task,
            source_text=request.source_text,
            expected_version=request.expected_version,
            client_request_id=request.client_request_id,
            education_stage=current.profile.education_stage or "",
            background=current.profile.background or "",
        )
    except RuntimeError as error:
        raise _runtime_error(error) from error
    view = await learning_task_view(db, task)
    await db.commit()
    return view
