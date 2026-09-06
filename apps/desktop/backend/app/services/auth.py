from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import ipaddress
import math
import re
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from urllib.parse import urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from argon2.low_level import Type
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.database import async_session, get_db
from app.models.learning import (
    AuthLoginAttempt, AuthSession, DesktopPetCapability, Learner, LearnerProfile, UserAccount,
)
from app.models.project import (
    ArtifactAnnotation, Checkpoint, Exercise, LectureNote, ProcessAnimation, Project, Roadmap,
    Source, Task,
)


@dataclass(frozen=True)
class CurrentLearner:
    account: UserAccount
    learner: Learner
    profile: LearnerProfile
    is_dev_login: bool = False
    session_id: int | None = None
    auth_method: str = "internal"
    pet_capability_scopes: tuple[str, ...] = ()
    pet_capability_expires_at: datetime | None = None


DESKTOP_PET_CAPABILITY_SCOPES = (
    "pet.bootstrap.read",
    "pet.session.read",
    "pet.tutor.turn",
    "pet.task.read",
    "pet.task.control",
    "pet.skill.control",
    "pet.review.read",
    "pet.file.read",
    "pet.context.write",
)
DESKTOP_PET_CAPABILITY_TTL_SECONDS = 10 * 60


@dataclass(frozen=True)
class PasswordVerification:
    valid: bool
    needs_upgrade: bool = False
    scheme: str = "unknown"


class PasswordKDFBusy(RuntimeError):
    pass


class ModelCredentialEncryptionUnavailable(RuntimeError):
    pass


class ModelCredentialDecryptionError(RuntimeError):
    pass


class ModelCredentialFormatError(ValueError):
    pass


@dataclass(frozen=True)
class EncryptedModelCredential:
    ciphertext: str
    nonce: str
    key_hint: str
    version: int


@dataclass(frozen=True)
class AccountModelProviderConfig:
    api_key: str
    base_url: str
    model: str


INVALID_LOGIN_DETAIL = "用户名或密码错误"
LOGIN_BACKOFF_DETAIL = "登录暂不可用，请稍后重试"
CSRF_HEADER_NAME = "x-csrf-token"
RUNTIME_BRIDGE_HEADER_NAME = "x-learnflow-runtime-bridge-token"
_CSRF_CONTEXT = b"learnflow.session.csrf.v1"
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_KDF_LIMITER = threading.BoundedSemaphore(max(1, settings.auth_kdf_max_concurrency))
_MODEL_CREDENTIAL_PURPOSE = "model-provider-api-key"
_VISION_CREDENTIAL_PURPOSE = "vision-provider-api-key"
_RUNTIME_BRIDGE_PATH = "/api/auth/model-credential/internal/resolve"
_RUNTIME_BRIDGE_SENTINEL = "learnflow-runtime-bridge-unconfigured-sentinel"
_NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def normalize_username(username: str) -> str:
    return username.strip().casefold()


@lru_cache(maxsize=8)
def _configured_password_hasher(
    time_cost: int,
    memory_cost: int,
    parallelism: int,
) -> PasswordHasher:
    return PasswordHasher(
        time_cost=max(1, time_cost),
        memory_cost=max(8 * max(1, parallelism), memory_cost),
        parallelism=max(1, parallelism),
        hash_len=32,
        salt_len=16,
        type=Type.ID,
    )


def _password_hasher() -> PasswordHasher:
    return _configured_password_hasher(
        int(settings.auth_argon2_time_cost),
        int(settings.auth_argon2_memory_cost_kib),
        int(settings.auth_argon2_parallelism),
    )


@lru_cache(maxsize=8)
def _configured_dummy_hash(
    time_cost: int,
    memory_cost: int,
    parallelism: int,
) -> str:
    return _configured_password_hasher(
        time_cost,
        memory_cost,
        parallelism,
    ).hash("learnflow-login-timing-sentinel")


def _dummy_password_hash() -> str:
    return _configured_dummy_hash(
        int(settings.auth_argon2_time_cost),
        int(settings.auth_argon2_memory_cost_kib),
        int(settings.auth_argon2_parallelism),
    )


def hash_password(password: str) -> str:
    """Return an Argon2id PHC string for all newly written credentials."""
    return _password_hasher().hash(password)


def _verify_legacy_scrypt(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_text, digest_text = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        n_value, r_value, p_value = int(n), int(r), int(p)
        if (n_value, r_value, p_value) != (2**14, 8, 1):
            return False
        decoded_salt = base64.urlsafe_b64decode(salt_text.encode())
        expected = base64.urlsafe_b64decode(digest_text.encode())
        if len(decoded_salt) != 16 or len(expected) != 32:
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=decoded_salt,
            n=n_value,
            r=r_value,
            p=p_value,
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (binascii.Error, MemoryError, TypeError, ValueError, OverflowError):
        return False


def _verify_password_details(password: str, encoded: str | None) -> PasswordVerification:
    if not encoded:
        return PasswordVerification(False)
    if encoded.startswith("$argon2"):
        try:
            valid = bool(_password_hasher().verify(encoded, password))
        except VerifyMismatchError:
            return PasswordVerification(False, scheme="argon2id")
        except (InvalidHashError, VerificationError):
            return PasswordVerification(False)
        return PasswordVerification(
            valid,
            needs_upgrade=valid and _password_hasher().check_needs_rehash(encoded),
            scheme="argon2id",
        )
    if encoded.startswith("scrypt$"):
        valid = _verify_legacy_scrypt(password, encoded)
        return PasswordVerification(valid, needs_upgrade=valid, scheme="scrypt")
    return PasswordVerification(False)


def verify_password(password: str, encoded: str | None) -> bool:
    return _verify_password_details(password, encoded).valid


def _run_bounded_kdf(operation, *args):
    acquired = _KDF_LIMITER.acquire(
        timeout=max(0.1, float(settings.auth_kdf_queue_timeout_seconds))
    )
    if not acquired:
        raise PasswordKDFBusy("password KDF queue is full")
    try:
        return operation(*args)
    finally:
        _KDF_LIMITER.release()


async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(_run_bounded_kdf, hash_password, password)


def _verify_password_candidate(
    password: str,
    encoded: str | None,
) -> PasswordVerification:
    """Verify a real or sentinel hash without exposing account existence."""
    dummy_hash = _dummy_password_hash()
    candidate = encoded or dummy_hash
    result = _verify_password_details(password, candidate)
    if encoded is None:
        return PasswordVerification(False, scheme=result.scheme)
    return result


async def verify_password_async(
    password: str,
    encoded: str | None,
) -> PasswordVerification:
    return await asyncio.to_thread(
        _run_bounded_kdf,
        _verify_password_candidate,
        password,
        encoded,
    )


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    raw = value.encode("ascii")
    padded = raw + (b"=" * (-len(raw) % 4))
    return base64.b64decode(padded, altchars=b"-_", validate=True)


def _model_credential_kek() -> tuple[bytes, int]:
    configured = str(settings.auth_api_key_kek or "").strip()
    version = int(settings.auth_api_key_kek_version or 0)
    if not configured:
        raise ModelCredentialEncryptionUnavailable(
            "AUTH_API_KEY_KEK is not configured"
        )
    try:
        key = _base64url_decode(configured)
    except (binascii.Error, UnicodeEncodeError, ValueError) as exc:
        raise ModelCredentialEncryptionUnavailable(
            "AUTH_API_KEY_KEK is not valid URL-safe base64"
        ) from exc
    if len(key) != 32 or version < 1:
        raise ModelCredentialEncryptionUnavailable(
            "AUTH_API_KEY_KEK must encode 32 bytes and its version must be positive"
        )
    return key, version


def _model_credential_aad(
    account_id: int,
    version: int,
    purpose: str = _MODEL_CREDENTIAL_PURPOSE,
) -> bytes:
    return (
        "learnflow|purpose="
        f"{purpose}|account_id={int(account_id)}|version={int(version)}"
    ).encode("utf-8")


def _model_credential_hint(api_key: str) -> str:
    if len(api_key) < 12:
        return "••••"
    return f"{api_key[:3]}…{api_key[-4:]}"


def _validate_model_credential_plaintext(api_key: str) -> str:
    """Validate the provider-neutral HTTP Authorization credential shape."""
    plaintext = api_key.strip()
    if (
        not plaintext
        or not plaintext.isascii()
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in plaintext)
    ):
        raise ModelCredentialFormatError(
            "model credential must contain printable ASCII without whitespace"
        )
    return plaintext


def model_credential_configured(account: UserAccount) -> bool:
    return bool(
        account.api_key_ciphertext
        and account.api_key_nonce
        and account.api_key_hint
        and account.api_key_encryption_version
    )


def vision_credential_configured(account: UserAccount) -> bool:
    return bool(
        account.vision_api_key_ciphertext
        and account.vision_api_key_nonce
        and account.vision_api_key_hint
        and account.vision_api_key_encryption_version
    )


def encrypt_model_credential(account_id: int, api_key: str) -> EncryptedModelCredential:
    plaintext = _validate_model_credential_plaintext(api_key)
    kek, version = _model_credential_kek()
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(kek).encrypt(
        nonce,
        plaintext.encode("utf-8"),
        _model_credential_aad(account_id, version),
    )
    return EncryptedModelCredential(
        ciphertext=_base64url_encode(ciphertext),
        nonce=_base64url_encode(nonce),
        key_hint=_model_credential_hint(plaintext),
        version=version,
    )


def encrypt_vision_credential(account_id: int, api_key: str) -> EncryptedModelCredential:
    plaintext = _validate_model_credential_plaintext(api_key)
    kek, version = _model_credential_kek()
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(kek).encrypt(
        nonce,
        plaintext.encode("utf-8"),
        _model_credential_aad(account_id, version, _VISION_CREDENTIAL_PURPOSE),
    )
    return EncryptedModelCredential(
        ciphertext=_base64url_encode(ciphertext),
        nonce=_base64url_encode(nonce),
        key_hint=_model_credential_hint(plaintext),
        version=version,
    )


def decrypt_model_credential(account: UserAccount) -> str:
    if not model_credential_configured(account):
        raise ModelCredentialDecryptionError("model credential is not configured")
    try:
        kek, configured_version = _model_credential_kek()
        stored_version = int(account.api_key_encryption_version)
        if stored_version != configured_version:
            raise ModelCredentialDecryptionError("model credential KEK version mismatch")
        nonce = _base64url_decode(str(account.api_key_nonce))
        ciphertext = _base64url_decode(str(account.api_key_ciphertext))
        if len(nonce) != 12 or len(ciphertext) < 16:
            raise ModelCredentialDecryptionError("invalid model credential envelope")
        plaintext = AESGCM(kek).decrypt(
            nonce,
            ciphertext,
            _model_credential_aad(account.id, stored_version),
        )
        return _validate_model_credential_plaintext(plaintext.decode("utf-8"))
    except ModelCredentialEncryptionUnavailable:
        raise
    except ModelCredentialFormatError:
        raise
    except ModelCredentialDecryptionError:
        raise
    except (binascii.Error, InvalidTag, UnicodeDecodeError, UnicodeEncodeError, ValueError) as exc:
        raise ModelCredentialDecryptionError("model credential authentication failed") from exc


def decrypt_vision_credential(account: UserAccount) -> str:
    if not vision_credential_configured(account):
        raise ModelCredentialDecryptionError("vision credential is not configured")
    try:
        kek, configured_version = _model_credential_kek()
        stored_version = int(account.vision_api_key_encryption_version)
        if stored_version != configured_version:
            raise ModelCredentialDecryptionError("vision credential KEK version mismatch")
        nonce = _base64url_decode(str(account.vision_api_key_nonce))
        ciphertext = _base64url_decode(str(account.vision_api_key_ciphertext))
        if len(nonce) != 12 or len(ciphertext) < 16:
            raise ModelCredentialDecryptionError("invalid vision credential envelope")
        plaintext = AESGCM(kek).decrypt(
            nonce,
            ciphertext,
            _model_credential_aad(account.id, stored_version, _VISION_CREDENTIAL_PURPOSE),
        )
        return _validate_model_credential_plaintext(plaintext.decode("utf-8"))
    except ModelCredentialEncryptionUnavailable:
        raise
    except ModelCredentialFormatError:
        raise
    except ModelCredentialDecryptionError:
        raise
    except (binascii.Error, InvalidTag, UnicodeDecodeError, UnicodeEncodeError, ValueError) as exc:
        raise ModelCredentialDecryptionError("vision credential authentication failed") from exc


def account_model_provider_config(account: UserAccount) -> AccountModelProviderConfig:
    """Resolve a configured account credential without retaining plaintext state."""
    api_key = decrypt_model_credential(account)
    base_url = str(account.provider_base_url or settings.llm_base_url or "").strip()
    model = str(account.provider_model or settings.llm_model or "").strip()
    if not base_url or not model:
        raise ModelCredentialDecryptionError("model provider configuration is incomplete")
    return AccountModelProviderConfig(api_key=api_key, base_url=base_url, model=model)


def account_vision_provider_config(account: UserAccount) -> AccountModelProviderConfig:
    """Resolve the account visual provider, falling back to its Tutor key."""
    if vision_credential_configured(account):
        base_url = str(
            account.vision_provider_base_url or account.provider_base_url or settings.llm_base_url or ""
        ).strip()
        model = str(
            account.vision_provider_model or account.provider_model or settings.llm_model or ""
        ).strip()
        api_key = decrypt_vision_credential(account)
    else:
        fallback = account_model_provider_config(account)
        base_url = str(account.vision_provider_base_url or fallback.base_url or "").strip()
        model = str(account.vision_provider_model or fallback.model or "").strip()
        api_key = fallback.api_key
    if not base_url or not model:
        raise ModelCredentialDecryptionError("vision provider configuration is incomplete")
    return AccountModelProviderConfig(api_key=api_key, base_url=base_url, model=model)


def _csrf_token(session_token: str) -> str:
    digest = hmac.new(session_token.encode("utf-8"), _CSRF_CONTEXT, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


async def create_auth_session(
    db: AsyncSession, account: UserAccount, *, is_dev_login: bool = False,
) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    absolute_expires_at = now + timedelta(days=max(1, settings.auth_session_days))
    idle_expires_at = min(
        absolute_expires_at,
        now + timedelta(minutes=max(1, settings.auth_session_idle_minutes)),
    )
    db.add(AuthSession(
        user_id=account.id,
        token_hash=_token_hash(token),
        is_dev_login=is_dev_login,
        auth_epoch=int(account.auth_epoch or 0),
        csrf_token_hash=_token_hash(_csrf_token(token)),
        absolute_expires_at=absolute_expires_at,
        idle_expires_at=idle_expires_at,
        expires_at=absolute_expires_at,
        last_seen_at=now,
    ))
    account.last_login_at = now
    await db.flush()
    return token


async def issue_desktop_pet_capability(
    db: AsyncSession,
    *,
    current: CurrentLearner,
    auth_token: str | None = None,
    auth_session_id: int | None = None,
) -> str:
    """Issue a capability that the pet can use without receiving a full bearer.

    The capability is opaque and database-backed so logout, account epoch
    changes and expiry are all checked server-side.  It is intentionally scoped
    to a small set of read/continue operations rather than general API access.
    """
    if (auth_token is None) == (auth_session_id is None):
        raise ValueError("必须提供且仅提供一个桌面认证会话标识")
    now = datetime.utcnow()
    session_filter = (
        AuthSession.token_hash == _token_hash(auth_token)
        if auth_token is not None
        else AuthSession.id == auth_session_id
    )
    auth_session = (await db.execute(select(AuthSession).where(
        session_filter,
        AuthSession.user_id == current.account.id,
        AuthSession.revoked_at.is_(None),
        AuthSession.auth_epoch == current.account.auth_epoch,
        AuthSession.expires_at > now,
        AuthSession.absolute_expires_at > now,
        AuthSession.idle_expires_at > now,
    ))).scalar_one_or_none()
    if not auth_session:
        raise RuntimeError("桌面认证会话已失效")
    await db.execute(
        delete(DesktopPetCapability).where(
            DesktopPetCapability.auth_session_id == auth_session.id,
            DesktopPetCapability.revoked_at.is_(None),
        )
    )
    capability = secrets.token_urlsafe(32)
    db.add(DesktopPetCapability(
        auth_session_id=auth_session.id,
        user_id=current.account.id,
        learner_id=current.learner.id,
        token_hash=_token_hash(capability),
        scopes=list(DESKTOP_PET_CAPABILITY_SCOPES),
        auth_epoch=int(current.account.auth_epoch or 0),
        expires_at=now + timedelta(seconds=DESKTOP_PET_CAPABILITY_TTL_SECONDS),
    ))
    await db.flush()
    return f"lfpet_{capability}"


def require_desktop_pet_capability(
    current: CurrentLearner,
    scope: str,
) -> None:
    if current.auth_method != "desktop_pet_capability":
        raise HTTPException(403, "该接口仅允许桌宠受限身份访问")
    if scope not in current.pet_capability_scopes:
        raise HTTPException(403, "桌宠身份没有此操作权限")


def set_auth_cookie(response: Response, token: str):
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=settings.auth_session_days * 24 * 60 * 60,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
        domain=settings.auth_cookie_domain or None,
    )


def clear_auth_cookie(response: Response):
    response.delete_cookie(
        settings.auth_cookie_name,
        path="/",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
        domain=settings.auth_cookie_domain or None,
    )


def valid_desktop_request(request: Request) -> bool:
    supplied = request.headers.get("x-learnflow-desktop-token", "")
    return bool(
        settings.desktop_mode
        and settings.desktop_token
        and supplied
        and hmac.compare_digest(supplied, settings.desktop_token)
    )


def _desktop_bearer_token(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer ") and valid_desktop_request(request):
        token = authorization[7:].strip()
        if token and not token.startswith("lfpet_"):
            return token
    return None


def _desktop_pet_capability_token(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer ") or not valid_desktop_request(request):
        return None
    token = authorization[7:].strip()
    if token.startswith("lfpet_"):
        return token.removeprefix("lfpet_") or None
    return None


def _required_desktop_pet_scope(request: Request) -> str | None:
    """Map the tiny desktop-pet API surface to a capability scope.

    Authorization is checked before a route reaches a normal CurrentLearner
    dependency, preventing a captured pet capability from being reused for a
    profile, credential, project mutation or evidence endpoint.
    """
    path = request.url.path
    method = request.method.upper()
    if method == "GET" and path == "/api/pet/bootstrap":
        return "pet.bootstrap.read"
    if method == "GET" and (
        path == "/api/agent/sessions"
        or re.fullmatch(r"/api/agent/sessions/\d+", path)
    ):
        return "pet.session.read"
    if method == "POST" and re.fullmatch(r"/api/agent/sessions/\d+/turns", path):
        return "pet.tutor.turn"
    if method == "POST" and re.fullmatch(r"/api/agent/sessions/\d+/skill-runs/\d+/actions", path):
        return "pet.skill.control"
    if method == "GET" and (
        path in {"/api/learning-tasks", "/api/learning-tasks/summary"}
        or re.fullmatch(r"/api/learning-tasks/\d+", path)
    ):
        return "pet.task.read"
    if method == "POST" and re.fullmatch(r"/api/learning-tasks/\d+/actions", path):
        return "pet.task.control"
    if method == "GET" and path in {
        "/api/review/summary", "/api/review/items", "/api/review/agent-context",
    }:
        return "pet.review.read"
    if method == "GET" and (
        path == "/api/learning-files"
        or re.fullmatch(r"/api/learning-files/(lecture|practice)/[^/]+", path)
    ):
        return "pet.file.read"
    if path in {
        "/api/pet/context-packages",
        "/api/pet/context-packages/document",
        "/api/pet/context-packages/image",
        "/api/pet/selection-text",
    } and method == "POST":
        return "pet.context.write"
    if re.fullmatch(r"/api/pet/context-packages/[^/]+", path) and method == "DELETE":
        return "pet.context.write"
    if re.fullmatch(r"/api/pet/context-packages/[^/]+/confirm", path) and method == "POST":
        return "pet.context.write"
    return None


def is_loopback_request(request: Request) -> bool:
    peer_host = str(request.client.host if request.client else "").strip()
    # Starlette's in-process TestClient has no network peer.  It is accepted as
    # a loopback surrogate only after the explicit dev/demo flag is checked.
    if peer_host == "testclient":
        return (request.url.hostname or "").casefold() == "testserver"
    try:
        peer_is_loopback = ipaddress.ip_address(
            peer_host.split("%", 1)[0]
        ).is_loopback
    except ValueError:
        return False
    if not peer_is_loopback:
        return False
    request_host = (request.url.hostname or "").strip().casefold()
    if request_host == "localhost":
        return True
    try:
        return ipaddress.ip_address(request_host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _normalized_origin(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    default_port = 80 if parsed.scheme == "http" else 443
    port = port or default_port
    suffix = "" if port == default_port else f":{port}"
    return f"{parsed.scheme}://{parsed.hostname.casefold()}{suffix}"


def _allowed_browser_origins(request: Request) -> set[str]:
    allowed = {
        normalized
        for origin in settings.cors_origins_list
        if (normalized := _normalized_origin(origin)) is not None
    }
    host = request.headers.get("host", "")
    if host:
        request_origin = _normalized_origin(f"{request.url.scheme}://{host}")
        if request_origin:
            allowed.add(request_origin)
    return allowed


def _validate_browser_source(request: Request) -> None:
    fetch_site = request.headers.get("sec-fetch-site", "").strip().casefold()
    if fetch_site == "cross-site" or fetch_site not in {
        "", "same-origin", "same-site", "none",
    }:
        raise HTTPException(403, "请求验证失败")
    origin = request.headers.get("origin", "").strip()
    if origin:
        normalized = _normalized_origin(origin)
        if normalized is None or normalized not in _allowed_browser_origins(request):
            raise HTTPException(403, "请求验证失败")


def require_runtime_bridge_request(request: Request) -> None:
    """Authorize the server-only credential resolver without logging secrets.

    The fixed-size digests keep comparison constant-time even for missing or
    differently sized supplied values.  Browser provenance headers are rejected
    so possessing a normal LearnFlow session is never sufficient to invoke the
    plaintext resolver from frontend code.
    """
    configured = str(settings.auth_runtime_bridge_token or "").strip()
    supplied = request.headers.get(RUNTIME_BRIDGE_HEADER_NAME, "").strip()
    expected = configured or _RUNTIME_BRIDGE_SENTINEL
    supplied_digest = hashlib.sha256(supplied.encode("utf-8")).digest()
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    token_matches = hmac.compare_digest(supplied_digest, expected_digest)

    if len(configured) < 32:
        raise HTTPException(
            503,
            "运行时凭据桥接不可用：请配置 AUTH_RUNTIME_BRIDGE_TOKEN（至少 32 字符）",
            headers=_NO_STORE_HEADERS,
        )
    browser_metadata = any(
        request.headers.get(name, "").strip()
        for name in (
            "origin",
            "sec-fetch-site",
            "sec-fetch-dest",
            "sec-fetch-user",
        )
    )
    if browser_metadata or not supplied or not token_matches:
        raise HTTPException(
            403,
            "运行时凭据桥接验证失败",
            headers=_NO_STORE_HEADERS,
        )


def _csrf_bootstrap_path(path: str) -> bool:
    if path in {"/api/auth/login", "/api/auth/register", "/api/demo/login"}:
        return True
    return path.startswith("/api/dev/accounts/") and path.endswith("/login")


def _is_unannotated_in_process_test_request(request: Request) -> bool:
    """Preserve legacy TestClient calls without creating a network bypass.

    Starlette synthesizes the otherwise impossible peer/host pair below.  As
    soon as a security test supplies Origin, Fetch Metadata, or a CSRF header,
    the request is evaluated by the production policy.
    """
    return bool(
        request.client
        and request.client.host == "testclient"
        and (request.url.hostname or "").casefold() == "testserver"
        and not request.headers.get("origin")
        and not request.headers.get("sec-fetch-site")
        and not request.headers.get(CSRF_HEADER_NAME)
    )


async def enforce_browser_request_security(request: Request) -> None:
    """Enforce browser provenance and session-bound CSRF on unsafe methods."""
    if request.method.upper() not in _UNSAFE_METHODS:
        return
    if request.url.path == _RUNTIME_BRIDGE_PATH:
        require_runtime_bridge_request(request)
        return
    if valid_desktop_request(request):
        # Desktop shell (Tauri sidecar) traffic is cross-origin by design and
        # is authenticated by the per-boot X-LearnFlow-Desktop-Token that the
        # sidecar hands only to its own window.  Pre-auth bootstrap calls such
        # as /api/auth/login carry that token but no bearer yet, so exempt the
        # whole desktop channel here; every route still enforces its own auth.
        return
    if _is_unannotated_in_process_test_request(request):
        return
    _validate_browser_source(request)
    if _csrf_bootstrap_path(request.url.path):
        return
    raw_token = request.cookies.get(settings.auth_cookie_name)
    if not raw_token:
        return
    supplied_csrf = request.headers.get(CSRF_HEADER_NAME, "").strip()
    if not supplied_csrf:
        raise HTTPException(403, "请求验证失败")
    now = datetime.utcnow()
    async with async_session() as db:
        session = (await db.execute(
            select(AuthSession)
            .join(UserAccount, UserAccount.id == AuthSession.user_id)
            .where(
                AuthSession.token_hash == _token_hash(raw_token),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.absolute_expires_at > now,
                AuthSession.idle_expires_at > now,
                AuthSession.auth_epoch == UserAccount.auth_epoch,
                UserAccount.status == "active",
            )
        )).scalar_one_or_none()
    if not session or not hmac.compare_digest(
        session.csrf_token_hash or "", _token_hash(supplied_csrf),
    ):
        raise HTTPException(403, "请求验证失败")


async def current_learner_from_request(
    request: Request,
    db: AsyncSession,
    *,
    required: bool = True,
) -> CurrentLearner | None:
    pet_capability = _desktop_pet_capability_token(request)
    if pet_capability:
        required_scope = _required_desktop_pet_scope(request)
        if not required_scope:
            raise HTTPException(403, "桌宠身份不能访问此接口")
        now = datetime.utcnow()
        row = (await db.execute(
            select(DesktopPetCapability, AuthSession, UserAccount, Learner, LearnerProfile)
            .join(AuthSession, AuthSession.id == DesktopPetCapability.auth_session_id)
            .join(UserAccount, UserAccount.id == DesktopPetCapability.user_id)
            .join(Learner, Learner.id == DesktopPetCapability.learner_id)
            .join(LearnerProfile, LearnerProfile.learner_id == Learner.id)
            .where(
                DesktopPetCapability.token_hash == _token_hash(pet_capability),
                DesktopPetCapability.revoked_at.is_(None),
                DesktopPetCapability.expires_at > now,
                DesktopPetCapability.auth_epoch == UserAccount.auth_epoch,
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.absolute_expires_at > now,
                AuthSession.idle_expires_at > now,
                AuthSession.auth_epoch == UserAccount.auth_epoch,
                UserAccount.status == "active",
            )
        )).first()
        if not row:
            if required:
                raise HTTPException(401, "桌宠身份已失效，请在主窗口重新登录")
            return None
        capability, session, account, learner, profile = row
        scopes = tuple(str(item) for item in (capability.scopes or ()) if isinstance(item, str))
        if required_scope not in scopes:
            raise HTTPException(403, "桌宠身份没有此操作权限")
        return CurrentLearner(
            account=account,
            learner=learner,
            profile=profile,
            is_dev_login=bool(session.is_dev_login),
            session_id=session.id,
            auth_method="desktop_pet_capability",
            pet_capability_scopes=scopes,
            pet_capability_expires_at=capability.expires_at,
        )
    bearer_token = _desktop_bearer_token(request)
    raw_token = bearer_token or request.cookies.get(settings.auth_cookie_name)
    auth_method = "desktop_bearer" if bearer_token else "cookie"
    if not raw_token:
        if required:
            raise HTTPException(401, "请先登录")
        return None
    now = datetime.utcnow()
    row = (await db.execute(
        select(AuthSession, UserAccount, Learner, LearnerProfile)
        .join(UserAccount, UserAccount.id == AuthSession.user_id)
        .join(Learner, Learner.user_id == UserAccount.id)
        .join(LearnerProfile, LearnerProfile.learner_id == Learner.id)
        .where(
            AuthSession.token_hash == _token_hash(raw_token),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
            AuthSession.absolute_expires_at > now,
            AuthSession.idle_expires_at > now,
            AuthSession.auth_epoch == UserAccount.auth_epoch,
            UserAccount.status == "active",
        )
    )).first()
    if not row:
        if required:
            raise HTTPException(401, "登录已失效")
        return None
    session, account, learner, profile = row
    last_seen = session.last_seen_at or session.created_at or now
    if (now - last_seen).total_seconds() >= max(
        1, settings.auth_session_touch_interval_seconds,
    ):
        session.last_seen_at = now
        session.idle_expires_at = min(
            session.absolute_expires_at,
            now + timedelta(minutes=max(1, settings.auth_session_idle_minutes)),
        )
        await db.commit()
    return CurrentLearner(
        account=account, learner=learner, profile=profile,
        is_dev_login=bool(session.is_dev_login),
        session_id=session.id,
        auth_method=auth_method,
    )


def auth_token_from_request(request: Request) -> str | None:
    return _desktop_bearer_token(request) or request.cookies.get(settings.auth_cookie_name)


async def csrf_token_from_request(request: Request, db: AsyncSession) -> str:
    _validate_browser_source(request)
    raw_token = request.cookies.get(settings.auth_cookie_name)
    if not raw_token:
        raise HTTPException(401, "请先登录")
    token = _csrf_token(raw_token)
    now = datetime.utcnow()
    session = (await db.execute(
        select(AuthSession)
        .join(UserAccount, UserAccount.id == AuthSession.user_id)
        .where(
            AuthSession.token_hash == _token_hash(raw_token),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
            AuthSession.absolute_expires_at > now,
            AuthSession.idle_expires_at > now,
            AuthSession.auth_epoch == UserAccount.auth_epoch,
            UserAccount.status == "active",
        )
    )).scalar_one_or_none()
    if not session or not hmac.compare_digest(
        session.csrf_token_hash or "", _token_hash(token),
    ):
        raise HTTPException(401, "登录已失效")
    return token


def login_request_keys(request: Request, normalized_username: str) -> tuple[str, str]:
    account_key = hashlib.sha256(
        f"account:{normalized_username}".encode("utf-8")
    ).hexdigest()
    peer = str(request.client.host if request.client else "unknown").strip().casefold()
    ip_key = hashlib.sha256(f"peer:{peer}".encode("utf-8")).hexdigest()
    return account_key, ip_key


def _failure_delay(failure_count: int, free_failures: int) -> int:
    if failure_count <= max(0, free_failures):
        return 0
    exponent = min(20, failure_count - max(0, free_failures) - 1)
    return min(
        max(1, settings.auth_login_backoff_max_seconds),
        max(1, settings.auth_login_backoff_base_seconds) * (2 ** exponent),
    )


async def _attempt_stats(
    db: AsyncSession,
    column,
    key: str,
    cutoff: datetime,
) -> tuple[int, datetime | None]:
    count, latest = (await db.execute(select(
        func.count(AuthLoginAttempt.id),
        func.max(AuthLoginAttempt.attempted_at),
    ).where(column == key, AuthLoginAttempt.attempted_at >= cutoff))).one()
    return int(count or 0), latest


async def login_backoff_seconds(
    db: AsyncSession,
    account_key: str,
    ip_key: str,
    *,
    now: datetime | None = None,
) -> int:
    now = now or datetime.utcnow()
    cutoff = now - timedelta(seconds=max(1, settings.auth_login_window_seconds))
    account_count, account_latest = await _attempt_stats(
        db, AuthLoginAttempt.account_key_hash, account_key, cutoff,
    )
    ip_count, ip_latest = await _attempt_stats(
        db, AuthLoginAttempt.ip_key_hash, ip_key, cutoff,
    )
    waits = []
    for count, latest, free in (
        (account_count, account_latest, settings.auth_login_account_free_failures),
        (ip_count, ip_latest, settings.auth_login_ip_free_failures),
    ):
        delay = _failure_delay(count, free)
        if delay and latest:
            waits.append(max(0, math.ceil((latest + timedelta(seconds=delay) - now).total_seconds())))
    return max(waits, default=0)


async def record_login_failure(
    db: AsyncSession,
    account_key: str,
    ip_key: str,
) -> int:
    now = datetime.utcnow()
    cutoff = now - timedelta(seconds=max(1, settings.auth_login_window_seconds))
    await db.execute(delete(AuthLoginAttempt).where(AuthLoginAttempt.attempted_at < cutoff))
    db.add(AuthLoginAttempt(
        account_key_hash=account_key,
        ip_key_hash=ip_key,
        attempted_at=now,
    ))
    await db.flush()
    delay = await login_backoff_seconds(db, account_key, ip_key, now=now)
    await db.commit()
    return delay


async def clear_login_failures(db: AsyncSession, account_key: str) -> None:
    await db.execute(delete(AuthLoginAttempt).where(
        AuthLoginAttempt.account_key_hash == account_key,
    ))


async def get_current_learner(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> CurrentLearner:
    return await current_learner_from_request(request, db, required=True)


async def require_admin(
    current: CurrentLearner = Depends(get_current_learner),
) -> CurrentLearner:
    if current.account.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return current


async def load_current_learner(db: AsyncSession, learner_id: int) -> CurrentLearner:
    row = (await db.execute(
        select(UserAccount, Learner, LearnerProfile)
        .join(Learner, Learner.user_id == UserAccount.id)
        .join(LearnerProfile, LearnerProfile.learner_id == Learner.id)
        .where(Learner.id == learner_id, UserAccount.status == "active")
    )).first()
    if not row:
        raise HTTPException(404, "Learner not found")
    return CurrentLearner(account=row[0], learner=row[1], profile=row[2])


async def require_owned_project(db: AsyncSession, learner_id: int, project_id: int) -> Project:
    project = (await db.execute(select(Project).where(
        Project.id == project_id,
        Project.learner_id == learner_id,
        Project.visibility != "deleted",
    ))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    return project


async def require_owned_checkpoint(db: AsyncSession, learner_id: int, checkpoint_id: int) -> Checkpoint:
    checkpoint = (await db.execute(
        select(Checkpoint)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            Checkpoint.id == checkpoint_id,
            Project.learner_id == learner_id,
            Project.visibility != "deleted",
        )
    )).scalar_one_or_none()
    if not checkpoint:
        raise HTTPException(404, "Checkpoint not found")
    return checkpoint


async def require_owned_task(db: AsyncSession, learner_id: int, task_id: int) -> Task:
    task = (await db.execute(select(Task).where(
        Task.id == task_id, Task.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not task:
        raise HTTPException(404, "Task not found")
    return task


async def require_owned_source(
    db: AsyncSession, learner_id: int, source_id: int,
    project_id: int | None = None,
) -> Source:
    query = select(Source).join(Project, Project.id == Source.project_id).where(
        Source.id == source_id,
        Project.learner_id == learner_id,
        Project.visibility != "deleted",
    )
    if project_id is not None:
        query = query.where(Source.project_id == project_id)
    source = (await db.execute(query)).scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Source not found")
    return source


async def require_owned_exercise(db: AsyncSession, learner_id: int, exercise_id: int) -> Exercise:
    exercise = (await db.execute(
        select(Exercise)
        .join(Checkpoint, Checkpoint.id == Exercise.checkpoint_id)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            Exercise.id == exercise_id,
            Project.learner_id == learner_id,
            Project.visibility != "deleted",
        )
    )).scalar_one_or_none()
    if not exercise:
        raise HTTPException(404, "Exercise not found")
    return exercise


async def require_owned_note(db: AsyncSession, learner_id: int, note_id: int) -> LectureNote:
    note = (await db.execute(
        select(LectureNote)
        .join(Checkpoint, Checkpoint.id == LectureNote.checkpoint_id)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            LectureNote.id == note_id,
            Project.learner_id == learner_id,
            Project.visibility != "deleted",
        )
    )).scalar_one_or_none()
    if not note:
        raise HTTPException(404, "Note not found")
    return note


async def require_owned_annotation(
    db: AsyncSession, learner_id: int, annotation_id: int,
) -> ArtifactAnnotation:
    annotation = (await db.execute(select(ArtifactAnnotation).where(
        ArtifactAnnotation.id == annotation_id,
        ArtifactAnnotation.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not annotation:
        raise HTTPException(404, "Annotation not found")
    return annotation


async def require_owned_animation(
    db: AsyncSession, learner_id: int, animation_id: int,
) -> ProcessAnimation:
    animation = await db.get(ProcessAnimation, animation_id)
    try:
        if animation and animation.project_id:
            await require_owned_project(db, learner_id, animation.project_id)
            return animation
        if animation and animation.checkpoint_id:
            await require_owned_checkpoint(db, learner_id, animation.checkpoint_id)
            return animation
    except HTTPException:
        pass
    raise HTTPException(404, "Animation not found")
