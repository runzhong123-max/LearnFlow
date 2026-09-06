"""Validated dynamic practice artifacts.

The learning-design agent may propose candidates, but this module owns the
deterministic boundary before they become formal ConceptQuestion objects.
Generated artifacts are uncalibrated and never count as learner evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import ConceptQuestion


SUPPORTED_ITEM_TYPES = {
    "single", "multi", "judge", "ordered_blocks", "exact_text", "numeric",
    "code_output", "trace_table",
}
SUPPORTED_PURPOSES = {"practice", "diagnostic", "transfer"}
SUPPORTED_DIFFICULTIES = {"easy", "medium", "hard"}


@dataclass(frozen=True)
class PracticeValidation:
    valid: bool
    errors: tuple[str, ...]
    warnings: tuple[str, ...]
    quality: dict[str, Any]


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _normalized(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _fingerprint(candidate: dict[str, Any]) -> str:
    stable = {
        "question": _normalized(candidate.get("question")),
        "options": [_normalized(item) for item in candidate.get("options", [])],
        "q_type": candidate.get("q_type"),
        "target": _normalized(candidate.get("target_skill")),
    }
    return hashlib.sha256(json.dumps(stable, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def validate_practice_candidate(candidate: dict[str, Any]) -> PracticeValidation:
    errors: list[str] = []
    warnings: list[str] = []
    question = _clean_text(candidate.get("question"), 4000)
    q_type = str(candidate.get("q_type") or "single")
    difficulty = str(candidate.get("difficulty") or "medium")
    purpose = str(candidate.get("purpose") or "practice")
    options = [_clean_text(item, 1200) for item in candidate.get("options", []) if _clean_text(item, 1200)]
    answer_indexes = candidate.get("answer_indexes") if isinstance(candidate.get("answer_indexes"), list) else []
    expected_response = candidate.get("expected_response")
    target_skill = _clean_text(candidate.get("target_skill"), 240)
    explanation = _clean_text(candidate.get("explanation"), 6000)

    if len(question) < 8:
        errors.append("题干过短，无法形成可检查任务")
    if q_type not in SUPPORTED_ITEM_TYPES:
        errors.append(f"不支持的题型：{q_type}")
    if difficulty not in SUPPORTED_DIFFICULTIES:
        errors.append("难度必须为 easy / medium / hard")
    if purpose not in SUPPORTED_PURPOSES:
        errors.append("用途必须为 practice / diagnostic / transfer")
    if not target_skill:
        errors.append("缺少 target_skill，无法说明题目测什么")
    if not explanation:
        warnings.append("缺少答案解释；题目可提交，但纠错质量会降低")

    selection_types = {"single", "multi", "judge", "ordered_blocks"}
    if q_type in selection_types:
        if len(options) < 2:
            errors.append("选择或排序题至少需要两个候选项")
        if len(set(map(_normalized, options))) != len(options):
            errors.append("候选项存在重复")
        if not answer_indexes:
            errors.append("缺少确定性答案索引")
        elif any(not isinstance(index, int) or index < 0 or index >= len(options) for index in answer_indexes):
            errors.append("答案索引越界")
        if q_type == "single" and len(answer_indexes) != 1:
            errors.append("单选题必须且只能有一个答案")
        if q_type == "judge" and len(options) != 2:
            errors.append("判断题必须有两个选项")
        if q_type == "ordered_blocks" and sorted(answer_indexes) != list(range(len(options))):
            errors.append("排序题答案必须是所有候选块的一个完整排列")
    elif q_type in {"exact_text", "numeric", "trace_table"} and expected_response in (None, "", []):
        errors.append("该题型缺少 expected_response")
    if q_type == "numeric":
        try:
            expected = float(expected_response)
            if not math.isfinite(expected):
                raise ValueError
        except (TypeError, ValueError):
            errors.append("数值题 expected_response 必须是有限数值")
    if q_type == "code_output" and expected_response in (None, ""):
        errors.append("代码输出题缺少已验证输出")

    quality = {
        "schema_valid": not errors,
        "construct_declared": bool(target_skill),
        "answer_deterministic": bool(answer_indexes or expected_response not in (None, "", [])),
        "explanation_available": bool(explanation),
        "psychometric_status": "uncalibrated",
        "mastery_inference": False,
        "fingerprint": _fingerprint(candidate),
    }
    return PracticeValidation(not errors, tuple(errors), tuple(warnings), quality)


def normalized_candidate(
    candidate: dict[str, Any], *, practice_set_id: str, family_id: str,
    assessment_blueprint_id: int | None = None, rubric_id: int | None = None,
) -> dict[str, Any]:
    validation = validate_practice_candidate(candidate)
    if not validation.valid:
        raise ValueError("；".join(validation.errors))
    q_type = str(candidate.get("q_type") or "single")
    meta = {
        "schema_version": "dynamic-practice-item.v1",
        "practice_set_id": practice_set_id,
        "family_id": family_id,
        "assessment_blueprint_id": assessment_blueprint_id,
        "rubric_id": rubric_id,
        "purpose": str(candidate.get("purpose") or "practice"),
        "target_skill": _clean_text(candidate.get("target_skill"), 240),
        "concept_key": _clean_text(candidate.get("concept_key"), 160),
        "response_schema": q_type,
        "expected_response": candidate.get("expected_response"),
        "numeric_tolerance": max(0.0, float(candidate.get("numeric_tolerance") or 0.0)),
        "quality": validation.quality,
        "quality_warnings": list(validation.warnings),
        "generation": {
            "generator": _clean_text(candidate.get("generator") or "learning_design_agent", 80),
            "source_refs": list(candidate.get("source_refs") or [])[:20],
            "radical_features": list(candidate.get("radical_features") or [])[:12],
            "incidental_features": list(candidate.get("incidental_features") or [])[:12],
        },
        "evidence_contract": {
            "generated_or_opened": "zero_target",
            "formal_submission": "knowledge_and_practice",
            "structure": "only_confirmed_relation_or_blockage",
            "human": "only_explicit_feedback_or_reproducible_support_pattern",
        },
    }
    return {
        "question": _clean_text(candidate.get("question"), 4000),
        "options": [_clean_text(item, 1200) for item in candidate.get("options", []) if _clean_text(item, 1200)],
        "answer_indexes": [int(item) for item in candidate.get("answer_indexes", [])],
        "q_type": q_type,
        "difficulty": str(candidate.get("difficulty") or "medium"),
        "explanation": _clean_text(candidate.get("explanation"), 6000),
        "code": str(candidate.get("code") or "")[:20_000],
        "expected_output": _clean_text(candidate.get("expected_response"), 20_000) if q_type == "code_output" else "",
        "assessment_meta": meta,
    }


async def create_practice_set(
    db: AsyncSession,
    *,
    checkpoint_id: int,
    practice_set_id: str,
    title: str,
    candidates: list[dict[str, Any]],
    assessment_blueprint_id: int | None = None,
    rubric_id: int | None = None,
) -> list[ConceptQuestion]:
    existing = list((await db.execute(select(ConceptQuestion).where(
        ConceptQuestion.checkpoint_id == checkpoint_id,
    ).order_by(ConceptQuestion.order, ConceptQuestion.id))).scalars().all())
    for question in existing:
        if (question.assessment_meta or {}).get("practice_set_id") == practice_set_id:
            return [item for item in existing if (item.assessment_meta or {}).get("practice_set_id") == practice_set_id]
    existing_fingerprints = {
        (item.assessment_meta or {}).get("quality", {}).get("fingerprint")
        for item in existing
    }
    start_order = max((item.order for item in existing), default=0) + 1
    created: list[ConceptQuestion] = []
    for index, candidate in enumerate(candidates[:12]):
        family_id = _clean_text(candidate.get("family_id") or f"{practice_set_id}:{index + 1}", 160)
        normalized = normalized_candidate(
            candidate,
            practice_set_id=practice_set_id,
            family_id=family_id,
            assessment_blueprint_id=assessment_blueprint_id,
            rubric_id=rubric_id,
        )
        fingerprint = normalized["assessment_meta"]["quality"]["fingerprint"]
        if fingerprint in existing_fingerprints:
            continue
        normalized["assessment_meta"]["practice_title"] = _clean_text(title, 255)
        question = ConceptQuestion(checkpoint_id=checkpoint_id, order=start_order + index, **normalized)
        db.add(question)
        created.append(question)
        existing_fingerprints.add(fingerprint)
    if not created:
        raise ValueError("候选题全部重复或无效，没有创建练习文件")
    await db.flush()
    return created


def grade_structured_response(question: ConceptQuestion, data: dict[str, Any]) -> tuple[bool, dict[str, Any], dict[str, Any]]:
    q_type = question.q_type or "single"
    meta = dict(question.assessment_meta or {})
    if q_type == "ordered_blocks":
        expected = [int(item) for item in (question.answer_indexes or [])]
        submitted = [int(item) for item in (data.get("answer_indexes") or [])]
        return submitted == expected, {"answer_indexes": submitted}, {"answer_indexes": expected}
    if q_type in {"single", "multi", "judge"}:
        expected = sorted(int(item) for item in (question.answer_indexes or []))
        submitted = sorted(int(item) for item in (data.get("answer_indexes") or []))
        return bool(submitted) and submitted == expected, {"answer_indexes": submitted}, {"answer_indexes": expected}
    expected = meta.get("expected_response")
    if q_type == "code_output" and expected in (None, ""):
        expected = question.expected_output
    submitted = data.get("response")
    if q_type == "numeric":
        try:
            actual = float(submitted)
            target = float(expected)
            tolerance = max(0.0, float(meta.get("numeric_tolerance") or 0.0))
            correct = math.isclose(actual, target, rel_tol=0.0, abs_tol=tolerance)
        except (TypeError, ValueError):
            correct = False
        return correct, {"response": submitted}, {"response": expected, "tolerance": meta.get("numeric_tolerance", 0)}
    if q_type == "trace_table":
        normalize_table = lambda value: [[_normalized(cell) for cell in row] for row in value] if isinstance(value, list) else []
        return normalize_table(submitted) == normalize_table(expected), {"response": submitted}, {"response": expected}
    return _normalized(submitted) == _normalized(expected), {"response": submitted}, {"response": expected}
