from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.teaching_guidance import (
    GUIDANCE_VERSION, reduce_teaching_guidance, select_teaching_guidance,
)

NOW = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)


def event(text="", *, event_id=1, event_type="user_message", session=10, project=1,
          checkpoint=2, at=NOW, **payload):
    return SimpleNamespace(id=event_id, event_type=event_type, occurred_at=at,
                           created_at=at, project_id=project, checkpoint_id=checkpoint,
                           session_id=session, payload={"text": text, **payload})


def apply(states, incoming):
    next_state = deepcopy(states)
    for kernel, patch in reduce_teaching_guidance(incoming, states).items():
        state = next_state.setdefault(kernel, {"short_term": {}, "long_term": {}})
        for storage in ("short_term", "long_term"):
            state.setdefault(storage, {}).update(patch[storage])
    return next_state


def read(states, **scope):
    return select_teaching_guidance(states, project_id=scope.get("project", 1),
                                   checkpoint_id=scope.get("checkpoint", 2),
                                   session_id=scope.get("session", 10),
                                   now=scope.get("at", NOW),
                                   archived_paths=scope.get("archived_paths", ()))


@pytest.mark.parametrize("text,kernel,slot", [
    ("这一步没看懂", "knowledge", "current_blocker"),
    ("今天只有10分钟", "human", "time_budget"),
    ("今天不想写代码", "human", "code_participation"),
    ("别给代码例子", "human", "code_participation"),
    ("别再用这个例子", "human", "example_selection"),
    ("这次回答简短", "human", "response_length"),
    ("我会二分查找", "knowledge", "starting_point"),
    ("先回到上一节", "structure", "return_anchor"),
    ("先补矩阵乘法再继续", "structure", "return_anchor"),
    ("今天先学SQL", "value", "current_priority"),
    ("先完成数据库项目", "value", "current_priority"),
])
def test_first_evidence_immediately_guides_without_mastery_or_long_term(text, kernel, slot):
    states = apply({}, event(text))
    directives = read(states)
    assert any(item["kernel"] == kernel and item["slot"] == slot for item in directives)
    assert all(item["mastery_inference"] is False for item in directives)
    assert all(not state["long_term"] for state in states.values())
    assert all(item["source_event_id"] == 1 and item["policy_version"] == GUIDANCE_VERSION for item in directives)


@pytest.mark.parametrize("text", [
    "我不会二分查找", "我会二分查找吗？", "我的同学会二分查找",
    "假设我会二分查找", "他说今天只有10分钟", "“这一步没看懂”",
    "如果今天只有10分钟", "测试消息：我会二分查找",
    "不要先回到上一节", "别先学SQL",
    "他今天只有10分钟", "朋友今天只有10分钟", "不是我明白了",
    "今天不是只有10分钟", "以后可能用Python示例", "以后用Python示例吗？",
])
def test_negation_quotes_hypotheses_and_third_party_do_not_become_facts(text):
    assert reduce_teaching_guidance(event(text), {}) == {}


def test_turn_instruction_clears_on_next_same_session_input_but_other_session_survives():
    states = apply({}, event("这次回答简短"))
    states = apply(states, event("这一步没看懂", event_id=2, session=11))
    assert len(read(states)) == 1
    states = apply(states, event("继续", event_id=3, at=NOW + timedelta(seconds=1)))
    assert read(states, at=NOW + timedelta(seconds=1)) == []
    assert read(states, session=11)[0]["slot"] == "current_blocker"


def test_reads_do_not_consume_turn_and_repeated_event_is_idempotent():
    incoming = event("这次回答简短")
    states = apply({}, incoming)
    assert read(states) == read(states)
    assert reduce_teaching_guidance(incoming, states) == {}


def test_scope_and_eight_hour_expiration_prevent_leakage_and_replay_refresh():
    states = apply({}, event("今天只有10分钟"))
    assert read(states, project=9) == []
    assert read(states, checkpoint=9) == []
    assert read(states, session=9) == []
    assert read(states, session=None) == []
    assert read(states, at=NOW + timedelta(hours=8)) == []
    assert reduce_teaching_guidance(event("今天只有10分钟"), states) == {}
    assert read(states, at=NOW + timedelta(hours=8)) == []


def test_resolved_blocker_is_acknowledged_without_mastery_and_only_in_same_session():
    states = apply({}, event("这一步没看懂"))
    states = apply(states, event("这一步没看懂", event_id=2, session=11))
    states = apply(states, event("我明白了", event_id=3, at=NOW + timedelta(seconds=1)))
    assert read(states, at=NOW + timedelta(seconds=1))[0]["evidence_kind"] == "self_reported_resolution"
    assert read(states, session=11)[0]["evidence_kind"] == "self_reported_gap"
    states = apply(states, event("继续", event_id=4, at=NOW + timedelta(seconds=2)))
    assert read(states, at=NOW + timedelta(seconds=2)) == []
    assert all(not state["long_term"] for state in states.values())


def test_explicit_durable_preference_needs_one_request_and_local_override_expires():
    states = apply({}, event("以后代码示例优先用Python"))
    assert read(states, session=99)[0]["lifetime"] == "persistent"
    states = apply(states, event("这次示例用Java", event_id=2, at=NOW + timedelta(seconds=1)))
    assert read(states, at=NOW + timedelta(seconds=1))[0]["language"] == "Java"
    assert read(states, session=99, at=NOW + timedelta(seconds=1))[0]["language"] == "Python"
    assert read(states, at=NOW + timedelta(hours=9))[0]["language"] == "Python"


def test_persistent_cancel_suppresses_old_default_and_has_explicit_stop_instruction():
    states = apply({}, event("以后代码示例优先用Python"))
    old = deepcopy(states["human"]["long_term"]["teaching_preferences"][0])
    states = apply(states, event("以后不用Python示例了", event_id=2, at=NOW + timedelta(seconds=1)))
    # Reader is defensive even against historical duplicated preferences.
    states["human"]["long_term"]["teaching_preferences"].append(old)
    selected = read(states, at=NOW + timedelta(days=30))
    assert len(selected) == 1
    assert selected[0]["status"] == "active"
    assert selected[0]["cancelled"] is True
    assert selected[0]["evidence_kind"] == "explicit_cancellation"
    assert "取消默认" in selected[0]["instruction"]
    assert selected[0]["source_event_id"] == 2


def test_delayed_input_cannot_overwrite_newer_preference():
    states = apply({}, event("以后代码示例优先用Java", event_id=2, at=NOW + timedelta(seconds=1)))
    states = apply(states, event("以后代码示例优先用Python", event_id=1))
    assert read(states, at=NOW + timedelta(seconds=1))[0]["language"] == "Java"


def test_no_session_user_input_is_not_project_wide_temporary_guidance():
    assert reduce_teaching_guidance(event("这一步没看懂，今天只有10分钟", session=None), {}) == {}
    assert reduce_teaching_guidance(event("这次回答简短", session=None, project=None, checkpoint=None), {}) == {}
    states = apply({}, event("以后代码示例优先用Python", session=None, project=None, checkpoint=None))
    assert read(states)[0]["lifetime"] == "persistent"


@pytest.mark.parametrize("event_type,result", [
    ("concept_attempt_evaluated", {"correct": False}),
    ("exercise_attempt_evaluated", {"passed": False}),
    ("remediation_retry_evaluated", {"passed": False}),
    ("remediation_variant_evaluated", {"correct": False}),
    ("review_attempt_evaluated", {"passed": False}),
    ("transfer_attempt_evaluated", {"passed": False}),
])
def test_grading_failures_immediately_guide_without_human_or_mastery(event_type, result):
    states = apply({}, event(event_type=event_type, item_id=4, **result))
    assert set(states) == {"practice"}
    assert read(states)[0]["evidence_kind"] == "evaluated_error"
    assert states["practice"]["long_term"] == {}


@pytest.mark.parametrize("metadata,expected", [
    ({"independent": False}, "supported_success"),
    ({"independent": True}, "independent_success"),
    ({"assistance_level": "hint"}, "supported_success"),
    ({"assistance_level": "none"}, "independent_success"),
    ({}, "success_assistance_unspecified"),
])
def test_support_is_not_independence_and_no_success_is_stable_mastery(metadata, expected):
    states = apply({}, event(event_type="concept_attempt_evaluated", item_id=1, correct=True, **metadata))
    directive = read(states)[0]
    assert directive["evidence_kind"] == expected
    assert directive["mastery_inference"] is False
    assert states["practice"]["long_term"] == {}


def test_success_changes_only_matching_item_feedback_and_not_other_blockers():
    states = apply({}, event("这一步没看懂"))
    for item in (1, 2):
        states = apply(states, event(event_type="exercise_attempt_evaluated", event_id=item + 1, item_id=item, passed=False))
    states = apply(states, event(event_type="exercise_attempt_evaluated", event_id=4, item_id=1,
                                passed=True, assistance_level="none", at=NOW + timedelta(seconds=1)))
    directives = read(states, at=NOW + timedelta(seconds=1))
    assert any(item["slot"] == "current_blocker" for item in directives)
    outcomes = {item["item_key"]: item["outcome"] for item in directives if "item_key" in item}
    assert outcomes == {"exercise:1": "independent_success"}
    # Other item evidence remains scoped in storage and can be explicitly selected.
    other = select_teaching_guidance(states, project_id=1, checkpoint_id=2, session_id=10,
                                    now=NOW + timedelta(seconds=1), item_key="exercise:2")
    assert next(item for item in other if "item_key" in item)["outcome"] == "evaluated_error"


@pytest.mark.parametrize("outcome", ["unknown", "skipped", "missing", "unanswered"])
def test_no_attempt_is_not_wrong_answer(outcome):
    states = apply({}, event(event_type="review_attempt_evaluated", item_id=1, passed=False, outcome=outcome))
    assert read(states)[0]["evidence_kind"] == "incomplete_attempt"


def test_model_candidate_only_allows_one_low_priority_clarification():
    states = apply({}, event(event_type="semantic_observation_proposed", fields={"mastery": "stable"}))
    directive = read(states)[0]
    assert directive["lifetime"] == "turn"
    assert directive["evidence_kind"] == "inferred_candidate"
    assert directive["priority"] == 10
    assert "stable" not in directive["instruction"]
    assert states["knowledge"]["long_term"] == {}


def test_explicit_ui_adaptation_only_changes_human_and_requires_explicit_input():
    states = apply({}, event(event_type="vnext_human_adaptation_requested", signal_kind="pace_adjustment", value="slower", explicit=True))
    assert set(states) == {"human"}
    assert read(states)[0]["slot"] == "pace"
    assert reduce_teaching_guidance(event(event_type="vnext_human_adaptation_requested", signal_kind="pace_adjustment", value="slower", explicit=False), {}) == {}


@pytest.mark.parametrize("archive", [
    ("human", "short_term", "teaching_directives"),
    ("human", "short_term", "planning_availability"),
    "human.short_term.teaching_directives",
])
def test_archived_current_and_related_human_controls_do_not_reappear(archive):
    states = apply({}, event("今天只有10分钟"))
    assert read(states, archived_paths=[archive]) == []


def test_archive_persistent_preferences_hides_default_but_not_other_kernels():
    states = apply({}, event("以后代码示例优先用Python"))
    states = apply(states, event("今天先学SQL", event_id=2))
    selected = read(states, archived_paths=[("human", "long_term", "teaching_preferences")])
    assert [item["kernel"] for item in selected] == ["value"]


def test_bounded_storage_read_and_deterministic_priority():
    states = {}
    for index in range(40):
        states = apply(states, event("今天只有10分钟", event_id=index + 1, session=index,
                                    at=NOW + timedelta(seconds=index)))
    assert len(states["human"]["short_term"]["teaching_directives"]) == 24
    for index in range(12):
        states = apply(states, event(event_type="exercise_attempt_evaluated", event_id=index + 50,
                                    item_id=index, passed=False, at=NOW + timedelta(minutes=1)))
    assert 0 < len(read(states, at=NOW + timedelta(minutes=1))) <= 8
    assert sum(item["slot"] == "practice_feedback" for item in read(states, at=NOW + timedelta(minutes=1))) == 1
    states["practice"]["short_term"]["teaching_directives"][0]["priority"] = 100000
    assert all(item["priority"] <= 95 for item in read(states, at=NOW + timedelta(minutes=1)))


def test_reducer_and_selector_do_not_mutate_input():
    states = apply({}, event("这一步没看懂"))
    original = deepcopy(states)
    reduce_teaching_guidance(event("我明白了", event_id=2), states)
    read(states)
    assert states == original


def test_undated_event_does_not_gain_new_lifetime():
    assert reduce_teaching_guidance(event("今天只有10分钟", at=None), {}) == {}


@pytest.mark.parametrize("text,budget", [("今天只有十分钟", 10), ("我只有二十五分钟", 25), ("今天只有半小时", 30)])
def test_common_chinese_time_budgets(text, budget):
    assert read(apply({}, event(text)))[0]["minutes"] == budget


@pytest.mark.parametrize("text", ["这一步没懂", "没懂", "不懂"])
def test_short_gap_requests_are_current_knowledge_only(text):
    states = apply({}, event(text))
    assert set(states) == {"knowledge"}
    assert read(states)[0]["evidence_kind"] == "self_reported_gap"


@pytest.mark.parametrize("text", ["懂了", "明白了"])
def test_short_acknowledgments_resolve_current_gap_without_mastery(text):
    states = apply({}, event("没懂"))
    states = apply(states, event(text, event_id=2, at=NOW + timedelta(seconds=1)))
    assert read(states, at=NOW + timedelta(seconds=1))[0]["evidence_kind"] == "self_reported_resolution"


@pytest.mark.parametrize("text,slot", [
    ("以后先举例再讲原理", "representation"),
    ("以后讲解慢一点", "pace"),
    ("以后回答简短些", "response_length"),
])
def test_explicit_durable_format_requests_and_cancellation(text, slot):
    states = apply({}, event(text))
    assert read(states, session=99)[0]["slot"] == slot
    assert read(states, session=99)[0]["lifetime"] == "persistent"
    states = apply(states, event(text.replace("以后", "以后不用"), event_id=2, at=NOW + timedelta(seconds=1)))
    cancellation = read(states, session=99, at=NOW + timedelta(seconds=1))[0]
    assert cancellation["cancelled"] is True
    assert cancellation["evidence_kind"] == "explicit_cancellation"


def test_same_message_durable_language_and_todays_exception_are_separate():
    states = apply({}, event("以后代码示例优先用Python，今天不要写代码"))
    assert [item["slot"] for item in read(states)] == ["code_participation"]
    future = read(states, session=99)[0]
    assert future["slot"] == "code_language"
    assert future["cancelled"] is False
    assert future["language"] == "Python"
    assert read(states, at=NOW + timedelta(hours=9))[0]["language"] == "Python"


def test_no_code_suppresses_ui_code_representation_without_erasing_it():
    states = apply({}, event(event_type="vnext_human_adaptation_requested", signal_kind="format_request", value="code"))
    states = apply(states, event("今天不想写代码", event_id=2, at=NOW + timedelta(seconds=1)))
    assert [item["slot"] for item in read(states, at=NOW + timedelta(seconds=1))] == ["code_participation"]
    assert len(states["human"]["short_term"]["teaching_directives"]) == 2


def test_explicit_return_to_code_replaces_temporary_refusal():
    states = apply({}, event("以后代码示例优先用Python，今天不想写代码"))
    states = apply(states, event("现在可以写代码了", event_id=2, at=NOW + timedelta(seconds=1)))
    selected = read(states, at=NOW + timedelta(seconds=1))
    assert next(item for item in selected if item["slot"] == "code_participation")["allow_code"] is True
    assert any(item["slot"] == "code_language" for item in selected)


def test_new_gap_in_same_message_is_not_erased_by_earlier_acknowledgment():
    states = apply({}, event("我明白了，但这一步没懂"))
    assert read(states)[0]["evidence_kind"] == "self_reported_gap"


def test_negative_request_is_not_short_answer_request():
    assert reduce_teaching_guidance(event("这次回答不要简短"), {}) == {}


def test_replayed_acknowledgment_does_not_remove_its_own_turn_guidance():
    states = apply({}, event("没懂"))
    acknowledgment = event("懂了", event_id=2, at=NOW + timedelta(seconds=1))
    states = apply(states, acknowledgment)
    assert reduce_teaching_guidance(acknowledgment, states) == {}
