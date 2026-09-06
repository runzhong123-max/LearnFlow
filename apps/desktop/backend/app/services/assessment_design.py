"""First-class assessment blueprint and rubric contracts.

Learning Design may propose these objects, but this service validates scope and
shape deterministically.  Blueprints constrain generated artifacts; they never
grade a learner or mutate five-kernel state.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AssessmentBlueprint, AssessmentRubric, LearningTask
from app.models.project import Checkpoint, Project, Roadmap
from app.services.dynamic_practice import (
    SUPPORTED_DIFFICULTIES,
    SUPPORTED_ITEM_TYPES,
    SUPPORTED_PURPOSES,
)
from app.services.learning_runtime import record_event


BLUEPRINT_SCHEMA_VERSION = "assessment-blueprint.v1"
RUBRIC_SCHEMA_VERSION = "assessment-rubric.v1"


def _text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


async def owned_task_scope(
    db: AsyncSession, learner_id: int, learning_task_id: int,
) -> tuple[LearningTask, Checkpoint, Project]:
    row = (await db.execute(
        select(LearningTask, Checkpoint, Project)
        .join(Checkpoint, Checkpoint.id == LearningTask.checkpoint_id)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            LearningTask.id == learning_task_id,
            LearningTask.learner_id == learner_id,
            Project.learner_id == learner_id,
            Project.visibility != "deleted",
        )
    )).first()
    if not row:
        raise ValueError("learning_task_scope_not_found")
    task, checkpoint, project = row
    if task.project_id and task.project_id != project.id:
        raise ValueError("learning_task_project_scope_mismatch")
    return task, checkpoint, project


def normalize_blueprint_input(data: dict[str, Any]) -> dict[str, Any]:
    purpose = str(data.get("purpose") or "practice")
    if purpose not in SUPPORTED_PURPOSES:
        raise ValueError("unsupported_assessment_purpose")

    raw_targets = data.get("target_subjects") or []
    targets = []
    for index, raw in enumerate(raw_targets[:8]):
        item = raw if isinstance(raw, dict) else {"name": raw}
        name = _text(item.get("name") or item.get("target_skill"), 240)
        if not name:
            continue
        key = _text(item.get("concept_key") or item.get("subject_key"), 160)
        targets.append({
            "id": _text(item.get("id") or key or f"target-{index + 1}", 160),
            "name": name,
            "concept_key": key,
            "observable_outcome": _text(
                item.get("observable_outcome") or f"能够在新题中独立完成：{name}", 500,
            ),
        })
    if not targets:
        concept = _text(data.get("concept") or data.get("title"), 240)
        if not concept:
            raise ValueError("assessment_target_required")
        targets = [{
            "id": "target-1", "name": concept, "concept_key": _text(data.get("concept_key"), 160),
            "observable_outcome": f"能够在新题中独立完成：{concept}",
        }]

    raw_mix = data.get("item_mix") or []
    if not raw_mix:
        raw_types = data.get("item_types") or ["single", "exact_text"]
        total = max(1, min(12, int(data.get("count") or len(raw_types) or 1)))
        raw_mix = [
            {"q_type": raw_types[index % len(raw_types)], "count": 1}
            for index in range(total)
        ]
    counts: dict[str, int] = {}
    for raw in raw_mix[:12]:
        item = raw if isinstance(raw, dict) else {"q_type": raw, "count": 1}
        q_type = str(item.get("q_type") or "")
        if q_type not in SUPPORTED_ITEM_TYPES:
            raise ValueError(f"unsupported_item_type:{q_type}")
        counts[q_type] = counts.get(q_type, 0) + max(1, min(12, int(item.get("count") or 1)))
    if not counts or sum(counts.values()) > 12:
        raise ValueError("assessment_item_count_out_of_range")
    item_mix = [{"q_type": key, "count": value} for key, value in sorted(counts.items())]

    raw_difficulty = data.get("difficulty_distribution") or {
        str(data.get("difficulty") or "medium"): 1.0,
    }
    difficulty = {
        key: max(0.0, float(value))
        for key, value in dict(raw_difficulty).items()
        if key in SUPPORTED_DIFFICULTIES and float(value) > 0
    }
    if not difficulty:
        raise ValueError("difficulty_distribution_required")
    total_weight = sum(difficulty.values())
    difficulty = {key: round(value / total_weight, 4) for key, value in sorted(difficulty.items())}

    minimum_items = min(sum(counts.values()), max(1, int(data.get("minimum_independent_items") or 2)))
    success_policy = {
        "minimum_score": max(0.5, min(1.0, float(data.get("minimum_score") or 0.8))),
        "minimum_independent_items": minimum_items,
        "transfer_required": purpose == "transfer",
        "assisted_success_is_independent": False,
        "single_success_is_stable_mastery": False,
    }
    return {
        "purpose": purpose,
        "target_subjects": targets,
        "item_mix": item_mix,
        "difficulty_distribution": difficulty,
        "success_policy": success_policy,
        "source_refs": list(data.get("source_refs") or [])[:20],
    }


def default_rubric(blueprint: dict[str, Any]) -> dict[str, Any]:
    target_names = "、".join(item["name"] for item in blueprint["target_subjects"][:3])
    return {
        "criteria": [
            {"id": "construct_accuracy", "name": "目标能力正确性", "weight": 0.55, "description": f"是否正确完成 {target_names}"},
            {"id": "reasoning_trace", "name": "推理或执行轨迹", "weight": 0.30, "description": "关键中间关系、状态或步骤是否可检查"},
            {"id": "independence", "name": "独立完成条件", "weight": 0.15, "description": "是否在无提示条件下完成"},
        ],
        "performance_levels": [
            {"id": "meets", "minimum": 0.8, "label": "达到本轮验证条件"},
            {"id": "developing", "minimum": 0.5, "label": "部分达到，需要纠错或再练"},
            {"id": "not_yet", "minimum": 0.0, "label": "尚未达到"},
        ],
        "scoring_policy": {
            "owner": "practice_agent",
            "method": "deterministic_item_grading_then_weighted_rubric_projection",
            "llm_may_score": False,
            "weights_total": 1.0,
        },
        "evidence_contract": {
            "blueprint_or_item_generation": "zero_target",
            "formal_submission": ["knowledge", "practice"],
            "structure": "only_confirmed_relation_or_reproducible_blockage",
            "human": "only_explicit_feedback_or_reproducible_support_pattern",
            "stable_mastery": "requires_repeated_verified_and_spaced_or_transfer_evidence",
        },
        "learner_visibility": {
            "show_targets_before_attempt": True,
            "show_scoring_rules_before_attempt": True,
            "hide_answers_until_submission": True,
        },
    }


def validate_rubric(candidate: dict[str, Any]) -> dict[str, Any]:
    criteria = [item for item in (candidate.get("criteria") or []) if isinstance(item, dict)]
    ids = [_text(item.get("id"), 80) for item in criteria]
    weights = [float(item.get("weight") or 0.0) for item in criteria]
    if not criteria or any(not item for item in ids) or len(ids) != len(set(ids)):
        raise ValueError("rubric_criteria_invalid")
    if any(weight <= 0 for weight in weights) or abs(sum(weights) - 1.0) > 0.001:
        raise ValueError("rubric_weights_must_sum_to_one")
    scoring = dict(candidate.get("scoring_policy") or {})
    if scoring.get("llm_may_score") is not False:
        raise ValueError("llm_grading_is_forbidden")
    return candidate


def normalize_rubric(
    blueprint: dict[str, Any], supplied: Any = None,
) -> dict[str, Any]:
    """Apply a bounded override without allowing required contracts to disappear."""
    candidate = default_rubric(blueprint)
    if isinstance(supplied, dict):
        for key in (
            "criteria", "performance_levels", "scoring_policy",
            "evidence_contract", "learner_visibility",
        ):
            if key in supplied:
                candidate[key] = supplied[key]
    return validate_rubric(candidate)


async def create_assessment_blueprint(
    db: AsyncSession,
    *,
    learner_id: int,
    learning_task_id: int,
    title: str,
    client_request_id: str,
    data: dict[str, Any],
    source: str = "assessment_blueprint_builder",
) -> tuple[AssessmentBlueprint, AssessmentRubric, bool]:
    task, checkpoint, project = await owned_task_scope(db, learner_id, learning_task_id)
    request_key = _text(client_request_id, 160)
    if not request_key:
        raise ValueError("client_request_id_required")
    existing = (await db.execute(select(AssessmentBlueprint).where(
        AssessmentBlueprint.learner_id == learner_id,
        AssessmentBlueprint.client_request_id == request_key,
    ))).scalar_one_or_none()
    if existing:
        rubric = (await db.execute(select(AssessmentRubric).where(
            AssessmentRubric.blueprint_id == existing.id,
            AssessmentRubric.version == existing.version,
        ))).scalar_one()
        return existing, rubric, False

    normalized = normalize_blueprint_input(data)
    blueprint = AssessmentBlueprint(
        learner_id=learner_id,
        learning_task_id=task.id,
        project_id=project.id,
        checkpoint_id=checkpoint.id,
        title=_text(title or f"{task.title} · 评估蓝图", 255),
        purpose=normalized["purpose"],
        target_subjects=normalized["target_subjects"],
        item_mix=normalized["item_mix"],
        difficulty_distribution=normalized["difficulty_distribution"],
        success_policy=normalized["success_policy"],
        source_refs=normalized["source_refs"],
        status="draft",
        schema_version=BLUEPRINT_SCHEMA_VERSION,
        client_request_id=request_key,
    )
    db.add(blueprint)
    await db.flush()
    rubric_data = normalize_rubric(normalized, data.get("rubric"))
    rubric = AssessmentRubric(
        blueprint_id=blueprint.id,
        title=f"{blueprint.title} · 评分量表"[:255],
        criteria=rubric_data["criteria"],
        performance_levels=rubric_data["performance_levels"],
        scoring_policy=rubric_data["scoring_policy"],
        evidence_contract=rubric_data["evidence_contract"],
        learner_visibility=rubric_data["learner_visibility"],
        status="draft",
        schema_version=RUBRIC_SCHEMA_VERSION,
        version=blueprint.version,
    )
    db.add(rubric)
    await db.flush()
    await record_event(
        db,
        learner_id=learner_id,
        session_id=task.session_id,
        project_id=project.id,
        checkpoint_id=checkpoint.id,
        event_type="assessment_blueprint_proposed",
        source=source,
        payload={
            "assessment_blueprint_id": blueprint.id,
            "rubric_id": rubric.id,
            "learning_task_id": task.id,
            "purpose": blueprint.purpose,
            "item_count": sum(item["count"] for item in blueprint.item_mix),
            "mastery_unchanged": True,
        },
        provenance={"tool": "assessment_blueprint_builder", "schema_version": BLUEPRINT_SCHEMA_VERSION},
        client_event_id=f"assessment-blueprint:{learner_id}:{request_key}",
    )
    return blueprint, rubric, True


def assessment_blueprint_view(blueprint: AssessmentBlueprint, rubric: AssessmentRubric) -> dict[str, Any]:
    return {
        "id": blueprint.id,
        "schema_version": blueprint.schema_version,
        "version": blueprint.version,
        "learning_task_id": blueprint.learning_task_id,
        "project_id": blueprint.project_id,
        "checkpoint_id": blueprint.checkpoint_id,
        "title": blueprint.title,
        "purpose": blueprint.purpose,
        "target_subjects": list(blueprint.target_subjects or []),
        "item_mix": list(blueprint.item_mix or []),
        "difficulty_distribution": dict(blueprint.difficulty_distribution or {}),
        "success_policy": dict(blueprint.success_policy or {}),
        "source_refs": list(blueprint.source_refs or []),
        "status": blueprint.status,
        "rubric": {
            "id": rubric.id,
            "schema_version": rubric.schema_version,
            "version": rubric.version,
            "criteria": list(rubric.criteria or []),
            "performance_levels": list(rubric.performance_levels or []),
            "scoring_policy": dict(rubric.scoring_policy or {}),
            "evidence_contract": dict(rubric.evidence_contract or {}),
            "learner_visibility": dict(rubric.learner_visibility or {}),
        },
        "mastery_inference": False,
    }


async def validate_candidates_against_blueprint(
    db: AsyncSession,
    *,
    learner_id: int,
    learning_task_id: int,
    blueprint_id: int,
    candidates: list[dict[str, Any]],
) -> tuple[AssessmentBlueprint, AssessmentRubric]:
    blueprint = (await db.execute(select(AssessmentBlueprint).where(
        AssessmentBlueprint.id == blueprint_id,
        AssessmentBlueprint.learner_id == learner_id,
        AssessmentBlueprint.learning_task_id == learning_task_id,
    ))).scalar_one_or_none()
    if not blueprint:
        raise ValueError("assessment_blueprint_scope_mismatch")
    rubric = (await db.execute(select(AssessmentRubric).where(
        AssessmentRubric.blueprint_id == blueprint.id,
        AssessmentRubric.version == blueprint.version,
    ))).scalar_one()
    allowed_types = {item["q_type"] for item in (blueprint.item_mix or [])}
    allowed_difficulties = {
        key for key, value in dict(blueprint.difficulty_distribution or {}).items() if value > 0
    }
    maximum = sum(int(item["count"]) for item in (blueprint.item_mix or []))
    if not candidates or len(candidates) > maximum:
        raise ValueError("candidate_count_exceeds_blueprint")
    for candidate in candidates:
        if candidate.get("q_type") not in allowed_types:
            raise ValueError("candidate_item_type_outside_blueprint")
        if candidate.get("difficulty") not in allowed_difficulties:
            raise ValueError("candidate_difficulty_outside_blueprint")
        if str(candidate.get("purpose") or "practice") != blueprint.purpose:
            raise ValueError("candidate_purpose_outside_blueprint")
    return blueprint, rubric
