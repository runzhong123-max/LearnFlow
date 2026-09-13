"""Current review qualification, distinct from immutable historical successes.

Only the reducer persists this value. Read surfaces reuse the existing spaced
review rule; this module does not grade attempts or introduce a second state.
"""
from __future__ import annotations

POLICY_VERSION = "review-qualification.v2"


def qualification_patch(previous, event, matching, *, practice=False):
    previous = dict(previous or {})
    if not matching and not previous:
        return None
    stable = bool(matching)
    passed = bool((event.payload or {}).get("passed"))
    evidence_ids = [row.id for row in matching[-10:]] if stable else []
    historical = previous.get("historical_evidence_ids", [])
    if not stable and previous.get("evidence_ids"):
        historical = previous["evidence_ids"]
    value = {
        "policy_version": POLICY_VERSION,
        "eligibility": "current" if stable else "invalidated",
        "evidence_ids": evidence_ids,
        "historical_evidence_ids": list(historical),
        "updated_by_event_id": event.id,
        "invalidated_by_event_id": None if stable else (
            event.id if not passed else previous.get("invalidated_by_event_id")
        ),
        "project_id": event.project_id,
        "checkpoint_id": event.checkpoint_id,
    }
    if practice:
        value.update(event_id=event.id, kind=("spaced_independent_transfer" if stable
                                            else "historical_spaced_independent_transfer"))
    else:
        value["level"] = "stable" if stable else "needs_review"
    return value


async def read_guard(db, learner_id):
    """Revoke legacy stable projections at read time, without migrating history.

    Uses the most recent failure after the cited successful events. A later
    requalification must carry fresh evidence, not resurrect the old citation.
    Returns detached replacements and IDs to omit from current-only readers.
    """
    from datetime import datetime
    from sqlalchemy import select
    from app.models.learning import EvidenceEvent, KernelState, MemoryFact, MemoryNode
    events = list((await db.execute(select(EvidenceEvent).where(
        EvidenceEvent.learner_id == learner_id,
        EvidenceEvent.event_type == "review_attempt_evaluated",
        EvidenceEvent.occurred_at <= datetime.utcnow(),
    ))).scalars())
    by_id = {event.id: event for event in events}
    failures = {}
    def order(event):
        return (event.occurred_at or event.created_at, event.id)
    for event in events:
        payload = event.payload or {}
        if payload.get("passed") is not False:
            continue
        key = f"review:{payload.get('source_item_type', '')}:{payload.get('item_id', '')}"
        if key not in failures or order(event) > order(failures[key]):
            failures[key] = event
    if not failures:
        return {}, set()
    def replacement(key, value):
        if not isinstance(value, dict) or not (value.get("level") == "stable" or
                value.get("kind") == "spaced_independent_transfer"):
            return None
        failure = failures.get(key)
        if failure is None:
            return None
        ids = value.get("evidence_ids") or []
        cited = [by_id[i] for i in ids if type(i) is int and i in by_id]
        if cited and max(order(event) for event in cited) >= order(failure):
            return None
        return qualification_patch(value, failure, [], practice="kind" in value)
    overrides = {}
    for state in (await db.execute(select(KernelState).where(
            KernelState.learner_id == learner_id,
            KernelState.kernel_name.in_(("knowledge", "practice"))))).scalars():
        field = "mastery" if state.kernel_name == "knowledge" else "proof_chain"
        values = (state.long_term or {}).get(field) or {}
        if isinstance(values, dict):
            changed = {key: update for key, value in values.items()
                       if (update := replacement(key, value)) is not None}
            if changed:
                overrides[state.kernel_name] = {field: {**values, **changed}}
    invalid = set()
    for node, fact in (await db.execute(select(MemoryNode, MemoryFact).join(
            MemoryFact, MemoryFact.node_id == MemoryNode.id).where(
                MemoryNode.learner_id == learner_id, MemoryNode.status.in_(("active", "legacy")),
                MemoryFact.predicate.in_(("long_term.mastery", "long_term.proof_chain", "short_term.retention_status"))))).all():
        values = fact.object_value
        if fact.predicate == "short_term.retention_status" and isinstance(values, dict):
            values = {"review:" + key: {"level": "stable", "evidence_ids": [value.get("evidence_id")]}
                      for key, value in values.items() if isinstance(value, dict) and value.get("status") == "spaced_stable"}
        if isinstance(values, dict) and any(replacement(key, value) is not None for key, value in values.items()):
            invalid.add(node.id)
    # Existing modules/claims store the transitive evidence closure. Do not
    # infer dependencies from prose. A mixed old snapshot is withheld whole.
    if invalid:
        for node in (await db.execute(select(MemoryNode).where(
                MemoryNode.learner_id == learner_id,
                MemoryNode.node_type.in_(("module", "claim")),
                MemoryNode.status.in_(("active", "legacy"))))).scalars():
            declared = (node.payload or {}).get("evidence_fact_ids") or []
            if isinstance(declared, list) and invalid.intersection(i for i in declared if type(i) is int):
                invalid.add(node.id)
    return overrides, invalid
