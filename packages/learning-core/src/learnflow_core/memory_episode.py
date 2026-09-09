"""Rebuildable learning episodes from checked ledger links; never a new writer.

The first version supports native concept/exercise assessment events. A shared
topic, nearby ID or nearby timestamp never establishes an attempt association.
No Attempt submission, grader answer, explanation or event free text is copied.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from sqlalchemy import func, select

from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, LearningAttempt, MemoryFact, MemoryNode
from app.models.project import Checkpoint, ConceptQuestion, Exercise, Project, Roadmap
from learnflow_core.memory_excerpt import excerpt

EPISODE_SCHEMA_VERSION = 'learnflow.learning-episode.v1'
ASSESSMENT_EVENTS = {'concept_attempt_evaluated': 'concept', 'exercise_attempt_evaluated': 'exercise'}
MAX_ANCHORS, MAX_EVENTS, MAX_FACTS = 24, 48, 96


def _integer(value):
    return value if type(value) is int and value > 0 else None


def _scope(entity):
    return tuple(getattr(entity, name, None) for name in ('project_id', 'checkpoint_id', 'session_id'))


async def collect_learning_episodes(db, *, learner_id, anchors, node_allowed, scope_predicates,
                                    terms=(), max_facts=6, now):
    """Return atomic candidate episodes and bounded rejection diagnostics.

    Every observation has a valid Fact -> applied Mutation -> eligible Event
    chain with identical scope. Event item/learner/project/checkpoint must also
    agree with the evaluated Attempt and its real owned checkpoint/project.
    Human and disallowed nodes are rejected by the same caller filter as items.
    """
    rejected = Counter()
    stats = {'anchors': min(len(anchors), MAX_ANCHORS), 'anchors_omitted': max(0, len(anchors) - MAX_ANCHORS),
             'events_scanned': 0, 'event_window_truncated': False, 'facts_scanned': 0,
             'fact_window_truncated': False, 'eligible': 0, 'selected': 0,
             'budget_omitted': 0, 'fact_limit_omitted': 0, 'rejected': {}}
    max_facts = max(1, min(12, int(max_facts)))
    anchor_ids = [n.id for n in anchors[:MAX_ANCHORS] if n.node_type == 'fact' and n.kernel_name != 'human']
    if not anchor_ids:
        return [], stats
    anchor_links = list((await db.execute(select(MemoryFact, EvidenceEvent)
        .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
        .where(MemoryFact.node_id.in_(anchor_ids), EvidenceEvent.learner_id == learner_id))).all())
    attempt_ids = list(dict.fromkeys(_integer((event.payload or {}).get('attempt_id'))
        for _, event in anchor_links if event.event_type in ASSESSMENT_EVENTS))
    attempt_ids = [i for i in attempt_ids if i is not None]
    if not attempt_ids:
        stats['rejected'] = {'no_supported_assessment_link': len(anchor_ids)}
        return [], stats
    # An explicit attempt_id finds candidates; it is not trusted until all
    # entity and ledger checks below agree. The SQL window never reads all history.
    events = list((await db.execute(select(EvidenceEvent).where(
        EvidenceEvent.learner_id == learner_id,
        EvidenceEvent.event_type.in_(ASSESSMENT_EVENTS),
        EvidenceEvent.payload['attempt_id'].as_integer().in_(attempt_ids),
        EvidenceEvent.occurred_at <= now,
    ).order_by(EvidenceEvent.occurred_at.desc(), EvidenceEvent.id.desc()).limit(MAX_EVENTS + 1))).scalars())
    stats['event_window_truncated'] = len(events) > MAX_EVENTS
    events = events[:MAX_EVENTS]
    stats['events_scanned'] = len(events)
    attempts = {a.id: a for a in (await db.execute(select(LearningAttempt).where(
        LearningAttempt.id.in_(attempt_ids), LearningAttempt.learner_id == learner_id))).scalars()}
    owned = {(checkpoint.id, project.id) for checkpoint, project in (await db.execute(select(Checkpoint, Project)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id).join(Project, Project.id == Roadmap.project_id)
        .where(Checkpoint.id.in_({a.checkpoint_id for a in attempts.values()} or {-1}),
               Checkpoint.archived.is_(False), Project.learner_id == learner_id,
               Project.visibility != 'deleted'))).all()}
    items = {}
    for kind, model in (('concept', ConceptQuestion), ('exercise', Exercise)):
        # Do not select the row containing answers/explanations. Only the
        # immutable item identity and checkpoint ownership are needed.
        items.update({(kind, identifier): checkpoint for identifier, checkpoint in
            (await db.execute(select(model.id, model.checkpoint_id).where(
                model.id.in_({a.item_id for a in attempts.values() if a.item_type == kind} or {-1})))).all()})
    session_ids = {e.session_id for e in events if e.session_id is not None}
    sessions = {s.id: s for s in (await db.execute(select(AgentSession).where(
        AgentSession.id.in_(session_ids or {-1}), AgentSession.learner_id == learner_id))).scalars()}
    verified = {}
    for event in events:
        payload = dict(event.payload or {})
        attempt = attempts.get(_integer(payload.get('attempt_id')))
        if not attempt or event.source != 'assessment':
            rejected['untrusted_attempt_link'] += 1
            continue
        if event.client_event_id not in (f'attempt:{attempt.id}:evaluated',
                                         f'{learner_id}:attempt:{attempt.id}:evaluated'):
            rejected['unbound_assessment_receipt'] += 1
            continue
        if (attempt.status != 'evaluated' or attempt.evaluated_at is None or attempt.evaluated_at > now
                or attempt.submitted_at is None or attempt.submitted_at > now
                or attempt.evaluated_at < attempt.submitted_at):
            rejected['attempt_not_evaluated'] += 1
            continue
        if (event.project_id != attempt.project_id or event.checkpoint_id != attempt.checkpoint_id
                or (attempt.checkpoint_id, attempt.project_id) not in owned):
            rejected['attempt_scope_mismatch'] += 1
            continue
        if (attempt.item_type != ASSESSMENT_EVENTS[event.event_type]
                or _integer(payload.get('item_id')) != attempt.item_id
                or items.get((attempt.item_type, attempt.item_id)) != attempt.checkpoint_id):
            rejected['attempt_item_mismatch'] += 1
            continue
        if event.session_id is not None:
            session = sessions.get(event.session_id)
            if (session is None
                    or session.session_type in ('project', 'checkpoint') and session.project_id != event.project_id
                    or session.session_type == 'checkpoint' and session.checkpoint_id != event.checkpoint_id
                    or session.checkpoint_id is not None and session.project_id is not None
                        and session.project_id != event.project_id):
                rejected['event_session_mismatch'] += 1
                continue
        correct = payload.get('correct' if attempt.item_type == 'concept' else 'passed')
        if type(correct) is not bool:
            rejected['missing_boolean_outcome'] += 1
            continue
        result = dict(attempt.result or {})
        if attempt.item_type == 'concept' and (type(result.get('correct')) is not bool or result['correct'] != correct):
            rejected['attempt_outcome_mismatch'] += 1
            continue
        if attempt.item_type == 'exercise':
            passed, total = result.get('passed'), result.get('total')
            if (type(passed) is not int or type(total) is not int or total <= 0
                    or not 0 <= passed <= total or (passed == total) != correct):
                rejected['attempt_outcome_mismatch'] += 1
                continue
        assistance = payload.get('assistance_level')
        if assistance not in (None, 'none', 'hint', 'guided') or (
                assistance is not None and assistance != attempt.assistance_level):
            rejected['attempt_assistance_mismatch'] += 1
            continue
        independent = payload.get('independent') if type(payload.get('independent')) is bool else None
        if independent is True and assistance in ('hint', 'guided'):
            rejected['contradictory_independence'] += 1
            continue
        verified[event.id] = (event, attempt, correct, assistance, independent)
    if not verified:
        stats['rejected'] = dict(rejected)
        return [], stats
    # Partition the bounded materialization so one large attempt cannot crowd
    # every other attempt out. Apply the shared SQL scope before this bound.
    candidates = select(MemoryNode.id.label('id'), func.row_number().over(
        partition_by=MemoryFact.source_event_id,
        order_by=(MemoryNode.id.in_(anchor_ids).desc(), MemoryNode.id)).label('position'))\
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id).where(
            MemoryNode.learner_id == learner_id, MemoryNode.node_type == 'fact',
            MemoryFact.source_event_id.in_(verified), *scope_predicates(MemoryNode)).subquery()
    candidate_rows = list((await db.execute(select(candidates.c.id, candidates.c.position)
        .where(candidates.c.position <= max_facts + 1)
        .order_by(candidates.c.position, candidates.c.id).limit(MAX_FACTS + 1))).all())
    stats['fact_window_truncated'] = len(candidate_rows) > MAX_FACTS or any(
        row.position > max_facts for row in candidate_rows)
    ids = [row.id for row in candidate_rows[:MAX_FACTS]]
    links = list((await db.execute(select(MemoryNode, MemoryFact, KernelMutation)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .join(KernelMutation, KernelMutation.id == MemoryFact.source_mutation_id)
        .where(MemoryNode.id.in_(ids or {-1})))).all())
    stats['facts_scanned'] = len(links)
    if len(links) < len(ids):
        rejected['missing_fact_chain'] += len(ids) - len(links)
    groups = defaultdict(list)
    for node, fact, mutation in links:
        event, attempt, *_ = verified[fact.source_event_id]
        if (mutation.learner_id != learner_id or mutation.event_id != event.id
                or mutation.status != 'applied' or mutation.kernel_name != node.kernel_name):
            rejected['invalid_fact_chain'] += 1
            continue
        if _scope(node) != _scope(fact) or _scope(node) != _scope(event):
            rejected['fact_event_scope_mismatch'] += 1
            continue
        if node.kernel_name == 'human' or not node_allowed(node, fact):
            rejected['filtered_fact'] += 1
            continue
        groups[attempt.id].append((node, fact, event))
    rank = {identifier: index for index, identifier in enumerate(anchor_ids)}
    episodes = []
    evaluation_order = {}
    for attempt_id, members in groups.items():
        # At least one independently validated member must be a ranked anchor.
        # A forged anchor cannot drag unrelated siblings into a new episode.
        valid_anchors = [n.id for n, _, _ in members if n.id in rank]
        if not valid_anchors:
            rejected['no_valid_anchor'] += 1
            continue
        members.sort(key=lambda row: (rank.get(row[0].id, MAX_ANCHORS), row[0].id))
        omitted = max(0, len(members) - max_facts)
        members = members[:max_facts]
        source_events = {event.id: event for _, _, event in members}
        evaluations = [verified[e] for e in source_events]
        if len({(e[2], e[3], e[4]) for e in evaluations}) != 1:
            rejected['conflicting_attempt_events'] += 1
            continue
        event, attempt, correct, assistance, independent = max(evaluations, key=lambda e: (e[0].occurred_at, e[0].id))
        if len({_scope(e) for e in source_events.values()}) != 1:
            rejected['conflicting_event_scopes'] += 1
            continue
        observations = []
        for node, fact, origin in members:
            body, source = excerpt(node.text, terms, limit=320)
            observations.append({'fact_id': node.id, 'kernel': node.kernel_name, 'text': body,
                'source_event_id': origin.id, 'source_mutation_id': fact.source_mutation_id,
                'evidence_grade': fact.evidence_grade, 'source_text': source})
        limitations = ['read_only_assessment_episode_not_mastery', 'canonical_item_relation_unavailable']
        if event.session_id is None:
            limitations.append('source_session_unavailable')
        if independent is None:
            limitations.append('independence_not_recorded')
        if assistance is None:
            limitations.append('assistance_not_recorded')
        if omitted:
            limitations.append('observation_limit_applied')
        if stats['fact_window_truncated'] or stats['event_window_truncated']:
            limitations.append('source_candidate_window_truncated')
        if any(o['source_text'].get('qualifier_spans_omitted') for o in observations):
            limitations.append('source_qualifiers_omitted')
        stats['fact_limit_omitted'] += omitted
        evaluation_order[attempt_id] = (event.occurred_at, event.id)
        episodes.append({'schema_version': EPISODE_SCHEMA_VERSION, 'attempt_id': attempt_id,
            'task': {'item_type': attempt.item_type, 'item_id': attempt.item_id, 'canonical_item_id': None,
                     'attempt_kind': attempt.attempt_role if attempt.attempt_role in ('original', 'retry', 'variant') else None},
            'outcome': {'correct': correct, 'assistance_level': assistance, 'independent': independent},
            'scope': {'learner_id': learner_id, 'project_id': event.project_id,
                      'checkpoint_id': event.checkpoint_id, 'session_id': event.session_id},
            'occurred_at': event.occurred_at.isoformat(), 'anchor_fact_ids': valid_anchors,
            'source_event_ids': sorted(source_events),
            'source_mutation_ids': sorted({f.source_mutation_id for _, f, _ in members}),
            'source_fact_ids': [n.id for n, _, _ in members], 'observations': observations,
            'limitations': limitations})
    # Relevance still bounds the anchor pool. Within its validated episodes,
    # the latest real assessment must precede older success evidence.
    episodes.sort(key=lambda e: evaluation_order[e['attempt_id']], reverse=True)
    stats['eligible'] = len(episodes)
    stats['rejected'] = dict(rejected)
    return episodes, stats
