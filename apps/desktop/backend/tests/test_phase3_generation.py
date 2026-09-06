import asyncio
from types import SimpleNamespace
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.api.tasks import task_events
from app.db.database import async_session
from app.main import app
from app.models.learning import Learner
from app.models.project import Checkpoint, Lecture, Project, Roadmap, Task
from app.services.lecture_agent import normalize_lecture_section_titles, resolve_lecture_section_title
from app.services.execution_policy import EXECUTION_ENV_VAR, EXECUTION_POLICY_VAR
from app.services.task_manager import manager, update_task
from app.services import task_runners


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield test_client


async def _seed_checkpoint() -> tuple[int, int]:
    async with async_session() as db:
        learner_id = (await db.execute(select(Learner.id).where(
            Learner.key == "local-default",
        ))).scalar_one()
        suffix = uuid.uuid4().hex[:8]
        project = Project(
            learner_id=learner_id,
            name=f"phase3-generation-{suffix}",
            description="generation route regression test",
        )
        db.add(project)
        await db.flush()
        roadmap = Roadmap(project_id=project.id, raw_json={})
        db.add(roadmap)
        await db.flush()
        checkpoint = Checkpoint(
            roadmap_id=roadmap.id,
            title="Generation checkpoint",
            order=1,
            prerequisites=[],
            learning_status="in_progress",
        )
        db.add(checkpoint)
        await db.commit()
        return checkpoint.id, learner_id


def test_concept_and_exercise_generation_routes_create_owned_tasks(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    checkpoint_id, learner_id = asyncio.run(_seed_checkpoint())
    monkeypatch.setattr(settings, "llm_api_key", "test-api-key")

    def submit(_task_id, coroutine):
        coroutine.close()
        return None

    monkeypatch.setattr(manager, "submit", submit)

    concept = client.post(f"/api/checkpoints/{checkpoint_id}/concepts/generate")
    exercise = client.post(f"/api/checkpoints/{checkpoint_id}/exercises/generate")

    assert concept.status_code == 200, concept.text
    assert exercise.status_code == 200, exercise.text
    assert concept.json()["status"] == "queued"
    assert exercise.json()["status"] == "queued"

    async def load_tasks():
        async with async_session() as db:
            return list((await db.execute(
                select(Task).where(Task.checkpoint_id == checkpoint_id).order_by(Task.id)
            )).scalars().all())

    tasks = asyncio.run(load_tasks())
    assert [task.type for task in tasks] == ["concept_generate", "exercise_generate"]
    assert all(task.learner_id == learner_id for task in tasks)


def test_task_event_stream_releases_sqlite_reads_before_background_writes():
    """An active SSE subscription must not lock task-runner progress updates."""

    async def exercise_stream():
        checkpoint_id, learner_id = await _seed_checkpoint()
        async with async_session() as db:
            task = Task(
                learner_id=learner_id,
                checkpoint_id=checkpoint_id,
                type="concept_generate",
                status="running",
                payload={"checkpoint_id": checkpoint_id},
                progress={"message": "排队中..."},
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)
            task_id = task.id

            current = SimpleNamespace(learner=SimpleNamespace(id=learner_id))
            response = await task_events(task_id, current, db)

            # The dependency-scoped ownership-check session outlives the SSE
            # response, so the endpoint must explicitly release its read txn.
            assert not db.in_transaction()

            stream = response.body_iterator
            first_event = await anext(stream)
            assert f'"task_id": {task_id}' in first_event

            updated = await asyncio.wait_for(
                update_task(
                    task_id,
                    progress={"current": 1, "total": 1, "message": "完成"},
                ),
                timeout=5,
            )
            await stream.aclose()
            return updated

    updated = asyncio.run(exercise_stream())
    assert updated is not None
    assert updated.progress["message"] == "完成"


def test_exercise_generation_refuses_model_code_verification_by_default(monkeypatch):
    checkpoint_id, learner_id = asyncio.run(_seed_checkpoint())
    monkeypatch.delenv(EXECUTION_ENV_VAR, raising=False)
    monkeypatch.delenv(EXECUTION_POLICY_VAR, raising=False)

    async def forbidden_context(*args, **kwargs):
        raise AssertionError("disabled policy must fail before model/content work")

    monkeypatch.setattr(task_runners, "_load_lecture_context", forbidden_context)

    async def scenario():
        async with async_session() as db:
            task = Task(
                learner_id=learner_id,
                checkpoint_id=checkpoint_id,
                type="exercise_generate",
                status="queued",
                payload={"checkpoint_id": checkpoint_id},
                progress={},
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)
            task_id = task.id
        await task_runners.run_exercise_generation(task_id)
        async with async_session() as db:
            stored = await db.get(Task, task_id)
            return stored.status, dict(stored.error or {}), dict(stored.result or {})

    status, error, result = asyncio.run(scenario())
    assert status == "failed"
    assert error["code"] == "code_execution_unsupported"
    assert error["execution_boundary"] == "not_executed"
    assert result["status"] == "unsupported"


def test_singleton_source_filename_uses_checkpoint_title_for_display():
    section = {
        "title": "ch03.ipynb",
        "content": "因果注意力正文",
        "source_file": "ch03/01_main-chapter-code/ch03.ipynb",
        "source_heading": "",
    }

    assert resolve_lecture_section_title(
        "因果自注意力与多头注意力",
        section["title"],
        source_file=section["source_file"],
        source_heading=section["source_heading"],
        section_count=1,
    ) == "因果自注意力与多头注意力"

    normalized = normalize_lecture_section_titles(
        "因果自注意力与多头注意力", [section],
    )
    assert normalized[0]["title"] == "因果自注意力与多头注意力"
    assert normalized[0]["source_file"] == section["source_file"]
    assert section["title"] == "ch03.ipynb"


def test_explicit_or_multi_section_titles_are_preserved():
    assert resolve_lecture_section_title(
        "自注意力核心",
        "3.3 自注意力计算",
        source_file="ch03.ipynb",
        source_heading="3.3 自注意力计算",
        section_count=1,
    ) == "3.3 自注意力计算"
    assert resolve_lecture_section_title(
        "自注意力核心",
        "ch03.ipynb",
        source_file="ch03.ipynb",
        section_count=2,
    ) == "ch03.ipynb"


def test_lecture_api_normalizes_legacy_singleton_filename_title(client: TestClient):
    checkpoint_id, _learner_id = asyncio.run(_seed_checkpoint())

    async def seed_lecture():
        async with async_session() as db:
            db.add(Lecture(
                checkpoint_id=checkpoint_id,
                status="published",
                sections=[{
                    "title": "ch03.ipynb",
                    "content": "因果注意力正文",
                    "source_file": "ch03/01_main-chapter-code/ch03.ipynb",
                    "source_heading": "",
                }],
            ))
            await db.commit()

    asyncio.run(seed_lecture())
    response = client.get(f"/api/checkpoints/{checkpoint_id}/lecture")

    assert response.status_code == 200, response.text
    assert response.json()["sections"][0]["title"] == "Generation checkpoint"
    assert response.json()["sections"][0]["source_file"].endswith("ch03.ipynb")
