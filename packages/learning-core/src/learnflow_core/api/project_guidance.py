"""Project artifact preparation, explicit promotion and device report ingestion."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from app.db.database import get_db
from app.services.auth import CurrentLearner, get_current_learner, require_owned_project
from learnflow_core.project_guidance_schema import GuidancePrepare, GuidanceConfirm, DeviceReportInput
from learnflow_core.project_guidance_models import ProjectDeviceReport
from learnflow_core import project_guidance as service

router = APIRouter(tags=["Project guidance"])


async def committed(db, operation):
    try:
        result = await operation
        await db.commit()
        return result
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "此操作刚被另一处提交，请使用同一操作编号重试") from exc


@router.post("/project-guidance/prepare")
async def prepare_project(data: GuidancePrepare, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.prepare(db, current.learner.id, data.model_dump()))


@router.post("/project-guidance/{candidate_id}/confirm")
async def confirm_project(candidate_id: str, data: GuidanceConfirm, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.confirm(db, current.learner.id, candidate_id, data.model_dump()))


@router.post("/vnext-projects/{project_id}/device-reports")
async def create_device_report(project_id: int, data: DeviceReportInput, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    project = await require_owned_project(db, current.learner.id, project_id)
    return await committed(db, service.record_device_report(db, project, data.model_dump()))


@router.get("/vnext-projects/{project_id}/device-reports/{report_id}")
async def get_device_report(project_id: int, report_id: int, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    await require_owned_project(db, current.learner.id, project_id)
    row = await db.scalar(select(ProjectDeviceReport).where(ProjectDeviceReport.id == report_id,
        ProjectDeviceReport.project_id == project_id, ProjectDeviceReport.learner_id == current.learner.id))
    if not row:
        raise HTTPException(404, "设备报告不存在")
    return service.report_view(row)
