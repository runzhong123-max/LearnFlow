"""Offline regression probes for scoped teaching memory and evidence gates."""
import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app.models.learning import LearningAttempt, RemediationCase, ReviewSchedule
from app.services.learning_tasks import _fallback_plan, _planner_memory_items, _scoped_planner_context
from app.services.remediation import apply_retry_result
from app.services.review_proficiency import build_concept_proficiency


def _item(identifier, kernel, **scope):
    return {"id": identifier, "kernel": kernel, "status": "active", "scope": scope,
            "text": "Python knowledge gap", "retrieval": {"reasons": ["lexical_match"]},
            "provenance": {"key": "knowledge_gap"}, "occurred_at": "2026-09-05"}


def test_planner_does_not_import_another_task_or_unrelated_global_memory():
    items = [_item(1, "knowledge", project_id=1, checkpoint_id=2, session_id=3),
             _item(2, "knowledge", project_id=8),
             _item(3, "practice", project_id=1, checkpoint_id=2, session_id=99),
             {**_item(4, "value"), "retrieval": {"reasons": ["active_claim"]}},
             {**_item(5, "knowledge"), "status": "retracted"}, _item(6, "value")]
    packet = {"scope": {"project_id": 1, "checkpoint_id": 2, "session_id": 3}, "items": items}
    assert [item["id"] for item in _planner_memory_items(packet)] == [1, 6]


def test_scoped_evidence_reaches_plan_with_provenance(monkeypatch):
    packet = {"snapshot_id": "snapshot-1", "scope": {"project_id": 1, "session_id": 3},
              "items": [_item(1, "knowledge", project_id=1, session_id=3),
                        {**_item(2, "practice", project_id=1, session_id=3),
                         "provenance": {"key": "assistance_level"}}]}
    retrieval = AsyncMock(return_value=packet)
    monkeypatch.setattr("app.services.five_kernel_context.build_five_kernel_context", retrieval)
    monkeypatch.setattr("app.services.learning_tasks.get_kernel_projection", AsyncMock(return_value={
        "human": {"short_term": {"format_preference": "先例子"}},
        "value": {"short_term": {"current_priority": "unrelated stale task"}}}))
    result = MagicMock()
    result.scalars.return_value.all.return_value = [SimpleNamespace(node_id=1, object_value="闭包变量捕获"),
                                                   SimpleNamespace(node_id=2, object_value="guided")]
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    context = asyncio.run(_scoped_planner_context(db, learner_id=7, project_id=1,
                          checkpoint_id=None, session_id=3, objective="理解 Python 闭包"))
    assert retrieval.call_args.kwargs["learner_id"] == 7
    assert context["knowledge"]["context_snapshot_id"] == "snapshot-1"
    assert context["knowledge"]["relevant_evidence"][0]["scope"]["session_id"] == 3
    assert "value" not in context
    plan = _fallback_plan(title="闭包", objective="理解闭包", origin_kind="conversation",
                          estimated_minutes=25, learner_context=context)
    assert "闭包变量捕获" in plan["phases"][0]["purpose"]
    assert "撤除提示" in plan["phases"][1]["purpose"]


def test_failed_retry_rotates_locally_without_recording_user_rejection(monkeypatch):
    record = AsyncMock(return_value=SimpleNamespace(id=12))
    monkeypatch.setattr("app.services.learning_runtime.record_event", record)
    case = RemediationCase(id=1, learner_id=1, project_id=2, checkpoint_id=3,
        item_type="concept", item_id=4, error_class="concept_misconception",
        misconception_tag="condition", evidence={"question": "why"},
        current_delivery_mode="contrast", ineffective_modes=[], strategy={},
        evidence_event_ids=[], explanation_history=[])
    attempt = LearningAttempt(id=10, assistance_level="none")
    asyncio.run(apply_retry_result(SimpleNamespace(), remediation=case, attempt=attempt,
                                  passed=False, evidence_event_id=11))
    assert case.current_delivery_mode != "contrast"
    assert case.ineffective_modes == []
    assert "contrast" in case.strategy["local_attempted_modes"]
    assert [call.kwargs["event_type"] for call in record.call_args_list] == ["remediation_retry_evaluated"]


def test_original_successes_never_claim_transfer():
    now = datetime.utcnow()
    schedule = ReviewSchedule(successful_reviews=4, interval_level=5, lapse_count=0,
                              last_reviewed_at=now, last_grade="good")
    attempts = [LearningAttempt(id=index, item_type="concept", status="evaluated",
                attempt_role="retry", assistance_level="none", result={"correct": True},
                evaluated_at=now) for index in range(1, 5)]
    result = build_concept_proficiency(schedule, attempts, [], now=now)
    assert result["score"] >= 65
    assert result["level"] == "developing"
    assert result["label"] == "形成中"


def test_standalone_generators_forward_authenticated_learner(monkeypatch):
    from app.services import task_runners
    task = SimpleNamespace(learner_id=71, payload={"checkpoint_id": 9})
    monkeypatch.setattr(task_runners, "update_task", AsyncMock(return_value=task))
    loader = AsyncMock(return_value=(None, "", [], {}))
    monkeypatch.setattr(task_runners, "_load_lecture_context", loader)
    monkeypatch.setattr(task_runners, "execution_policy_status", lambda: {"enabled": True})
    # Empty chunks stop both entrypoints before any model or generated code runs.
    asyncio.run(task_runners.run_concept_generation(1))
    asyncio.run(task_runners.run_exercise_generation(2))
    assert len(loader.call_args_list) == 2
    assert all(call.args == (9,) and call.kwargs == {"learner_id": 71}
               for call in loader.call_args_list)
