import asyncio
from copy import deepcopy
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import EvidenceEvent, KernelMutation
from app.models.project import Checkpoint, DomainKnowledgePacket, Project, Roadmap
from app.services.micro_learning import _ground_artifact_in_packet
from app.services.topic_primers import NAIVE_BAYES
from app.services.auth import AccountModelProviderConfig


def _register(client):
    result = client.post("/api/auth/register", json={
        "username": f"file-upgrade-{uuid.uuid4().hex[:10]}", "password": "learnflow-pass-123",
        "display_name": "文件共学", "education_stage": "undergraduate", "background": "Python 基础",
        "focus_areas": ["计算机"], "weekly_hours": 6, "preferred_modes": ["practice"], "career_goal": "",
        "career_goal_status": "exploring",
    })
    assert result.status_code == 200, result.text
    return result.json()["learner_id"]


def _task(client, **scope):
    result = client.post("/api/learning-tasks", json={
        "title": "朴素贝叶斯", "objective": "解释分类分数、条件独立与平滑", "estimated_minutes": 20,
        "client_request_id": uuid.uuid4().hex, **scope,
    })
    assert result.status_code == 200, result.text
    return result.json()


def _generate(client, task, kinds, request_id=None):
    payload = {"file_kinds": kinds, "expected_version": task["version"],
        "client_request_id": request_id or uuid.uuid4().hex}
    response = client.post(f"/api/learning-files/tasks/{task['id']}/generate", json=payload)
    assert response.status_code == 200, response.text
    return response.json(), payload


def test_files_fill_only_requested_missing_kind_and_replay_without_scope_drift():
    with TestClient(app) as client:
        learner_id = _register(client)
        task = _task(client)
        practice_only, _ = _generate(client, task, ["practice"])
        assert practice_only["file_generation"]["generated_kinds"] == ["practice"]
        assert practice_only["project_id"] is None and practice_only["checkpoint_id"] is None
        assert practice_only["micro_learning_run_id"] is None
        assert all(ref["type"] != "managed_lecture" for ref in practice_only["artifact_refs"])
        original_questions = next(ref["ids"] for ref in practice_only["artifact_refs"] if ref["type"] == "concept_question_set")

        paired, request = _generate(client, practice_only, ["lecture", "practice"])
        assert paired["file_generation"]["generated_kinds"] == ["lecture"]
        assert paired["file_generation"]["reused_kinds"] == ["practice"]
        assert next(ref["ids"] for ref in paired["artifact_refs"] if ref["type"] == "concept_question_set") == original_questions
        lecture_ref = next(ref for ref in paired["artifact_refs"] if ref["type"] == "managed_lecture")
        lecture = client.get(f"/api/learning-files/lecture/{lecture_ref['id']}").json()
        assert len(lecture["sections"]) >= 4
        assert {section["role"] for section in lecture["sections"]} >= {"objective", "mechanism", "example", "boundary"}
        assert len({section["anchor"] for section in lecture["sections"]}) == len(lecture["sections"])
        assert all(section["source_refs"] for section in lecture["sections"])

        replay = client.post(f"/api/learning-files/tasks/{task['id']}/generate", json=request)
        assert replay.status_code == 200, replay.text
        assert replay.json()["version"] == paired["version"]
        assert replay.json()["artifact_refs"] == paired["artifact_refs"]
        changed_key = client.post(f"/api/learning-files/tasks/{task['id']}/generate", json={**request, "file_kinds": ["practice"]})
        assert changed_key.status_code == 409

        async def generated_events():
            async with async_session() as db:
                events = list((await db.execute(select(EvidenceEvent).where(EvidenceEvent.learner_id == learner_id))).scalars())
                file_ids = [event.id for event in events if event.event_type == "learning_file_generated"]
                mutations = list((await db.execute(select(KernelMutation).where(KernelMutation.event_id.in_(file_ids)))).scalars())
                return events, mutations
        events, mutations = asyncio.run(generated_events())
        assert not mutations
        assert not any(event.event_type == "micro_learning_started" for event in events)


def test_file_generation_uses_account_provider_when_global_key_is_unset(monkeypatch):
    captured = []

    async def generated_with_account_provider(**kwargs):
        captured.append(kwargs["provider_config"])
        return {**deepcopy(NAIVE_BAYES), "generation": {"mode": "model_enhanced"}}

    monkeypatch.setattr("learnflow_core.api.learning_files.model_credential_configured", lambda _account: True)
    monkeypatch.setattr(
        "learnflow_core.api.learning_files.account_model_provider_config",
        lambda _account: AccountModelProviderConfig(
            api_key="account-test-key", base_url="https://provider.example/v1", model="account-test-model",
        ),
    )
    monkeypatch.setattr("app.services.micro_learning.generate_micro_learning_artifact", generated_with_account_provider)
    with TestClient(app) as client:
        _register(client)
        task = _task(client)
        generated, _ = _generate(client, task, ["lecture", "practice"])

    assert generated["file_generation"]["status"] == "ready"
    assert captured == [AccountModelProviderConfig(
        api_key="account-test-key", base_url="https://provider.example/v1", model="account-test-model",
    )]


def test_existing_project_checkpoint_and_artifact_identity_survive_generation():
    with TestClient(app) as client:
        learner_id = _register(client)
        async def seed():
            async with async_session() as db:
                project = Project(learner_id=learner_id, name="原有统计项目", project_kind="learning", visibility="visible")
                db.add(project)
                await db.flush()
                roadmap = Roadmap(project_id=project.id)
                db.add(roadmap)
                await db.flush()
                checkpoint = Checkpoint(roadmap_id=roadmap.id, title="朴素贝叶斯", description="比较分类分数", order=1)
                db.add(checkpoint)
                await db.commit()
                return project.id, checkpoint.id
        project_id, checkpoint_id = asyncio.run(seed())
        task = _task(client, project_id=project_id, checkpoint_id=checkpoint_id)
        generated, _ = _generate(client, task, ["lecture", "practice"])
        assert generated["project_id"] == project_id
        assert generated["checkpoint_id"] == checkpoint_id
        assert generated["session_id"] == task["session_id"]
        reused, _ = _generate(client, generated, ["lecture", "practice"])
        assert reused["file_generation"]["generated_kinds"] == []
        assert reused["artifact_refs"] == generated["artifact_refs"]


def test_unknown_topic_does_not_publish_generic_learning_advice_as_subject_content():
    with TestClient(app) as client:
        _register(client)
        task = _task(client, title="虚构的蓝色转移定律", objective="分析尚未提供的具体学科机制")
        response = client.post(f"/api/learning-files/tasks/{task['id']}/generate", json={
            "source_text": "这是本次学习材料的说明，但没有提供学科机制、例子或可检查结论。",
            "expected_version": task["version"], "client_request_id": uuid.uuid4().hex,
        })
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["file_generation"]["status"] == "blocked"
        assert body["file_generation"]["gaps"]
        assert not body["artifact_refs"]


def test_packet_grounding_preserves_authored_subject_questions():
    artifact = deepcopy(NAIVE_BAYES)
    artifact["generation"] = {"mode": "model_enhanced"}
    before = deepcopy(artifact["questions"])
    packet = DomainKnowledgePacket(id=1, subject_key="朴素贝叶斯", input_fingerprint="packet-test",
        knowledge_units={"claims": [{"statement": point} for point in artifact["card"]["key_points"]]}, source_version_refs=[])
    grounded, _ = _ground_artifact_in_packet(artifact, "朴素贝叶斯", packet)
    assert grounded["questions"] == before


def test_practice_history_is_persisted_without_exposing_answers():
    with TestClient(app) as client:
        _register(client)
        generated, _ = _generate(client, _task(client), ["practice"])
        scope = generated["execution_state"]["artifact_scope"]
        practice_ref = f"questions-{scope['checkpoint_id']}"
        file = client.get(f"/api/learning-files/practice/{practice_ref}").json()
        question = file["questions"][0]
        assert question["attempt_count"] == 0
        response = client.post(f"/api/checkpoints/{scope['checkpoint_id']}/concepts/{question['id']}/submit", json={
            "answer_indexes": [3], "assistance_level": "none", "attempt_role": "original",
            "client_submission_id": uuid.uuid4().hex,
        })
        assert response.status_code == 200, response.text
        refreshed = client.get(f"/api/learning-files/practice/{practice_ref}").json()["questions"][0]
        assert refreshed["attempt_count"] == 1
        assert refreshed["latest_passed"] is False
        assert refreshed["remediation_case_id"]
        assert not {"answer_indexes", "expected_response", "explanation", "variant"} & refreshed.keys()


def test_program_linking_example_generates_real_content_and_varied_deterministic_questions():
    with TestClient(app) as client:
        _register(client)
        task = _task(client, title="我想学习程序的链接", objective="解释编译、符号解析和重定位")
        generated, _ = _generate(client, task, ["lecture", "practice"])
        assert generated["file_generation"]["status"] == "ready"
        assert generated["file_generation"]["generation"]["source"] == "curated.program_linking.v1"
        lecture_ref = next(ref for ref in generated["artifact_refs"] if ref["type"] == "managed_lecture")
        lecture = client.get(f"/api/learning-files/lecture/{lecture_ref['id']}").json()
        text = "\n".join(section["content"] for section in lecture["sections"])
        assert "main.o" in text and "add.o" in text and "重定位" in text
        scope = generated["execution_state"]["artifact_scope"]
        practice = client.get(f"/api/learning-files/practice/questions-{scope['checkpoint_id']}").json()
        assert len(practice["questions"]) == 3
        assert all("宣布掌握" not in " ".join(item["options"]) for item in practice["questions"])
        # Reloading the task queue must not create a duplicate task for its private artifact checkpoint.
        tasks = client.get("/api/learning-tasks").json()["items"]
        assert len([row for row in tasks if row["id"] == task["id"] or row.get("checkpoint_id") == scope["checkpoint_id"]]) == 1


def test_concurrent_generation_claims_task_version_before_creating_files():
    from app.models.learning import LearningTask
    from app.models.project import ConceptQuestion
    from learnflow_core.learning_file_generation import generate_task_files
    with TestClient(app) as client:
        _register(client)
        created = _task(client)
        async def race():
            async with async_session() as first_db, async_session() as second_db:
                first = await first_db.get(LearningTask, created["id"])
                second = await second_db.get(LearningTask, created["id"])
                async def generate(db, task, request_id):
                    try:
                        result = await generate_task_files(db, task=task, file_kinds=["practice"], source_text="",
                            expected_version=created["version"], client_request_id=request_id)
                        await db.commit()
                        return result["status"]
                    except RuntimeError as error:
                        await db.rollback()
                        return str(error)
                results = await asyncio.gather(generate(first_db, first, "first-window"), generate(second_db, second, "second-window"))
            async with async_session() as db:
                task = await db.get(LearningTask, created["id"])
                checkpoint_id = task.execution_state["artifact_scope"]["checkpoint_id"]
                count = len(list((await db.execute(select(ConceptQuestion).where(ConceptQuestion.checkpoint_id == checkpoint_id))).scalars()))
            return results, count
        results, count = asyncio.run(race())
        assert sorted(results) == ["ready", "version_conflict"]
        assert count == len(NAIVE_BAYES["questions"])
