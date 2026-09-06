import asyncio
import base64
from io import BytesIO
from types import SimpleNamespace

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import DesktopPetContextPackage
from app.services.auth import AccountModelProviderConfig
from app.services.desktop_pet_vision import (
    _selection_text_from_response,
    normalize_desktop_pet_image,
    transcribe_desktop_pet_selection,
)


DESKTOP_TOKEN = "desktop-pet-vision-test-token"
HEADERS = {"X-LearnFlow-Desktop-Token": DESKTOP_TOKEN}
BROWSER_HEADERS = {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}

def registration(username: str) -> dict:
    return {
        "username": username,
        "password": "LearnFlow-安全密码-2026!",
        "display_name": username,
        "education_stage": "undergraduate",
        "background": "Python 基础",
        "focus_areas": ["图像理解"],
        "weekly_hours": 5,
        "preferred_modes": ["explanation"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


def png_bytes() -> bytes:
    image = Image.new("RGBA", (24, 16), (255, 255, 255, 0))
    image.putpixel((2, 2), (18, 92, 192, 255))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_desktop_pet_image_normalization_rejects_invalid_and_removes_alpha():
    normalized = normalize_desktop_pet_image(png_bytes())
    assert normalized.mime_type == "image/jpeg"
    assert normalized.data.startswith(b"\xff\xd8")

    try:
        normalize_desktop_pet_image(b"not an image")
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 422
    else:
        raise AssertionError("invalid image was accepted")


def test_desktop_pet_selection_text_parser_preserves_mixed_text_and_rejects_missing_text():
    assert _selection_text_from_response(
        '{"text":"是否允许桌宠自动执行一次\\nCtrl+C？"}',
    ) == "是否允许桌宠自动执行一次\nCtrl+C？"
    assert _selection_text_from_response('{"text":""}') == ""


def test_desktop_pet_selection_transcription_uses_strict_text_prompt(monkeypatch):
    calls: list[dict] = []

    class FakeCompletions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=(
                '{"text":"选中的中文 English 123"}'
            )))])

    class FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self):
            return None

    monkeypatch.setattr("app.services.desktop_pet_vision.AsyncOpenAI", FakeAsyncOpenAI)
    result = asyncio.run(transcribe_desktop_pet_selection(
        normalize_desktop_pet_image(png_bytes()),
        provider_config=AccountModelProviderConfig("key", "https://provider.example/v1", "vision-test"),
    ))
    assert result == "选中的中文 English 123"
    assert calls[0]["temperature"] == 0
    assert "高亮选区" in calls[0]["messages"][0]["content"]


def test_desktop_pet_selection_endpoint_accepts_capability_scope(monkeypatch):
    from starlette.requests import Request

    from app.services.auth import _required_desktop_pet_scope

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/pet/selection-text",
        "headers": [],
        "query_string": b"",
        "server": ("testserver", 80),
        "client": ("testclient", 50000),
        "scheme": "http",
    }
    assert _required_desktop_pet_scope(Request(scope)) == "pet.context.write"


def test_desktop_pet_selection_endpoint_accepts_capability_token(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", DESKTOP_TOKEN)
    monkeypatch.setattr("app.api.pet.model_credential_configured", lambda account: True)
    monkeypatch.setattr("app.api.pet.account_vision_provider_config", lambda account: object())
    monkeypatch.setattr(
        "app.api.pet.transcribe_desktop_pet_selection",
        lambda image, provider_config: asyncio.sleep(0, result="选区文字"),
    )

    with TestClient(app) as raw_client:
        issued = raw_client.post(
            "/api/auth/register",
            headers={"X-LearnFlow-Desktop-Token": DESKTOP_TOKEN},
            json=registration("pet_selection_endpoint"),
        )
        assert issued.status_code == 200, issued.text
        capability = issued.json()["desktop_pet_capability_token"]
        response = raw_client.post(
            "/api/pet/selection-text",
            headers={
                "X-LearnFlow-Desktop-Token": DESKTOP_TOKEN,
                "Authorization": f"Bearer {capability}",
            },
            files={"file": ("selection.png", png_bytes(), "image/png")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["text"] == "选区文字"


def test_desktop_pet_image_context_is_idempotent_and_ttl_only(monkeypatch):
    calls: list[dict] = []

    class FakeCompletions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=(
                '{"schema_version":"learnflow.image-observation.v1",'
                '"image_type":"diagram","visible_text":["输入 x"],'
                '"formulas":["y=x+1"],"visual_relations":["箭头指向输出"],'
                '"key_details":["蓝色节点"],"uncertainties":[]}'
            )))])

    class FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self):
            return None

    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", DESKTOP_TOKEN)
    monkeypatch.setattr(
        settings,
        "auth_api_key_kek",
        base64.urlsafe_b64encode(b"V" * 32).decode().rstrip("="),
    )
    monkeypatch.setattr("app.services.desktop_pet_vision.AsyncOpenAI", FakeAsyncOpenAI)

    with TestClient(app) as raw_client:
        raw_client.headers.update(BROWSER_HEADERS)
        issued = raw_client.post(
            "/api/auth/register",
            headers=HEADERS,
            json=registration("desktop_pet_image_owner"),
        )
        assert issued.status_code == 200, issued.text
        bearer = issued.json()["desktop_auth_token"]
        capability = issued.json()["desktop_pet_capability_token"]
        csrf = raw_client.get("/api/auth/csrf", headers=HEADERS).json()["csrf_token"]
        configured = raw_client.put(
            "/api/auth/model-credential",
            headers={
                **HEADERS,
                "Authorization": f"Bearer {bearer}",
                "X-CSRF-Token": csrf,
            },
            json={
                "api_key": "sk-vision-test-key",
                "base_url": "https://provider.example/v1",
                "model": "vision-test-model",
            },
        )
        assert configured.status_code == 200, configured.text

        pet_headers = {**HEADERS, "Authorization": f"Bearer {capability}"}
        request_id = "desktop-pet-image:stable-request-001"
        payload = {
            "file": ("attached-image.png", png_bytes(), "image/png"),
            "question_hint": (None, "请解释图中的关系"),
            "client_context_id": (None, request_id),
        }
        first = raw_client.post("/api/pet/context-packages/image", headers=pet_headers, files=payload)
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["kind"] == "image_observation"
        assert body["requires_confirmation"] is True
        assert body["source_label"] == "用户主动附加的图片视觉观察 · attached-image.png"
        assert "输入 x" in body["preview"]

        second = raw_client.post("/api/pet/context-packages/image", headers=pet_headers, files=payload)
        assert second.status_code == 200, second.text
        assert second.json()["id"] == body["id"]

    async def package_snapshot():
        async with async_session() as db:
            package = (await db.execute(select(DesktopPetContextPackage).where(
                DesktopPetContextPackage.id == body["id"],
            ))).scalar_one()
            return package.kind, package.content, package.client_context_id, package.source

    kind, content, client_context_id, source = asyncio.run(package_snapshot())
    assert kind == "image_observation"
    assert client_context_id == request_id
    assert "data:image" not in str(content)
    assert "base64" not in str(content)
    assert source["untrusted"] is True
    assert len(calls) == 1
    message_content = calls[0]["messages"][1]["content"]
    assert message_content[1]["type"] == "image_url"
    assert message_content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
