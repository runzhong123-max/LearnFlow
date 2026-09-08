"""Per-process cloud sessions. Cloud cookies never reach the local webview.

The shell chooses one HTTPS authority. This adapter never converts a local
learner into a cloud learner, stores passwords, or retries mutations.
"""
from __future__ import annotations

import asyncio
import secrets
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.config import settings
from app.services.auth import valid_desktop_request

router = APIRouter()
MAX_BODY = 32 * 1024 * 1024


def cloud_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"}):
        raise ValueError("云端地址必须是 HTTPS 站点地址")
    return value.rstrip("/")


@dataclass
class CloudSession:
    client: httpx.AsyncClient
    csrf: str = ""
    learner_id: int = 0


class CloudConnection:
    def __init__(self, origin: str, transport=None):
        self.origin = cloud_origin(origin)
        self.transport = transport
        self.sessions: dict[str, CloudSession] = {}
        self.pet_handles: dict[str, tuple[str, float]] = {}
        self.login_lock = asyncio.Lock()

    def client(self):
        return httpx.AsyncClient(base_url=self.origin, follow_redirects=False,
                                trust_env=False, transport=self.transport,
                                timeout=httpx.Timeout(900, connect=15),
                                headers={"Origin": self.origin, "Referer": self.origin + "/"})

    async def close(self):
        sessions, self.sessions = self.sessions, {}
        self.pet_handles.clear()
        for session in sessions.values():
            await session.client.aclose()

    async def forward(self, request: Request, path: str):
        if not valid_desktop_request(request):
            return JSONResponse({"detail": "仅允许本机 LearnFlow 客户端连接"}, 403)
        if any(part in {".", ".."} for part in path.split("/")) or "\\" in path or path.startswith("/"):
            return JSONResponse({"detail": "无效 API 路径"}, 400)
        if path.startswith("dev/") or "/internal/" in "/" + path:
            return JSONResponse({"detail": "此接口不向桌面客户端开放"}, 403)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                return JSONResponse({"detail": "单次上传不能超过 32 MiB"}, 413)
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        pet = token.startswith('lfpet_')
        if pet:
            parent, expiry = self.pet_handles.get(token, ('', 0))
            token = parent if expiry > time.monotonic() else ''
            allowed = (request.method == 'GET' and (path in {'pet/bootstrap', 'auth/status'}
                       or re.fullmatch(r'agent/sessions(?:/\d+)?', path))) or (
                       request.method == 'POST' and (path == 'agent/sessions' or re.fullmatch(r'agent/sessions/\d+/turns', path)))
            if not allowed:
                return JSONResponse({'detail': '桌宠无权执行此操作，请在主窗口操作'}, 403)
        session = self.sessions.get(token)
        if path in {"auth/login", "auth/register"} and request.method == "POST":
            async with self.login_lock:
                client = self.client()
                try:
                    response = await client.post("/api/" + path, content=bytes(body),
                                                 headers={"Content-Type": "application/json"})
                    if response.status_code != 200:
                        await client.aclose()
                        return JSONResponse(response.json(), response.status_code)
                    account = response.json()
                    if not isinstance(account.get("learner_id"), int):
                        raise ValueError("云端未返回有效学习者身份")
                    # A successful account switch revokes every local handle.
                    await self.close()
                    handle = secrets.token_urlsafe(48)
                    self.sessions[handle] = CloudSession(client, learner_id=account["learner_id"])
                    pet_handle = 'lfpet_cloud_' + secrets.token_urlsafe(48)
                    self.pet_handles[pet_handle] = (handle, time.monotonic() + 600)
                    account["desktop_auth_token"] = handle
                    account['desktop_pet_capability_token'] = pet_handle
                    account["identity_authority"] = self.origin
                    return JSONResponse(account, headers={"Cache-Control": "no-store"})
                except (httpx.HTTPError, ValueError):
                    await client.aclose()
                    return JSONResponse({"detail": "无法连接云端认证服务，请检查网络后重试；不会改用本地账号"}, 503)
        if session is None:
            if path == "auth/status":
                return JSONResponse({"authenticated": False, "identity_authority": self.origin})
            if path == "demo/status":
                return JSONResponse({"enabled": False})
            return JSONResponse({"detail": "请使用网页端同一账号登录"}, 401)
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() in {"accept", "content-type", "range", "if-none-match"}}
        try:
            if path == 'auth/desktop-pet-capability' and request.method == 'POST' and not pet:
                for key, value in list(self.pet_handles.items()):
                    if value[0] == token:
                        del self.pet_handles[key]
                handle = 'lfpet_cloud_' + secrets.token_urlsafe(48)
                self.pet_handles[handle] = (token, time.monotonic() + 600)
                return JSONResponse({'desktop_pet_capability_token': handle})
            if path == 'pet/bootstrap' and request.method == 'GET':
                account = await session.client.get('/api/auth/me')
                if account.status_code != 200:
                    return JSONResponse({'detail': '请在主窗口重新登录'}, 401)
                sessions = await session.client.get('/api/agent/sessions?limit=30')
                value = sessions.json() if sessions.status_code == 200 else []
                reviews = await session.client.get('/api/review/summary')
                if reviews.status_code != 200:
                    return JSONResponse({'detail': '云端复习信息暂不可用'}, 503)
                tasks = await session.client.get('/api/learning-tasks?limit=6')
                task_value = tasks.json() if tasks.status_code == 200 else []
                return JSONResponse({'authority': 'formal_learnflow_objects',
                    'learner': {'id': session.learner_id, 'display_name': account.json().get('display_name', '')},
                    'capability': {'scopes': ['pet.bootstrap.read', 'pet.session.read', 'pet.tutor.turn'], 'expires_at': None},
                    'sessions': value if isinstance(value, list) else value.get('sessions', []),
                    'tasks': task_value if isinstance(task_value, list) else task_value.get('tasks', []),
                    'review': {'due': reviews.json()['due'], 'focus_subjects': [], 'mastery_unchanged': True},
                    'model': {'configured': True, 'status': 'ready'}})
            conversion = re.fullmatch(r'desktop/conversions/([A-Za-z0-9_-]{32,128})/import', path)
            if conversion and request.method == 'POST' and not pet:
                from app.services.cloud_conversion_import import import_handoff
                return await import_handoff(session, self.origin, conversion[1], bytes(body))
            device = re.fullmatch(r'projects/(\d+)/(workspace|experiments|local-agent)/(.*)', path)
            if device and not pet:
                from app.services.cloud_device import device_request
                return await device_request(session, self.origin, int(device[1]), device[2], device[3], request.method, bytes(body))
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if not session.csrf:
                    csrf = await session.client.get("/api/auth/csrf")
                    if csrf.status_code != 200:
                        return JSONResponse({"detail": "云端会话已过期，请重新登录"}, 401)
                    session.csrf = csrf.json()["csrf_token"]
                headers["X-CSRF-Token"] = session.csrf
            url = "/api/" + path
            if request.url.query:
                url += "?" + request.url.query
            upstream = await session.client.send(session.client.build_request(
                request.method, url, content=bytes(body), headers=headers), stream=True)
            if 300 <= upstream.status_code < 400:
                await upstream.aclose()
                return JSONResponse({"detail": "云端 API 返回了不允许的重定向"}, 502)
            response_headers = {k: v for k, v in upstream.headers.items()
                                if k.lower() in {"content-type", "content-disposition", "retry-after", "etag", "content-range"}}
            response_headers["Cache-Control"] = "no-store"

            async def chunks():
                try:
                    async for chunk in upstream.aiter_bytes():
                        yield chunk
                finally:
                    await upstream.aclose()
                    if path == "auth/logout" or upstream.status_code == 401:
                        self.sessions.pop(token, None)
                        await session.client.aclose()

            return StreamingResponse(chunks(), status_code=upstream.status_code, headers=response_headers)
        except (httpx.HTTPError, ValueError, KeyError):
            if path == 'auth/logout':
                self.sessions.pop(token, None)
                await session.client.aclose()
            return JSONResponse({"detail": "云端连接中断。请检查网络；提交结果请刷新确认后再重试"}, 503)


_connection: CloudConnection | None = None


def connection():
    global _connection
    if _connection is None:
        _connection = CloudConnection(settings.cloud_platform_url)
    return _connection


@router.api_route("/cloud/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
async def cloud_api(request: Request, path: str):
    return await connection().forward(request, path)
