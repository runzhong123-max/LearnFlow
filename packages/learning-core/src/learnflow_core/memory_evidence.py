"""Owned, bounded inspection of evidence and recorded dependencies.

This is a read-only view, never an alternative profile or a grading authority.
Raw answers, submissions and arbitrary Event payloads are not returned.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import and_, or_, select

from app.models.learning import (AgentSession, EvidenceEvent, KernelMutation, MemoryClaim,
    MemoryEdge, MemoryFact, MemoryModule, MemoryNode, ReviewSchedule)
from app.models.project import Checkpoint, Project, Roadmap
from .memory_excerpt import excerpt
from .memory_source import _unsafe_payload

SCHEMA_VERSION = "learnflow.memory-evidence.v1"
SOURCE_LIMIT = 20
LINK_LIMIT = 40
_TITLES = {
    "artifact_state": "本次正式作答结果", "recent_feedback": "本次反馈",
    "mastery": "间隔复习的当前资格", "proof_chain": "独立实践依据",
    "retention_status": "复习表现记录", "review_history": "复习尝试记录",
    "concept_understanding": "概念理解记录", "pending_question": "尚待解决的问题",
    "current_priority": "当前学习重点", "current_goal": "学习目标",
    "learning_path_plans": "已确认的学习安排", "concept_observation": "概念学习记录",
}


def _iso(value):
    return value.isoformat() if value else None


def _scope(row):
    return tuple(getattr(row, key, None) for key in ("project_id", "checkpoint_id", "session_id"))


def _fits(node, learner_id, project_id=None, checkpoint_id=None):
    return (node.learner_id == learner_id
            and (project_id is None or node.project_id == project_id)
            and (checkpoint_id is None or node.checkpoint_id == checkpoint_id))


async def inspection_scope(db, learner_id, project_id=None, checkpoint_id=None, review_schedule_id=None):
    schedule = None
    if review_schedule_id is not None:
        schedule = (await db.execute(select(ReviewSchedule).where(
            ReviewSchedule.id == review_schedule_id, ReviewSchedule.learner_id == learner_id))).scalar_one_or_none()
        if not schedule or (project_id is not None and project_id != schedule.project_id) or (
                checkpoint_id is not None and checkpoint_id != schedule.checkpoint_id):
            raise HTTPException(404, "学习记录不存在或不可访问")
        project_id, checkpoint_id = schedule.project_id, schedule.checkpoint_id
    if checkpoint_id is not None:
        owned = (await db.execute(select(Roadmap.project_id).join(Checkpoint,
            Checkpoint.roadmap_id == Roadmap.id).join(Project, Project.id == Roadmap.project_id).where(
                Checkpoint.id == checkpoint_id, Project.learner_id == learner_id,
                Project.visibility != "deleted", Checkpoint.archived.is_(False)))).scalar_one_or_none()
        if owned is None or project_id is not None and project_id != owned:
            raise HTTPException(404, "学习记录不存在或不可访问")
        project_id = owned
    if project_id is not None:
        owned = (await db.execute(select(Project.id).where(Project.id == project_id,
            Project.learner_id == learner_id, Project.visibility != "deleted"))).scalar_one_or_none()
        if owned is None:
            raise HTTPException(404, "学习记录不存在或不可访问")
    return project_id, checkpoint_id, schedule


async def _source(db, learner_id, node, fact):
    from .memory_graph import _fact_pairs
    from .five_kernel_context import SENSITIVE_FIELDS
    if not fact:
        return None
    event = await db.get(EvidenceEvent, fact.source_event_id)
    mutation = await db.get(KernelMutation, fact.source_mutation_id)
    if (not event or not mutation or node.learner_id != learner_id
            or event.learner_id != learner_id or mutation.learner_id != learner_id
            or mutation.event_id != event.id or mutation.status != "applied"
            or mutation.kernel_name != node.kernel_name or _scope(node) != _scope(fact)
            or _scope(fact) != _scope(event)):
        return None
    pairs = _fact_pairs(mutation)
    ordinal = fact.fact_ordinal
    if not isinstance(ordinal, int) or not 0 <= ordinal < len(pairs):
        return None
    scope, key, value = pairs[ordinal]
    if fact.predicate != f"{scope}.{key}" or fact.object_value != value:
        return None
    try:
        await inspection_scope(db, learner_id, event.project_id, event.checkpoint_id)
    except HTTPException:
        return None
    if event.session_id is not None:
        session = await db.get(AgentSession, event.session_id)
        if (not session or session.learner_id != learner_id
                or session.session_type in {"project", "checkpoint"} and session.project_id != event.project_id
                or session.session_type == "checkpoint" and session.checkpoint_id != event.checkpoint_id):
            return None
    # Older aggregate snapshots can contain values inherited from other items
    # or projects. Never attribute that whole map to this event's scope.
    if fact.predicate in {"long_term.mastery", "long_term.proof_chain",
                          "short_term.retention_status", "short_term.review_history",
                          "short_term.concept_understanding"} and isinstance(value, dict):
        if len(value) > 1:
            return None
        if event.event_type == "review_attempt_evaluated":
            payload = event.payload or {}
            item = f"{payload.get('source_item_type') or payload.get('item_type') or 'concept'}:{payload.get('item_id')}"
            expected = "review:" + item if scope == "long_term" else item
            if set(value) != {expected}:
                return None
    # Inspect a safe Fact value, not an arbitrary event, answer or submission.
    if _unsafe_payload(value, SENSITIVE_FIELDS):
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    if not text or len(text) > 65536:
        return None
    quote, meta = excerpt(text, (), limit=900)
    payload = event.payload or {}
    qualifiers = {
        "evidence_grade": fact.evidence_grade,
        "assistance_level": str(payload.get("assistance_level", ""))[:40],
        "question_form": str(payload.get("question_form", ""))[:40],
        "independent": payload.get("independent") if isinstance(payload.get("independent"), bool) else None,
        "outcome": str(payload.get("outcome") or ("correct" if payload.get("passed", payload.get("correct")) is True else "incorrect" if payload.get("passed", payload.get("correct")) is False else ""))[:40],
    }
    return {"node_id": node.id, "event_id": event.id, "mutation_id": mutation.id,
            "predicate": fact.predicate, "source_path": "/object_value",
            "source_format": "text" if isinstance(value, str) else "canonical_json",
            "source_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": quote, "ranges": meta["ranges"], "truncated": bool(meta.get("truncated")),
            "qualifier_spans_omitted": meta.get("qualifier_spans_omitted", 0),
            "occurred_at": _iso(event.occurred_at), "status": node.status,
            "qualifiers": qualifiers, "event_type": event.event_type}


def _brief(node):
    key = (node.payload or {}).get("key", "")
    title = _TITLES.get(key, "学习依据" if node.node_type == "fact" else "相关学习认识")
    return {"id": node.id, "kind": node.node_type, "kernel": node.kernel_name,
            "title": title, "status": node.status, "occurred_at": _iso(node.occurred_at)}


async def evidence_card(db, learner_id, node_id, *, project_id=None, checkpoint_id=None, _invalid_ids=None):
    project_id, checkpoint_id, _ = await inspection_scope(db, learner_id, project_id, checkpoint_id)
    node = await db.get(MemoryNode, node_id)
    if not node or not _fits(node, learner_id, project_id, checkpoint_id):
        raise HTTPException(404, "学习依据不存在或不可访问")
    # Root ownership is not enough: every source and neighbour is checked.
    project_id = node.project_id if project_id is None else project_id
    checkpoint_id = node.checkpoint_id if checkpoint_id is None else checkpoint_id
    await inspection_scope(db, learner_id, project_id, checkpoint_id)
    module = await db.get(MemoryModule, node_id)
    claim = await db.get(MemoryClaim, node_id)
    support = list((await db.execute(select(MemoryEdge.source_node_id).where(
        MemoryEdge.learner_id == learner_id, MemoryEdge.target_node_id == node_id,
        MemoryEdge.relation_type == "SUPPORTS").order_by(MemoryEdge.id).limit(SOURCE_LIMIT + 1))).scalars())
    declared = module.evidence_fact_ids if module else (node.payload or {}).get("evidence_fact_ids")
    declared = [i for i in declared if type(i) is int and i > 0] if isinstance(declared, list) else []
    identifiers = [node_id] if node.node_type == "fact" else list(dict.fromkeys(support + declared))
    identifiers = [i for i in identifiers if type(i) is int and i > 0]
    sources = []
    for identifier in identifiers[:SOURCE_LIMIT]:
        source_node = await db.get(MemoryNode, identifier)
        if not source_node or not _fits(source_node, learner_id, project_id, checkpoint_id):
            continue
        source = await _source(db, learner_id, source_node, await db.get(MemoryFact, identifier))
        if source:
            sources.append(source)
    edges = list((await db.execute(select(MemoryEdge).where(
        MemoryEdge.learner_id == learner_id,
        or_(MemoryEdge.source_node_id == node_id, MemoryEdge.target_node_id == node_id),
        MemoryEdge.relation_type.in_(("SUPPORTS", "CONSOLIDATED_INTO", "SUPERSEDES", "REFINES", "CONTRADICTS")),
    ).order_by(MemoryEdge.id.desc()).limit(LINK_LIMIT + 1))).scalars())
    links = []
    for edge in edges[:LINK_LIMIT]:
        other_id = edge.target_node_id if edge.source_node_id == node_id else edge.source_node_id
        other = await db.get(MemoryNode, other_id)
        if not other or not _fits(other, learner_id, project_id, checkpoint_id):
            continue
        try:
            await inspection_scope(db, learner_id, other.project_id, other.checkpoint_id)
        except HTTPException:
            continue
        links.append({**_brief(other), "relation": edge.relation_type,
                      "direction": "out" if edge.source_node_id == node_id else "in"})
    from .review_qualification import read_guard
    invalid_ids = _invalid_ids
    if invalid_ids is None:
        _, invalid_ids = await read_guard(db, learner_id)
    historical = node.status not in {"active", "transient", "legacy"}
    now = datetime.utcnow()
    expired = node.valid_to is not None and node.valid_to.replace(tzinfo=None) <= now
    qualification = None
    fact = await db.get(MemoryFact, node_id)
    if sources and fact and isinstance(fact.object_value, dict):
        qualification = next((v for v in fact.object_value.values() if isinstance(v, dict)
                              and v.get("policy_version") == "review-qualification.v2"), None)
    return {"schema_version": SCHEMA_VERSION, **_brief(node),
            "statement": node.text if claim or module else "",
            "scope": {"project_id": project_id, "checkpoint_id": checkpoint_id, "session_id": node.session_id},
            "availability": "historical" if historical else "expired" if expired else (
                "invalidated" if node.id in invalid_ids or qualification and qualification.get("eligibility") == "invalidated" else "current"),
            "qualification": qualification,
            "sources": sources, "links": links,
            "coverage": {"source_total": len(identifiers), "source_returned": len(sources),
                         "sources_truncated": len(identifiers) > SOURCE_LIMIT,
                         "links_truncated": len(edges) > LINK_LIMIT,
                         "complete": bool(identifiers) and len(sources) == len(identifiers)},
            "correction": {"claim_id": node.id if claim else None,
                           "allowed": bool(claim and node.status in {"active", "legacy"}),
                           "formal_assessment_editable": False},
            "boundary": "已记录的证据关系；不推断未记录的任务消费。历史成功保留，当前资格另行判断。"}


async def list_evidence_cards(db, learner_id, *, project_id=None, checkpoint_id=None,
                              review_schedule_id=None, before_id=None, limit=8):
    project_id, checkpoint_id, schedule = await inspection_scope(
        db, learner_id, project_id, checkpoint_id, review_schedule_id)
    query = select(MemoryNode).where(MemoryNode.learner_id == learner_id,
                                     MemoryNode.node_type == "fact")
    if project_id is not None:
        query = query.where(MemoryNode.project_id == project_id)
    if checkpoint_id is not None:
        query = query.where(MemoryNode.checkpoint_id == checkpoint_id)
    if before_id is not None:
        query = query.where(MemoryNode.id < before_id)
    if schedule:
        query = query.join(MemoryFact, MemoryFact.node_id == MemoryNode.id).join(
            EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id).where(
                EvidenceEvent.learner_id == learner_id,
                EvidenceEvent.payload["item_id"].as_integer() == schedule.item_id,
                or_(and_(
                    EvidenceEvent.event_type == "review_attempt_evaluated",
                    or_(EvidenceEvent.payload["source_item_type"].as_string() == schedule.item_type,
                        EvidenceEvent.payload["item_type"].as_string() == schedule.item_type),
                    MemoryFact.predicate.in_(("long_term.mastery", "long_term.proof_chain", "short_term.retention_status")),
                ), and_(
                    EvidenceEvent.event_type == ("concept_attempt_evaluated" if schedule.item_type == "concept" else "exercise_attempt_evaluated"),
                    MemoryFact.predicate.in_(("short_term.artifact_state", "short_term.recent_feedback", "short_term.pending_question")),
                )),
            )
    nodes = list((await db.execute(query.order_by(MemoryNode.id.desc()).limit(limit + 1))).scalars())
    from .review_qualification import read_guard
    _, invalid_ids = await read_guard(db, learner_id)
    cards = []
    for node in nodes[:limit]:
        try:
            cards.append(await evidence_card(db, learner_id, node.id, project_id=project_id,
                                             checkpoint_id=checkpoint_id, _invalid_ids=invalid_ids))
        except HTTPException as error:
            if error.status_code != 404:
                raise
            # A deleted project must not break a learner-wide inspection page.
            continue
    return {"schema_version": SCHEMA_VERSION, "cards": cards,
            "next_before_id": nodes[limit - 1].id if len(nodes) > limit else None}
