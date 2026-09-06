import asyncio
import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import (
    EvidenceEvent, KernelState, MicroLearningRun, ReviewSchedule,
)
from app.models.project import ConceptQuestion
from app.services.micro_learning import (
    _valid_question,
    analyze_teach_back,
    generate_micro_learning_artifact,
)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield test_client


def _request_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def test_teach_back_does_not_reward_repeating_only_the_topic_name():
    analysis = analyze_teach_back("贝叶斯更新，贝叶斯更新就是贝叶斯更新。", {
        "target_concepts": ["贝叶斯更新"],
        "key_points": [
            "说明贝叶斯更新如何结合先验与似然。",
            "解释新证据为什么会改变后验判断。",
            "用一个医疗检测情境展示更新过程。",
        ],
        "common_confusion": "似然不等于后验。",
    })
    assert analysis["coverage_ratio"] < 0.5
    assert analysis["mastery_unchanged"] is True


def test_generated_questions_reject_runtime_specific_or_nonstandard_trivia():
    assert _valid_question({
        "q_type": "single",
        "question": "修改 add5.__closure__[0].cell_contents 后会怎样？",
        "options": ["改变闭包", "保持不变"],
        "answer_indexes": [0],
        "explanation": "这依赖解释器内部 cell_contents。",
        "variant": {
            "type": "concept_choice",
            "validated": True,
            "prompt": "在 CPython 的另一个版本中会怎样？",
            "options": ["A", "B"],
            "answer_indexes": [0],
        },
    }) is None


def test_micro_learning_generation_falls_back_within_interactive_budget(monkeypatch):
    class SlowModel:
        def __init__(self, **_kwargs):
            pass

        async def ainvoke(self, _messages):
            await asyncio.sleep(1)

    monkeypatch.setattr("app.services.micro_learning.ChatOpenAI", SlowModel)
    monkeypatch.setattr("app.services.micro_learning.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.micro_learning.settings.micro_learning_artifact_model_budget_seconds",
        0.01,
    )

    started = time.perf_counter()
    artifact = asyncio.run(generate_micro_learning_artifact(
        goal="理解条件概率",
        source_text="",
        education_stage="本科",
        background="计算机专业",
    ))

    assert time.perf_counter() - started < 0.5
    assert artifact["generation"]["mode"] == "deterministic_fallback"
    assert artifact["generation"]["reason"] == "budget_exceeded"
    assert artifact["generation"]["source"] == "curated.conditional_probability.v1"
    assert "先验" in artifact["card"]["objective"]
    assert any("P(A|B)" in point for point in artifact["card"]["key_points"])
    assert len(artifact["questions"]) >= 2


def test_naive_bayes_offline_primer_contains_teachable_content(monkeypatch):
    monkeypatch.setattr("app.services.micro_learning.settings.llm_api_key", "")
    artifact = asyncio.run(generate_micro_learning_artifact(
        goal="跟我讲讲什么是朴素贝叶斯分类器",
        source_text="",
        education_stage="本科",
        background="计算机专业",
    ))

    assert artifact["generation"]["source"] == "curated.naive_bayes.v1"
    assert artifact["card"]["title"] == "朴素贝叶斯分类器：用概率比较类别"
    assert any("条件独立" in point for point in artifact["card"]["key_points"])
    assert any("拉普拉斯平滑" in point for point in artifact["card"]["key_points"])
    assert all("只要读过材料" not in question["question"] for question in artifact["questions"])


def test_generic_fallback_cannot_enter_evidence_workflow(monkeypatch, client: TestClient):
    monkeypatch.setattr("app.services.micro_learning.settings.llm_api_key", "")
    created = client.post("/api/micro-learning/runs", json={
        "goal": "理解 Python 装饰器如何包装函数",
        "source_text": "",
        "client_request_id": _request_id("generic-quality-gate"),
    })
    assert created.status_code == 409, created.text
    assert "领域知识覆盖不足" in created.json()["detail"]

    # The knowledge gate now rejects the artifact before persistence instead
    # of creating a generic card that can never enter the evidence workflow.
    runs = client.get("/api/micro-learning/runs")
    assert runs.status_code == 200
    assert all(
        item["goal"] != "理解 Python 装饰器如何包装函数"
        for item in runs.json()["items"]
    )


def test_learning_card_can_be_regenerated_before_evidence(monkeypatch, client: TestClient):
    monkeypatch.setattr("app.services.micro_learning.settings.llm_api_key", "")
    created = client.post("/api/micro-learning/runs", json={
        "goal": "跟我讲讲什么是朴素贝叶斯分类器",
        "source_text": "",
        "client_request_id": _request_id("naive-bayes-regenerate"),
    })
    assert created.status_code == 200, created.text
    run = created.json()
    task_id = run["learning_task"]["id"]
    question_ids = [item["id"] for item in run["questions"]]
    request_id = _request_id("regenerate-card")

    regenerated = client.post(f"/api/micro-learning/runs/{run['id']}/regenerate", json={
        "expected_version": run["version"],
        "client_request_id": request_id,
    })
    assert regenerated.status_code == 200, regenerated.text
    body = regenerated.json()
    assert body["id"] == run["id"]
    assert body["learning_task"]["id"] == task_id
    assert body["learning_card"]["generation_source"] == "curated.naive_bayes.v1"
    assert [item["id"] for item in body["questions"]][:len(question_ids)] == question_ids

    replay = client.post(f"/api/micro-learning/runs/{run['id']}/regenerate", json={
        "expected_version": run["version"],
        "client_request_id": request_id,
    })
    assert replay.status_code == 200, replay.text
    assert replay.json()["version"] == body["version"]

    advanced = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "complete_card",
        "expected_version": body["version"],
        "client_action_id": _request_id("regenerated-card-viewed"),
    })
    assert advanced.status_code == 200, advanced.text
    blocked = client.post(f"/api/micro-learning/runs/{run['id']}/regenerate", json={
        "expected_version": advanced.json()["version"],
        "client_request_id": _request_id("regenerate-after-evidence"),
    })
    assert blocked.status_code == 409


def _start(client: TestClient, *, request_id: str | None = None) -> dict:
    response = client.post("/api/micro-learning/runs", json={
        "goal": "理解条件概率与贝叶斯更新",
        "source_text": (
            "条件概率描述在已知事件发生时另一事件的概率。\n"
            "贝叶斯公式把先验概率、似然和证据概率联系起来。\n"
            "得到新证据后，应当用后验概率更新判断。\n"
            "先验不是最终结论，似然也不等于后验。"
        ),
        "client_request_id": request_id or _request_id("micro-start"),
    })
    assert response.status_code == 200, response.text
    return response.json()


def _advance_to_verification(client: TestClient, run: dict) -> dict:
    card_action = _request_id("card")
    card = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "complete_card",
        "expected_version": run["version"],
        "client_action_id": card_action,
    })
    assert card.status_code == 200, card.text
    teach_back = client.post(f"/api/micro-learning/runs/{run['id']}/teach-back", json={
        "response": "条件概率是在已有信息下重新限定样本空间；贝叶斯更新会结合先验、似然和新证据得到后验判断。",
        "expected_version": card.json()["version"],
        "client_submission_id": _request_id("teach-back"),
    })
    assert teach_back.status_code == 200, teach_back.text
    assert teach_back.json()["teach_back"]["mastery_unchanged"] is True
    verification = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "continue_after_feedback",
        "expected_version": teach_back.json()["version"],
        "client_action_id": _request_id("continue"),
    })
    assert verification.status_code == 200, verification.text
    assert verification.json()["state"] == "verification"
    assert verification.json()["learning_task"]["current_phase_id"] == "verify"
    return verification.json()


async def _answers(question_ids: list[int]) -> dict[int, list[int]]:
    async with async_session() as db:
        rows = list((await db.execute(select(ConceptQuestion).where(
            ConceptQuestion.id.in_(question_ids),
        ))).scalars().all())
        return {row.id: list(row.answer_indexes or []) for row in rows}


def test_create_run_is_idempotent_and_answer_free(client: TestClient):
    request_id = _request_id("idempotent-start")
    first = _start(client, request_id=request_id)
    replay = _start(client, request_id=request_id)
    assert replay["id"] == first["id"]
    assert first["state"] == "learning_card"
    assert len(first["questions"]) >= 2
    assert "answer_indexes" not in json.dumps(first["questions"], ensure_ascii=False)
    assert first["learning_card"]["key_points"]

    paused = client.post(f"/api/micro-learning/runs/{first['id']}/advance", json={
        "action": "pause",
        "expected_version": first["version"],
        "client_action_id": _request_id("pause"),
    })
    assert paused.status_code == 200
    assert paused.json()["state"] == "paused"
    assert paused.json()["learning_task"]["status"] == "paused"
    resumed = client.post(f"/api/micro-learning/runs/{first['id']}/advance", json={
        "action": "resume",
        "expected_version": paused.json()["version"],
        "client_action_id": _request_id("resume"),
    })
    assert resumed.status_code == 200
    assert resumed.json()["state"] == "learning_card"
    assert resumed.json()["learning_task"]["status"] == "active"


def test_card_teach_back_verification_and_review_close_the_loop(client: TestClient):
    run = _advance_to_verification(client, _start(client))
    question_ids = [item["id"] for item in run["questions"]]
    answers = asyncio.run(_answers(question_ids))

    for index, question_id in enumerate(question_ids):
        grade = client.post(
            f"/api/checkpoints/{run['checkpoint_id']}/concepts/{question_id}/submit",
            json={
                "answer_indexes": answers[question_id],
                "assistance_level": "none",
                "client_submission_id": _request_id(f"answer-{index}"),
            },
        )
        assert grade.status_code == 200, grade.text
        assert grade.json()["correct"] is True
        sync = client.post(f"/api/micro-learning/runs/{run['id']}/sync", json={
            "expected_version": run["version"],
            "client_action_id": _request_id(f"sync-{index}"),
        })
        assert sync.status_code == 200, sync.text
        run = sync.json()
        if index == 0 and len(question_ids) > 1:
            current_task = client.get(
                f"/api/learning-tasks/{run['learning_task']['id']}"
            ).json()
            premature = client.post(
                f"/api/learning-tasks/{current_task['id']}/actions",
                json={
                    "action": "complete_task",
                    "expected_version": current_task["version"],
                    "client_action_id": _request_id("premature-task-complete"),
                },
            )
            assert premature.status_code == 409
            assert "完成整组学习与验证" in premature.json()["detail"]

    assert run["status"] == "completed"
    assert run["summary"]["mastery_claim"] == "not_stable_yet"
    assert set(run["summary"]["independently_verified_question_ids"]) == set(question_ids)
    assert run["summary"]["review_schedule_ids"]
    assert run["learning_task"]["status"] == "completed"
    assert run["learning_task"]["current_phase_id"] == ""
    assert any(
        item.get("type") == "managed_lecture"
        for item in run["learning_task"]["artifact_refs"]
    )

    async def stored_evidence():
        async with async_session() as db:
            persisted = await db.get(MicroLearningRun, run["id"])
            schedules = list((await db.execute(select(ReviewSchedule).where(
                ReviewSchedule.item_id.in_(question_ids),
            ))).scalars().all())
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.checkpoint_id == run["checkpoint_id"],
            ))).scalars().all())
            knowledge = (await db.execute(select(KernelState).where(
                KernelState.learner_id == persisted.learner_id,
                KernelState.kernel_name == "knowledge",
            ))).scalar_one()
            return persisted, schedules, events, knowledge

    persisted, schedules, events, knowledge = asyncio.run(stored_evidence())
    assert persisted.status == "completed"
    assert len(schedules) == len(question_ids)
    event_types = [event.event_type for event in events]
    assert "micro_learning_started" in event_types
    assert "micro_learning_card_viewed" in event_types
    assert "teach_back_analyzed" in event_types
    assert "micro_learning_completed" in event_types
    assert (knowledge.short_term or {})["teach_back_diagnostic"]["attempt_id"]
    assert f"checkpoint:{run['checkpoint_id']}" not in (
        (knowledge.long_term or {}).get("mastery") or {}
    )


def test_wrong_answer_moves_the_run_into_existing_remediation(client: TestClient):
    run = _advance_to_verification(client, _start(client))
    question = run["current_question"]
    correct = asyncio.run(_answers([question["id"]]))[question["id"]]
    wrong_index = next(index for index in range(len(question["options"])) if index not in correct)
    grade = client.post(
        f"/api/checkpoints/{run['checkpoint_id']}/concepts/{question['id']}/submit",
        json={
            "answer_indexes": [wrong_index],
            "assistance_level": "none",
            "client_submission_id": _request_id("wrong"),
        },
    )
    assert grade.status_code == 200, grade.text
    assert grade.json()["correct"] is False
    assert grade.json()["remediation"]["status"] == "explaining"

    synced = client.post(f"/api/micro-learning/runs/{run['id']}/sync", json={
        "expected_version": run["version"],
        "client_action_id": _request_id("wrong-sync"),
    })
    assert synced.status_code == 200, synced.text
    body = synced.json()
    assert body["state"] == "remediation"
    assert body["remediation"]["strategy"]["decision_owner"] == "deterministic_policy"
    assert "answer_indexes" not in json.dumps(body["remediation"], ensure_ascii=False)

    retry = client.post(
        f"/api/checkpoints/{run['checkpoint_id']}/concepts/{question['id']}/submit",
        json={
            "answer_indexes": correct,
            "assistance_level": "guided",
            "remediation_case_id": body["remediation"]["id"],
            "attempt_role": "retry",
            "client_submission_id": _request_id("retry"),
        },
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["remediation"]["status"] == "variant_ready"

    async def variant_answers() -> list[int]:
        async with async_session() as db:
            stored = await db.get(ConceptQuestion, question["id"])
            return list((stored.assessment_meta or {})["variant"]["answer_indexes"])

    variant = client.post(
        f"/api/remediation/{body['remediation']['id']}/variant/submit",
        json={"answer_indexes": asyncio.run(variant_answers())},
    )
    assert variant.status_code == 200, variant.text
    assert variant.json()["remediation"]["status"] == "completed"

    resumed = client.post(f"/api/micro-learning/runs/{run['id']}/sync", json={
        "expected_version": body["version"],
        "client_action_id": _request_id("remediation-completed-sync"),
    })
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["state"] == "verification"
    assert resumed.json()["verification"]["results"][str(question["id"])]["status"] == "remediated"
    assert resumed.json()["current_question"]["id"] != question["id"]


def test_run_scope_and_optimistic_version_are_enforced(client: TestClient):
    run = _start(client)
    blank_goal = client.post("/api/micro-learning/runs", json={
        "goal": "   ",
        "source_text": "",
        "client_request_id": _request_id("blank-goal"),
    })
    assert blank_goal.status_code == 422
    stale = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "complete_card",
        "expected_version": run["version"] + 100,
        "client_action_id": _request_id("stale"),
    })
    assert stale.status_code == 409
    blank_action_id = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "complete_card",
        "expected_version": run["version"],
        "client_action_id": "        ",
    })
    assert blank_action_id.status_code == 422
    assert client.get("/api/micro-learning/runs/99999999").status_code == 404


def test_global_tutor_can_start_the_registered_micro_learning_action(client: TestClient):
    session = client.post("/api/agent/sessions", json={"session_type": "global"})
    assert session.status_code == 200
    turn = client.post(f"/api/agent/sessions/{session.json()['id']}/turns", json={
        "message": "用15分钟弄懂边际成本",
        "client_turn_id": _request_id("tutor-turn"),
    })
    assert turn.status_code == 200, turn.text
    action = turn.json()["executed_action"]
    assert action["status"] == "completed"
    assert action["result"]["navigate_to_learning_run"] is True
    assert action["result"]["learning_run"]["goal"] == "边际成本"


def test_checkpoint_tutor_does_not_hijack_start_learning_as_a_new_micro_run(client: TestClient):
    run = _start(client)
    turn = client.post(f"/api/agent/sessions/{run['session_id']}/turns", json={
        "message": "开始学习当前内容",
        "client_turn_id": _request_id("checkpoint-turn"),
    })
    assert turn.status_code == 200, turn.text
    executed = turn.json().get("executed_action") or {}
    assert executed.get("capability") != "start_micro_learning"


def test_micro_learning_runs_are_isolated_between_learners(client: TestClient):
    run = _start(client)
    accounts = client.get("/api/dev/accounts").json()
    legacy_id = next(item["id"] for item in accounts if item["username"] == "legacy-demo")
    username = f"micro_{uuid.uuid4().hex[:10]}"
    registered = client.post("/api/auth/register", json={
        "username": username,
        "password": "safe-test-password",
        "display_name": "隔离测试学习者",
        "education_stage": "working",
        "background": "用于学习流程隔离测试",
        "focus_areas": ["测试"],
        "weekly_hours": 3,
        "preferred_modes": ["explanation"],
        "career_goal": "",
        "career_goal_status": "exploring",
    })
    assert registered.status_code == 200, registered.text
    assert client.get(f"/api/micro-learning/runs/{run['id']}").status_code == 404
    assert all(
        item["id"] != run["id"]
        for item in client.get("/api/micro-learning/runs").json()["items"]
    )
    assert client.post(f"/api/dev/accounts/{legacy_id}/login").status_code == 200
    assert client.get(f"/api/micro-learning/runs/{run['id']}").status_code == 200
