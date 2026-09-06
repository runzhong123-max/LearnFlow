"""Xingchen-backed, uncommitted learning-task candidate artifacts.

The integration is deliberately narrower than a LearnFlow Agent.  It pins
learner-owned SourceVersion rows, sends bounded source segments to one fixed
workflow, validates the returned delivery bundle deterministically and stores
only a reviewable candidate artifact.  It never emits learning evidence or
writes project, path, mastery, memory, or five-kernel state.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import ssl
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit

from dotenv import dotenv_values
import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.project import (
    Chunk, LearningTaskCandidateArtifact, Project, Source, SourceVersion,
)


CANDIDATE_SCHEMA_VERSION = "role-learning-task-candidate.v1"
PROVIDER_REQUEST_SCHEMA_VERSION = "lf.xingchen-ltc.v1"
INTEGRATION_BUNDLE_SCHEMA_VERSION = "learning-task-conversion-integration-bundle-v1"
PERSONALIZED_HANDOFF_SCHEMA_VERSION = "learning-task-to-personalized-learning-v1"
VALIDATOR_VERSION = "learning-task-candidate-validator.v1.1"
MAX_PROVIDER_INPUT_CHARS = 500
MAX_SEGMENT_CHARS = 1_200
MAX_SOURCE_CHARS = 10_000
MAX_PROVIDER_SOURCE_TEXT_CHARS = 48
MAX_PROVIDER_RESPONSE_BYTES = 2_000_000
MAX_BUNDLE_RESPONSE_BYTES = 4_000_000
MAX_STEPS = 12
MIN_STEPS = 3


class LearningTaskIntegrationError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 502,
        retryable: bool = False,
        who_fixes: str = "operator",
        stage: str | None = None,
        suggested_action: str = "检查集成配置后重试",
        diagnostics: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable
        self.who_fixes = who_fixes
        self.stage = stage or _error_stage(code)
        self.suggested_action = suggested_action
        self.diagnostics = dict(diagnostics or {})

    def payload(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": str(self),
                "stage": self.stage,
                "retryable": self.retryable,
                "whoFixes": self.who_fixes,
                "suggestedAction": self.suggested_action,
                "diagnostics": self.diagnostics,
            }
        }


def _error_stage(code: str) -> str:
    if code == "idempotency_conflict":
        return "commit"
    if code.startswith("bundle_"):
        return "bundle"
    if code.startswith("provider_") or code.startswith("workflow_") or code == "integration_config_invalid":
        return "provider"
    if code.startswith("source_") or code == "candidate_not_found":
        return "request"
    return "validation"


@dataclass(frozen=True)
class XingchenCredentials:
    app_id: str
    api_key: str
    api_secret: str
    flow_id: str
    base_url: str = "https://xingchen-api.xf-yun.com"
    timeout_seconds: float = 120.0


@dataclass(frozen=True)
class SourceSnapshot:
    package_id: str
    package_version: str
    snapshot_id: str
    root_hash: str
    bindings: list[dict[str, Any]]
    citations: list[dict[str, Any]]
    segments: list[dict[str, Any]]
    coverage: dict[str, Any]
    warnings: list[dict[str, Any]]


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _compact(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _text_list(value: Any, *, limit: int = 12, item_limit: int = 800) -> list[str]:
    output: list[str] = []
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, Mapping):
        values = [value]
    else:
        values = list(value or [])
    for item in values:
        if isinstance(item, Mapping):
            text = next((
                _compact(item.get(key), item_limit)
                for key in ("criterion", "check", "description", "name", "title", "value")
                if _compact(item.get(key), item_limit)
            ), "")
        else:
            text = _compact(item, item_limit)
        if text and text not in output:
            output.append(text)
        if len(output) >= limit:
            break
    return output


def _credentials_path() -> Path:
    configured = str(settings.learning_task_xfyun_credentials_path or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[2] / ".private" / "learning_task_conversion.xfyun.env"


def _validated_https_dns_url(value: str, *, label: str) -> str:
    normalized = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(normalized)
        host = parsed.hostname or ""
    except ValueError as exc:
        raise LearningTaskIntegrationError(
            "integration_config_invalid", f"{label} 不是有效 URL", status_code=503,
            suggested_action="改为 HTTPS 域名后重启服务",
        ) from exc
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise LearningTaskIntegrationError(
            "integration_config_invalid", f"{label} 必须使用不含凭据的 HTTPS 域名", status_code=503,
            suggested_action="配置受信任的 HTTPS 域名",
        )
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise LearningTaskIntegrationError(
            "integration_config_invalid", f"{label} 不接受裸 IP", status_code=503,
            suggested_action="为服务配置 HTTPS DNS 域名",
        )
    return normalized


def load_xingchen_credentials(path: str | Path | None = None) -> XingchenCredentials:
    source = Path(path).expanduser() if path else _credentials_path()
    if not source.is_file():
        raise LearningTaskIntegrationError(
            "provider_not_configured", "讯飞学习型任务工作流尚未配置", status_code=503,
            who_fixes="operator", suggested_action="在后端私密配置文件中配置并发布固定工作流",
        )
    values = dotenv_values(source)
    names = ("XFYUN_APP_ID", "XFYUN_API_KEY", "XFYUN_API_SECRET", "XFYUN_FLOW_ID")
    missing = [name for name in names if not str(values.get(name) or "").strip()]
    if missing:
        raise LearningTaskIntegrationError(
            "provider_not_configured", "讯飞工作流私密配置不完整", status_code=503,
            diagnostics={"missing": missing},
            suggested_action="补齐缺少的服务端配置项",
        )
    try:
        timeout = float(values.get("XFYUN_WORKFLOW_TIMEOUT_SECONDS") or 120.0)
    except (TypeError, ValueError) as exc:
        raise LearningTaskIntegrationError(
            "integration_config_invalid", "讯飞工作流超时配置不是数字", status_code=503,
        ) from exc
    return XingchenCredentials(
        app_id=str(values["XFYUN_APP_ID"]).strip(),
        api_key=str(values["XFYUN_API_KEY"]).strip(),
        api_secret=str(values["XFYUN_API_SECRET"]).strip(),
        flow_id=str(values["XFYUN_FLOW_ID"]).strip(),
        base_url=_validated_https_dns_url(
            str(values.get("XFYUN_WORKFLOW_BASE_URL") or "https://xingchen-api.xf-yun.com"),
            label="讯飞工作流地址",
        ),
        timeout_seconds=max(5.0, min(timeout, 300.0)),
    )


def load_bundle_service_token(path: str | Path | None = None) -> str:
    configured = str(settings.learning_task_bundle_credentials_path or "").strip()
    source = Path(path).expanduser() if path else (
        Path(configured).expanduser() if configured else _credentials_path()
    )
    if not source.is_file():
        raise LearningTaskIntegrationError(
            "bundle_service_not_configured", "讯飞任务包服务认证尚未配置", status_code=503,
            who_fixes="operator", suggested_action="在后端私密配置中设置任务包服务 token",
        )
    token = str(dotenv_values(source).get("LEARNING_TASK_BUNDLE_SERVICE_TOKEN") or "").strip()
    if not token:
        raise LearningTaskIntegrationError(
            "bundle_service_not_configured", "讯飞任务包服务认证 token 缺失", status_code=503,
            who_fixes="operator", suggested_action="设置 LEARNING_TASK_BUNDLE_SERVICE_TOKEN",
        )
    return token


def _upstream_error(response: httpx.Response, *, service: str) -> LearningTaskIntegrationError:
    status = response.status_code
    body = _compact(response.text, 800)
    diagnostics = {"upstreamStatus": status, "service": service, "bodyPreview": body}
    if status == 429:
        return LearningTaskIntegrationError(
            "provider_rate_limited", f"{service}当前限流", status_code=429,
            retryable=True, who_fixes="provider", suggested_action="稍后使用相同 requestId 重试",
            diagnostics=diagnostics,
        )
    if status in {401, 403}:
        return LearningTaskIntegrationError(
            "provider_authorization_failed", f"{service}拒绝了服务端凭据或工作流权限", status_code=503,
            retryable=False, who_fixes="operator", suggested_action="检查同一 App 下的工作流与模型授权",
            diagnostics=diagnostics,
        )
    if status in {502, 503, 504}:
        return LearningTaskIntegrationError(
            "provider_unavailable", f"{service}暂时不可用", status_code=status,
            retryable=True, who_fixes="provider", suggested_action="稍后使用相同 requestId 重试",
            diagnostics=diagnostics,
        )
    return LearningTaskIntegrationError(
        "provider_contract_rejected", f"{service}未接受当前请求", status_code=502,
        retryable=False, who_fixes="operator", suggested_action="检查线上工作流输入/输出合同",
        diagnostics=diagnostics,
    )


class XingchenWorkflowClient:
    """Call exactly one operator-configured Xingchen workflow."""

    def __init__(
        self,
        *,
        credentials: XingchenCredentials | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.credentials = credentials or load_xingchen_credentials()
        self.transport = transport

    async def run(self, provider_input: Mapping[str, Any], *, uid: str) -> dict[str, Any]:
        serialized = json.dumps(provider_input, ensure_ascii=False, separators=(",", ":"))
        if len(serialized) > MAX_PROVIDER_INPUT_CHARS:
            raise LearningTaskIntegrationError(
                "provider_input_too_large", "发送给讯飞的有界上下文仍超过限制", status_code=422,
                who_fixes="learnflow", suggested_action="减少来源片段或任务描述长度",
                diagnostics={"characters": len(serialized), "limit": MAX_PROVIDER_INPUT_CHARS},
            )
        payload = {
            "flow_id": self.credentials.flow_id,
            "uid": _compact(uid, 40),
            "parameters": {"AGENT_USER_INPUT": serialized},
            "ext": {"bot_id": "workflow", "caller": "learnflow-learning-task-conversion"},
            "stream": False,
        }
        try:
            async with httpx.AsyncClient(
                base_url=self.credentials.base_url,
                timeout=self.credentials.timeout_seconds,
                follow_redirects=False,
                trust_env=False,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    "/workflow/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.credentials.api_key}:{self.credentials.api_secret}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise LearningTaskIntegrationError(
                "provider_timeout", "讯飞工作流响应超时", status_code=504,
                retryable=True, who_fixes="provider", suggested_action="稍后使用相同 requestId 重试",
            ) from exc
        except httpx.HTTPError as exc:
            raise LearningTaskIntegrationError(
                "provider_unavailable", "无法连接讯飞工作流", status_code=503,
                retryable=True, who_fixes="operator", suggested_action="检查服务端网络与讯飞域名",
            ) from exc
        if response.status_code >= 400:
            raise _upstream_error(response, service="讯飞工作流")
        if len(response.content) > MAX_PROVIDER_RESPONSE_BYTES:
            raise LearningTaskIntegrationError(
                "provider_response_too_large", "讯飞工作流响应超过大小限制", status_code=502,
                retryable=False, who_fixes="provider",
                suggested_action="缩小工作流结束节点输出并返回版本化任务包引用",
                diagnostics={"bytes": len(response.content), "limit": MAX_PROVIDER_RESPONSE_BYTES},
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise LearningTaskIntegrationError(
                "provider_response_invalid", "讯飞工作流返回了非 JSON 响应", status_code=502,
                diagnostics={"bodyPreview": _compact(response.text, 800)},
            ) from exc
        if not isinstance(data, Mapping):
            raise LearningTaskIntegrationError(
                "provider_response_invalid", "讯飞工作流响应必须是对象", status_code=502,
            )
        if data.get("code") not in {0, "0", None}:
            code = str(data.get("code") or "unknown")
            raise LearningTaskIntegrationError(
                "provider_workflow_failed", f"讯飞工作流执行失败（{code}）", status_code=502,
                retryable=code in {"11200", "20301", "20373"}, who_fixes="operator",
                suggested_action="在讯飞控制台检查工作流节点、模型授权与配额",
                diagnostics={"providerCode": code, "providerMessage": _compact(data.get("message"), 500)},
            )
        choices = data.get("choices")
        first = choices[0] if isinstance(choices, list) and choices else {}
        content = ""
        if isinstance(first, Mapping):
            delta = first.get("delta")
            message = first.get("message")
            if isinstance(delta, Mapping):
                content = str(delta.get("content") or "")
            if not content and isinstance(message, Mapping):
                content = str(message.get("content") or "")
        if not content.strip():
            raise LearningTaskIntegrationError(
                "provider_response_invalid", "讯飞工作流没有返回最终内容", status_code=502,
                diagnostics={"responseKeys": sorted(str(key) for key in data.keys())[:20]},
            )
        return {
            "runId": _compact(data.get("id"), 160),
            "content": content,
            "usage": data.get("usage") if isinstance(data.get("usage"), Mapping) else {},
            "workflowId": self.credentials.flow_id,
        }


class LearningTaskBundleGateway:
    _TRANSIENT = {404, 429, 502, 503, 504}

    def __init__(
        self,
        *,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        service_token: str | None = None,
        allow_test_url: bool = False,
        ca_file: str | Path | None = None,
    ) -> None:
        configured = str(base_url if base_url is not None else settings.learning_task_conversion_base_url)
        if allow_test_url and transport is not None:
            self.base_url = configured.rstrip("/")
        else:
            if not configured.strip():
                raise LearningTaskIntegrationError(
                    "bundle_service_not_configured", "讯飞任务包服务尚未配置", status_code=503,
                    suggested_action="配置任务包服务的 HTTPS 域名",
                )
            self.base_url = _validated_https_dns_url(configured, label="任务包服务地址")
        self.timeout_seconds = max(2.0, min(float(
            timeout_seconds if timeout_seconds is not None
            else settings.learning_task_conversion_timeout_seconds
        ), 120.0))
        self.transport = transport
        self.service_token = str(service_token or "").strip()
        configured_ca = str(
            ca_file if ca_file is not None else settings.learning_task_bundle_ca_file
        ).strip()
        self.verify: bool | ssl.SSLContext = True
        if configured_ca:
            try:
                self.verify = ssl.create_default_context(cafile=str(Path(configured_ca).expanduser()))
            except (OSError, ssl.SSLError) as exc:
                raise LearningTaskIntegrationError(
                    "integration_config_invalid", "任务包服务 CA 文件无法加载", status_code=503,
                    who_fixes="operator", suggested_action="配置可读且有效的 PEM CA 文件",
                ) from exc

    async def read(self, task_card_id: str) -> dict[str, Any]:
        service_token = self.service_token or load_bundle_service_token()
        response: httpx.Response | None = None
        try:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout_seconds,
                follow_redirects=False,
                trust_env=False,
                transport=self.transport,
                verify=self.verify,
            ) as client:
                for attempt in range(5):
                    response = await client.get(
                        f"/api/v1/learning-task-conversion/tasks/{task_card_id}/bundle",
                        headers={"Authorization": f"Bearer {service_token}"},
                    )
                    if response.status_code not in self._TRANSIENT or attempt == 4:
                        break
                    await asyncio.sleep(0.15 * (2 ** attempt))
        except httpx.TimeoutException as exc:
            raise LearningTaskIntegrationError(
                "bundle_timeout", "讯飞任务包服务响应超时", status_code=504,
                retryable=True, who_fixes="provider", suggested_action="稍后使用相同 requestId 重试",
            ) from exc
        except httpx.HTTPError as exc:
            raise LearningTaskIntegrationError(
                "bundle_service_unavailable", "无法连接讯飞任务包服务", status_code=503,
                retryable=True, who_fixes="operator", suggested_action="检查任务包服务域名与健康状态",
            ) from exc
        if response is None:
            raise LearningTaskIntegrationError("bundle_missing", "任务包服务没有响应", status_code=503)
        if response.status_code >= 400:
            raise _upstream_error(response, service="讯飞任务包服务")
        if len(response.content) > MAX_BUNDLE_RESPONSE_BYTES:
            raise LearningTaskIntegrationError(
                "bundle_response_too_large", "讯飞任务包响应超过大小限制", status_code=502,
                retryable=False, who_fixes="provider",
                suggested_action="缩小版本化任务包后重新生成",
                diagnostics={"bytes": len(response.content), "limit": MAX_BUNDLE_RESPONSE_BYTES},
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise LearningTaskIntegrationError(
                "bundle_invalid_json", "讯飞任务包服务返回了非 JSON 内容", status_code=502,
                diagnostics={"bodyPreview": _compact(response.text, 800)},
            ) from exc
        return validate_integration_bundle(payload, task_card_id)


class XingchenHandoffGateway:
    """Read the narrow handoff artifact returned by the fixed workflow.

    The deployed workflow currently returns a versioned personalized-learning
    handoff directly, while older deployments exposed a service-to-service
    bundle endpoint.  This reader is pinned to the configured artifact origin
    and exact task path, keeps TLS verification enabled and never follows a
    redirect, so model output cannot turn it into a general-purpose URL fetcher.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        timeout_seconds: float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        ca_file: str | Path | None = None,
    ) -> None:
        configured = str(base_url if base_url is not None else settings.learning_task_conversion_base_url).strip()
        try:
            parsed = urlsplit(configured.rstrip("/"))
        except ValueError as exc:
            raise LearningTaskIntegrationError(
                "integration_config_invalid", "讯飞交接产物来源不是有效 URL", status_code=503,
                suggested_action="配置工作流产物的 HTTPS 来源",
            ) from exc
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise LearningTaskIntegrationError(
                "integration_config_invalid", "讯飞交接产物来源必须使用不含凭据的 HTTPS 地址", status_code=503,
                suggested_action="配置工作流产物的 HTTPS 来源",
            )
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.timeout_seconds = max(2.0, min(float(
            timeout_seconds if timeout_seconds is not None
            else settings.learning_task_conversion_timeout_seconds
        ), 120.0))
        self.transport = transport
        configured_ca = str(ca_file if ca_file is not None else settings.learning_task_bundle_ca_file).strip()
        self.verify: bool | ssl.SSLContext = True
        if configured_ca:
            try:
                self.verify = ssl.create_default_context(cafile=str(Path(configured_ca).expanduser()))
            except (OSError, ssl.SSLError) as exc:
                raise LearningTaskIntegrationError(
                    "integration_config_invalid", "任务交接服务 CA 文件无法加载", status_code=503,
                    who_fixes="operator", suggested_action="配置可读且有效的 PEM CA 文件",
                ) from exc

    async def read(self, artifact_url: str, task_card_id: str) -> dict[str, Any]:
        safe_id = _compact(task_card_id, 160)
        expected_paths = {
            f"/api/v1/learning-task-conversion/tasks/{safe_id}/handoff.json",
            f"/api/v1/learning-task-conversion/tasks/{safe_id}/personalized-learning.json",
            f"/api/v1/wf03/learning-tasks/{safe_id}/handoff.json",
            f"/api/v1/wf03/learning-tasks/{safe_id}/personalized-learning.json",
        }
        try:
            parsed = urlsplit(str(artifact_url or "").strip())
        except ValueError as exc:
            raise LearningTaskIntegrationError(
                "bundle_handoff_url_invalid", "讯飞交接 JSON 地址无效", status_code=502,
                who_fixes="provider", suggested_action="让工作流返回固定任务卡对应的 HTTPS 交接地址",
            ) from exc
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or origin.casefold() != self.origin.casefold() or parsed.path not in expected_paths
            or parsed.query or parsed.fragment
        ):
            raise LearningTaskIntegrationError(
                "bundle_handoff_url_invalid", "讯飞交接 JSON 不属于已配置任务卡产物地址", status_code=502,
                who_fixes="provider", suggested_action="检查结束节点 handoff_url 与任务包服务来源",
                diagnostics={
                    "expectedPaths": sorted(expected_paths),
                    "actualPath": parsed.path,
                    "originMatched": origin.casefold() == self.origin.casefold(),
                },
            )
        try:
            async with httpx.AsyncClient(
                base_url=self.origin,
                timeout=self.timeout_seconds,
                follow_redirects=False,
                trust_env=False,
                transport=self.transport,
                verify=self.verify,
            ) as client:
                response = await client.get(parsed.path, headers={"Accept": "application/json"})
        except httpx.TimeoutException as exc:
            raise LearningTaskIntegrationError(
                "bundle_handoff_timeout", "讯飞交接 JSON 响应超时", status_code=504,
                retryable=True, who_fixes="provider", suggested_action="稍后使用相同 requestId 重试",
            ) from exc
        except httpx.HTTPError as exc:
            raise LearningTaskIntegrationError(
                "bundle_handoff_unavailable", "无法读取讯飞交接 JSON", status_code=503,
                retryable=True, who_fixes="operator", suggested_action="检查工作流产物服务和 HTTPS 证书",
            ) from exc
        if response.status_code >= 400:
            raise _upstream_error(response, service="讯飞交接产物服务")
        if len(response.content) > MAX_BUNDLE_RESPONSE_BYTES:
            raise LearningTaskIntegrationError(
                "bundle_response_too_large", "讯飞交接 JSON 超过大小限制", status_code=502,
                who_fixes="provider", suggested_action="缩小交接 JSON 后重新生成",
                diagnostics={"bytes": len(response.content), "limit": MAX_BUNDLE_RESPONSE_BYTES},
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise LearningTaskIntegrationError(
                "bundle_invalid_json", "讯飞交接产物不是 JSON", status_code=502,
                who_fixes="provider", suggested_action="修复工作流交接产物格式",
            ) from exc
        return handoff_to_integration_bundle(payload, safe_id)


def _json_objects(text: str) -> Iterable[dict[str, Any]]:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", str(text or "")):
        try:
            value, _ = decoder.raw_decode(text[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def task_card_id_from_content(content: str) -> str:
    for pattern in (
        r"/learning-task-conversion/tasks/(ltc_[A-Za-z0-9_-]{1,96})/",
        r"/learning-tasks/(ltc_[A-Za-z0-9_-]{1,96})/",
        r"/tasks/(ltc_[A-Za-z0-9_-]{1,96})(?:/|\b)",
        r'"task_card_id"\s*:\s*"(ltc_[A-Za-z0-9_-]{1,96})"',
    ):
        match = re.search(pattern, str(content or ""))
        if match:
            return match.group(1)
    return ""


def _safe_workflow_artifact_url(value: Any) -> str:
    """Keep a usable artifact reference without persisting query credentials."""
    text = _compact(value, 2_000)
    if not text:
        return ""
    parsed = urlsplit(text)
    if parsed.scheme in {"http", "https"} and parsed.hostname:
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    if text.startswith("/"):
        return text.split("?", 1)[0].split("#", 1)[0]
    return ""


def workflow_end_output(content: str) -> dict[str, str]:
    """Parse the exported Xingchen end-node contract from JSON or Markdown."""
    aliases = {
        "interactive_url": ("interactive_url", "交互式任务页"),
        "pdf_url": ("pdf_url", "实训工单 PDF"),
        "handoff_url": ("handoff_url", "个性化学习交接 JSON"),
        "feedback_url": ("feedback_url", "关系校验反馈 JSON"),
        "failure_report": ("failure_report", "失败报告"),
    }
    output: dict[str, str] = {}
    for value in _json_objects(content):
        for key in aliases:
            if key in value and _compact(value.get(key), 2_000):
                output[key] = _compact(value.get(key), 2_000)
    for line in str(content or "").splitlines():
        normalized = line.strip().lstrip("#*- ").strip()
        for key, labels in aliases.items():
            for label in labels:
                match = re.match(rf"^{re.escape(label)}\s*[：:]\s*(.+)$", normalized, re.IGNORECASE)
                if match and _compact(match.group(1), 2_000):
                    output[key] = _compact(match.group(1), 2_000)
                    break
    for key in ("interactive_url", "pdf_url", "handoff_url", "feedback_url"):
        if key in output:
            output[key] = _safe_workflow_artifact_url(output[key])
            if not output[key]:
                output.pop(key, None)
    return output


def _meaningful_failure_report(value: Any) -> str:
    text = _compact(value, 2_000)
    return "" if text.casefold() in {"", "[]", "{}", "null", "none", "无"} else text


def _workflow_output_error(content: str, output: Mapping[str, Any]) -> LearningTaskIntegrationError:
    failure_report = _meaningful_failure_report(output.get("failure_report"))
    diagnostic_text = " ".join(filter(None, (failure_report, _compact(content, 2_000))))
    insufficient_markers = (
        "无法从这句话确定", "无法确定你要转换", "输入不足", "信息不足",
        "请补充其中一种", "请补充岗位", "请补充技术方向", "请补充具体",
    )
    diagnostics = {
        "outputFields": sorted(str(key) for key in output),
        "failureReport": failure_report,
        "providerDiagnostics": provider_diagnostics(content),
    }
    if any(marker in diagnostic_text for marker in insufficient_markers):
        return LearningTaskIntegrationError(
            "workflow_input_insufficient", "讯飞工作流需要更具体的岗位或真实工作任务", status_code=422,
            retryable=False, who_fixes="user", suggested_action=failure_report or "补充岗位、技术方向或可验收的真实工作任务",
            diagnostics=diagnostics,
        )
    if failure_report:
        return LearningTaskIntegrationError(
            "workflow_review_failed", "讯飞工作流候选未通过独立评审", status_code=422,
            retryable=True, who_fixes="provider", suggested_action="LearnFlow 将携带失败报告自动重新生成；连续失败后需检查工作流评审节点",
            diagnostics=diagnostics,
        )
    return LearningTaskIntegrationError(
        "workflow_artifact_missing", "讯飞工作流完成但没有返回可解析的任务包", status_code=422,
        retryable=True, who_fixes="provider", suggested_action="让结束节点返回集成 bundle 或含任务卡 ID 的四类产物 URL",
        diagnostics={**diagnostics, "contentPreview": _compact(content, 1_000)},
    )


def provider_diagnostics(content: str) -> list[str]:
    output: list[str] = []
    for value in _json_objects(content):
        for key in ("hard_errors", "errors", "warnings"):
            for item in list(value.get(key) or []):
                text = _compact(item, 500)
                if text and text not in output:
                    output.append(text)
    return output[:12]


def validate_integration_bundle(payload: Any, task_card_id: str) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    if not isinstance(payload, Mapping):
        errors.append({"path": "$", "reason": "任务包必须是 JSON 对象"})
    else:
        if payload.get("schema_version") != INTEGRATION_BUNDLE_SCHEMA_VERSION:
            errors.append({"path": "$.schema_version", "reason": "不支持的任务包版本"})
        if payload.get("task_card_id") != task_card_id:
            errors.append({"path": "$.task_card_id", "reason": "任务包 ID 与工作流输出不一致"})
        task = payload.get("task")
        work = task.get("work_task") if isinstance(task, Mapping) else None
        if not isinstance(work, Mapping):
            errors.append({"path": "$.task.work_task", "reason": "缺少 work_task"})
        else:
            steps = work.get("task_steps")
            if not isinstance(steps, list):
                errors.append({"path": "$.task.work_task.task_steps", "reason": "步骤必须是数组"})
            elif not MIN_STEPS <= len(steps) <= MAX_STEPS:
                errors.append({"path": "$.task.work_task.task_steps", "reason": f"步骤数量必须在 {MIN_STEPS}—{MAX_STEPS} 之间"})
            knowledge_ids = {
                str(item.get("knowledge_id")) for item in list(work.get("knowledge_points") or [])
                if isinstance(item, Mapping) and item.get("knowledge_id")
            }
            skill_ids = {
                str(item.get("skill_id")) for item in list(work.get("skill_points") or [])
                if isinstance(item, Mapping) and item.get("skill_id")
            }
            seen: set[str] = set()
            for index, step in enumerate(steps if isinstance(steps, list) else []):
                path = f"$.task.work_task.task_steps[{index}]"
                if not isinstance(step, Mapping):
                    errors.append({"path": path, "reason": "步骤必须是对象"})
                    continue
                step_id = _compact(step.get("step_id"), 160)
                if not step_id:
                    errors.append({"path": f"{path}.step_id", "reason": "缺少稳定步骤 ID"})
                elif step_id in seen:
                    errors.append({"path": f"{path}.step_id", "reason": "步骤 ID 重复"})
                seen.add(step_id)
                for key in ("name", "action", "deliverable", "check"):
                    if key == "name" and _compact(step.get("title"), 500):
                        continue
                    if not _compact(step.get(key), 1_000):
                        errors.append({"path": f"{path}.{key}", "reason": "字段不能为空"})
                kp = {str(item) for item in list(step.get("knowledge_point_ids") or [])}
                sp = {str(item) for item in list(step.get("skill_point_ids") or [])}
                if not kp:
                    errors.append({"path": f"{path}.knowledge_point_ids", "reason": "步骤缺少知识点映射"})
                if not sp:
                    errors.append({"path": f"{path}.skill_point_ids", "reason": "步骤缺少技能点映射"})
                if kp - knowledge_ids:
                    errors.append({"path": f"{path}.knowledge_point_ids", "reason": "包含悬空知识点引用"})
                if sp - skill_ids:
                    errors.append({"path": f"{path}.skill_point_ids", "reason": "包含悬空技能点引用"})
    if errors:
        raise LearningTaskIntegrationError(
            "bundle_contract_invalid", "讯飞任务包未通过结构校验", status_code=422,
            retryable=False, who_fixes="provider", suggested_action="按 diagnostics 修订工作流输出后重新生成",
            diagnostics={"issues": errors[:24], "issueCount": len(errors)},
        )
    return dict(payload)


def handoff_to_integration_bundle(payload: Any, task_card_id: str) -> dict[str, Any]:
    """Normalize the workflow's public handoff contract into the internal bundle.

    No semantic fields are invented here.  The handoff already contains the
    work task, steps, mappings and acceptance data; this adapter only adds the
    trusted task-card binding and the internal envelope expected by the same
    deterministic validator used for the legacy bundle endpoint.
    """
    if not isinstance(payload, Mapping):
        raise LearningTaskIntegrationError(
            "bundle_contract_invalid", "讯飞交接 JSON 必须是对象", status_code=422,
            who_fixes="provider", suggested_action="让 handoff_url 返回版本化 JSON 对象",
            diagnostics={"issues": [{"path": "$", "reason": "交接产物必须是 JSON 对象"}], "issueCount": 1},
        )
    if payload.get("schema_version") != PERSONALIZED_HANDOFF_SCHEMA_VERSION:
        raise LearningTaskIntegrationError(
            "bundle_contract_invalid", "讯飞交接 JSON 版本不受支持", status_code=422,
            who_fixes="provider", suggested_action="让 handoff_url 返回 learning-task-to-personalized-learning-v1",
            diagnostics={
                "issues": [{"path": "$.schema_version", "reason": "不支持的交接合同版本"}],
                "issueCount": 1,
            },
        )
    work_task = payload.get("work_task")
    bundle = {
        "schema_version": INTEGRATION_BUNDLE_SCHEMA_VERSION,
        "task_card_id": task_card_id,
        "verification_status": _compact(payload.get("verification_status"), 80) or "provisional",
        "task": {"work_task": dict(work_task) if isinstance(work_task, Mapping) else work_task},
        "handoff_contract": {
            "schema_version": PERSONALIZED_HANDOFF_SCHEMA_VERSION,
            "review_required": bool(payload.get("review_required", True)),
            "evidence_required": bool(payload.get("evidence_required", True)),
            "release_scope": _compact(payload.get("release_scope"), 160),
            "source_typical_task_id": _compact(payload.get("source_typical_task_id"), 160),
        },
    }
    return validate_integration_bundle(bundle, task_card_id)


async def build_source_snapshot(
    db: AsyncSession,
    project: Project,
    *,
    source_version_ids: list[int],
    max_segments: int,
) -> SourceSnapshot:
    query = (
        select(SourceVersion, Source)
        .join(Source, Source.id == SourceVersion.source_id)
        .where(Source.project_id == project.id, Source.status == "processed")
        .order_by(Source.id, SourceVersion.version.desc())
    )
    if source_version_ids:
        query = query.where(SourceVersion.id.in_(source_version_ids))
    rows = list((await db.execute(query)).all())
    if source_version_ids:
        found = {version.id for version, _source in rows}
        missing = sorted(set(source_version_ids) - found)
        if missing:
            raise LearningTaskIntegrationError(
                "source_version_unavailable", "部分来源版本不属于当前项目或不可读取", status_code=422,
                who_fixes="user", suggested_action="重新选择当前项目的有效来源版本",
                diagnostics={"sourceVersionIds": missing},
            )
    else:
        active_rows: list[tuple[SourceVersion, Source]] = []
        seen_sources: set[int] = set()
        for version, source in rows:
            active_id = int(dict(source.meta_data or {}).get("active_source_version_id") or 0)
            if source.id in seen_sources:
                continue
            if active_id and version.id != active_id:
                continue
            if version.status not in {"active", "stale", "conflicted"}:
                continue
            active_rows.append((version, source))
            seen_sources.add(source.id)
        rows = active_rows
    rows = rows[:20]
    version_ids = [version.id for version, _source in rows]
    chunk_rows = [] if not version_ids else list((await db.execute(
        select(Chunk).where(Chunk.source_version_id.in_(version_ids)).order_by(Chunk.source_version_id, Chunk.index)
    )).scalars().all())
    chunks_by_version: dict[int, list[Chunk]] = {}
    for chunk in chunk_rows:
        chunks_by_version.setdefault(int(chunk.source_version_id or 0), []).append(chunk)

    max_segments = max(1, min(max_segments, int(settings.learning_task_conversion_max_source_segments or 16), 20))
    bindings: list[dict[str, Any]] = []
    citations: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    total_chars = 0
    available_chunks = [
        chunk
        for version, _source in rows
        for chunk in chunks_by_version.get(version.id, [])
        if str(chunk.content or "").strip()
    ]
    available_segments = len(available_chunks)
    available_characters = sum(len(str(chunk.content or "").strip()) for chunk in available_chunks)
    for version, source in rows:
        bindings.append({
            "sourceId": source.id,
            "sourceVersionId": version.id,
            "sourceVersion": version.version,
            "contentHash": version.content_hash,
            "authorityTier": version.authority_tier,
            "status": version.status,
        })
        if version.status != "active":
            warnings.append({
                "code": f"source_{version.status}",
                "message": f"来源版本 {version.id} 状态为 {version.status}",
                "sourceVersionId": version.id,
            })
        for chunk in chunks_by_version.get(version.id, []):
            if len(segments) >= max_segments or total_chars >= MAX_SOURCE_CHARS:
                break
            text = str(chunk.content or "").strip()
            if not text:
                continue
            text = text[:min(MAX_SEGMENT_CHARS, MAX_SOURCE_CHARS - total_chars)]
            citation_id = f"srcv{version.id}:chunk{chunk.id}"
            segment = {
                "citationId": citation_id,
                "sourceId": source.id,
                "sourceVersionId": version.id,
                "chunkId": chunk.id,
                "contentHash": version.content_hash,
                "text": text,
            }
            segments.append(segment)
            citations.append({
                "citationId": citation_id,
                "sourceId": source.id,
                "sourceVersionId": version.id,
                "chunkId": chunk.id,
                "contentHash": version.content_hash,
                "excerpt": text[:360],
            })
            total_chars += len(text)
    omitted = max(0, available_segments - len(segments))
    omitted_characters = max(0, available_characters - total_chars)
    truncated = omitted > 0 or omitted_characters > 0
    if not segments:
        warnings.append({
            "code": "ungrounded",
            "message": "没有可发送给 provider 的项目来源片段；候选不得表述为岗位来源事实。",
        })
    elif truncated:
        warnings.append({
            "code": "source_context_truncated",
            "message": f"来源上下文已按预算截断，省略 {omitted} 个片段、{omitted_characters} 个字符。",
        })
    root_hash = canonical_hash({"projectId": project.id, "bindings": bindings, "segments": segments})
    return SourceSnapshot(
        package_id=f"learnflow-project:{project.id}",
        package_version=f"source-set.{root_hash[:12]}",
        snapshot_id=f"source_snapshot_{root_hash[:20]}",
        root_hash=root_hash,
        bindings=bindings,
        citations=citations,
        segments=segments,
        coverage={
            "sourceVersionCount": len(bindings),
            "availableSegmentCount": available_segments,
            "includedSegmentCount": len(segments),
            "omittedSegmentCount": omitted,
            "availableCharacters": available_characters,
            "includedCharacters": total_chars,
            "omittedCharacterCount": omitted_characters,
            "truncated": truncated,
        },
        warnings=warnings,
    )


def _provider_bounded_snapshot(source_snapshot: SourceSnapshot) -> SourceSnapshot:
    """Pin exactly the source excerpt that can cross Xingchen's 500-char wire limit."""
    segments: list[dict[str, Any]] = []
    citations: list[dict[str, Any]] = []
    if source_snapshot.segments:
        original = source_snapshot.segments[0]
        text = _compact(original.get("text"), MAX_PROVIDER_SOURCE_TEXT_CHARS)
        segment = {
            "citationId": original["citationId"],
            "sourceVersionId": original["sourceVersionId"],
            "text": text,
        }
        segments.append(segment)
        citation = next(
            (
                dict(item)
                for item in source_snapshot.citations
                if item.get("citationId") == original.get("citationId")
            ),
            None,
        )
        if citation:
            citation["excerpt"] = text
            citations.append(citation)

    available_segments = int(source_snapshot.coverage.get("availableSegmentCount") or 0)
    available_characters = int(source_snapshot.coverage.get("availableCharacters") or 0)
    included_characters = sum(len(str(item.get("text") or "")) for item in segments)
    omitted_segments = max(0, available_segments - len(segments))
    omitted_characters = max(0, available_characters - included_characters)
    truncated = omitted_segments > 0 or omitted_characters > 0
    warnings = [
        dict(item)
        for item in source_snapshot.warnings
        if item.get("code") not in {"source_context_truncated", "provider_context_truncated"}
    ]
    if segments and truncated:
        warnings.append({
            "code": "provider_context_truncated",
            "message": (
                "讯飞当前工作流的 user_query 最多 500 字符；"
                f"已发送 1 个来源摘要，省略 {omitted_segments} 个片段、"
                f"{omitted_characters} 个字符。"
            ),
        })
    root_hash = canonical_hash({
        "bindings": source_snapshot.bindings,
        "providerSegments": segments,
    })
    return SourceSnapshot(
        package_id=source_snapshot.package_id,
        package_version=f"source-set.{root_hash[:12]}",
        snapshot_id=f"source_snapshot_{root_hash[:20]}",
        root_hash=root_hash,
        bindings=source_snapshot.bindings,
        citations=citations,
        segments=segments,
        coverage={
            **source_snapshot.coverage,
            "includedSegmentCount": len(segments),
            "omittedSegmentCount": omitted_segments,
            "includedCharacters": included_characters,
            "omittedCharacterCount": omitted_characters,
            "truncated": truncated,
            "providerInputCharacterLimit": MAX_PROVIDER_INPUT_CHARS,
        },
        warnings=warnings,
    )


def _provider_citation_ids(*values: Any) -> list[str]:
    output: list[str] = []
    for value in values:
        if isinstance(value, str):
            candidates = [value]
        elif isinstance(value, Mapping):
            candidates = list(value.get("citation_ids") or value.get("citationIds") or [])
        else:
            candidates = list(value or []) if isinstance(value, list) else []
        for item in candidates:
            text = _compact(item, 180)
            if text and text not in output:
                output.append(text)
    return output[:24]


def bundle_to_candidate(
    bundle: Mapping[str, Any],
    *,
    candidate_id: str,
    request_id: str,
    task_title: str,
    source_snapshot: SourceSnapshot,
    provider_run: Mapping[str, Any],
    target_step_count: int,
    upstream_task: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    task_envelope = bundle.get("task")
    work = task_envelope.get("work_task") if isinstance(task_envelope, Mapping) else {}
    work = dict(work) if isinstance(work, Mapping) else {}
    knowledge_by_id = {
        str(item.get("knowledge_id")): dict(item)
        for item in list(work.get("knowledge_points") or [])
        if isinstance(item, Mapping) and item.get("knowledge_id")
    }
    skill_by_id = {
        str(item.get("skill_id")): dict(item)
        for item in list(work.get("skill_points") or [])
        if isinstance(item, Mapping) and item.get("skill_id")
    }
    allowed_citations = {item["citationId"] for item in source_snapshot.citations}
    used_citations: set[str] = set()
    steps: list[dict[str, Any]] = []
    knowledge_targets: dict[str, dict[str, Any]] = {}
    skill_targets: dict[str, dict[str, Any]] = {}
    capability_targets: dict[str, dict[str, Any]] = {}
    provider_steps = list(work.get("task_steps") or [])
    provider_step_ids = [str(item.get("step_id")) for item in provider_steps if isinstance(item, Mapping)]
    for index, raw in enumerate(provider_steps, start=1):
        if not isinstance(raw, Mapping):
            continue
        step_id = _compact(raw.get("step_id"), 160) or f"step_{index:02d}"
        raw_prerequisites = _text_list(raw.get("prerequisites"), limit=8, item_limit=160)
        prerequisites = [item for item in raw_prerequisites if item in provider_step_ids and item != step_id]
        dependency_derivation = "provider"
        if not prerequisites and index > 1:
            prerequisites = [steps[-1]["id"]]
            dependency_derivation = "local_order_derivation"
        step_citations = _provider_citation_ids(raw)
        used_citations.update(item for item in step_citations if item in allowed_citations)
        knowledge_ids = [str(item) for item in list(raw.get("knowledge_point_ids") or []) if str(item) in knowledge_by_id]
        skill_ids = [str(item) for item in list(raw.get("skill_point_ids") or []) if str(item) in skill_by_id]
        for item_id in knowledge_ids:
            item = knowledge_by_id[item_id]
            citations = _provider_citation_ids(item, step_citations)
            used_citations.update(value for value in citations if value in allowed_citations)
            knowledge_targets[item_id] = {
                "id": item_id,
                "title": _compact(item.get("name"), 240),
                "description": _compact(item.get("scope") or item.get("description"), 800),
                "derivedFromObjectIds": [step_id],
                "citationIds": [value for value in citations if value in allowed_citations],
                "derivationKind": "pedagogical_transformation",
            }
        for item_id in skill_ids:
            item = skill_by_id[item_id]
            citations = _provider_citation_ids(item, step_citations)
            used_citations.update(value for value in citations if value in allowed_citations)
            skill_targets[item_id] = {
                "id": item_id,
                "title": _compact(item.get("name"), 240),
                "description": _compact(item.get("observable_action") or item.get("description"), 800),
                "derivedFromObjectIds": [step_id],
                "citationIds": [value for value in citations if value in allowed_citations],
                "derivationKind": "pedagogical_transformation",
            }
        resources: list[dict[str, Any]] = []
        for item_id in knowledge_ids:
            for resource in list(knowledge_by_id[item_id].get("learning_resources") or []):
                if not isinstance(resource, Mapping):
                    continue
                url = _compact(resource.get("resource_url"), 1_000)
                resources.append({
                    "id": _compact(resource.get("resource_id"), 160) or f"resource_{len(resources) + 1}",
                    "title": _compact(resource.get("resource_name"), 300) or "学习资源",
                    "type": _compact(resource.get("resource_type"), 80) or "reference",
                    "url": url,
                })
        deliverable = _compact(raw.get("deliverable"), 800)
        criterion = _compact(raw.get("check") or raw.get("acceptance"), 800)
        step = {
            "id": step_id,
            "order": index,
            "title": _compact(raw.get("name") or raw.get("title") or raw.get("action"), 300),
            "action": _compact(raw.get("action") or raw.get("operation"), 1_200),
            "prerequisiteStepIds": prerequisites,
            "dependencyDerivation": dependency_derivation,
            "inputs": _text_list(raw.get("inputs"), limit=8),
            "resources": resources[:8],
            "deliverables": [deliverable] if deliverable else [],
            "successCriteria": [criterion] if criterion else [],
            "safetyRequirements": _text_list(raw.get("safety") or raw.get("safety_points"), limit=6),
            "knowledgeTargetIds": knowledge_ids,
            "skillTargetIds": skill_ids,
            "capabilityTargetIds": [f"capability_{step_id}"],
            "citationIds": [value for value in step_citations if value in allowed_citations],
        }
        steps.append(step)
        capability_targets[f"capability_{step_id}"] = {
            "id": f"capability_{step_id}",
            "title": f"独立完成{step['title']}",
            "description": f"在规定边界内完成“{step['action']}”，并提交“{deliverable}”供确定性验收。",
            "derivedFromObjectIds": [step_id],
            "citationIds": list(step["citationIds"]),
            "derivationKind": "pedagogical_transformation",
        }
    global_success = _text_list(work.get("acceptance_tests"), limit=16)
    evidence_required = list(dict.fromkeys(
        item for step in steps for item in step["deliverables"]
    ))
    rubric = []
    for index, criterion in enumerate(global_success or [
        item for step in steps for item in step["successCriteria"]
    ], start=1):
        source_step = steps[min(index - 1, len(steps) - 1)] if steps else {}
        rubric.append({
            "id": f"rubric_{index:02d}",
            "criterion": criterion,
            "passCondition": criterion,
            "levels": [
                {"id": "pass", "label": "通过", "condition": criterion},
                {"id": "revise", "label": "需修订", "condition": f"未提供足以证明“{criterion}”的独立证据"},
            ],
            "derivedFromObjectIds": [source_step["id"]] if source_step else [],
            "citationIds": list(source_step.get("citationIds") or []),
            "derivationKind": "pedagogical_transformation",
        })
    used_citation_objects = [
        item for item in source_snapshot.citations if item["citationId"] in used_citations
    ]
    warnings = list(source_snapshot.warnings)
    if source_snapshot.segments and not used_citations:
        warnings.append({
            "code": "sources_supplied_without_citation_binding",
            "message": "来源片段已进入 provider 输入，但输出没有绑定 citationId；候选不得宣称为直接岗位事实。",
        })
    if len(steps) != target_step_count:
        warnings.append({
            "code": "provider_step_count_mismatch",
            "message": (
                f"请求 {target_step_count} 个步骤，讯飞实际返回 {len(steps)} 个；"
                "候选仍可复核，但不得宣称已满足目标步数。"
            ),
        })
    grounding_status = (
        "ungrounded" if not source_snapshot.segments
        else "grounded" if used_citations
        else "source_supplied_unverified"
    )
    title = _compact(
        work.get("teaching_task_name") or work.get("enterprise_task_name") or task_title, 300,
    )
    context = _compact(
        work.get("work_situation") or work.get("enterprise_task_description")
        or work.get("teaching_task_description"), 2_000,
    )
    objective = _compact(
        work.get("teaching_task_description") or work.get("enterprise_task_description"), 2_000,
    ) or f"完成“{task_title}”并提交可独立检查的过程产物。"
    upstream = dict(upstream_task or {})
    raw_origin = upstream.get("learnflowOrigin")
    raw_origin = dict(raw_origin) if isinstance(raw_origin, Mapping) else {}
    session_id = raw_origin.get("sessionId")
    origin = {
        **({"sessionId": session_id} if isinstance(session_id, int) and session_id > 0 else {}),
        **({"conversationId": _compact(raw_origin.get("conversationId"), 160)} if _compact(raw_origin.get("conversationId"), 160) else {}),
        **({"sheetId": _compact(raw_origin.get("sheetId"), 160)} if _compact(raw_origin.get("sheetId"), 160) else {}),
    }
    raw_task_source = upstream.get("taskSource")
    raw_task_source = dict(raw_task_source) if isinstance(raw_task_source, Mapping) else {}
    task_source = {
        "kind": _compact(raw_task_source.get("kind"), 80),
        "ref": _compact(raw_task_source.get("ref"), 500),
    }
    candidate = {
        "schemaVersion": CANDIDATE_SCHEMA_VERSION,
        "candidateId": candidate_id,
        "requestId": request_id,
        "packageId": source_snapshot.package_id,
        "packageVersion": source_snapshot.package_version,
        "snapshotId": source_snapshot.snapshot_id,
        "rootHash": source_snapshot.root_hash,
        "lifecycle": "candidate",
        "confirmationStatus": "unconfirmed",
        "groundingStatus": grounding_status,
        "sourceSnapshot": {
            "packageId": source_snapshot.package_id,
            "packageVersion": source_snapshot.package_version,
            "snapshotId": source_snapshot.snapshot_id,
            "rootHash": source_snapshot.root_hash,
        },
        "sourceBindings": source_snapshot.bindings,
        "citations": used_citation_objects,
        "task": {
            "title": title,
            "workContext": context,
            "learningObjective": objective,
            "prerequisites": _text_list(work.get("prerequisites"), limit=12),
            "estimatedMinutes": (
                int(work.get("estimated_minutes"))
                if str(work.get("estimated_minutes") or "").isdigit()
                else max(30, len(steps) * 35)
            ),
            "inputs": _text_list(work.get("inputs"), limit=12),
            "resources": _text_list(work.get("tools"), limit=16),
            "steps": steps,
            "deliverables": evidence_required,
            "successCriteria": global_success or [
                criterion for step in steps for criterion in step["successCriteria"]
            ],
            "safetyRequirements": _text_list(work.get("safety_points"), limit=16),
        },
        "mappings": {
            "knowledgeTargets": list(knowledge_targets.values()),
            "skillTargets": list(skill_targets.values()),
            "capabilityTargets": list(capability_targets.values()),
        },
        "assessment": {
            "evidenceRequired": evidence_required,
            "rubric": rubric,
            "scoringPolicy": {
                "owner": "practice_agent",
                "method": "deterministic_binary_gate_after_submission",
                "llmMayScore": False,
            },
            "independentVerification": {
                "required": True,
                "methods": list(dict.fromkeys(
                    criterion for step in steps for criterion in step["successCriteria"]
                )),
                "validatorId": "learning_task_candidate_independent_verification",
                "validatorVersion": VALIDATOR_VERSION,
                "procedure": "逐项核对步骤产物、成功标准和 rubric；任一必需项缺证据即退回修订",
                "passCondition": "all_required_evidence_and_rubric_items_pass",
                "authority": "learnflow_deterministic_rules_after_user_confirmation",
                "requiresUserConfirmation": True,
            },
        },
        "coverage": {
            "partial": bool(source_snapshot.coverage.get("truncated")),
            "truncated": bool(source_snapshot.coverage.get("truncated")),
            "omitted": int(source_snapshot.coverage.get("omittedSegmentCount") or 0),
            "source": source_snapshot.coverage,
            "task": {
                "requestedStepCount": target_step_count,
                "returnedStepCount": len(steps),
                "knowledgeTargetCount": len(knowledge_targets),
                "skillTargetCount": len(skill_targets),
                "capabilityTargetCount": len(capability_targets),
                "citationCount": len(used_citations),
                "truncated": False,
                "omittedStepCount": 0,
            },
        },
        "warnings": warnings,
        "assumptions": _text_list(work.get("assumptions"), limit=12),
        "validation": {},
        "provenance": {
            "provider": "xunfei-xingchen",
            "requestedTaskTitle": task_title,
            "flowId": _compact(provider_run.get("workflowId"), 160),
            "workflowId": _compact(provider_run.get("workflowId"), 160),
            "workflowRunIds": [value for value in list(provider_run.get("workflowRunIds") or []) if value],
            "taskCardId": _compact(bundle.get("task_card_id"), 160),
            "contractVersion": INTEGRATION_BUNDLE_SCHEMA_VERSION,
            "validatorVersion": VALIDATOR_VERSION,
            "verificationStatus": _compact(bundle.get("verification_status"), 80),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "localDerivations": [
                "linear prerequisites are derived only when provider step order has no explicit dependency",
                "rubric rows are derived from provider success criteria",
                "capability targets are pedagogical transformations of candidate steps, not岗位来源事实",
            ],
            "workflowArtifacts": dict(provider_run.get("workflowOutput") or {}),
            "kernelTargets": [],
            "masteryUnchanged": True,
            "origin": origin,
            "taskSource": task_source,
        },
    }
    candidate["validation"] = validate_candidate(candidate)
    return candidate


def _has_cycle(steps: list[Mapping[str, Any]]) -> bool:
    graph = {str(step.get("id")): [str(item) for item in list(step.get("prerequisiteStepIds") or [])] for step in steps}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> bool:
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        if any(visit(parent) for parent in graph.get(node, [])):
            return True
        visiting.remove(node)
        visited.add(node)
        return False

    return any(visit(node) for node in graph)


def validate_candidate(candidate: Mapping[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    safety_sensitive = False
    safety_gate_passed = True

    def require(condition: bool, path: str, reason: str) -> None:
        if not condition:
            issues.append({"path": path, "reason": reason})

    require(candidate.get("schemaVersion") == CANDIDATE_SCHEMA_VERSION, "$.schemaVersion", "候选版本不受支持")
    require(bool(_compact(candidate.get("candidateId"), 100)), "$.candidateId", "缺少 candidateId")
    require(candidate.get("lifecycle") == "candidate", "$.lifecycle", "候选对象不得冒充正式任务")
    require(candidate.get("confirmationStatus") == "unconfirmed", "$.confirmationStatus", "候选必须保持未确认")
    source_snapshot = candidate.get("sourceSnapshot")
    require(isinstance(source_snapshot, Mapping), "$.sourceSnapshot", "缺少固定来源快照")
    if isinstance(source_snapshot, Mapping):
        require(bool(re.fullmatch(r"[a-f0-9]{64}", str(source_snapshot.get("rootHash") or ""))), "$.sourceSnapshot.rootHash", "rootHash 必须是 SHA-256")
    task = candidate.get("task")
    require(isinstance(task, Mapping), "$.task", "缺少任务主体")
    steps = list(task.get("steps") or []) if isinstance(task, Mapping) else []
    require(MIN_STEPS <= len(steps) <= MAX_STEPS, "$.task.steps", f"步骤数量必须在 {MIN_STEPS}—{MAX_STEPS} 之间")
    if isinstance(task, Mapping):
        for key in ("title", "workContext", "learningObjective"):
            require(bool(_compact(task.get(key), 3_000)), f"$.task.{key}", "字段不能为空")
        safety_text = " ".join(_text_list(task.get("safetyRequirements"), limit=20)).casefold()
        risk_text = " ".join([
            str(task.get("title") or ""), str(task.get("workContext") or ""),
            *[str(step.get("action") or "") for step in steps if isinstance(step, Mapping)],
        ]).casefold()
        safety_sensitive = any(term in risk_text for term in (
            "高压", "带电", "电池包", "危险化学", "起重", "焊接", "生产环境",
            "root 权限", "管理员权限", "删除数据", "医疗", "消防", "燃气",
        ))
        safety_gate_passed = not safety_sensitive or bool(safety_text) or any(
            _text_list(step.get("safetyRequirements")) for step in steps if isinstance(step, Mapping)
        )
        require(safety_gate_passed, "$.task.safetyRequirements", "安全敏感任务必须包含明确安全要求")
    step_ids = [str(step.get("id") or "") for step in steps if isinstance(step, Mapping)]
    require(len(step_ids) == len(steps), "$.task.steps", "每个步骤都必须是对象并具有 ID")
    require(len(set(step_ids)) == len(step_ids), "$.task.steps", "步骤 ID 必须唯一")
    step_set = set(step_ids)
    for index, step in enumerate(steps):
        if not isinstance(step, Mapping):
            continue
        path = f"$.task.steps[{index}]"
        for key in ("title", "action"):
            require(bool(_compact(step.get(key), 2_000)), f"{path}.{key}", "字段不能为空")
        require(bool(_text_list(step.get("deliverables"))), f"{path}.deliverables", "至少需要一个可检查产物")
        require(bool(_text_list(step.get("successCriteria"))), f"{path}.successCriteria", "至少需要一个验收依据")
        prerequisites = {str(item) for item in list(step.get("prerequisiteStepIds") or [])}
        require(not (prerequisites - step_set), f"{path}.prerequisiteStepIds", "包含悬空步骤依赖")
        require(str(step.get("id")) not in prerequisites, f"{path}.prerequisiteStepIds", "步骤不能依赖自身")
        for resource_index, resource in enumerate(list(step.get("resources") or [])):
            if not isinstance(resource, Mapping):
                issues.append({"path": f"{path}.resources[{resource_index}]", "reason": "资源必须是对象"})
                continue
            url = str(resource.get("url") or "").strip()
            if url:
                parsed = urlsplit(url)
                require(parsed.scheme in {"http", "https"} and bool(parsed.hostname), f"{path}.resources[{resource_index}].url", "资源 URL 必须是 HTTP(S) 绝对地址")
    require(not _has_cycle([step for step in steps if isinstance(step, Mapping)]), "$.task.steps", "步骤依赖图不能成环")
    citation_ids = {
        str(item.get("citationId")) for item in list(candidate.get("citations") or [])
        if isinstance(item, Mapping) and item.get("citationId")
    }
    referenced_citations = {
        str(value) for step in steps if isinstance(step, Mapping)
        for value in list(step.get("citationIds") or [])
    }
    for group in ("knowledgeTargets", "skillTargets", "capabilityTargets"):
        targets = list(dict(candidate.get("mappings") or {}).get(group) or [])
        ids = [str(item.get("id") or "") for item in targets if isinstance(item, Mapping)]
        require(len(ids) == len(targets) and len(set(ids)) == len(ids), f"$.mappings.{group}", "映射 ID 必须存在且唯一")
        for index, target in enumerate(targets):
            if not isinstance(target, Mapping):
                continue
            derived = {str(value) for value in list(target.get("derivedFromObjectIds") or [])}
            require(bool(derived) and not (derived - step_set), f"$.mappings.{group}[{index}].derivedFromObjectIds", "映射必须指向本候选步骤")
            require(target.get("derivationKind") in {"direct_fact", "pedagogical_transformation", "explicit_assumption"}, f"$.mappings.{group}[{index}].derivationKind", "derivationKind 无效")
            referenced_citations.update(str(value) for value in list(target.get("citationIds") or []))
    assessment = candidate.get("assessment")
    if isinstance(assessment, Mapping):
        scoring_policy = assessment.get("scoringPolicy")
        if isinstance(scoring_policy, Mapping):
            require(scoring_policy.get("owner") == "practice_agent", "$.assessment.scoringPolicy.owner", "评分权威必须属于 Practice Agent")
            require(scoring_policy.get("llmMayScore") is False, "$.assessment.scoringPolicy.llmMayScore", "模型不得决定评分或通过状态")
        for index, row in enumerate(list(assessment.get("rubric") or [])):
            if not isinstance(row, Mapping):
                issues.append({"path": f"$.assessment.rubric[{index}]", "reason": "rubric 行必须是对象"})
                continue
            require(bool(_compact(row.get("criterion"), 1_000)), f"$.assessment.rubric[{index}].criterion", "rubric criterion 不能为空")
            require(bool(_compact(row.get("passCondition"), 1_000)), f"$.assessment.rubric[{index}].passCondition", "rubric passCondition 不能为空")
            derived = {str(value) for value in list(row.get("derivedFromObjectIds") or [])}
            require(bool(derived) and not (derived - step_set), f"$.assessment.rubric[{index}].derivedFromObjectIds", "rubric 必须指向本候选步骤")
            referenced_citations.update(str(value) for value in list(row.get("citationIds") or []))
        verification = assessment.get("independentVerification")
        if isinstance(verification, Mapping):
            require(verification.get("authority") == "learnflow_deterministic_rules_after_user_confirmation", "$.assessment.independentVerification.authority", "独立验证必须由用户确认后的 LearnFlow 确定性规则控制")
    require(not (referenced_citations - citation_ids), "$.citations", "存在未绑定到固定来源快照的 citationId")
    coverage = candidate.get("coverage")
    require(isinstance(coverage, Mapping), "$.coverage", "缺少覆盖统计")
    if isinstance(coverage, Mapping):
        task_coverage = coverage.get("task")
        if isinstance(task_coverage, Mapping) and task_coverage.get("truncated"):
            require(int(task_coverage.get("omittedStepCount") or 0) > 0, "$.coverage.task.omittedStepCount", "截断时必须报告遗漏量")
    if candidate.get("groundingStatus") == "ungrounded" and candidate.get("citations"):
        issues.append({"path": "$.citations", "reason": "ungrounded 候选不得携带来源引用"})
    if not citation_ids:
        warnings.append({"path": "$.citations", "reason": "候选没有可验证的来源引用"})
    requested_title = str(dict(candidate.get("provenance") or {}).get("requestedTaskTitle") or "")
    candidate_text = " ".join([
        str(dict(candidate.get("task") or {}).get("title") or ""),
        str(dict(candidate.get("task") or {}).get("workContext") or ""),
        *[str(step.get("title") or "") + " " + str(step.get("action") or "") for step in steps if isinstance(step, Mapping)],
    ]).casefold()
    significant_terms = [term for term in re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", requested_title.casefold()) if len(term) >= 2]
    if significant_terms and not any(term in candidate_text for term in significant_terms):
        warnings.append({"path": "$.task", "reason": "候选与原始任务标题缺少可观察词汇重合，需要用户重点复核语义一致性"})
    result = {
        "valid": not issues,
        "issues": issues,
        "warnings": warnings,
        "policyVersion": VALIDATOR_VERSION,
        "riskClass": "safety_sensitive" if safety_sensitive else "standard",
        "safetyGatePassed": bool(safety_gate_passed),
        "sourceClosureValid": not bool(referenced_citations - citation_ids),
        "snapshotCoherent": bool(isinstance(source_snapshot, Mapping) and re.fullmatch(
            r"[a-f0-9]{64}", str(source_snapshot.get("rootHash") or ""),
        )),
        "requiresUserConfirmation": True,
        "promotable": False,
        "deterministic": True,
        "kernelWrites": 0,
        "masteryChanged": False,
    }
    if issues:
        raise LearningTaskIntegrationError(
            "candidate_validation_failed", "候选未通过 LearnFlow 确定性校验", status_code=422,
            retryable=False, who_fixes="provider", suggested_action="依据 diagnostics 重新生成完整候选",
            diagnostics={"issues": issues[:32], "issueCount": len(issues)},
        )
    return result


def _serialized_provider_length(value: Mapping[str, Any]) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _fit_provider_input(value: Mapping[str, Any]) -> dict[str, Any]:
    """Deterministically shrink optional prose while preserving task and source identity."""
    fitted = json.loads(json.dumps(value, ensure_ascii=False))
    source = fitted.get("s") if isinstance(fitted.get("s"), dict) else {}
    if _serialized_provider_length(fitted) <= MAX_PROVIDER_INPUT_CHARS:
        return fitted
    fitted.pop("d", None)
    while _serialized_provider_length(fitted) > MAX_PROVIDER_INPUT_CHARS and source:
        text = str(source.get("x") or "")
        if len(text) <= 24:
            break
        source["x"] = text[:-8]
    while _serialized_provider_length(fitted) > MAX_PROVIDER_INPUT_CHARS:
        title = str(fitted.get("t") or "")
        if len(title) <= 24:
            break
        fitted["t"] = title[:-8]
    if _serialized_provider_length(fitted) > MAX_PROVIDER_INPUT_CHARS:
        raise LearningTaskIntegrationError(
            "provider_input_too_large", "讯飞紧凑请求仍超过 500 字符限制", status_code=422,
            who_fixes="learnflow", suggested_action="减少请求标识长度后重试",
            diagnostics={
                "characters": _serialized_provider_length(fitted),
                "limit": MAX_PROVIDER_INPUT_CHARS,
            },
        )
    return fitted


def _base_provider_input(
    *,
    request_id: str,
    task_title: str,
    task_description: str,
    source_snapshot: SourceSnapshot,
    target_step_count: int,
) -> dict[str, Any]:
    request_ref = f"r_{canonical_hash(request_id)[:12]}"
    source_segment = source_snapshot.segments[0] if source_snapshot.segments else None
    provider_input: dict[str, Any] = {
        "v": PROVIDER_REQUEST_SCHEMA_VERSION,
        "r": request_ref,
        "t": _compact(task_title, 48),
        "d": _compact(task_description, 24),
        "n": target_step_count,
        "ss": source_snapshot.snapshot_id,
        "s": ({
            "c": source_segment["citationId"],
            "v": source_segment["sourceVersionId"],
            "x": source_segment["text"],
        } if source_segment else {}),
        "o": "bundle-v1",
    }
    if not provider_input["d"]:
        del provider_input["d"]
    return _fit_provider_input(provider_input)


def _repair_provider_input(base: Mapping[str, Any], error: LearningTaskIntegrationError, attempt: int) -> dict[str, Any]:
    repaired = {
        **dict(base),
        "fix": {
            "a": attempt,
            "e": _compact(error.code, 40),
            "p": [
                _compact(item.get("path"), 56)
                for item in list(error.diagnostics.get("issues") or [])[:3]
                if isinstance(item, Mapping) and item.get("path")
            ],
        },
    }
    return _fit_provider_input(repaired)


async def _bundle_from_run(
    run: Mapping[str, Any],
    gateway: LearningTaskBundleGateway | None,
    handoff_gateway: XingchenHandoffGateway | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    content = str(run.get("content") or "")
    workflow_output = workflow_end_output(content)
    for value in _json_objects(content):
        if value.get("schema_version") == INTEGRATION_BUNDLE_SCHEMA_VERSION:
            return validate_integration_bundle(value, str(value.get("task_card_id") or "")), workflow_output
    task_card_id = task_card_id_from_content(content)
    if not task_card_id:
        raise _workflow_output_error(content, workflow_output)
    if gateway is None and workflow_output.get("handoff_url"):
        reader = handoff_gateway or XingchenHandoffGateway()
        return await reader.read(workflow_output["handoff_url"], task_card_id), workflow_output
    legacy_gateway = gateway or LearningTaskBundleGateway()
    return await legacy_gateway.read(task_card_id), workflow_output


async def generate_candidate(
    db: AsyncSession,
    *,
    project: Project,
    learner_id: int,
    request_id: str,
    task_title: str,
    task_description: str,
    upstream_task: Mapping[str, Any] | None,
    source_version_ids: list[int],
    target_step_count: int,
    max_source_segments: int,
    workflow_client: XingchenWorkflowClient | None = None,
    bundle_gateway: LearningTaskBundleGateway | None = None,
    handoff_gateway: XingchenHandoffGateway | None = None,
) -> dict[str, Any]:
    full_source_snapshot = await build_source_snapshot(
        db, project, source_version_ids=source_version_ids,
        max_segments=max_source_segments,
    )
    source_snapshot = _provider_bounded_snapshot(full_source_snapshot)
    fingerprint = canonical_hash({
        "schema_version": "role-learning-task-candidate-request.v1",
        "request_id": request_id,
        "task": {
            "title": _compact(task_title, 300),
            "description": _compact(task_description, 2_000),
            "upstream_task": dict(upstream_task or {}),
        },
        "source_snapshot_root_hash": source_snapshot.root_hash,
        "source_version_ids": source_version_ids,
        "target_step_count": target_step_count,
        "max_source_segments": max_source_segments,
    })
    base_provider_input = _base_provider_input(
        request_id=request_id,
        task_title=task_title,
        task_description=task_description,
        source_snapshot=source_snapshot,
        target_step_count=target_step_count,
    )
    existing = (await db.execute(select(LearningTaskCandidateArtifact).where(
        LearningTaskCandidateArtifact.learner_id == learner_id,
        LearningTaskCandidateArtifact.project_id == project.id,
        LearningTaskCandidateArtifact.request_id == request_id,
    ))).scalar_one_or_none()
    if existing:
        if existing.input_hash != fingerprint:
            raise LearningTaskIntegrationError(
                "idempotency_conflict", "相同 requestId 已用于不同输入", status_code=409,
                who_fixes="user", suggested_action="为新输入生成新的 requestId",
            )
        return dict(existing.candidate_json or {})

    client = workflow_client or XingchenWorkflowClient()
    run_ids: list[str] = []
    provider_input: Mapping[str, Any] = base_provider_input
    last_error: LearningTaskIntegrationError | None = None
    for attempt in range(3):
        run = await client.run(provider_input, uid=f"lf-{learner_id}-{request_id}"[:40])
        if run.get("runId"):
            run_ids.append(str(run["runId"]))
        try:
            bundle, workflow_output = await _bundle_from_run(
                run, bundle_gateway, handoff_gateway,
            )
            candidate_id = f"ltc_{canonical_hash({'project': project.id, 'request': request_id, 'input': fingerprint})[:28]}"
            candidate = bundle_to_candidate(
                bundle,
                candidate_id=candidate_id,
                request_id=request_id,
                task_title=task_title,
                source_snapshot=source_snapshot,
                provider_run={
                    **run,
                    "workflowRunIds": run_ids,
                    "workflowOutput": workflow_output,
                },
                target_step_count=target_step_count,
                upstream_task=upstream_task,
            )
            artifact = LearningTaskCandidateArtifact(
                candidate_id=candidate_id,
                learner_id=learner_id,
                project_id=project.id,
                request_id=request_id,
                input_hash=fingerprint,
                candidate_json=candidate,
            )
            db.add(artifact)
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
                raced = (await db.execute(select(LearningTaskCandidateArtifact).where(
                    LearningTaskCandidateArtifact.learner_id == learner_id,
                    LearningTaskCandidateArtifact.project_id == project.id,
                    LearningTaskCandidateArtifact.request_id == request_id,
                ))).scalar_one_or_none()
                if raced and raced.input_hash == fingerprint:
                    return dict(raced.candidate_json or {})
                raise LearningTaskIntegrationError(
                    "idempotency_conflict", "并发请求使用了冲突的 requestId", status_code=409,
                    who_fixes="user", suggested_action="使用新的 requestId",
                )
            return candidate
        except LearningTaskIntegrationError as exc:
            if exc.code not in {
                "bundle_contract_invalid", "candidate_validation_failed", "workflow_artifact_missing",
                "workflow_review_failed",
            } or attempt >= 2:
                raise
            last_error = exc
            provider_input = _repair_provider_input(base_provider_input, exc, attempt + 1)
    raise last_error or LearningTaskIntegrationError(
        "candidate_generation_failed", "候选生成失败", status_code=502,
    )


async def read_candidate_artifact(
    db: AsyncSession, *, learner_id: int, project_id: int, candidate_id: str,
) -> dict[str, Any]:
    artifact = (await db.execute(select(LearningTaskCandidateArtifact).where(
        LearningTaskCandidateArtifact.candidate_id == candidate_id,
        LearningTaskCandidateArtifact.learner_id == learner_id,
        LearningTaskCandidateArtifact.project_id == project_id,
    ))).scalar_one_or_none()
    if not artifact:
        raise LearningTaskIntegrationError(
            "candidate_not_found", "未找到当前项目的学习任务候选", status_code=404,
            who_fixes="user", suggested_action="重新生成候选或检查 candidateId",
        )
    return dict(artifact.candidate_json or {})


async def confirm_candidate_as_learning_task(
    db: AsyncSession,
    *,
    candidate: Mapping[str, Any],
    learner_id: int,
    project_id: int,
    confirmation_id: str,
    expected_root_hash: str,
) -> tuple[Any, bool]:
    """Promote one revalidated candidate through LearnFlow's formal task runtime.

    The external workflow never calls this function.  A learner-confirmed host
    request supplies the immutable candidate root hash; Learning Design owns the
    resulting plan and the existing task runtime owns lifecycle events.
    """
    from app.services.learning_runtime import record_event
    from app.services.learning_tasks import create_learning_task

    validation = validate_candidate(candidate)
    source_snapshot = dict(candidate.get("sourceSnapshot") or {})
    candidate_root_hash = str(source_snapshot.get("rootHash") or "")
    if expected_root_hash != candidate_root_hash:
        raise LearningTaskIntegrationError(
            "candidate_version_conflict", "候选来源快照已经变化，请重新打开后确认", status_code=409,
            who_fixes="user", suggested_action="刷新候选并确认当前 rootHash",
            diagnostics={"expectedRootHash": expected_root_hash, "currentRootHash": candidate_root_hash},
        )
    task_data = dict(candidate.get("task") or {})
    mappings = dict(candidate.get("mappings") or {})
    assessment = dict(candidate.get("assessment") or {})
    candidate_id = str(candidate.get("candidateId") or "")
    provenance = dict(candidate.get("provenance") or {})
    origin = dict(provenance.get("origin") or {})
    session_id = origin.get("sessionId")
    session_id = session_id if isinstance(session_id, int) and session_id > 0 else None
    conversation_id = _compact(origin.get("conversationId"), 160)
    sheet_id = _compact(origin.get("sheetId"), 160)
    task_source = dict(provenance.get("taskSource") or {})
    task_source_ref = _compact(task_source.get("ref"), 500)
    work_steps = [dict(item) for item in list(task_data.get("steps") or []) if isinstance(item, Mapping)]
    plan = {
        "schema_version": "learning-task-plan.v1",
        "summary": "候选经用户确认后进入 LearnFlow；具体工作步骤保持原顺序，教学与验收仍由 LearnFlow 控制。",
        "estimated_minutes": int(task_data.get("estimatedMinutes") or max(30, len(work_steps) * 35)),
        "phases": [
            {
                "id": "learn", "kind": "learn", "title": "学习步骤所需知识与技能",
                "purpose": "按工作步骤读取已映射的知识点、技能点和来源边界。",
                "methods": ["evidence_grounded_teaching", "guided_explanation"],
                "required": True, "status": "pending",
                "completion_rule": "已逐步学习任务所需知识与技能，并保留来源边界。",
                "artifact_outputs": ["learning_task_candidate"],
            },
            {
                "id": "practice", "kind": "practice", "title": "执行真实工作步骤",
                "purpose": "按候选 work_steps 的依赖顺序执行，并提交每步可检查产物。",
                "methods": ["practice_verification", "remediation_loop"],
                "required": True, "status": "pending",
                "completion_rule": "所有必需步骤均提交了对应产物；完成不等于掌握。",
                "artifact_outputs": list(task_data.get("deliverables") or [])[:20],
            },
            {
                "id": "verify", "kind": "verify", "title": "独立验收",
                "purpose": "由 Practice Agent 的确定性规则核对证据与 rubric。",
                "methods": ["verified_micro_learning", "practice_verification"],
                "required": True, "status": "pending",
                "completion_rule": "全部必需证据与 rubric 项由确定性规则判定通过。",
                "artifact_outputs": ["assessment"],
            },
            {
                "id": "consolidate", "kind": "consolidate", "title": "交付与复习衔接",
                "purpose": "归档任务产物，并只根据正式评估决定是否进入复习队列。",
                "methods": ["spaced_review"],
                "required": True, "status": "pending",
                "completion_rule": "任务产物已归档，正式评估需要的复习项已转交或明确无需转交。",
                "artifact_outputs": ["review_schedule"],
            },
        ],
        "adaptation_triggers": ["步骤证据不足", "确定性验收未通过", "学习者要求调整讲法"],
        "work_steps": work_steps,
        "candidate_id": candidate_id,
        "candidate_schema_version": candidate.get("schemaVersion"),
        "source_snapshot": source_snapshot,
        "mappings": mappings,
        "assessment": assessment,
        "confirmation": {
            "confirmationId": confirmation_id,
            "expectedRootHash": expected_root_hash,
            "confirmedBy": "learner",
        },
    }
    source_refs = [{
        "type": "learning_task_candidate",
        "id": candidate_id,
        "schemaVersion": candidate.get("schemaVersion"),
        "rootHash": candidate_root_hash,
    }]
    if conversation_id:
        source_refs.append({
            "type": "conversation",
            "id": conversation_id,
            **({"sheetId": sheet_id} if sheet_id else {}),
        })
    if task_source_ref:
        source_refs.append({
            "type": "plugin_object",
            "source": _compact(task_source.get("kind"), 80),
            "ref": task_source_ref,
        })
    source_refs.extend(
        {
            "type": "source_version",
            "id": item.get("sourceVersionId"),
            "contentHash": item.get("contentHash"),
            "authorityTier": item.get("authorityTier"),
        }
        for item in list(candidate.get("sourceBindings") or [])
        if isinstance(item, Mapping) and item.get("sourceVersionId")
    )
    task, created = await create_learning_task(
        db,
        learner_id=learner_id,
        title=str(task_data.get("title") or "学习型工作任务"),
        objective=str(task_data.get("learningObjective") or "完成任务并提交可验收证据"),
        client_request_id=f"candidate-confirm:{candidate_id}",
        origin_kind="learning_task_candidate",
        created_by="learning_design_agent",
        status="queued",
        session_id=session_id,
        project_id=project_id,
        estimated_minutes=int(plan["estimated_minutes"]),
        preferred_skills=["evidence_grounded_teaching", "practice_verification"],
        source_refs=source_refs,
        success_criteria=[str(item) for item in list(task_data.get("successCriteria") or [])],
        use_model_planner=False,
        plan_override=plan,
    )
    if created:
        task.artifact_refs = [{
            "type": "learning_task_candidate",
            "id": candidate_id,
            "schema_version": candidate.get("schemaVersion"),
            "root_hash": candidate_root_hash,
        }]
        task.review_handoff = {
            "candidateId": candidate_id,
            "sourceSnapshot": source_snapshot,
            "mappings": mappings,
            "assessment": assessment,
            "validatorVersion": validation.get("policyVersion"),
            "requiresDeterministicAssessment": True,
            "masteryUnchangedAtConfirmation": True,
        }
        task.action_log = [{
            "action": "candidate_confirmed",
            "confirmation_id": confirmation_id,
            "candidate_id": candidate_id,
            "root_hash": candidate_root_hash,
            "actor": "learner",
        }]
        await record_event(
            db,
            learner_id=learner_id,
            project_id=project_id,
            event_type="learning_task_candidate_confirmed",
            source="user",
            payload={
                "candidate_id": candidate_id,
                "learning_task_id": task.id,
                "root_hash": candidate_root_hash,
                "confirmation_id": confirmation_id,
                "mastery_claimed": False,
            },
            client_event_id=f"learning-task-candidate:{candidate_id}:confirmed",
        )
    return task, created


def candidate_evidence_view(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "candidateId": candidate.get("candidateId"),
        "groundingStatus": candidate.get("groundingStatus"),
        "sourceSnapshot": candidate.get("sourceSnapshot"),
        "sourceBindings": candidate.get("sourceBindings") or [],
        "citations": candidate.get("citations") or [],
        "coverage": dict(candidate.get("coverage") or {}).get("source") or {},
        "warnings": [
            item for item in list(candidate.get("warnings") or [])
            if isinstance(item, Mapping) and str(item.get("code") or "").startswith(("source", "ungrounded"))
        ],
        "authority": "candidate_source_binding_only",
        "masteryInference": False,
    }


def candidate_audit_view(candidate: Mapping[str, Any]) -> dict[str, Any]:
    validation = validate_candidate(candidate)
    return {
        "candidateId": candidate.get("candidateId"),
        "lifecycle": candidate.get("lifecycle"),
        "validation": validation,
        "coverage": candidate.get("coverage") or {},
        "warnings": candidate.get("warnings") or [],
        "provenance": candidate.get("provenance") or {},
        "formalLearningTaskCreated": False,
        "kernelWrites": 0,
    }


def candidate_handoff_view(candidate: Mapping[str, Any]) -> dict[str, Any]:
    validation = validate_candidate(candidate)
    task = dict(candidate.get("task") or {})
    mappings = dict(candidate.get("mappings") or {})
    knowledge_targets = list(mappings.get("knowledgeTargets") or [])
    resources: list[dict[str, Any]] = []
    seen_resources: set[tuple[str, str]] = set()
    for step in list(task.get("steps") or []):
        if not isinstance(step, Mapping):
            continue
        for resource in list(step.get("resources") or []):
            if not isinstance(resource, Mapping):
                continue
            key = (str(resource.get("id") or ""), str(resource.get("url") or ""))
            if key in seen_resources:
                continue
            seen_resources.add(key)
            resources.append(dict(resource))
    return {
        "schemaVersion": "learnflow.personalized-learning-handoff.v1",
        "candidateId": candidate.get("candidateId"),
        "status": "ready_for_tutor_review",
        "consumer": "Tutor",
        "requiresUserConfirmation": True,
        "knowledgeId": (
            str(knowledge_targets[0].get("id") or "")
            if knowledge_targets and isinstance(knowledge_targets[0], Mapping)
            else ""
        ),
        "taskSteps": list(task.get("steps") or []),
        "skills": list(mappings.get("skillTargets") or []),
        "resources": resources,
        "citations": list(candidate.get("citations") or []),
        "returnContract": {
            "schemaVersion": "learnflow.personalized-learning-return.v1",
            "allowedActions": ["review", "request_revision", "confirm_candidate"],
            "requires": ["user_confirmation", "learning_design_validation"],
            "kernelWritesBeforeConfirmation": 0,
        },
        "candidate": candidate,
        "validation": validation,
        "instruction": "Tutor 可据此解释、比较和追问；用户确认前不得创建正式 LearningTask 或写入掌握状态。",
        "formalLearningTaskCreated": False,
        "kernelWrites": 0,
    }


__all__ = [
    "CANDIDATE_SCHEMA_VERSION", "INTEGRATION_BUNDLE_SCHEMA_VERSION",
    "LearningTaskBundleGateway", "LearningTaskIntegrationError", "SourceSnapshot",
    "XingchenCredentials", "XingchenWorkflowClient", "XingchenHandoffGateway", "build_source_snapshot",
    "bundle_to_candidate", "candidate_audit_view", "candidate_evidence_view",
    "candidate_handoff_view", "generate_candidate", "load_xingchen_credentials",
    "confirm_candidate_as_learning_task", "read_candidate_artifact", "task_card_id_from_content", "workflow_end_output", "validate_candidate",
    "handoff_to_integration_bundle", "validate_integration_bundle",
]
