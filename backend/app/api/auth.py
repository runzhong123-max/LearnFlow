import ipaddress
import hmac
import time
from uuid import uuid4
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import and_, case, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import (
    normalize_openai_base_url,
    openai_chat_provider_kwargs,
    settings,
)
from app.db.database import get_db
from app.models.learning import AuthApiKey, AuthApiKeySecret, AuthSession, Learner, LearnerProfile, UserAccount
from app.models.project import Project
from app.schemas.auth import (
    AdminAccountProjection,
    ApiKeyCreateRequest,
    ApiKeyRevealRequest,
    ApiKeyCreateResponse,
    ApiKeyListResponse,
    AuthenticatedAccountResponse,
    CsrfTokenResponse,
    LoginRequest,
    LogoutResponse,
    ModelCredentialMetadata,
    ModelCredentialResolveResponse,
    ModelCredentialTestRequest,
    ModelCredentialTestResponse,
    ModelCredentialUpdateRequest,
    PasswordChangeRequest,
    RegisterRequest,
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
    decrypt_model_credential,
    encrypt_model_credential,
    get_current_learner,
    hash_password_async,
    is_loopback_request,
    login_backoff_seconds,
    login_request_keys,
    model_credential_configured,
    normalize_username,
    record_login_failure,
    require_admin,
    require_runtime_bridge_request,
    set_auth_cookie,
    valid_desktop_request,
    verify_password_async,
)
from app.services.demo_seed import DEMO_USERNAME, demo_manifest
from app.services.learning_runtime import ensure_kernel_states, record_event
from app.services.profile import award_career_goal


class _AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request: Request):
            is_key_management = request.url.path.startswith("/api/auth/api-keys")
            try:
                response = await handler(request)
            except RequestValidationError:
                if not is_key_management:
                    raise
                # FastAPI's default validation detail echoes rejected input (including passwords).
                response = JSONResponse(status_code=422, content={"detail": "密钥参数无效，请检查名称、密码和有效期"})
            except HTTPException as error:
                if is_key_management:
                    error.headers = {**(error.headers or {}), "Cache-Control": "no-store"}
                raise
            if is_key_management:
                response.headers["Cache-Control"] = "no-store"
                response.headers["Pragma"] = "no-cache"
            return response
        return protected


router = APIRouter(tags=["Authentication"], route_class=_AuthRoute)
dev_router = APIRouter(prefix="/dev", tags=["Development"])


async def _cookie_account(current: CurrentLearner = Depends(get_current_learner)):
    if current.auth_method != "cookie":
        raise HTTPException(403, "API key 管理需要使用网页登录账号")
    return current


async def _verify_key_management_password(request: Request, current: CurrentLearner, db: AsyncSession, password: str):
    account_key, ip_key = login_request_keys(request, current.account.username_normalized)
    delay = await login_backoff_seconds(db, account_key, ip_key)
    if delay:
        _raise_login_backoff(delay)
    try:
        verification = await verify_password_async(password, current.account.password_hash)
    except PasswordKDFBusy:
        _raise_kdf_busy()
    if not verification.valid:
        delay = await record_login_failure(db, account_key, ip_key)
        await db.commit()
        if delay:
            _raise_login_backoff(delay)
        # A failed step-up must not log an otherwise authenticated browser out.
        raise HTTPException(403, "密码不正确，请重试")
    await clear_login_failures(db, account_key)


@router.post("/auth/api-keys", response_model=ApiKeyCreateResponse, status_code=201)
async def create_api_key(
    data: ApiKeyCreateRequest, request: Request, response: Response,
    current: CurrentLearner = Depends(_cookie_account), db: AsyncSession = Depends(get_db),
):
    from app.services.api_keys import issue_api_key, metadata
    await _verify_key_management_password(request, current, db, data.password)
    token, key = await issue_api_key(db, current.account, data.name, data.expires_in_days)
    await db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"api_key": token, "metadata": metadata(key, copy_available=True)}


@router.post("/auth/api-keys/{key_id}/reveal", response_model=ApiKeyCreateResponse)
async def reveal_api_key(
    key_id: int, data: ApiKeyRevealRequest, request: Request, response: Response,
    current: CurrentLearner = Depends(_cookie_account), db: AsyncSession = Depends(get_db),
):
    from app.services.api_keys import reveal_api_key as reveal_owned_key, metadata
    await _verify_key_management_password(request, current, db, data.password)
    token, key = await reveal_owned_key(db, current.account, key_id)
    await db.commit()
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return {"api_key": token, "metadata": metadata(key, copy_available=True)}


@router.get("/auth/api-keys", response_model=ApiKeyListResponse)
async def list_api_keys(
    response: Response, current: CurrentLearner = Depends(_cookie_account),
    db: AsyncSession = Depends(get_db),
):
    from app.services.api_keys import metadata
    keys = (await db.execute(select(AuthApiKey).where(
        AuthApiKey.user_id == current.account.id,
    ).order_by(AuthApiKey.created_at.desc(), AuthApiKey.id.desc()))).scalars().all()
    response.headers["Cache-Control"] = "no-store"
    recoverable = set((await db.execute(select(AuthApiKeySecret.key_id).join(
        AuthApiKey, AuthApiKey.id == AuthApiKeySecret.key_id,
    ).where(AuthApiKey.user_id == current.account.id))).scalars().all())
    now = datetime.utcnow()
    return {"api_keys": [metadata(key, copy_available=key.id in recoverable and not key.revoked_at
        and key.expires_at > now and key.auth_epoch == current.account.auth_epoch) for key in keys]}


@router.delete("/auth/api-keys/{key_id}")
async def revoke_api_key(
    key_id: int, response: Response, current: CurrentLearner = Depends(_cookie_account),
    db: AsyncSession = Depends(get_db),
):
    from app.services.api_keys import revoke_api_key as revoke_owned_key
    key = await revoke_owned_key(db, current.account.id, key_id)
    await db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"status": "revoked", "api_key_id": key.id}


@router.get("/auth/api-key/verify", status_code=204)
async def verify_api_key(current: CurrentLearner = Depends(get_current_learner)):
    if current.auth_method != "api_key":
        raise HTTPException(401, "此入口必须使用 API key")
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


def _account_view(current: CurrentLearner, desktop_auth_token: str | None = None) -> dict:
    credit_limit = int(current.account.credit_limit if current.account.credit_limit is not None else -1)
    credit_used = max(0, int(current.account.credit_used or 0))
    unlimited = credit_limit < 0
    result = {
        "id": current.account.id,
        "account_number": current.account.account_number,
        "username": current.account.username,
        "display_name": current.learner.display_name,
        "learner_id": current.learner.id,
        "role": "user" if current.auth_method == "api_key" else current.account.role,
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
        "quota": {
            "unit": "credits",
            "unlimited": unlimited,
            "limit": None if unlimited else credit_limit,
            "used": credit_used,
            "remaining": None if unlimited else max(0, credit_limit - credit_used),
        },
    }
    if desktop_auth_token:
        result["desktop_auth_token"] = desktop_auth_token
    return result


def _model_credential_view(account: UserAccount) -> ModelCredentialMetadata:
    configured = model_credential_configured(account)
    return ModelCredentialMetadata(
        configured=configured,
        key_hint=str(account.api_key_hint or "") if configured else "",
        updated_at=account.api_key_updated_at,
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
    expected_invite = str(settings.registration_invite_code or "").strip()
    supplied_invite = str(data.invite_code or "").strip()
    if expected_invite and not hmac.compare_digest(supplied_invite, expected_invite):
        raise HTTPException(403, "邀请码无效")
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
        "credit_limit": int(settings.default_account_credit_limit),
        "credit_used": 0,
    }
    if normalized == "ryan":
        account_kwargs.update(account_number=0, role="admin")
    account = UserAccount(**account_kwargs)
    db.add(account)
    try:
        await db.flush()
        learner = Learner(
            user_id=account.id,
            key=f"user-{account.id}-{uuid4().hex}",
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
            client_event_id=f"registration-profile:{account.id}",
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
    return _account_view(
        CurrentLearner(account, learner, profile),
        token if valid_desktop_request(request) else None,
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
    return _account_view(
        CurrentLearner(account, learner, profile),
        token if valid_desktop_request(request) else None,
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
    return ModelCredentialMetadata(configured=bool(settings.llm_api_key.strip()))


@router.put("/auth/model-credential", response_model=ModelCredentialMetadata)
async def put_model_credential(
    data: ModelCredentialUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    raise HTTPException(403, "模型与 API Key 由后台统一管理")


@router.delete("/auth/model-credential", response_model=ModelCredentialMetadata)
async def delete_model_credential(
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    raise HTTPException(403, "模型与 API Key 由后台统一管理")


@router.post(
    "/auth/model-credential/test",
    response_model=ModelCredentialTestResponse,
)
async def test_model_credential(
    data: ModelCredentialTestRequest,
    current: CurrentLearner = Depends(get_current_learner),
):
    raise HTTPException(403, "模型连接测试仅由后台运维执行")


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
    api_key = str(settings.llm_api_key or "").strip()
    if not api_key or api_key in {"***", "sk-your-key-here"}:
        raise HTTPException(
            503,
            "后台模型服务尚未配置",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return ModelCredentialResolveResponse(
        api_key=api_key,
        key_hint="server-managed",
        version=1,
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
    await db.execute(update(AuthApiKey).where(
        AuthApiKey.user_id == current.account.id,
        AuthApiKey.revoked_at.is_(None),
    ).values(revoked_at=now, revoked_reason="password_changed"))
    await db.execute(delete(AuthApiKeySecret).where(AuthApiKeySecret.key_id.in_(
        select(AuthApiKey.id).where(AuthApiKey.user_id == current.account.id),
    )))
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
    return _account_view(
        current,
        token if valid_desktop_request(request) else None,
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
    return {"authenticated": True, **_account_view(current)}


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
    return _account_view(
        CurrentLearner(account, learner, profile, is_dev_login=True),
        token if valid_desktop_request(request) else None,
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
    return _account_view(
        CurrentLearner(account, learner, profile, is_dev_login=True),
        token if valid_desktop_request(request) else None,
    )
