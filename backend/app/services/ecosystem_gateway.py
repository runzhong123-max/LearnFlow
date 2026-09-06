"""Fixed-destination service gateway; browser credentials never leave LearnFlow."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import hmac
import json
import time
from urllib.parse import urlsplit
import httpx
from app.core.config import settings
from app.services.auth import CurrentLearner

PROTOCOL = "learnflow-ecosystem/v1"
PUBLIC_OPERATIONS = frozenset({"catalog.search", "package.resolve", "role.query", "agent.run", "agent.get_run"})
INTERNAL_OPERATIONS = frozenset({"learning.resolve", "learning.validate_extension", "learning.validate_alignment"})
MAX_BYTES = 4 * 1024 * 1024


class GatewayError(Exception):
    def __init__(self, code: str, message: str, status: int = 502, retryable: bool = False):
        self.code, self.message, self.status, self.retryable = code, message, status, retryable
        super().__init__(message)


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()


def subject_for(current: CurrentLearner) -> str:
    return f"learnflow:learner:{current.learner.id}"


def gateway_url() -> str:
    base = settings.role_atlas_gateway_base_url.strip().rstrip("/")
    secret = settings.role_atlas_gateway_secret
    if settings.desktop_mode or not base or len(secret.encode()) < 32:
        raise GatewayError("gateway_unavailable", "岗位服务未配置中央网关；桌面端请连接已认证的 LearnFlow 服务。", 503, False)
    try:
        parsed = urlsplit(base)
        _ = parsed.port
    except ValueError:
        raise GatewayError("gateway_unavailable", "岗位网关地址配置无效。", 503)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise GatewayError("gateway_unavailable", "岗位网关必须使用 HTTPS 源站或明确的本机 HTTP 地址。", 503)
    return base + "/api/integrations/learnflow/gateway"


def delegation_token(current: CurrentLearner, request_id: str, body: bytes, *, now: int | None = None) -> str:
    issued = int(time.time()) if now is None else now
    claims = {"v": 1, "iss": "learnflow", "aud": "role-atlas", "sub": subject_for(current),
              "role": "admin" if current.account.role == "admin" else "user", "iat": issued, "exp": issued + 60,
              "requestId": request_id, "bodyHash": hashlib.sha256(body).hexdigest()}
    encoded = base64.urlsafe_b64encode(canonical_bytes(claims)).rstrip(b"=")
    signature = hmac.new(settings.role_atlas_gateway_secret.encode(), encoded, hashlib.sha256).hexdigest()
    return encoded.decode() + "." + signature


async def dispatch(current: CurrentLearner, operation: str, request_id: str, payload: dict) -> dict:
    if operation not in PUBLIC_OPERATIONS | INTERNAL_OPERATIONS:
        raise GatewayError("unsupported_operation", "该网关操作未登记。", 400)
    url = gateway_url()
    body = canonical_bytes({"protocol": PROTOCOL, "operation": operation, "requestId": request_id, "payload": payload})
    if len(body) > MAX_BYTES:
        raise GatewayError("request_too_large", "岗位请求超过大小限制。", 413)
    timeout = min(45.0, max(1.0, settings.role_atlas_gateway_timeout_seconds))
    try:
        async with asyncio.timeout(timeout):
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", url, content=body, headers={
                    "Content-Type": "application/json", "Accept": "application/json",
                    "X-LearnFlow-Delegation": delegation_token(current, request_id, body),
                }) as response:
                    if 300 <= response.status_code < 400:
                        raise GatewayError("upstream_redirect", "岗位服务返回了不允许的重定向。")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_BYTES:
                            raise GatewayError("upstream_too_large", "岗位服务响应超过大小限制。")
                    status = response.status_code
    except (httpx.TimeoutException, TimeoutError):
        raise GatewayError("upstream_timeout", "岗位服务请求超时。", 504, True)
    except httpx.HTTPError:
        raise GatewayError("upstream_unavailable", "暂时无法连接岗位服务。", 503, True)
    try:
        envelope = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        raise GatewayError("invalid_upstream_response", "岗位服务返回无效 JSON。")
    if not isinstance(envelope, dict) or envelope.get("protocol") != PROTOCOL or envelope.get("requestId") != request_id or type(envelope.get("ok")) is not bool:
        raise GatewayError("invalid_upstream_response", "岗位服务响应身份或协议不匹配。")
    if not envelope["ok"] or status >= 400:
        # Do not expose remote errors, private package identifiers, or diagnostics.
        if status in {401, 403, 404}:
            raise GatewayError("package_unavailable", "岗位资源不可用或当前主体无权访问。", 404)
        if status == 409:
            raise GatewayError("upstream_conflict", "岗位资源版本冲突，请重新获取。", 409)
        if status in {400, 422}:
            raise GatewayError("invalid_operation", "岗位服务拒绝了不符合契约的请求。", 422)
        raise GatewayError("upstream_unavailable", "岗位服务暂时未完成请求。", 503, True)
    if "data" not in envelope:
        raise GatewayError("invalid_upstream_response", "岗位服务缺少结果数据。")
    return envelope["data"]
