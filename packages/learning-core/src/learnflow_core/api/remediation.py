import hashlib

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.db.database import get_db
from app.models.learning import LearningAttempt, RemediationCase
from app.services.auth import CurrentLearner, get_current_learner, require_owned_checkpoint
from app.services.remediation import (
    ensure_variant,
    load_owned_case,
    request_explanation_mode,
    serialize_case,
    submit_variant,
)


router = APIRouter(tags=["Remediation"])


async def _require_case(
    db: AsyncSession, learner_id: int, case_id: int,
) -> RemediationCase:
    remediation = await load_owned_case(db, learner_id, case_id)
    if not remediation:
        raise HTTPException(404, "Remediation case not found")
    return remediation


@router.get("/remediation/{case_id}")
async def get_remediation_case(
    case_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    return serialize_case(await _require_case(db, current.learner.id, case_id))


@router.get("/checkpoints/{checkpoint_id}/remediation-cases")
async def list_remediation_cases(
    checkpoint_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    await require_owned_checkpoint(db, current.learner.id, checkpoint_id)
    rows = (await db.execute(select(RemediationCase).where(
        RemediationCase.learner_id == current.learner.id,
        RemediationCase.checkpoint_id == checkpoint_id,
    ).order_by(RemediationCase.created_at.desc()))).scalars().all()
    return [serialize_case(item) for item in rows]


@router.post("/remediation/{case_id}/explanations")
async def change_remediation_explanation(
    case_id: int,
    data: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    action = str((data or {}).get("action") or "switch")
    if action not in {"switch", "steps", "example"}:
        raise HTTPException(400, "action must be switch, steps, or example")
    remediation = await _require_case(db, current.learner.id, case_id)
    if remediation.status == "completed":
        raise HTTPException(409, "纠错案例已经完成")
    await request_explanation_mode(db, remediation=remediation, action=action)
    await db.commit()
    return serialize_case(remediation)


@router.post("/remediation/{case_id}/variant")
async def create_remediation_variant(
    case_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    remediation = await _require_case(db, current.learner.id, case_id)
    if remediation.status != "variant_ready":
        raise HTTPException(409, "必须先通过原题重做，才能进入变式验证")
    await ensure_variant(remediation)
    await db.commit()
    return serialize_case(remediation)


async def _variant_submission_replay(
    db: AsyncSession, *, learner_id: int, case_id: int,
    submission_key: str, submission: dict,
) -> dict | None:
    attempt = (await db.execute(select(LearningAttempt).where(
        LearningAttempt.learner_id == learner_id,
        LearningAttempt.client_submission_id == submission_key,
    ))).scalar_one_or_none()
    if not attempt:
        return None
    if (
        attempt.item_type != "remediation_variant" or attempt.item_id != case_id
        or attempt.remediation_case_id != case_id or dict(attempt.submission or {}) != submission
    ):
        raise HTTPException(409, "client_submission_id 已用于另一条纠错提交")
    remediation = await _require_case(db, learner_id, case_id)
    # Stored results contain the grading contract; replay must preserve the same
    # answer-safe response as the original request, including after completion.
    safe_result = {key: value for key, value in dict(attempt.result or {}).items()
                   if key in {"correct", "outcome", "user_answer_indexes", "actual"}}
    return {"result": safe_result, "remediation": serialize_case(remediation),
            "attempt_id": attempt.id, "idempotent_replay": True}


@router.post("/remediation/{case_id}/variant/submit")
async def evaluate_remediation_variant(
    case_id: int,
    data: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    learner_id = current.learner.id
    remediation = await _require_case(db, learner_id, case_id)
    submission = dict(data or {})
    client_key = submission.pop("client_submission_id", None)
    if client_key is not None and not isinstance(client_key, str):
        raise HTTPException(400, "client_submission_id 必须是字符串")
    submission_key = None
    if client_key and client_key.strip():
        raw_key = f"remediation-variant:{learner_id}:{client_key.strip()}"
        submission_key = raw_key if len(raw_key) <= 160 else (
            f"remediation-variant:{learner_id}:sha256:{hashlib.sha256(raw_key.encode()).hexdigest()}"
        )
        replay = await _variant_submission_replay(db, learner_id=learner_id, case_id=case_id,
            submission_key=submission_key, submission=submission)
        if replay:
            return replay
    if remediation.status != "variant_ready":
        raise HTTPException(409, "必须先通过原题重做，才能提交变式验证")
    try:
        remediation, result = await submit_variant(
            db, remediation=remediation, submission=submission,
            client_submission_id=submission_key,
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if submission_key:
            # Concurrent requests can both miss the initial read. The unique
            # Attempt key is the write gate; safely replay the winning request.
            replay = await _variant_submission_replay(db, learner_id=learner_id, case_id=case_id,
                submission_key=submission_key, submission=submission)
            if replay:
                return replay
        raise
    return {"result": result, "remediation": serialize_case(remediation),
            "attempt_id": remediation.variant_attempt_id}
