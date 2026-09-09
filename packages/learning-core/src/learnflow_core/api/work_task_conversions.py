"""Authenticated pre-project conversion API shared by cloud and local hosts."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import get_db
from app.services.auth import CurrentLearner, get_current_learner
from learnflow_core.work_task_conversion_schema import Create, Message, UpdateBrief, Generate, Handoff, Consume
from learnflow_core.work_task_conversion_models import WorkTaskConversion
from learnflow_core import work_task_conversions as service

router = APIRouter(prefix="/work-task-conversions", tags=["Work task conversions"])


async def committed(db, operation):
    try:
        result = await operation
        await db.commit()
        return result
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, {"code": "concurrent_request", "message": "操作刚被另一处提交，请使用相同操作编号重试"}) from exc


@router.post("")
async def create_conversion(data: Create, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.create(db, current.learner.id, data.model_dump()))


@router.get("")
async def list_conversions(current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    rows = list(await db.scalars(select(WorkTaskConversion).where(WorkTaskConversion.learner_id == current.learner.id)
                                .order_by(WorkTaskConversion.updated_at.desc()).limit(100)))
    result = []
    for row in rows:
        result.append(service.view(await service.expire_generation(db, row)))
    await db.commit()
    return {"items": result}


# Ticket paths precede the variable id route and never place ticket values in events.
@router.get("/handoff/{ticket}")
async def preview_handoff(ticket: str, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await service.preview_ticket(db, current.learner.id, ticket)


@router.post("/handoff/{ticket}")
async def consume_handoff(ticket: str, data: Consume, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.consume_ticket(db, current.learner.id, ticket, data.model_dump()))


@router.get("/{conversion_id}")
async def get_conversion(conversion_id: str, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    row = await service.owned(db, current.learner.id, conversion_id)
    row = await service.expire_generation(db, row)
    result = service.view(row)
    await db.commit()
    return result


@router.post("/{conversion_id}/messages")
async def clarify_conversion(conversion_id: str, data: Message, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.add_message(db, current.learner.id, conversion_id, data.model_dump()))


@router.post("/{conversion_id}/brief")
async def edit_conversion_brief(conversion_id: str, data: UpdateBrief, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.update_brief(db, current.learner.id, conversion_id, data.model_dump()))


@router.post("/{conversion_id}/generate")
async def generate_conversion(conversion_id: str, data: Generate, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    result, generation_id = await committed(db, service.prepare_generation(db, current.learner.id, conversion_id, data.model_dump()))
    if generation_id:
        service.launch_generation(current.learner.id, conversion_id, generation_id)
    return result


@router.post("/{conversion_id}/handoff")
async def handoff_conversion(conversion_id: str, data: Handoff, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return await committed(db, service.handoff(db, current.learner.id, conversion_id, data.model_dump()))
