"""Least-privilege API surface for the Tauri desktop pet."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db.database import get_db
from app.models.learning import AgentSession, LearningTask, ReviewSchedule
from app.services.auth import (
    CurrentLearner,
    ModelCredentialDecryptionError,
    ModelCredentialEncryptionUnavailable,
    account_vision_provider_config,
    get_current_learner,
    model_credential_configured,
    require_desktop_pet_capability,
    vision_credential_configured,
)
from app.services.desktop_pet_context import (
    MAX_CONTEXT_CHARS,
    DesktopPetSourceRef,
    create_desktop_pet_context_package,
    confirm_desktop_pet_context_package,
    delete_desktop_pet_context_package,
    load_desktop_pet_context_by_client_id,
    purge_expired_desktop_pet_contexts,
)
from app.services.desktop_pet_vision import (
    MAX_IMAGE_BYTES,
    normalize_desktop_pet_image,
    observe_desktop_pet_image,
    transcribe_desktop_pet_selection,
)
from app.services.file_formats import (
    DEFAULT_EXTRACTION_BUDGET,
    FileFormatError,
    extract_bytes,
    validate_declared_format,
)
from app.services.learning_tasks import learning_task_view
from app.services.review import schedule_bucket


router = APIRouter(prefix="/pet", tags=["Desktop Pet"])
PET_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024
PET_DOCUMENT_FORMATS = {"plain_text", "markdown", "csv", "pdf", "docx", "pptx", "xlsx"}


class DesktopPetContextCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["text", "ocr_text", "image_observation", "document_excerpt", "video_transcript"] = "text"
    content: str = Field(min_length=1, max_length=12_000)
    source_label: str = Field(default="用户主动提供的外部参考", max_length=180)
    captured_at: str = Field(default="", max_length=80)
    ttl_seconds: int | None = Field(default=None, ge=60, le=30 * 60)
    source_ref: DesktopPetSourceRef | None = Field(default=None)

    @field_validator("content", "source_label", "captured_at", mode="before")
    @classmethod
    def normalize_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class DesktopPetContextConfirmRequest(BaseModel):
    session_id: int = Field(ge=1)


def _session_summary(session: AgentSession) -> dict:
    vnext = dict((session.context_summary or {}).get("vnext") or {})
    return {
        "id": session.id,
        "title": session.title,
        "session_type": session.session_type,
        "project_id": session.project_id,
        "checkpoint_id": session.checkpoint_id,
        "client_conversation_id": str(vnext.get("conversation_id") or ""),
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
    }


def _context_view(package) -> dict:
    source = dict(package.source or {})
    content = str(package.content or "")
    return {
        "id": package.id,
        "kind": package.kind,
        "status": package.status,
        "preview": content[:600],
        "content_length": len(content),
        "source_label": str(source.get("label") or "")[:180],
        "captured_at": str(source.get("captured_at") or "")[:80],
        "expires_at": package.expires_at.isoformat() if package.expires_at else None,
        "requires_confirmation": package.status == "pending",
        "mastery_unchanged": True,
        "source_ref": source.get("source_ref"),
    }


def _review_focus_subjects(schedules: list[ReviewSchedule]) -> list[dict[str, str]]:
    candidates: list[tuple[int, int, datetime, str, str]] = []
    for schedule in schedules:
        subject = str(schedule.subject_key or "").strip()[:120]
        if not subject:
            continue
        bucket = schedule_bucket(schedule)
        lapse_count = int(schedule.lapse_count or 0)
        last_grade = str(schedule.last_grade or "").strip().casefold()
        if bucket == "wrong":
            rank, reason_code = 0, "recent_retrieval_failure"
        elif lapse_count > 0 or last_grade in {"again", "hard", "failed"}:
            rank, reason_code = 1, "review_lapse"
        else:
            continue
        candidates.append((rank, -lapse_count, schedule.due_at, subject, reason_code))

    candidates.sort(key=lambda item: item[:4])
    focus: list[dict[str, str]] = []
    seen_subjects: set[str] = set()
    for _, _, _, subject, reason_code in candidates:
        normalized_subject = subject.casefold()
        if normalized_subject in seen_subjects:
            continue
        seen_subjects.add(normalized_subject)
        focus.append({"subject": subject, "reason_code": reason_code})
        if len(focus) == 3:
            break
    return focus


@router.get("/bootstrap")
async def desktop_pet_bootstrap(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    require_desktop_pet_capability(current, "pet.bootstrap.read")
    await purge_expired_desktop_pet_contexts(db, learner_id=current.learner.id)
    sessions = list((await db.execute(select(AgentSession).where(
        AgentSession.learner_id == current.learner.id,
        AgentSession.status == "active",
    ).order_by(AgentSession.updated_at.desc(), AgentSession.id.desc()).limit(30))).scalars().all())
    tasks = list((await db.execute(select(LearningTask).where(
        LearningTask.learner_id == current.learner.id,
        LearningTask.status.in_(("queued", "active", "paused")),
    ).order_by(
        LearningTask.priority.desc(), LearningTask.queue_position, LearningTask.updated_at.desc(),
    ).limit(6))).scalars().all())
    due_reviews = (await db.execute(select(func.count(ReviewSchedule.id)).where(
        ReviewSchedule.learner_id == current.learner.id,
        ReviewSchedule.phase == "active",
        ReviewSchedule.due_at <= datetime.utcnow(),
    ))).scalar_one()
    review_focus_candidates = list((await db.execute(select(ReviewSchedule).where(
        ReviewSchedule.learner_id == current.learner.id,
        ReviewSchedule.phase == "active",
        or_(
            ReviewSchedule.lapse_count > 0,
            ReviewSchedule.last_grade.in_(("again", "hard", "failed")),
        ),
    ).order_by(
        ReviewSchedule.lapse_count.desc(), ReviewSchedule.due_at, ReviewSchedule.id,
    ).limit(60))).scalars().all())
    return {
        "authority": "formal_learnflow_objects",
        "learner": {
            "id": current.learner.id,
            "display_name": current.learner.display_name,
        },
        "capability": {
            "scopes": list(current.pet_capability_scopes),
            "expires_at": (
                current.pet_capability_expires_at.isoformat()
                if current.pet_capability_expires_at else None
            ),
        },
        "sessions": [_session_summary(item) for item in sessions],
        "tasks": [await learning_task_view(db, item) for item in tasks],
        "review": {
            "due": int(due_reviews or 0),
            "focus_subjects": _review_focus_subjects(review_focus_candidates),
            "mastery_unchanged": True,
        },
        "model": {
            "configured": model_credential_configured(current.account) or vision_credential_configured(current.account),
            "status": (
                "ready" if model_credential_configured(current.account) or vision_credential_configured(current.account)
                else "unavailable"
            ),
        },
    }


@router.post("/context-packages")
async def create_context_package(
    request: DesktopPetContextCreateRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    require_desktop_pet_capability(current, "pet.context.write")
    await purge_expired_desktop_pet_contexts(db, learner_id=current.learner.id)
    package = await create_desktop_pet_context_package(
        db,
        learner_id=current.learner.id,
        kind=request.kind,
        content=request.content,
        source_label=request.source_label,
        captured_at=request.captured_at,
        ttl_seconds=request.ttl_seconds,
        source_ref=request.source_ref,
    )
    await db.commit()
    return _context_view(package)


@router.post("/context-packages/document")
async def create_document_context_package(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    require_desktop_pet_capability(current, "pet.context.write")
    filename = str(file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or filename in {".", ".."} or "\x00" in filename:
        await file.close()
        raise HTTPException(400, "文档文件名无效")
    try:
        capability = validate_declared_format(filename, file.content_type)
        if capability.id not in PET_DOCUMENT_FORMATS:
            raise FileFormatError("pet_document_format_rejected", "桌宠仅支持可摘录的文档、表格与文本文件")
        raw = await file.read(PET_DOCUMENT_MAX_BYTES + 1)
        if len(raw) > PET_DOCUMENT_MAX_BYTES:
            raise FileFormatError("file_budget_exceeded", "桌宠文档不能超过 12 MB", status_code=413)
        extraction = await run_in_threadpool(
            extract_bytes,
            raw,
            filename,
            file.content_type,
            budget=DEFAULT_EXTRACTION_BUDGET,
        )
    except FileFormatError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc
    finally:
        await file.close()
    content = extraction.text[:MAX_CONTEXT_CHARS].strip()
    if not content:
        raise HTTPException(400, "文档没有可用的文字摘录")
    await purge_expired_desktop_pet_contexts(db, learner_id=current.learner.id)
    package = await create_desktop_pet_context_package(
        db,
        learner_id=current.learner.id,
        kind="document_excerpt",
        content=content,
        source_label=(
            f"用户主动选择的文档摘录 · {filename}"
            f"（{'已截取前' + str(MAX_CONTEXT_CHARS) + '字' if extraction.truncated or len(extraction.text) > MAX_CONTEXT_CHARS else '完整可摘录文本'}）"
        ),
    )
    await db.commit()
    return _context_view(package)


@router.post("/context-packages/image")
async def create_image_context_package(
    file: UploadFile = File(...),
    question_hint: str = Form(default="", max_length=600),
    client_context_id: str = Form(min_length=12, max_length=160),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    """Turn one explicit image attachment into a TTL-only visual observation."""
    require_desktop_pet_capability(current, "pet.context.write")
    await purge_expired_desktop_pet_contexts(db, learner_id=current.learner.id)
    existing = await load_desktop_pet_context_by_client_id(
        db,
        learner_id=current.learner.id,
        client_context_id=client_context_id,
    )
    if existing:
        if existing.status in {"pending", "confirmed"} and existing.content:
            return _context_view(existing)
        raise HTTPException(409, "该图片请求已失效，请重新附加图片")

    filename = str(file.filename or "截图").replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or filename in {".", ".."} or "\x00" in filename:
        await file.close()
        raise HTTPException(400, "截图文件名无效")
    try:
        raw = await file.read(MAX_IMAGE_BYTES + 1)
        image = normalize_desktop_pet_image(raw)
    finally:
        await file.close()
    if not (model_credential_configured(current.account) or vision_credential_configured(current.account)):
        raise HTTPException(409, "请先在 LearnFlow 主窗口配置支持图片理解的模型")
    try:
        provider_config = account_vision_provider_config(current.account)
    except ModelCredentialEncryptionUnavailable:
        raise HTTPException(503, "账户模型凭据当前不可用") from None
    except ModelCredentialDecryptionError:
        raise HTTPException(500, "账户模型凭据无法解密，请重新配置") from None
    observation = await observe_desktop_pet_image(
        image,
        provider_config=provider_config,
        question_hint=question_hint,
    )
    package = await create_desktop_pet_context_package(
        db,
        learner_id=current.learner.id,
        kind="image_observation",
        content=observation,
        source_label=f"用户主动附加的图片视觉观察 · {filename[:100]}",
        client_context_id=client_context_id,
    )
    await db.commit()
    return _context_view(package)


@router.post("/selection-text")
async def transcribe_selection_text(
    file: UploadFile = File(...),
    current: CurrentLearner = Depends(get_current_learner),
):
    """Transcribe one user-triggered system selection without creating a package."""
    require_desktop_pet_capability(current, "pet.context.write")
    filename = str(file.filename or "desktop-selection.png").replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or filename in {".", ".."} or "\x00" in filename:
        await file.close()
        raise HTTPException(400, "选区截图文件名无效")
    try:
        raw = await file.read(MAX_IMAGE_BYTES + 1)
        image = normalize_desktop_pet_image(raw)
    finally:
        await file.close()
    if not (model_credential_configured(current.account) or vision_credential_configured(current.account)):
        raise HTTPException(409, "请先在 LearnFlow 主窗口配置支持图片理解的模型")
    try:
        provider_config = account_vision_provider_config(current.account)
    except ModelCredentialEncryptionUnavailable:
        raise HTTPException(503, "账户模型凭据当前不可用") from None
    except ModelCredentialDecryptionError:
        raise HTTPException(500, "账户模型凭据无法解密，请重新配置") from None
    text = await transcribe_desktop_pet_selection(image, provider_config=provider_config)
    return {
        "text": text,
        "source_label": "用户主动抓取的系统高亮文字",
        "mastery_unchanged": True,
    }


@router.post("/context-packages/{package_id}/confirm")
async def confirm_context_package(
    package_id: str,
    request: DesktopPetContextConfirmRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    require_desktop_pet_capability(current, "pet.context.write")
    package = await confirm_desktop_pet_context_package(
        db,
        learner_id=current.learner.id,
        package_id=package_id,
        session_id=request.session_id,
    )
    await db.commit()
    return _context_view(package)


@router.delete("/context-packages/{package_id}")
async def delete_context_package(
    package_id: str,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    require_desktop_pet_capability(current, "pet.context.write")
    await delete_desktop_pet_context_package(
        db,
        learner_id=current.learner.id,
        package_id=package_id,
    )
    await db.commit()
    return {"status": "deleted", "mastery_unchanged": True}
