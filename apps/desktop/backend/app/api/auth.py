import ipaddress
import time
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import and_, case, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import (
    normalize_openai_base_url,
    openai_chat_provider_kwargs,
    settings,
)
from app.db.database import get_db
from app.models.learning import AuthSession, Learner, LearnerProfile, UserAccount
from app.models.project import Project
from app.schemas.auth import (
    AdminAccountProjection,
    AuthenticatedAccountResponse,
    CsrfTokenResponse,
    DesktopPetCapabilityRefreshResponse,
    LoginRequest,
    LogoutResponse,
    ModelCredentialMetadata,
    ModelCredentialResolveResponse,
    ModelCredentialTestRequest,
    ModelCredentialTestResponse,
    ModelCredentialUpdateRequest,
    PasswordChangeRequest,
    RegisterRequest,
    VisionCredentialMetadata,
    VisionCredentialUpdateRequest,
)
from app.services.auth import (
    INVALID_LOGIN_DETAIL,
    LOGIN_BACKOFF_DETAIL,
    CurrentLearner,
    ModelCredentialDecryptionError,
    ModelCredentialEncryptionUnavailable,
    ModelCredentialFormatError,
    PasswordKDFBusy,
    clear_auth_cookie,
    clear_login_failures,
    create_auth_session,
    csrf_token_from_request,
    current_learner_from_request,
    encrypt_model_credential,
    account_model_provider_config,
    account_vision_provider_config,
    encrypt_vision_credential,
    get_current_learner,
    hash_password_async,
    is_loopback_request,
    issue_desktop_pet_capability,
    login_backoff_seconds,
    login_request_keys,
    model_credential_configured,
    normalize_username,
    record_login_failure,
    require_admin,
    require_runtime_bridge_request,
    set_auth_cookie,
    valid_desktop_request,
    vision_credential_configured,
    verify_password_async,
)
from app.services.demo_seed import DEMO_USERNAME, demo_manifest
from app.services.learning_runtime import ensure_kernel_states, record_event
from app.services.profile import award_career_goal
from app.services.provider_compat import create_chat_completion


router = APIRouter(tags=["Authentication"])
dev_router = APIRouter(prefix="/dev", tags=["Development"])


def _account_view(
    current: CurrentLearner,
    desktop_auth_token: str | None = None,
    desktop_pet_capability_token: str | None = None,
) -> dict:
    result = {
        "id": current.account.id,
        "account_number": current.account.account_number,
        "username": current.account.username,
        "display_name": current.learner.display_name,
        "learner_id": current.learner.id,
        "role": current.account.role,
        "status": current.account.status,
        "must_change_password": bool(current.account.must_change_password),
        "is_legacy_demo": bool(current.account.is_legacy_demo),
        "profile": {
            "education_stage": current.profile.education_stage,
            "background": current.profile.background,
            "focus_areas": current.profile.focus_areas or [],
            "weekly_hours": current.profile.weekly_hours,
            "preferred_modes": current.profile.preferred_modes or [],
            "career_goal": current.profile.career_goal or "",
            "career_goal_status": current.profile.career_goal_status,
        },
        "dev_test_login_enabled": settings.dev_test_login_enabled,
        "is_dev_login": current.is_dev_login,
    }
    if desktop_auth_token:
        result["desktop_auth_token"] = desktop_auth_token
    if desktop_pet_capability_token:
        result["desktop_pet_capability_token"] = desktop_pet_capability_token
    return result


def _model_credential_view(account: UserAccount) -> ModelCredentialMetadata:
    configured = model_credential_configured(account)
    return ModelCredentialMetadata(
        configured=configured,
        key_hint=str(account.api_key_hint or "") if configured else "",
        updated_at=account.api_key_updated_at,
        base_url=str(account.provider_base_url or ""),
        model=str(account.provider_model or ""),
    )


def _vision_credential_view(account: UserAccount) -> VisionCredentialMetadata:
    dedicated = vision_credential_configured(account)
    base_url = str(account.vision_provider_base_url or account.provider_base_url or "")
    model = str(account.vision_provider_model or account.provider_model or "")
    has_key = dedicated or model_credential_configured(account)
    return VisionCredentialMetadata(
        configured=bool(has_key and base_url and model),
        uses_tutor_key=not dedicated,
        key_hint=(
            str(account.vision_api_key_hint or "") if dedicated
            else str(account.api_key_hint or "") if model_credential_configured(account)
            else ""
        ),
        updated_at=(account.vision_api_key_updated_at if dedicated else account.api_key_updated_at),
        base_url=base_url,
        model=model,
    )


def _raise_model_credential_kek_error() -> None:
    raise HTTPException(
        503,
        "账户模型凭据加密不可用：请配置 AUTH_API_KEY_KEK（32 字节 URL-safe Base64）",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


def _validated_model_base_url(value: str) -> str:
    normalized = normalize_openai_base_url(value)
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError:
        raise HTTPException(422, "模型服务地址无效") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or port is not None and not 1 <= port <= 65535
    ):
        raise HTTPException(422, "模型服务地址无效")
    if parsed.scheme == "http":
        host = parsed.hostname.casefold()
        try:
            loopback = ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
        except ValueError:
            loopback = host == "localhost"
        if not loopback:
            raise HTTPException(422, "非本机模型服务必须使用 HTTPS")
    return normalized


def _raise_kdf_busy() -> None:
    raise HTTPException(
        503,
        "认证服务繁忙，请稍后重试",
        headers={"Retry-After": "1"},
    )


def _raise_login_backoff(seconds: int) -> None:
    raise HTTPException(
        429,
        LOGIN_BACKOFF_DETAIL,
        headers={"Retry-After": str(max(1, seconds))},
    )


async def _reject_login(
    db: AsyncSession,
    account_key: str,
    ip_key: str,
) -> None:
    delay = await record_login_failure(db, account_key, ip_key)
    if delay:
        _raise_login_backoff(delay)
    raise HTTPException(401, INVALID_LOGIN_DETAIL)


@router.post(
    "/auth/register",
    response_model=AuthenticatedAccountResponse,
    response_model_exclude_none=True,
)
async def register(
    data: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    normalized = normalize_username(data.username)
    existing = (await db.execute(
        select(UserAccount.id).where(UserAccount.username_normalized == normalized)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "用户名已存在")
    try:
        password_hash = await hash_password_async(data.password)
    except PasswordKDFBusy:
        _raise_kdf_busy()

    # Public account zero is a compatibility identity, not the database PK.
    # Only the exact normalized, non-demo Ryan account may receive it.
    account_kwargs = {
        "username": data.username.strip(),
        "username_normalized": normalized,
        "password_hash": password_hash,
        "password_version": 1,
        "must_change_password": False,
    }
    if normalized == "ryan":
        account_kwargs.update(account_number=0, role="admin")
    account = UserAccount(**account_kwargs)
    db.add(account)
    try:
        await db.flush()
        learner = Learner(
            user_id=account.id,
            key=f"user-{account.id}",
            display_name=data.display_name.strip(),
        )
        db.add(learner)
        await db.flush()
        profile = LearnerProfile(
            learner_id=learner.id,
            education_stage=data.education_stage,
            background=data.background.strip(),
            focus_areas=data.focus_areas,
            weekly_hours=data.weekly_hours,
            preferred_modes=data.preferred_modes,
            career_goal=data.career_goal.strip(),
            career_goal_status=data.career_goal_status,
        )
        db.add(profile)
        await ensure_kernel_states(db, learner.id)
        registration_event = await record_event(
            db,
            learner_id=learner.id,
            event_type="registration_profile_completed",
            source="registration",
            payload={
                "education_stage": profile.education_stage,
                "background": profile.background,
                "focus_areas": profile.focus_areas,
                "weekly_hours": profile.weekly_hours,
                "preferred_modes": profile.preferred_modes,
                "career_goal": profile.career_goal,
                "career_goal_status": profile.career_goal_status,
            },
            confidence=1.0,
            provenance={"self_report": True},
            client_event_id="registration-profile",
        )
        if profile.career_goal and profile.career_goal_status == "confirmed":
            await award_career_goal(
                db,
                learner_id=learner.id,
                career_goal=profile.career_goal,
                confidence=1.0,
                source_event_id=registration_event.id,
            )
        token = await create_auth_session(db, account)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "用户名已存在") from None
    set_auth_cookie(response, token)
    current = CurrentLearner(account, learner, profile)
    desktop_auth_token = token if valid_desktop_request(request) else None
    desktop_pet_capability_token = (
        await issue_desktop_pet_capability(db, current=current, auth_token=token)
        if desktop_auth_token else None
    )
    if desktop_pet_capability_token:
        await db.commit()
    return _account_view(
        current,
        desktop_auth_token,
        desktop_pet_capability_token,
    )


@router.post(
    "/auth/login",
    response_model=AuthenticatedAccountResponse,
    response_model_exclude_none=True,
)
async def login(
    data: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    normalized = normalize_username(data.username)
    account_key, ip_key = login_request_keys(request, normalized)
    delay = await login_backoff_seconds(db, account_key, ip_key)
    if delay:
        _raise_login_backoff(delay)

    account = (await db.execute(select(UserAccount).where(
        UserAccount.username_normalized == normalized,
    ))).scalar_one_or_none()
    eligible_hash = (
        account.password_hash
        if account is not None and account.status == "active"
        else None
    )
    try:
        verification = await verify_password_async(data.password, eligible_hash)
    except PasswordKDFBusy:
        _raise_kdf_busy()
    if not verification.valid or account is None:
        await _reject_login(db, account_key, ip_key)

    identity = (await db.execute(
        select(Learner, LearnerProfile)
        .join(LearnerProfile, LearnerProfile.learner_id == Learner.id)
        .where(Learner.user_id == account.id)
    )).first()
    if identity is None:
        await _reject_login(db, account_key, ip_key)
    learner, profile = identity

    if verification.needs_upgrade:
        try:
            account.password_hash = await hash_password_async(data.password)
        except PasswordKDFBusy:
            _raise_kdf_busy()
        account.password_version = max(1, int(account.password_version or 0)) + 1
        account.password_upgraded_at = datetime.utcnow()

    await clear_login_failures(db, account_key)
    token = await create_auth_session(db, account)
    await db.commit()
    set_auth_cookie(response, token)
    current = CurrentLearner(account, learner, profile)
    desktop_auth_token = token if valid_desktop_request(request) else None
    desktop_pet_capability_token = (
        await issue_desktop_pet_capability(db, current=current, auth_token=token)
        if desktop_auth_token else None
    )
    if desktop_pet_capability_token:
        await db.commit()
    return _account_view(
        current,
        desktop_auth_token,
        desktop_pet_capability_token,
    )


@router.get("/auth/csrf", response_model=CsrfTokenResponse)
async def csrf_token(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _current: CurrentLearner = Depends(get_current_learner),
):
    token = await csrf_token_from_request(request, db)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Cookie"
    return CsrfTokenResponse(csrf_token=token)


@router.get("/auth/model-credential", response_model=ModelCredentialMetadata)
async def get_model_credential(
    response: Response,
    current: CurrentLearner = Depends(get_current_learner),
):
    response.headers["Cache-Control"] = "no-store"
    return _model_credential_view(current.account)


@router.put("/auth/model-credential", response_model=ModelCredentialMetadata)
async def put_model_credential(
    data: ModelCredentialUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    api_key = data.api_key.strip()
    if not api_key and not data.base_url.strip() and not data.model.strip():
        return _model_credential_view(current.account)
    base_url = _validated_model_base_url(
        data.base_url.strip() or current.account.provider_base_url or settings.llm_base_url
    )
    model = data.model.strip() or current.account.provider_model or settings.llm_model
    if not model:
        raise HTTPException(422, "模型名称不能为空")
    if api_key:
        try:
            envelope = encrypt_model_credential(current.account.id, api_key)
        except ModelCredentialFormatError:
            raise HTTPException(
                422,
                "API Key 格式无效：只能包含不带空白的 ASCII 字符",
            ) from None
        except ModelCredentialEncryptionUnavailable:
            _raise_model_credential_kek_error()
        current.account.api_key_ciphertext = envelope.ciphertext
        current.account.api_key_nonce = envelope.nonce
        current.account.api_key_hint = envelope.key_hint
        current.account.api_key_encryption_version = envelope.version
    current.account.provider_base_url = base_url
    current.account.provider_model = model
    current.account.api_key_updated_at = datetime.utcnow()
    await db.commit()
    return _model_credential_view(current.account)


@router.delete("/auth/model-credential", response_model=ModelCredentialMetadata)
async def delete_model_credential(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    current.account.api_key_ciphertext = None
    current.account.api_key_nonce = None
    current.account.api_key_hint = None
    current.account.api_key_encryption_version = None
    current.account.provider_base_url = None
    current.account.provider_model = None
    current.account.api_key_updated_at = datetime.utcnow()
    await db.commit()
    return _model_credential_view(current.account)


@router.get("/auth/vision-credential", response_model=VisionCredentialMetadata)
async def get_vision_credential(
    response: Response,
    current: CurrentLearner = Depends(get_current_learner),
):
    response.headers["Cache-Control"] = "no-store"
    return _vision_credential_view(current.account)


@router.put("/auth/vision-credential", response_model=VisionCredentialMetadata)
async def put_vision_credential(
    data: VisionCredentialUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    base_url = _validated_model_base_url(
        data.base_url.strip()
        or current.account.vision_provider_base_url
        or current.account.provider_base_url
        or settings.llm_base_url
    )
    model = (
        data.model.strip()
        or current.account.vision_provider_model
        or current.account.provider_model
        or settings.llm_model
    )
    if not model:
        raise HTTPException(422, "视觉模型名称不能为空")
    if data.use_tutor_key:
        current.account.vision_api_key_ciphertext = None
        current.account.vision_api_key_nonce = None
        current.account.vision_api_key_hint = None
        current.account.vision_api_key_encryption_version = None
        current.account.vision_api_key_updated_at = datetime.utcnow()
    elif data.api_key.strip():
        try:
            envelope = encrypt_vision_credential(current.account.id, data.api_key.strip())
        except ModelCredentialFormatError:
            raise HTTPException(
                422,
                "视觉 API Key 格式无效：只能包含不带空白的 ASCII 字符",
            ) from None
        except ModelCredentialEncryptionUnavailable:
            _raise_model_credential_kek_error()
        current.account.vision_api_key_ciphertext = envelope.ciphertext
        current.account.vision_api_key_nonce = envelope.nonce
        current.account.vision_api_key_hint = envelope.key_hint
        current.account.vision_api_key_encryption_version = envelope.version
        current.account.vision_api_key_updated_at = datetime.utcnow()
    current.account.vision_provider_base_url = base_url
    current.account.vision_provider_model = model
    await db.commit()
    return _vision_credential_view(current.account)


@router.delete("/auth/vision-credential", response_model=VisionCredentialMetadata)
async def delete_vision_credential(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    current.account.vision_api_key_ciphertext = None
    current.account.vision_api_key_nonce = None
    current.account.vision_api_key_hint = None
    current.account.vision_api_key_encryption_version = None
    current.account.vision_api_key_updated_at = datetime.utcnow()
    current.account.vision_provider_base_url = None
    current.account.vision_provider_model = None
    await db.commit()
    return _vision_credential_view(current.account)


@router.post(
    "/auth/vision-credential/test",
    response_model=ModelCredentialTestResponse,
)
async def test_vision_credential(
    current: CurrentLearner = Depends(get_current_learner),
):
    metadata = _vision_credential_view(current.account)
    if not metadata.configured:
        raise HTTPException(409, "尚未配置可用的视觉模型")
    try:
        provider_config = account_vision_provider_config(current.account)
    except ModelCredentialEncryptionUnavailable:
        _raise_model_credential_kek_error()
    except (ModelCredentialDecryptionError, ModelCredentialFormatError):
        raise HTTPException(500, "视觉模型凭据无法解密，请重新配置") from None
    try:
        started = time.perf_counter()
        await create_chat_completion(
            api_key=provider_config.api_key,
            base_url=provider_config.base_url,
            model=provider_config.model,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "只回复 OK"},
                    {"type": "image_url", "image_url": {"url": (
                        "data:image/png;base64,"
                        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGP8//8/AymAiSTVDKMaiANMRKqDg1ENxACSQwkAVW0DHeN02ZEAAAAASUVORK5CYII="
                    )}},
                ],
            }],
            max_tokens=16,
            timeout=15,
            **openai_chat_provider_kwargs(
                provider_config.base_url,
                provider_config.model,
                thinking_enabled=False,
            ),
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
    except Exception as exc:
        status_code = getattr(exc, "status_code", None)
        if status_code in {400, 404, 415, 422}:
            raise HTTPException(400, "模型或服务地址不支持图片理解") from None
        if status_code in {401, 403}:
            raise HTTPException(400, "视觉模型凭据验证失败") from None
        raise HTTPException(502, "视觉模型连接测试失败") from None
    return ModelCredentialTestResponse(
        status="ok",
        model=provider_config.model,
        latency_ms=latency_ms,
    )


@router.post(
    "/auth/model-credential/test",
    response_model=ModelCredentialTestResponse,
)
async def test_model_credential(
    data: ModelCredentialTestRequest,
    current: CurrentLearner = Depends(get_current_learner),
):
    if not model_credential_configured(current.account):
        raise HTTPException(409, "尚未配置账户模型凭据")
    try:
        provider_config = account_model_provider_config(current.account)
    except ModelCredentialFormatError:
        raise HTTPException(
            422,
            "账户模型凭据格式无效，请在设置中重新保存 API Key",
        ) from None
    except ModelCredentialEncryptionUnavailable:
        _raise_model_credential_kek_error()
    except ModelCredentialDecryptionError:
        raise HTTPException(
            500,
            "账户模型凭据无法解密，请检查 KEK 版本或密文完整性",
        ) from None

    base_url = _validated_model_base_url(
        data.base_url.strip() or provider_config.base_url or settings.llm_base_url
    )
    model = data.model.strip() or provider_config.model or settings.llm_model
    if not model:
        raise HTTPException(422, "模型名称不能为空")
    try:
        started = time.perf_counter()
        provider_response = await create_chat_completion(
            api_key=provider_config.api_key,
            base_url=base_url,
            model=model,
            messages=[{"role": "user", "content": "只回复 OK"}],
            max_tokens=16,
            timeout=60,
            **openai_chat_provider_kwargs(
                base_url,
                model,
                thinking_enabled=False,
            ),
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
    except Exception as exc:
        status_code = getattr(exc, "status_code", None)
        error_name = type(exc).__name__.casefold()
        if status_code in {401, 403} or "authentication" in error_name:
            raise HTTPException(400, "模型凭据验证失败") from None
        if status_code == 404:
            raise HTTPException(400, "模型或服务地址不可用") from None
        if "timeout" in error_name:
            raise HTTPException(400, "模型服务连接超时") from None
        raise HTTPException(400, "模型服务连接测试失败") from None
    return ModelCredentialTestResponse(
        status="ok",
        model=str(getattr(provider_response, "model", None) or model),
        latency_ms=latency_ms,
    )


@router.post(
    "/auth/model-credential/internal/resolve",
    response_model=ModelCredentialResolveResponse,
    include_in_schema=False,
)
async def resolve_model_credential_for_runtime(
    request: Request,
    response: Response,
    current: CurrentLearner = Depends(get_current_learner),
):
    # This is intentionally checked both by the request-security middleware and
    # here so direct route invocation cannot bypass the server-only boundary.
    require_runtime_bridge_request(request)
    if not model_credential_configured(current.account):
        raise HTTPException(
            409,
            "尚未配置账户模型凭据",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    try:
        provider_config = account_model_provider_config(current.account)
    except ModelCredentialFormatError:
        raise HTTPException(
            422,
            "账户模型凭据格式无效，请在设置中重新保存 API Key",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        ) from None
    except ModelCredentialEncryptionUnavailable:
        _raise_model_credential_kek_error()
    except ModelCredentialDecryptionError:
        raise HTTPException(
            500,
            "账户模型凭据无法解密，请检查 KEK 版本或密文完整性",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        ) from None
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return ModelCredentialResolveResponse(
        api_key=provider_config.api_key,
        key_hint=str(current.account.api_key_hint or ""),
        version=int(current.account.api_key_encryption_version),
        base_url=provider_config.base_url,
        model=provider_config.model,
    )


@router.post(
    "/auth/password",
    response_model=AuthenticatedAccountResponse,
    response_model_exclude_none=True,
)
async def change_password(
    data: PasswordChangeRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    try:
        verification = await verify_password_async(
            data.current_password,
            current.account.password_hash,
        )
        if not verification.valid:
            raise HTTPException(401, "当前密码错误")
        replacement_hash = await hash_password_async(data.new_password)
    except PasswordKDFBusy:
        _raise_kdf_busy()

    now = datetime.utcnow()
    current.account.password_hash = replacement_hash
    current.account.password_version = max(
        1, int(current.account.password_version or 0),
    ) + 1
    current.account.auth_epoch = int(current.account.auth_epoch or 0) + 1
    current.account.must_change_password = False
    current.account.password_changed_at = now
    await db.execute(update(AuthSession).where(
        AuthSession.user_id == current.account.id,
        AuthSession.revoked_at.is_(None),
    ).values(
        revoked_at=now,
        revoked_reason="password_changed",
    ))
    token = await create_auth_session(db, current.account)
    await db.commit()
    set_auth_cookie(response, token)
    desktop_auth_token = token if valid_desktop_request(request) else None
    desktop_pet_capability_token = (
        await issue_desktop_pet_capability(db, current=current, auth_token=token)
        if desktop_auth_token else None
    )
    if desktop_pet_capability_token:
        await db.commit()
    return _account_view(
        current,
        desktop_auth_token,
        desktop_pet_capability_token,
    )


@router.post("/auth/logout", response_model=LogoutResponse)
async def logout(
    response: Response,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    if current.session_id is not None:
        session = await db.get(AuthSession, current.session_id)
        if session is not None and session.revoked_at is None:
            session.revoked_at = datetime.utcnow()
            session.revoked_reason = "logout"
            await db.commit()
    clear_auth_cookie(response)
    return {"status": "ok"}


@router.get(
    "/auth/me",
    response_model=AuthenticatedAccountResponse,
    response_model_exclude_none=True,
)
async def me(current: CurrentLearner = Depends(get_current_learner)):
    return _account_view(current)


@router.get("/auth/status")
async def auth_status(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Probe the current session without turning an expected signed-out state into a 401."""
    current = await current_learner_from_request(request, db, required=False)
    if current is None:
        return {"authenticated": False}
    desktop_auth_token = None
    desktop_pet_capability_token = None
    if valid_desktop_request(request):
        desktop_auth_token = await create_auth_session(
            db,
            current.account,
            is_dev_login=current.is_dev_login,
        )
        desktop_pet_capability_token = await issue_desktop_pet_capability(
            db, current=current, auth_token=desktop_auth_token,
        )
        await db.commit()
    return {
        "authenticated": True,
        **_account_view(current, desktop_auth_token, desktop_pet_capability_token),
    }


@router.post(
    "/auth/desktop-pet-capability",
    response_model=DesktopPetCapabilityRefreshResponse,
)
async def refresh_desktop_pet_capability(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    """Refresh the pet credential from the parent desktop bearer only."""
    if (
        not valid_desktop_request(request)
        or current.auth_method != "desktop_bearer"
        or current.session_id is None
    ):
        raise HTTPException(403, "只有 LearnFlow 主窗口可以续期桌宠身份")
    capability = await issue_desktop_pet_capability(
        db,
        current=current,
        auth_session_id=current.session_id,
    )
    await db.commit()
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return {"desktop_pet_capability_token": capability}


@router.get("/admin/accounts", response_model=list[AdminAccountProjection])
async def admin_accounts(
    db: AsyncSession = Depends(get_db),
    _admin: CurrentLearner = Depends(require_admin),
):
    credential_configured = case((and_(
        UserAccount.api_key_ciphertext.is_not(None),
        UserAccount.api_key_nonce.is_not(None),
        UserAccount.api_key_hint.is_not(None),
        UserAccount.api_key_encryption_version.is_not(None),
    ), True), else_=False).label("api_key_configured")
    rows = (await db.execute(
        select(
            UserAccount.account_number,
            UserAccount.username,
            func.coalesce(Learner.display_name, UserAccount.username).label("display_name"),
            UserAccount.role,
            UserAccount.status,
            UserAccount.created_at,
            UserAccount.updated_at,
            UserAccount.last_login_at,
            credential_configured,
            func.count(Project.id).label("project_count"),
        )
        .outerjoin(Learner, Learner.user_id == UserAccount.id)
        .outerjoin(Project, and_(
            Project.learner_id == Learner.id,
            Project.visibility != "deleted",
        ))
        .group_by(
            UserAccount.account_number,
            UserAccount.username,
            Learner.display_name,
            UserAccount.role,
            UserAccount.status,
            UserAccount.created_at,
            UserAccount.updated_at,
            UserAccount.last_login_at,
            UserAccount.api_key_ciphertext,
            UserAccount.api_key_nonce,
            UserAccount.api_key_hint,
            UserAccount.api_key_encryption_version,
        )
        .order_by(UserAccount.account_number.asc())
    )).all()
    return [AdminAccountProjection(
        account_number=row.account_number,
        username=row.username,
        display_name=row.display_name,
        role=row.role,
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        last_login_at=row.last_login_at,
        project_count=int(row.project_count or 0),
        api_key_configured=bool(row.api_key_configured),
    ) for row in rows]


@router.get("/demo/status")
async def competition_demo_status():
    return {"enabled": settings.competition_demo_mode, "offline": True}


@router.post("/demo/login")
async def competition_demo_login(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if not settings.competition_demo_mode or not is_loopback_request(request):
        raise HTTPException(404, "Not found")
    account = (await db.execute(select(UserAccount).where(
        UserAccount.username_normalized == DEMO_USERNAME,
        UserAccount.status == "active",
    ))).scalar_one_or_none()
    if not account:
        raise HTTPException(503, "演示数据尚未初始化，请重新运行 bash start.sh demo")
    learner = (await db.execute(select(Learner).where(
        Learner.user_id == account.id,
    ))).scalar_one()
    profile = await db.get(LearnerProfile, learner.id)
    token = await create_auth_session(db, account, is_dev_login=True)
    await db.commit()
    set_auth_cookie(response, token)
    current = CurrentLearner(account, learner, profile, is_dev_login=True)
    desktop_auth_token = token if valid_desktop_request(request) else None
    desktop_pet_capability_token = (
        await issue_desktop_pet_capability(db, current=current, auth_token=token)
        if desktop_auth_token else None
    )
    if desktop_pet_capability_token:
        await db.commit()
    return _account_view(
        current,
        desktop_auth_token,
        desktop_pet_capability_token,
    )


@router.get("/demo/manifest")
async def competition_demo_manifest(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    if not settings.competition_demo_mode:
        raise HTTPException(404, "Not found")
    manifest = await demo_manifest(db, current.learner.id)
    if not manifest:
        raise HTTPException(503, "演示数据尚未初始化")
    return manifest


def _require_dev(request: Request) -> None:
    if not (
        (settings.dev_test_login_enabled or settings.competition_demo_mode)
        and is_loopback_request(request)
    ):
        raise HTTPException(404, "Not found")


@dev_router.get("/accounts")
async def list_dev_accounts(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    _require_dev(request)
    rows = (await db.execute(
        select(UserAccount, Learner, func.count(Project.id))
        .join(Learner, Learner.user_id == UserAccount.id)
        .outerjoin(Project, and_(
            Project.learner_id == Learner.id,
            Project.visibility == "visible",
        ))
        .group_by(UserAccount.id, Learner.id)
        .order_by(UserAccount.account_number.asc())
    )).all()
    return [{
        "id": account.id,
        "account_number": account.account_number,
        "username": account.username,
        "display_name": learner.display_name,
        "role": account.role,
        "created_at": account.created_at.isoformat() if account.created_at else None,
        "last_login_at": account.last_login_at.isoformat() if account.last_login_at else None,
        "project_count": project_count or 0,
        "is_legacy_demo": bool(account.is_legacy_demo),
    } for account, learner, project_count in rows]


@dev_router.post("/accounts/{account_id}/login")
async def dev_login(
    account_id: int,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    _require_dev(request)
    account = await db.get(UserAccount, account_id)
    if not account or account.status != "active":
        raise HTTPException(404, "Account not found")
    learner = (await db.execute(select(Learner).where(
        Learner.user_id == account.id,
    ))).scalar_one_or_none()
    profile = await db.get(LearnerProfile, learner.id) if learner else None
    if not learner or not profile:
        raise HTTPException(404, "Account not found")
    token = await create_auth_session(db, account, is_dev_login=True)
    await db.commit()
    set_auth_cookie(response, token)
    current = CurrentLearner(account, learner, profile, is_dev_login=True)
    desktop_auth_token = token if valid_desktop_request(request) else None
    desktop_pet_capability_token = (
        await issue_desktop_pet_capability(db, current=current, auth_token=token)
        if desktop_auth_token else None
    )
    if desktop_pet_capability_token:
        await db.commit()
    return _account_view(
        current,
        desktop_auth_token,
        desktop_pet_capability_token,
    )
