"""Evidence ledger and deterministic five-kernel runtime.

The ledger is the source of truth. Kernel rows are materialized projections
that can always be rebuilt from evidence.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable
import json
import re

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    AgentSession, Learner, EvidenceEvent, LearningAttempt, KernelState,
    KernelMutation, MemoryArchive,
)
from app.models.project import Project, Roadmap, Checkpoint, Lecture
from app.services.architecture_registry import (
    KERNEL_NAMES,
    SEMANTIC_MEMORY_KEYS,
    normalize_event_provenance,
)


LOCAL_LEARNER_KEY = "local-default"

PUBLIC_EVENT_TYPES = {
    "project_selected", "checkpoint_entered", "lecture_viewed",
    "hint_requested", "code_review_requested", "learning_feedback",
}

# Machine-readable implementation contract for the deterministic reducer.
# Keep this set beside the reducer implementation (never generate it from the
# architecture registry): the registry may declare candidate events, while
# this set states which event names the runtime actually handles today.
REDUCER_EVENT_TYPES = frozenset({
    "vnext_teaching_input_received",
    "semantic_observation_proposed",
    "vnext_human_adaptation_requested",
    "memory_correction_confirmed", "memory_correction_added", "memory_correction_retracted",
    "vnext_value_claim_proposal_accepted",
    "vnext_learning_path_plan_committed", "vnext_learning_path_plan_revised",
    "vnext_learning_path_plan_archived", "vnext_learning_path_node_status_set",
    "vnext_planning_profile_self_reported",
    "vnext_personal_path_node_added", "vnext_personal_path_node_removed",
    "learning_action_segment_completed", "micro_learning_started",
    "registration_profile_completed", "learner_concept_statement_recorded",
    "learner_concept_observation_recorded", "learner_concept_relation_recorded",
    "career_goal_confirmed", "profile_updated",
    "project_proposal_created", "project_proposal_revised",
    "project_proposal_user_edited", "project_proposal_reopened",
    "project_proposal_dismissed", "project_proposal_accepted",
    "project_created", "project_selected", "project_imported", "project_completed",
    "roadmap_discussed", "roadmap_applied", "roadmap_revised",
    "source_added", "source_processing", "source_processed", "source_failed",
    "checkpoint_entered", "lecture_generated", "lecture_viewed",
    "micro_learning_card_viewed", "teach_back_analyzed", "user_message",
    "hint_requested", "code_review_requested", "explanation_requested",
    "remediation_started", "remediation_mode_rejected",
    "remediation_explanation_requested", "remediation_retry_evaluated",
    "remediation_variant_evaluated", "remediation_completed",
    "review_reflection_recorded", "review_attempt_evaluated",
    "concept_attempt_evaluated", "exercise_attempt_evaluated",
    "transfer_attempt_evaluated", "tool_failed", "task_failed",
})


async def get_default_learner(db: AsyncSession) -> Learner:
    learner = (await db.execute(
        select(Learner).where(Learner.key == LOCAL_LEARNER_KEY)
    )).scalar_one_or_none()
    if learner:
        return learner
    learner = Learner(key=LOCAL_LEARNER_KEY, display_name="本地学习者")
    db.add(learner)
    await db.flush()
    await ensure_kernel_states(db, learner.id)
    return learner


async def ensure_kernel_states(db: AsyncSession, learner_id: int):
    existing = set((await db.execute(
        select(KernelState.kernel_name).where(KernelState.learner_id == learner_id)
    )).scalars().all())
    for name in KERNEL_NAMES:
        if name not in existing:
            db.add(KernelState(
                learner_id=learner_id,
                kernel_name=name,
                short_term={}, long_term={}, action_chain=[], evidence_refs=[],
                confidence=0.0, version=1,
            ))
    await db.flush()


def context_id(project_id: int | None, checkpoint_id: int | None, session_id: int | None = None) -> str:
    parts = []
    if project_id is not None:
        parts.append(f"project:{project_id}")
    if checkpoint_id is not None:
        parts.append(f"checkpoint:{checkpoint_id}")
    if session_id is not None:
        parts.append(f"session:{session_id}")
    return "/".join(parts) or "global"


async def record_event(
    db: AsyncSession,
    *,
    learner_id: int | None = None,
    event_type: str,
    source: str,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    session_id: int | None = None,
    payload: dict | None = None,
    confidence: float = 1.0,
    provenance: dict | None = None,
    client_event_id: str | None = None,
    artifact_refs: list | None = None,
    occurred_at: datetime | None = None,
    actor_type: str | None = None,
) -> EvidenceEvent:
    if learner_id is None:
        learner_id = (await get_default_learner(db)).id
    await ensure_kernel_states(db, learner_id)

    owned_project_id: int | None = None
    if project_id is not None:
        owner = (await db.execute(select(Project.id).where(
            Project.id == project_id, Project.learner_id == learner_id,
        ))).scalar_one_or_none()
        if not owner:
            raise ValueError("项目不属于当前学习者")
        owned_project_id = int(owner)
    checkpoint_project_id: int | None = None
    if checkpoint_id is not None:
        owned_checkpoint = (await db.execute(
            select(Checkpoint.id, Roadmap.project_id)
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .join(Project, Project.id == Roadmap.project_id)
            .where(
                Checkpoint.id == checkpoint_id,
                Project.learner_id == learner_id,
            )
        )).one_or_none()
        if not owned_checkpoint:
            raise ValueError("检查点不属于当前学习者")
        checkpoint_project_id = int(owned_checkpoint.project_id)
        if owned_project_id is not None and checkpoint_project_id != owned_project_id:
            raise ValueError("检查点不属于所声明的项目")
    if session_id is not None:
        owned_session = (await db.execute(select(AgentSession).where(
            AgentSession.id == session_id,
            AgentSession.learner_id == learner_id,
        ))).scalar_one_or_none()
        if not owned_session:
            raise ValueError("Tutor 会话不属于当前学习者")
        # A global Tutor session is deliberately allowed to reference any
        # project owned by the same learner while planning or handing off. A
        # project Tutor may reference checkpoints inside its own project. Only
        # bound project/checkpoint sessions require exact scope equality.
        if (
            project_id is not None
            and owned_session.session_type in {"project", "checkpoint"}
            and owned_session.project_id != project_id
        ):
            raise ValueError("Tutor 会话不属于所声明的项目")
        if (
            checkpoint_id is not None
            and owned_session.session_type == "checkpoint"
            and owned_session.checkpoint_id != checkpoint_id
        ):
            raise ValueError("Tutor 会话不属于所声明的检查点")
        if (
            owned_session.checkpoint_id is not None
            and owned_session.project_id is not None
            and checkpoint_project_id is not None
            and checkpoint_project_id != owned_session.project_id
        ):
            raise ValueError("Tutor 会话的项目与检查点关系无效")

    if client_event_id:
        scoped_event_id = f"{learner_id}:{client_event_id}"
        existing = (await db.execute(
            select(EvidenceEvent).where(
                EvidenceEvent.learner_id == learner_id,
                EvidenceEvent.client_event_id.in_([scoped_event_id, client_event_id]),
            )
        )).scalar_one_or_none()
        if existing:
            return existing
        client_event_id = scoped_event_id

    from app.services.memory_graph import actor_type_for_source, next_learner_sequence

    recorded_at = datetime.utcnow()
    event = EvidenceEvent(
        learner_id=learner_id,
        project_id=project_id,
        checkpoint_id=checkpoint_id,
        session_id=session_id,
        event_type=event_type,
        source=source,
        context_id=context_id(project_id, checkpoint_id, session_id),
        payload=payload or {},
        artifact_refs=artifact_refs or [],
        confidence=max(0.0, min(float(confidence), 1.0)),
        provenance=normalize_event_provenance(event_type, source, provenance),
        client_event_id=client_event_id,
        occurred_at=occurred_at or recorded_at,
        learner_seq=await next_learner_sequence(db, learner_id),
        actor_type=actor_type or actor_type_for_source(source),
        created_at=recorded_at,
    )
    db.add(event)
    await db.flush()
    await _reduce_event(db, event)
    return event


async def _kernel(db: AsyncSession, learner_id: int, name: str) -> KernelState:
    state = (await db.execute(
        select(KernelState).where(
            KernelState.learner_id == learner_id,
            KernelState.kernel_name == name,
        )
    )).scalar_one()
    return state


async def _apply_patch(
    db: AsyncSession,
    event: EvidenceEvent,
    kernel_name: str,
    short_patch: dict,
    reason: str,
    *,
    long_patch: dict | None = None,
):
    state = await _kernel(db, event.learner_id, kernel_name)
    before = state.version or 1
    short_term = dict(state.short_term or {})
    short_term.update(short_patch)
    long_term = dict(state.long_term or {})
    if long_patch:
        long_term.update(long_patch)
    chain = list(state.action_chain or [])
    chain.append({
        "event_id": event.id,
        "type": event.event_type,
        "at": event.created_at.isoformat() if event.created_at else datetime.utcnow().isoformat(),
    })
    refs = list(state.evidence_refs or [])
    refs.append(event.id)
    state.short_term = short_term
    state.long_term = long_term
    state.action_chain = chain[-20:]
    state.evidence_refs = refs[-100:]
    state.confidence = round(min(1.0, max(state.confidence or 0.0, event.confidence or 0.0)), 3)
    state.version = before + 1
    state.updated_at = datetime.utcnow()
    mutation = KernelMutation(
        learner_id=event.learner_id,
        event_id=event.id,
        kernel_name=kernel_name,
        mutation_type="long_term" if long_patch else "short_term",
        status="applied",
        patch={"short_term": short_patch, "long_term": long_patch or {}},
        reason=reason,
        before_version=before,
        after_version=state.version,
    )
    db.add(mutation)
    await db.flush()

    from app.services.memory_graph import create_facts_for_mutation
    await create_facts_for_mutation(db, event, mutation)
    from app.services.five_kernel_context import refresh_kernel_head
    await refresh_kernel_head(db, event.learner_id, kernel_name)


async def _reduce_event(db: AsyncSession, event: EvidenceEvent):
    p = dict(event.payload or {})
    et = event.event_type
    # Hidden controls and reference-only inputs are ledger records, not learner evidence.
    # Exit before consuming one-turn guidance or updating any other kernel reducer.
    if et == "user_message" and p.get("direct_user_input") is False:
        return

    # Immediate guidance is a deterministic kernel projection. It does not wait
    # for (or acquire the authority of) background Module/Claim synthesis.
    from app.services.teaching_guidance import GUIDANCE_EVENT_TYPES, reduce_teaching_guidance
    if et in GUIDANCE_EVENT_TYPES:
        rows = (await db.execute(select(KernelState).where(
            KernelState.learner_id == event.learner_id,
        ))).scalars().all()
        states = {row.kernel_name: {"short_term": dict(row.short_term or {}),
                                   "long_term": dict(row.long_term or {})} for row in rows}
        for kernel_name, patch in reduce_teaching_guidance(event, states).items():
            await _apply_patch(db, event, kernel_name, patch.get("short_term", {}),
                "依据当前证据即时调整教学；适用范围与期限独立于长期掌握门槛",
                long_patch=patch.get("long_term") or None)
    if et == "vnext_teaching_input_received":
        return

    if et == "semantic_observation_proposed":
        kernel_name = p.get("kernel")
        candidate = p.get("candidate")
        if kernel_name in KERNEL_NAMES and isinstance(candidate, dict):
            await _apply_patch(db, event, kernel_name, {"semantic_candidate": {
                "fields": candidate, "source_event_id": p.get("source_event_id"),
                "verification": "inferred", "mastery_inference": False,
                "scope": event.context_id,
            }}, "模型观察仅保留为待核对候选，不覆盖已确认背景、偏好或能力")
        return

    if et == "vnext_human_adaptation_requested":
        signal_kind = str(p.get("signal_kind") or "").strip()
        value = str(p.get("value") or "").strip()[:80]
        strength = max(0.0, min(float(p.get("strength") or 0.7), 1.0))
        valid_kinds = {
            "pace_adjustment", "format_request", "cognitive_load",
            "frustration", "support_need",
        }
        if signal_kind not in valid_kinds or not bool(p.get("explicit", True)):
            return
        expires_at = ((event.occurred_at or event.created_at or datetime.utcnow()) + timedelta(hours=8)).isoformat()
        patch: dict[str, Any] = {
            "transient_expires_at": expires_at,
            "adaptation_source": "explicit_current_context",
            "adaptation_scope": {
                "project_id": event.project_id,
                "checkpoint_id": event.checkpoint_id,
                "session_id": event.session_id,
            },
        }
        if signal_kind == "pace_adjustment" and value in {"slower", "faster"}:
            patch["pace_adjustment"] = value
            patch["support_need"] = "reduce_pacing" if value == "slower" else "increase_pacing"
        elif signal_kind == "format_request" and value in {
            "visual", "example", "code", "steps", "concise", "alternative",
        }:
            patch["format_request"] = value
            if value == "alternative":
                patch["support_need"] = "switch_explanation_mode"
        elif signal_kind == "cognitive_load":
            patch["cognitive_load"] = max(0.6, strength)
            patch["support_need"] = value or "reduce_chunk_size"
        elif signal_kind == "frustration":
            patch["affect"] = "frustrated"
            patch["frustration"] = max(0.6, strength)
            patch["support_need"] = value or "acknowledge_and_reduce_scope"
        elif signal_kind == "support_need" and value:
            patch["support_need"] = value
        else:
            return
        await _apply_patch(
            db, event, "human", patch,
            "学习者明确表达了当前教学适配需求；该指令限时有效，不形成性格、诊断或固定学习风格结论",
        )
        return

    if et in {
        "memory_correction_confirmed",
        "memory_correction_added",
        "memory_correction_retracted",
    }:
        kernel_name = p.get("kernel_name")
        if kernel_name in KERNEL_NAMES:
            state = await _kernel(db, event.learner_id, kernel_name)
            cleared = {}
            long_cleared = {}
            if p.get("action") in {"correct", "retract"}:
                keys = {str(key) for key in p.get("affected_keys", [])}
                cleared = {key: None for key in keys if key in (state.short_term or {})}
                long_cleared = {key: None for key in keys if key in (state.long_term or {})}
                preferences = dict((state.long_term or {}).get("learning_preferences") or {})
                if keys & set(preferences):
                    long_cleared["learning_preferences"] = {
                        key: value for key, value in preferences.items() if key not in keys
                    }
            await _apply_patch(
                db, event, kernel_name,
                {**cleared, "memory_feedback": {
                    "claim_id": p.get("claim_id"),
                    "action": p.get("action"),
                    "correction": p.get("correction", ""),
                    "affected_keys": p.get("affected_keys", []),
                }},
                "学习者对可检查记忆声明提交了追加式反馈",
                long_patch=long_cleared,
            )
        return

    if et == "vnext_value_claim_proposal_accepted":
        proposal_id = str(p.get("proposal_id") or f"event:{event.id}")[:160]
        statement = str(p.get("proposed_claim") or p.get("goal") or "").strip()[:1000]
        if not statement:
            return
        state = await _kernel(db, event.learner_id, "value")
        confirmed_goals = dict((state.long_term or {}).get("confirmed_goals") or {})
        confirmed_goals[proposal_id] = {
            "statement": statement,
            "evidence_quote": str(p.get("evidence_quote") or "")[:500],
            "scope": str(p.get("scope") or "long_term_direction_candidate")[:80],
            "status": "confirmed",
            "evidence_id": event.id,
        }
        await _apply_patch(
            db, event, "value",
            {
                "current_priority": statement,
                "goal_candidate": statement,
                "goal_status": "confirmed",
            },
            "学习者在规划态检查旧内容、建议与原话依据后确认了价值声明",
            long_patch={"confirmed_goals": confirmed_goals},
        )
        return

    if et in {"vnext_learning_path_plan_committed", "vnext_learning_path_plan_revised"}:
        plan_id = str(p.get("plan_id") or "").strip()[:160]
        objective = str(p.get("objective") or "").strip()[:1000]
        target_ids = list(dict.fromkeys(
            str(item).strip()[:160] for item in list(p.get("target_node_ids") or [])
            if str(item).strip()
        ))[:8]
        route_ids = list(dict.fromkeys(
            str(item).strip()[:160] for item in list(p.get("route_node_ids") or [])
            if str(item).strip()
        ))[:40]
        milestone_ids = list(dict.fromkeys(
            str(item).strip()[:160] for item in list(p.get("milestone_node_ids") or [])
            if str(item).strip()
        ))[:16]
        if not plan_id or not objective or not target_ids or any(item not in route_ids for item in target_ids):
            return
        structure = await _kernel(db, event.learner_id, "structure")
        plans = dict((structure.long_term or {}).get("learning_path_plans") or {})
        previous = dict(plans.get(plan_id) or {})
        plan = {
            "id": plan_id,
            "title": str(p.get("title") or objective)[:200],
            "objective": objective,
            "horizon": str(p.get("horizon") or "长期")[:120],
            "target_node_ids": target_ids,
            "route_node_ids": route_ids,
            "milestone_node_ids": milestone_ids,
            "rationale": str(p.get("rationale") or "")[:1600],
            "evidence_quote": str(p.get("evidence_quote") or "")[:500],
            "source_plan_id": str(p.get("source_plan_id") or "")[:160],
            "status": "active",
            "revision": max(int(previous.get("revision") or 0) + 1, int(p.get("revision") or 1)),
            "evidence_id": event.id,
        }
        plans[plan_id] = plan
        await _apply_patch(
            db, event, "structure",
            {
                "active_learning_path_plan": plan,
                "path_position": {
                    "level": "long_term_learning_path",
                    "plan_id": plan_id,
                    "target_node_ids": target_ids,
                    "milestone_node_ids": milestone_ids,
                },
                "resume_anchor": {
                    "plan_id": plan_id,
                    "node_id": milestone_ids[0] if milestone_ids else route_ids[0],
                    "note": f"返回长期学习路径「{plan['title']}」继续",
                },
            },
            "学习者确认了可检查、可修订的长期学习路径；路线是导航结构而不是掌握结论",
            long_patch={
                "learning_path_plans": plans,
                "active_learning_path_plan_id": plan_id,
            },
        )

        value = await _kernel(db, event.learner_id, "value")
        confirmed_goals = dict((value.long_term or {}).get("confirmed_goals") or {})
        confirmed_goals[f"path-plan:{plan_id}"] = {
            "statement": objective,
            "evidence_quote": plan["evidence_quote"],
            "scope": "long_term_learning_path",
            "status": "confirmed",
            "route_plan_id": plan_id,
            "evidence_id": event.id,
        }
        await _apply_patch(
            db, event, "value",
            {
                "current_priority": objective,
                "goal_candidate": objective,
                "goal_status": "confirmed",
                "active_learning_path_plan_id": plan_id,
            },
            "学习者确认长期路线时同步确认其目标；路线本身仍由 Structure 负责",
            long_patch={"confirmed_goals": confirmed_goals},
        )
        return

    if et == "vnext_learning_path_plan_archived":
        plan_id = str(p.get("plan_id") or "").strip()[:160]
        if not plan_id:
            return
        structure = await _kernel(db, event.learner_id, "structure")
        plans = dict((structure.long_term or {}).get("learning_path_plans") or {})
        plan = dict(plans.get(plan_id) or {})
        if plan:
            plan.update({"status": "archived", "archived_by_event_id": event.id})
            plans[plan_id] = plan
        long_patch: dict[str, Any] = {"learning_path_plans": plans}
        short_patch: dict[str, Any] = {"learning_path_last_edit": plan_id}
        if (structure.long_term or {}).get("active_learning_path_plan_id") == plan_id:
            long_patch["active_learning_path_plan_id"] = None
            short_patch["active_learning_path_plan"] = None
        await _apply_patch(
            db, event, "structure", short_patch,
            "学习者归档当前长期学习路径；历史路线与确认事件继续保留",
            long_patch=long_patch,
        )

        value = await _kernel(db, event.learner_id, "value")
        confirmed_goals = dict((value.long_term or {}).get("confirmed_goals") or {})
        goal_key = f"path-plan:{plan_id}"
        if goal_key in confirmed_goals:
            archived_goal = dict(confirmed_goals[goal_key])
            archived_goal.update({"status": "archived", "archived_by_event_id": event.id})
            confirmed_goals[goal_key] = archived_goal
        await _apply_patch(
            db, event, "value",
            {"goal_status": "archived", "active_learning_path_plan_id": None},
            "归档路线同步结束当前目标优先级，但不删除历史目标",
            long_patch={"confirmed_goals": confirmed_goals},
        )
        return

    if et == "vnext_learning_path_node_status_set":
        node_id = str(p.get("node_id") or "").strip()[:160]
        status = str(p.get("status") or "unmarked")
        if not node_id or status not in {
            "unmarked", "exploring", "self_reported_exposed", "self_reported_mastered",
        }:
            return
        structure = await _kernel(db, event.learner_id, "structure")
        statuses = dict((structure.long_term or {}).get("learning_path_statuses") or {})
        if status == "unmarked":
            statuses.pop(node_id, None)
        else:
            statuses[node_id] = {
                "status": status,
                "title": str(p.get("node_title") or node_id)[:200],
                "self_reported": True,
                "evidence_id": event.id,
            }
        short_patch: dict[str, Any] = {"learning_path_last_edit": node_id}
        if status == "exploring":
            short_patch["path_position"] = {
                "level": "learning_path_node",
                "node_id": node_id,
                "title": str(p.get("node_title") or node_id)[:200],
                "status": status,
            }
            short_patch["resume_anchor"] = {
                "node_id": node_id,
                "note": f"返回学习路径中的「{str(p.get('node_title') or node_id)[:120]}」",
            }
        await _apply_patch(
            db, event, "structure", short_patch,
            "学习者明确设置课程图节点状态；该状态只用于路径导航",
            long_patch={"learning_path_statuses": statuses},
        )

        knowledge = await _kernel(db, event.learner_id, "knowledge")
        exposure = dict((knowledge.short_term or {}).get("declared_course_exposure") or {})
        if status in {"self_reported_exposed", "self_reported_mastered"}:
            exposure[node_id] = {
                "status": status,
                "title": str(p.get("node_title") or node_id)[:200],
                "self_reported_only": True,
                "mastery_unchanged": True,
                "evidence_id": event.id,
            }
        else:
            exposure.pop(node_id, None)
        await _apply_patch(
            db, event, "knowledge",
            {"declared_course_exposure": exposure, "mastery_unchanged": True},
            "课程图标记只形成自报接触背景，不形成知识掌握",
        )
        return

    if et == "vnext_personal_path_node_added":
        node = dict(p.get("node") or {})
        node_id = str(node.get("id") or p.get("node_id") or "").strip()[:160]
        title = str(node.get("title") or p.get("node_title") or "").strip()[:200]
        if not node_id or not title:
            return
        structure = await _kernel(db, event.learner_id, "structure")
        nodes = dict((structure.long_term or {}).get("personal_learning_path_nodes") or {})
        nodes[node_id] = {
            "id": node_id,
            "title": title,
            "summary": str(node.get("summary") or "")[:1000],
            "aliases": list(node.get("aliases") or [])[:8],
            "domains": list(node.get("domains") or [])[:8],
            "stage": str(node.get("stage") or "advanced")[:40],
            "order": int(node.get("order") or 6),
            "source_refs": list(node.get("sourceRefs") or node.get("source_refs") or [])[:8],
            "edges": list(p.get("edges") or [])[:12],
            "status": "active",
            "evidence_id": event.id,
        }
        await _apply_patch(
            db, event, "structure",
            {"learning_path_last_edit": node_id, "goal_candidate_node": node_id},
            "学习者确认把图谱外的真实学习目标加入个人课程图",
            long_patch={"personal_learning_path_nodes": nodes},
        )
        await _apply_patch(
            db, event, "value",
            {
                "interest_signal": title,
                "goal_candidate": title,
                "relevance_reason": str(p.get("reason") or "学习者主动加入个人路径节点")[:500],
            },
            "个人路径节点是明确兴趣候选，但不是固定长期方向",
        )
        return

    if et == "vnext_personal_path_node_removed":
        node_id = str(p.get("node_id") or "").strip()[:160]
        if not node_id:
            return
        structure = await _kernel(db, event.learner_id, "structure")
        nodes = dict((structure.long_term or {}).get("personal_learning_path_nodes") or {})
        removed = dict(nodes.get(node_id) or {})
        title = str(removed.get("title") or p.get("node_title") or node_id)[:200]
        if node_id in nodes:
            removed.update({"status": "removed", "removed_by_event_id": event.id})
            nodes[node_id] = removed
        statuses = dict((structure.long_term or {}).get("learning_path_statuses") or {})
        statuses.pop(node_id, None)
        await _apply_patch(
            db, event, "structure",
            {"learning_path_last_edit": node_id},
            "学习者从当前个人课程图撤下节点；历史事件继续保留",
            long_patch={
                "personal_learning_path_nodes": nodes,
                "learning_path_statuses": statuses,
            },
        )
        await _apply_patch(
            db, event, "value",
            {"interest_signal": {"title": title, "status": "removed"}},
            "撤下个人路径节点只结束当前兴趣候选，不改写历史动机",
        )
        return

    if et == "vnext_planning_profile_self_reported":
        report = dict(p.get("self_report") or {})
        if report.get("version") != "planning-profile-self-report.v1":
            return

        def observations(key: str) -> list[dict[str, Any]]:
            normalized: list[dict[str, Any]] = []
            for item in list(report.get(key) or [])[:12]:
                if not isinstance(item, dict):
                    continue
                subject = str(item.get("subject") or "").strip()[:160]
                statement = str(item.get("statement") or "").strip()[:500]
                if subject and statement:
                    normalized.append({"subject": subject, "statement": statement})
            return normalized

        education_stage = str(report.get("education_stage") or "").strip()[:80]
        planning_goal = str(p.get("planning_goal") or report.get("goal_candidate") or "").strip()[:200]
        goal_candidate = str(report.get("goal_candidate") or planning_goal).strip()[:200]
        evidence_quote = str(report.get("evidence_quote") or "").strip()[:2000]
        knowledge_exposures = observations("knowledge_exposures")
        knowledge_gaps = observations("knowledge_gaps")
        practice_exposures = observations("practice_exposures")
        weekly = dict(report.get("weekly_hours") or {})
        weekly_min = weekly.get("min")
        weekly_max = weekly.get("max")
        if not isinstance(weekly_min, int) or not isinstance(weekly_max, int):
            weekly_min = weekly_max = None
        elif not (0 <= weekly_min <= weekly_max <= 168):
            weekly_min = weekly_max = None
        current_load = str(report.get("current_load") or "")
        if current_load not in {"manageable", "constrained"}:
            current_load = ""

        if education_stage or planning_goal:
            position = {
                "education_stage": education_stage,
                "planning_goal": planning_goal,
                "self_reported": True,
                "evidence_quote": evidence_quote[:500],
                "evidence_id": event.id,
            }
            structure_patch: dict[str, Any] = {"planning_position": position}
            if planning_goal:
                structure_patch["current_task"] = f"规划：{planning_goal}"[:240]
            await _apply_patch(
                db, event, "structure", structure_patch,
                "规划对话只把明确自述投影为当前位置与规划锚点，不把整段原文冒充学习任务",
            )

        if knowledge_exposures or knowledge_gaps:
            await _apply_patch(
                db, event, "knowledge",
                {
                    "declared_planning_background": {
                        "exposures": knowledge_exposures,
                        "gaps": knowledge_gaps,
                        "self_report_only": True,
                        "mastery_unchanged": True,
                        "evidence_id": event.id,
                    },
                    "mastery_unchanged": True,
                },
                "规划中的课程与技能自述只形成未验证背景，不升级为掌握证据",
            )

        if weekly_min is not None or current_load:
            expires_at = ((event.occurred_at or event.created_at or datetime.utcnow()) + timedelta(hours=8)).isoformat()
            availability = {
                "weekly_hours": (
                    {"min": weekly_min, "max": weekly_max}
                    if weekly_min is not None else None
                ),
                "current_load": current_load or None,
                "self_reported": True,
                "scope": "current_planning_dialogue",
                "evidence_id": event.id,
            }
            await _apply_patch(
                db, event, "human", {
                    "planning_availability": availability,
                    "transient_expires_at": expires_at,
                    "adaptation_source": "explicit_current_context",
                    "adaptation_scope": {
                        "project_id": event.project_id,
                        "checkpoint_id": event.checkpoint_id,
                        "session_id": event.session_id,
                    },
                },
                "规划中的明确时间投入与当前负荷只作为有界适配依据",
            )

        if goal_candidate:
            await _apply_patch(
                db, event, "value",
                {
                    "goal_candidate": goal_candidate,
                    "goal_status": "exploring",
                    "current_priority": goal_candidate,
                    "goal_evidence_quote": evidence_quote[:500],
                },
                "规划目标先作为可检查候选；未经学习者确认不巩固为长期价值声明",
            )

        if practice_exposures:
            await _apply_patch(
                db, event, "practice",
                {
                    "self_reported_experience": {
                        "items": practice_exposures,
                        "verified": False,
                        "attempt_evidence": False,
                        "mastery_unchanged": True,
                        "evidence_id": event.id,
                    },
                    "mastery_unchanged": True,
                },
                "规划中的项目与工具经历只记录为自述接触，不冒充正式 Attempt 或迁移证据",
            )
        return

    if et == "learning_action_segment_completed":
        goal = str(p.get("goal") or "").strip()[:500]
        goal_kind = str(p.get("goal_kind") or "").strip()
        if not goal_kind and p.get("mode") == "learn":
            goal_kind = "learning_task"
        projectable_goal = goal if goal_kind in {"learning_task", "planning_goal"} else ""
        action = {
            "segment_id": p.get("segment_id"),
            "mode": p.get("mode"),
            "goal": projectable_goal,
            "goal_kind": goal_kind,
            "outcome": p.get("outcome", ""),
            "learning_task_id": p.get("learning_task_id"),
            "project_proposal_id": p.get("project_proposal_id"),
            "entry_message_id": p.get("entry_message_id"),
            "exit_message_id": p.get("exit_message_id"),
            "skills": list(p.get("skills") or []),
            "evidence_id": event.id,
        }
        structure_patch: dict[str, Any] = {"last_learning_action": action}
        if projectable_goal:
            structure_patch["current_task"] = projectable_goal
        if p.get("learning_task_id") or event.checkpoint_id:
            structure_patch["resume_anchor"] = {
                "session_id": event.session_id,
                "project_id": event.project_id,
                "checkpoint_id": event.checkpoint_id,
                "learning_task_id": p.get("learning_task_id"),
                "note": "返回原对话或关卡继续同一个学习任务",
            }
        await _apply_patch(
            db, event, "structure", structure_patch,
            "把一次自由态到学习形态再返回的过程投影为可恢复学习动作",
        )
        if p.get("content_exposure"):
            await _apply_patch(
                db, event, "knowledge",
                {
                    "last_explanation": projectable_goal,
                    "exposure_only": True,
                    "last_learning_action_id": p.get("segment_id"),
                    "mastery_unchanged": True,
                },
                "对话讲解或任务引导只形成内容接触证据，不代表掌握",
            )
        if projectable_goal and p.get("mode") in {"learn", "plan"}:
            await _apply_patch(
                db, event, "value",
                {
                    "current_priority": projectable_goal,
                    "current_motivation": "explicit_learning_action",
                },
                "学习动作保留本轮明确目标，不自动巩固为长期价值声明",
            )
        return

    if et == "micro_learning_started":
        await _apply_patch(
            db, event, "structure",
            {
                "focused_learning_run_id": p.get("run_id"),
                "active_project_id": event.project_id,
                "active_checkpoint_id": event.checkpoint_id,
                "current_task": p.get("goal", "快速学习"),
            },
            "学习者显式开始一次可恢复的微学习流程",
        )
        await _apply_patch(
            db, event, "value",
            {
                "current_priority": p.get("goal", ""),
                "current_motivation": "explicit_micro_learning_goal",
            },
            "学习者明确提交了本次微学习目标",
        )
        return

    if et == "registration_profile_completed":
        await _apply_patch(
            db, event, "knowledge",
            {"declared_background": p.get("background", ""), "self_report_only": True},
            "注册资料记录学习起点，不构成掌握证据",
        )
        await _apply_patch(
            db, event, "human",
            {"weekly_hours": p.get("weekly_hours"), "preferred_modes": p.get("preferred_modes", [])},
            "用户明确填写了稳定的学习节奏与形式偏好",
            long_patch={"learning_preferences": {
                "weekly_hours": p.get("weekly_hours"),
                "preferred_modes": p.get("preferred_modes", []),
            }},
        )
        value_long = {"focus_areas": p.get("focus_areas", [])}
        if p.get("career_goal") and p.get("career_goal_status") == "confirmed":
            value_long["career_goal"] = p.get("career_goal")
        await _apply_patch(
            db, event, "value",
            {"focus_areas": p.get("focus_areas", []),
             "career_goal_candidate": p.get("career_goal", "")},
            "注册资料记录关注方向与职业目标自述",
            long_patch=value_long,
        )
        return

    if et == "learner_concept_statement_recorded":
        # Raw learner text is retained in the immutable evidence ledger.  The
        # reviewed child events below own the actual kernel projections.
        return

    if et == "learner_concept_observation_recorded":
        concept_key = str(p.get("concept_key") or "").strip()[:160]
        if not concept_key:
            return
        observation = {
            "concept_key": concept_key,
            "name": str(p.get("concept_name") or concept_key)[:160],
            "observation_type": str(p.get("observation_type") or "self_reported_exposure")[:80],
            "statement": str(p.get("statement") or "")[:1000],
            "verification": str(p.get("verification") or "unverified")[:40],
            "source_tag": str(p.get("source_tag") or "user_self_input")[:60],
            "question_ref": dict(p.get("question_ref") or {}),
            "mastery_inference": False,
        }
        await _apply_patch(
            db, event, "knowledge",
            {"concept_observation": observation},
            "记录概念节点内部的认识历程；自述与接触不升级为掌握结论",
        )
        return

    if et == "learner_concept_relation_recorded":
        relation_type = str(p.get("relation_type") or "").strip()[:80]
        source_anchor = dict(p.get("source_anchor") or {})
        target_anchor = dict(p.get("target_anchor") or {})
        if not relation_type or not source_anchor.get("concept_key") or not target_anchor.get("concept_key"):
            return
        relation = {
            "source": source_anchor,
            "target": target_anchor,
            "relation_type": relation_type,
            "rationale": str(p.get("rationale") or "")[:500],
            "verification": str(p.get("verification") or "unverified")[:40],
            "source_tag": str(p.get("source_tag") or "user_self_input")[:60],
            "mastery_inference": False,
        }
        await _apply_patch(
            db, event, "structure",
            {"concept_relation": relation},
            "记录概念之间的学习关系；关系事实不替知识核判断任一概念是否掌握",
        )
        return

    if et == "career_goal_confirmed":
        await _apply_patch(
            db, event, "value",
            {"career_goal_candidate": p.get("career_goal", ""), "career_goal_status": "confirmed"},
            "高置信度职业理想事件进入长期价值记忆",
            long_patch={"career_goal": p.get("career_goal", "")},
        )
        return

    if et == "profile_updated":
        if "background" in p:
            await _apply_patch(
                db, event, "knowledge",
                {"declared_background": p.get("background", ""), "self_report_only": True},
                "用户更新了自述基础，不构成掌握证据",
            )
        if "weekly_hours" in p or "preferred_modes" in p:
            state = await _kernel(db, event.learner_id, "human")
            preferences = dict((state.long_term or {}).get("learning_preferences") or {})
            preferences.update({key: p[key] for key in ("weekly_hours", "preferred_modes") if key in p})
            await _apply_patch(
                db, event, "human", {key: p[key] for key in ("weekly_hours", "preferred_modes") if key in p},
                "用户更新了学习节奏与形式偏好",
                long_patch={"learning_preferences": preferences},
            )
        if "career_goal" in p or "career_goal_status" in p:
            status = p.get("career_goal_status", "exploring")
            goal = str(p.get("career_goal") or "")
            await _apply_patch(db, event, "value", {
                "career_goal_candidate": goal, "career_goal_status": status,
                "goal_status": status, "current_priority": goal,
            }, "目标修订与确认状态同步更新；探索状态不保留已确认长期目标",
                long_patch={"career_goal": goal if status == "confirmed" else ""})
        if "focus_areas" in p:
            await _apply_patch(
                db, event, "value", {"focus_areas": p.get("focus_areas", [])},
                "用户更新了关注方向",
                long_patch={"focus_areas": p.get("focus_areas", [])},
            )
        return

    if et in {
        "project_proposal_created", "project_proposal_revised",
        "project_proposal_user_edited", "project_proposal_reopened",
        "project_proposal_dismissed",
    }:
        proposal_id = p.get("proposal_id")
        status = "dismissed" if et == "project_proposal_dismissed" else "active"
        await _apply_patch(
            db, event, "structure",
            {"active_proposal_id": proposal_id, "proposal_status": status},
            "项目提案只更新候选结构，不直接创建长期项目",
        )
        if p.get("learning_goal"):
            await _apply_patch(
                db, event, "value",
                {"goal_candidate": p.get("learning_goal"),
                 "proposal_id": proposal_id, "goal_status": status},
                "长期目标在用户接受前保持为候选",
            )
        if p.get("practice_goal"):
            await _apply_patch(
                db, event, "practice",
                {"artifact_candidate": p.get("practice_goal"), "proposal_id": proposal_id},
                "记录项目实践产物候选",
            )
        if p.get("learner_start"):
            await _apply_patch(
                db, event, "knowledge",
                {"declared_starting_point": p.get("learner_start")},
                "用户基础作为提案适配信息，不作为掌握证明",
            )
        if p.get("estimated_effort"):
            await _apply_patch(
                db, event, "human",
                {"proposal_pace": p.get("estimated_effort")},
                "提案节奏用于短期教学适配",
            )
        return

    if et == "project_proposal_accepted":
        project_id = event.project_id or p.get("project_id")
        proposal_id = p.get("proposal_id")
        await _apply_patch(
            db,
            event,
            "structure",
            {
                "active_proposal_id": proposal_id,
                "proposal_status": "accepted",
                "active_project_id": project_id,
            },
            "学习者明确接受项目提案；只确认学习结构，不推断掌握",
        )
        if p.get("learning_goal"):
            await _apply_patch(
                db,
                event,
                "value",
                {
                    "current_priority": p.get("learning_goal"),
                    "confirmed_goal": p.get("learning_goal"),
                    "goal_status": "accepted",
                    "proposal_id": proposal_id,
                },
                "学习者明确接受项目目标，目标由候选转为已确认",
            )
        return

    if et in {"project_created", "project_selected", "project_imported"}:
        project_id = event.project_id or p.get("project_id")
        project = (await db.execute(select(Project).where(
            Project.id == project_id,
            Project.learner_id == event.learner_id,
        ))).scalar_one_or_none() if project_id else None
        long_patch = None
        if et in {"project_created", "project_imported"} and project_id:
            state = await _kernel(db, event.learner_id, "structure")
            graph = dict((state.long_term or {}).get("project_graph") or {})
            graph[str(project_id)] = {
                "name": p.get("name", ""),
                "description": p.get("description", ""),
            }
            long_patch = {"project_graph": graph}
        await _apply_patch(
            db, event, "structure",
            {"active_project_id": project_id, "active_checkpoint_id": None,
             "current_task": "进入学习项目",
             "path_position": {
                 "project_id": project_id,
                 "project_name": project.name if project else p.get("name", ""),
                 "level": "project",
             }},
            "项目上下文发生变化", long_patch=long_patch,
        )
        learning_goal = p.get("learning_goal") or p.get("goal")
        if et == "project_created" and learning_goal:
            await _apply_patch(
                db, event, "value",
                {"current_priority": learning_goal,
                 "goal_candidate": learning_goal,
                 "relevance_reason": p.get("expected_outcome", "")},
                "学习者明确创建项目，目标进入价值核；不推断掌握",
            )
        return

    if et == "project_completed":
        project_id = event.project_id or p.get("project_id")
        project_name = str(p.get("name") or "")
        checkpoint_count = int(p.get("checkpoint_count") or 0)

        structure_state = await _kernel(db, event.learner_id, "structure")
        project_graph = dict((structure_state.long_term or {}).get("project_graph") or {})
        project_entry = dict(project_graph.get(str(project_id)) or {})
        project_entry.update({
            "name": project_name or project_entry.get("name", ""),
            "status": "completed",
            "checkpoint_count": checkpoint_count,
        })
        project_graph[str(project_id)] = project_entry
        await _apply_patch(
            db,
            event,
            "structure",
            {
                "active_project_id": project_id,
                "current_task": "项目复盘与迁移",
                "project_status": "completed",
            },
            "全部非归档关卡已完成，项目结构进入完成态",
            long_patch={"project_graph": project_graph},
        )

        await _apply_patch(
            db,
            event,
            "value",
            {
                "completed_project_id": project_id,
                "completed_project_name": project_name,
                "goal_status": "completed",
            },
            "学习者完成已选择的项目目标；不据此推断后续职业取向",
        )

        practice_state = await _kernel(db, event.learner_id, "practice")
        completed_projects = dict((practice_state.long_term or {}).get("completed_projects") or {})
        completed_projects[str(project_id)] = {
            "name": project_name,
            "checkpoint_count": checkpoint_count,
            "source_event_id": event.id,
        }
        await _apply_patch(
            db,
            event,
            "practice",
            {
                "last_completed_project_id": project_id,
                "last_project_checkpoint_count": checkpoint_count,
            },
            "项目全部关卡已完成，记录实践历程；产物质量与迁移能力仍需独立证据",
            long_patch={"completed_projects": completed_projects},
        )
        return

    if et == "roadmap_discussed":
        await _apply_patch(
            db, event, "structure",
            {"active_project_id": event.project_id,
             "current_task": "协商项目关卡路线",
             "roadmap_proposal": p.get("checkpoints", []),
             "proposal_status": "unconfirmed"},
            "路线仍是候选方案，不创建掌握或长期结构结论",
        )
        return

    if et in {"roadmap_applied", "roadmap_revised"}:
        project_id = event.project_id or p.get("project_id")
        state = await _kernel(db, event.learner_id, "structure")
        routes = dict((state.long_term or {}).get("project_roadmaps") or {})
        routes[str(project_id)] = {
            "roadmap_id": p.get("roadmap_id"),
            "project_theme": p.get("project_theme", ""),
            "checkpoints": p.get("checkpoints", []),
            "revision": p.get("revision", 1),
            "status": "active",
        }
        checkpoints = list(p.get("checkpoints") or [])
        current_checkpoint_id = (state.short_term or {}).get("active_checkpoint_id")
        active = next((item for item in checkpoints if item.get("id") == current_checkpoint_id), None)
        anchor = active or (checkpoints[0] if checkpoints else {})
        await _apply_patch(
            db, event, "structure",
            {"active_project_id": project_id,
             "active_checkpoint_id": anchor.get("id"),
             "current_task": anchor.get("title", "项目路线待继续规划"),
             "resume_anchor": {"project_id": project_id,
                               "checkpoint_id": anchor.get("id"),
                               "checkpoint_title": anchor.get("title", "")},
             "proposal_status": "revised" if et == "roadmap_revised" else "applied"},
            "学习者确认项目路线或修订，写入结构核；路线本身不证明知识掌握",
            long_patch={"project_roadmaps": routes},
        )
        return

    if et in {"source_added", "source_processing", "source_processed", "source_failed"}:
        patch = {
            "active_project_id": event.project_id,
            "current_task": "处理学习来源",
            "current_blocker": p.get("error", "") if et == "source_failed" else "",
        }
        await _apply_patch(db, event, "structure", patch, "学习来源状态更新")
        await _apply_patch(
            db, event, "practice",
            {"artifact_state": et, "recent_feedback": p.get("status", et)},
            "来源形成可执行学习材料",
        )
        return

    if et == "checkpoint_entered":
        checkpoint = (await db.execute(
            select(Checkpoint)
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .join(Project, Project.id == Roadmap.project_id)
            .where(
                Checkpoint.id == event.checkpoint_id,
                Project.learner_id == event.learner_id,
            )
        )).scalar_one_or_none()
        roadmap = await db.get(Roadmap, checkpoint.roadmap_id) if checkpoint else None
        project = await db.get(Project, roadmap.project_id) if roadmap else None
        structure = await _kernel(db, event.learner_id, "structure")
        previous_checkpoint_id = (structure.short_term or {}).get("active_checkpoint_id")
        previous_checkpoint = None
        if previous_checkpoint_id and previous_checkpoint_id != event.checkpoint_id:
            previous_checkpoint = (await db.execute(
                select(Checkpoint)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .join(Project, Project.id == Roadmap.project_id)
                .where(
                    Checkpoint.id == previous_checkpoint_id,
                    Project.learner_id == event.learner_id,
                )
            )).scalar_one_or_none()
        prerequisite_ids = list((checkpoint.prerequisites or []) if checkpoint else [])
        prerequisite_rows = []
        if prerequisite_ids:
            prerequisite_rows = (await db.execute(
                select(Checkpoint)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .join(Project, Project.id == Roadmap.project_id)
                .where(
                    Checkpoint.id.in_(prerequisite_ids),
                    Project.learner_id == event.learner_id,
                )
            )).scalars().all()
        prerequisite_map = {item.id: item for item in prerequisite_rows}
        title = checkpoint.title if checkpoint else p.get("title", "当前检查点")
        path_position = {
            "project_id": event.project_id,
            "project_name": project.name if project else "",
            "checkpoint_id": event.checkpoint_id,
            "checkpoint_title": title,
            "checkpoint_order": checkpoint.order if checkpoint else None,
            "level": "checkpoint",
        }
        patch = {
            "active_project_id": event.project_id,
            "active_checkpoint_id": event.checkpoint_id,
            "current_task": title,
            "path_position": path_position,
            "resume_anchor": {
                "checkpoint_id": event.checkpoint_id,
                "checkpoint_title": title,
                "note": f"返回时从「{title}」继续",
            },
        }
        if prerequisite_ids:
            patch["path_dependencies"] = [
                {
                    "checkpoint_id": checkpoint_id,
                    "title": prerequisite_map.get(checkpoint_id).title
                    if prerequisite_map.get(checkpoint_id) else f"检查点 {checkpoint_id}",
                }
                for checkpoint_id in prerequisite_ids
            ]
        if previous_checkpoint:
            patch["focus_transition"] = {
                "from_checkpoint_id": previous_checkpoint.id,
                "from_title": previous_checkpoint.title,
                "to_checkpoint_id": event.checkpoint_id,
                "to_title": title,
                "reason": "学习位置切换",
            }
        await _apply_patch(
            db, event, "structure", patch,
            "记录学习路径位置、依赖与返回线索",
        )
        return

    if et in {"lecture_generated", "lecture_viewed", "micro_learning_card_viewed"}:
        await _apply_patch(
            db, event, "knowledge",
            {"active_concepts": p.get("concepts", []),
             "last_explanation": (
                 "讲义已生成" if et == "lecture_generated"
                 else "微学习卡已阅读" if et == "micro_learning_card_viewed"
                 else "讲义已阅读"
             ),
             "exposure_only": True},
            "学习内容只形成接触证据，不代表掌握",
        )
        return

    if et == "teach_back_analyzed":
        missing = list(p.get("missing_points") or [])
        await _apply_patch(
            db, event, "knowledge",
            {
                "teach_back_diagnostic": {
                    "run_id": p.get("run_id"),
                    "attempt_id": p.get("attempt_id"),
                    "coverage_ratio": p.get("coverage_ratio", 0),
                    "covered_points": list(p.get("covered_points") or []),
                    "missing_points": missing,
                    "evidence_id": event.id,
                },
                "pending_question": missing[0] if missing else "",
                "mastery_unchanged": True,
            },
            "费曼复述只提供覆盖缺口诊断，不能替代独立评分或晋级掌握",
        )
        await _apply_patch(
            db, event, "practice",
            {
                "current_attempt": p.get("attempt_id"),
                "assistance_level": "none",
                "recent_feedback": "teach_back_diagnostic",
                "diagnostic_only": True,
            },
            "记录一次独立复述诊断尝试，后续仍需题目验证",
        )
        return

    if et == "user_message":
        text = str(p.get("text", ""))
        lower = text.lower()
        if re.search(r"我(?:的)?(?:朋友|同学|同事|学生)|(?:这是|只是|用于).{0,6}(?:测试|演示)|假设|假如|[“”\"]", text):
            return
        if any(word in text for word in ("不懂", "没懂", "困惑", "为什么", "不会")):
            await _apply_patch(
                db, event, "knowledge",
                {"pending_question": text[:500], "knowledge_gap": text[:500]},
                "用户表达了待澄清的知识疑问；疑问不等于误解",
            )
        if re.search(r"(?:我|现在|今天|这|学得).{0,8}(?:太难|很烦|崩溃|跟不上|很累)", text) and not re.search(r"不(?:太难|烦|累)|没(?:有)?(?:很)?(?:累|烦)", text):
            await _apply_patch(
                db, event, "human",
                {"affect": "frustrated", "cognitive_load": 0.85,
                 "frustration": 0.8,
                 "transient_expires_at": ((event.occurred_at or event.created_at or datetime.utcnow()) + timedelta(hours=8)).isoformat()},
                "用户表达了短期学习负荷",
            )
        if (re.search(r"(?:我(?:的)?(?:目标|计划|想学)|为了).+", text) or "i want to learn" in lower) and not re.search(r"不想|不打算|不再|没有计划", text):
            await _apply_patch(
                db, event, "value",
                {"current_priority": text[:500], "current_motivation": "explicit"},
                "用户表达了当前学习目标",
            )
        if text.strip() in {"懂了", "明白了", "会了", "got it", "understood"}:
            await _apply_patch(
                db, event, "knowledge",
                {"last_acknowledgement": text.strip(), "mastery_unchanged": True},
                "自我确认是低置信度反馈，不晋级掌握",
            )
        return

    if et in {"hint_requested", "code_review_requested", "explanation_requested"}:
        level = "hint" if et == "hint_requested" else "guided"
        await _apply_patch(
            db, event, "practice",
            {"assistance_level": level, "recent_feedback": et},
            "记录当前尝试的辅助程度",
        )
        return

    if et == "remediation_started":
        await _apply_patch(
            db, event, "knowledge",
            {
                "active_remediation_case_id": p.get("case_id"),
                "pending_question": p.get("misconception_tag") or "答错后需要纠错",
                "recent_misconception": {
                    "tag": p.get("misconception_tag", ""),
                    "error_class": p.get("error_class", ""),
                    "item_id": p.get("item_id"),
                    "source_evidence_id": p.get("source_evidence_id"),
                },
            },
            "已验证的错误启动显式纠错闭环",
        )
        await _apply_patch(
            db, event, "practice",
            {
                "remediation_status": "explaining",
                "remediation_case_id": p.get("case_id"),
                "recent_feedback": p.get("delivery_mode", ""),
            },
            "纠错案例进入证据讲解阶段",
        )
        return

    if et == "remediation_mode_rejected":
        if not (event.provenance or {}).get("explicit_user_action"):
            return
        human = await _kernel(db, event.learner_id, "human")
        ineffective = list((human.short_term or {}).get("ineffective_explanation_modes") or [])
        mode = p.get("ineffective_mode")
        if mode and mode not in ineffective:
            ineffective.append(mode)
        await _apply_patch(
            db, event, "human",
            {
                "ineffective_explanation_modes": ineffective[-8:],
                "last_requested_explanation_mode": p.get("next_mode", ""),
                "adaptation_scope": {"project_id": event.project_id, "checkpoint_id": event.checkpoint_id, "session_id": event.session_id},
                "transient_expires_at": ((event.occurred_at or event.created_at or datetime.utcnow()) + timedelta(hours=8)).isoformat(),
            },
            "学习者明确要求换一种讲法，记录当前上下文中的无效表征",
        )
        return

    if et == "remediation_explanation_requested":
        await _apply_patch(
            db, event, "practice",
            {
                "remediation_status": "explaining",
                "remediation_case_id": p.get("case_id"),
                "assistance_level": "guided",
                "recent_feedback": p.get("delivery_mode", ""),
            },
            "记录纠错讲解的显式表征选择",
        )
        return

    if et == "remediation_retry_evaluated":
        passed = bool(p.get("passed"))
        await _apply_patch(
            db, event, "practice",
            {
                "remediation_status": "variant_ready" if passed else "explaining",
                "remediation_case_id": p.get("case_id"),
                "current_attempt": p.get("attempt_id"),
                "recent_feedback": "retry_passed" if passed else "retry_failed",
            },
            "原题重做结果回写纠错闭环",
        )
        if passed:
            await _apply_patch(
                db, event, "knowledge",
                {"pending_question": "", "remediation_retry_verified": True},
                "原题重做通过，但仍需变式验证后闭环",
            )
        return

    if et == "remediation_variant_evaluated":
        correct = bool(p.get("correct"))
        outcome = str(p.get("outcome") or ("correct" if correct else "incorrect"))
        await _apply_patch(
            db, event, "practice",
            {
                "remediation_status": "completed" if correct else "variant_ready",
                "remediation_case_id": p.get("case_id"),
                "current_attempt": p.get("attempt_id"),
                "recent_feedback": (
                    "variant_passed" if correct
                    else "variant_unknown" if outcome == "unknown"
                    else "variant_failed"
                ),
            },
            "变式作答验证纠错规则是否可迁移",
        )
        await _apply_patch(
            db, event, "knowledge",
            {
                "remediation_variant_verified": correct,
                "last_variant_attempt": {
                    "case_id": p.get("case_id"),
                    "attempt_id": p.get("attempt_id"),
                    "outcome": outcome,
                },
                "pending_question": "" if correct else "迁移变式仍需再次验证",
            },
            "变式结果记录概念规则是否能迁移到新情境",
        )
        return

    if et == "remediation_completed":
        await _apply_patch(
            db, event, "knowledge",
            {
                "active_remediation_case_id": None,
                "pending_question": "",
                "last_completed_remediation": {
                    "case_id": p.get("case_id"),
                    "evidence_event_ids": p.get("evidence_event_ids", []),
                },
            },
            "原题重做与变式均通过，纠错闭环形成可追溯证据",
        )
        await _apply_patch(
            db, event, "human",
            {"last_effective_explanation_mode": p.get("delivery_mode", "")},
            "成功完成纠错与迁移，保留本次有效讲法证据",
        )
        await _apply_patch(
            db, event, "practice",
            {"remediation_status": "completed",
             "remediation_case_id": p.get("case_id"),
             "remediation_evidence_event_ids": p.get("evidence_event_ids", [])},
            "显式纠错闭环完成并回写实践证据",
        )
        return

    if et == "review_reflection_recorded":
        # Keep the ReviewSchedule key for the operational short-term lookup;
        # MemoryFact uses memory_subject_key as the ConceptAnchor coordinate.
        subject_key = str(p.get("subject_key") or p.get("memory_subject_key") or "global")
        knowledge = await _kernel(db, event.learner_id, "knowledge")
        understanding = dict((knowledge.short_term or {}).get("concept_understanding") or {})
        current = dict(understanding.get(subject_key) or {})
        reflections = list(current.get("learner_reflections") or [])
        entry = {
            "event_id": event.id,
            "review_schedule_id": p.get("review_schedule_id"),
            "kind": p.get("reflection_kind"),
            "text": str(p.get("text") or "")[:1000],
            "source": "learner_self_report",
            "verification": "unverified",
            "mastery_inference": False,
            "correctable": True,
        }
        if not any(item.get("event_id") == event.id for item in reflections):
            reflections.append(entry)
        current["learner_reflections"] = reflections[-12:]
        understanding[subject_key] = current
        await _apply_patch(
            db,
            event,
            "knowledge",
            {"concept_understanding": understanding},
            "学习者为复习主题补充可纠正的自我反思；不据此升级掌握",
        )
        return

    if et == "review_attempt_evaluated":
        passed = bool(p.get("passed"))
        outcome = str(p.get("outcome") or ("correct" if passed else "incorrect"))
        independent = bool(p.get("independent", True))
        item_type = str(p.get("source_item_type") or p.get("item_type") or "concept")
        item_id = p.get("item_id")
        if item_id is None:
            return
        item_key = f"{item_type}:{item_id}"

        from app.services.review import stable_review_events
        matching = await stable_review_events(
            db, event.learner_id, item_type, int(item_id),
        )
        spaced_stable = bool(matching)

        knowledge = await _kernel(db, event.learner_id, "knowledge")
        retention = dict((knowledge.short_term or {}).get("retention_status") or {})
        retention[item_key] = {
            "status": (
                "spaced_stable" if spaced_stable
                else "retrieved" if passed and independent
                else "retrieved_with_support" if passed
                else "retrieval_gap" if outcome == "unknown"
                else "needs_review"
            ),
            "attempt_id": p.get("attempt_id"),
            "evidence_id": event.id,
            "question_form": p.get("question_form", "original"),
            "checkpoint_id": event.checkpoint_id,
        }
        recent_errors = list((knowledge.short_term or {}).get("recent_errors") or [])
        error_ref = f"{item_type}:{item_id}"
        if passed:
            recent_errors = [value for value in recent_errors if value != error_ref]
        elif error_ref not in recent_errors:
            recent_errors.append(error_ref)
        short_patch = {
            "retention_status": retention,
            "recent_errors": recent_errors[-12:],
        }
        if not passed:
            short_patch["pending_question"] = (
                "本轮未能提取答案，需要重新学习" if outcome == "unknown"
                else p.get("prompt", "复习题答错，需要纠错")
            )
        long_patch = None
        if spaced_stable:
            mastery = dict((knowledge.long_term or {}).get("mastery") or {})
            mastery[f"review:{item_key}"] = {
                "level": "stable",
                "policy_version": "review-policy-v1",
                "evidence_ids": [row.id for row in matching[-10:]],
            }
            long_patch = {"mastery": mastery}
        await _apply_patch(
            db, event, "knowledge", short_patch,
            "间隔检索结果更新知识保持状态",
            long_patch=long_patch,
        )

        practice = await _kernel(db, event.learner_id, "practice")
        review_history = dict((practice.short_term or {}).get("review_history") or {})
        review_history[item_key] = {
            "attempt_id": p.get("attempt_id"),
            "outcome": outcome,
            "assistance_level": p.get("assistance_level", "none"),
            "question_form": p.get("question_form", "original"),
            "evidence_id": event.id,
        }
        practice_long = None
        if spaced_stable:
            proof_chain = dict((practice.long_term or {}).get("proof_chain") or {})
            proof_chain[f"review:{item_key}"] = {
                "event_id": event.id,
                "checkpoint_id": event.checkpoint_id,
                "kind": "spaced_independent_transfer",
                "evidence_ids": [row.id for row in matching[-10:]],
            }
            practice_long = {"proof_chain": proof_chain}
        await _apply_patch(
            db, event, "practice",
            {
                "current_attempt": p.get("attempt_id"),
                "assistance_level": p.get("assistance_level", "none"),
                "recent_feedback": f"review_{outcome}",
                "review_history": review_history,
            },
            "复习尝试记录独立性、辅助程度与题目形式",
            long_patch=practice_long,
        )
        return

    if et == "concept_attempt_evaluated":
        correct = bool(p.get("correct"))
        independent = bool(p.get("independent", True))
        allows_same_session_stability = (
            p.get("assessment_mode") != "verified_micro_learning"
        )
        knowledge_state = await _kernel(db, event.learner_id, "knowledge")
        concept_understanding = dict(
            (knowledge_state.short_term or {}).get("concept_understanding") or {}
        )
        item_key = f"item:{p.get('item_id')}"
        concept_understanding[item_key] = {
            "status": (
                "verified_once" if correct and independent
                else "correct_with_support" if correct
                else "needs_review"
            ),
            "question": p.get("question", ""),
            "checkpoint_id": event.checkpoint_id,
            "evidence_id": event.id,
        }
        recent_errors = list((knowledge_state.short_term or {}).get("recent_errors") or [])
        item_id = p.get("item_id")
        if correct:
            recent_errors = [item for item in recent_errors if item != item_id]
        elif item_id not in recent_errors:
            recent_errors.append(item_id)
        patch = {
            "concept_understanding": concept_understanding,
            "recent_errors": recent_errors[-8:],
        }
        if not correct:
            patch["pending_question"] = p.get("question", "概念题答错")
        long_patch = None
        if correct and independent and allows_same_session_stability:
            rows = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.learner_id == event.learner_id,
                EvidenceEvent.checkpoint_id == event.checkpoint_id,
                EvidenceEvent.event_type == "concept_attempt_evaluated",
            ))).scalars().all()
            distinct_items = {
                (row.payload or {}).get("item_id") for row in rows
                if (row.payload or {}).get("correct") and (row.payload or {}).get("independent", True)
            }
            if len({x for x in distinct_items if x is not None}) >= 2:
                mastery = dict((knowledge_state.long_term or {}).get("mastery") or {})
                mastery[f"checkpoint:{event.checkpoint_id}"] = {
                    "level": "stable", "evidence_ids": [row.id for row in rows[-10:]],
                }
                concept_understanding[item_key]["status"] = "stable"
                long_patch = {"mastery": mastery}
        await _apply_patch(db, event, "knowledge", patch, "概念评估结果", long_patch=long_patch)
        await _apply_patch(
            db, event, "practice",
            {
                "current_attempt": p.get("attempt_id"),
                "assistance_level": p.get("assistance_level", "none"),
                "artifact_state": "passed" if correct else "failed",
                "recent_feedback": "concept_correct" if correct else "concept_needs_review",
            },
            "概念题正式作答",
        )
        blocker = str(p.get("blocker_concept_key") or "").strip()
        if blocker:
            await _apply_patch(
                db, event, "structure",
                {
                    "navigation_blocker": {
                        "concept_key": blocker,
                        "blocks": p.get("concept_key") or p.get("target_skill") or f"item:{p.get('item_id')}",
                        "source": "learner_explicit_attempt_reflection",
                        "evidence_id": event.id,
                    },
                },
                "学习者明确指出的概念卡点",
            )
        helpful_format = str(p.get("helpful_format") or "").strip()
        if helpful_format and bool(p.get("support_effective")):
            await _apply_patch(
                db, event, "human",
                {
                    "format_preference": helpful_format,
                    "support_need": {
                        "effective_format": helpful_format,
                        "scope": p.get("concept_key") or p.get("target_skill") or "current_practice",
                        "source": "learner_explicit_attempt_reflection",
                        "evidence_id": event.id,
                    },
                },
                "学习者确认有效的支持形式",
            )
        return

    if et == "exercise_attempt_evaluated":
        passed = bool(p.get("passed"))
        independent = p.get("assistance_level", "none") == "none"
        long_patch = None
        if passed and independent:
            state = await _kernel(db, event.learner_id, "practice")
            proof_chain = dict((state.long_term or {}).get("proof_chain") or {})
            proof_chain[f"exercise:{p.get('item_id')}"] = {
                "event_id": event.id, "checkpoint_id": event.checkpoint_id,
                "kind": "independent_success",
            }
            long_patch = {"proof_chain": proof_chain}
        await _apply_patch(
            db, event, "practice",
            {"current_attempt": p.get("attempt_id"),
             "artifact_state": "passed" if passed else "failed",
             "assistance_level": p.get("assistance_level", "none"),
             "recent_feedback": p.get("feedback", "")},
            "实践评估结果", long_patch=long_patch,
        )
        return

    if et == "transfer_attempt_evaluated":
        passed = bool(p.get("passed"))
        independent = p.get("assistance_level", "none") == "none"
        high_confidence = (event.confidence or 0.0) >= 0.9
        if passed and independent and high_confidence:
            knowledge = await _kernel(db, event.learner_id, "knowledge")
            mastery = dict((knowledge.long_term or {}).get("mastery") or {})
            mastery[f"checkpoint:{event.checkpoint_id}"] = {
                "level": "stable",
                "evidence_ids": [event.id],
                "kind": "high_confidence_transfer",
            }
            await _apply_patch(
                db, event, "knowledge",
                {"pending_question": "", "transfer_verified": True},
                "高置信度迁移任务形成掌握证据",
                long_patch={"mastery": mastery},
            )
            practice = await _kernel(db, event.learner_id, "practice")
            proof_chain = dict((practice.long_term or {}).get("proof_chain") or {})
            proof_chain[f"transfer:{event.id}"] = {
                "event_id": event.id,
                "checkpoint_id": event.checkpoint_id,
                "kind": "high_confidence_transfer",
            }
            await _apply_patch(
                db, event, "practice",
                {"artifact_state": "passed", "assistance_level": "none"},
                "独立迁移任务形成实践证据",
                long_patch={"proof_chain": proof_chain},
            )
        return

    if et in {"tool_failed", "task_failed"}:
        await _apply_patch(
            db, event, "structure",
            {"current_blocker": p.get("message", "工具执行失败")},
            "工具失败形成当前阻塞",
        )


async def apply_semantic_observations(
    db: AsyncSession,
    event: EvidenceEvent,
    observations: Iterable[dict[str, Any]],
):
    """Record model proposals under their own provenance, never as user speech."""
    for index, observation in enumerate(list(observations or [])[:5]):
        kernel_name = observation.get("kernel")
        patch = observation.get("short_term")
        if kernel_name not in KERNEL_NAMES or not isinstance(patch, dict):
            continue
        allowed_keys = SEMANTIC_MEMORY_KEYS[kernel_name]
        safe_patch = {
            str(key)[:80]: value for key, value in list(patch.items())[:8]
            if key in allowed_keys and isinstance(value, (str, bool, int, float, list, dict))
            and len(json.dumps(value, ensure_ascii=False)) <= 1000
        }
        if not safe_patch:
            continue
        await record_event(
            db, learner_id=event.learner_id, project_id=event.project_id,
            checkpoint_id=event.checkpoint_id, session_id=event.session_id,
            event_type="semantic_observation_proposed", source="semantic_observation",
            payload={"kernel": kernel_name, "candidate": safe_patch,
                     "source_event_id": event.id,
                     "reason": str(observation.get("reason") or "Tutor 语义观察")[:500]},
            confidence=0.5, provenance={"semantic_observation": True,
                "policy_version": "memory-observation.v2", "mastery_inference": False},
            client_event_id=f"semantic-observation:{event.id}:{index}",
        )


async def create_attempt(
    db: AsyncSession,
    *,
    learner_id: int | None = None,
    checkpoint_id: int,
    item_type: str,
    item_id: int | None,
    submission: dict,
    result: dict,
    assistance_level: str = "none",
    attempt_role: str = "original",
    status: str = "evaluated",
    client_submission_id: str | None = None,
) -> LearningAttempt:
    if learner_id is None:
        learner_id = (await get_default_learner(db)).id
    checkpoint = (await db.execute(
        select(Checkpoint)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            Checkpoint.id == checkpoint_id,
            Project.learner_id == learner_id,
        )
    )).scalar_one_or_none()
    if not checkpoint:
        raise ValueError("检查点不属于当前学习者")
    roadmap = await db.get(Roadmap, checkpoint.roadmap_id) if checkpoint else None
    now = datetime.utcnow()
    attempt = LearningAttempt(
        learner_id=learner_id,
        project_id=roadmap.project_id if roadmap else None,
        checkpoint_id=checkpoint_id,
        item_type=item_type,
        item_id=item_id,
        status=status,
        submission=submission,
        result=result,
        assistance_level=assistance_level,
        attempt_role=attempt_role,
        client_submission_id=client_submission_id,
        submitted_at=now,
        evaluated_at=now,
    )
    db.add(attempt)
    await db.flush()
    return attempt


async def evaluate_checkpoint_status(
    db: AsyncSession, checkpoint_id: int, learner_id: int | None = None,
) -> str:
    checkpoint_query = select(Checkpoint).where(Checkpoint.id == checkpoint_id)
    if learner_id is not None:
        checkpoint_query = (
            checkpoint_query
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .join(Project, Project.id == Roadmap.project_id)
            .where(Project.learner_id == learner_id)
        )
    checkpoint = (await db.execute(checkpoint_query)).scalar_one_or_none()
    if not checkpoint:
        return "not_started"
    progress = dict(checkpoint.progress or {})
    attempt_filters = [
            LearningAttempt.checkpoint_id == checkpoint_id,
            LearningAttempt.status == "evaluated",
    ]
    if learner_id is not None:
        attempt_filters.append(LearningAttempt.learner_id == learner_id)
    attempts = (await db.execute(select(LearningAttempt).where(*attempt_filters))).scalars().all()
    independent = [attempt for attempt in attempts if attempt.assistance_level == "none"]
    knowledge_verified = any(
        attempt.item_type == "concept" and bool((attempt.result or {}).get("correct"))
        for attempt in independent
    )
    practice_verified = any(
        attempt.item_type == "exercise"
        and int((attempt.result or {}).get("total") or 0) > 0
        and int((attempt.result or {}).get("passed") or 0) == int((attempt.result or {}).get("total") or 0)
        for attempt in independent
    )
    transfer_filters = [
        EvidenceEvent.checkpoint_id == checkpoint_id,
        EvidenceEvent.event_type == "transfer_attempt_evaluated",
        EvidenceEvent.confidence >= 0.9,
    ]
    if learner_id is not None:
        transfer_filters.append(EvidenceEvent.learner_id == learner_id)
    transfer = (await db.execute(select(EvidenceEvent).where(*transfer_filters))).scalars().all()
    transfer_verified = any(
        bool((event.payload or {}).get("passed"))
        and (event.payload or {}).get("assistance_level", "none") == "none"
        for event in transfer
    )
    lecture = (await db.execute(
        select(Lecture.id).where(Lecture.checkpoint_id == checkpoint_id)
    )).scalar_one_or_none()

    if (knowledge_verified and practice_verified) or transfer_verified:
        checkpoint.learning_status = "completed"
        checkpoint.completed = True
    elif checkpoint.legacy_completed:
        checkpoint.learning_status = "verification_due"
    elif lecture or progress or attempts:
        checkpoint.learning_status = "in_progress"
    else:
        checkpoint.learning_status = checkpoint.learning_status or "not_started"
    return checkpoint.learning_status


async def get_kernel_projection(db: AsyncSession, learner_id: int | None = None) -> dict:
    if learner_id is None:
        learner_id = (await get_default_learner(db)).id
    await ensure_kernel_states(db, learner_id)
    states = (await db.execute(
        select(KernelState).where(KernelState.learner_id == learner_id)
    )).scalars().all()
    archives = (await db.execute(select(MemoryArchive).where(
        MemoryArchive.learner_id == learner_id,
        MemoryArchive.status == "archived",
    ))).scalars().all()
    archived_paths = {
        (item.kernel_name, item.memory_scope, item.memory_key) for item in archives
    }
    now = datetime.utcnow()
    result = {}
    from app.services.memory_graph import active_module_claims, recent_atomic_facts
    from app.services.five_kernel_context import _archived_projection_ids
    archived_node_ids = await _archived_projection_ids(db, learner_id, archives)
    for state in states:
        short = dict(state.short_term or {})
        # This compatibility projection has no session scope. Model candidates
        # are available only through session-filtered transient memory facts.
        short.pop("semantic_candidate", None)
        short.pop("teaching_directives", None)
        long = dict(state.long_term or {})
        long.pop("teaching_preferences", None)
        for kernel_name, scope, key in archived_paths:
            if kernel_name != state.kernel_name:
                continue
            (short if scope == "short_term" else long).pop(key, None)
            if state.kernel_name == "human":
                if key == "learning_preferences":
                    for preference_key in ("preferred_modes", "pace_preference", "format_preference", "weekly_hours"):
                        short.pop(preference_key, None)
                        long.pop(preference_key, None)
                    long.pop("learning_preferences", None)
                else:
                    preferences = dict(long.get("learning_preferences") or {})
                    preferences.pop(key, None)
                    if "learning_preferences" in long:
                        long["learning_preferences"] = preferences
        if state.kernel_name == "human" and short.get("transient_expires_at"):
            try:
                if datetime.fromisoformat(short["transient_expires_at"]) < now:
                    for key in (
                        "affect", "cognitive_load", "attention", "frustration",
                        "support_need", "pace_adjustment", "format_request",
                        "adaptation_source", "adaptation_scope", "transient_expires_at",
                    ):
                        short.pop(key, None)
            except (TypeError, ValueError):
                pass
        recent_facts = await recent_atomic_facts(db, learner_id, state.kernel_name)
        module_claims = await active_module_claims(
            db, learner_id, kernel_name=state.kernel_name, limit=30,
        )
        recent_facts = [item for item in recent_facts if item["id"] not in archived_node_ids]
        module_claims = [item for item in module_claims if item["id"] not in archived_node_ids]
        short.pop("memory_graph_recent_facts", None)
        long.pop("memory_graph_claims", None)
        if recent_facts:
            short["memory_graph_recent_facts"] = recent_facts
        if module_claims:
            long["memory_graph_claims"] = module_claims
        result[state.kernel_name] = {
            "short_term": short,
            "long_term": long,
            "confidence": state.confidence or 0.0,
        }
    for kernel_name in KERNEL_NAMES:
        result.setdefault(kernel_name, {
            "short_term": {}, "long_term": {}, "confidence": 0.0,
        })

    # Historical versions stored goals under structure. Keep the evidence but
    # expose it through the canonical value dimension from now on.
    for scope in ("short_term", "long_term"):
        legacy_goal = result["structure"][scope].pop("current_goal", None)
        if legacy_goal and "current_goal" not in result["value"][scope]:
            result["value"][scope]["current_goal"] = legacy_goal

    # Apply archive paths again after canonicalization so a newly archived
    # value:current_goal does not reappear from a legacy structure row.
    for kernel_name, scope, key in archived_paths:
        result.get(kernel_name, {}).get(scope, {}).pop(key, None)
    return result


async def get_state_summary(
    db: AsyncSession,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    *,
    learner_id: int | None = None,
) -> dict:
    if learner_id is None:
        learner_id = (await get_default_learner(db)).id
    projection = await get_kernel_projection(db, learner_id)
    structure = projection.get("structure", {}).get("short_term", {})
    value = projection.get("value", {}).get("short_term", {})
    active_project_id = project_id or structure.get("active_project_id")
    active_checkpoint_id = checkpoint_id or structure.get("active_checkpoint_id")
    project = (await db.execute(select(Project).where(
        Project.id == active_project_id, Project.learner_id == learner_id,
    ))).scalar_one_or_none() if active_project_id else None
    if not project:
        active_project_id = None
    checkpoint = (await db.execute(
        select(Checkpoint)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            Checkpoint.id == active_checkpoint_id,
            Project.learner_id == learner_id,
        )
    )).scalar_one_or_none() if active_checkpoint_id else None
    counts = {"total": 0, "completed": 0, "verification_due": 0}
    if active_project_id:
        rows = (await db.execute(
            select(Checkpoint.learning_status, func.count(Checkpoint.id))
            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
            .where(Roadmap.project_id == active_project_id, Checkpoint.archived.is_(False))
            .group_by(Checkpoint.learning_status)
        )).all()
        for status, count in rows:
            counts["total"] += count
            if status == "completed":
                counts["completed"] = count
            elif status == "verification_due":
                counts["verification_due"] = count
    stage = "自由学习"
    if checkpoint:
        stage = checkpoint.learning_status or "in_progress"
    elif project:
        stage = "项目学习"
    return {
        "stage": stage,
        "active_project": {"id": project.id, "name": project.name} if project else None,
        "active_checkpoint": {
            "id": checkpoint.id, "title": checkpoint.title,
            "status": checkpoint.learning_status or "not_started",
        } if checkpoint else None,
        "progress": counts,
        "blocker": structure.get("current_blocker", ""),
        "current_goal": (
            value.get("current_goal")
            or value.get("current_priority")
            or value.get("goal_candidate")
            or ""
        ),
    }
