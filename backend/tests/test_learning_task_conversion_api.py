from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.api import learning_task_conversion
from app.main import app
from app.services.learning_task_conversion_xfyun import XfyunWorkflowError


class _FakeGateway:
    submitted_feedback = []
    submitted_upstream = []

    async def capabilities(self):
        return {
            "schema_version": "learning-task-conversion-capabilities-v1",
            "service": "learning-task-conversion",
        }

    async def task_bundle(self, task_card_id: str):
        return {
            "schema_version": "learning-task-conversion-integration-bundle-v1",
            "task_card_id": task_card_id,
            "verification_status": "verified",
            "task": {
                "schema_version": "learning-task-to-personalized-learning-v1",
                "work_task": {
                    "work_task_id": "task-unity-camera",
                    "enterprise_task_name": "Unity摄像机跟随模块开发",
                    "enterprise_task_description": "完成跟随、遮挡检测和验收。",
                    "teaching_task_name": "Unity摄像机跟随学习型工作任务",
                    "teaching_task_description": "在实训环境中完成模块并提交验收记录。",
                    "work_situation": "在Unity项目中为第三人称角色开发摄像机模块。",
                    "task_steps": [
                        {
                            "step": 1,
                            "step_id": "step_01",
                            "name": "配置摄像机跟随",
                            "action": "配置Cinemachine跟随对象与阻尼。",
                            "deliverable": "摄像机配置",
                            "check": "摄像机平滑跟随角色",
                            "knowledge_point_ids": ["kp_camera"],
                            "skill_point_ids": ["sp_camera"],
                        }
                    ],
                    "knowledge_points": [
                        {
                            "knowledge_id": "kp_camera",
                            "display_code": "K1",
                            "name": "Cinemachine跟随与阻尼参数",
                            "scope": "理解跟随对象、构图与阻尼的作用。",
                            "learning_resources": [],
                        }
                    ],
                    "skill_points": [
                        {
                            "skill_id": "sp_camera",
                            "display_code": "S1",
                            "name": "配置第三人称摄像机",
                            "observable_action": "能完成跟随参数配置并验证。",
                        }
                    ],
                },
            },
            "strong_relationships": [],
            "artifacts": {
                "interactive_html_url": f"https://example.test/tasks/{task_card_id}/interactive.html",
                "pdf_url": f"https://example.test/tasks/{task_card_id}/document.pdf",
                "personalized_learning_json_url": f"https://example.test/tasks/{task_card_id}/personalized-learning.json",
                "feedback_json_url": f"https://example.test/tasks/{task_card_id}/feedback.json",
            },
        }

    async def submit_upstream_handoff(self, payload):
        self.submitted_upstream.append(payload)
        return {"status": "accepted", "upstream_task_id": payload["upstream_task_id"]}

    async def personalized_learning_handoff(self, task_card_id: str):
        return {
            "schema_version": "learning-task-to-personalized-learning-v1",
            "task_card_id": task_card_id,
            "work_task": {"task_steps": [{"step_id": "step_01"}]},
        }

    async def submit_downstream_feedback(self, payload):
        self.submitted_feedback.append(payload)
        return {"status": "accepted", "task_card_id": payload["task_card_id"]}


class _FakeXfyunClient:
    def __init__(self):
        self.calls = []

    async def run(self, user_input: str, *, uid: str):
        self.calls.append({"user_input": user_input, "uid": uid})
        return {
            "schema_version": "learning-task-conversion-xfyun-run-v1",
            "provider": "xunfei-xingchen",
            "app_id": "app-test",
            "flow_id": "flow-test",
            "run_id": "run-test",
            "content": (
                "[打开任务网页](https://example.test/api/v1/learning-task-conversion/"
                "tasks/ltc_generated_01/interactive.html)"
            ),
            "usage": {},
        }


class _StageConflictThenSuccessClient(_FakeXfyunClient):
    async def run(self, user_input: str, *, uid: str):
        if not self.calls:
            self.calls.append({"user_input": user_input, "uid": uid})
            raise XfyunWorkflowError(
                "讯飞星辰工作流执行失败(21812): 当前阶段 INTAKE 不接受计划提交"
            )
        return await super().run(user_input, uid=uid)


class _StageConflictClient(_FakeXfyunClient):
    async def run(self, user_input: str, *, uid: str):
        self.calls.append({"user_input": user_input, "uid": uid})
        raise XfyunWorkflowError(
            "讯飞星辰工作流执行失败(21812): 当前阶段 INTAKE 不接受计划提交"
        )


class _WorkflowSelfLinkClient(_FakeXfyunClient):
    async def run(self, user_input: str, *, uid: str):
        self.calls.append({"user_input": user_input, "uid": uid})
        return {
            "run_id": "run-without-task",
            "content": (
                "岗位典型工作任务转化结果\n"
                "[打开交互式任务页]()\n"
                "[下载 PDF](https://agent.xfyun.cn/agentbuilder/work_flow/demo/arrange)"
            ),
            "usage": {},
        }


class _ClarificationWithInternalLinkClient(_FakeXfyunClient):
    async def run(self, user_input: str, *, uid: str):
        self.calls.append({"user_input": user_input, "uid": uid})
        return {
            "run_id": "run-clarification-with-internal-link",
            "content": (
                "请补充一个具体任务。"
                "[继续编排](https://agent.xfyun.cn/agentbuilder/work_flow/internal)"
                "[空入口]()"
            ),
            "usage": {},
        }


def _registration(username: str) -> dict:
    return {
        "username": username,
        "password": "learnflow-pass-123",
        "display_name": username,
        "education_stage": "undergraduate",
        "background": "计算机基础",
        "focus_areas": ["工程实践"],
        "weekly_hours": 5,
        "preferred_modes": ["practice"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


def test_learning_task_conversion_proxy_requires_login_and_keeps_task_id(monkeypatch):
    fake_xfyun = _FakeXfyunClient()
    monkeypatch.setattr(learning_task_conversion, "_gateway", lambda: _FakeGateway())
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        assert client.get("/api/learning-task-conversion/capabilities").status_code == 401
        username = f"conversion_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        capabilities = client.get("/api/learning-task-conversion/capabilities")
        assert capabilities.status_code == 200
        assert capabilities.json()["service"] == "learning-task-conversion"

        bundle = client.get(
            "/api/learning-task-conversion/tasks/ltc_contract_01/bundle"
        )
        assert bundle.status_code == 200
        assert bundle.json()["task_card_id"] == "ltc_contract_01"

        invalid = client.get(
            "/api/learning-task-conversion/tasks/not%20valid/bundle"
        )
        assert invalid.status_code == 422

        workflow_run = client.post(
            "/api/learning-task-conversion/workflow-runs",
            json={"user_input": "Windows 11系统重装与驱动配置"},
        )
        assert workflow_run.status_code == 200
        assert workflow_run.json()["provider"] == "xunfei-xingchen"
        assert fake_xfyun.calls[0]["user_input"] == "Windows 11系统重装与驱动配置"
        assert fake_xfyun.calls[0]["uid"].startswith("lf-")
        assert len(fake_xfyun.calls[0]["uid"]) <= 40

        generated = client.post(
            "/api/learning-task-conversion/generate",
            json={"query": "Windows 11系统重装与驱动配置"},
        )
        assert generated.status_code == 200
        assert generated.json()["schema_version"] == "learnflow-learning-task-generation-v2"
        assert generated.json()["task_card_id"] == "ltc_generated_01"
        assert generated.json()["bundle"]["task_card_id"] == "ltc_generated_01"
        assert fake_xfyun.calls[0]["uid"] != fake_xfyun.calls[1]["uid"]

        empty_run = client.post(
            "/api/learning-task-conversion/workflow-runs",
            json={"user_input": "  "},
        )
        assert empty_run.status_code == 422


def test_learning_task_generation_retries_one_stale_xingchen_stage(monkeypatch):
    fake_xfyun = _StageConflictThenSuccessClient()
    monkeypatch.setattr(learning_task_conversion, "_gateway", lambda: _FakeGateway())
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        username = f"conversion_retry_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        generated = client.post(
            "/api/learning-task-conversion/generate",
            json={"query": "Linux系统安装与基础配置"},
        )
        assert generated.status_code == 200
        assert generated.json()["task_card_id"] == "ltc_generated_01"
        assert len(fake_xfyun.calls) == 2


def test_learning_task_generation_persists_and_replays_session_turn(monkeypatch):
    fake_xfyun = _FakeXfyunClient()
    monkeypatch.setattr(learning_task_conversion, "_gateway", lambda: _FakeGateway())
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        username = f"conversion_session_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200
        session = client.post("/api/agent/sessions", json={"session_type": "global"}).json()
        payload = {
            "query": "Unity游戏客户端登录与场景加载模块开发",
            "session_id": session["id"],
            "client_turn_id": "conversion-turn-001",
        }

        first = client.post("/api/learning-task-conversion/generate", json=payload)
        second = client.post("/api/learning-task-conversion/generate", json=payload)

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["replayed"] is True
        assert len(fake_xfyun.calls) == 1
        assert "查看学习型任务" in first.json()["message"]
        assert "PDF" not in first.json()["message"]
        assert "JSON" not in first.json()["message"]
        loaded = client.get(f"/api/agent/sessions/{session['id']}").json()
        generated = [
            item for item in loaded["messages"]
            if item.get("meta_data", {}).get("message_kind") == "learning_task_generated"
        ]
        assert len(generated) == 1
        assert "/wf03/tasks/ltc_generated_01" in generated[0]["content"]


def test_learning_task_generation_persistence_tolerates_stale_replay_check(monkeypatch):
    fake_xfyun = _FakeXfyunClient()

    async def always_miss_replay(*_args, **_kwargs):
        return None

    monkeypatch.setattr(learning_task_conversion, "_gateway", lambda: _FakeGateway())
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    monkeypatch.setattr(
        learning_task_conversion,
        "_replay_generation_result",
        always_miss_replay,
    )
    with TestClient(app) as client:
        username = f"conversion_race_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200
        session = client.post("/api/agent/sessions", json={"session_type": "global"}).json()
        payload = {
            "query": "Unity游戏客户端登录与场景加载模块开发",
            "session_id": session["id"],
            "client_turn_id": "conversion-race-001",
        }

        first = client.post("/api/learning-task-conversion/generate", json=payload)
        second = client.post("/api/learning-task-conversion/generate", json=payload)

        assert first.status_code == 200
        assert second.status_code == 200
        assert len(fake_xfyun.calls) == 2
        loaded = client.get(f"/api/agent/sessions/{session['id']}").json()
        matching_messages = [
            item for item in loaded["messages"]
            if item.get("meta_data", {}).get("client_turn_id") == "conversion-race-001"
        ]
        assert len(matching_messages) == 2


def test_learning_task_generation_turns_intake_conflict_into_clarification(monkeypatch):
    fake_xfyun = _StageConflictClient()
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        username = f"conversion_clarify_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        response = client.post(
            "/api/learning-task-conversion/generate",
            json={"query": "我还不知道"},
        )

        assert response.status_code == 200
        assert response.json()["status"] == "needs_clarification"
        assert response.json()["task_card_id"] == ""
        assert response.json()["bundle"] is None
        assert "请再补充一个可执行对象或结果" in response.json()["message"]
        assert len(fake_xfyun.calls) == 2


def test_learning_task_generation_never_exposes_empty_or_workflow_self_links(monkeypatch):
    fake_xfyun = _WorkflowSelfLinkClient()
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        username = f"conversion_self_link_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        response = client.post(
            "/api/learning-task-conversion/generate",
            json={"query": "Unity游戏客户端开发"},
        )

        payload = response.json()
        assert response.status_code == 200
        assert payload["status"] == "needs_revision"
        assert payload["task_card_id"] == ""
        assert payload["bundle"] is None
        assert "agent.xfyun.cn" not in payload["message"]
        assert "[]()" not in payload["message"]


def test_learning_task_clarification_never_exposes_workflow_content(monkeypatch):
    fake_xfyun = _ClarificationWithInternalLinkClient()
    monkeypatch.setattr(learning_task_conversion, "_xfyun_client", lambda: fake_xfyun)
    with TestClient(app) as client:
        username = f"safe_clarify_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        response = client.post(
            "/api/learning-task-conversion/generate",
            json={"query": "Unity游戏客户端开发"},
        )

        payload = response.json()
        assert response.status_code == 200
        assert payload["status"] == "needs_clarification"
        assert "请再补充一个可执行对象或结果" in payload["message"]
        assert "agent.xfyun.cn" not in payload["message"]
        assert "[]()" not in payload["message"]


def test_learning_task_conversion_proxies_both_handoff_directions(monkeypatch):
    gateway = _FakeGateway()
    monkeypatch.setattr(learning_task_conversion, "_gateway", lambda: gateway)
    with TestClient(app) as client:
        username = f"conversion_handoff_{uuid.uuid4().hex[:10]}"
        assert client.post("/api/auth/register", json=_registration(username)).status_code == 200

        upstream = {
            "schema_version": "competency-graph-learning-task-handoff-v1",
            "upstream_task_id": "unity-role-01",
            "correlation_id": "handoff-test-01",
            "task_name": "Unity 游戏客户端角色移动模块开发与验收",
        }
        upstream_response = client.post(
            "/api/learning-task-conversion/upstream-handoffs",
            json=upstream,
        )
        assert upstream_response.status_code == 200
        assert gateway.submitted_upstream[-1]["task_name"] == upstream["task_name"]

        handoff = client.get(
            "/api/learning-task-conversion/tasks/ltc_generated_01/personalized-learning"
        )
        assert handoff.status_code == 200
        assert handoff.json()["task_card_id"] == "ltc_generated_01"

        knowledge_entry = client.get(
            "/api/learning-task-conversion/tasks/ltc_generated_01/knowledge/"
            "kp_camera/personalized-learning-entry"
        )
        assert knowledge_entry.status_code == 200
        entry = knowledge_entry.json()
        assert entry["schema_version"] == (
            "learning-task-knowledge-to-personalized-learning-v1"
        )
        assert entry["focus"]["knowledge_point"]["knowledge_id"] == "kp_camera"
        assert entry["focus"]["source_steps"][0]["step_id"] == "step_01"
        assert entry["focus"]["strongly_related_skills"][0]["skill_id"] == "sp_camera"
        assert entry["focus"]["relationships"][0]["strength"] == "strong"
        assert "focus.relationships" in entry["generation_contract"]["immutable_fields"]

        opened = client.post(
            "/api/learning-task-conversion/tasks/ltc_generated_01/knowledge/"
            "kp_camera/personalized-learning-entry"
        )
        assert opened.status_code == 200
        assert opened.json()["navigation"]["entry_path"].endswith(
            "/ltc_generated_01/knowledge/kp_camera"
        )

        missing_knowledge = client.get(
            "/api/learning-task-conversion/tasks/ltc_generated_01/knowledge/"
            "kp_missing/personalized-learning-entry"
        )
        assert missing_knowledge.status_code == 404

        feedback = {
            "schema_version": "personalized-learning-to-task-conversion-feedback-v1",
            "task_card_id": "ltc_generated_01",
            "correlation_id": f"feedback-{uuid.uuid4().hex}",
            "source_system": "learnflow-task-review",
            "status": "accepted_with_feedback",
            "issues": [{"issue_id": "issue-01"}],
            "summary": "步骤映射需要复核",
        }
        feedback_response = client.post(
            "/api/learning-task-conversion/downstream-feedback",
            json=feedback,
        )
        assert feedback_response.status_code == 200
        assert gateway.submitted_feedback[-1]["task_card_id"] == "ltc_generated_01"

        submitted_count = len(gateway.submitted_feedback)
        invalid_feedback = {**feedback, "issues": {"issue_id": "not-an-array"}}
        invalid_feedback["correlation_id"] = f"invalid-{uuid.uuid4().hex}"
        invalid_response = client.post(
            "/api/learning-task-conversion/downstream-feedback",
            json=invalid_feedback,
        )
        assert invalid_response.status_code == 422
        assert len(gateway.submitted_feedback) == submitted_count
