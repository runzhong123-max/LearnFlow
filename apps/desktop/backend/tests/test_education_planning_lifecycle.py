"""Stateful plan lifecycle regressions; model and persistence are isolated."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.services import learning_tasks as tasks
from learnflow_core.planning_guidance import compile_planning_guidance, enforce_planning_guidance
from learnflow_core.teaching_guidance import GUIDANCE_VERSION


def context(minutes=None, *, learning_gap=False, supported=False):
    now = datetime.now(timezone.utc)
    rows = []
    for kernel, slot, kind, details in (
        ("human", "time_budget", "explicit_request", {"minutes": minutes}),
        ("knowledge", "current_blocker", "self_reported_gap", {}),
        ("practice", "practice_feedback", "supported_success", {}),
    ):
        if (slot == "time_budget" and minutes is None or
                slot == "current_blocker" and not learning_gap or
                slot == "practice_feedback" and not supported):
            continue
        rows.append({"kernel": kernel, "slot": slot, "evidence_kind": kind, **details,
                     "policy_version": GUIDANCE_VERSION, "status": "active", "source_event_id": len(rows) + 1,
                     "scope": {"project_id": 2, "checkpoint_id": 3, "session_id": 4},
                     "lifetime": "session", "occurred_at": now.isoformat(),
                     "expires_at": (now + timedelta(hours=1)).isoformat()})
    return {kernel: {"teaching_guidance": [row for row in rows if row["kernel"] == kernel]}
            for kernel in {row["kernel"] for row in rows}}


def task_with_plan(plan):
    return SimpleNamespace(id=9, learner_id=1, project_id=2, checkpoint_id=3, session_id=4,
        title="递归终止", objective="解释递归终止并独立验证", origin_kind="conversation", status="active",
        estimated_minutes=plan["estimated_minutes"], plan=plan, plan_version=1, version=1,
        action_log=[], execution_state={}, current_phase_id="learn")


def initial_plan(learner_context=None):
    return tasks._fallback_plan(title="递归终止", objective="解释递归终止并独立验证",
                                origin_kind="conversation", estimated_minutes=60,
                                learner_context=learner_context)


def setup_replan(monkeypatch, learner_context):
    monkeypatch.setattr(tasks.settings, "llm_api_key", "")
    monkeypatch.setattr(tasks, "_scoped_planner_context", AsyncMock(return_value=learner_context))
    monkeypatch.setattr(tasks, "_append_revision", AsyncMock())
    monkeypatch.setattr(tasks, "_record_task_event", AsyncMock())


def replan(task, request):
    return asyncio.run(tasks.replan_learning_task(SimpleNamespace(), task=task, reason="更新当前支持",
        learner_direction="", preferred_skills=[], expected_version=task.version, client_request_id=request))


def test_new_guidance_reaches_pending_phase_without_rewriting_completed_work(monkeypatch):
    plan = initial_plan()
    for phase in plan["phases"][:2]:
        phase.update(status="completed", completed_at="2026-09-01T00:00:00")
    completed = deepcopy(plan["phases"][:2])
    ctx = context(10, learning_gap=True, supported=True)
    setup_replan(monkeypatch, ctx)
    task = replan(task_with_plan(plan), "replan-a")
    assert task.plan["phases"][:2] == completed
    assert task.current_phase_id == "verify"
    verify = task.plan["phases"][2]
    assert verify["required"] is True
    assert "当前卡点" in verify["purpose"] and "撤除提示" in verify["purpose"]
    assert "无提示" in verify["purpose"]
    assert len(verify["teaching_preparation_sources"]) == 3
    assert len(task.plan["phases"]) == 4
    assert enforce_planning_guidance(task.plan, compile_planning_guidance(ctx)) == task.plan


def test_new_and_expired_budget_recompute_from_uncapped_task_estimate(monkeypatch):
    task = task_with_plan(initial_plan(context(10)))
    assert task.estimated_minutes == 10
    setup_replan(monkeypatch, context(30))
    replan(task, "budget-30")
    assert task.estimated_minutes == 30
    setup_replan(monkeypatch, {})
    replan(task, "expired-budget")
    assert task.estimated_minutes == 60
    assert "session_focus" not in task.plan


def test_candidate_override_preserves_identity_and_acceptance_while_honoring_budget(monkeypatch):
    ctx = context(2, supported=True)
    monkeypatch.setattr(tasks, "_validate_scope", AsyncMock(return_value=(None, None, None)))
    monkeypatch.setattr(tasks, "_scoped_planner_context", AsyncMock(return_value=ctx))
    monkeypatch.setattr(tasks, "_next_queue_position", AsyncMock(return_value=100))
    monkeypatch.setattr(tasks, "_append_revision", AsyncMock())
    monkeypatch.setattr(tasks, "_record_task_event", AsyncMock())
    candidate = initial_plan()
    candidate["provider_source"] = {"snapshot": "confirmed-source"}
    for phase in candidate["phases"]:
        phase["id"] = "confirmed-" + phase["id"]
    baseline = deepcopy(candidate)
    class DB:
        async def execute(self, *_):
            return SimpleNamespace(scalar_one_or_none=lambda: None)
        def add(self, _):
            pass
        async def flush(self):
            pass
    task, created = asyncio.run(tasks.create_learning_task(DB(), learner_id=1, title="递归",
        objective="独立判断终止条件", session_id=4, project_id=2, checkpoint_id=None,
        client_request_id="candidate-1", plan_override=candidate, estimated_minutes=60))
    assert created and task.estimated_minutes == 2
    assert task.plan["provider_source"] == baseline["provider_source"]
    assert [(p["id"], p["completion_rule"], p["methods"]) for p in task.plan["phases"]] == [
        (p["id"], p["completion_rule"], p["methods"]) for p in baseline["phases"]]
    assert candidate == baseline
    assert "撤除提示" in task.plan["phases"][1]["purpose"]


def test_explicit_task_duration_edit_is_preserved_on_replan(monkeypatch):
    from learnflow_core.api import learning_tasks as api
    from app.schemas.learning_task import LearningTaskUpdate
    task = task_with_plan(initial_plan(context(10)))
    monkeypatch.setattr(api, "_owned_task_or_404", AsyncMock(return_value=task))
    monkeypatch.setattr(api, "learning_task_view", AsyncMock(return_value={}))
    asyncio.run(api.update_task(task_id=task.id,
        request=LearningTaskUpdate(expected_version=task.version, estimated_minutes=25),
        db=SimpleNamespace(commit=AsyncMock()), current=SimpleNamespace(learner=SimpleNamespace(id=1))))
    assert task.estimated_minutes == 25
    setup_replan(monkeypatch, context(10))
    replan(task, "edited-with-current-cap")
    assert task.estimated_minutes == 10
    setup_replan(monkeypatch, {})
    replan(task, "edited-after-expiry")
    assert task.estimated_minutes == 25


def test_model_reversed_stages_cannot_put_verification_before_gap_support():
    fallback = initial_plan(context(10, learning_gap=True, supported=True))
    raw = {"phases": [{"kind": "verify", "required": False}, {"kind": "learn"}]}
    plan = tasks._validated_plan(raw, fallback)
    assert [phase["kind"] for phase in plan["phases"]] == ["learn", "practice", "verify"]
    assert "当前卡点" in plan["phases"][0]["purpose"]
    assert "撤除提示" in plan["phases"][1]["purpose"]
    assert plan["phases"][2]["required"] is True
