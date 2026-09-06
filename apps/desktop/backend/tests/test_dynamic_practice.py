from app.models.project import ConceptQuestion
from app.services.dynamic_practice import (
    grade_structured_response,
    normalized_candidate,
    validate_practice_candidate,
)


def _candidate(**overrides):
    candidate = {
        "question": "下面哪一种数据结构最适合实现先进先出队列？",
        "q_type": "single",
        "difficulty": "easy",
        "purpose": "diagnostic",
        "target_skill": "识别队列的 FIFO 语义",
        "concept_key": "queue",
        "options": ["栈", "队列", "哈希表", "二叉搜索树"],
        "answer_indexes": [1],
        "explanation": "队列按先进先出顺序取出元素。",
    }
    candidate.update(overrides)
    return candidate


def test_dynamic_item_validation_declares_evidence_boundary_and_fingerprint():
    report = validate_practice_candidate(_candidate())
    assert report.valid
    assert report.quality["psychometric_status"] == "uncalibrated"
    assert report.quality["mastery_inference"] is False
    assert len(report.quality["fingerprint"]) == 64

    normalized = normalized_candidate(
        _candidate(), practice_set_id="ps-test", family_id="queue-family",
        assessment_blueprint_id=31, rubric_id=47,
    )
    meta = normalized["assessment_meta"]
    assert meta["assessment_blueprint_id"] == 31
    assert meta["rubric_id"] == 47
    assert meta["practice_set_id"] == "ps-test"
    assert meta["evidence_contract"]["formal_submission"] == "knowledge_and_practice"
    assert meta["evidence_contract"]["human"].startswith("only_explicit_feedback")


def test_dynamic_item_validation_rejects_ambiguous_or_incomplete_items():
    duplicate = validate_practice_candidate(_candidate(options=["队列", " 队列 "]))
    assert not duplicate.valid
    assert "候选项存在重复" in duplicate.errors

    missing_target = validate_practice_candidate(_candidate(target_skill=""))
    assert not missing_target.valid
    assert "缺少 target_skill，无法说明题目测什么" in missing_target.errors

    bad_order = validate_practice_candidate(_candidate(
        q_type="ordered_blocks", options=["A", "B", "C"], answer_indexes=[0, 2],
    ))
    assert not bad_order.valid


def test_structured_grader_handles_selection_order_numeric_and_trace_table():
    selection = ConceptQuestion(q_type="multi", answer_indexes=[0, 2], assessment_meta={})
    assert grade_structured_response(selection, {"answer_indexes": [2, 0]})[0]
    assert not grade_structured_response(selection, {"answer_indexes": [0]})[0]

    ordered = ConceptQuestion(q_type="ordered_blocks", answer_indexes=[2, 0, 1], assessment_meta={})
    assert grade_structured_response(ordered, {"answer_indexes": [2, 0, 1]})[0]
    assert not grade_structured_response(ordered, {"answer_indexes": [0, 2, 1]})[0]

    numeric = ConceptQuestion(
        q_type="numeric", answer_indexes=[],
        assessment_meta={"expected_response": 3.14, "numeric_tolerance": 0.01},
    )
    assert grade_structured_response(numeric, {"response": "3.145"})[0]
    assert not grade_structured_response(numeric, {"response": "3.2"})[0]

    trace = ConceptQuestion(
        q_type="trace_table", answer_indexes=[],
        assessment_meta={"expected_response": [["i", "sum"], ["1", "1"]]},
    )
    assert grade_structured_response(trace, {"response": [[" I ", "SUM"], ["1", "1"]]})[0]
