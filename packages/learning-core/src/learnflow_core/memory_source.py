"""Read-only text sources backed by the existing memory authority chain.

The caller supplies its existing visibility predicate and sensitive-field set.
This module neither invents evidence nor exposes arbitrary Event/JSON payloads.
Offsets always refer to the indicated source string, never a synthetic prefix.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from typing import Callable, Collection, Iterable

from sqlalchemy import select

from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, MemoryFact, MemoryNode
from app.models.project import Checkpoint, Project, Roadmap
from .memory_excerpt import excerpt as source_excerpt
from .registry_core import SEMANTIC_MEMORY_KEYS


SOURCE_PROJECTION_VERSION = "memory-source.v1"
MAX_SOURCE_CHARS = 65536
_BATCH_SIZE = 256
# Reviewed reducer shapes only. No recursive search through arbitrary JSON.
_NESTED_FIELDS = {
    ("knowledge", "concept_observation", "learner_concept_observation_recorded"): "statement",
    ("structure", "concept_relation", "learner_concept_relation_recorded"): "rationale",
}


@dataclass(frozen=True)
class SourceDocument:
    node_id: int
    text: str
    source_kind: str
    source_hash: str
    source_path: str
    source_event_id: int | None = None
    source_mutation_id: int | None = None
    fallback_reason: str | None = None

    def excerpt(self, terms=(), *, limit=640) -> tuple[str, dict]:
        rendered, metadata = source_excerpt(self.text, terms, limit=limit)
        metadata.update(source_kind=self.source_kind, source_path=self.source_path)
        if self.source_event_id is not None:
            metadata["source_event_id"] = self.source_event_id
            metadata["source_mutation_id"] = self.source_mutation_id
        if self.fallback_reason:
            metadata["fallback_reason"] = self.fallback_reason
        return rendered, metadata


def _document(node, text, kind, path, *, event=None, mutation=None, reason=None):
    return SourceDocument(node_id=node.id, text=text, source_kind=kind,
        source_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(), source_path=path,
        source_event_id=event.id if event is not None else None,
        source_mutation_id=mutation.id if mutation is not None else None, fallback_reason=reason)


def _scope(entity):
    return tuple(getattr(entity, field, None) for field in ("project_id", "checkpoint_id", "session_id"))


def _time(value):
    if not isinstance(value, datetime):
        return None
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _unsafe_payload(value, sensitive_fields):
    """Reuse the caller's field authority and fail closed on uninspected tails."""
    pending, inspected = [value], 0
    while pending:
        inspected += 1
        if inspected > 2048:
            return True
        current = pending.pop()
        if isinstance(current, dict):
            if len(current) + len(pending) > 2048 - inspected:
                return True
            if any(str(key).casefold() in sensitive_fields for key in current):
                return True
            pending.extend(current.values())
        elif isinstance(current, list):
            if len(current) + len(pending) > 2048 - inspected:
                return True
            pending.extend(current)
    return False


async def resolve_source_documents(
    db, *, learner_id: int, nodes: Iterable[MemoryNode],
    node_allowed: Callable[[MemoryNode, MemoryFact | None], bool],
    sensitive_fields: Collection[str], now: datetime | None = None,
) -> dict[int, SourceDocument]:
    """Resolve safe Fact values in batches; other allowed nodes retain node_text.

    Visibility/archives/current request scope are owned by ``node_allowed``.
    The resolver additionally checks the immutable source links and real entity
    ownership. Human or caller-rejected nodes are absent, not compact fallbacks.
    Fact-less adapters (including LoCoMo) retain their original node text.
    No autoflush, source mutation, historical backfill or network call occurs.
    """
    at = _time(now or datetime.utcnow())
    if at is None:
        raise ValueError("now must be a datetime")
    fields = frozenset(str(value).casefold() for value in sensitive_fields)
    selected = {node.id: node for node in nodes
                if type(node.id) is int and node.id > 0 and node.learner_id == learner_id
                and node.kernel_name != "human"}
    documents = {}
    identifiers = list(selected)
    with db.no_autoflush:
        for start in range(0, len(identifiers), _BATCH_SIZE):
            ids = identifiers[start:start + _BATCH_SIZE]
            facts = {fact.node_id: fact for fact in (await db.execute(select(MemoryFact).where(
                MemoryFact.node_id.in_(ids)))).scalars()}
            events = {event.id: event for event in (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.id.in_({fact.source_event_id for fact in facts.values()} or {-1}),
                EvidenceEvent.learner_id == learner_id))).scalars()}
            mutations = {mutation.id: mutation for mutation in (await db.execute(select(KernelMutation).where(
                KernelMutation.id.in_({fact.source_mutation_id for fact in facts.values()} or {-1}),
                KernelMutation.learner_id == learner_id))).scalars()}
            project_ids = {event.project_id for event in events.values() if event.project_id is not None}
            owned_projects = set((await db.execute(select(Project.id).where(
                Project.id.in_(project_ids or {-1}), Project.learner_id == learner_id,
                Project.visibility != "deleted"))).scalars())
            checkpoint_ids = {event.checkpoint_id for event in events.values() if event.checkpoint_id is not None}
            checkpoints = dict((await db.execute(select(Checkpoint.id, Roadmap.project_id)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .join(Project, Project.id == Roadmap.project_id).where(
                    Checkpoint.id.in_(checkpoint_ids or {-1}), Checkpoint.archived.is_(False),
                    Project.learner_id == learner_id, Project.visibility != "deleted"))).all())
            session_ids = {event.session_id for event in events.values() if event.session_id is not None}
            sessions = {session.id: session for session in (await db.execute(select(AgentSession).where(
                AgentSession.id.in_(session_ids or {-1}), AgentSession.learner_id == learner_id))).scalars()}
            for identifier in ids:
                node, fact = selected[identifier], facts.get(identifier)
                if not node_allowed(node, fact):
                    continue
                reason = "no_native_fact"
                event = events.get(fact.source_event_id) if fact else None
                mutation = mutations.get(fact.source_mutation_id) if fact else None
                if fact is not None:
                    reason = _chain_error(node, fact, event, mutation, at, owned_projects,
                                          checkpoints, sessions, fields)
                    if reason is None:
                        value, path, kind = _source_value(node, fact, event)
                        if not isinstance(value, str) or not value.strip():
                            reason = "unsupported_source_shape"
                        elif len(value) > MAX_SOURCE_CHARS:
                            reason = "source_size_limit"
                        else:
                            documents[identifier] = _document(node, value, kind, path,
                                                             event=event, mutation=mutation)
                            continue
                documents[identifier] = _document(node, node.text, "node_text", "/text", reason=reason)
    return documents


def _chain_error(node, fact, event, mutation, at, projects, checkpoints, sessions, fields):
    # memory_graph imports the context schema; resolve this edge only at call time.
    from .memory_graph import _compact, _fact_pairs

    if node.node_type != "fact" or event is None or mutation is None:
        return "missing_native_chain"
    if (mutation.event_id != event.id or mutation.status != "applied"
            or mutation.kernel_name != node.kernel_name or mutation.learner_id != node.learner_id
            or event.learner_id != node.learner_id):
        return "invalid_native_chain"
    if _scope(node) != _scope(fact) or _scope(node) != _scope(event):
        return "source_scope_mismatch"
    if (node.status not in {"active", "legacy"} or fact.consumption_status not in {"eligible", "reserved", "consumed"}
            or _time(event.occurred_at) is None or _time(event.occurred_at) > at
            or _time(node.occurred_at) != _time(event.occurred_at)
            or node.valid_from is not None and (_time(node.valid_from) is None or _time(node.valid_from) > at)
            or node.valid_to is not None and (_time(node.valid_to) is None or _time(node.valid_to) <= at)):
        return "inactive_or_future_source"
    if event.project_id is not None and event.project_id not in projects:
        return "source_project_unavailable"
    if event.checkpoint_id is not None and (event.checkpoint_id not in checkpoints
            or event.project_id is not None and checkpoints[event.checkpoint_id] != event.project_id):
        return "source_checkpoint_unavailable"
    if event.session_id is not None:
        session = sessions.get(event.session_id)
        if (session is None or session.session_type in {"project", "checkpoint"}
                and session.project_id != event.project_id
                or session.session_type == "checkpoint" and session.checkpoint_id != event.checkpoint_id):
            return "source_session_mismatch"
    if (_unsafe_payload(event.payload, fields) or _unsafe_payload(mutation.patch, fields)
            or _unsafe_payload(fact.object_value, fields)):
        return "sensitive_source_payload"
    if (not isinstance(event.payload, dict) or not isinstance(node.payload, dict)
            or not isinstance(mutation.patch, dict)
            or any(not isinstance(mutation.patch.get(scope) or {}, dict)
                   for scope in ("short_term", "long_term"))):
        return "invalid_source_shape"
    pairs = _fact_pairs(mutation)
    if type(fact.fact_ordinal) is not int or not 0 <= fact.fact_ordinal < len(pairs):
        return "source_ordinal_mismatch"
    scope, key, value = pairs[fact.fact_ordinal]
    payload = node.payload or {}
    if (fact.predicate != f"{scope}.{key}" or fact.object_value != value
            or payload.get("scope") != scope or payload.get("key") != key
            or payload.get("event_type") != event.event_type
            or node.text != f"{key}: {_compact(value)}"):
        return "source_value_mismatch"
    return None


def _source_value(node, fact, event):
    key = (node.payload or {}).get("key")
    if key in SEMANTIC_MEMORY_KEYS.get(node.kernel_name, ()) and isinstance(fact.object_value, str):
        return fact.object_value, "/object_value", "fact_object_value"
    field = _NESTED_FIELDS.get((node.kernel_name, key, event.event_type))
    if field and isinstance(fact.object_value, dict):
        return fact.object_value.get(field), f"/object_value/{field}", "fact_object_field"
    return None, None, None
