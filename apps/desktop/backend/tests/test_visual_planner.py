import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import EvidenceEvent


DESKTOP_TOKEN = "visual-planner-desktop-token"
HEADERS = {"X-LearnFlow-Desktop-Token": DESKTOP_TOKEN}


def _registration(username: str) -> dict:
    return {
        "username": username,
        "password": "learnflow-pass-123",
        "display_name": username,
        "education_stage": "undergraduate",
        "background": "Python 基础",
        "focus_areas": ["算法"],
        "weekly_hours": 5,
        "preferred_modes": ["explanation"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


async def _evidence_count() -> int:
    async with async_session() as db:
        return int((await db.execute(select(func.count(EvidenceEvent.id)))).scalar_one())


def test_desktop_visual_planner_is_narrow_scoped_and_uses_requested_budget(monkeypatch):
    calls: list[dict] = []

    class FakeCompletions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                model="visual-test-model",
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"kind":"diagram"}'))],
            )

    class FakeAsyncOpenAI:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", DESKTOP_TOKEN)
    monkeypatch.setattr(settings, "llm_api_key", "sk-visual-test")
    monkeypatch.setattr(settings, "llm_base_url", "https://provider.example/v1")
    monkeypatch.setattr(settings, "llm_model", "visual-test-model")
    monkeypatch.setattr("openai.AsyncOpenAI", FakeAsyncOpenAI)

    with TestClient(app) as client:
        registered = client.post("/api/auth/register", headers=HEADERS, json=_registration("visual_planner_owner"))
        assert registered.status_code == 200, registered.text
        session = client.post("/api/agent/sessions", headers=HEADERS, json={"session_type": "global"})
        assert session.status_code == 200, session.text
        evidence_before = asyncio.run(_evidence_count())
        response = client.post(
            f"/api/agent/sessions/{session.json()['id']}/visual-plans",
            headers=HEADERS,
            json={
                "instructions": "只输出严格的 LearnFlow VisualSpec JSON，不得输出代码或解释。",
                "input": "画一个编译器前端结构图",
                "timeout_ms": 720_000,
                "max_tokens": 32_768,
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["text"] == '{"kind":"diagram"}'
        assert asyncio.run(_evidence_count()) == evidence_before

    assert len(calls) == 1
    assert calls[0]["timeout"] == 720
    assert calls[0]["max_tokens"] == 32_768
    assert calls[0]["response_format"] == {"type": "json_object"}
    assert calls[0]["messages"][0]["role"] == "system"
    assert calls[0]["messages"][1]["content"] == "画一个编译器前端结构图"


def test_visual_planner_bridge_is_hidden_outside_desktop(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", False)
    monkeypatch.setattr(settings, "desktop_token", "")
    with TestClient(app) as client:
        registered = client.post("/api/auth/register", json=_registration("visual_planner_browser"))
        assert registered.status_code == 200, registered.text
        session = client.post("/api/agent/sessions", json={"session_type": "global"})
        assert session.status_code == 200, session.text
        response = client.post(
            f"/api/agent/sessions/{session.json()['id']}/visual-plans",
            json={"instructions": "只输出一个合法的 VisualSpec JSON 对象。", "input": "画图"},
        )
        assert response.status_code == 404
