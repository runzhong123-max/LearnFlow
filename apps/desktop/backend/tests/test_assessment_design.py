import pytest

from app.services.assessment_design import (
    default_rubric,
    normalize_blueprint_input,
    normalize_rubric,
    validate_rubric,
)


def test_assessment_blueprint_normalizes_targets_mix_and_success_boundary():
    blueprint = normalize_blueprint_input({
        "purpose": "transfer",
        "concept": "追踪队列状态",
        "concept_key": "queue-fifo",
        "item_types": ["single", "trace_table"],
        "count": 3,
        "difficulty_distribution": {"easy": 1, "medium": 2},
    })
    assert blueprint["target_subjects"][0]["concept_key"] == "queue-fifo"
    assert sum(item["count"] for item in blueprint["item_mix"]) == 3
    assert sum(blueprint["difficulty_distribution"].values()) == 1.0
    assert blueprint["success_policy"]["transfer_required"] is True
    assert blueprint["success_policy"]["assisted_success_is_independent"] is False
    assert blueprint["success_policy"]["single_success_is_stable_mastery"] is False


def test_assessment_rubric_keeps_deterministic_practice_agent_authority():
    blueprint = normalize_blueprint_input({
        "purpose": "diagnostic", "concept": "二分查找", "item_types": ["code_output"], "count": 2,
    })
    rubric = validate_rubric(default_rubric(blueprint))
    assert sum(item["weight"] for item in rubric["criteria"]) == 1.0
    assert rubric["scoring_policy"]["owner"] == "practice_agent"
    assert rubric["scoring_policy"]["llm_may_score"] is False
    assert rubric["evidence_contract"]["blueprint_or_item_generation"] == "zero_target"

    invalid = {**rubric, "scoring_policy": {**rubric["scoring_policy"], "llm_may_score": True}}
    with pytest.raises(ValueError, match="llm_grading_is_forbidden"):
        validate_rubric(invalid)


def test_partial_rubric_override_keeps_required_contract_fields():
    blueprint = normalize_blueprint_input({
        "purpose": "diagnostic", "concept": "条件概率", "item_types": ["single"],
    })
    rubric = normalize_rubric(blueprint, {
        "criteria": [{"id": "accuracy", "name": "正确性", "weight": 1.0}],
    })

    assert rubric["criteria"][0]["id"] == "accuracy"
    assert rubric["scoring_policy"]["llm_may_score"] is False
    assert rubric["evidence_contract"]["blueprint_or_item_generation"] == "zero_target"
    assert rubric["learner_visibility"]["hide_answers_until_submission"] is True
