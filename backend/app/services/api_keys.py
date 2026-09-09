"""First-party account API keys, separate from sessions and model credentials."""
from datetime import datetime, timedelta, timezone
import hashlib
import re
import secrets

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AuthApiKey, Learner, LearnerProfile, UserAccount

def api_token_from_request(request: Request) -> str | None:
    """An explicit Authorization value never falls back to a browser cookie."""
    values = request.headers.getlist("authorization")
    if not values:
        return None
    if len(values) != 1:
        raise HTTPException(401, "API key 无效")
    match = re.fullmatch(r"(?i:Bearer) (lfak_[A-Za-z0-9_-]{43})", values[0], re.ASCII)
    if not match:
        raise HTTPException(401, "API key 无效")
    return match.group(1)


def metadata(key: AuthApiKey) -> dict:
    result = {field: getattr(key, field) for field in (
        "id", "name", "key_hint", "created_at", "expires_at", "last_used_at", "revoked_at",
    )}
    for field, value in result.items():
        if isinstance(value, datetime) and value.tzinfo is None:
            result[field] = value.replace(tzinfo=timezone.utc)
    return result


async def resolve_api_key(db: AsyncSession, token: str):
    now = datetime.utcnow()
    row = (await db.execute(
        select(AuthApiKey, UserAccount, Learner, LearnerProfile)
        .join(UserAccount, UserAccount.id == AuthApiKey.user_id)
        .join(Learner, Learner.user_id == UserAccount.id)
        .join(LearnerProfile, LearnerProfile.learner_id == Learner.id)
        .where(
            AuthApiKey.token_hash == hashlib.sha256(token.encode("ascii")).hexdigest(),
            AuthApiKey.revoked_at.is_(None), AuthApiKey.expires_at > now,
            AuthApiKey.auth_epoch == UserAccount.auth_epoch, UserAccount.status == "active",
        )
    )).first()
    if row is None:
        raise HTTPException(401, "API key 已失效")
    return row


async def issue_api_key(db: AsyncSession, account: UserAccount, name: str, days: int):
    if account.status != "active" or type(days) is not int or not 1 <= days <= 90:
        raise ValueError("Account must be active and expiry must be between 1 and 90 days")
    name = name.strip()
    if not 1 <= len(name) <= 80 or any(ord(character) < 32 for character in name):
        raise ValueError("A valid API key name is required")
    token = "lfak_" + secrets.token_urlsafe(32)
    now = datetime.utcnow()
    key = AuthApiKey(
        user_id=account.id, name=name, token_hash=hashlib.sha256(token.encode("ascii")).hexdigest(),
        key_hint=f"lfak_…{token[-4:]}", auth_epoch=int(account.auth_epoch or 0),
        created_at=now, expires_at=now + timedelta(days=days),
    )
    db.add(key)
    await db.flush()
    return token, key


async def revoke_api_key(db: AsyncSession, user_id: int, key_id: int):
    key = (await db.execute(select(AuthApiKey).where(
        AuthApiKey.id == key_id, AuthApiKey.user_id == user_id,
    ))).scalar_one_or_none()
    if key is None:
        raise HTTPException(404, "API key 不存在")
    if key.revoked_at is None:
        key.revoked_at, key.revoked_reason = datetime.utcnow(), "owner_revoked"
        await db.flush()
    return key
