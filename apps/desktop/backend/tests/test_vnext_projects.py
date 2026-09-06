import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, LearningTask
from app.models.project import Checkpoint, Project, Roadmap, Source, SourceVersion


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield test_client


def _create(client: TestClient) -> dict:
    name = f"RAG Agent 学徒项目 {uuid.uuid4().hex[:6]}"
    response = client.post("/api/vnext-projects", json={
        "name": name,
        "objective": "理解检索、上下文组装与评测，并实现一个可运行的 RAG Agent",
        "expected_outcome": "一个带离线评测的可运行仓库",
        "user_level": "intermediate",
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_project_creation_is_topic_locked_and_does_not_invent_checkpoints(client: TestClient):
    workspace = _create(client)
    assert workspace["schema_version"] == "vnext.project.v1"
    assert workspace["project_tutor"]["mode"] == "learning_plan"
    assert workspace["roadmap"]["checkpoints"] == []
    assert workspace["boundaries"]["planning_requires_confirmation"] is True
    assert workspace["boundaries"]["file_generation_is_not_mastery"] is True

    tutor_context = client.get(
        f"/api/vnext-projects/{workspace['project']['id']}/agent-context",
        params={"session_id": workspace["project_tutor"]["session_id"], "query": "规划路线"},
    )
    assert tutor_context.status_code == 200, tutor_context.text
    assert tutor_context.json()["roadmap"]["checkpoints"] == []
    assert tutor_context.json()["roadmap"]["revision"] == 0
    assert tutor_context.json()["tool_policy"]["roadmap_tool_access"] == "project_tutor"

    mismatch = client.post(f"/api/vnext-projects/{workspace['project']['id']}/roadmap/apply", json={
        "project_theme": "无关的操作系统课程",
        "rationale": "错误主题",
        "checkpoints": [{
            "key": "start", "title": "开始", "objective": "开始",
            "success_criteria": ["完成"], "prerequisites": [], "estimated_minutes": 30,
        }],
        "client_action_id": f"mismatch-{uuid.uuid4().hex}",
    })
    assert mismatch.status_code == 422


def test_project_source_baseline_requires_coverage_confirmation_and_invalidates_on_quarantine(
    client: TestClient, tmp_path, monkeypatch,
):
    from app.core.config import settings

    monkeypatch.setattr(settings, "source_uploads_dir", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "source_cache_dir", str(tmp_path / "cache"))
    workspace = _create(client)
    project_id = workspace["project"]["id"]
    content = """# RAG Agent 项目范围

## 前置与机制
因为检索结果会进入模型上下文，必须先理解切分、召回和引用闭包之间的依赖。

## 实现步骤
先加载并切分文档，再建立检索索引，然后把带定位的证据交给回答器。

## 例子
例如用三个小文档验证检索命中，再检查回答的每个声明是否指向实际片段。

## 风险与误区
搜索摘要不能作为关键声明的唯一证据，也不能把检索命中直接当作回答正确。
"""
    uploaded = client.post(f"/api/projects/{project_id}/sources/upload", files={
        "file": ("rag-baseline.md", content.encode(), "text/markdown"),
    })
    assert uploaded.status_code == 200, uploaded.text
    source_id = uploaded.json()["id"]
    processed = client.post(f"/api/projects/{project_id}/sources/{source_id}/process")
    assert processed.status_code == 200, processed.text

    async def mark_official() -> None:
        async with async_session() as db:
            source = await db.get(Source, source_id)
            version = await db.get(
                SourceVersion,
                int(dict(source.meta_data or {})["active_source_version_id"]),
            )
            version.authority_tier = "official"
            version.source_role = "canonical"
            await db.commit()

    asyncio.run(mark_official())
    proposed = client.post(f"/api/vnext-projects/{project_id}/knowledge-baseline/proposals", json={
        "source_ids": [source_id], "query": f"{workspace['project']['name']} RAG Agent 实现",
    })
    assert proposed.status_code == 200, proposed.text
    proposal = proposed.json()["proposal"]
    assert proposal["status"] == "draft"
    assert proposal["coverage"]["gate_status"] == "ready"
    assert client.get(f"/api/vnext-projects/{project_id}").json()["sources"][0]["selection_state"] == "recommended"
    confirmed = client.post(
        f"/api/vnext-projects/{project_id}/knowledge-baseline/{proposal['id']}/confirm"
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["baseline"]["status"] == "ready"
    assert client.get(f"/api/vnext-projects/{project_id}").json()["sources"][0]["selection_state"] == "pinned"

    quarantined = client.post(f"/api/vnext-projects/{project_id}/sources/{source_id}/health", json={
        "action": "quarantine", "reason": "学习者发现资料被污染",
    })
    assert quarantined.status_code == 200, quarantined.text
    baseline = client.get(f"/api/vnext-projects/{project_id}/knowledge-baseline")
    assert baseline.status_code == 200, baseline.text
    assert baseline.json()["baseline"]["status"] == "quarantined"
    assert baseline.json()["baseline"]["mastery_inference"] is False


def test_inspected_library_source_requires_explicit_project_promotion(client: TestClient):
    captured = client.post("/api/knowledge-library/web-evidence", json={
        "query": "RAG 引用闭包与覆盖审计",
        "url": f"https://example.org/rag-evidence-{uuid.uuid4().hex}",
        "title": "RAG evidence reference",
        "excerpt": (
            "A retrieval system should bind each generated claim to an inspected source locator. "
            "Coverage auditing identifies missing definitions, mechanisms, examples, and risks before publication."
        ),
    })
    assert captured.status_code == 200, captured.text
    evidence = captured.json()
    workspace = _create(client)
    project_id = workspace["project"]["id"]
    action_id = f"promote-{uuid.uuid4().hex}"
    payload = {
        "source_id": evidence["source_id"],
        "source_version_id": evidence["source_version_id"],
        "recommendation_reason": "Tutor 推荐把已核验的引用闭包资料加入这个 RAG 项目",
        "client_action_id": action_id,
    }
    promoted = client.post(
        f"/api/vnext-projects/{project_id}/knowledge-sources/promotions",
        json=payload,
    )
    assert promoted.status_code == 200, promoted.text
    body = promoted.json()
    assert body["selection_state"] == "confirmed"
    assert body["baseline_inclusion_required"] is True
    assert body["mastery_unchanged"] is True
    assert body["source"]["active_version"]["source_profile"]["selection_state"] == "confirmed"

    replay = client.post(
        f"/api/vnext-projects/{project_id}/knowledge-sources/promotions",
        json=payload,
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["source"]["id"] == body["source"]["id"]

    async def inspect_promotion() -> tuple[list[EvidenceEvent], list[KernelMutation]]:
        async with async_session() as db:
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.project_id == project_id,
                EvidenceEvent.event_type == "project_knowledge_source_promoted",
            ))).scalars().all())
            mutations = [] if not events else list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id.in_([event.id for event in events]),
            ))).scalars().all())
            return events, mutations

    events, mutations = asyncio.run(inspect_promotion())
    assert len(events) == 1
    assert mutations == []


def test_confirmed_roadmap_creates_checkpoint_sessions_and_formal_tasks(client: TestClient):
    workspace = _create(client)
    project = workspace["project"]
    response = client.post(f"/api/vnext-projects/{project['id']}/roadmap/apply", json={
        "project_theme": project["name"],
        "rationale": "先做最小检索闭环，再加入可重复的离线评测，始终服务目标仓库。",
        "checkpoints": [
            {
                "key": "retrieval-loop", "title": "最小检索闭环",
                "objective": "实现加载、切分、检索与回答的最小闭环",
                "prerequisites": [],
                "success_criteria": ["能够解释每个组件的输入输出", "仓库可以离线运行"],
                "estimated_minutes": 90,
            },
            {
                "key": "evaluation", "title": "离线评测与误差分析",
                "objective": "构建小型评测集并分析检索与回答错误",
                "prerequisites": ["retrieval-loop"],
                "success_criteria": ["评测可重复", "能区分检索错误与生成错误"],
                "estimated_minutes": 120,
            },
        ],
        "client_action_id": f"roadmap-{uuid.uuid4().hex}",
    })
    assert response.status_code == 200, response.text
    applied = response.json()
    checkpoints = applied["roadmap"]["checkpoints"]
    assert len(checkpoints) == 2
    assert checkpoints[1]["prerequisites"] == [checkpoints[0]["id"]]
    assert all(item["session_id"] for item in checkpoints)
    assert all(item["learning_task"]["origin_kind"] == "checkpoint" for item in checkpoints)
    assert all(item["learning_task"]["project_id"] == project["id"] for item in checkpoints)
    assert all(item["learning_contract"]["schema_version"] == "learnflow.teaching-contract.v2" for item in checkpoints)
    assert all(item["learning_contract"]["teaching_gate"]["status"] == "blocked_knowledge" for item in checkpoints)
    assert all(item["learning_contract"]["knowledge_input_contract"]["mode"] == "required_for_formal_publish" for item in checkpoints)
    assert all(item["learning_contract"]["delivery_readiness"]["overall"] == "outline_only" for item in checkpoints)
    assert all(item["learning_contract"]["delivery_readiness"]["package_readiness"]["overall"] == "outline_only" for item in checkpoints)
    assert all(item["learning_contract"]["delivery_readiness"]["task_readiness"]["overall"] == "runnable_with_fallback" for item in checkpoints)
    assert all(item["learning_contract"]["delivery_readiness"]["task_readiness"]["available_phases"] == ["learn"] for item in checkpoints)
    assert all(item["learning_contract"]["delivery_readiness"]["mastery_inference"] is False for item in checkpoints)

    context = client.get(
        f"/api/vnext-projects/{project['id']}/agent-context",
        params={"checkpoint_id": checkpoints[0]["id"], "query": "检索闭环"},
    )
    assert context.status_code == 200, context.text
    packet = context.json()
    assert packet["project"]["name"] == project["name"]
    assert packet["checkpoint_id"] == checkpoints[0]["id"]
    assert packet["tool_policy"]["roadmap_write_requires_user_confirmation"] is True
    assert packet["five_kernel_context"]["scope"]["project_id"] == project["id"]

    free = client.post(f"/api/vnext-projects/{project['id']}/sessions", json={
        "kind": "free", "title": "项目里的架构讨论",
        "client_action_id": f"free-{uuid.uuid4().hex}",
    })
    assert free.status_code == 200, free.text
    refreshed = client.get(f"/api/vnext-projects/{project['id']}").json()
    assert any(item["session_id"] == free.json()["session_id"] for item in refreshed["free_sessions"])
    free_context = client.get(
        f"/api/vnext-projects/{project['id']}/agent-context",
        params={"session_id": free.json()["session_id"], "query": "能否调整路线"},
    )
    assert free_context.status_code == 200, free_context.text
    assert free_context.json()["tool_policy"]["roadmap_tool_access"] == "none"
    resumed_tutor = client.post("/api/agent/sessions", json={
        "session_type": "project", "project_id": project["id"], "create_new": False,
    })
    assert resumed_tutor.status_code == 200, resumed_tutor.text
    assert resumed_tutor.json()["id"] == workspace["project_tutor"]["session_id"]
    assert resumed_tutor.json()["id"] != free.json()["session_id"]

    async def inspect():
        async with async_session() as db:
            roadmap = (await db.execute(select(Roadmap).where(Roadmap.project_id == project["id"]))).scalar_one()
            checkpoint_rows = list((await db.execute(select(Checkpoint).where(Checkpoint.roadmap_id == roadmap.id))).scalars())
            task_rows = list((await db.execute(select(LearningTask).where(LearningTask.project_id == project["id"]))).scalars())
            session_rows = list((await db.execute(select(AgentSession).where(AgentSession.project_id == project["id"]))).scalars())
            event_rows = list((await db.execute(select(EvidenceEvent).where(EvidenceEvent.project_id == project["id"]))).scalars())
            mutations = list((await db.execute(select(KernelMutation).join(
                EvidenceEvent, EvidenceEvent.id == KernelMutation.event_id,
            ).where(EvidenceEvent.project_id == project["id"]))).scalars())
            return checkpoint_rows, task_rows, session_rows, event_rows, mutations

    checkpoint_rows, task_rows, session_rows, event_rows, mutations = asyncio.run(inspect())
    assert len(checkpoint_rows) == 2
    assert len(task_rows) == 2
    assert any((item.context_summary or {}).get("role") == "project_tutor" for item in session_rows)
    assert any((item.context_summary or {}).get("role") == "project_free" for item in session_rows)
    assert {item.event_type for item in event_rows} >= {"project_created", "roadmap_applied", "project_free_conversation_created"}
    assert {item.kernel_name for item in mutations} <= {"structure", "value"}


def test_roadmap_requires_forward_only_prerequisites(client: TestClient):
    workspace = _create(client)
    project = workspace["project"]
    response = client.post(f"/api/vnext-projects/{project['id']}/roadmap/apply", json={
        "project_theme": project["name"], "rationale": "非法反向边",
        "checkpoints": [
            {"key": "a", "title": "关卡 A", "objective": "A 目标", "prerequisites": ["b"], "success_criteria": ["A"], "estimated_minutes": 20},
            {"key": "b", "title": "关卡 B", "objective": "B 目标", "prerequisites": [], "success_criteria": ["B"], "estimated_minutes": 20},
        ],
        "client_action_id": f"cycle-{uuid.uuid4().hex}",
    })
    assert response.status_code == 422
    assert "DAG" in response.text


def test_project_tutor_can_revise_only_unstarted_roadmap_suffix(client: TestClient):
    workspace = _create(client)
    project = workspace["project"]
    applied_response = client.post(f"/api/vnext-projects/{project['id']}/roadmap/apply", json={
        "project_theme": project["name"], "rationale": "三段初始路线",
        "checkpoints": [
            {"key": "foundation", "title": "检索基础", "objective": "完成最小检索链", "prerequisites": [], "success_criteria": ["检索可运行"], "estimated_minutes": 60},
            {"key": "generation", "title": "生成链", "objective": "接入生成模型", "prerequisites": ["foundation"], "success_criteria": ["回答可追踪"], "estimated_minutes": 70},
            {"key": "report", "title": "原始报告", "objective": "写初步报告", "prerequisites": ["generation"], "success_criteria": ["报告完成"], "estimated_minutes": 40},
        ],
        "client_action_id": f"roadmap-{uuid.uuid4().hex}",
    })
    assert applied_response.status_code == 200, applied_response.text
    applied = applied_response.json()
    first, second, removed = applied["roadmap"]["checkpoints"]

    async def start_first():
        async with async_session() as db:
            checkpoint = await db.get(Checkpoint, first["id"])
            checkpoint.learning_status = "in_progress"
            await db.commit()

    asyncio.run(start_first())
    revision_id = f"revision-{uuid.uuid4().hex}"
    revised_response = client.put(f"/api/vnext-projects/{project['id']}/roadmap", json={
        "project_theme": project["name"], "rationale": "保留已开始基础关，只调整后续评测路线",
        "expected_revision": 1, "client_action_id": revision_id,
        "checkpoints": [
            {"id": first["id"], "key": "foundation", "title": "检索基础", "objective": "完成最小检索链", "prerequisites": [], "success_criteria": ["检索可运行"], "estimated_minutes": 60},
            {"id": second["id"], "key": "generation", "title": "可观测生成链", "objective": "接入生成模型并记录引用", "prerequisites": ["foundation"], "success_criteria": ["引用可追踪"], "estimated_minutes": 90},
            {"key": "evaluation", "title": "离线评测", "objective": "区分检索与生成误差", "prerequisites": ["generation"], "success_criteria": ["评测可重复"], "estimated_minutes": 120},
        ],
    })
    assert revised_response.status_code == 200, revised_response.text
    revised = revised_response.json()
    assert revised["roadmap"]["revision"] == 2
    assert [item["title"] for item in revised["roadmap"]["checkpoints"]] == ["检索基础", "可观测生成链", "离线评测"]
    assert revised["roadmap"]["checkpoints"][0]["editable"] is False
    assert revised["roadmap"]["checkpoints"][1]["editable"] is True

    forbidden = client.put(f"/api/vnext-projects/{project['id']}/roadmap", json={
        "project_theme": project["name"], "rationale": "错误地修改已开始关卡",
        "expected_revision": 2, "client_action_id": f"forbidden-{uuid.uuid4().hex}",
        "checkpoints": [
            {"id": first["id"], "key": "foundation", "title": "检索基础", "objective": "偷偷改变目标", "prerequisites": [], "success_criteria": ["检索可运行"], "estimated_minutes": 60},
            *[{"id": item["id"], "key": item["key"], "title": item["title"], "objective": item["objective"], "prerequisites": ["foundation"] if index == 1 else ["generation"], "success_criteria": list(item["learning_contract"]["exit_criteria"]), "estimated_minutes": item["learning_contract"]["estimated_minutes"]} for index, item in enumerate(revised["roadmap"]["checkpoints"][1:], start=1)],
        ],
    })
    assert forbidden.status_code == 409

    async def inspect_revision():
        async with async_session() as db:
            removed_checkpoint = await db.get(Checkpoint, removed["id"])
            removed_task = (await db.execute(select(LearningTask).where(
                LearningTask.checkpoint_id == removed["id"],
            ))).scalar_one()
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.project_id == project["id"],
                EvidenceEvent.event_type == "roadmap_revised",
            ))).scalar_one()
            mutations = list((await db.execute(select(KernelMutation).where(
                KernelMutation.event_id == event.id,
            ))).scalars())
            return removed_checkpoint, removed_task, event, mutations

    removed_checkpoint, removed_task, event, mutations = asyncio.run(inspect_revision())
    assert removed_checkpoint.archived is True
    assert removed_task.status == "canceled"
    assert event.payload["revision"] == 2
    assert {item.kernel_name for item in mutations} == {"structure"}


def test_removing_an_entire_unstarted_roadmap_returns_a_safe_empty_graph(client: TestClient):
    workspace = _create(client)
    project = workspace["project"]
    applied = client.post(f"/api/vnext-projects/{project['id']}/roadmap/apply", json={
        "project_theme": project["name"], "rationale": "临时路线",
        "checkpoints": [{"key": "draft", "title": "临时关卡", "objective": "验证空图迁移", "prerequisites": [], "success_criteria": ["完成"], "estimated_minutes": 30}],
        "client_action_id": f"roadmap-{uuid.uuid4().hex}",
    })
    assert applied.status_code == 200, applied.text
    cleared = client.put(f"/api/vnext-projects/{project['id']}/roadmap", json={
        "project_theme": project["name"], "rationale": "重新规划前清空所有未开始关卡",
        "checkpoints": [], "expected_revision": 1,
        "client_action_id": f"revision-{uuid.uuid4().hex}",
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["roadmap"]["revision"] == 2
    assert cleared.json()["roadmap"]["checkpoints"] == []
    context = client.get(
        f"/api/vnext-projects/{project['id']}/agent-context",
        params={"session_id": workspace["project_tutor"]["session_id"], "query": "重新规划"},
    )
    assert context.status_code == 200, context.text
    assert context.json()["roadmap"]["checkpoints"] == []
    assert context.json()["tool_policy"]["roadmap_tool_access"] == "project_tutor"
