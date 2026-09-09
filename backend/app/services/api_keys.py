"""First-party account API keys, separate from sessions and model credentials."""
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import re
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from fastapi import HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AuthApiKey, AuthApiKeySecret, Learner, LearnerProfile, UserAccount

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


def metadata(key: AuthApiKey, *, copy_available: bool = False) -> dict:
    result = {field: getattr(key, field) for field in (
        "id", "name", "key_hint", "created_at", "expires_at", "last_used_at", "revoked_at",
    )}
    for field, value in result.items():
        if isinstance(value, datetime) and value.tzinfo is None:
            result[field] = value.replace(tzinfo=timezone.utc)
    result["copy_available"] = copy_available
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
    # Reuse the server KEK infrastructure with a separate purpose and key-bound AAD.
    kek, version = _access_key_kek()
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(kek).encrypt(nonce, token.encode("ascii"), _aad(key, version))
    db.add(key)
    await db.flush()
    db.add(AuthApiKeySecret(key_id=key.id, encryption_version=version,
        ciphertext=base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")))
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
    await db.execute(delete(AuthApiKeySecret).where(AuthApiKeySecret.key_id == key.id))
    return key


def _access_key_kek():
    from app.services.auth import _model_credential_kek, ModelCredentialEncryptionUnavailable
    try:
        return _model_credential_kek()
    except ModelCredentialEncryptionUnavailable:
        raise HTTPException(503, "密钥加密服务未就绪，请联系管理员", headers={"Cache-Control": "no-store"}) from None


def _aad(key: AuthApiKey, version: int) -> bytes:
    return f"learnflow|purpose=personal-access-key|user={key.user_id}|hash={key.token_hash}|version={version}".encode("ascii")


async def reveal_api_key(db: AsyncSession, account: UserAccount, key_id: int):
    key = (await db.execute(select(AuthApiKey).where(
        AuthApiKey.id == key_id, AuthApiKey.user_id == account.id,
    ))).scalar_one_or_none()
    if key is None:
        raise HTTPException(404, "API Key 不存在")
    if key.revoked_at or key.expires_at <= datetime.utcnow() or key.auth_epoch != account.auth_epoch or account.status != "active":
        raise HTTPException(409, "此密钥已失效，请签发新密钥")
    envelope = await db.get(AuthApiKeySecret, key.id)
    if envelope is None:
        raise HTTPException(409, "旧版密钥无法再次读取，请签发新密钥")
    kek, version = _access_key_kek()
    try:
        if envelope.encryption_version != version:
            raise ValueError("version mismatch")
        raw = base64.b64decode(envelope.ciphertext, altchars=b"-_", validate=True)
        token = AESGCM(kek).decrypt(raw[:12], raw[12:], _aad(key, version)).decode("ascii")
        if not hmac.compare_digest(hashlib.sha256(token.encode("ascii")).hexdigest(), key.token_hash):
            raise ValueError("digest mismatch")
    except (ValueError, InvalidTag, UnicodeError):
        raise HTTPException(503, "密钥暂时无法解密，请联系管理员", headers={"Cache-Control": "no-store"}) from None
    return token, key
