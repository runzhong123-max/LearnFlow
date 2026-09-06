"""Inspectable, event-sourced memory graph for the five learning kernels."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    EvidenceEvent,
    KernelMutation,
    KernelState,
    MemoryClaim,
    MemoryEdge,
    MemoryFact,
    MemoryModule,
    MemoryNode,
    MemorySynthesisRun,
)
from app.services.five_kernel_context import (
    MEMORY_SCHEMA_VERSION,
    memory_kind_for,
    memory_salience,
    subject_parts,
)


KERNEL_NAMES = ("structure", "knowledge", "human", "value", "practice")
NODE_TYPES = ("fact", "module", "claim")
RELATION_TYPES = (
    "NEXT_IN_KERNEL",
    "SAME_EVENT",
    "SAME_SUBJECT",
    "SUPPORTS",
    "CONTRADICTS",
    "REFINES",
    "SUPERSEDES",
    "MOTIVATES",
    "ADDRESSES",
    "BLOCKS",
    "ENABLES",
    "CONSOLIDATED_INTO",
)
TRANSIENT_HUMAN_KEYS = {
    "affect", "cognitive_load", "attention", "frustration", "support_need",
    "pace_adjustment", "format_request", "planning_availability",
}
NON_MEMORY_PATCH_KEYS = {
    "transient_expires_at", "adaptation_source", "adaptation_scope",
    # These are bounded, scoped control projections, not evidence summaries.
    # The original event/mutation already preserves their sources. Re-synthesis
    # would repeat old instructions and defeat per-turn expiry and replacement.
    "teaching_directives", "teaching_preferences",
}
BOUNDARY_EVENTS = {
    "project_created", "project_imported", "project_selected", "roadmap_applied", "roadmap_revised", "checkpoint_entered",
    "checkpoint_completed", "project_completed", "vnext_personal_path_node_added",
    "vnext_personal_path_node_removed", "vnext_learning_path_node_status_set",
}
EXPLICIT_PREFERENCE_KEYS = {
    "weekly_hours", "preferred_modes", "learning_preferences", "pace_preference",
    "format_preference",
}
MODULE_VERSION_POLICY = "memory-module-version-v2"
MAX_SYNTHESIS_ATTEMPTS = 3
MODULE_EVIDENCE_LIMIT = 64
KNOWLEDGE_SELF_REPORT_THRESHOLD = 2


def actor_type_for_source(source: str) -> str:
    source = (source or "system").casefold()
    if source in {"user", "profile", "registration", "learner"}:
        return "learner"
    if source in {"tutor", "assistant", "agent", "semantic_observation"}:
        return "tutor"
    if source in {"tool", "grader", "runtime", "judge"}:
        return "tool"
    return "system"


async def next_learner_sequence(db: AsyncSession, learner_id: int) -> int:
    """Allocate a unique learner-local event sequence inside the caller transaction.

    A ``MAX + 1`` query races when chat persistence, task updates and artifact
    actions arrive together.  The sequence row turns allocation into one atomic
    database write while the MAX floor keeps old databases and direct imports
    compatible.
    """
    bind = db.get_bind()
    if bind.dialect.name == "sqlite":
        await db.execute(text(
            "INSERT OR IGNORE INTO learner_event_sequences "
            "(learner_id, next_sequence, updated_at) "
            "SELECT :learner_id, COALESCE(MAX(learner_seq), 0) + 1, CURRENT_TIMESTAMP "
            "FROM evidence_events WHERE learner_id = :learner_id"
        ), {"learner_id": learner_id})
        statement = text(
            "UPDATE learner_event_sequences SET "
            "next_sequence = MAX(next_sequence, COALESCE((SELECT MAX(learner_seq) + 1 "
            "FROM evidence_events WHERE learner_id = :learner_id), 1)) + 1, "
            "updated_at = CURRENT_TIMESTAMP WHERE learner_id = :learner_id "
            "RETURNING next_sequence - 1"
        )
    else:
        await db.execute(text(
            "INSERT INTO learner_event_sequences (learner_id, next_sequence, updated_at) "
            "SELECT :learner_id, COALESCE(MAX(learner_seq), 0) + 1, CURRENT_TIMESTAMP "
            "FROM evidence_events WHERE learner_id = :learner_id "
            "ON CONFLICT (learner_id) DO NOTHING"
        ), {"learner_id": learner_id})
        statement = text(
            "UPDATE learner_event_sequences SET "
            "next_sequence = GREATEST(next_sequence, COALESCE((SELECT MAX(learner_seq) + 1 "
            "FROM evidence_events WHERE learner_id = :learner_id), 1)) + 1, "
            "updated_at = CURRENT_TIMESTAMP WHERE learner_id = :learner_id "
            "RETURNING next_sequence - 1"
        )
    allocated = (await db.execute(statement, {"learner_id": learner_id})).scalar_one()
    return int(allocated)


def _compact(value: Any, limit: int = 220) -> str:
    if isinstance(value, str):
        rendered = value
    else:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
    rendered = " ".join(rendered.split())
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"


def _subject_key(event: EvidenceEvent, kernel_name: str, key: str, value: Any) -> str:
    payload = dict(event.payload or {})
    if payload.get("memory_subject_key"):
        return str(payload["memory_subject_key"])
    if kernel_name == "knowledge":
        concept = (
            payload.get("concept_id") or payload.get("concept") or payload.get("concept_name")
        )
        if concept is not None:
            return f"concept:{concept}"
        if event.checkpoint_id is not None:
            return f"checkpoint:{event.checkpoint_id}"
        item = payload.get("question_id") or payload.get("item_id")
        if item is not None:
            return f"concept-item:{item}"
    if kernel_name == "practice":
        item = payload.get("exercise_id") or payload.get("item_id") or payload.get("attempt_id")
        if item is not None:
            return f"practice:{item}"
        if event.checkpoint_id is not None:
            return f"checkpoint:{event.checkpoint_id}"
    if kernel_name == "structure" and event.project_id is not None:
        return f"project:{event.project_id}"
    if kernel_name == "value":
        if key in {"career_goal", "career_goal_candidate", "career_goal_status", "current_goal", "goal_candidate", "goal_status", "current_priority"}:
            return "goal:primary"
        if event.project_id is not None:
            return f"project:{event.project_id}"
    if kernel_name == "human":
        if key in EXPLICIT_PREFERENCE_KEYS:
            return "preference:learning"
        if event.session_id is not None:
            return f"session:{event.session_id}"
    if event.project_id is not None:
        return f"project:{event.project_id}"
    return "global"


def _evidence_grade(event: EvidenceEvent, key: str) -> str:
    provenance = dict(event.provenance or {})
    if event.event_type.startswith("memory_correction"):
        return "corrected"
    if provenance.get("migration"):
        return "legacy"
    if event.event_type == "lecture_viewed" or provenance.get("exposure_only"):
        return "exposure_only"
    if event.event_type in {"transfer_attempt_evaluated", "remediation_variant_evaluated"} and (
        ((event.payload or {}).get("passed") or (event.payload or {}).get("correct"))
        and (event.payload or {}).get("assistance_level", "none") == "none"
        and (event.confidence or 0) >= 0.9
    ):
        return "verified"
    if event.event_type in {"concept_attempt_evaluated", "exercise_attempt_evaluated"}:
        payload = event.payload or {}
        passed = bool(payload.get("correct")) if event.event_type == "concept_attempt_evaluated" else bool(payload.get("passed"))
        independent = bool(payload.get("independent", True)) if event.event_type == "concept_attempt_evaluated" else payload.get("assistance_level", "none") == "none"
        return "verified" if passed and independent and (event.confidence or 0) >= 0.8 else "observed"
    if provenance.get("self_report") or event.source in {"profile", "registration", "user"}:
        return "self_reported"
    if provenance.get("semantic_observation") or event.source in {"tutor", "semantic_observation"}:
        return "inferred"
    return "observed"


def _fact_pairs(mutation: KernelMutation) -> list[tuple[str, str, Any]]:
    patch = dict(mutation.patch or {})
    short = dict(patch.get("short_term") or {})
    long = dict(patch.get("long_term") or {})
    pairs: list[tuple[str, str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for scope, values in (("short_term", short), ("long_term", long)):
        for key, value in values.items():
            if key in NON_MEMORY_PATCH_KEYS or (
                mutation.kernel_name == "human" and scope == "long_term" and key == "learning_preferences"
            ):
                continue
            marker = (key, json.dumps(value, ensure_ascii=False, sort_keys=True, default=str))
            if marker in seen:
                continue
            seen.add(marker)
            pairs.append((scope, key, value))
    return pairs


async def _add_edge(
    db: AsyncSession,
    *,
    learner_id: int,
    source_node_id: int,
    target_node_id: int,
    relation_type: str,
    origin: str = "deterministic",
    confidence: float = 1.0,
    event_id: int | None = None,
    payload: dict | None = None,
) -> MemoryEdge | None:
    if source_node_id == target_node_id or relation_type not in RELATION_TYPES:
        return None
    existing = (await db.execute(select(MemoryEdge.id).where(
        MemoryEdge.learner_id == learner_id,
        MemoryEdge.source_node_id == source_node_id,
        MemoryEdge.target_node_id == target_node_id,
        MemoryEdge.relation_type == relation_type,
    ))).scalar_one_or_none()
    if existing:
        return None
    edge = MemoryEdge(
        learner_id=learner_id,
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        relation_type=relation_type,
        origin=origin,
        confidence=max(0.0, min(float(confidence), 1.0)),
        evidence_event_id=event_id,
        payload=payload or {},
    )
    db.add(edge)
    await db.flush()
    return edge


async def invalidate_fact_projections(db: AsyncSession, learner_id: int, fact_ids: list[int], *, status: str) -> None:
    """Invalidate derived projections, retaining immutable events and old text."""
    if not fact_ids:
        return
    facts = (await db.execute(select(MemoryNode, MemoryFact).join(
        MemoryFact, MemoryFact.node_id == MemoryNode.id,
    ).where(MemoryNode.learner_id == learner_id, MemoryNode.id.in_(fact_ids)))).all()
    for node, fact in facts:
        node.status = status
        fact.consumption_status = "excluded"
        fact.reservation_run_id = None
    derived = (await db.execute(select(MemoryNode).where(
        MemoryNode.learner_id == learner_id,
        MemoryNode.node_type.in_(["module", "claim"]),
        MemoryNode.status.in_(["active", "legacy"]),
    ))).scalars().all()
    affected = set(fact_ids)
    for node in derived:
        if affected.intersection((node.payload or {}).get("evidence_fact_ids", [])):
            node.status = status
    await db.flush()
    await rebuild_kernel_long_term_from_modules(db, learner_id)


async def create_facts_for_mutation(
    db: AsyncSession,
    event: EvidenceEvent,
    mutation: KernelMutation,
    *,
    queue_synthesis: bool = True,
) -> list[MemoryNode]:
    """Expand a mutation into idempotent atomic facts and sparse deterministic edges."""
    existing = (await db.execute(
        select(MemoryNode)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .where(MemoryFact.source_mutation_id == mutation.id)
        .order_by(MemoryFact.fact_ordinal.asc())
    )).scalars().all()
    if existing:
        return list(existing)

    if event.event_type in {"memory_correction_added", "memory_correction_retracted"}:
        await invalidate_fact_projections(
            db, event.learner_id, list((event.payload or {}).get("affected_fact_ids", [])),
            status="retracted" if event.event_type.endswith("retracted") else "superseded",
        )
    if mutation.kernel_name == "human" and "learning_preferences" in dict((mutation.patch or {}).get("long_term") or {}):
        # Historical aggregate facts duplicate per-key evidence and must not keep
        # stale values alive after a partial preference update.
        aggregates = list((await db.execute(select(MemoryNode.id).where(
            MemoryNode.learner_id == event.learner_id,
            MemoryNode.kernel_name == "human", MemoryNode.node_type == "fact",
            MemoryNode.status.in_(["active", "legacy"]),
            MemoryNode.payload["key"].as_string() == "learning_preferences",
        ))).scalars().all())
        await invalidate_fact_projections(db, event.learner_id, aggregates, status="superseded")
    created: list[MemoryNode] = []
    occurred_at = event.occurred_at or event.created_at or datetime.utcnow()
    for ordinal, (scope, key, value) in enumerate(_fact_pairs(mutation)):
        subject = _subject_key(event, mutation.kernel_name, key, value)
        replaceable = (
            mutation.kernel_name == "knowledge" and key == "declared_background"
        ) or (
            mutation.kernel_name == "human" and key in EXPLICIT_PREFERENCE_KEYS
        ) or (mutation.kernel_name == "value" and key in {
            "career_goal", "career_goal_candidate", "career_goal_status", "current_goal", "goal_candidate", "goal_status", "current_priority",
        })
        if replaceable:
            old_ids = list((await db.execute(select(MemoryNode.id).where(
                MemoryNode.learner_id == event.learner_id,
                MemoryNode.kernel_name == mutation.kernel_name,
                MemoryNode.subject_key == subject,
                MemoryNode.node_type == "fact",
                MemoryNode.status.in_(["active", "legacy"]),
                MemoryNode.payload["key"].as_string() == key,
            ))).scalars().all())
            await invalidate_fact_projections(db, event.learner_id, old_ids, status="superseded")
        subject_type, subject_id = subject_parts(subject)
        grade = _evidence_grade(event, key)
        transient = key == "semantic_candidate" or (
            mutation.kernel_name == "human" and key in TRANSIENT_HUMAN_KEYS
        )
        valid_to = occurred_at + timedelta(hours=8) if transient else None
        memory_kind = memory_kind_for(mutation.kernel_name, key)
        node = MemoryNode(
            learner_id=event.learner_id,
            node_type="fact",
            kernel_name=mutation.kernel_name,
            memory_kind=memory_kind,
            subject_key=subject,
            subject_type=subject_type,
            subject_id=subject_id,
            project_id=event.project_id,
            checkpoint_id=event.checkpoint_id,
            session_id=event.session_id,
            text=f"{key}: {_compact(value)}",
            payload={
                "scope": scope,
                "reason": mutation.reason,
                "event_type": event.event_type,
                "key": key,
            },
            confidence=event.confidence or 0.0,
            salience=memory_salience(
                memory_kind=memory_kind,
                evidence_grade=grade,
                scope=scope,
                confidence=event.confidence or 0.0,
            ),
            schema_version=MEMORY_SCHEMA_VERSION,
            status="active" if not transient else "transient",
            valid_from=occurred_at,
            valid_to=valid_to,
            occurred_at=occurred_at,
        )
        db.add(node)
        await db.flush()
        db.add(MemoryFact(
            node_id=node.id,
            source_event_id=event.id,
            source_mutation_id=mutation.id,
            fact_ordinal=ordinal,
            predicate=f"{scope}.{key}",
            object_value=value,
            evidence_grade=grade,
            consumption_status="excluded" if transient else "eligible",
            project_id=event.project_id,
            checkpoint_id=event.checkpoint_id,
            session_id=event.session_id,
        ))
        await db.flush()

        previous_kernel = (await db.execute(
            select(MemoryNode.id)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .where(
                MemoryNode.learner_id == event.learner_id,
                MemoryNode.node_type == "fact",
                MemoryNode.kernel_name == mutation.kernel_name,
                MemoryNode.id != node.id,
            )
            .order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
            .limit(1)
        )).scalar_one_or_none()
        if previous_kernel:
            await _add_edge(
                db, learner_id=event.learner_id, source_node_id=previous_kernel,
                target_node_id=node.id, relation_type="NEXT_IN_KERNEL", event_id=event.id,
            )

        same_event_nodes = list((await db.execute(
            select(MemoryNode.id)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .where(
                MemoryFact.source_event_id == event.id,
                MemoryNode.id != node.id,
            )
        )).scalars().all())
        for related_id in same_event_nodes:
            await _add_edge(
                db, learner_id=event.learner_id, source_node_id=related_id,
                target_node_id=node.id, relation_type="SAME_EVENT", event_id=event.id,
            )

        previous_subject = (await db.execute(
            select(MemoryNode.id)
            .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
            .where(
                MemoryNode.learner_id == event.learner_id,
                MemoryNode.kernel_name == mutation.kernel_name,
                MemoryNode.subject_key == subject,
                MemoryNode.id != node.id,
                MemoryFact.source_event_id != event.id,
            )
            .order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
            .limit(1)
        )).scalar_one_or_none()
        if previous_subject:
            await _add_edge(
                db, learner_id=event.learner_id, source_node_id=previous_subject,
                target_node_id=node.id, relation_type="SAME_SUBJECT", event_id=event.id,
            )
        created.append(node)

    if queue_synthesis:
        for subject in sorted({node.subject_key for node in created}):
            await maybe_queue_synthesis(
                db, event.learner_id, mutation.kernel_name, subject,
                trigger_event=event,
            )
    return created


async def _eligible_facts(
    db: AsyncSession, learner_id: int, kernel_name: str, subject_key: str,
    *, limit: int = 12,
) -> list[tuple[MemoryNode, MemoryFact, EvidenceEvent]]:
    rows = (await db.execute(
        select(MemoryNode, MemoryFact, EvidenceEvent)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name == kernel_name,
            MemoryNode.subject_key == subject_key,
            MemoryNode.status.in_(["active", "legacy"]),
            MemoryFact.consumption_status == "eligible",
        )
        .order_by(
            case((MemoryFact.evidence_grade == "corrected", 0),
                 (MemoryFact.evidence_grade == "verified", 1),
                 (MemoryFact.evidence_grade == "self_reported", 2), else_=3),
            MemoryNode.occurred_at.desc(), MemoryNode.id.desc(),
        )
        .limit(limit)
    )).all()
    return sorted(rows, key=lambda row: (row[0].occurred_at, row[0].id))


def _sessions_count(rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]]) -> int:
    sessions = {
        fact.session_id if fact.session_id is not None else f"event:{event.id}"
        for _, fact, event in rows
    }
    return len(sessions)


def _trigger_reason(
    kernel_name: str,
    rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]],
    trigger_event: EvidenceEvent,
) -> str | None:
    if not rows:
        return None
    event_count = len({event.id for _, _, event in rows})
    if trigger_event.event_type == "memory_correction_confirmed":
        return "confirmation"
    if trigger_event.event_type in {"memory_correction_added", "memory_correction_retracted"}:
        return "correction"
    if kernel_name == "structure":
        if event_count >= 3:
            return "structure_threshold"
        if event_count >= 2 and trigger_event.event_type in BOUNDARY_EVENTS:
            return "structure_boundary"
    elif kernel_name == "knowledge":
        # A learner may explicitly ask LearnFlow to remember the boundary of
        # prior exposure before any assessment exists. Two or more reviewed
        # observations for the same concept may therefore form an
        # exposure-only module. The worker still labels every resulting claim
        # as self-reported and rejects mastery language without repeated
        # verified evidence.
        exposure_only = (
            event_count >= KNOWLEDGE_SELF_REPORT_THRESHOLD
            and all(fact.evidence_grade == "self_reported" for _, fact, _ in rows)
            and all(
                event.event_type == "learner_concept_observation_recorded"
                for _, _, event in rows
            )
        )
        if exposure_only:
            return "knowledge_self_report"
        verified_events = {
            event.id for _, fact, event in rows if fact.evidence_grade == "verified"
        }
        transfer = any(
            event.event_type == "transfer_attempt_evaluated"
            and fact.evidence_grade == "verified"
            for _, fact, event in rows
        )
        if transfer:
            return "verified_transfer"
        if len(rows) >= 3 and len(verified_events) >= 2:
            return "knowledge_assessments"
    elif kernel_name == "human":
        explicit = any(
            (node.payload or {}).get("key") in EXPLICIT_PREFERENCE_KEYS
            and fact.evidence_grade == "self_reported"
            for node, fact, _ in rows
        )
        if explicit:
            return "explicit_preference"
        if event_count >= 3 and _sessions_count(rows) >= 2:
            return "human_cross_session"
    elif kernel_name == "value":
        confirmed = any(
            event.event_type == "career_goal_confirmed"
            or event.event_type == "vnext_value_claim_proposal_accepted"
            or (event.payload or {}).get("career_goal_status") == "confirmed"
            for _, _, event in rows
        )
        if confirmed:
            return "confirmed_goal"
        if event_count >= 3 and _sessions_count(rows) >= 2:
            return "value_cross_session"
    elif kernel_name == "practice":
        event_types = {event.event_type for _, _, event in rows}
        has_chain = (
            any("attempt" in item for item in event_types)
            and any("feedback" in item or "evaluated" in item for item in event_types)
            and len(rows) >= 3
        )
        independent_pass = any(
            fact.evidence_grade == "verified" for _, fact, _ in rows
        ) and any("attempt" in item for item in event_types)
        if has_chain or independent_pass:
            return "practice_chain"
    return None


def input_fingerprint(kernel_name: str, subject_key: str, fact_ids: list[int]) -> str:
    body = (
        f"{MODULE_VERSION_POLICY}|{kernel_name}|{subject_key}|"
        + ",".join(str(item) for item in sorted(fact_ids))
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


async def current_memory_module(
    db: AsyncSession,
    learner_id: int,
    kernel_name: str,
    subject_key: str,
    *, include_inactive: bool = False,
) -> tuple[MemoryNode, MemoryModule] | None:
    """Return the single current module snapshot for one kernel subject."""
    return (await db.execute(
        select(MemoryNode, MemoryModule)
        .join(MemoryModule, MemoryModule.node_id == MemoryNode.id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name == kernel_name,
            MemoryNode.subject_key == subject_key,
            MemoryNode.status.in_(["active", "legacy", "superseded", "retracted", "refined"] if include_inactive else ["active", "legacy"]),
        )
        .order_by(MemoryModule.version.desc(), MemoryNode.id.desc())
        .limit(1)
    )).first()


async def module_evidence_fact_ids(
    db: AsyncSession, module: MemoryModule,
) -> list[int]:
    """Read a module's evidence closure, including pre-versioning modules."""
    stored = [int(item) for item in (module.evidence_fact_ids or [])]
    if stored:
        return list(dict.fromkeys(stored))
    edge_ids = list((await db.execute(select(MemoryEdge.source_node_id).where(
        MemoryEdge.target_node_id == module.node_id,
        MemoryEdge.relation_type == "CONSOLIDATED_INTO",
    ).order_by(MemoryEdge.source_node_id.asc()))).scalars().all())
    consumed_ids = list((await db.execute(select(MemoryFact.node_id).where(
        MemoryFact.consumed_by_module_id == module.node_id,
    ).order_by(MemoryFact.node_id.asc()))).scalars().all())
    return list(dict.fromkeys(int(item) for item in edge_ids + consumed_ids))


async def module_delta_fact_ids(
    db: AsyncSession, module: MemoryModule,
) -> list[int]:
    """Read only the facts introduced by this module version."""
    stored = [int(item) for item in (module.delta_fact_ids or [])]
    if stored:
        return list(dict.fromkeys(stored))
    consumed_ids = list((await db.execute(select(MemoryFact.node_id).where(
        MemoryFact.consumed_by_module_id == module.node_id,
    ).order_by(MemoryFact.node_id.asc()))).scalars().all())
    if consumed_ids:
        return [int(item) for item in consumed_ids]
    return list((await db.execute(select(MemoryEdge.source_node_id).where(
        MemoryEdge.target_node_id == module.node_id,
        MemoryEdge.relation_type == "CONSOLIDATED_INTO",
    ).order_by(MemoryEdge.source_node_id.asc()))).scalars().all())


def _bounded_evidence_ids(base_ids: list[int], delta_ids: list[int]) -> list[int]:
    delta = list(dict.fromkeys(int(item) for item in delta_ids))
    delta_set = set(delta)
    base = [int(item) for item in base_ids if int(item) not in delta_set]
    room = max(0, MODULE_EVIDENCE_LIMIT - len(delta))
    return base[-room:] + delta if room else delta[-MODULE_EVIDENCE_LIMIT:]


async def effective_evidence_ids(db: AsyncSession, learner_id: int, kernel_name: str,
                                 subject_key: str, delta_ids: list[int]) -> list[int]:
    """Keep current same-subject evidence, prioritizing corrections and verification."""
    rows = (await db.execute(select(MemoryNode, MemoryFact).join(
        MemoryFact, MemoryFact.node_id == MemoryNode.id,
    ).where(
        MemoryNode.learner_id == learner_id, MemoryNode.kernel_name == kernel_name,
        MemoryNode.subject_key == subject_key, MemoryNode.status.in_(["active", "legacy"]),
        or_(MemoryFact.consumption_status.in_(["consumed", "reserved"]), MemoryNode.id.in_(delta_ids)),
    ).order_by(
        case((MemoryFact.evidence_grade == "corrected", 0),
             (MemoryFact.evidence_grade == "verified", 1), else_=2),
        MemoryNode.occurred_at.desc(), MemoryNode.id.desc(),
    ).limit(MODULE_EVIDENCE_LIMIT))).all()
    priority = [node.id for node, _ in rows if node.id not in delta_ids]
    room = max(0, MODULE_EVIDENCE_LIMIT - len(delta_ids))
    return sorted(set(priority[:room] + delta_ids))


def _refinement_trigger_reason(
    kernel_name: str,
    rows: list[tuple[MemoryNode, MemoryFact, EvidenceEvent]],
) -> str | None:
    """Trigger a new immutable version from meaningful evidence deltas."""
    decisive_grades = {"verified", "corrected", "self_reported"}
    if any(fact.evidence_grade in decisive_grades for _, fact, _ in rows):
        return "module_refinement"
    event_count = len({event.id for _, _, event in rows})
    if kernel_name in {"human", "value"}:
        return "module_refinement" if event_count >= 2 and _sessions_count(rows) >= 2 else None
    return "module_refinement" if event_count >= 2 else None


async def maybe_queue_synthesis(
    db: AsyncSession,
    learner_id: int,
    kernel_name: str,
    subject_key: str,
    *,
    trigger_event: EvidenceEvent,
) -> MemorySynthesisRun | None:
    rows = await _eligible_facts(db, learner_id, kernel_name, subject_key)
    current = await current_memory_module(db, learner_id, kernel_name, subject_key, include_inactive=True)
    reason = _trigger_reason(kernel_name, rows, trigger_event)
    if current and not reason:
        reason = _refinement_trigger_reason(kernel_name, rows)
    if not reason:
        return None
    delta_fact_ids = [node.id for node, _, _ in rows]
    base_node, base_module = current if current else (None, None)
    base_fact_ids = await module_evidence_fact_ids(db, base_module) if base_module else []
    evidence_fact_ids = await effective_evidence_ids(db, learner_id, kernel_name, subject_key, delta_fact_ids)
    fingerprint = input_fingerprint(kernel_name, subject_key, evidence_fact_ids)
    existing = (await db.execute(select(MemorySynthesisRun).where(
        MemorySynthesisRun.learner_id == learner_id,
        MemorySynthesisRun.input_fingerprint == fingerprint,
    ))).scalar_one_or_none()
    if existing:
        if existing.status == "failed" and (existing.attempt_count or 0) < MAX_SYNTHESIS_ATTEMPTS:
            existing.status = "queued"
            existing.due_at = datetime.utcnow() + timedelta(seconds=2 ** (existing.attempt_count or 0))
            existing.finished_at = None
            await db.flush()
        return existing
    immediate = reason in {
        "correction", "confirmation", "structure_boundary", "verified_transfer",
        "explicit_preference", "confirmed_goal",
    }
    pending = (await db.execute(select(MemorySynthesisRun).where(
        MemorySynthesisRun.learner_id == learner_id,
        MemorySynthesisRun.kernel_name == kernel_name,
        MemorySynthesisRun.subject_key == subject_key,
        MemorySynthesisRun.status == "queued",
    ).order_by(MemorySynthesisRun.id.desc()).limit(1))).scalar_one_or_none()
    if pending:
        pending.candidate_fact_ids = delta_fact_ids
        pending.evidence_fact_ids = evidence_fact_ids
        pending.base_module_node_id = base_node.id if base_node else None
        pending.target_module_version = int(base_module.version or 1) + 1 if base_module else 1
        pending.input_fingerprint = fingerprint
        pending.prompt_version = "memory-synthesis-v2"
        pending.trigger_reason = reason
        if immediate:
            pending.due_at = datetime.utcnow()
        await db.flush()
        return pending
    run = MemorySynthesisRun(
        learner_id=learner_id,
        kernel_name=kernel_name,
        subject_key=subject_key,
        status="queued",
        trigger_reason=reason,
        candidate_fact_ids=delta_fact_ids,
        evidence_fact_ids=evidence_fact_ids,
        base_module_node_id=base_node.id if base_node else None,
        target_module_version=int(base_module.version or 1) + 1 if base_module else 1,
        input_fingerprint=fingerprint,
        prompt_version="memory-synthesis-v2",
        due_at=datetime.utcnow() if immediate else datetime.utcnow() + timedelta(seconds=2),
    )
    db.add(run)
    await db.flush()
    return run


async def active_module_claims(
    db: AsyncSession,
    learner_id: int,
    *,
    kernel_name: str | None = None,
    project_id: int | None = None,
    limit: int = 20,
) -> list[dict]:
    query = (
        select(MemoryNode, MemoryClaim, MemoryModule)
        .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
        .join(MemoryModule, MemoryModule.node_id == MemoryClaim.module_node_id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.node_type == "claim",
            MemoryNode.status == "active",
        )
        .order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
        .limit(limit)
    )
    if kernel_name:
        query = query.where(MemoryNode.kernel_name == kernel_name)
    if project_id is not None:
        query = query.where(or_(
            MemoryNode.subject_key == f"project:{project_id}",
            MemoryNode.payload["project_id"].as_integer() == project_id,
        ))
    rows = (await db.execute(query)).all()
    return [{
        "id": node.id,
        "kernel": node.kernel_name,
        "subject": node.subject_key,
        "claim": node.text,
        "confidence": node.confidence,
        "verification_status": claim.verification_status,
        "module_id": claim.module_node_id,
        "occurred_at": node.occurred_at.isoformat(),
    } for node, claim, _ in rows]


async def recent_atomic_facts(
    db: AsyncSession,
    learner_id: int,
    kernel_name: str,
    *,
    limit: int = 8,
) -> list[dict]:
    rows = (await db.execute(
        select(MemoryNode, MemoryFact)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name == kernel_name,
            MemoryNode.status.in_(["active", "transient"]),
            MemoryFact.consumption_status.in_(["eligible", "reserved"]),
            or_(MemoryNode.valid_to.is_(None), MemoryNode.valid_to > datetime.utcnow()),
        )
        .order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
        .limit(limit)
    )).all()
    return [{
        "id": node.id,
        "subject": node.subject_key,
        "fact": node.text,
        "evidence_grade": fact.evidence_grade,
        "confidence": node.confidence,
        "occurred_at": node.occurred_at.isoformat(),
        "source_event_id": fact.source_event_id,
    } for node, fact in rows]


async def rebuild_kernel_long_term_from_modules(db: AsyncSession, learner_id: int) -> None:
    """Project active claims without erasing the existing low-latency fields."""
    for kernel_name in KERNEL_NAMES:
        state = (await db.execute(select(KernelState).where(
            KernelState.learner_id == learner_id,
            KernelState.kernel_name == kernel_name,
        ))).scalar_one_or_none()
        if not state:
            continue
        claims = await active_module_claims(
            db, learner_id, kernel_name=kernel_name, limit=50,
        )
        long_term = dict(state.long_term or {})
        long_term["memory_graph_claims"] = claims
        state.long_term = long_term
        state.updated_at = datetime.utcnow()


async def backfill_memory_graph(db: AsyncSession) -> dict[str, int]:
    """Idempotently backfill event timing, mutation facts, and legacy modules."""
    event_count = 0
    learners = list((await db.execute(
        select(EvidenceEvent.learner_id).distinct()
    )).scalars().all())
    for learner_id in learners:
        events = (await db.execute(select(EvidenceEvent).where(
            EvidenceEvent.learner_id == learner_id,
        ).order_by(EvidenceEvent.created_at.asc(), EvidenceEvent.id.asc()))).scalars().all()
        seq = 0
        for event in events:
            seq += 1
            changed = False
            if event.occurred_at is None:
                event.occurred_at = event.created_at or datetime.utcnow()
                changed = True
            if event.learner_seq is None:
                event.learner_seq = seq
                changed = True
            if not event.actor_type:
                event.actor_type = actor_type_for_source(event.source)
                changed = True
            event_count += int(changed)
        await db.flush()

    fact_count = 0
    mutations = (await db.execute(select(KernelMutation).where(
        KernelMutation.event_id.is_not(None),
        KernelMutation.status == "applied",
    ).order_by(KernelMutation.id.asc()))).scalars().all()
    for mutation in mutations:
        event = await db.get(EvidenceEvent, mutation.event_id)
        if not event:
            continue
        facts = await create_facts_for_mutation(
            db, event, mutation, queue_synthesis=False,
        )
        fact_count += len(facts)

    module_count = 0
    states = (await db.execute(select(KernelState))).scalars().all()
    for state in states:
        if not state.long_term:
            continue
        fingerprint = hashlib.sha256(
            f"legacy|{state.learner_id}|{state.kernel_name}|".encode("utf-8")
            + json.dumps(state.long_term, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        exists = (await db.execute(select(MemoryModule.node_id).where(
            MemoryModule.input_fingerprint == fingerprint,
        ))).scalar_one_or_none()
        if exists:
            continue
        now = state.updated_at or datetime.utcnow()
        summary = f"迁移的{state.kernel_name}长期记忆"
        node = MemoryNode(
            learner_id=state.learner_id,
            node_type="module",
            kernel_name=state.kernel_name,
            memory_kind="topic_summary",
            subject_key="legacy:kernel-state",
            subject_type="legacy",
            subject_id="kernel-state",
            text=summary,
            payload={"legacy": True, "unverified": True},
            confidence=min(state.confidence or 0.0, 0.4),
            salience=0.2,
            schema_version=MEMORY_SCHEMA_VERSION,
            status="legacy",
            occurred_at=now,
            valid_from=now,
        )
        db.add(node)
        await db.flush()
        db.add(MemoryModule(
            node_id=node.id,
            synthesis_run_id=None,
            module_type="legacy_import",
            summary=summary,
            time_start=now,
            time_end=now,
            input_fingerprint=fingerprint,
            immutable=True,
        ))
        await db.flush()
        for ordinal, (key, value) in enumerate((state.long_term or {}).items()):
            claim_node = MemoryNode(
                learner_id=state.learner_id,
                node_type="claim",
                kernel_name=state.kernel_name,
                memory_kind="semantic_claim",
                subject_key="legacy:kernel-state",
                subject_type="legacy",
                subject_id="kernel-state",
                text=f"{key}: {_compact(value)}",
                payload={"legacy": True, "project_id": None},
                confidence=min(state.confidence or 0.0, 0.4),
                salience=0.2,
                schema_version=MEMORY_SCHEMA_VERSION,
                status="legacy",
                occurred_at=now,
                valid_from=now,
            )
            db.add(claim_node)
            await db.flush()
            db.add(MemoryClaim(
                node_id=claim_node.id,
                module_node_id=node.id,
                claim_ordinal=ordinal,
                predicate=f"legacy.{key}",
                value=value,
                verification_status="unverified",
            ))
        module_count += 1
    await db.flush()
    return {"events": event_count, "facts": fact_count, "modules": module_count}


async def backfill_module_versions(db: AsyncSession) -> dict[str, int]:
    """Assign immutable version chains and cumulative evidence to existing modules."""
    rows = list((await db.execute(
        select(MemoryNode, MemoryModule)
        .join(MemoryModule, MemoryModule.node_id == MemoryNode.id)
        .order_by(
            MemoryNode.learner_id.asc(), MemoryNode.kernel_name.asc(),
            MemoryNode.subject_key.asc(), MemoryNode.occurred_at.asc(), MemoryNode.id.asc(),
        )
    )).all())
    groups: dict[tuple[int, str, str], list[tuple[MemoryNode, MemoryModule]]] = {}
    for node, module in rows:
        groups.setdefault(
            (node.learner_id, node.kernel_name, node.subject_key), [],
        ).append((node, module))

    versioned = 0
    historical = 0
    for group in groups.values():
        cumulative: list[int] = []
        previous_id: int | None = None
        for index, (node, module) in enumerate(group, start=1):
            direct_ids = await module_delta_fact_ids(db, module)
            cumulative = _bounded_evidence_ids(cumulative, direct_ids)
            module.version = index
            module.parent_module_node_id = previous_id
            module.revision_kind = (
                "correction" if module.module_type == "correction"
                else "confirmation" if module.module_type == "confirmation"
                else "initial" if index == 1
                else "refinement"
            )
            module.evidence_fact_ids = cumulative
            module.delta_fact_ids = direct_ids
            module.policy_version = MODULE_VERSION_POLICY
            node.payload = {
                **dict(node.payload or {}),
                "module_version": index,
                "parent_module_node_id": previous_id,
                "evidence_fact_ids": cumulative,
                "delta_fact_ids": direct_ids,
                "policy_version": MODULE_VERSION_POLICY,
            }
            claim_nodes = list((await db.execute(
                select(MemoryNode)
                .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
                .where(MemoryClaim.module_node_id == node.id)
            )).scalars().all())
            for claim_node in claim_nodes:
                claim_node.payload = {
                    **dict(claim_node.payload or {}),
                    "module_version": index,
                }
            if previous_id is not None:
                await _add_edge(
                    db,
                    learner_id=node.learner_id,
                    source_node_id=node.id,
                    target_node_id=previous_id,
                    relation_type=(
                        "SUPERSEDES" if module.revision_kind == "correction" else "REFINES"
                    ),
                    origin="module_version_migration",
                    confidence=node.confidence or 0,
                )
            if index < len(group) and node.status in {"active", "legacy"}:
                node.status = "refined"
                for claim_node in claim_nodes:
                    if claim_node.status in {"active", "legacy"}:
                        claim_node.status = "refined"
                historical += 1
            previous_id = node.id
            versioned += 1
    await db.flush()
    return {"versioned_modules": versioned, "historical_modules": historical}
