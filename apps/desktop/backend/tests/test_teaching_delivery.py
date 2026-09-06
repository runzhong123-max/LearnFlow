from app.services.delivery_readiness import (
    project_delivery_readiness,
    project_package_readiness,
    project_task_readiness,
)
from app.services.teaching_contract import (
    build_fallback_section,
    ensure_teaching_sections,
    knowledge_design_input_from_context,
    normalize_teaching_contract,
)


def test_teaching_contract_normalizes_legacy_fields_and_blocks_without_domain_packet():
    contract = normalize_teaching_contract(
        {"exit_criteria": ["能解释生成器暂停与恢复"]},
        objective="理解 Python generator",
    )
    assert contract["objective"] == "理解 Python generator"
    assert contract["outcomes"] == ["能解释生成器暂停与恢复"]
    assert contract["exit_criteria"] == contract["outcomes"]
    assert contract["teaching_gate"]["status"] == "blocked_knowledge"
    assert contract["teaching_gate"]["max_model_revisions"] == 1
    knowledge = contract["knowledge_input_contract"]
    assert knowledge["mode"] == "required_for_formal_publish"
    assert knowledge["context_policy"] == "learning_design"
    assert knowledge["missing_behavior"] == "blocked_knowledge_without_published_artifact"
    assert knowledge["writes_kernels"] == []
    assert knowledge["mastery_inference"] is False


def test_teaching_contract_hard_error_returns_non_publishable_gap_notice():
    contract = normalize_teaching_contract({
        "objective": "理解闭包",
        "outcomes": ["能解释自由变量"],
        "answer_leakage": True,
    })
    assert contract["teaching_gate"]["status"] == "blocked_knowledge"
    section = build_fallback_section(contract, checkpoint_title="闭包")
    assert section["delivery_state"] == "blocked_knowledge"
    assert section["publishable"] is False
    assert section["mastery_inference"] is False
    assert "学习目标" in section["content"]
    assert "当前缺口" in section["content"]
    gated = ensure_teaching_sections([{"title": "unsafe", "content": "看似有效"}], contract=contract, checkpoint_title="闭包")
    assert gated == []


def test_knowledge_design_input_requires_answer_free_packet_and_stays_bounded():
    rejected = knowledge_design_input_from_context({
        "manifest": {"answer_free": False},
        "kernel_heads": {"knowledge": {"summary": "不应进入教学设计"}},
    })
    assert rejected["status"] == "unavailable"

    accepted = knowledge_design_input_from_context({
        "snapshot_id": "snapshot-1",
        "manifest": {"answer_free": True},
        "kernel_heads": {"knowledge": {
            "summary": "理解变量作用域，但闭包捕获仍待验证",
            "facets": {"knowledge_gap": ["闭包捕获"], "private_answer": "拒绝"},
        }},
        "items": [
            {"kernel": "knowledge", "memory_kind": "gap", "text": f"缺口 {index}"}
            for index in range(8)
        ],
    })
    assert accepted["status"] == "available"
    assert accepted["snapshot_id"] == "snapshot-1"
    assert accepted["facets"] == {"knowledge_gap": ["闭包捕获"]}
    assert len(accepted["observations"]) == 6
    assert accepted["mastery_inference"] is False


def test_delivery_readiness_is_monotonic_object_projection_not_learning_status():
    outline = project_delivery_readiness({})
    assert outline["overall"] == "outline_only"
    assert outline["mastery_inference"] is False

    content = project_delivery_readiness({
        "published_lecture_sections": 2,
        "learning_task_count": 1,
    })
    assert content["overall"] == "guided_learning_ready"

    practice = project_delivery_readiness({
        "published_lecture_sections": 2,
        "learning_task_count": 1,
        "concept_question_count": 2,
        "deterministic_answer_count": 2,
    })
    assert practice["overall"] == "practice_ready"

    verified = project_delivery_readiness({
        "processed_source_chunks": 4,
        "published_lecture_sections": 2,
        "learning_task_count": 1,
        "concept_question_count": 2,
        "deterministic_answer_count": 2,
        "active_blueprint_count": 1,
        "active_rubric_count": 1,
    })
    assert verified["overall"] == "verification_ready"
    assert verified["gaps"] == []


def test_package_readiness_is_independent_from_atomic_task_binding():
    snapshot = {
        "published_lecture_sections": 2,
        "concept_question_count": 2,
        "deterministic_answer_count": 2,
        "active_blueprint_count": 1,
        "active_rubric_count": 1,
    }
    package = project_package_readiness(snapshot)
    task = project_task_readiness(snapshot, package)

    assert package["overall"] == "verification_ready"
    assert package["fallback_allowed"] is True
    assert task["overall"] == "unbound"
    assert task["can_start_or_resume"] is False
    assert task["operational_completion_is_mastery"] is False


def test_atomic_task_can_start_with_minimum_fallback_and_gains_phases_from_package():
    fallback = project_delivery_readiness({
        "learning_task_count": 1,
        "learning_task_status": "queued",
    })
    assert fallback["package_readiness"]["overall"] == "outline_only"
    assert fallback["task_readiness"]["overall"] == "runnable_with_fallback"
    assert fallback["task_readiness"]["available_phases"] == ["learn"]
    assert fallback["task_readiness"]["fallback"] == "minimum_teaching_fallback"

    practice = project_delivery_readiness({
        "learning_task_count": 1,
        "learning_task_status": "active",
        "published_lecture_sections": 1,
        "exercise_count": 1,
        "deterministic_answer_count": 1,
    })
    assert practice["package_readiness"]["overall"] == "practice_ready"
    assert practice["task_readiness"]["overall"] == "practice_ready"
    assert practice["task_readiness"]["available_phases"] == ["learn", "practice"]


def test_task_acceptance_and_completion_remain_operational_not_mastery():
    package = project_package_readiness({"published_lecture_sections": 1})
    proposed = project_task_readiness({"learning_task_status": "proposed"}, package)
    completed = project_task_readiness({"learning_task_status": "completed"}, package)

    assert proposed["overall"] == "awaiting_acceptance"
    assert proposed["can_start_or_resume"] is False
    assert completed["overall"] == "completed"
    assert completed["operational_completion_is_mastery"] is False
