"""Evidence-driven planning choices, with both host consumers exercised."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.services import learning_tasks as tasks
from learnflow_core.planning_guidance import compile_planning_guidance, enforce_planning_guidance
from learnflow_core.registry_core import EDUCATION_MEMORY_POLICIES

NOW = datetime(2026, 9, 8, tzinfo=timezone.utc)


def episode(**outcome):
    return {"schema_version": "learnflow.learning-episode.v1", "attempt_id": 12,
            "occurred_at": (NOW - timedelta(hours=1)).isoformat(),
            "task": {"item_type": "concept", "item_id": 6, "attempt_kind": "ordinary"},
            "outcome": {"correct": True, "assistance_level": None, "independent": None, **outcome},
            "scope": {"project_id": 2, "checkpoint_id": 3, "session_id": 4},
            "source_event_ids": [21], "source_mutation_ids": [31], "source_fact_ids": [41]}


def compiled(row):
    return compile_planning_guidance({"practice": {"learning_episodes": [row]}}, now=NOW)


@pytest.mark.parametrize("outcome,action", [
    ({"correct": False}, "diagnose_first_error"),
    ({"correct": None}, "clarify_nonresponse"),
    ({}, "clarify_assistance"),
    ({"assistance_level": "none"}, "clarify_assistance"),
    ({"assistance_level": "hint", "independent": True}, "fade_support_then_independent_probe"),
    ({"assistance_level": "none", "independent": True}, "independent_variant_or_reasoning_check"),
])
def test_episode_decisions_keep_missing_and_assisted_evidence_distinct(outcome, action):
    controls = compiled(episode(**outcome))
    assert controls["decisions"] == [{"action": action, "source_event_ids": [21],
        "policy_version": "learning-plan-guidance.v2", "uncertainties": ["stable_mastery_not_established"],
        "mastery_inference": False}]
    plan = tasks._fallback_plan(title="递归", objective="解释终止条件", origin_kind="conversation", estimated_minutes=30)
    before = deepcopy(plan)
    actual = enforce_planning_guidance(plan, controls)
    assert actual["teaching_decisions"] == controls["decisions"]
    assert all(p["required"] for p in actual["phases"] if p["kind"] in {"practice", "verify"})
    assert [p["completion_rule"] for p in actual["phases"]] == [p["completion_rule"] for p in before["phases"]]
    assert [p["status"] for p in actual["phases"]] == [p["status"] for p in before["phases"]]
    assert enforce_planning_guidance(actual, controls) == actual
    assert plan == before


@pytest.mark.parametrize("patch", [
    {"schema_version": "unknown"}, {"attempt_id": True}, {"source_event_ids": []},
    {"source_event_ids": [-1]}, {"source_fact_ids": []}, {"source_mutation_ids": []},
    {"occurred_at": "malformed"}, {"occurred_at": (NOW + timedelta(hours=1)).isoformat()},
])
def test_malformed_or_unattributed_episode_cannot_drive_a_plan(patch):
    assert compiled({**episode(), **patch})["decisions"] == []


def test_retry_does_not_become_independent_transfer_and_latest_event_wins():
    old = episode(correct=False)
    latest = episode(assistance_level="none", independent=True)
    latest["occurred_at"] = NOW.isoformat()
    latest["source_event_ids"] = [22]
    latest["task"]["attempt_kind"] = "retry"
    for rows in ([latest, old], [old, latest]):
        controls = compile_planning_guidance({"practice": {"learning_episodes": rows}}, now=NOW)
        assert controls["decisions"][0]["action"] == "fade_support_then_independent_probe"
        assert controls["decisions"][0]["source_event_ids"] == [22]


def test_host_planner_consumes_only_scoped_packet_episodes(monkeypatch):
    from app.services import five_kernel_context
    row = episode()
    builder = AsyncMock(return_value={"learning_episodes": [row], "items": [], "teaching_guidance": []})
    monkeypatch.setattr(five_kernel_context, "build_five_kernel_context", builder)
    monkeypatch.setattr(tasks, "get_kernel_projection", AsyncMock(return_value={}))
    db = AsyncMock()
    context = asyncio.run(tasks._scoped_planner_context(db, learner_id=1, project_id=2,
        checkpoint_id=3, session_id=4, objective="递归终止条件"))
    assert context["practice"]["learning_episodes"] == [row]
    kwargs = builder.call_args.kwargs
    assert {k: kwargs[k] for k in ("learner_id", "project_id", "checkpoint_id", "session_id")} == {
        "learner_id": 1, "project_id": 2, "checkpoint_id": 3, "session_id": 4}
    db.execute.assert_not_called()
    assert compiled(context["practice"]["learning_episodes"][0])["decisions"][0]["action"] == "clarify_assistance"


def test_registered_control_windows_match_implementation():
    from learnflow_core.teaching_guidance import GUIDANCE_VERSION, MAX_EXPLICIT_WINDOW_HOURS
    policy = EDUCATION_MEMORY_POLICIES["teaching_controls"]
    assert policy["version"] == GUIDANCE_VERSION
    assert policy["max_explicit_window_hours"] == MAX_EXPLICIT_WINDOW_HOURS
    assert EDUCATION_MEMORY_POLICIES["learning_episode"]["kernel_write_path"] == "none"


def test_completed_plan_does_not_claim_to_apply_new_practice_preparation():
    plan = tasks._fallback_plan(title="递归", objective="解释终止条件", origin_kind="conversation", estimated_minutes=30)
    for phase in plan["phases"]:
        phase["status"] = "completed"
    old = deepcopy(plan["phases"])
    result = enforce_planning_guidance(plan, compiled(episode(correct=False)))
    assert result["phases"] == old
    assert result["teaching_decisions"] == []


def test_goal_revision_replaces_only_the_previous_control_prefix():
    plan = tasks._fallback_plan(title="项目准备", objective="学习编程", origin_kind="conversation", estimated_minutes=30)
    original_summary = plan.get("summary", "")
    controls = {"policy_version": "learning-plan-guidance.v2", "sources": [], "current_priority": "先复习 SQL", "decisions": []}
    first = enforce_planning_guidance(plan, controls)
    second = enforce_planning_guidance(first, {**controls, "current_priority": "先完成递归练习"})
    assert "先复习 SQL" not in second["summary"]
    assert second["summary"].endswith(original_summary)
    cancelled = enforce_planning_guidance(second, {**controls, "current_priority": None})
    assert cancelled["summary"] == original_summary


# Real gateway -> reducer -> scoped ContextPacket -> host planner smoke. The
# API fixture provides an isolated test DB; this is not a fabricated State row.
from test_education_memory_policy import client, planner_context


def test_current_budget_in_mixed_task_prose_reaches_real_planner(client):
    ctx, selected = asyncio.run(planner_context([
        ("vnext_teaching_input_received", {"text": "题干写着‘今天有三十分钟’。我这一次只有10分钟。"}),
    ]))
    guidance = next(row for row in selected if row["slot"] == "time_budget")
    assert guidance["minutes"] == 10
    plan = tasks._fallback_plan(title="递归", objective="解释终止条件", origin_kind="conversation",
                                estimated_minutes=45, learner_context=ctx)
    assert plan["estimated_minutes"] == 10
    decision = next(row for row in plan["teaching_decisions"] if row["action"] == "limit_session")
    assert decision["source_event_ids"] == [guidance["source_event_id"]]
    source = plan["teaching_constraints"]["sources"][0]
    assert source["source_span"] is not None
    assert source["source_scope"] == source["application_scope"]


def test_packet_diagnoses_only_current_scope_without_copying_original_human_text(client):
    import json
    import uuid
    from app.db.database import async_session
    from app.services.five_kernel_context import build_five_kernel_context
    from app.services.learning_runtime import record_event
    from test_education_memory_policy import seed_scope

    async def run():
        owned = await seed_scope()
        other = await seed_scope(learner_id=owned["learner_id"])
        async with async_session() as db:
            source = await record_event(db, **{k: owned[k] for k in ("learner_id", "project_id", "checkpoint_id", "session_id")},
                event_type="vnext_teaching_input_received", source="user", client_event_id=uuid.uuid4().hex,
                payload={"text": "假设我只有20分钟，PRIVATE_HUMAN_TEXT。"})
            elsewhere = await record_event(db, **{k: other[k] for k in ("learner_id", "project_id", "checkpoint_id", "session_id")},
                event_type="vnext_teaching_input_received", source="user", client_event_id=uuid.uuid4().hex,
                payload={"text": "我这一次只有10分钟，OTHER_SCOPE_TEXT。"})
            packet = await build_five_kernel_context(db, **{k: owned[k] for k in ("learner_id", "project_id", "checkpoint_id", "session_id")},
                policy="checkpoint_tutor", query="继续学习递归")
            audit = packet["retrieval_diagnostics"]["teaching_controls"]
            assert audit["delivered"] == 0
            assert any(row["reason"] == "hypothetical_input" for row in audit["diagnostics"])
            assert {row.get("source_event_id") for row in audit["diagnostics"]} == {source.id}
            assert elsewhere.id not in {row.get("source_event_id") for row in audit["diagnostics"]}
            assert "PRIVATE_HUMAN_TEXT" not in json.dumps(packet)
            assert "OTHER_SCOPE_TEXT" not in json.dumps(packet)
    asyncio.run(run())


def test_direct_constraint_reapplication_restores_time_basis_after_expiry_or_cancel():
    plan = tasks._fallback_plan(title="递归", objective="解释终止条件", origin_kind="conversation", estimated_minutes=45)
    policy = {"policy_version": "learning-plan-guidance.v2", "sources": [], "decisions": []}
    first = enforce_planning_guidance(plan, {**policy, "max_minutes": 10})
    expanded = enforce_planning_guidance(first, {**policy, "max_minutes": 30})
    assert expanded["estimated_minutes"] == 30
    assert expanded["session_focus"]["max_minutes"] == 30
    expired = enforce_planning_guidance(first, policy)
    assert expired["estimated_minutes"] == 45
    assert "session_focus" not in expired
    assert expired["teaching_decisions"] == []


def test_equal_time_newer_assessment_event_overrides_older_guidance():
    item = episode(assistance_level="none", independent=True)
    old = {"kernel": "practice", "slot": "practice_feedback", "policy_version": "teaching-guidance.v1",
        "status": "active", "evidence_kind": "supported_success", "source_event_id": 20,
        "lifetime": "session", "occurred_at": item["occurred_at"],
        "expires_at": (NOW + timedelta(hours=1)).isoformat()}
    ctx = {"practice": {"teaching_guidance": [old], "learning_episodes": [item]}}
    actual = compile_planning_guidance(ctx, now=NOW)
    assert actual["practice_feedback"] == "independent_success"
    assert actual["decisions"][0]["source_event_ids"] == [21]
    old["source_event_id"] = 22
    assert compile_planning_guidance(ctx, now=NOW)["practice_feedback"] == "supported_success"


def test_current_input_diagnostics_survive_many_other_scope_controls():
    from types import SimpleNamespace
    from learnflow_core.teaching_guidance import diagnose_teaching_guidance
    rows = [{"kernel": "human", "slot": "time_budget", "policy_version": "teaching-guidance.v1",
             "status": "active", "source_event_id": i, "scope": {"project_id": 99, "session_id": i},
             "instruction": "Other scope", "lifetime": "session", "occurred_at": NOW.isoformat(),
             "expires_at": (NOW + timedelta(hours=1)).isoformat()} for i in range(1, 31)]
    event = SimpleNamespace(id=100, event_type="vnext_teaching_input_received", occurred_at=NOW,
        project_id=2, checkpoint_id=3, session_id=4, payload={"text": "假设我只有20分钟"})
    actual = diagnose_teaching_guidance({"human": {"short_term": {"teaching_directives": rows}}},
        project_id=2, checkpoint_id=3, session_id=4, now=NOW, input_event=event)
    assert actual["diagnostics"][0]["source_event_id"] == 100
    assert actual["diagnostics"][0]["reason"] == "hypothetical_input"
    assert len(actual["diagnostics"]) <= 24 and actual["omitted"] > 0


@pytest.mark.parametrize("text,minutes", [
    ("题干：我现在只有10分钟", []),
    ("题干：‘我现在只有10分钟", []),
    ("“我现在只有10分钟", []),
    ("题干：我现在只有10分钟，但这一次只有2分钟", [2]),
])
def test_task_colon_and_unclosed_quotes_do_not_become_a_personal_budget(text, minutes):
    from learnflow_core.teaching_control_parser import parse_text_controls
    parsed = parse_text_controls(text, NOW)
    assert [a["details"]["minutes"] for a in parsed["actions"] if a["slot"] == "time_budget"] == minutes
