import asyncio
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import EvidenceEvent, KernelMutation, LearningAttempt
from app.models.project import Checkpoint
from app.services.architecture_registry import EVENTS
from app.services.learning_tasks import (
    _attempt_is_verification_evidence,
    _fallback_plan,
    _portable_planner_context,
    generate_learning_task_plan,
)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield test_client


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def _create(client: TestClient, title: str = "理解 Python 闭包") -> dict:
    response = client.post("/api/learning-tasks", json={
        "title": title,
        "objective": f"能够解释{title}并独立完成一道验证题",
        "estimated_minutes": 25,
        "preferred_skills": ["guided_explanation", "feynman_dialogue"],
        "client_request_id": _id("learning-task"),
    })
    assert response.status_code == 200, response.text
    return response.json()


def _action(client: TestClient, task: dict, action: str, phase_id: str = "") -> dict:
    response = client.post(f"/api/learning-tasks/{task['id']}/actions", json={
        "action": action,
        "phase_id": phase_id,
        "expected_version": task["version"],
        "client_action_id": _id(f"task-{action}"),
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_fallback_plan_uses_bounded_five_kernel_content():
    plan = _fallback_plan(
        title="理解指针",
        objective="能解释解引用并完成独立判断",
        origin_kind="conversation",
        estimated_minutes=35,
        learner_context={
            "human": {"cognitive_load": 0.85},
            "knowledge": {"knowledge_gap": "混淆指针变量与指向的值"},
            "value": {"current_priority": "完成 C 语言实验"},
            "practice": {"assistance_level": "guided"},
        },
    )
    assert plan["estimated_minutes"] == 20
    assert plan["phases"][0]["title"].startswith("分段")
    assert "混淆指针变量" in plan["phases"][0]["purpose"]
    assert "撤除提示" in plan["phases"][1]["purpose"]
    assert {item["kernel"] for item in plan["personalization_basis"]} == {
        "human", "knowledge", "value", "practice",
    }


def test_new_task_context_does_not_inherit_volatile_content_from_another_task():
    projection = {
        "structure": {"short_term": {"path_position": "Python 闭包纠错"}},
        "knowledge": {"short_term": {"knowledge_gap": "不理解闭包捕获"}},
        "human": {"short_term": {
            "cognitive_load": 0.9,
            "format_preference": "先图后文",
            "pace_preference": "分段",
        }},
        "value": {"short_term": {"current_priority": "完成闭包任务"}},
        "practice": {"short_term": {"assistance_level": "guided"}},
    }

    context = _portable_planner_context(projection)
    plan = _fallback_plan(
        title="弄懂 C 指针",
        objective="能够解释解引用并完成独立验证",
        origin_kind="conversation",
        estimated_minutes=20,
        learner_context=context,
    )

    assert context == {"human": {
        "format_preference": "先图后文",
        "pace_preference": "分段",
    }}
    assert "闭包" not in plan["summary"]
    assert "闭包" not in plan["phases"][0]["purpose"]
    assert plan["personalization_basis"] == [{
        "kernel": "human",
        "keys": ["format_preference", "pace_preference"],
    }]


def test_learning_task_planner_falls_back_within_interactive_budget(monkeypatch):
    class SlowModel:
        def __init__(self, **_kwargs):
            pass

        async def ainvoke(self, _messages):
            await asyncio.sleep(1)

    monkeypatch.setattr("app.services.learning_tasks.ChatOpenAI", SlowModel)
    monkeypatch.setattr("app.services.learning_tasks.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.learning_tasks.settings.learning_task_plan_model_budget_seconds",
        0.01,
    )

    started = time.perf_counter()
    plan = asyncio.run(generate_learning_task_plan(
        title="理解事件循环",
        objective="能够解释事件循环并完成独立验证",
        origin_kind="conversation",
        estimated_minutes=20,
    ))

    assert time.perf_counter() - started < 0.5
    assert plan["schema_version"] == "learning-task-plan.v1"
    assert {phase["kind"] for phase in plan["phases"]} >= {"learn", "verify"}


def test_verification_rejects_hints_diagnostics_retries_and_review_replays():
    def attempt(*, item_type="concept", role="original", assistance="none"):
        return LearningAttempt(
            item_type=item_type,
            attempt_role=role,
            assistance_level=assistance,
            result={"correct": True},
        )

    assert _attempt_is_verification_evidence(attempt()) is True
    assert _attempt_is_verification_evidence(attempt(assistance="hint")) is False
    assert _attempt_is_verification_evidence(attempt(item_type="teach_back", role="diagnostic")) is False
    assert _attempt_is_verification_evidence(attempt(role="retry")) is False
    assert _attempt_is_verification_evidence(attempt(role="review")) is False
    assert _attempt_is_verification_evidence(
        attempt(item_type="remediation_variant", role="variant")
    ) is True


def test_learning_task_creation_is_idempotent_and_plan_is_registered(client: TestClient):
    request_id = _id("idempotent-task")
    payload = {
        "title": "理解引用与指针",
        "objective": "能够区分引用与指针并完成独立判断题",
        "estimated_minutes": 30,
        "client_request_id": request_id,
    }
    first = client.post("/api/learning-tasks", json=payload)
    replay = client.post("/api/learning-tasks", json=payload)
    assert first.status_code == replay.status_code == 200
    assert first.json()["id"] == replay.json()["id"]
    body = first.json()
    assert body["status"] == "queued"
    assert body["navigation"] == {
        "kind": "task", "path": f"/tasks?task={body['id']}",
    }
    assert body["management_navigation"] == body["navigation"]
    assert body["origin_navigation"] == body["navigation"]
    assert body["plan"]["schema_version"] == "learning-task-plan.v1"
    assert {phase["kind"] for phase in body["plan"]["phases"]} >= {"learn", "verify"}
    assert body["plan_history"][0]["version"] == 1
    assert "不等于稳定掌握" in body["evidence_notice"]


def test_tutor_distinguishes_explicit_task_consent_from_recommendation(
    client: TestClient, monkeypatch,
):
    opportunity = {
        "should_propose": True,
        "consent_basis": "explicit_user_request",
        "title": "理解递归终止条件",
        "objective": "能解释终止条件并独立判断一个递归调用是否会结束",
        "estimated_minutes": 20,
        "suggested_skills": ["guided_explanation"],
        "success_criteria": ["完成一次独立判断"],
    }

    async def fake_reply(*_args, **_kwargs):
        return "我们就以这个目标开始。", [], None, None, [], None, opportunity

    monkeypatch.setattr("app.services.tutor_service._generate_tutor_reply", fake_reply)
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    explicit = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "带我学懂递归的终止条件",
        "client_turn_id": _id("explicit-task-turn"),
    })
    assert explicit.status_code == 200, explicit.text
    assert explicit.json()["learning_task_proposal"]["status"] == "active"
    assert explicit.json()["learning_task_proposal"]["origin_kind"] == "conversation"
    existing_id = explicit.json()["learning_task_proposal"]["id"]
    duplicate = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "帮我弄懂递归的终止条件",
        "client_turn_id": _id("same-explicit-task-turn"),
    })
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["learning_task_proposal"]["id"] == existing_id

    opportunity["consent_basis"] = "tutor_recommendation"
    recommendation_session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    recommendation = client.post(f"/api/agent/sessions/{recommendation_session['id']}/turns", json={
        "message": "递归好像还有些细节",
        "client_turn_id": _id("recommended-task-turn"),
    })
    assert recommendation.status_code == 200, recommendation.text
    assert recommendation.json()["learning_task_proposal"]["status"] == "proposed"


def test_task_is_resumable_but_verification_cannot_be_self_declared(client: TestClient):
    task = _action(client, _create(client), "start")
    assert "complete_phase" in task["available_actions"]
    assert "complete_task" not in task["available_actions"]
    task = _action(client, task, "complete_phase", "learn")
    fake_practice = client.post(f"/api/learning-tasks/{task['id']}/actions", json={
        "action": "complete_phase",
        "phase_id": "practice",
        "expected_version": task["version"],
        "client_action_id": _id("fake-practice"),
    })
    assert fake_practice.status_code == 409
    assert "真实作答" in fake_practice.json()["detail"]
    blocked = client.post(f"/api/learning-tasks/{task['id']}/actions", json={
        "action": "complete_phase",
        "phase_id": "verify",
        "expected_version": task["version"],
        "client_action_id": _id("fake-verify"),
    })
    assert blocked.status_code == 409
    assert "正式评估证据" in blocked.json()["detail"]

    paused = _action(client, task, "pause")
    assert paused["status"] == "paused"
    resumed = _action(client, paused, "resume")
    assert resumed["status"] == "active"


def test_explicit_atomic_request_persists_and_teaches_in_dialogue(
    client: TestClient, monkeypatch,
):
    model_calls = []

    async def model_reply_for_follow_up(*_args, **_kwargs):
        model_calls.append(True)
        return "我们继续沿着这个任务讨论。", [], None, None, [], None, None

    async def planner_must_not_block_explicit_task(*_args, **_kwargs):
        raise AssertionError("explicit atomic task should use the immediate fallback plan")

    monkeypatch.setattr(
        "app.services.tutor_service._generate_tutor_reply",
        model_reply_for_follow_up,
    )
    monkeypatch.setattr(
        "app.services.learning_tasks.generate_learning_task_plan",
        planner_must_not_block_explicit_task,
    )
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    first = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "带我弄懂 Python 闭包为什么会捕获外层变量",
        "client_turn_id": _id("offline-atomic-turn"),
    })
    assert first.status_code == 200, first.text
    task = first.json()["learning_task_proposal"]
    assert task["status"] == "active"
    assert task["navigation"] == {
        "kind": "conversation", "path": f"/agent/{session['id']}",
    }
    assert task["origin_navigation"] == task["navigation"]
    assert task["management_navigation"] == {
        "kind": "task", "path": f"/tasks?task={task['id']}",
    }
    assert task["runtime"]["next_action"]["id"] == "prepare_materials"
    assert first.json()["learning_tasks"][0]["id"] == task["id"]
    assert len(model_calls) == 1

    follow_up = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "我先想知道变量是在定义时还是调用时决定的",
        "client_turn_id": _id("offline-atomic-follow-up"),
    })
    assert follow_up.status_code == 200, follow_up.text
    assert len(model_calls) == 2
    assert follow_up.json()["learning_task_proposal"] is None
    assert follow_up.json()["learning_tasks"][0]["id"] == task["id"]
    current = follow_up.json()["learning_tasks"][0]
    prepared = client.post(f"/api/learning-tasks/{task['id']}/materialize", json={
        "expected_version": current["version"],
        "client_request_id": _id("conversation-task-materialize"),
    })
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["navigation"] == {
        "kind": "conversation", "path": f"/agent/{session['id']}",
    }
    assert prepared.json()["origin_navigation"] == {
        "kind": "conversation", "path": f"/agent/{session['id']}",
    }
    learning_run = client.get(
        f"/api/micro-learning/runs/{prepared.json()['micro_learning_run_id']}"
    ).json()
    assert "闭包" in learning_run["source_excerpt"]
    assert learning_run["learning_task"]["navigation"] == {
        "kind": "conversation", "path": f"/agent/{session['id']}",
    }
    assert learning_run["learning_task"]["origin_navigation"] == {
        "kind": "conversation", "path": f"/agent/{session['id']}",
    }
    assert learning_run["learning_task"]["management_navigation"]["path"] == (
        f"/tasks?task={task['id']}"
    )
    restored = client.get(f"/api/agent/sessions/{session['id']}")
    assert restored.status_code == 200
    assert restored.json()["learning_tasks"][0]["id"] == task["id"]


def test_task_can_materialize_saved_lecture_and_questions(client: TestClient):
    task = _create(client, "理解事件循环")
    request_id = _id("materialize")
    payload = {
        "source_text": "事件循环按队列调度任务。微任务会在下一个宏任务前清空。",
        "expected_version": task["version"],
        "client_request_id": request_id,
    }
    response = client.post(f"/api/learning-tasks/{task['id']}/materialize", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "active"
    assert body["micro_learning_run_id"]
    assert body["checkpoint_id"]
    assert body["navigation"]["kind"] == "focused_learning"
    assert any(item["type"] == "managed_lecture" for item in body["artifact_refs"])
    assert any(item["type"] == "concept_question_set" for item in body["artifact_refs"])
    assert body["runtime"]["materials"]["status"] == "ready"
    assert body["runtime"]["next_action"]["id"] == "continue_learning"
    assert body["runtime"]["learning_flow"] == {
        "kind": "focused_learning",
        "state": "learning_card",
        "active_state": "learning_card",
        "status": "active",
        "completed_items": 0,
        "total_items": len(next(
            item["ids"] for item in body["artifact_refs"]
            if item["type"] == "concept_question_set"
        )),
    }
    replay = client.post(f"/api/learning-tasks/{task['id']}/materialize", json=payload)
    assert replay.status_code == 200
    assert replay.json()["id"] == body["id"]
    assert replay.json()["version"] == body["version"]
    run = client.get(f"/api/micro-learning/runs/{body['micro_learning_run_id']}").json()
    viewed = client.post(f"/api/micro-learning/runs/{run['id']}/advance", json={
        "action": "complete_card",
        "expected_version": run["version"],
        "client_action_id": _id("task-card-viewed"),
    })
    assert viewed.status_code == 200, viewed.text
    assert viewed.json()["learning_task"]["current_phase_id"] == "practice"
    after_view = client.get(f"/api/learning-tasks/{body['id']}").json()
    assert after_view["runtime"]["learning_flow"]["state"] == "teach_back"
    assert after_view["runtime"]["learning_flow"]["active_state"] == "teach_back"

    async def event_routes():
        async with async_session() as db:
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.checkpoint_id == body["checkpoint_id"],
            ))).scalars().all())
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_([event.id for event in events]),
            ))).scalars().all())
            by_event: dict[int, set[str]] = {}
            for mutation in mutations:
                by_event.setdefault(mutation.event_id, set()).add(mutation.kernel_name)
            return {event.event_type: by_event.get(event.id, set()) for event in events}

    routes = asyncio.run(event_routes())
    assert routes["learning_task_materialized"] == set()
    assert routes["learning_card_generated"] == set()
    assert routes["micro_learning_started"] == {"structure", "value"}
    assert routes["micro_learning_card_viewed"] == {"knowledge"}
    current_task = client.get(f"/api/learning-tasks/{body['id']}").json()
    paused_task = _action(client, current_task, "pause")
    assert paused_task["status"] == "paused"
    assert paused_task["runtime"]["learning_flow"]["state"] == "paused"
    assert paused_task["runtime"]["learning_flow"]["active_state"] == "teach_back"
    assert client.get(
        f"/api/micro-learning/runs/{body['micro_learning_run_id']}"
    ).json()["status"] == "paused"
    resumed_task = _action(client, paused_task, "resume")
    assert resumed_task["status"] == "active"
    assert client.get(
        f"/api/micro-learning/runs/{body['micro_learning_run_id']}"
    ).json()["status"] == "active"
    visible_projects = client.get("/api/projects")
    assert visible_projects.status_code == 200
    assert body["project_id"] not in {item["id"] for item in visible_projects.json()}


def test_checkpoint_status_cannot_bypass_task_attempt_and_review_gates(client: TestClient):
    task = _create(client, "验证任务阶段边界")
    prepared = client.post(f"/api/learning-tasks/{task['id']}/materialize", json={
        "source_text": "本材料只用于验证任务阶段边界。",
        "expected_version": task["version"],
        "client_request_id": _id("checkpoint-status-boundary"),
    })
    assert prepared.status_code == 200, prepared.text
    body = prepared.json()

    async def mark_checkpoint_completed():
        async with async_session() as db:
            checkpoint = await db.get(Checkpoint, body["checkpoint_id"])
            checkpoint.learning_status = "completed"
            checkpoint.completed = True
            await db.commit()

    asyncio.run(mark_checkpoint_completed())
    reconciled = client.get(f"/api/learning-tasks/{task['id']}")
    assert reconciled.status_code == 200
    current = reconciled.json()
    assert current["status"] == "active"
    assert current["runtime"]["evidence"]["practice_attempts"] == 0
    assert current["runtime"]["evidence"]["successful_verifications"] == 0
    assert current["runtime"]["evidence"]["review_items"] == 0


def test_queue_reorder_and_remove_are_learner_controlled(client: TestClient):
    first = _create(client, "任务队列 A")
    second = _create(client, "任务队列 B")
    reorder_request_id = _id("task-reorder")
    reorder_payload = {
        "task_ids": [second["id"], first["id"]],
        "client_request_id": reorder_request_id,
    }
    reordered = client.post("/api/learning-tasks/reorder", json=reorder_payload)
    assert reordered.status_code == 200, reordered.text
    assert [item["id"] for item in reordered.json()["items"]] == [second["id"], first["id"]]
    replay = client.post("/api/learning-tasks/reorder", json=reorder_payload)
    assert replay.status_code == 200
    assert [item["version"] for item in replay.json()["items"]] == [
        item["version"] for item in reordered.json()["items"]
    ]
    canceled = _action(client, reordered.json()["items"][0], "cancel")
    assert canceled["status"] == "canceled"
    reopened = _action(client, canceled, "reopen")
    assert reopened["status"] == "queued"


def test_learning_task_lifecycle_is_operational_not_kernel_evidence(client: TestClient):
    summary = client.get("/api/learning-tasks/summary")
    assert summary.status_code == 200
    assert {item["id"] for item in summary.json()["queues"]} == {"learning", "review"}
    for event_type in {
        "learning_task_created", "learning_task_accepted", "learning_task_replanned",
        "learning_task_started", "learning_task_paused", "learning_task_resumed",
        "learning_task_phase_completed", "learning_task_materialized",
        "learning_task_completed", "learning_task_canceled",
    }:
        assert EVENTS[event_type].kernel_targets == ()
