from __future__ import annotations

import asyncio
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.project import Source


def _registration(username: str) -> dict:
    return {
        "username": username,
        "password": "learnflow-pass-123",
        "display_name": username,
        "education_stage": "undergraduate",
        "background": "Python 基础",
        "focus_areas": ["工程实践"],
        "weekly_hours": 5,
        "preferred_modes": ["explanation", "practice"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


def test_uploaded_reference_file_stays_outside_project_workspace(tmp_path, monkeypatch):
    upload_root = tmp_path / "source-uploads"
    cache_root = tmp_path / "source-cache"
    workspace_root = tmp_path / "project-workspace"
    workspace_root.mkdir()
    monkeypatch.setattr(settings, "source_uploads_dir", str(upload_root))
    monkeypatch.setattr(settings, "source_cache_dir", str(cache_root))

    with TestClient(app) as client:
        username = f"upload_boundary_{uuid.uuid4().hex[:10]}"
        registered = client.post("/api/auth/register", json=_registration(username))
        assert registered.status_code == 200, registered.text
        project_response = client.post(
            "/api/projects",
            json={"name": "参考来源边界", "description": "", "user_level": "beginner"},
        )
        assert project_response.status_code == 200, project_response.text
        project = project_response.json()

        uploaded = client.post(
            f"/api/projects/{project['id']}/sources/upload",
            files={"file": ("notes?.md", b"# Reference\n\nThis is uploaded reference content for chunking.\n", "text/markdown")},
        )
        assert uploaded.status_code == 200, uploaded.text
        source = uploaded.json()
        assert source["type"] == "file"
        assert source["url"] == "notes?.md"

        processed = client.post(
            f"/api/projects/{project['id']}/sources/{source['id']}/process"
        )
        assert processed.status_code == 200, processed.text
        assert processed.json()["chunk_count"] > 0

        assert (upload_root / str(registered.json()["learner_id"]) / str(project["id"]) / str(source["id"]) / "notes?.md").is_file()
        assert (cache_root / str(source["id"])).is_dir()
        assert not (workspace_root / "notes?.md").exists()


def test_project_source_upload_uses_the_same_format_safety_gate(tmp_path, monkeypatch):
    upload_root = tmp_path / "source-uploads"
    monkeypatch.setattr(settings, "source_uploads_dir", str(upload_root))

    with TestClient(app) as client:
        username = f"upload_format_gate_{uuid.uuid4().hex[:10]}"
        registered = client.post("/api/auth/register", json=_registration(username))
        assert registered.status_code == 200, registered.text
        project_response = client.post(
            "/api/projects",
            json={"name": "来源格式安全门", "description": "", "user_level": "beginner"},
        )
        assert project_response.status_code == 200, project_response.text
        project = project_response.json()

        rejected = client.post(
            f"/api/projects/{project['id']}/sources/upload",
            files={"file": (".env", b"API_KEY=secret\n", "text/plain")},
        )

        assert rejected.status_code == 415, rejected.text
        detail = rejected.json()["detail"]
        assert detail["code"] == "secret_file_rejected"
        assert not upload_root.exists() or not any(upload_root.rglob(".env"))


def test_project_and_library_url_entrypoints_share_the_source_locator():
    with TestClient(app) as client:
        username = f"source_locator_{uuid.uuid4().hex[:10]}"
        registered = client.post("/api/auth/register", json=_registration(username))
        assert registered.status_code == 200, registered.text
        project_response = client.post(
            "/api/projects",
            json={"name": "安全来源", "description": "", "user_level": "beginner"},
        )
        assert project_response.status_code == 200, project_response.text
        project = project_response.json()

        for unsafe_url in (
            "http://127.0.0.1/private",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/private",
            "https://user:secret@example.com/private",
            "file:///etc/passwd",
        ):
            project_rejection = client.post(
                f"/api/projects/{project['id']}/sources",
                json={"type": "url", "url": unsafe_url},
            )
            library_rejection = client.post(
                "/api/knowledge-library/sources/url",
                json={"url": unsafe_url},
            )
            assert project_rejection.status_code == 422, project_rejection.text
            assert library_rejection.status_code == 400, library_rejection.text

        public_source = client.post(
            f"/api/projects/{project['id']}/sources",
            json={"type": "url", "url": "https://example.com:443/lesson#intro"},
        )
        assert public_source.status_code == 200, public_source.text
        assert public_source.json()["url"] == "https://example.com/lesson"
        assert public_source.json()["type"] == "url"

        github_source = client.post(
            "/api/knowledge-library/sources/url",
            json={"url": "https://github.com/OpenAI/openai-python.git"},
        )
        assert github_source.status_code == 200, github_source.text
        assert github_source.json()["url"] == "https://github.com/OpenAI/openai-python"
        assert github_source.json()["type"] == "github"


def test_processing_legacy_dangerous_source_rows_fails_closed():
    with TestClient(app) as client:
        username = f"legacy_source_{uuid.uuid4().hex[:10]}"
        registered = client.post("/api/auth/register", json=_registration(username))
        assert registered.status_code == 200, registered.text
        project_response = client.post(
            "/api/projects",
            json={"name": "旧来源隔离", "description": "", "user_level": "beginner"},
        )
        assert project_response.status_code == 200, project_response.text
        project_id = project_response.json()["id"]

        async def seed_legacy_rows() -> tuple[int, int]:
            async with async_session() as db:
                unsafe_git = Source(
                    project_id=project_id,
                    type="github",
                    url="file:///tmp/private-repository",
                )
                unsafe_file = Source(
                    project_id=project_id,
                    type="file",
                    url="/etc/passwd",
                )
                db.add_all([unsafe_git, unsafe_file])
                await db.commit()
                await db.refresh(unsafe_git)
                await db.refresh(unsafe_file)
                return unsafe_git.id, unsafe_file.id

        unsafe_git_id, unsafe_file_id = asyncio.run(seed_legacy_rows())
        git_result = client.post(
            f"/api/projects/{project_id}/sources/{unsafe_git_id}/process",
        )
        file_result = client.post(
            f"/api/projects/{project_id}/sources/{unsafe_file_id}/process",
        )

        assert git_result.status_code == 400, git_result.text
        assert git_result.json()["detail"]["code"] == "unsafe_git_location"
        assert file_result.status_code == 400, file_result.text
        assert file_result.json()["detail"]["code"] == "unmanaged_file_source"
