"""Learner-confirmed project composition and bounded case-consumption API."""
from typing import Awaitable
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import get_db
from app.schemas.project_workflow import (
    WorkflowInitializeRequest, WorkbenchSaveRequest, DeliveryRequest,
    ReadingRecordRequest, CaseValidationRequest, WorkflowHintRequest,
)
from app.services.auth import CurrentLearner, get_current_learner, require_owned_project
from app.services import project_workflows as service
from app.services.practice_cases import case_catalog, case_summary, get_case
from app.api.workspace import require_desktop_token

router = APIRouter(tags=["Project workflows"])


@router.get("/practice-cases")
async def list_cases(current: CurrentLearner = Depends(get_current_learner)):
    return {"schema_version": "learnflow.practice-case-catalog.v1", "cases": case_catalog()}


@router.get("/practice-cases/{case_id}")
async def read_case(case_id: str, current: CurrentLearner = Depends(get_current_learner)):
    case = get_case(case_id)
    return {**case_summary(case), "starter_files": case["starter_files"], "requires_confirmation": True}


@router.post("/practice-cases/{case_id}/validate")
async def validate_case(case_id: str, data: CaseValidationRequest, current: CurrentLearner = Depends(get_current_learner)):
    case = get_case(case_id, data.version, data.root_hash)
    return {"schema_version": "learnflow.practice-case-candidate.v1", "status": "ready", "candidate": {
        "case_id": case["id"], "case_version": case["version"], "case_root_hash": case["root_hash"],
        "title": case["title"], "summary": case["summary"], "project_mode": "practice",
        "provenance": case["provenance"],
    }, "requires_confirmation": True, "mastery_inference": False}


@router.get("/vnext-projects/{project_id}/workflow")
async def read_workflow(project_id: int, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await service.workflow_view(db, project)


async def _commit(db: AsyncSession, operation: Awaitable[dict]) -> dict:
    try:
        result = await operation
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "项目刚被另一处更新，请刷新后重试") from exc
    return result


@router.post("/vnext-projects/{project_id}/workflow/initialize")
async def initialize(project_id: int, data: WorkflowInitializeRequest,
                     current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await _commit(db, service.initialize_workflow(db, project, data.model_dump()))


@router.put("/vnext-projects/{project_id}/workbench")
async def save_workbench(project_id: int, data: WorkbenchSaveRequest,
                         current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await _commit(db, service.save_workbench(db, project, data.model_dump()))


@router.post("/vnext-projects/{project_id}/checkpoints/{checkpoint_id}/deliver")
async def deliver(project_id: int, checkpoint_id: int, data: DeliveryRequest,
                  desktop_token: str | None = Header(default=None, alias="X-LearnFlow-Desktop-Token"),
                  current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    if any(ref.kind == "workspace_file" for ref in data.artifact_refs):
        require_desktop_token(desktop_token)
    return await _commit(db, service.deliver_checkpoint(db, project, checkpoint_id, data.model_dump()))


@router.post("/vnext-projects/{project_id}/reading")
async def reading(project_id: int, data: ReadingRecordRequest,
                  current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await _commit(db, service.record_reading(db, project, data.model_dump()))


@router.post("/vnext-projects/{project_id}/checkpoints/{checkpoint_id}/hint")
async def hint(project_id: int, checkpoint_id: int, data: WorkflowHintRequest,
               current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await _commit(db, service.request_hint(db, project, checkpoint_id, data.model_dump()))
