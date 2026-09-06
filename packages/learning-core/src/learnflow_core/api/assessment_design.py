"""Learner-scoped AssessmentBlueprint and Rubric proposal API."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import AssessmentBlueprint, AssessmentRubric
from app.services.assessment_design import (
    assessment_blueprint_view,
    create_assessment_blueprint,
)
from app.services.auth import CurrentLearner, get_current_learner


router = APIRouter(prefix="/assessment-blueprints", tags=["assessment-design"])


async def _owned_blueprint(
    db: AsyncSession, learner_id: int, blueprint_id: int,
) -> tuple[AssessmentBlueprint, AssessmentRubric]:
    blueprint = (await db.execute(select(AssessmentBlueprint).where(
        AssessmentBlueprint.id == blueprint_id,
        AssessmentBlueprint.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not blueprint:
        raise HTTPException(404, "评估蓝图不存在")
    rubric = (await db.execute(select(AssessmentRubric).where(
        AssessmentRubric.blueprint_id == blueprint.id,
        AssessmentRubric.version == blueprint.version,
    ))).scalar_one()
    return blueprint, rubric


@router.post("")
async def propose_assessment_blueprint(
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    try:
        blueprint, rubric, created = await create_assessment_blueprint(
            db,
            learner_id=current.learner.id,
            learning_task_id=int(data.get("learning_task_id") or 0),
            title=str(data.get("title") or ""),
            client_request_id=str(data.get("client_request_id") or ""),
            data=data,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    await db.commit()
    return {**assessment_blueprint_view(blueprint, rubric), "created": created}


@router.get("")
async def list_assessment_blueprints(
    learning_task_id: int | None = None,
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    query = select(AssessmentBlueprint).where(
        AssessmentBlueprint.learner_id == current.learner.id,
    )
    if learning_task_id:
        query = query.where(AssessmentBlueprint.learning_task_id == learning_task_id)
    blueprints = list((await db.execute(
        query.order_by(AssessmentBlueprint.updated_at.desc(), AssessmentBlueprint.id.desc())
    )).scalars().all())
    result = []
    for blueprint in blueprints:
        rubric = (await db.execute(select(AssessmentRubric).where(
            AssessmentRubric.blueprint_id == blueprint.id,
            AssessmentRubric.version == blueprint.version,
        ))).scalar_one()
        result.append(assessment_blueprint_view(blueprint, rubric))
    return {"items": result, "mastery_inference": False}


@router.get("/{blueprint_id}")
async def get_assessment_blueprint(
    blueprint_id: int,
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    blueprint, rubric = await _owned_blueprint(db, current.learner.id, blueprint_id)
    return assessment_blueprint_view(blueprint, rubric)
