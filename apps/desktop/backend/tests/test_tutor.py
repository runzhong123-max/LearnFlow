import asyncio
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.db.database import async_session, init_db
from app.models.learning import (
    AgentMessage, AgentSession, EvidenceEvent, KernelMutation, KernelState,
    LearningProjectProposal, LearningSkillRun, LearningTask, MicroLearningRun, SchemaMigration,
)
from app.models.project import (
    Project, Source, Chunk, Roadmap, Checkpoint, CheckpointChunk, Lecture, Exercise,
    ProjectWorkspace,
)
from app.services.learning_runtime import (
    apply_semantic_observations, create_attempt, evaluate_checkpoint_status,
    get_kernel_projection, record_event,
)
from app.services.learning_skill_runtime import (
    SKILL_RUNTIME_VERSION,
    SUPPORT_TURN_BUDGET,
    learner_response_signal,
    transition_learning_skill_turn,
)
from app.services.learning_tasks import create_learning_task, ensure_checkpoint_learning_task
from app.services.profile import memory_projection
from app.services.task_manager import manager
from app.services.auth import load_current_learner
from app.services.roadmap_agent import RoadmapAgent, SubmittedRoadmap
from app.services.tutor_service import _decode_tutor_content, get_or_create_session
from app.services.checkpoint_context import build_checkpoint_tutor_context
from app.services.task_runners import _repair_markdown_fences
from app.services import project_proposals as proposal_service
from app.api.phase1 import _roadmap_planning_context


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        csrf = test_client.get("/api/auth/csrf")
        assert csrf.status_code == 200
        test_client.headers["x-csrf-token"] = csrf.json()["csrf_token"]
        yield test_client


@pytest.fixture
def no_background_tasks(monkeypatch):
    def submit(_task_id, coroutine):
        coroutine.close()
        return None
    monkeypatch.setattr(manager, "submit", submit)


def new_session(client: TestClient, *, create_new: bool = True) -> int:
    response = client.post("/api/agent/sessions", json={
        "session_type": "global",
        "create_new": create_new,
    })
    assert response.status_code == 200
    return response.json()["id"]


def test_chat_modes_drive_definition_atomic_task_and_long_plan(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")

    explanation_session = new_session(client)
    explanation = client.post(
        f"/api/agent/sessions/{explanation_session}/turns",
        json={"message": "跟我讲讲什么是朴素贝叶斯分类器"},
    )
    assert explanation.status_code == 200
    explanation_body = explanation.json()
    assert explanation_body["chat_mode"]["id"] == "explain"
    assert explanation_body["chat_mode"]["status"] == "completed"
    assert explanation_body["learning_tasks"] == []

    learning_session = new_session(client)
    learning = client.post(
        f"/api/agent/sessions/{learning_session}/turns",
        json={"message": "带我弄懂朴素贝叶斯分类器"},
    )
    assert learning.status_code == 200
    learning_body = learning.json()
    assert learning_body["chat_mode"]["id"] == "learn"
    assert learning_body["learning_task_proposal"]["status"] == "active"
    assert learning_body["learning_task_proposal"]["navigation"] == {
        "kind": "conversation",
        "path": f"/agent/{learning_session}",
    }

    async def clear_legacy_mode_state():
        async with async_session() as db:
            session = await db.get(AgentSession, learning_session)
            session.context_summary = {}
            await db.commit()

    asyncio.run(clear_legacy_mode_state())
    restored_learning = client.get(f"/api/agent/sessions/{learning_session}")
    assert restored_learning.status_code == 200
    assert restored_learning.json()["chat_mode"]["id"] == "learn"
    assert restored_learning.json()["chat_mode"]["reason"] == "恢复仍在进行的原子学习任务"

    selected_text_session = new_session(client)
    selected_text_learning = client.post(
        f"/api/agent/sessions/{selected_text_session}/turns",
        json={
            "message": "带我深入理解我选中的这段内容，并安排一次练习与验证。",
            "context": {
                "selected_text": "装饰器会接收函数并返回一个包装后的可调用对象。",
                "interaction": "selected_text_question",
            },
        },
    )
    assert selected_text_learning.status_code == 200
    selected_body = selected_text_learning.json()
    assert selected_body["chat_mode"]["id"] == "learn"
    assert selected_body["learning_task_proposal"]["status"] == "active"
    assert "装饰器会接收函数" in selected_body["learning_task_proposal"]["objective"]
    assert selected_body["learning_task_proposal"]["navigation"] == {
        "kind": "conversation",
        "path": f"/agent/{selected_text_session}",
    }

    planning_session = new_session(client)
    planning = client.post(
        f"/api/agent/sessions/{planning_session}/turns",
        json={"message": "帮我规划从零开始系统学习操作系统的长期路线"},
    )
    assert planning.status_code == 200
    assert planning.json()["chat_mode"]["id"] == "plan"
    restored_plan = client.get(f"/api/agent/sessions/{planning_session}")
    assert restored_plan.status_code == 200
    assert restored_plan.json()["chat_mode"]["id"] == "plan"

    modes = client.get("/api/agent/modes")
    assert modes.status_code == 200
    assert [item["id"] for item in modes.json()] == [
        "free", "explain", "learn", "plan",
    ]

    async def projected_action():
        async with async_session() as db:
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == explanation_session,
                EvidenceEvent.event_type == "learning_action_segment_completed",
            ))).scalar_one()
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
            ))).scalars().all())
            return event, mutations

    event, mutations = asyncio.run(projected_action())
    assert event.payload["mode"] == "explain"
    assert event.payload["content_exposure"] is True
    assert {item.kernel_name for item in mutations} == {"structure", "knowledge"}
    knowledge = next(item for item in mutations if item.kernel_name == "knowledge")
    assert knowledge.patch["short_term"]["mastery_unchanged"] is True


def test_independent_global_chats_invoke_registered_session_skills(client: TestClient):
    first = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    })
    second = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    })
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] != second.json()["id"]

    skills = client.get("/api/agent/skills")
    assert skills.status_code == 200
    assert {item["id"] for item in skills.json()} == {
        "guided_explanation", "socratic_dialogue", "feynman_dialogue",
        "worked_example_fading", "learning_file_study",
    }

    turn = client.post(f"/api/agent/sessions/{first.json()['id']}/turns", json={
        "message": "带我学习边际成本",
        "selected_skill_id": "feynman_dialogue",
        "client_turn_id": f"skill-turn-{uuid.uuid4().hex}",
    })
    assert turn.status_code == 200, turn.text
    assert turn.json()["executed_action"] is None
    assert turn.json()["active_skill"]["id"] == "feynman_dialogue"
    assert turn.json()["session_title"].startswith("带我学习边际成本")

    restored = client.get(f"/api/agent/sessions/{first.json()['id']}").json()
    untouched = client.get(f"/api/agent/sessions/{second.json()['id']}").json()
    assert restored["active_skill"]["name"] == "费曼复述"
    assert untouched["active_skill"] is None
    assert untouched["messages"] == []
    listed = client.get("/api/agent/sessions", params={"session_type": "global"})
    assert listed.status_code == 200
    assert {first.json()["id"], second.json()["id"]} <= {
        item["id"] for item in listed.json()
    }

    invalid = client.post(f"/api/agent/sessions/{second.json()['id']}/turns", json={
        "message": "测试不存在的方法",
        "selected_skill_id": "imaginary_skill",
    })
    assert invalid.status_code == 400


def test_checkpoint_session_creation_recovers_the_unique_scope_winner(client: TestClient):
    async def exercise_conflict_path():
        async with async_session() as db:
            project = Project(
                learner_id=1,
                name=f"并发关卡会话 {uuid.uuid4().hex[:8]}",
                description="验证关卡 Tutor 的幂等创建",
                project_kind="apprenticeship",
                visibility="visible",
            )
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={}, conversation_history=[])
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="唯一关卡",
                description="并发请求只应得到一个会话",
                order=1,
                prerequisites=[],
                learning_status="not_started",
            )
            db.add(checkpoint)
            await db.flush()
            first = await get_or_create_session(
                db,
                learner_id=1,
                session_type="checkpoint",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
            )
            first_id = first.id
            await db.commit()

        async with async_session() as db:
            replay = await get_or_create_session(
                db,
                learner_id=1,
                session_type="checkpoint",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                create_new=True,
            )
            replay_id = replay.id
            count = len(list((await db.execute(select(AgentSession).where(
                AgentSession.learner_id == 1,
                AgentSession.project_id == project.id,
                AgentSession.checkpoint_id == checkpoint.id,
                AgentSession.session_type == "checkpoint",
                AgentSession.status == "active",
            ))).scalars()))
            await db.commit()
            return first_id, replay_id, count

    first_id, replay_id, count = asyncio.run(exercise_conflict_path())
    assert replay_id == first_id
    assert count == 1


def test_vnext_global_chat_is_cross_browser_authority_without_kernel_evidence(client: TestClient):
    conversation_id = f"chat-{uuid.uuid4()}"
    create_payload = {
        "session_type": "global",
        "create_new": True,
        "title": "解释一下 CNN",
        "client_conversation_id": conversation_id,
    }
    first = client.post("/api/agent/sessions", json=create_payload)
    replay = client.post("/api/agent/sessions", json=create_payload)
    assert first.status_code == replay.status_code == 200
    assert first.json()["id"] == replay.json()["id"]
    session_id = first.json()["id"]

    sync_payload = {
        "client_conversation_id": conversation_id,
        "title": "解释一下 CNN",
        "mode": "simple_explain",
        "messages": [
            {
                "client_message_id": f"message-{uuid.uuid4()}",
                "role": "user",
                "content": "解释一下 CNN",
                "created_at_ms": 1_700_000_000_000,
                "meta_data": {"tutorMode": "simple_explain"},
            },
            {
                "client_message_id": f"message-{uuid.uuid4()}",
                "role": "assistant",
                "content": "CNN 会用卷积核提取局部模式。",
                "created_at_ms": 1_700_000_001_000,
                "meta_data": {"tutorMode": "simple_explain"},
            },
        ],
    }
    synced = client.put(f"/api/agent/sessions/{session_id}/vnext", json=sync_payload)
    repeated = client.put(f"/api/agent/sessions/{session_id}/vnext", json=sync_payload)
    assert synced.status_code == repeated.status_code == 200
    assert len(repeated.json()["messages"]) == 2
    assert repeated.json()["client_conversation_id"] == conversation_id
    assert repeated.json()["vnext_mode"] == "simple_explain"

    listed = client.get("/api/agent/sessions", params={"session_type": "global"})
    listed_item = next(item for item in listed.json() if item["id"] == session_id)
    assert listed_item["vnext_managed"] is True
    assert listed_item["client_conversation_id"] == conversation_id

    async def stored_projection():
        async with async_session() as db:
            messages = list((await db.execute(select(AgentMessage).where(
                AgentMessage.session_id == session_id,
            ))).scalars().all())
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
            ))).scalars().all())
            return messages, events

    messages, events = asyncio.run(stored_projection())
    assert len(messages) == 2
    assert events == []


def test_deleting_global_chat_removes_workspace_and_cancels_open_task(client: TestClient):
    session_id = new_session(client)
    turn = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "带我弄懂 Python 装饰器为什么能包装函数",
        "client_turn_id": f"delete-chat-{uuid.uuid4().hex}",
    })
    assert turn.status_code == 200, turn.text
    task_id = turn.json()["learning_task_proposal"]["id"]

    deleted = client.delete(f"/api/agent/sessions/{session_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["evidence_retained"] is True
    assert deleted.json()["canceled_learning_tasks"] == 1
    repeated = client.delete(f"/api/agent/sessions/{session_id}")
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["status"] == "already_deleted"
    assert repeated.json()["evidence_retained"] is True
    assert client.get(f"/api/agent/sessions/{session_id}").status_code == 404
    listed = client.get("/api/agent/sessions", params={"session_type": "global"}).json()
    assert session_id not in {item["id"] for item in listed}

    async def deletion_state():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            task = await db.get(LearningTask, task_id)
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type == "conversation_deleted",
            ))).scalar_one()
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
            ))).scalars().all())
            return session, task, mutations

    session, task, mutations = asyncio.run(deletion_state())
    assert session.status == "deleted"
    assert task.status == "canceled"
    assert mutations == []


def test_global_chat_listing_supports_stable_pagination(client: TestClient):
    created_ids = [new_session(client) for _ in range(3)]

    first = client.get(
        "/api/agent/sessions",
        params={"session_type": "global", "limit": 2, "offset": 0},
    )
    second = client.get(
        "/api/agent/sessions",
        params={"session_type": "global", "limit": 2, "offset": 2},
    )

    assert first.status_code == second.status_code == 200
    first_ids = [item["id"] for item in first.json()]
    second_ids = [item["id"] for item in second.json()]
    assert len(first_ids) == 2
    assert not set(first_ids).intersection(second_ids)
    assert set(created_ids).issubset(set(first_ids + second_ids))


def test_deleting_project_removes_all_project_surfaces_but_retains_evidence(client: TestClient):
    project_response = client.post("/api/projects", json={
        "name": f"待删除项目 {uuid.uuid4().hex[:8]}",
        "description": "验证项目工作区删除",
        "user_level": "beginner",
    })
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]
    project_session = client.post("/api/agent/sessions", json={
        "session_type": "project",
        "project_id": project_id,
    })
    assert project_session.status_code == 200, project_session.text
    project_session_id = project_session.json()["id"]
    task_response = client.post("/api/learning-tasks", json={
        "title": "项目中的未完成任务",
        "objective": "完成项目中的一个原子学习任务",
        "project_id": project_id,
        "client_request_id": f"delete-project-task-{uuid.uuid4().hex}",
    })
    assert task_response.status_code == 200, task_response.text
    task_id = task_response.json()["id"]

    direct_session_delete = client.delete(f"/api/agent/sessions/{project_session_id}")
    assert direct_session_delete.status_code == 409

    deleted = client.delete(f"/api/projects/{project_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["evidence_retained"] is True
    assert deleted.json()["retired_sessions"] == 1
    assert deleted.json()["canceled_learning_tasks"] == 1
    repeated = client.delete(f"/api/projects/{project_id}")
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["status"] == "already_deleted"
    assert repeated.json()["evidence_retained"] is True
    assert client.get(f"/api/projects/{project_id}").status_code == 404
    assert project_id not in {item["id"] for item in client.get("/api/projects").json()}
    assert client.get(f"/api/agent/sessions/{project_session_id}").status_code == 404

    async def deletion_state():
        async with async_session() as db:
            project = await db.get(Project, project_id)
            session = await db.get(AgentSession, project_session_id)
            task = await db.get(LearningTask, task_id)
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.project_id == project_id,
                EvidenceEvent.event_type == "project_deleted",
            ))).scalar_one()
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
            ))).scalars().all())
            return project, session, task, mutations

    project, session, task, mutations = asyncio.run(deletion_state())
    assert project.visibility == "deleted"
    assert session.status == "deleted"
    assert task.status == "canceled"
    assert mutations == []


def test_socratic_skill_run_is_bounded_resumable_and_hands_off_to_verification(
    client: TestClient,
):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    session_id = session["id"]

    opening_id = f"skill-open-{uuid.uuid4().hex}"
    opening = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "不要直接告诉我，请引导我理解边际成本为什么会变化",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": opening_id,
    })
    assert opening.status_code == 200, opening.text
    run = opening.json()["active_skill_run"]
    assert run["skill"]["id"] == "socratic_dialogue"
    assert run["state"] == "eliciting_prior_model"
    assert run["turn_count"] == 0
    assert run["verification_required"] is True
    assert run["learning_task"]["status"] == "active"
    assert run["learning_task"]["current_phase_id"] == "learn"
    assert opening.json()["executed_action"] is None

    responses = (
        "我觉得边际成本是每多生产一个单位时新增的成本，可能会受当前产量影响。",
        "如果设备已经接近容量上限，继续生产会需要加班或者效率下降，所以成本会变高。",
        "因为产量增加会改变资源约束，所以新增一单位的成本会变化；只有资源约束不变时才可能保持稳定。",
    )
    expected_states = ("testing_assumption", "building_explanation", "verification_ready")
    for index, (response, expected_state) in enumerate(zip(responses, expected_states)):
        turn_id = f"skill-step-{index}-{uuid.uuid4().hex}"
        advanced = client.post(f"/api/agent/sessions/{session_id}/turns", json={
            "message": response,
            "selected_skill_id": "socratic_dialogue",
            "client_turn_id": turn_id,
        })
        assert advanced.status_code == 200, advanced.text
        run = advanced.json()["active_skill_run"]
        assert run["state"] == expected_state
        assert run["turn_count"] == index + 1
        assert run["turn_count"] <= run["turn_budget"]
        replay = client.post(f"/api/agent/sessions/{session_id}/turns", json={
            "message": response,
            "selected_skill_id": "socratic_dialogue",
            "client_turn_id": turn_id,
        })
        assert replay.status_code == 200
        assert replay.json()["active_skill_run"]["version"] == run["version"]

    assert run["can_start_verification"] is True
    pause_action_id = f"pause-{uuid.uuid4().hex}"
    paused = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions",
        json={
            "action": "pause", "expected_version": run["version"],
            "client_action_id": pause_action_id,
        },
    )
    assert paused.status_code == 200, paused.text
    paused_run = paused.json()["active_skill_run"]
    assert paused_run["status"] == "paused"
    paused_task = client.get(f"/api/learning-tasks/{paused_run['learning_task']['id']}").json()
    assert paused_task["status"] == "paused"
    replayed_pause = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions",
        json={
            "action": "pause", "expected_version": run["version"],
            "client_action_id": pause_action_id,
        },
    )
    assert replayed_pause.status_code == 200, replayed_pause.text
    assert replayed_pause.json()["active_skill_run"]["version"] == paused_run["version"]
    stale_pause = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions",
        json={
            "action": "pause", "expected_version": run["version"],
            "client_action_id": f"stale-{uuid.uuid4().hex}",
        },
    )
    assert stale_pause.status_code == 409
    restored = client.get(f"/api/agent/sessions/{session_id}")
    assert restored.status_code == 200
    assert restored.json()["active_skill_run"]["status"] == "paused"

    resumed = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions",
        json={
            "action": "resume", "expected_version": paused_run["version"],
            "client_action_id": f"resume-{uuid.uuid4().hex}",
        },
    )
    assert resumed.status_code == 200, resumed.text
    resumed_run = resumed.json()["active_skill_run"]
    assert resumed_run["state"] == "verification_ready"
    resumed_task = client.get(f"/api/learning-tasks/{resumed_run['learning_task']['id']}").json()
    assert resumed_task["status"] == "active"
    assert resumed_task["plan"]["phases"][0]["status"] == "completed"

    verification = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions",
        json={
            "action": "start_verification", "expected_version": resumed_run["version"],
            "client_action_id": f"verify-{uuid.uuid4().hex}",
        },
    )
    assert verification.status_code == 200, verification.text
    body = verification.json()
    assert body["active_skill_run"]["state"] == "verification_in_progress"
    assert body["learning_run"]["goal"] == run["goal"]
    assert body["learning_run"]["state"] == "learning_card"
    materialized_task = client.get(
        f"/api/learning-tasks/{body['active_skill_run']['learning_task']['id']}"
    ).json()
    assert materialized_task["micro_learning_run_id"] == body["learning_run"]["id"]

    async def complete_verification_projection():
        async with async_session() as db:
            micro = await db.get(MicroLearningRun, body["learning_run"]["id"])
            micro.status = "completed"
            micro.state = "completed"
            micro.summary = {
                "mastery_claim": "not_stable_yet",
                "review_schedule_ids": [701],
            }
            await db.commit()

    asyncio.run(complete_verification_projection())
    completed_view = client.get(f"/api/agent/sessions/{session_id}")
    assert completed_view.status_code == 200, completed_view.text
    assert completed_view.json()["active_skill_run"]["status"] == "completed"
    assert "稳定掌握仍需" in completed_view.json()["active_skill_run"]["evidence_note"]

    async def skill_event_audit():
        async with async_session() as db:
            stored = await db.get(LearningSkillRun, run["id"])
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type.in_({
                    "learning_skill_run_started", "learning_skill_run_advanced",
                    "learning_skill_run_paused", "learning_skill_run_resumed",
                    "learning_skill_verification_started", "learning_skill_run_completed",
                }),
            ))).scalars().all())
            event_ids = [event.id for event in events]
            mutation_count = (await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_(event_ids),
            ))).scalars().all() if event_ids else []
            return stored, events, mutation_count

    stored, events, mutations = asyncio.run(skill_event_audit())
    assert stored.micro_learning_run_id == body["learning_run"]["id"]
    assert {event.event_type for event in events} >= {
        "learning_skill_run_started", "learning_skill_run_advanced",
        "learning_skill_run_paused", "learning_skill_run_resumed",
        "learning_skill_verification_started", "learning_skill_run_completed",
    }
    assert mutations == []


def test_skill_runtime_scaffolds_no_knowledge_without_advancing(client: TestClient):
    session_id = new_session(client)
    opening = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "跟我讲讲什么是朴素贝叶斯分类器",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"grounded-open-{uuid.uuid4().hex}",
    })
    assert opening.status_code == 200, opening.text
    opening_body = opening.json()
    run = opening_body["active_skill_run"]
    assert run["goal"] == "朴素贝叶斯分类器"
    assert run["state"] == "eliciting_prior_model"
    assert run["stage_label"] == "建立可回答起点"
    assert run["turn_count"] == 0
    assert run["support_count"] == 0
    assert run["stages"][0]["status"] == "current"
    assert "不应该让你凭空猜" in opening_body["message"]

    orientation_choice = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "B，我想先看一个具体例子",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"grounded-choice-{uuid.uuid4().hex}",
    })
    assert orientation_choice.status_code == 200, orientation_choice.text
    oriented = orientation_choice.json()["active_skill_run"]
    assert oriented["state"] == "eliciting_prior_model"
    assert oriented["turn_count"] == 0
    assert oriented["support_count"] == 1
    assert oriented["last_response_signal"] == "orientation_example_choice"
    assert "不是作答" in oriented["flow_note"]

    no_knowledge = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "我不知道",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"grounded-help-{uuid.uuid4().hex}",
    })
    assert no_knowledge.status_code == 200, no_knowledge.text
    supported = no_knowledge.json()["active_skill_run"]
    assert supported["state"] == "eliciting_prior_model"
    assert supported["step_index"] == 1
    assert supported["turn_count"] == 0
    assert supported["support_count"] == 2
    assert supported["last_response_signal"] == "no_prior_knowledge"
    assert "没有被当作完成" in supported["flow_note"]
    assert "不该继续让你猜" in no_knowledge.json()["message"]

    direct_help = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "先直接解释一下，再继续问我",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"grounded-direct-{uuid.uuid4().hex}",
    })
    assert direct_help.status_code == 200, direct_help.text
    directly_supported = direct_help.json()["active_skill_run"]
    assert directly_supported["state"] == "eliciting_prior_model"
    assert directly_supported["turn_count"] == 0
    assert directly_supported["support_count"] == 3
    assert directly_supported["last_response_signal"] == "direct_explanation_requested"
    assert "先切到简明说明" in direct_help.json()["message"]

    attempted = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "我猜它会把已有类别比例和观察到的特征一起用于分类。",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"grounded-attempt-{uuid.uuid4().hex}",
    })
    assert attempted.status_code == 200, attempted.text
    advanced = attempted.json()["active_skill_run"]
    assert advanced["state"] == "testing_assumption"
    assert advanced["turn_count"] == 1
    assert advanced["support_count"] == 3
    assert advanced["last_response_signal"] == "attempt"


def test_vnext_skill_turn_endpoint_advances_once_without_second_model_answer(client: TestClient):
    session_id = new_session(client)
    started = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json={
        "skill_id": "socratic_dialogue",
        "goal": "理解朴素贝叶斯分类器",
        "client_request_id": f"vnext-skill-{uuid.uuid4().hex}",
    })
    assert started.status_code == 200, started.text
    run = started.json()["active_skill_run"]
    initial_state = run["state"]
    client_turn_id = f"vnext-turn-{uuid.uuid4().hex}"

    support = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": "我不知道",
            "expected_version": run["version"],
            "client_turn_id": client_turn_id,
        },
    )
    assert support.status_code == 200, support.text
    supported = support.json()["active_skill_run"]
    assert support.json()["created"] is True
    assert supported["state"] == initial_state
    assert supported["support_count"] == 1
    assert supported["turn_count"] == 0

    duplicate = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": "我不知道",
            "expected_version": run["version"],
            "client_turn_id": client_turn_id,
        },
    )
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["created"] is False
    assert duplicate.json()["active_skill_run"]["version"] == supported["version"]

    attempt = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": "它会把先验概率和当前证据结合起来更新类别判断。",
            "expected_version": supported["version"],
            "client_turn_id": f"vnext-turn-{uuid.uuid4().hex}",
        },
    )
    assert attempt.status_code == 200, attempt.text
    advanced = attempt.json()["active_skill_run"]
    assert advanced["state"] != initial_state
    assert advanced["turn_count"] == 1

    async def audit_messages_and_mutations():
        async with async_session() as db:
            messages = list((await db.execute(select(AgentMessage).where(
                AgentMessage.session_id == session_id,
                AgentMessage.role == "user",
            ))).scalars().all())
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type == "learning_skill_run_advanced",
            ))).scalars().all())
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_([event.id for event in events]),
            ))).scalars().all()) if events else []
            return messages, events, mutations

    messages, events, mutations = asyncio.run(audit_messages_and_mutations())
    assert len(messages) == 2
    assert all(message.meta_data["model_answer_generated"] is False for message in messages)
    assert len(events) == 2
    assert mutations == []


def test_skill_turn_plan_is_consumed_once_by_tutor_render(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    session_id = new_session(client)
    opening_message = "请用最小例子解释闭包如何捕获变量"
    started = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json={
        "skill_id": "guided_explanation",
        "goal": opening_message,
        "client_request_id": f"single-advance-{uuid.uuid4().hex}",
    })
    assert started.status_code == 200, started.text
    opening_run = started.json()["active_skill_run"]
    assert opening_run["runtime_version"] == SKILL_RUNTIME_VERSION

    # Legacy Tutor clients omit prepared_skill_turn_id. The message that merely
    # opened an already-created run must render its opening plan without advancing.
    opening_render = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": opening_message,
        "selected_skill_id": "guided_explanation",
        "client_turn_id": f"legacy-opening-{uuid.uuid4().hex}",
    })
    assert opening_render.status_code == 200, opening_render.text
    assert opening_render.json()["active_skill_run"]["version"] == opening_run["version"]
    assert opening_render.json()["active_skill_run"]["turn_count"] == 0

    learner_reply = "闭包保留了创建它时可访问的变量环境，所以之后仍能读取那个变量。"
    formal_turn_id = f"formal-turn-{uuid.uuid4().hex}"
    prepared = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{opening_run['id']}/turns",
        json={
            "message": learner_reply,
            "expected_version": opening_run["version"],
            "client_turn_id": formal_turn_id,
        },
    )
    assert prepared.status_code == 200, prepared.text
    prepared_body = prepared.json()
    advanced_run = prepared_body["active_skill_run"]
    prepared_message_id = prepared_body["prepared_skill_turn_id"]
    assert advanced_run["turn_count"] == 1
    assert prepared_body["turn_plan"]["run_version"] == advanced_run["version"]

    render_id = f"tutor-render-{uuid.uuid4().hex}"
    render_payload = {
        "message": learner_reply,
        "selected_skill_id": "guided_explanation",
        "client_turn_id": render_id,
        "prepared_skill_turn_id": prepared_message_id,
    }
    rendered = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json=render_payload,
    )
    replayed = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json=render_payload,
    )
    assert rendered.status_code == replayed.status_code == 200
    assert rendered.json()["prepared_skill_turn_id"] == prepared_message_id
    assert rendered.json()["active_skill_run"]["version"] == advanced_run["version"]
    assert rendered.json()["active_skill_run"]["turn_count"] == 1
    assert replayed.json() == rendered.json()

    async def audit_single_record():
        async with async_session() as db:
            messages = list((await db.execute(select(AgentMessage).where(
                AgentMessage.session_id == session_id,
                AgentMessage.role == "user",
                AgentMessage.content == learner_reply,
            ))).scalars().all())
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type == "learning_skill_run_advanced",
            ))).scalars().all())
            user_events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type == "user_message",
            ))).scalars().all())
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_([event.id for event in events]),
            ))).scalars().all()) if events else []
            return messages, events, user_events, mutations

    messages, events, user_events, mutations = asyncio.run(audit_single_record())
    assert len(messages) == 1
    assert messages[0].id == prepared_message_id
    assert render_id in messages[0].meta_data["tutor_render_client_turn_ids"]
    assert len(events) == 1
    assert events[0].payload["message_id"] == prepared_message_id
    assert len([
        event for event in user_events
        if (event.provenance or {}).get("message_id") == prepared_message_id
    ]) == 1
    assert mutations == []


def test_legacy_tutor_render_auto_consumes_latest_prepared_skill_turn(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    session_id = new_session(client)
    started = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json={
        "skill_id": "socratic_dialogue",
        "goal": "理解哈希冲突",
        "client_request_id": f"legacy-prepared-{uuid.uuid4().hex}",
    })
    assert started.status_code == 200, started.text
    run = started.json()["active_skill_run"]
    learner_reply = "冲突表示不同输入得到相同桶位置，需要额外规则区分它们。"
    formal_turn_id = f"legacy-formal-{uuid.uuid4().hex}"
    prepared = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": learner_reply,
            "expected_version": run["version"],
            "client_turn_id": formal_turn_id,
        },
    )
    assert prepared.status_code == 200, prepared.text
    prepared_body = prepared.json()

    legacy_render_id = f"legacy-render-{uuid.uuid4().hex}"
    legacy_payload = {
        "message": learner_reply,
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": legacy_render_id,
    }
    rendered = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json=legacy_payload,
    )
    replayed_render = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json=legacy_payload,
    )
    replayed_formal = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": learner_reply,
            "expected_version": run["version"],
            "client_turn_id": formal_turn_id,
        },
    )
    assert rendered.status_code == replayed_render.status_code == 200
    assert replayed_formal.status_code == 200, replayed_formal.text
    assert rendered.json()["active_skill_run"]["version"] == prepared_body["active_skill_run"]["version"]
    assert rendered.json()["active_skill_run"]["turn_count"] == 1
    assert replayed_render.json() == rendered.json()
    assert replayed_formal.json()["created"] is False
    assert replayed_formal.json()["prepared_skill_turn_id"] == prepared_body["prepared_skill_turn_id"]
    assert replayed_formal.json()["turn_plan"] == prepared_body["turn_plan"]


def test_scoped_skill_runs_reuse_checkpoint_task_and_preserve_ownership(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    monkeypatch.setattr("app.services.learning_tasks.settings.llm_api_key", "")

    async def seed_scopes():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(
                learner_id=learner_id,
                name=f"Skill scope {uuid.uuid4().hex[:8]}",
            )
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="事务隔离关卡",
                description="解释隔离级别的可见性边界",
                order=1,
            )
            db.add(checkpoint)
            await db.flush()
            checkpoint_task = await ensure_checkpoint_learning_task(
                db,
                learner_id=learner_id,
                checkpoint=checkpoint,
                session_id=None,
            )
            await db.commit()
            return project.id, checkpoint.id, checkpoint_task.id

    project_id, checkpoint_id, existing_task_id = asyncio.run(seed_scopes())
    project_session = client.post("/api/agent/sessions", json={
        "session_type": "project",
        "project_id": project_id,
        "create_new": True,
    })
    checkpoint_session = client.post("/api/agent/sessions", json={
        "session_type": "checkpoint",
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "create_new": True,
    })
    assert project_session.status_code == checkpoint_session.status_code == 200
    project_session_id = project_session.json()["id"]
    checkpoint_session_id = checkpoint_session.json()["id"]

    project_started = client.post(
        f"/api/agent/sessions/{project_session_id}/skill-runs",
        json={
            "skill_id": "guided_explanation",
            "goal": "解释项目中的事务边界",
            "client_request_id": f"project-skill-{uuid.uuid4().hex}",
        },
    )
    checkpoint_started = client.post(
        f"/api/agent/sessions/{checkpoint_session_id}/skill-runs",
        json={
            "skill_id": "socratic_dialogue",
            "goal": "解释隔离级别的可见性边界",
            "client_request_id": f"checkpoint-skill-{uuid.uuid4().hex}",
        },
    )
    assert project_started.status_code == 200, project_started.text
    assert checkpoint_started.status_code == 200, checkpoint_started.text
    project_run = project_started.json()["active_skill_run"]
    checkpoint_run = checkpoint_started.json()["active_skill_run"]
    assert project_run["scope"] == {
        "session_id": project_session_id,
        "project_id": project_id,
        "checkpoint_id": None,
    }
    assert project_run["learning_task"]["id"] != existing_task_id
    assert checkpoint_run["scope"] == {
        "session_id": checkpoint_session_id,
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
    }
    assert checkpoint_run["learning_task"]["id"] == existing_task_id

    for index in range(3):
        advanced = client.post(
            f"/api/agent/sessions/{checkpoint_session_id}/skill-runs/{checkpoint_run['id']}/turns",
            json={
                "message": f"这是第 {index + 1} 个可检查的隔离边界解释。",
                "expected_version": checkpoint_run["version"],
                "client_turn_id": f"checkpoint-step-{index}-{uuid.uuid4().hex}",
            },
        )
        assert advanced.status_code == 200, advanced.text
        checkpoint_run = advanced.json()["active_skill_run"]
    assert checkpoint_run["state"] == "verification_ready"
    verification = client.post(
        f"/api/agent/sessions/{checkpoint_session_id}/skill-runs/{checkpoint_run['id']}/actions",
        json={
            "action": "start_verification",
            "expected_version": checkpoint_run["version"],
            "client_action_id": f"checkpoint-verify-{uuid.uuid4().hex}",
        },
    )
    assert verification.status_code == 200, verification.text
    checkpoint_run = verification.json()["active_skill_run"]
    assert checkpoint_run["state"] == "verification_in_progress"
    assert checkpoint_run["learning_task"]["id"] == existing_task_id
    assert checkpoint_run["scope"] == {
        "session_id": checkpoint_session_id,
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
    }

    wrong_session = client.post(
        f"/api/agent/sessions/{project_session_id}/skill-runs/{checkpoint_run['id']}/turns",
        json={
            "message": "这条消息不能跨会话推进",
            "expected_version": checkpoint_run["version"],
            "client_turn_id": f"wrong-session-{uuid.uuid4().hex}",
        },
    )
    wrong_checkpoint = client.post(
        f"/api/agent/sessions/{checkpoint_session_id}/turns",
        json={
            "message": "这条消息不能跨关卡",
            "project_id": project_id,
            "checkpoint_id": checkpoint_id + 999_999,
        },
    )
    assert wrong_session.status_code == 404
    assert wrong_checkpoint.status_code == 409

    async def audit_scopes():
        async with async_session() as db:
            project_task = await db.get(LearningTask, project_run["learning_task"]["id"])
            checkpoint_task = await db.get(LearningTask, existing_task_id)
            project_events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == project_session_id,
                EvidenceEvent.event_type.in_({
                    "learning_skill_selected", "learning_skill_run_started",
                }),
            ))).scalars().all())
            checkpoint_events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == checkpoint_session_id,
                EvidenceEvent.event_type.in_({
                    "learning_skill_selected", "learning_skill_run_started",
                }),
            ))).scalars().all())
            return project_task, checkpoint_task, project_events, checkpoint_events

    project_task, checkpoint_task, project_events, checkpoint_events = asyncio.run(audit_scopes())
    assert (project_task.learner_id, project_task.session_id) == (
        checkpoint_task.learner_id, project_session_id,
    )
    assert (project_task.project_id, project_task.checkpoint_id) == (project_id, None)
    assert checkpoint_task.session_id == checkpoint_session_id
    assert (checkpoint_task.project_id, checkpoint_task.checkpoint_id) == (
        project_id, checkpoint_id,
    )
    assert project_events and all(
        (event.project_id, event.checkpoint_id) == (project_id, None)
        for event in project_events
    )
    assert checkpoint_events and all(
        (event.project_id, event.checkpoint_id) == (project_id, checkpoint_id)
        for event in checkpoint_events
    )


def test_support_turn_budget_has_structured_exit_without_auto_pass(
    client: TestClient,
):
    session_id = new_session(client)
    started = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json={
        "skill_id": "worked_example_fading",
        "goal": "用二分查找定位边界",
        "client_request_id": f"support-budget-{uuid.uuid4().hex}",
    })
    assert started.status_code == 200, started.text
    run = started.json()["active_skill_run"]
    initial_state = run["state"]
    final_turn_id = ""
    final_response = None
    for index in range(SUPPORT_TURN_BUDGET):
        final_turn_id = f"support-budget-{index}-{uuid.uuid4().hex}"
        final_response = client.post(
            f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
            json={
                "message": "我不知道",
                "expected_version": run["version"],
                "client_turn_id": final_turn_id,
            },
        )
        assert final_response.status_code == 200, final_response.text
        run = final_response.json()["active_skill_run"]

    assert run["runtime_version"] == SKILL_RUNTIME_VERSION
    assert run["state"] == initial_state
    assert run["turn_count"] == 0
    assert run["support_count"] == run["support_budget"] == SUPPORT_TURN_BUDGET
    assert run["can_start_verification"] is False
    assert run["support_exit"]["reason"] == "support_budget_exhausted"
    assert run["support_exit"]["mastery_unchanged"] is True
    assert [item["action"] for item in run["support_exit"]["options"]] == [
        "narrow_goal", "switch_method", "pause",
    ]
    assert final_response.json()["turn_plan"]["support_exit"] == run["support_exit"]

    blocked = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": "我还是不知道，请再讲一次",
            "expected_version": run["version"],
            "client_turn_id": f"support-budget-blocked-{uuid.uuid4().hex}",
        },
    )
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["created"] is True
    assert blocked.json()["active_skill_run"]["version"] == run["version"]
    assert blocked.json()["active_skill_run"]["state"] == initial_state
    assert blocked.json()["turn_plan"]["support_exit"] == run["support_exit"]

    duplicate = client.post(
        f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns",
        json={
            "message": "我不知道",
            "expected_version": run["version"] - 1,
            "client_turn_id": final_turn_id,
        },
    )
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["created"] is False
    assert duplicate.json()["active_skill_run"]["version"] == run["version"]

    async def audit_support_boundary():
        async with async_session() as db:
            stored = await db.get(LearningSkillRun, run["id"])
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == session_id,
                EvidenceEvent.event_type == "learning_skill_run_advanced",
            ))).scalars().all())
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_([event.id for event in events]),
            ))).scalars().all()) if events else []
            return stored, events, mutations

    stored, events, mutations = asyncio.run(audit_support_boundary())
    assert stored.run_data["mastery_claim"] == "none"
    assert len(events) == SUPPORT_TURN_BUDGET
    assert all(event.payload["mastery_unchanged"] is True for event in events)
    assert mutations == []


def test_skill_response_signals_distinguish_help_skip_and_attempt():
    assert learner_response_signal("我不知道") == "no_prior_knowledge"
    assert learner_response_signal("请直接解释一下") == "direct_explanation_requested"
    assert learner_response_signal("请换一种支架，再来一轮") == "direct_explanation_requested"
    assert learner_response_signal("先跳过") == "skip"
    assert learner_response_signal("好的") == "acknowledgement"
    assert learner_response_signal("我不知道，但我觉得可能和先验概率有关") == "attempt"


def test_feynman_single_gap_loop_is_bounded_and_never_claims_mastery():
    state = "awaiting_teach_back"
    step_index = 1
    turn_count = 0
    support_count = 0
    calibration = {
        "audience_level": "undergraduate",
        "cognitive_demand": "mechanism",
        "scaffold_level": "guided",
        "representation_mode": "auto",
    }
    diagnostic = {}
    gap_loop_count = 0
    messages = (
        "事务隔离会控制并发事务能看到哪些数据。",
        "这里的可见性表示一个事务读取另一个事务修改的时机。",
        "它会控制读取结果。",
        "它仍然是控制读取结果。",
        "因为隔离级别限制了修改何时可见，所以不同并发顺序会呈现不同读取结果。",
    )
    states = []
    gaps = []
    for message in messages:
        result = transition_learning_skill_turn(
            skill_id="feynman_dialogue",
            current_state=state,
            step_index=step_index,
            turn_count=turn_count,
            support_count=support_count,
            goal="事务隔离",
            message=message,
            calibration=calibration,
            teach_back_diagnostic=diagnostic,
            gap_loop_count=gap_loop_count,
        )
        state = str(result["state"])
        step_index = int(result["step_index"])
        turn_count = int(result["turn_count"])
        support_count = int(result["support_count"])
        calibration = dict(result["calibration"])
        diagnostic = dict(result["teach_back_diagnostic"])
        gap_loop_count = int(result["gap_loop_count"])
        states.append(state)
        gaps.append(diagnostic["candidate_gap"])
    assert states == [
        "locating_gap", "revising_explanation", "revising_explanation",
        "revising_explanation", "verification_ready",
    ]
    assert len(set(gaps)) == 1
    assert gap_loop_count == 2
    assert turn_count == 5
    assert diagnostic["status"] == "ready_for_independent_verification"
    assert diagnostic["mastery_inference"] is False


def test_adaptive_tutor_recommends_but_does_not_silently_activate_skill(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    session_id = session["id"]
    turn = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "不要直接告诉我答案，引导我自己推导递归为什么会终止",
        "selected_skill_id": "adaptive",
        "client_turn_id": f"recommend-{uuid.uuid4().hex}",
    })
    assert turn.status_code == 200, turn.text
    assert turn.json()["active_skill"] is None
    assert turn.json()["active_skill_run"] is None
    recommendation = turn.json()["skill_recommendation"]
    assert recommendation["skill"]["id"] == "socratic_dialogue"
    assert recommendation["goal"] == "递归为什么会终止"
    assert recommendation["requires_confirmation"] is True

    acceptance_request = {
        "skill_id": "socratic_dialogue",
        "goal": "推导递归为什么会终止",
        "client_request_id": f"accept-{uuid.uuid4().hex}",
    }
    accepted = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json=acceptance_request)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["active_skill"]["id"] == "socratic_dialogue"
    assert accepted.json()["active_skill_run"]["state"] == "eliciting_prior_model"
    assert accepted.json()["created"] is True
    replayed = client.post(f"/api/agent/sessions/{session_id}/skill-runs", json=acceptance_request)
    assert replayed.status_code == 200, replayed.text
    assert replayed.json()["active_skill_run"]["id"] == accepted.json()["active_skill_run"]["id"]
    assert replayed.json()["created"] is False


def test_adaptive_tutor_recommends_guided_explanation_without_silent_activation(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    turn = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "请直接解释什么是哈希表",
        "selected_skill_id": "adaptive",
        "client_turn_id": f"guided-{uuid.uuid4().hex}",
    })
    assert turn.status_code == 200, turn.text
    assert turn.json()["active_skill"] is None
    assert turn.json()["active_skill_run"] is None
    assert turn.json()["skill_recommendation"]["skill"]["id"] == "guided_explanation"
    assert turn.json()["skill_recommendation"]["requires_confirmation"] is True
    accepted = client.post(f"/api/agent/sessions/{session['id']}/skill-runs", json={
        "skill_id": "guided_explanation",
        "goal": "哈希表",
        "client_request_id": f"guided-accept-{uuid.uuid4().hex}",
    })
    assert accepted.status_code == 200, accepted.text
    run = accepted.json()["active_skill_run"]
    assert run["state"] == "presenting_core_model"
    assert run["learning_task"]["status"] == "active"
    assert "guided_explanation" in client.get(
        f"/api/learning-tasks/{run['learning_task']['id']}"
    ).json()["plan"]["phases"][0]["methods"]


def test_learning_skill_run_claims_requested_formal_task_without_duplicate(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()

    async def seed_task():
        async with async_session() as db:
            persisted = await db.get(AgentSession, session["id"])
            task, _ = await create_learning_task(
                db,
                learner_id=persisted.learner_id,
                title="上下文控制学习型任务",
                objective="实现上下文与模型行为控制",
                client_request_id=f"candidate-task-{uuid.uuid4().hex}",
                origin_kind="learning_task_candidate",
                created_by="learning_design_agent",
                status="queued",
                success_criteria=["完成上下文组装与行为验证"],
                use_model_planner=False,
            )
            await db.commit()
            return task.id

    task_id = asyncio.run(seed_task())
    request_id = f"candidate-skill-{uuid.uuid4().hex}"
    started = client.post(f"/api/agent/sessions/{session['id']}/skill-runs", json={
        "skill_id": "guided_explanation",
        "goal": "实现上下文与模型行为控制",
        "client_request_id": request_id,
        "learning_task_id": task_id,
    })
    assert started.status_code == 200, started.text
    run = started.json()["active_skill_run"]
    assert run["learning_task"]["id"] == task_id
    assert run["learning_task"]["status"] == "active"
    task = client.get(f"/api/learning-tasks/{task_id}").json()
    assert task["session_id"] == session["id"]

    retried = client.post(f"/api/agent/sessions/{session['id']}/skill-runs", json={
        "skill_id": "guided_explanation",
        "goal": "实现上下文与模型行为控制",
        "client_request_id": request_id,
        "learning_task_id": task_id,
    })
    assert retried.status_code == 200, retried.text
    assert retried.json()["created"] is False
    assert retried.json()["active_skill_run"]["id"] == run["id"]
    assert retried.json()["active_skill_run"]["learning_task"]["id"] == task_id

    async def scoped_task_count():
        async with async_session() as db:
            persisted = await db.get(AgentSession, session["id"])
            rows = list((await db.execute(select(LearningTask).where(
                LearningTask.learner_id == persisted.learner_id,
                LearningTask.objective == "实现上下文与模型行为控制",
            ))).scalars().all())
            return len(rows)

    assert asyncio.run(scoped_task_count()) == 1


def test_learning_skill_goal_normalizes_conversational_fillers(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    accepted = client.post(f"/api/agent/sessions/{session['id']}/skill-runs", json={
        "skill_id": "guided_explanation",
        "goal": "带我学习一下集成学习",
        "client_request_id": f"normalize-goal-{uuid.uuid4().hex}",
    })
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["active_skill_run"]["goal"] == "集成学习"


def test_feynman_skill_run_uses_a_distinct_bounded_workflow(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    first = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "我想用自己的话讲清楚条件概率",
        "selected_skill_id": "feynman_dialogue",
        "client_turn_id": f"feynman-open-{uuid.uuid4().hex}",
    })
    assert first.status_code == 200, first.text
    run = first.json()["active_skill_run"]
    assert run["state"] == "awaiting_teach_back"
    assert run["goal"] == "条件概率"
    assert run["turn_budget"] == 5
    assert run["calibration"]["audience_level"] == "undergraduate"

    calibrated = client.post(
        f"/api/agent/sessions/{session['id']}/skill-runs/{run['id']}/actions",
        json={
            "action": "calibrate",
            "expected_version": run["version"],
            "client_action_id": f"feynman-calibrate-{uuid.uuid4().hex}",
            "audience_level": "vocational",
            "cognitive_demand": "mechanism",
            "scaffold_level": "minimal",
            "representation_mode": "code",
        },
    )
    assert calibrated.status_code == 200, calibrated.text
    run = calibrated.json()["active_skill_run"]
    assert run["state"] == "awaiting_teach_back"
    assert run["calibration"] == {
        "audience_level": "vocational",
        "cognitive_demand": "mechanism",
        "scaffold_level": "minimal",
        "representation_mode": "code",
    }

    messages = (
        "条件概率是在已经知道一件事发生的情况下重新判断另一件事的概率。",
        "这里的条件就是先把观察范围缩小到已经发生的事件。",
        "因为已知事件缩小了样本空间，所以要在这个范围内重新计算比例；例如抽到红球后再判断大小，但前提是条件事件概率不为零。",
    )
    for index, expected_state in enumerate(("locating_gap", "revising_explanation", "verification_ready")):
        next_turn = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
            "message": messages[index],
            "selected_skill_id": "feynman_dialogue",
            "client_turn_id": f"feynman-{index}-{uuid.uuid4().hex}",
        })
        assert next_turn.status_code == 200, next_turn.text
        run = next_turn.json()["active_skill_run"]
        assert run["state"] == expected_state
    assert run["turn_count"] == 3
    assert run["turn_budget"] == 5
    assert run["teach_back_diagnostic"]["status"] == "ready_for_independent_verification"
    assert run["teach_back_diagnostic"]["mastery_inference"] is False
    assert run["can_start_verification"] is True
    cleared = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "先退出这个方法，后面再继续。",
        "selected_skill_id": "adaptive",
        "client_turn_id": f"feynman-clear-{uuid.uuid4().hex}",
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["active_skill"] is None


def test_worked_example_fading_is_task_linked_and_bounded(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    first = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "先示范再让我做：用 Python 写二分查找",
        "selected_skill_id": "worked_example_fading",
        "client_turn_id": f"worked-open-{uuid.uuid4().hex}",
    })
    assert first.status_code == 200, first.text
    run = first.json()["active_skill_run"]
    assert run["state"] == "studying_worked_example"
    assert run["learning_task"]["status"] == "active"
    assert "worked_example_fading" in client.get(
        f"/api/learning-tasks/{run['learning_task']['id']}"
    ).json()["plan"]["phases"][0]["methods"]

    for index, expected_state in enumerate((
        "completing_last_step", "solving_faded_example", "verification_ready",
    )):
        advanced = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
            "message": f"这是第 {index + 1} 次补全，我按子目标完成对应步骤。",
            "selected_skill_id": "worked_example_fading",
            "client_turn_id": f"worked-{index}-{uuid.uuid4().hex}",
        })
        assert advanced.status_code == 200, advanced.text
        run = advanced.json()["active_skill_run"]
        assert run["state"] == expected_state
    assert run["turn_count"] == run["turn_budget"] == 3
    assert run["can_start_verification"] is True
    cleared = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "先退出这个方法，后面再继续。",
        "selected_skill_id": "adaptive",
        "client_turn_id": f"worked-clear-{uuid.uuid4().hex}",
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["active_skill"] is None


def test_learning_file_study_keeps_content_in_papers_and_reaches_verification(client: TestClient):
    session = client.post("/api/agent/sessions", json={
        "session_type": "global", "create_new": True,
    }).json()
    first = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
        "message": "用讲义和练习带我学注意力矩阵形状",
        "selected_skill_id": "learning_file_study",
        "client_turn_id": f"file-open-{uuid.uuid4().hex}",
    })
    assert first.status_code == 200, first.text
    run = first.json()["active_skill_run"]
    assert run["state"] == "selecting_learning_artifact"
    assert run["learning_task"]["status"] == "active"
    assert "纸张" in first.json()["message"]

    for index, expected_state in enumerate((
        "reading_with_anchor", "practicing_in_file", "verification_ready",
    )):
        advanced = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
            "message": "已完成当前纸张中的动作并给出可检查回应。",
            "selected_skill_id": "learning_file_study",
            "client_turn_id": f"file-step-{index}-{uuid.uuid4().hex}",
        })
        assert advanced.status_code == 200, advanced.text
        run = advanced.json()["active_skill_run"]
        assert run["state"] == expected_state
    assert run["can_start_verification"] is True


def test_conversation_skill_runtime_migration_is_idempotent(client: TestClient):
    del client

    async def scenario():
        await init_db()
        await init_db()
        async with async_session() as db:
            markers = list((await db.execute(select(SchemaMigration).where(
                SchemaMigration.version == "v16-atomic-learning-skill-runtime",
            ))).scalars().all())
            await db.execute(select(LearningSkillRun.id).limit(1))
            await db.execute(select(LearningTask.id).limit(1))
            return len(markers)

    assert asyncio.run(scenario()) == 1


def test_checkpoint_tutor_session_and_context_are_isolated(client: TestClient, tmp_path):
    root = tmp_path / "checkpoint-workspace"
    root.mkdir()
    (root / "shared.py").write_text("print('shared project file')\n", encoding="utf-8")

    async def seed():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(learner_id=learner_id, name="关卡会话隔离项目")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            first = Checkpoint(
                roadmap_id=roadmap.id, title="第一关", description="只看第一关",
                order=1, brief={"goal": "first-only"},
            )
            second = Checkpoint(
                roadmap_id=roadmap.id, title="第二关", description="other-checkpoint-secret",
                order=2, brief={"goal": "second-secret"},
            )
            db.add_all([first, second])
            await db.flush()
            source = Source(project_id=project.id, type="url", url="https://example.com", status="processed")
            db.add(source)
            await db.flush()
            first_chunk = Chunk(source_id=source.id, index=0, content="first assigned resource", meta_data={"file": "first.md"})
            second_chunk = Chunk(source_id=source.id, index=1, content="second hidden resource", meta_data={"file": "second.md"})
            db.add_all([first_chunk, second_chunk])
            await db.flush()
            db.add_all([
                CheckpointChunk(checkpoint_id=first.id, chunk_id=first_chunk.id),
                CheckpointChunk(checkpoint_id=second.id, chunk_id=second_chunk.id),
                Lecture(checkpoint_id=first.id, status="published", sections=[{"title": "第一讲", "content": "first lecture body"}]),
                Lecture(checkpoint_id=second.id, status="published", sections=[{"title": "第二讲", "content": "other lecture secret"}]),
                Exercise(checkpoint_id=first.id, title="第一题", description="first exercise", order=1),
                Exercise(checkpoint_id=second.id, title="第二题", description="other exercise secret", order=1),
                ProjectWorkspace(project_id=project.id, learner_id=learner_id, root_path=str(root), status="linked", platform="test"),
            ])
            await db.commit()
            return learner_id, project.id, first.id, second.id

    learner_id, project_id, first_id, second_id = asyncio.run(seed())
    first = client.post("/api/agent/sessions", json={
        "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": first_id,
    })
    assert first.status_code == 200, first.text
    resumed = client.post("/api/agent/sessions", json={
        "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": first_id,
    })
    second = client.post("/api/agent/sessions", json={
        "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": second_id,
    })
    assert resumed.json()["id"] == first.json()["id"]
    assert second.json()["id"] != first.json()["id"]
    assert first.json()["session_type"] == "checkpoint"

    crossed = client.post(f"/api/agent/sessions/{first.json()['id']}/turns", json={
        "message": "切换关卡", "project_id": project_id, "checkpoint_id": second_id,
    })
    assert crossed.status_code == 409
    turn = client.post(f"/api/agent/sessions/{first.json()['id']}/turns", json={
        "message": "只属于第一关的消息", "project_id": project_id, "checkpoint_id": first_id,
        "context": {"surface": "lecture", "selected_text": "第一关选中文本"},
    })
    assert turn.status_code == 200, turn.text
    untouched = client.get(f"/api/agent/sessions/{second.json()['id']}").json()
    assert all("只属于第一关" not in item["content"] for item in untouched["messages"])

    artifacts = client.get(f"/api/checkpoints/{first_id}/workspace/artifacts")
    assert artifacts.status_code == 200
    assert artifacts.json()["managed_lecture"]["checkpoint_id"] == first_id
    assert [item["title"] for item in artifacts.json()["managed_exercises"]] == ["第一题"]

    async def load_context():
        async with async_session() as db:
            return await build_checkpoint_tutor_context(
                db, learner_id=learner_id, project_id=project_id,
                checkpoint_id=first_id,
                surface_context={"surface": "lecture", "selected_text": "selected"},
            )

    context = asyncio.run(load_context())
    rendered = str(context)
    assert "first assigned resource" in rendered
    assert "shared.py" in rendered
    assert "first lecture body" in rendered
    assert "second hidden resource" not in rendered
    assert "other lecture secret" not in rendered
    assert "other exercise secret" not in rendered
    assert context["scope"]["checkpoint_id"] == first_id
    assert context["five_kernel_projection"]["structure"]["short_term"]["session_scope"] == {
        "project_id": project_id, "checkpoint_id": first_id,
    }


async def legacy_learner_id() -> int:
    async with async_session() as db:
        return (await db.execute(select(KernelState.learner_id).limit(1))).scalar_one()


def test_model_json_fallback_is_unwrapped_for_tutor_display():
    reply, observations, opportunity, learning_intent, major_events, local_agent_task = _decode_tutor_content(
        """```json
{"reply":"第一段\\n\\n第二段","observations":[{"kernel":"knowledge","key":"understanding"}],"project_opportunity":null}
```"""
    )
    assert reply == "第一段\n\n第二段"
    assert observations == [{"kernel": "knowledge", "key": "understanding"}]
    assert opportunity is None
    assert learning_intent is None
    assert major_events == []
    assert local_agent_task is None


def test_malformed_math_fence_cannot_swallow_following_markdown():
    malformed = """手动验证：

$$
L = z^2
```

后续解释不应进入公式。

```python
print('still code')
```
"""
    repaired = _repair_markdown_fences(malformed)
    assert "$$\nL = z^2\n$$" in repaired
    assert "```python\nprint('still code')\n```" in repaired
    assert repaired.count("$$") == 2


def test_unclosed_math_is_closed_without_touching_code_dollars():
    malformed = """```python
price = '$5'
```

$$
x^2 + y^2
"""
    repaired = _repair_markdown_fences(malformed)
    assert "price = '$5'" in repaired
    assert repaired.rstrip().endswith("$$")


def test_formal_roadmap_uses_profile_and_treats_stage_preview_as_soft_reference(client: TestClient):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "创建一个路线规划上下文测试项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    async def seed_and_load_context():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            proposal = LearningProjectProposal(
                learner_id=learner_id,
                session_id=session_id,
                proposal_key=f"roadmap-context-{project_id}",
                proposal_type="build",
                status="accepted",
                action_type="create",
                accepted_project_id=project_id,
                artifact={
                    "learning_goal": "理解规划上下文",
                    "practice_goal": "完成可验证产物",
                    "estimated_effort": "每周 5 小时",
                    "acceptance_criteria": ["能够独立完成"],
                    "risks": ["前置基础不足"],
                    "milestones": [
                        {"id": "preview-only", "title": "仅供预览的阶段", "purpose": "提供方向"},
                    ],
                },
            )
            db.add(proposal)
            db.add(Source(
                project_id=project_id,
                type="github",
                url="https://github.com/example/structured-course",
                role="main",
                status="processed",
                meta_data={
                    "repo_analysis": {
                        "structure_logic": "tutorial-progression",
                        "readme_toc": [{"title": "张量与自动求导"}],
                        "dir_groups": [{"name": "Chapter 03 Attention", "is_chapter": True}],
                    },
                },
            ))
            await db.commit()
            current = await load_current_learner(db, learner_id)
            return await _roadmap_planning_context(db, current, project_id)

    context = asyncio.run(seed_and_load_context())
    assert context["input_policy"]["stage_preview_weight"] == "low"
    assert context["learner_profile"]["weekly_hours"] >= 0
    assert context["five_kernel_memory"]
    domains = context["repository_knowledge_domains"]
    assert len(domains) == 1
    assert domains[0]["role"] == "main"
    assert domains[0]["type"] == "github"
    assert domains[0]["structure_logic"] == "tutorial-progression"
    assert domains[0]["domains"] == [
        {"label": "张量与自动求导", "evidence": "README 目录"},
        {"label": "Chapter 03 Attention", "evidence": "章节目录"},
    ]
    assert context["proposal_reference"]["usage"] == "soft_reference_only"
    assert context["proposal_reference"]["stage_preview"][0]["title"] == "仅供预览的阶段"

    agent = object.__new__(RoadmapAgent)
    agent._planning_context = context
    rendered = agent._build_planning_context()
    assert "用户画像与五核记忆" in rendered
    assert "项目来源知识领域" in rendered
    assert "不是学习者状态或掌握证据" in rendered
    assert "低权重参考，不是正式路线骨架" in rendered
    assert "可以合并、重排或舍弃" in rendered


def test_confirmed_route_has_a_structured_submission_fallback():
    class StructuredModel:
        async def ainvoke(self, _messages):
            return SubmittedRoadmap.model_validate({
                "checkpoints": [
                    {
                        "title": "PyTorch 热身",
                        "description": "跑通最小训练循环",
                        "order": 9,
                        "prerequisites": [99],
                        "files": ["chapter01.py", "invented.py"],
                        "key_concepts": ["张量", "自动求导"],
                    },
                    {
                        "title": "因果自注意力",
                        "description": "实现注意力并验证形状",
                        "order": 12,
                        "prerequisites": [1],
                        "files": ["chapter02.py"],
                        "key_concepts": ["因果掩码"],
                    },
                ],
            })

    class FakeLlm:
        def with_structured_output(self, _schema):
            return StructuredModel()

    agent = object.__new__(RoadmapAgent)
    agent.llm = FakeLlm()
    agent._existing_roadmap = None
    agent._last_submitted_roadmap = None
    agent._planning_context = {}
    result = asyncio.run(agent._force_structured_submission(
        message="用户确认路线",
        history=[],
        topic="MiniGPT",
        sources_info=[{
            "source_id": 1,
            "role": "main",
            "repo_analysis": {
                "file_summaries": {
                    "chapter01.py": "训练循环",
                    "chapter02.py": "注意力",
                },
            },
        }],
    ))
    checkpoints = result["updated_roadmap"]["checkpoints"]
    assert [item["order"] for item in checkpoints] == [1, 2]
    assert checkpoints[0]["prerequisites"] == []
    assert checkpoints[0]["files"] == ["chapter01.py"]
    assert checkpoints[1]["prerequisites"] == [1]


def test_roadmap_submission_requires_a_confirmed_tutor_action(client: TestClient):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个路线写入保护测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    response = client.post(
        f"/api/projects/{project_id}/roadmap/chat",
        json={"message": "直接写入路线", "history": [], "require_submission": True},
    )
    assert response.status_code == 409
    assert "确认" in response.json()["detail"]


def test_roadmap_chunk_tools_are_scoped_to_current_project_sources():
    async def seed_chunks():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            first = Project(learner_id=learner_id, name="路线来源隔离 A")
            second = Project(learner_id=learner_id, name="路线来源隔离 B")
            db.add_all([first, second])
            await db.flush()
            allowed = Source(project_id=first.id, type="url", url="https://example.com/a", status="processed")
            blocked = Source(project_id=second.id, type="url", url="https://example.com/b", status="processed")
            db.add_all([allowed, blocked])
            await db.flush()
            allowed_chunk = Chunk(source_id=allowed.id, index=0, content="allowed-roadmap-content", meta_data={"file": "a.md"})
            blocked_chunk = Chunk(source_id=blocked.id, index=0, content="blocked-roadmap-content", meta_data={"file": "b.md"})
            db.add_all([allowed_chunk, blocked_chunk])
            await db.commit()
            return allowed.id, allowed_chunk.id, blocked_chunk.id

    source_id, allowed_chunk_id, blocked_chunk_id = asyncio.run(seed_chunks())
    agent = object.__new__(RoadmapAgent)
    agent._existing_roadmap = None
    agent._last_submitted_roadmap = None
    tools = agent._build_tools([], [{"source_id": source_id, "role": "main"}])
    read_chunk = next(item for item in tools if item.name == "read_chunk")
    result = read_chunk.invoke({"chunk_ids": [allowed_chunk_id, blocked_chunk_id]})
    assert "allowed-roadmap-content" in result
    assert "blocked-roadmap-content" not in result
    assert f"[chunk-{blocked_chunk_id}] （不存在）" in result


def test_explicit_project_command_executes_in_same_turn(client: TestClient):
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "帮我建一个强化学习项目"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["executed_action"]["status"] == "completed"
    assert body["executed_action"]["result"]["project"]["name"] == "强化学习"
    assert "已建立并进入" in body["message"]


def test_add_source_is_direct_and_idempotent(client: TestClient, no_background_tasks):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "创建一个线性代数项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    first = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "把 https://example.com/linear-algebra 加到当前项目"},
    )
    assert first.status_code == 200
    assert first.json()["executed_action"]["status"] == "running"

    second = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "把 https://example.com/linear-algebra/ 加到当前项目"},
    )
    assert second.status_code == 200
    assert second.json()["executed_action"]["result"]["source"]["id"] == first.json()["executed_action"]["result"]["source"]["id"]

    async def count_sources():
        async with async_session() as db:
            rows = (await db.execute(
                select(Source).where(Source.project_id == project_id)
            )).scalars().all()
            return len(rows)

    assert asyncio.run(count_sources()) == 1


def test_global_main_agent_references_active_project_without_becoming_project_tutor(
    client: TestClient,
    no_background_tasks,
):
    project_session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{project_session_id}/turns",
        json={"message": "创建一个跨会话上下文项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]
    assert created["executed_action"]["result"]["navigate_to_project"] is True
    assert created["state_summary"]["session_scope"] == "global"
    assert created["state_summary"]["active_project"] is None
    assert created["state_summary"]["referenced_project"]["id"] == project_id

    global_session_id = new_session(client, create_new=False)
    assert global_session_id == project_session_id
    resumed = client.get(f"/api/agent/sessions/{global_session_id}").json()
    assert resumed["session_type"] == "global"
    assert resumed["project_id"] is None
    assert resumed["state_summary"]["tutor_role"] == "main_agent"
    response = client.post(
        f"/api/agent/sessions/{global_session_id}/turns",
        json={"message": "把 https://example.com/context-source 加到当前项目"},
    )
    assert response.status_code == 200
    assert response.json()["executed_action"]["status"] == "running"
    assert response.json()["executed_action"]["result"]["project"]["id"] == project_id


def test_project_session_handoff_uses_message_and_evidence_refs(client: TestClient):
    global_session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{global_session_id}/turns",
        json={"message": "创建一个会话交接项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]
    project_session = client.post(
        "/api/agent/sessions",
        json={"session_type": "project", "project_id": project_id},
    ).json()
    assert project_session["id"] != global_session_id
    assert project_session["state_summary"]["session_scope"] == "project"
    assert project_session["state_summary"]["tutor_role"] == "project_tutor"
    assert project_session["state_summary"]["active_project"]["id"] == project_id

    async def handoff():
        async with async_session() as db:
            session = await db.get(AgentSession, project_session["id"])
            return (session.context_summary or {}).get("handoff") or {}

    context = asyncio.run(handoff())
    assert context["from_session_id"] == global_session_id
    assert context["message_refs"]
    assert context["evidence_refs"]
    welcome = [
        message for message in project_session["messages"]
        if message["meta_data"].get("message_kind") == "project_welcome"
    ]
    assert len(welcome) == 1
    assert welcome[0]["meta_data"]["project_owner"] is True
    assert "资料选择、正式路线规划" in welcome[0]["content"]

    resumed = client.post(
        "/api/agent/sessions",
        json={"session_type": "project", "project_id": project_id},
    ).json()
    assert len([
        message for message in resumed["messages"]
        if message["meta_data"].get("message_kind") == "project_welcome"
    ]) == 1


def test_accepted_project_welcome_carries_candidate_source_attachment(
    client: TestClient,
    no_background_tasks,
):
    session_id = new_session(client)

    async def create_unique_proposal():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            proposal = LearningProjectProposal(
                learner_id=learner_id,
                session_id=session_id,
                proposal_key=f"welcome-attachment-{uuid.uuid4().hex[:12]}",
                proposal_type="build",
                status="ready",
                artifact={
                    "title": "项目 Tutor 欢迎语测试",
                    "learning_goal": "验证项目 Tutor 能持续承接项目上下文",
                    "practice_goal": "完成一个可验证产物",
                    "candidate_sources": [{
                        "title": "example/learning-source",
                        "url": "https://github.com/example/learning-source",
                        "type": "github",
                    }],
                },
                source_status="completed",
            )
            db.add(proposal)
            await db.commit()
            await db.refresh(proposal)
            return proposal.id

    proposal_id = asyncio.run(create_unique_proposal())
    accepted = client.post(
        f"/api/agent/project-proposals/{proposal_id}/accept",
        json={"client_event_id": f"welcome-attachment-{proposal_id}"},
    ).json()
    project_id = accepted["executed_action"]["result"]["project"]["id"]
    project_session = client.post(
        "/api/agent/sessions",
        json={"session_type": "project", "project_id": project_id},
    ).json()
    welcome = next(
        message for message in project_session["messages"]
        if message["meta_data"].get("message_kind") == "project_welcome"
    )
    assert welcome["meta_data"]["attachment"] == {
        "type": "candidate_sources",
        "proposal_id": proposal_id,
    }
    assert "候选来源" in welcome["content"]


def test_candidate_source_completion_continues_project_tutor_session(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个来源收尾测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]
    proposal_id = 900_000 + project_id

    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={
            "message": "候选来源选择完毕，请继续安排下一步。",
            "project_id": project_id,
            "client_turn_id": f"candidate-sources-completed-{project_id}",
            "context": {
                "interaction": "candidate_sources_completed",
                "proposal_id": proposal_id,
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["executed_action"] is None
    assert body["message"] == "未接入模型。"

    restored = client.get(f"/api/agent/sessions/{session_id}").json()
    completed_turn = next(
        message for message in reversed(restored["messages"])
        if message["role"] == "user"
        and message["meta_data"].get("interaction") == "candidate_sources_completed"
    )
    assert completed_turn["meta_data"]["proposal_id"] == proposal_id


def test_tutor_reports_missing_model_without_fallback_copy(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "请解释一下这个概念", "client_turn_id": f"missing-model-{uuid.uuid4().hex}"},
    )
    assert response.status_code == 200
    assert response.json()["message"] == "未接入模型。"


def test_tutor_structured_and_plain_attempts_share_one_model_budget(
    client: TestClient,
    monkeypatch,
):
    class SlowModel:
        def __init__(self, **_kwargs):
            pass

        def with_structured_output(self, _schema):
            return self

        async def ainvoke(self, _messages):
            await asyncio.sleep(1)

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", SlowModel)
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.tutor_service.settings.tutor_model_budget_seconds",
        0.01,
    )
    session_id = new_session(client)

    started = time.perf_counter()
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={
            "message": "请简单聊聊今天的学习安排",
            "client_turn_id": f"slow-model-{uuid.uuid4().hex}",
        },
    )

    assert time.perf_counter() - started < 1
    assert response.status_code == 200
    assert "模型已经配置" in response.json()["message"]
    assert "超过" in response.json()["message"]


def test_explanation_mode_uses_latency_safe_plain_reply(
    client: TestClient,
    monkeypatch,
):
    class PlainExplanationModel:
        def __init__(self, **_kwargs):
            pass

        def with_structured_output(self, _schema):
            raise AssertionError("简单讲解不应先等待结构化输出")

        async def ainvoke(self, messages):
            assert "本轮使用纯文本兼容输出" in messages[0].content
            return type("PlainResult", (), {
                "content": "核方法用核函数隐式比较高维空间中的样本关系。",
            })()

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", PlainExplanationModel)
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    session_id = new_session(client)
    response = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "跟我讲讲什么是核方法",
        "client_turn_id": f"plain-explain-{uuid.uuid4().hex}",
    })

    assert response.status_code == 200, response.text
    assert response.json()["chat_mode"]["id"] == "explain"
    assert response.json()["message"] == "核方法用核函数隐式比较高维空间中的样本关系。"


def test_structured_timeout_preserves_budget_for_plain_fallback(
    client: TestClient,
    monkeypatch,
):
    calls = {
        "structured": 0,
        "structured_cancelled": False,
        "plain": 0,
    }

    class SlowStructuredInvoker:
        async def ainvoke(self, _messages):
            calls["structured"] += 1
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                calls["structured_cancelled"] = True
                raise

    class FallbackModel:
        def __init__(self, **_kwargs):
            pass

        def with_structured_output(self, _schema):
            return SlowStructuredInvoker()

        async def ainvoke(self, messages):
            calls["plain"] += 1
            assert "本轮使用纯文本兼容输出" in messages[0].content
            return type("PlainResult", (), {"content": "你好，我们可以先明确今天的目标。"})()

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", FallbackModel)
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.tutor_service.settings.tutor_model_budget_seconds",
        0.08,
    )
    session_id = new_session(client)

    response = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "你好",
        "client_turn_id": f"plain-reserve-{uuid.uuid4().hex}",
    })

    assert response.status_code == 200, response.text
    assert response.json()["message"] == "你好，我们可以先明确今天的目标。"
    assert calls == {
        "structured": 1,
        "structured_cancelled": True,
        "plain": 1,
    }


def test_empty_model_reply_uses_skill_fallback_instead_of_blank_message(
    client: TestClient,
    monkeypatch,
):
    class EmptyStructuredResult:
        reply = ""
        project_opportunity = None
        learning_intent = None
        local_agent_task = None
        learning_task_opportunity = None
        observations = []
        major_event_candidates = []

    class EmptyStructuredInvoker:
        async def ainvoke(self, _messages):
            return EmptyStructuredResult()

    class EmptyModel:
        def __init__(self, **_kwargs):
            pass

        def with_structured_output(self, _schema):
            return EmptyStructuredInvoker()

        async def ainvoke(self, _messages):
            return type("EmptyPlainResult", (), {"content": ""})()

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", EmptyModel)
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.tutor_service.settings.tutor_model_budget_seconds",
        0.1,
    )
    session_id = new_session(client)
    topic = f"空白回复概念{uuid.uuid4().hex[:8]}"
    response = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": f"跟我讲讲什么是{topic}",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"empty-skill-{uuid.uuid4().hex}",
    })
    assert response.status_code == 200, response.text
    assert "不应该让你凭空猜" in response.json()["message"]
    assert response.json()["message"].strip()


def test_active_skill_uses_plain_tutor_call_without_structured_detour(
    client: TestClient,
    monkeypatch,
):
    class PlainOnlyModel:
        def __init__(self, **_kwargs):
            pass

        def with_structured_output(self, _schema):
            raise AssertionError("进行中的 Skill 不应请求结构化 Tutor 输出")

        async def ainvoke(self, _messages):
            return type("PlainResult", (), {
                "content": "先给一个最小解释和具体例子，再请你判断一个变化。",
            })()

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", PlainOnlyModel)
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    session_id = new_session(client)
    response = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "跟我讲讲什么是朴素贝叶斯分类器",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"plain-skill-{uuid.uuid4().hex}",
    })
    assert response.status_code == 200, response.text
    assert response.json()["message"] == "先给一个最小解释和具体例子，再请你判断一个变化。"


def test_valid_skill_attempt_does_not_repeat_reused_opening_scaffold(
    client: TestClient,
    monkeypatch,
):
    class EmptyModel:
        def __init__(self, **_kwargs):
            pass

        async def ainvoke(self, _messages):
            return type("EmptyPlainResult", (), {"content": ""})()

    async def existing_scaffold(*_args, **_kwargs):
        return "已有材料中的主题讲义支架"

    monkeypatch.setattr("app.services.tutor_service.ChatOpenAI", EmptyModel)
    monkeypatch.setattr(
        "app.services.tutor_service._existing_skill_scaffold",
        existing_scaffold,
    )
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.tutor_service.settings.tutor_model_budget_seconds",
        0.1,
    )
    session_id = new_session(client)
    opening = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "跟我讲讲什么是测试分类器",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"reused-scaffold-open-{uuid.uuid4().hex}",
    })
    assert opening.status_code == 200, opening.text
    assert opening.json()["message"] == "已有材料中的主题讲义支架"
    assert opening.json()["active_skill_run"]["turn_count"] == 0

    attempted = client.post(f"/api/agent/sessions/{session_id}/turns", json={
        "message": "我猜它会结合类别原本的比例和当前观察到的特征。",
        "selected_skill_id": "socratic_dialogue",
        "client_turn_id": f"reused-scaffold-attempt-{uuid.uuid4().hex}",
    })
    assert attempted.status_code == 200, attempted.text
    body = attempted.json()
    assert body["message"] != "已有材料中的主题讲义支架"
    assert "关键条件" in body["message"]
    assert body["active_skill_run"]["state"] == "testing_assumption"
    assert body["active_skill_run"]["turn_count"] == 1
    assert body["active_skill_run"]["last_response_signal"] == "attempt"


def test_project_tutor_routes_formal_learning_into_checkpoints(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "")
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个 Tutor 关卡边界测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    completed = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={
            "message": "候选来源选择完毕，请继续安排下一步。",
            "project_id": project_id,
            "context": {
                "interaction": "candidate_sources_completed",
                "proposal_id": 910_000 + project_id,
            },
        },
    )
    assert completed.status_code == 200

    async def fake_roadmap_chat(self, message, **_kwargs):
        if "已经明确确认" in message or "以“开始”明确确认" in message:
            return {
                "message": "路线已经按确认结果保存。",
                "updated_roadmap": {
                    "checkpoints": [
                        {
                            "title": "PyTorch 热身",
                            "description": "在关卡内完成张量、自动求导与最小训练循环。",
                            "order": 1,
                            "prerequisites": [],
                            "chunk_ids": [],
                            "files": [],
                            "key_concepts": ["张量", "自动求导", "训练循环"],
                        },
                        {
                            "title": "因果自注意力",
                            "description": "实现并验证注意力中的张量形状流动。",
                            "order": 2,
                            "prerequisites": [1],
                            "chunk_ids": [],
                            "files": [],
                            "key_concepts": ["因果掩码", "多头注意力"],
                        },
                    ],
                    "archives": [],
                },
            }
        return {
            "message": "正式路线提案：先做 PyTorch 热身，再进入因果自注意力。确认后写入项目关卡。",
            "updated_roadmap": None,
        }

    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(RoadmapAgent, "chat", fake_roadmap_chat)

    planned = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={
            "message": (
                "A 几乎没用过 PyTorch；B 能说出自注意力的大意，但不清楚张量形状；"
                "C 可以租 GPU，但需要环境指导。每周投入 7 小时。"
            ),
            "project_id": project_id,
        },
    )
    assert planned.status_code == 200
    planned_body = planned.json()
    assert planned_body["executed_action"]["title"] == "规划学习路线"
    assert planned_body["executed_action"]["result"]["updated_roadmap"] is None
    assert "正式路线提案" in planned_body["message"]
    assert "import torch" not in planned_body["message"]
    confirmation_card = planned_body["action_card"]
    assert confirmation_card["title"] == "应用学习路线"
    assert confirmation_card["status"] == "pending_confirmation"
    assert confirmation_card["primary_label"] == "确认并生成关卡图"

    applied = client.post(
        f"/api/agent/actions/{confirmation_card['id']}/confirm",
    )
    assert applied.status_code == 200
    applied_body = applied.json()
    assert applied_body["executed_action"]["title"] == "应用学习路线"
    assert applied_body["executed_action"]["result"]["updated_roadmap"] is not None
    assert "讲义、练习、代码任务和验证会放在各自关卡中" in applied_body["message"]

    async def route_state():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            checkpoints = list((await db.execute(
                select(Checkpoint)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .where(Roadmap.project_id == project_id)
                .order_by(Checkpoint.order)
            )).scalars().all())
            lectures = list((await db.execute(
                select(Lecture).where(Lecture.checkpoint_id.in_([item.id for item in checkpoints]))
            )).scalars().all()) if checkpoints else []
            return session.context_summary, checkpoints, lectures

    context_summary, checkpoints, lectures = asyncio.run(route_state())
    assert (context_summary.get("learning_flow") or {}).get("phase") == "roadmap_ready"
    assert [item.title for item in checkpoints] == ["PyTorch 热身", "因果自注意力"]
    assert lectures == []

    entered = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "开始", "project_id": project_id},
    )
    assert entered.status_code == 200
    assert entered.json()["executed_action"]["title"] == "进入检查点"
    assert entered.json()["executed_action"]["result"]["checkpoint"]["title"] == "PyTorch 热身"


def test_direct_checkpoint_learning_request_and_confirmation_use_roadmap_tool(
    client: TestClient,
    monkeypatch,
):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个 直接关卡测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    async def fake_roadmap_chat(self, message, **_kwargs):
        confirmed = "已经明确确认" in message
        return {
            "message": "路线已保存。" if confirmed else "正式路线提案，共两关，请确认。",
            "updated_roadmap": ({
                "checkpoints": [
                    {
                        "title": "基础关",
                        "description": "完成基础训练闭环",
                        "order": 1,
                        "prerequisites": [],
                        "chunk_ids": [],
                        "files": [],
                        "key_concepts": ["训练循环"],
                    },
                    {
                        "title": "实践关",
                        "description": "完成可验证实践产物",
                        "order": 2,
                        "prerequisites": [1],
                        "chunk_ids": [],
                        "files": [],
                        "key_concepts": ["实践验证"],
                    },
                ],
                "archives": [],
            } if confirmed else None),
        }

    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(RoadmapAgent, "chat", fake_roadmap_chat)

    proposed = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我想直接进入关卡学习", "project_id": project_id},
    )
    assert proposed.status_code == 200
    assert proposed.json()["executed_action"]["title"] == "规划学习路线"
    assert proposed.json()["executed_action"]["result"]["updated_roadmap"] is None

    confirmed = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "确认", "project_id": project_id},
    )
    assert confirmed.status_code == 200
    body = confirmed.json()
    assert body["executed_action"]["title"] == "应用学习路线"
    assert len(body["executed_action"]["result"]["updated_roadmap"]["checkpoints"]) == 2


def test_confirmation_recovers_a_recent_text_only_route_proposal(
    client: TestClient,
    monkeypatch,
):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个 文本路线恢复测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    async def seed_text_proposal():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            session.session_type = "project"
            session.project_id = project_id
            session.context_summary = {}
            db.add(AgentMessage(
                session_id=session_id,
                role="assistant",
                content="## 正式学习路线（确认后生效）\n阶段 0 基础关；阶段 1 实践关。",
            ))
            await db.commit()

    asyncio.run(seed_text_proposal())

    async def fake_roadmap_chat(self, message, **_kwargs):
        del message
        return {
            "message": "路线已真实写入。",
            "updated_roadmap": {
                "checkpoints": [
                    {
                        "title": "基础关", "description": "基础", "order": 1,
                        "prerequisites": [], "chunk_ids": [], "files": [], "key_concepts": [],
                    },
                    {
                        "title": "实践关", "description": "实践", "order": 2,
                        "prerequisites": [1], "chunk_ids": [], "files": [], "key_concepts": [],
                    },
                ],
                "archives": [],
            },
        }

    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(RoadmapAgent, "chat", fake_roadmap_chat)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "确认", "project_id": project_id},
    )
    assert response.status_code == 200
    assert response.json()["executed_action"]["title"] == "应用学习路线"
    assert response.json()["executed_action"]["result"]["updated_roadmap"] is not None


def test_natural_route_confirmation_after_tutor_prompt_applies_roadmap(
    client: TestClient,
    monkeypatch,
):
    session_id = new_session(client)
    created = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": f"创建一个 自然确认路线测试 {uuid.uuid4().hex[:8]} 项目"},
    ).json()
    project_id = created["executed_action"]["result"]["project"]["id"]

    async def seed_route_prompt():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            session.session_type = "project"
            session.project_id = project_id
            session.context_summary = {"learning_flow": {"phase": "roadmap_intake"}}
            db.add(AgentMessage(
                session_id=session_id,
                role="assistant",
                content=(
                    "我已经根据你的目标整理好路线：先完成基础关，再进入实践关。"
                    "确认这条路线后，我就正式建立路线。"
                ),
            ))
            await db.commit()

    asyncio.run(seed_route_prompt())

    async def fake_roadmap_chat(self, message, **_kwargs):
        assert "已经明确确认" in message
        return {
            "message": "路线已真实写入。",
            "updated_roadmap": {
                "checkpoints": [
                    {
                        "title": "基础关", "description": "基础", "order": 1,
                        "prerequisites": [], "chunk_ids": [], "files": [], "key_concepts": [],
                    },
                    {
                        "title": "实践关", "description": "实践", "order": 2,
                        "prerequisites": [1], "chunk_ids": [], "files": [], "key_concepts": [],
                    },
                ],
                "archives": [],
            },
        }

    monkeypatch.setattr("app.services.tutor_service.settings.llm_api_key", "test-key")
    monkeypatch.setattr(RoadmapAgent, "chat", fake_roadmap_chat)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我确认这条路线", "project_id": project_id},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["executed_action"]["title"] == "应用学习路线"
    assert body["executed_action"]["result"]["updated_roadmap"] is not None
    assert body["executed_action"]["result"]["checkpoint"]["title"] == "基础关"
    assert body["executed_action"]["result"]["entry_mode"] == "automatic_after_roadmap"
    assert "已直接进入第一关「基础关」" in body["message"]

    async def route_state():
        async with async_session() as db:
            checkpoints = list((await db.execute(
                select(Checkpoint)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .where(Roadmap.project_id == project_id)
                .order_by(Checkpoint.order)
            )).scalars().all())
            session = await db.get(AgentSession, session_id)
            events = list((await db.execute(
                select(EvidenceEvent.event_type, EvidenceEvent.payload)
                .where(EvidenceEvent.session_id == session_id)
                .order_by(EvidenceEvent.id)
            )).all())
            return [item.title for item in checkpoints], session.checkpoint_id, events

    titles, active_checkpoint_id, events = asyncio.run(route_state())
    assert titles == ["基础关", "实践关"]
    assert active_checkpoint_id == body["executed_action"]["result"]["checkpoint"]["id"]
    entered = [payload for event_type, payload in events if event_type == "checkpoint_entered"]
    assert entered == [{"title": "基础关", "entry_mode": "automatic_after_roadmap"}]


def test_add_source_uses_recent_url(client: TestClient, no_background_tasks):
    session_id = new_session(client)
    client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "创建一个分步来源项目"},
    )
    client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "https://example.com/recent-source"},
    )
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "添加这个来源"},
    )
    assert response.status_code == 200
    assert response.json()["executed_action"]["status"] == "running"
    assert response.json()["executed_action"]["result"]["source"]["url"] == "https://example.com/recent-source"


def test_project_opportunity_requires_confirmation(client: TestClient):
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我想系统学习概率论并做一套配套练习"},
    )
    assert response.status_code == 200
    proposal = response.json()["proposal_update"]
    assert proposal["status"] == "ready"
    assert response.json()["executed_action"] is None

    confirmed = client.post(
        f"/api/agent/project-proposals/{proposal['id']}/accept",
        json={"client_event_id": f"accept-probability-{proposal['id']}"},
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["executed_action"]["status"] == "completed"


def test_plain_question_does_not_create_project_card(client: TestClient):
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "什么是矩阵的特征值？"},
    )
    assert response.status_code == 200
    assert response.json()["action_card"] is None


def test_acknowledgement_is_low_confidence_only(client: TestClient):
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "懂了"},
    )
    assert response.status_code == 200

    async def event_for_message():
        async with async_session() as db:
            return (await db.execute(
                select(EvidenceEvent)
                .where(
                    EvidenceEvent.session_id == session_id,
                    EvidenceEvent.event_type == "user_message",
                )
                .order_by(EvidenceEvent.id.desc())
                .limit(1)
            )).scalar_one()

    event = asyncio.run(event_for_message())
    assert event.confidence == pytest.approx(0.25)


def test_evidence_is_written_for_explicit_action(client: TestClient):
    async def latest():
        async with async_session() as db:
            return (await db.execute(
                select(EvidenceEvent)
                .where(EvidenceEvent.event_type == "project_created")
                .order_by(EvidenceEvent.id.desc())
                .limit(1)
            )).scalar_one_or_none()

    event = asyncio.run(latest())
    assert event is not None
    assert event.source == "tutor_tool"
    assert event.provenance.get("action_id")


def test_action_confirmation_is_not_repeated(client: TestClient):
    session_id = new_session(client)
    proposal = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我想制定一个系统学习统计学的计划并持续练习"},
    ).json()
    proposal_id = proposal["proposal_update"]["id"]
    turn = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "就这个"},
    )
    assert turn.status_code == 200
    assert turn.json()["executed_action"]["status"] == "completed"
    assert turn.json()["proposal_update"]["id"] == proposal_id
    assert turn.json()["proposal_update"]["status"] == "accepted"


def test_continue_accepts_project_proposal_without_main_agent_teaching(
    client: TestClient,
    monkeypatch,
):
    session_id = new_session(client)
    proposal_key = f"continue-handoff-{uuid.uuid4().hex[:12]}"

    async def seed_proposal():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            proposal = LearningProjectProposal(
                learner_id=learner_id,
                session_id=session_id,
                proposal_key=proposal_key,
                proposal_type="build",
                status="ready",
                action_type="create",
                artifact={
                    "title": "RL Gymnasium 热身",
                    "learning_goal": "理解 Gymnasium 中环境与智能体的交互循环",
                    "practice_goal": "完成可运行的 CartPole 随机策略",
                    "learner_start": ["会 Python，尚未使用 Gymnasium"],
                    "estimated_effort": "每周 2–3 小时",
                    "milestones": [{"id": "warmup", "title": "Gymnasium 热身"}],
                    "acceptance_criteria": ["能独立运行 CartPole 循环"],
                    "risks": ["环境安装问题"],
                },
            )
            db.add(proposal)
            await db.commit()
            await db.refresh(proposal)
            return proposal.id

    proposal_id = asyncio.run(seed_proposal())

    async def fail_if_llm_is_called(*_args, **_kwargs):
        raise AssertionError("项目确认回合不应调用主 Agent LLM")

    monkeypatch.setattr(
        "app.services.tutor_service._generate_tutor_reply",
        fail_if_llm_is_called,
    )
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={
            "message": "继续",
            "client_turn_id": f"accept-{proposal_key}",
        },
    )
    assert response.status_code == 200
    body = response.json()
    project = body["executed_action"]["result"]["project"]
    assert body["executed_action"]["status"] == "completed"
    assert body["executed_action"]["result"]["navigate_to_project"] is True
    assert body["proposal_update"]["id"] == proposal_id
    assert body["proposal_update"]["status"] == "accepted"
    assert body["message"] == (
        "已建立并进入「RL Gymnasium 热身」，"
        "项目 Tutor 与路径规划 Agent 已接手。"
    )

    async def load_handoff_and_planning_context():
        async with async_session() as db:
            project_session = await get_or_create_session(
                db,
                learner_id=await legacy_learner_id(),
                session_type="project",
                project_id=project["id"],
            )
            await db.commit()
            current = await load_current_learner(db, await legacy_learner_id())
            planning_context = await _roadmap_planning_context(
                db, current, project["id"],
            )
            return project_session.context_summary, planning_context

    handoff, planning_context = asyncio.run(load_handoff_and_planning_context())
    assert handoff["handoff"]["from_session_id"] == session_id
    assert handoff["handoff"]["message_refs"]
    assert handoff["handoff"]["evidence_refs"]
    assert planning_context["proposal_reference"]["proposal_id"] == proposal_id
    assert planning_context["proposal_reference"]["learning_goal"].startswith("理解 Gymnasium")
    assert planning_context["proposal_reference"]["practice_goal"].startswith("完成可运行")
    assert planning_context["proposal_reference"]["estimated_effort"] == "每周 2–3 小时"


def test_gpt_goal_creates_and_evolves_one_build_proposal(client: TestClient, no_background_tasks):
    session_id = new_session(client)
    first = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我想自己动手实现一个g p t"},
    ).json()
    proposal = first["proposal_update"]
    assert proposal["proposal_type"] == "build"
    assert "GPT" in proposal["artifact"]["title"]
    proposal_id = proposal["id"]

    second = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "用p y to r ch"},
    ).json()
    assert second["proposal_update"]["id"] == proposal_id
    assert second["project_proposals"][0]["artifact"]["details"]["stack"] == ["Python", "PyTorch"]

    third = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "没用过Pytorch，只学过python的CS61A"},
    ).json()
    assert third["proposal_update"]["id"] == proposal_id
    titles = [item["title"] for item in third["proposal_update"]["artifact"]["milestones"]]
    assert titles[:2] == ["PyTorch 张量与自动求导", "手写最小 PyTorch 训练循环"]
    assert "CS61A" in " ".join(third["proposal_update"]["artifact"]["learner_start"])
    assert "当前基础" in third["proposal_update"]["last_change_summary"]

    short_turn = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "张量和列表有什么区别？"},
    ).json()
    assert short_turn["proposal_update"] is None
    assert any(item["id"] == proposal_id for item in short_turn["project_proposals"])

    edited = client.patch(
        f"/api/agent/project-proposals/{proposal_id}",
        json={
            "patch": {"title": "我的 PyTorch MiniGPT"},
            "lock_fields": ["title"],
            "client_event_id": f"edit-gpt-title-{proposal_id}",
        },
    ).json()
    assert edited["artifact"]["title"] == "我的 PyTorch MiniGPT"
    assert "title" in edited["locked_fields"]

    accepted = client.post(
        f"/api/agent/project-proposals/{proposal_id}/accept",
        json={"client_event_id": f"accept-gpt-{proposal_id}"},
    ).json()
    repeated = client.post(
        f"/api/agent/project-proposals/{proposal_id}/accept",
        json={"client_event_id": f"accept-gpt-{proposal_id}-retry"},
    ).json()
    assert accepted["executed_action"]["result"]["project"]["id"] == repeated["executed_action"]["result"]["project"]["id"]

    async def count_created():
        async with async_session() as db:
            proposals = (await db.execute(
                select(LearningProjectProposal).where(LearningProjectProposal.id == proposal_id)
            )).scalars().all()
            projects = (await db.execute(
                select(Project).where(Project.name == "我的 PyTorch MiniGPT")
            )).scalars().all()
            return len(proposals), len(projects)

    assert asyncio.run(count_created()) == (1, 1)


def test_resource_search_failure_does_not_remove_proposal(
    client: TestClient,
    no_background_tasks,
    monkeypatch,
):
    session_id = new_session(client)
    response = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "我想自己动手实现一个 Transformer"},
    ).json()
    proposal = response["proposal_update"]
    assert proposal["source_task_id"]

    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            raise RuntimeError("offline")

    monkeypatch.setattr(proposal_service.httpx, "AsyncClient", lambda **_kwargs: FailingClient())
    asyncio.run(proposal_service.run_resource_search(proposal["source_task_id"]))
    latest = client.get(f"/api/agent/project-proposals/{proposal['id']}").json()
    assert latest["source_status"] == "failed"
    assert latest["artifact"]["title"]


def test_resource_search_ranking_prefers_relevant_popular_learning_repositories():
    artifact = {
        "title": "从 Python 到手写 MiniGPT",
        "learning_goal": "理解并亲手实现 GPT",
        "practice_goal": "用 PyTorch 完成一个可训练的 decoder-only Transformer",
        "learner_start": ["没用过 PyTorch，只学过 Python"],
        "source_search_query": "gpt pytorch language:Python",
        "details": {"stack": ["Python", "PyTorch"]},
        "milestones": [],
    }
    items = [
        {
            "full_name": "rasbt/LLMs-from-scratch",
            "html_url": "https://github.com/rasbt/LLMs-from-scratch",
            "description": "Implement a ChatGPT-like LLM in PyTorch from scratch, step by step",
            "stargazers_count": 102176,
            "forks_count": 15654,
            "pushed_at": "2026-08-10T01:11:40Z",
            "language": "Jupyter Notebook",
            "topics": ["llm", "pytorch", "transformer"],
            "license": {"spdx_id": "MIT"},
            "fork": False,
            "archived": False,
        },
        {
            "full_name": "karpathy/minGPT",
            "html_url": "https://github.com/karpathy/minGPT",
            "description": "A minimal PyTorch re-implementation of the OpenAI GPT training",
            "stargazers_count": 24785,
            "forks_count": 3312,
            "pushed_at": "2024-08-15T04:09:40Z",
            "language": "Python",
            "topics": ["gpt", "pytorch"],
            "license": {"spdx_id": "MIT"},
            "fork": False,
            "archived": False,
        },
        {
            "full_name": "otahina/PowerPoint-Generator-Python-Project",
            "html_url": "https://github.com/otahina/PowerPoint-Generator-Python-Project",
            "description": "Generate PowerPoint slides using ChatGPT",
            "stargazers_count": 405,
            "forks_count": 20,
            "pushed_at": "2026-01-01T00:00:00Z",
            "language": "Python",
            "topics": [],
            "license": None,
            "fork": False,
            "archived": False,
        },
    ]
    candidates = proposal_service._rank_repository_candidates(
        items, artifact, None, generation=1, previous_urls=[],
    )
    assert [item["title"] for item in candidates] == [
        "rasbt/LLMs-from-scratch", "karpathy/minGPT",
    ]
    assert candidates[0]["quality"] == "excellent"
    assert candidates[0]["rank_score"] > candidates[1]["rank_score"]
    assert all("PowerPoint" not in item["title"] for item in candidates)

    first_plans = proposal_service._github_search_plans(artifact, 1)
    refresh_plans = proposal_service._github_search_plans(artifact, 2)
    assert len(first_plans) == len(refresh_plans) == 3
    assert first_plans == refresh_plans
    assert "nanoGPT OR minGPT" in first_plans[-1]["q"]


def test_force_refresh_creates_a_new_search_generation(client: TestClient, no_background_tasks):
    session_id = new_session(client)
    async def create_searching_proposal():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            stored = LearningProjectProposal(
                learner_id=learner_id,
                session_id=session_id,
                proposal_key=f"refresh-candidates-{uuid.uuid4().hex[:12]}",
                proposal_type="build",
                status="ready",
                artifact={
                    "title": "刷新候选测试 GPT",
                    "learning_goal": "从零实现 GPT",
                    "practice_goal": "用 PyTorch 完成可训练模型",
                    "learner_start": ["尚未使用过 PyTorch"],
                    "milestones": [],
                    "details": {"stack": ["Python", "PyTorch"]},
                    "source_search_query": "gpt pytorch language:Python",
                },
            )
            db.add(stored)
            await db.flush()
            await proposal_service.start_resource_search(db, stored)
            return proposal_service.proposal_view(stored)

    proposal = asyncio.run(create_searching_proposal())
    first_task_id = proposal["source_task_id"]
    assert proposal["artifact"]["source_search_generation"] == 1

    async def finish_first_search():
        async with async_session() as db:
            stored = await db.get(LearningProjectProposal, proposal["id"])
            task = await db.get(proposal_service.Task, first_task_id)
            artifact = dict(stored.artifact or {})
            artifact["candidate_sources"] = [{
                "title": "example/old", "url": "https://github.com/example/old", "type": "github",
            }]
            artifact["source_search_completed_query"] = artifact["source_search_query"]
            stored.artifact = artifact
            stored.source_status = "completed"
            task.status = "completed"
            await db.commit()

    asyncio.run(finish_first_search())
    refreshed = client.post(
        f"/api/agent/project-proposals/{proposal['id']}/refresh-sources",
    ).json()
    assert refreshed["source_status"] == "queued"
    assert refreshed["source_task_id"] != first_task_id
    assert refreshed["artifact"]["source_search_generation"] == 2
    assert refreshed["artifact"]["candidate_sources"][0]["title"] == "example/old"


def test_distinct_long_term_goals_keep_at_most_three_active_proposals(client: TestClient):
    session_id = new_session(client)
    for message in (
        "我想自己动手实现一个编译器",
        "我想系统学习微积分",
        "我想构建一个数据库",
        "我想研究操作系统",
    ):
        client.post(f"/api/agent/sessions/{session_id}/turns", json={"message": message})
    session = client.get(f"/api/agent/sessions/{session_id}").json()
    keys = [item["proposal_key"] for item in session["project_proposals"]]
    assert len(keys) == 3
    assert len(set(keys)) == 3


def test_missing_parameter_is_asked_once_then_reused(client: TestClient):
    session_id = new_session(client)
    first = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "创建一个学习项目"},
    ).json()
    action_id = first["executed_action"]["id"]
    assert first["executed_action"]["status"] == "needs_input"

    second = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "图论"},
    ).json()
    assert second["executed_action"]["id"] == action_id
    assert second["executed_action"]["status"] == "completed"
    assert second["executed_action"]["result"]["project"]["name"] == "图论"


def test_duplicate_project_name_is_disambiguated_once(client: TestClient):
    async def create_duplicates():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            first = Project(learner_id=learner_id, name="同名课程", description="第一版", user_level="beginner")
            second = Project(learner_id=learner_id, name="同名课程", description="第二版", user_level="beginner")
            db.add_all([first, second])
            await db.commit()
            return first.id, second.id

    _, second_id = asyncio.run(create_duplicates())
    session_id = new_session(client)
    first_turn = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "进入同名课程项目"},
    ).json()
    action_id = first_turn["executed_action"]["id"]
    assert first_turn["executed_action"]["status"] == "needs_input"

    selected = client.post(
        f"/api/agent/sessions/{session_id}/turns",
        json={"message": "选项 2"},
    ).json()
    assert selected["executed_action"]["id"] == action_id
    assert selected["executed_action"]["status"] == "completed"
    assert selected["executed_action"]["result"]["project"]["id"] == second_id


def test_duplicate_turn_request_replays_without_side_effect(client: TestClient):
    session_id = new_session(client)
    payload = {
        "message": "创建一个幂等回合项目",
        "client_turn_id": "turn-idempotency-project-create",
    }
    first = client.post(f"/api/agent/sessions/{session_id}/turns", json=payload).json()
    second = client.post(f"/api/agent/sessions/{session_id}/turns", json=payload).json()
    assert second["executed_action"]["id"] == first["executed_action"]["id"]

    async def count_projects():
        async with async_session() as db:
            return len((await db.execute(
                select(Project).where(Project.name == "幂等回合")
            )).scalars().all())

    assert asyncio.run(count_projects()) == 1


def test_lecture_is_exposure_not_completion(client: TestClient):
    async def scenario():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(learner_id=learner_id, name="完成语义测试", description="", user_level="beginner")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={"checkpoints": []})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="只生成讲义",
                order=1,
                completed=False,
                learning_status="not_started",
                legacy_completed=False,
            )
            db.add(checkpoint)
            await db.flush()
            db.add(Lecture(checkpoint_id=checkpoint.id, sections=[{"title": "一", "content": "内容"}], status="published"))
            await db.flush()

            status = await evaluate_checkpoint_status(db, checkpoint.id)
            assert status == "in_progress"
            assert checkpoint.completed is False

            await create_attempt(
                db, learner_id=learner_id, checkpoint_id=checkpoint.id, item_type="concept", item_id=1,
                submission={"answer_indexes": [0]}, result={"correct": True},
            )
            await create_attempt(
                db, learner_id=learner_id, checkpoint_id=checkpoint.id, item_type="exercise", item_id=1,
                submission={"code": "pass"}, result={"passed": 1, "total": 1},
            )
            status = await evaluate_checkpoint_status(db, checkpoint.id)
            assert status == "completed"
            assert checkpoint.completed is True
            await db.rollback()

    asyncio.run(scenario())


def test_assisted_attempts_do_not_complete_checkpoint(client: TestClient):
    async def scenario():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(learner_id=learner_id, name="辅助作答测试", description="", user_level="beginner")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={"checkpoints": []})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="独立性验证",
                order=1,
                completed=False,
                learning_status="not_started",
                legacy_completed=False,
            )
            db.add(checkpoint)
            await db.flush()
            await create_attempt(
                db, learner_id=learner_id, checkpoint_id=checkpoint.id, item_type="concept", item_id=1,
                submission={}, result={"correct": True}, assistance_level="guided",
            )
            await create_attempt(
                db, learner_id=learner_id, checkpoint_id=checkpoint.id, item_type="exercise", item_id=1,
                submission={}, result={"passed": 1, "total": 1}, assistance_level="hint",
            )
            assert await evaluate_checkpoint_status(db, checkpoint.id) == "in_progress"
            assert checkpoint.completed is False
            await db.rollback()

    asyncio.run(scenario())


def test_legacy_completion_requires_verification(client: TestClient):
    async def scenario():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(learner_id=learner_id, name="旧进度测试", description="", user_level="beginner")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={"checkpoints": []})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="旧完成关卡",
                order=1,
                completed=True,
                learning_status="verification_due",
                legacy_completed=True,
                progress={"lecture_generated": True},
            )
            db.add(checkpoint)
            await db.flush()
            assert await evaluate_checkpoint_status(db, checkpoint.id, learner_id=learner_id) == "verification_due"
            await db.rollback()

    asyncio.run(scenario())


def test_structure_and_knowledge_memories_have_distinct_boundaries(client: TestClient):
    async def scenario():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            project = Project(
                learner_id=learner_id,
                name="五核边界测试",
                description="验证结构位置与知识理解不会混写",
                user_level="beginner",
            )
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            foundation = Checkpoint(
                roadmap_id=roadmap.id, title="张量形状", order=1,
                prerequisites=[], learning_status="in_progress",
            )
            db.add(foundation)
            await db.flush()
            attention = Checkpoint(
                roadmap_id=roadmap.id, title="因果自注意力", order=2,
                prerequisites=[foundation.id], learning_status="in_progress",
            )
            db.add(attention)
            await db.flush()

            await record_event(
                db, learner_id=learner_id, event_type="checkpoint_entered",
                source="test", project_id=project.id, checkpoint_id=foundation.id,
                payload={"title": foundation.title},
            )
            await record_event(
                db, learner_id=learner_id, event_type="checkpoint_entered",
                source="test", project_id=project.id, checkpoint_id=attention.id,
                payload={"title": attention.title},
            )
            await record_event(
                db, learner_id=learner_id, event_type="user_message",
                source="test", project_id=project.id, checkpoint_id=attention.id,
                payload={"text": "我为什么看不懂 Q、K、V 的张量形状？"},
            )
            await record_event(
                db, learner_id=learner_id, event_type="user_message",
                source="test", project_id=project.id,
                payload={"text": "我的目标是亲手实现一个 MiniGPT"},
            )
            semantic_event = await record_event(
                db, learner_id=learner_id, event_type="learning_feedback",
                source="test", project_id=project.id,
                payload={"value": "semantic-boundary"},
            )
            await apply_semantic_observations(db, semantic_event, [
                {
                    "kernel": "structure",
                    "short_term": {
                        "deferred_threads": ["完成张量热身后回到注意力"],
                        "concept_understanding": {"qkv": "错误维度"},
                    },
                    "reason": "结构只保留返回线索",
                },
                {
                    "kernel": "knowledge",
                    "short_term": {
                        "misconceptions": {"qkv": "把 Q、K、V 当成三个独立输入"},
                        "path_position": {"checkpoint_id": attention.id},
                    },
                    "reason": "知识只保留具体误解",
                },
            ])

            projection = await get_kernel_projection(db, learner_id)
            structure = projection["structure"]["short_term"]
            knowledge = projection["knowledge"]["short_term"]
            value = projection["value"]["short_term"]

            assert structure["path_position"]["checkpoint_title"] == "因果自注意力"
            assert structure["path_dependencies"][0]["title"] == "张量形状"
            assert structure["resume_anchor"]["checkpoint_id"] == attention.id
            assert structure["focus_transition"]["from_checkpoint_id"] == foundation.id
            assert "deferred_threads" not in structure
            assert "semantic_candidate" not in structure
            from app.models.learning import KernelState
            raw_states = {row.kernel_name: row.short_term for row in (await db.execute(
                select(KernelState).where(KernelState.learner_id == learner_id)
            )).scalars()}
            assert raw_states["structure"]["semantic_candidate"]["fields"]["deferred_threads"] == ["完成张量热身后回到注意力"]
            assert raw_states["structure"]["semantic_candidate"]["verification"] == "inferred"
            assert "concept_understanding" not in structure

            assert knowledge["knowledge_gap"].startswith("我为什么看不懂")
            assert "current_misconception" not in knowledge
            assert "misconceptions" not in knowledge
            assert "semantic_candidate" not in knowledge
            assert raw_states["knowledge"]["semantic_candidate"]["fields"]["misconceptions"]["qkv"] == "把 Q、K、V 当成三个独立输入"
            assert "path_position" not in knowledge
            assert value["current_priority"] == "我的目标是亲手实现一个 MiniGPT"
            assert "current_goal" not in structure
            await db.rollback()

    asyncio.run(scenario())


def test_profile_projects_legacy_goal_to_value_and_marks_self_report(client: TestClient):
    async def scenario():
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            structure = (await db.execute(select(KernelState).where(
                KernelState.learner_id == learner_id,
                KernelState.kernel_name == "structure",
            ))).scalar_one()
            short = dict(structure.short_term or {})
            short["current_goal"] = "历史版本误写的目标"
            structure.short_term = short
            await record_event(
                db, learner_id=learner_id,
                event_type="registration_profile_completed", source="test",
                payload={
                    "background": "只学过 Python",
                    "weekly_hours": 5,
                    "preferred_modes": ["practice"],
                    "focus_areas": ["AI"],
                },
            )

            dimensions = await memory_projection(db, learner_id)
            structure_memories = next(
                item["memories"] for item in dimensions if item["kernel"] == "structure"
            )
            value_memories = next(
                item["memories"] for item in dimensions if item["kernel"] == "value"
            )
            knowledge_memories = next(
                item["memories"] for item in dimensions if item["kernel"] == "knowledge"
            )

            assert not any(item["key"] == "current_goal" for item in structure_memories)
            assert next(item for item in value_memories if item["key"] == "current_goal")["summary"] == "历史版本误写的目标"
            background = next(item for item in knowledge_memories if item["key"] == "declared_background")
            assert background["verification_status"] == "self_reported"
            assert "尚未通过答题或实践验证" in background["summary"]
            await db.rollback()

    asyncio.run(scenario())


def test_five_kernel_migration_is_idempotent(client: TestClient):
    async def scenario():
        await init_db()
        await init_db()
        async with async_session() as db:
            learner_id = await legacy_learner_id()
            kernel_count = len((await db.execute(select(KernelState).where(
                KernelState.learner_id == learner_id,
            ))).scalars().all())
            migration_count = len((await db.execute(
                select(SchemaMigration).where(
                    SchemaMigration.version.in_([
                        "v2-five-kernel-tutor", "v3-evolving-project-proposals",
                        "v4-user-isolation-profile-badges",
                    ])
                )
            )).scalars().all())
            return kernel_count, migration_count

    assert asyncio.run(scenario()) == (5, 3)
