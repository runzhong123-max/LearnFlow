import asyncio
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import (
    AgentSession, EvidenceEvent, KernelMutation, KernelState, Learner, LearningAttempt,
    MemoryFact, MemoryNode, RemediationCase, ReviewSchedule,
)
from app.models.project import Checkpoint, Project, Roadmap, Source
from app.services.learning_runtime import record_event
from app.services.personal_concept_graph import extract_self_report
from app.services.personal_concept_graph import concept_client_event_id


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield test_client


def eid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def _contains_answer_material(value):
    if isinstance(value, dict):
        if any(key in value for key in {"submission", "solution", "answer_indexes", "test_cases"}):
            return True
        return any(_contains_answer_material(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_answer_material(item) for item in value)
    return False


def test_profile_background_extraction_is_conservative_and_canonical():
    observations, relations = extract_self_report(
        "学习过CS61A python, 学习过机器学习算法、深度学习基础。"
        "微积分、线性代数、离散数学、概率论、数据结构。"
    )
    keys = {item["concept_key"] for item in observations}
    assert {"python-programming", "machine-learning", "deep-learning"} <= keys
    assert all(not item["name"].startswith(("学习过", "学过")) for item in observations)
    assert relations == []


def test_concept_event_ids_stay_within_gateway_limit():
    event_id = concept_client_event_id("x" * 140, "knowledge", 1, "y" * 140)
    assert len(event_id) <= 145


def test_vnext_operational_event_is_idempotent_and_zero_target(client: TestClient):
    client_event_id = eid("vnext-step")
    payload = {
        "event_type": "vnext_learning_skill_step_entered",
        "client_event_id": client_event_id,
        "payload": {"task_id": "local-1", "step_id": "anchor"},
    }
    first = client.post("/api/learner-state/events", json=payload)
    second = client.post("/api/learner-state/events", json=payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["event_id"] == second.json()["event_id"]


def test_learning_path_self_report_updates_structure_without_mastery(client: TestClient):
    response = client.post("/api/learner-state/learning-path/status", json={
        "node_id": "machine-learning",
        "node_title": "机器学习",
        "status": "self_reported_mastered",
        "client_event_id": eid("path-status"),
    })
    assert response.status_code == 200, response.text
    snapshot = client.get("/api/learner-state/snapshot")
    assert snapshot.status_code == 200, snapshot.text
    data = snapshot.json()
    assert data["learning_path"]["statuses"]["machine-learning"]["status"] == "self_reported_mastered"
    knowledge = data["kernels"]["knowledge"]
    declared = knowledge["short_term"]["declared_course_exposure"]["machine-learning"]
    assert declared["self_reported_only"] is True
    assert declared["mastery_unchanged"] is True
    assert "machine-learning" not in knowledge["long_term"].get("mastery", {})


def test_personal_path_node_and_value_claim_use_formal_reducer(client: TestClient):
    node_id = f"personal-{uuid.uuid4().hex[:10]}"
    added = client.post("/api/learner-state/learning-path/personal-nodes", json={
        "node": {
            "id": node_id,
            "title": "Agent 评测工程",
            "summary": "构建可重复的 Agent 评测与轨迹分析流程。",
            "aliases": ["agent eval"],
            "domains": ["AI", "工程"],
            "stage": "advanced",
            "order": 6,
            "sourceRefs": ["https://example.com/agent-eval"],
        },
        "edges": [{
            "id": f"edge-{node_id}", "from": "agent-engineering", "to": node_id,
            "kind": "soft_prerequisite", "rationale": "先有 Agent 工程基础", "origin": "personal",
        }],
        "reason": "学习者明确希望补充这一方向",
        "client_event_id": eid("personal-node"),
    })
    assert added.status_code == 200, added.text
    assert any(item["id"] == node_id for item in added.json()["learning_path"]["personal_nodes"])

    proposal_id = f"goal-{uuid.uuid4().hex[:10]}"
    confirmed = client.post("/api/learner-state/value-claims/confirm", json={
        "proposal_id": proposal_id,
        "current_claim": "探索 Agent 与机器学习科研",
        "proposed_claim": "未来一年优先探索 Agent 评测工程，并保留机器学习科研分支。",
        "evidence_quote": "我想先做 Agent 评测工程项目，再决定是否偏科研。",
        "scope": "long_term_direction_candidate",
        "client_event_id": eid("value-claim"),
    })
    assert confirmed.status_code == 200, confirmed.text
    snapshot = client.get("/api/learner-state/snapshot").json()
    goal = snapshot["kernels"]["value"]["long_term"]["confirmed_goals"][proposal_id]
    assert goal["status"] == "confirmed"
    assert goal["evidence_quote"].startswith("我想先做")

    removed = client.delete(
        f"/api/learner-state/learning-path/personal-nodes/{node_id}",
        params={"client_event_id": eid("remove-node"), "node_title": "Agent 评测工程"},
    )
    assert removed.status_code == 200, removed.text
    assert all(item["id"] != node_id for item in removed.json()["learning_path"]["personal_nodes"])


def test_context_packet_is_answer_free_and_authoritative(client: TestClient):
    response = client.get("/api/learner-state/context", params={"query": "规划 Agent 评测工程"})
    assert response.status_code == 200, response.text
    packet = response.json()
    assert packet["manifest"]["answer_free"] is True
    assert packet["manifest"]["authority"] == "read_only_projection_from_evidence_and_memory_graph"


def test_agent_workspace_context_exposes_scoped_practice_review_and_source_domains(client: TestClient):
    async def seed():
        async with async_session() as db:
            learner_id = (await db.execute(select(Learner.id).where(
                Learner.key == "local-default",
            ))).scalar_one()
            suffix = uuid.uuid4().hex[:8]
            project = Project(learner_id=learner_id, name=f"agent-observation-{suffix}")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="Agent Tool Calling",
                order=1,
                learning_status="in_progress",
            )
            db.add(checkpoint)
            await db.flush()
            source = Source(
                project_id=project.id,
                type="github",
                role="main",
                status="processed",
                meta_data={"repo_analysis": {
                    "structure_logic": "tutorial-progression",
                    "readme_toc": [{"title": "工具定义与失败恢复"}],
                }},
            )
            db.add(source)
            attempt = LearningAttempt(
                learner_id=learner_id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                item_type="exercise",
                item_id=900_000 + int(suffix[:4], 16),
                status="evaluated",
                submission={"hidden": "must not leave backend"},
                result={"passed": 1, "total": 2, "feedback": "private grader detail"},
                assistance_level="hint",
                attempt_role="original",
                evaluated_at=datetime.utcnow(),
            )
            db.add(attempt)
            await db.flush()
            remediation = RemediationCase(
                learner_id=learner_id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                source_attempt_id=attempt.id,
                item_type="exercise",
                item_id=attempt.item_id,
                status="explaining",
                error_fingerprint=f"workspace-{suffix}",
                error_class="boundary_update",
                misconception_tag="tool_result_handling",
                current_delivery_mode="contrast",
                ineffective_modes=["definition_only"],
            )
            db.add(remediation)
            review = ReviewSchedule(
                learner_id=learner_id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                item_type="exercise",
                item_id=attempt.item_id,
                subject_key="agent.tool-calling",
                phase="active",
                due_at=datetime.utcnow() - timedelta(days=1),
                lapse_count=1,
                last_grade="failed",
                last_attempt_id=attempt.id,
            )
            db.add(review)
            await db.commit()
            return project.id, checkpoint.id

    project_id, checkpoint_id = asyncio.run(seed())
    response = client.get("/api/learner-state/agent-workspace-context", params={
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
    })
    assert response.status_code == 200, response.text
    packet = response.json()
    assert packet["manifest"]["answer_free"] is True
    assert packet["manifest"]["read_only"] is True
    assert packet["scope"]["project_id"] == project_id
    assert packet["recent_attempts"][0]["outcome"] == "failed"
    assert packet["recent_attempts"][0]["independent"] is False
    assert packet["open_remediations"][0]["misconception_tag"] == "tool_result_handling"
    assert packet["review"]["summary"]["due"] >= 1
    assert packet["knowledge_domains"][0]["title"] == "工具定义与失败恢复"
    assert packet["knowledge_domains"][0]["source_ids"]
    assert not _contains_answer_material(packet)

    missing = client.get("/api/learner-state/agent-workspace-context", params={"project_id": 999_999_999})
    assert missing.status_code == 404


def test_personal_concept_graph_separates_knowledge_history_and_structure_edges(client: TestClient):
    request_id = eid("concept-statement")
    payload = {
        "raw_text": "我学过概率论，但条件概率总是搞混。链式法则会帮助我理解反向传播。",
        "source_tag": "user_self_input",
        "client_event_id": request_id,
        "concepts": [
            {
                "concept_key": "conditional-probability",
                "name": "条件概率",
                "observation_type": "self_reported_gap",
                "statement": "学习者自述条件概率容易混淆",
            },
            {
                "concept_key": "probability-statistics",
                "name": "概率论与数理统计",
                "observation_type": "self_reported_exposure",
                "statement": "学习者自述学过概率论",
            },
        ],
        "relations": [{
            "source": {"concept_key": "chain-rule", "name": "链式法则"},
            "target": {"concept_key": "backpropagation", "name": "反向传播"},
            "relation_type": "enables",
            "rationale": "学习者明确表示链式法则帮助理解反向传播",
        }],
    }
    first = client.post("/api/learner-state/concept-graph/statements", json=payload)
    second = client.post("/api/learner-state/concept-graph/statements", json=payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["statement_event_id"] == second.json()["statement_event_id"]

    graph_response = client.get("/api/learner-state/concept-graph")
    assert graph_response.status_code == 200, graph_response.text
    graph = graph_response.json()
    node_map = {item["concept_key"]: item for item in graph["nodes"]}
    conditional = node_map["conditional-probability"]
    assert conditional["knowledge"]["latest_observation"]["verification"] == "unverified"
    assert conditional["knowledge"]["latest_observation"]["mastery_inference"] is False
    assert conditional["knowledge"]["mastery_claim"] is None
    edge = next(item for item in graph["edges"] if item["relation_type"] == "enables")
    assert edge["source_key"] == "chain-rule"
    assert edge["target_key"] == "backpropagation"
    assert edge["mastery_inference"] is False
    assert graph["manifest"]["knowledge_owns_node_history"] is True
    assert graph["manifest"]["structure_owns_relations"] is True

    snapshot = client.get("/api/learner-state/snapshot").json()
    assert snapshot["concept_graph"]["manifest"]["shared_identity_only"] is True
    context = client.get("/api/learner-state/context", params={"query": "反向传播"}).json()
    assert "personal_concept_graph" in context
    assert context["personal_concept_graph"]["manifest"]["self_report_never_implies_mastery"] is True
    assert context["manifest"]["personal_concept_graph"].startswith("read-only Knowledge")
    assert context["manifest"]["token_estimate"] <= context["manifest"]["policy"]["token_budget"]


def test_personal_path_gateway_rejects_invalid_edges_and_cycles(client: TestClient):
    invalid_id = f"invalid-{uuid.uuid4().hex[:8]}"
    invalid = client.post("/api/learner-state/learning-path/personal-nodes", json={
        "node": {"id": invalid_id, "title": "非法关系节点"},
        "edges": [{
            "from": "machine-learning", "to": "deep-learning",
            "kind": "soft_prerequisite",
        }],
        "client_event_id": eid("invalid-edge"),
    })
    assert invalid.status_code == 422

    suffix = uuid.uuid4().hex[:8]
    first_id, second_id, third_id = (f"dag-{suffix}-{index}" for index in range(3))

    def add_node(node_id: str, edges: list[dict]):
        return client.post("/api/learner-state/learning-path/personal-nodes", json={
            "node": {"id": node_id, "title": node_id},
            "edges": edges,
            "client_event_id": eid("dag-node"),
        })

    first = add_node(first_id, [{
        "from": "machine-learning", "to": first_id, "kind": "soft_prerequisite",
    }])
    assert first.status_code == 200, first.text
    second = add_node(second_id, [{
        "from": first_id, "to": second_id, "kind": "soft_prerequisite",
    }])
    assert second.status_code == 200, second.text
    cycle = add_node(third_id, [
        {"from": second_id, "to": third_id, "kind": "soft_prerequisite"},
        {"from": third_id, "to": first_id, "kind": "soft_prerequisite"},
    ])
    assert cycle.status_code == 422
    assert "形成环" in cycle.json()["detail"]


def test_confirmed_long_term_path_enters_structure_value_and_planning_context(client: TestClient):
    plan_id = f"plan-{uuid.uuid4().hex[:10]}"
    plan = {
        "plan_id": plan_id,
        "title": "通向 Agent 工程的长期路径",
        "objective": "用半年系统学习 Agent 工程，并完成一个可评测的项目",
        "horizon": "6 个月",
        "target_node_ids": ["agent-engineering"],
        "route_node_ids": ["python-programming", "machine-learning", "agent-engineering"],
        "milestone_node_ids": ["python-programming", "machine-learning", "agent-engineering"],
        "rationale": "从编程与机器学习基础进入 Agent 工程；自报状态只调整验证顺序。",
        "evidence_quote": "我想用半年系统学习 Agent 工程",
        "client_event_id": eid("path-plan"),
    }
    committed = client.post("/api/learner-state/learning-path/plans", json=plan)
    assert committed.status_code == 200, committed.text
    overlay = committed.json()["learning_path"]
    assert overlay["active_plan_id"] == plan_id
    assert overlay["plans"][0]["target_node_ids"] == ["agent-engineering"]

    replay = client.post("/api/learner-state/learning-path/plans", json=plan)
    assert replay.status_code == 200, replay.text
    assert replay.json()["event_id"] == committed.json()["event_id"]
    assert replay.json()["learning_path"]["plans"][0]["revision"] == 1

    snapshot = client.get("/api/learner-state/snapshot").json()
    structure = snapshot["kernels"]["structure"]
    value = snapshot["kernels"]["value"]
    assert structure["short_term"]["active_learning_path_plan"]["id"] == plan_id
    assert structure["long_term"]["learning_path_plans"][plan_id]["status"] == "active"
    assert value["long_term"]["confirmed_goals"][f"path-plan:{plan_id}"]["status"] == "confirmed"

    packet = client.get("/api/learner-state/context", params={
        "query": "接下来怎样推进 Agent 工程长期学习",
        "purpose": "learning_plan",
    })
    assert packet.status_code == 200, packet.text
    packet_text = str(packet.json())
    assert plan_id in packet_text
    assert "Agent 工程" in packet_text
    assert packet.json()["manifest"]["policy"]["id"] == "learning_plan"

    archived = client.delete(
        f"/api/learner-state/learning-path/plans/{plan_id}",
        params={"client_event_id": eid("path-plan-archive")},
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["learning_path"]["active_plan_id"] is None
    archived_snapshot = client.get("/api/learner-state/snapshot").json()
    assert archived_snapshot["kernels"]["structure"]["long_term"]["learning_path_plans"][plan_id]["status"] == "archived"
    assert archived_snapshot["kernels"]["value"]["long_term"]["confirmed_goals"][f"path-plan:{plan_id}"]["status"] == "archived"


def test_explicit_profile_edit_routes_human_and_value_through_reducer(client: TestClient):
    updated = client.patch("/api/profile", json={
        "weekly_hours": 11,
        "preferred_modes": ["可视化", "定义后直接举例", "代码"],
        "focus_areas": ["机器学习", "Agent", "强化学习"],
        "career_goal": "优先探索 Agent 工程，同时保留机器学习科研方向",
        "career_goal_status": "confirmed",
    })
    assert updated.status_code == 200, updated.text
    snapshot = client.get("/api/learner-state/snapshot").json()
    human = snapshot["kernels"]["human"]
    value = snapshot["kernels"]["value"]
    assert human["long_term"]["learning_preferences"]["weekly_hours"] == 11
    assert human["long_term"]["learning_preferences"]["preferred_modes"] == ["可视化", "定义后直接举例", "代码"]
    assert value["long_term"]["focus_areas"] == ["机器学习", "Agent", "强化学习"]
    assert value["long_term"]["career_goal"].startswith("优先探索 Agent 工程")


def test_planning_profile_self_report_is_scoped_and_never_upgrades_mastery(client: TestClient):
    client_event_id = eid("planning-profile")
    response = client.post("/api/learner-state/events", json={
        "event_type": "vnext_planning_profile_self_reported",
        "client_event_id": client_event_id,
        "payload": {
            "planning_goal": "成为大模型应用工程师",
            "self_report": {
                "version": "planning-profile-self-report.v1",
                "evidence_quote": "我是大二学生，每周投入15到20小时；学过机器学习，用过PyTorch，写过简单Flask接口。",
                "education_stage": "大二",
                "weekly_hours": {"min": 15, "max": 20},
                "current_load": "manageable",
                "knowledge_exposures": [{"subject": "机器学习", "statement": "学过机器学习基础"}],
                "knowledge_gaps": [{"subject": "生产级软件工程", "statement": "没写过生产级代码"}],
                "practice_exposures": [{"subject": "Flask 接口", "statement": "写过简单 Flask 接口"}],
                "goal_candidate": "成为大模型应用工程师",
            },
        },
    })
    assert response.status_code == 200, response.text
    snapshot = client.get("/api/learner-state/snapshot").json()
    kernels = snapshot["kernels"]
    assert kernels["structure"]["short_term"]["current_task"] == "规划：成为大模型应用工程师"
    assert kernels["structure"]["short_term"]["planning_position"]["education_stage"] == "大二"
    background = kernels["knowledge"]["short_term"]["declared_planning_background"]
    assert background["self_report_only"] is True
    assert background["mastery_unchanged"] is True
    assert kernels["human"]["short_term"]["planning_availability"]["weekly_hours"] == {"min": 15, "max": 20}
    assert kernels["value"]["short_term"]["goal_candidate"] == "成为大模型应用工程师"
    assert kernels["value"]["short_term"]["goal_status"] == "exploring"
    practice = kernels["practice"]["short_term"]["self_reported_experience"]
    assert practice["verified"] is False
    assert practice["attempt_evidence"] is False

    async def inspect_evidence():
        async with async_session() as db:
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.client_event_id.endswith(client_event_id),
            ))).scalar_one()
            facts = (await db.execute(
                select(MemoryFact).where(MemoryFact.source_event_id == event.id)
            )).scalars().all()
            human_nodes = (await db.execute(
                select(MemoryNode)
                .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
                .where(
                    MemoryFact.source_event_id == event.id,
                    MemoryNode.kernel_name == "human",
                )
            )).scalars().all()
            return event, facts, human_nodes

    event, facts, human_nodes = asyncio.run(inspect_evidence())
    assert event.actor_type == "learner"
    assert event.provenance["self_report"] is True
    assert {fact.evidence_grade for fact in facts} == {"self_reported"}
    planning_fact = next(
        fact for fact in facts if fact.predicate == "short_term.planning_availability"
    )
    assert planning_fact.consumption_status == "excluded"
    assert next(node for node in human_nodes if node.id == planning_fact.node_id).status == "transient"


def test_explicit_human_adaptation_is_scoped_transient_and_answer_free(client: TestClient):
    async def seed_scope():
        async with async_session() as db:
            learner_id = (await db.execute(select(Learner.id).where(
                Learner.key == "local-default",
            ))).scalar_one()
            suffix = uuid.uuid4().hex[:8]
            project = Project(learner_id=learner_id, name=f"human-scope-{suffix}")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="显式节奏适配", order=1)
            db.add(checkpoint)
            await db.flush()
            session = AgentSession(
                learner_id=learner_id,
                session_type="checkpoint",
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                title="人因核测试",
            )
            db.add(session)
            await db.commit()
            return learner_id, project.id, checkpoint.id, session.id

    learner_id, project_id, checkpoint_id, session_id = asyncio.run(seed_scope())
    quote = "这里讲得太快了，请慢一点"
    client_event_id = eid("human-adaptation")
    response = client.post("/api/learner-state/events", json={
        "event_type": "vnext_human_adaptation_requested",
        "client_event_id": client_event_id,
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
        "payload": {
            "signal_kind": "pace_adjustment",
            "value": "slower",
            "strength": 0.9,
            "explicit": True,
            "evidence_quote": quote,
        },
    })
    assert response.status_code == 200, response.text

    snapshot = client.get("/api/learner-state/snapshot").json()
    human = snapshot["kernels"]["human"]["short_term"]
    assert human["pace_adjustment"] == "slower"
    assert human["support_need"] == "reduce_pacing"
    assert human["transient_expires_at"]

    packet_response = client.get("/api/learner-state/context", params={
        "query": "继续当前学习",
        "purpose": "checkpoint_tutor",
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
    })
    assert packet_response.status_code == 200, packet_response.text
    packet = packet_response.json()
    instructions = [item["instruction"] for item in packet["adaptation_directives"]]
    assert any("放慢节奏" in item for item in instructions)
    assert quote not in str(packet)
    assert all(item["kernel"] != "human" for item in packet["items"])

    async def inspect_event_chain():
        async with async_session() as db:
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.learner_id == learner_id,
                EvidenceEvent.client_event_id == f"{learner_id}:{client_event_id}",
            ))).scalar_one()
            assert (event.project_id, event.checkpoint_id, event.session_id) == (
                project_id, checkpoint_id, session_id,
            )
            assert event.provenance["self_report"] is True
            mutations = (await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
                KernelMutation.kernel_name == "human",
            ))).scalars().all()
            assert len(mutations) == 2
            guidance_mutation = next(item for item in mutations if 'teaching_directives' in item.patch['short_term'])
            assert guidance_mutation.patch['short_term']['teaching_directives'][0]['source_event_id'] == event.id
            mutation = next(item for item in mutations if 'transient_expires_at' in item.patch['short_term'])
            assert "transient_expires_at" in mutation.patch["short_term"]
            fact_rows = list((await db.execute(
                select(MemoryFact, MemoryNode)
                .join(MemoryNode, MemoryNode.id == MemoryFact.node_id)
                .where(MemoryFact.source_mutation_id == mutation.id)
            )).all())
            assert fact_rows
            assert all(fact.predicate not in {"transient_expires_at", "adaptation_source"} for fact, _ in fact_rows)
            assert all(node.valid_to is not None for _, node in fact_rows)

    asyncio.run(inspect_event_chain())

    async def expire_current_adaptation():
        async with async_session() as db:
            state = (await db.execute(select(KernelState).where(
                KernelState.learner_id == learner_id,
                KernelState.kernel_name == "human",
            ))).scalar_one()
            short_term = dict(state.short_term or {})
            short_term["transient_expires_at"] = (datetime.utcnow() - timedelta(seconds=1)).isoformat()
            state.short_term = short_term
            await db.commit()

    asyncio.run(expire_current_adaptation())
    expired_packet = client.get("/api/learner-state/context", params={
        "query": "继续当前学习",
        "purpose": "checkpoint_tutor",
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
    })
    assert expired_packet.status_code == 200, expired_packet.text
    assert all(
        "放慢节奏" not in item["instruction"]
        for item in expired_packet.json()["adaptation_directives"]
    )

    mismatch = client.post("/api/learner-state/events", json={
        "event_type": "vnext_human_adaptation_requested",
        "client_event_id": eid("human-scope-mismatch"),
        "project_id": project_id + 100000,
        "checkpoint_id": checkpoint_id,
        "payload": {
            "signal_kind": "format_request", "value": "visual", "explicit": True,
        },
    })
    assert mismatch.status_code == 400


def test_ordinary_uncertainty_does_not_infer_human_state():
    async def inspect():
        async with async_session() as db:
            learner_id = (await db.execute(select(Learner.id).where(
                Learner.key == "local-default",
            ))).scalar_one()
            event = await record_event(
                db,
                learner_id=learner_id,
                event_type="user_message",
                source="test",
                payload={"text": "我不会这道题，也不懂反向传播"},
                client_event_id=eid("uncertainty-not-human"),
            )
            await db.commit()
            human_mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
                KernelMutation.kernel_name == "human",
            ))).scalars().all())
            assert human_mutations == []

    asyncio.run(inspect())
