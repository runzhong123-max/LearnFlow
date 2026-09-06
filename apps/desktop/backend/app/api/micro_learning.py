from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import MicroLearningRun
from app.schemas.micro_learning import (
    MicroLearningAdvanceRequest,
    MicroLearningRegenerateRequest,
    MicroLearningRunCreate,
    MicroLearningSyncRequest,
    TeachBackSubmitRequest,
)
from app.services.auth import CurrentLearner, get_current_learner
from app.services.micro_learning import (
    advance_run,
    create_micro_learning_run,
    load_owned_run,
    regenerate_learning_artifact,
    reconcile_run,
    run_view,
    submit_teach_back,
    sync_run,
)
from app.services.learning_tasks import reconcile_task_for_micro_run


router = APIRouter(prefix="/micro-learning", tags=["Focused Micro Learning"])


async def _owned_run_or_404(
    db: AsyncSession, learner_id: int, run_id: int,
) -> MicroLearningRun:
    run = await load_owned_run(db, learner_id, run_id)
    if not run:
        raise HTTPException(404, "学习记录不存在")
    return run


def _workflow_error(error: RuntimeError) -> HTTPException:
    if str(error) == "version_conflict":
        return HTTPException(409, "学习状态已更新，请刷新后重试")
    if str(error) == "invalid_state":
        return HTTPException(409, "当前步骤不能执行这个操作")
    if str(error) == "quality_gate":
        return HTTPException(409, "讲义未通过内容质量门槛，请重建讲义或返回原对话")
    if str(error) == "domain_knowledge_blocked":
        return HTTPException(409, "领域知识覆盖不足或来源已失效；请补充资料或先完成来源核验")
    return HTTPException(400, "无法更新学习流程")


@router.post("/runs")
async def create_run(
    request: MicroLearningRunCreate,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    try:
        run = await create_micro_learning_run(
            db,
            learner_id=current.learner.id,
            goal=request.goal,
            source_text=request.source_text,
            client_request_id=request.client_request_id,
            education_stage=current.profile.education_stage or "",
            background=current.profile.background or "",
        )
    except RuntimeError as error:
        raise _workflow_error(error) from error
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)


@router.get("/runs")
async def list_runs(
    limit: int = Query(default=8, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    runs = list((await db.execute(
        select(MicroLearningRun)
        .where(MicroLearningRun.learner_id == current.learner.id)
        .order_by(MicroLearningRun.updated_at.desc(), MicroLearningRun.id.desc())
        .limit(limit)
    )).scalars().all())
    for run in runs:
        await reconcile_run(db, run)
        await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return {"items": [await run_view(db, run) for run in runs]}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    run = await _owned_run_or_404(db, current.learner.id, run_id)
    await reconcile_run(db, run)
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)


@router.post("/runs/{run_id}/advance")
async def advance(
    run_id: int,
    request: MicroLearningAdvanceRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    run = await _owned_run_or_404(db, current.learner.id, run_id)
    try:
        await advance_run(
            db,
            run=run,
            action=request.action,
            expected_version=request.expected_version,
            client_action_id=request.client_action_id,
        )
    except RuntimeError as error:
        raise _workflow_error(error) from error
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)


@router.post("/runs/{run_id}/regenerate")
async def regenerate(
    run_id: int,
    request: MicroLearningRegenerateRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    run = await _owned_run_or_404(db, current.learner.id, run_id)
    try:
        await regenerate_learning_artifact(
            db,
            run=run,
            expected_version=request.expected_version,
            client_request_id=request.client_request_id,
            education_stage=current.profile.education_stage or "",
            background=current.profile.background or "",
        )
    except RuntimeError as error:
        raise _workflow_error(error) from error
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)


@router.post("/runs/{run_id}/teach-back")
async def teach_back(
    run_id: int,
    request: TeachBackSubmitRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    run = await _owned_run_or_404(db, current.learner.id, run_id)
    try:
        await submit_teach_back(
            db,
            run=run,
            response=request.response,
            expected_version=request.expected_version,
            client_submission_id=request.client_submission_id,
        )
    except RuntimeError as error:
        raise _workflow_error(error) from error
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)


@router.post("/runs/{run_id}/sync")
async def sync(
    run_id: int,
    request: MicroLearningSyncRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    run = await _owned_run_or_404(db, current.learner.id, run_id)
    try:
        await sync_run(
            db,
            run=run,
            expected_version=request.expected_version,
            client_action_id=request.client_action_id,
        )
    except RuntimeError as error:
        raise _workflow_error(error) from error
    await reconcile_task_for_micro_run(db, run)
    await db.commit()
    return await run_view(db, run)
