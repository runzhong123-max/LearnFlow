"""Ephemeral, learner-owned context packages for the desktop pet.

These packages deliberately sit outside AgentMessage, EvidenceEvent and the
five-kernel projections.  A user must preview and confirm a package before it
can be attached to one formal Tutor turn.  Raw content is cleared when used or
when its TTL expires; only a compact provenance receipt remains.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import secrets
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AgentSession, DesktopPetContextPackage


MAX_CONTEXT_CHARS = 12_000
MAX_CONTEXT_REFS = 3
MAX_TTL_SECONDS = 30 * 60
DEFAULT_TTL_SECONDS = 15 * 60
MAX_SUBTITLE_CUE_RECEIPTS = 256
ALLOWED_CONTEXT_KINDS = {
    "text",
    "ocr_text",
    "image_observation",
    "document_excerpt",
    "video_transcript",
}

SOURCE_REF_VERSION = "desktop_pet_source_ref.v1"


class SubtitleTimeRange(BaseModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)

    @field_validator("end_ms")
    @classmethod
    def end_not_before_start(cls, value: int, info) -> int:
        start_ms = info.data.get("start_ms")
        if start_ms is not None and value < start_ms:
            raise ValueError("end_ms cannot precede start_ms")
        return value


class DesktopPetSourceRef(BaseModel):
    """Strictly validated temporary source receipt for subtitle contexts.

    Deliberately carries no field for the subtitle body: raw subtitle text
    exists only inside the TTL package, and this receipt holds just the display
    and timeline metadata that survives consumption and expiry.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["desktop_pet_source_ref.v1"] = SOURCE_REF_VERSION
    source_kind: Literal["user_selected_subtitle"] = "user_selected_subtitle"
    display_name: str = Field(min_length=1, max_length=180)
    subtitle_format: Literal["srt", "vtt", "txt"]
    time_ranges: list[SubtitleTimeRange] = Field(default_factory=list, max_length=MAX_SUBTITLE_CUE_RECEIPTS)
    cue_count: int = Field(default=0, ge=0, le=MAX_SUBTITLE_CUE_RECEIPTS)
    truncated: bool = False
    scope_status: Literal["unbound"] = "unbound"

    @field_validator("cue_count")
    @classmethod
    def cue_count_matches_ranges(cls, value: int, info) -> int:
        time_ranges = info.data.get("time_ranges")
        if time_ranges is not None and value != len(time_ranges):
            raise ValueError("cue_count must match time_ranges length")
        return value


def _normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines()).strip()


def _context_receipt(package: DesktopPetContextPackage) -> dict[str, Any]:
    source = dict(package.source or {})
    return {
        "id": package.id,
        "kind": package.kind,
        "source_label": str(source.get("label") or "用户确认的外部参考")[:180],
        "captured_at": str(source.get("captured_at") or "")[:80],
        "content_sha256": package.content_sha256,
        "expires_at": package.expires_at.isoformat() if package.expires_at else None,
        "source_ref": source.get("source_ref"),
    }


async def purge_expired_desktop_pet_contexts(
    db: AsyncSession,
    *,
    learner_id: int | None = None,
) -> int:
    now = datetime.utcnow()
    query = select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.status.in_(("pending", "confirmed")),
        DesktopPetContextPackage.expires_at <= now,
    )
    if learner_id is not None:
        query = query.where(DesktopPetContextPackage.learner_id == learner_id)
    packages = list((await db.execute(query)).scalars().all())
    for package in packages:
        package.status = "expired"
        package.content = None
    return len(packages)


async def create_desktop_pet_context_package(
    db: AsyncSession,
    *,
    learner_id: int,
    kind: str,
    content: str,
    source_label: str,
    captured_at: str = "",
    ttl_seconds: int | None = None,
    client_context_id: str = "",
    source_ref: DesktopPetSourceRef | None = None,
) -> DesktopPetContextPackage:
    normalized_kind = str(kind or "").strip().casefold()
    if normalized_kind not in ALLOWED_CONTEXT_KINDS:
        raise HTTPException(422, "不支持的临时上下文类型")
    if source_ref is not None and normalized_kind != "video_transcript":
        raise HTTPException(422, "source_ref 只能用于 video_transcript 字幕上下文")
    normalized_content = _normalize_text(content)
    if not normalized_content:
        raise HTTPException(422, "临时上下文不能为空")
    if len(normalized_content) > MAX_CONTEXT_CHARS:
        raise HTTPException(422, f"临时上下文不能超过 {MAX_CONTEXT_CHARS} 个字符")
    normalized_label = " ".join(str(source_label or "").split())[:180]
    if not normalized_label:
        normalized_label = "用户主动提供的外部参考"
    effective_ttl = min(
        MAX_TTL_SECONDS,
        max(60, int(ttl_seconds or DEFAULT_TTL_SECONDS)),
    )
    normalized_client_context_id = str(client_context_id or "").strip()[:160]
    package = DesktopPetContextPackage(
        id=f"petctx_{secrets.token_urlsafe(18)}",
        learner_id=learner_id,
        client_context_id=normalized_client_context_id or None,
        kind=normalized_kind,
        status="pending",
        content=normalized_content,
        content_sha256=hashlib.sha256(normalized_content.encode("utf-8")).hexdigest(),
        source={
            "label": normalized_label,
            "captured_at": str(captured_at or "")[:80],
            "untrusted": True,
            "user_confirmed": False,
            **(
                {"source_ref": source_ref.model_dump(mode="json")}
                if source_ref is not None else {}
            ),
        },
        expires_at=datetime.utcnow() + timedelta(seconds=effective_ttl),
    )
    db.add(package)
    await db.flush()
    return package


async def load_desktop_pet_context_by_client_id(
    db: AsyncSession,
    *,
    learner_id: int,
    client_context_id: str,
) -> DesktopPetContextPackage | None:
    normalized_client_context_id = str(client_context_id or "").strip()[:160]
    if not normalized_client_context_id:
        return None
    return (await db.execute(select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.learner_id == learner_id,
        DesktopPetContextPackage.client_context_id == normalized_client_context_id,
    ))).scalar_one_or_none()


async def confirm_desktop_pet_context_package(
    db: AsyncSession,
    *,
    learner_id: int,
    package_id: str,
    session_id: int,
) -> DesktopPetContextPackage:
    await purge_expired_desktop_pet_contexts(db, learner_id=learner_id)
    package = (await db.execute(select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.id == package_id,
        DesktopPetContextPackage.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not package:
        raise HTTPException(404, "临时上下文不存在")
    if package.status != "pending" or not package.content:
        raise HTTPException(409, "临时上下文已失效或已使用")
    session = (await db.execute(select(AgentSession).where(
        AgentSession.id == session_id,
        AgentSession.learner_id == learner_id,
        AgentSession.status == "active",
    ))).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Tutor 会话不存在")
    package.status = "confirmed"
    package.session_id = session.id
    package.confirmed_at = datetime.utcnow()
    package.source = {**dict(package.source or {}), "user_confirmed": True}
    await db.flush()
    return package


async def delete_desktop_pet_context_package(
    db: AsyncSession,
    *,
    learner_id: int,
    package_id: str,
) -> None:
    package = (await db.execute(select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.id == package_id,
        DesktopPetContextPackage.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not package:
        raise HTTPException(404, "临时上下文不存在")
    package.status = "deleted"
    package.content = None
    await db.flush()


async def load_confirmed_desktop_pet_contexts(
    db: AsyncSession,
    *,
    learner_id: int,
    session_id: int,
    context_refs: list[str],
) -> list[dict[str, Any]]:
    refs = list(dict.fromkeys(str(item or "").strip() for item in context_refs if str(item or "").strip()))
    if len(refs) > MAX_CONTEXT_REFS:
        raise HTTPException(422, f"一次最多附加 {MAX_CONTEXT_REFS} 条临时上下文")
    if not refs:
        return []
    await purge_expired_desktop_pet_contexts(db, learner_id=learner_id)
    packages = list((await db.execute(select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.id.in_(refs),
        DesktopPetContextPackage.learner_id == learner_id,
        DesktopPetContextPackage.session_id == session_id,
        DesktopPetContextPackage.status == "confirmed",
    ))).scalars().all())
    by_id = {package.id: package for package in packages}
    if len(by_id) != len(refs):
        raise HTTPException(409, "临时上下文已过期、未确认或不属于当前会话")
    return [{
        **_context_receipt(by_id[ref]),
        "content": by_id[ref].content or "",
        "trust_boundary": "untrusted_user_confirmed_reference",
    } for ref in refs]


async def consume_desktop_pet_contexts(
    db: AsyncSession,
    *,
    packages: list[dict[str, Any]],
    client_turn_id: str,
) -> list[dict[str, Any]]:
    if not packages:
        return []
    package_ids = [str(item["id"]) for item in packages]
    rows = list((await db.execute(select(DesktopPetContextPackage).where(
        DesktopPetContextPackage.id.in_(package_ids),
        DesktopPetContextPackage.status == "confirmed",
    ))).scalars().all())
    by_id = {row.id: row for row in rows}
    now = datetime.utcnow()
    receipts: list[dict[str, Any]] = []
    for package in packages:
        row = by_id.get(str(package["id"]))
        if not row:
            raise HTTPException(409, "临时上下文状态已变化，请重新确认")
        receipts.append(_context_receipt(row))
        row.status = "consumed"
        row.consumed_at = now
        row.consumed_by_turn_id = client_turn_id[:160]
        row.content = None
    await db.flush()
    return receipts
