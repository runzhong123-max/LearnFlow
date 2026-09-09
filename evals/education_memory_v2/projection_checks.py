"""Independent evidence/scope checks for the versioned read projections.

No production imports, decision compilation, semantic keyword score or LLM.
Inputs marked _source_* are independently serialized database snapshots, not
packet declarations. Passing provenance is not proof that an action teaches well.
"""
from datetime import datetime, timezone
import re


def stamp(value):
    try:
        when = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def identity(value):
    return str(value) if type(value) in (int, str) else None


def index(rows):
    return {identity(k): v for k, v in rows.items()}


def refs(value):
    return isinstance(value, list) and bool(value) and all(type(v) is int and v > 0 for v in value) and len(set(value)) == len(value)


def check(name, errors, count, expected):
    return {"name": name, "passed": not errors if count else None,
            "actual": {"checked": count, "errors": errors}, "expected": expected,
            "denominator": count, **({"not_applicable_reason": "No corresponding selected projection"} if not count else {})}


def verify_read_projections(packet, plan, case):
    events = index(packet.get("_source_events") or {})
    nodes = index(packet.get("_source_nodes") or {})
    facts = index(packet.get("_source_facts") or {})
    mutations = index(packet.get("_source_mutations") or {})
    attempts = index(packet.get("_source_attempts") or {})
    request_scope = case.get("_scope") or {}
    at = stamp((case.get("current") or {}).get("at"))
    scope_fields = ("learner_id", "project_id", "checkpoint_id", "session_id")
    episode_errors, guidance_errors, decision_errors = [], [], []
    cited_available = set()
    episodes = packet.get("learning_episodes") or []
    for position, episode in enumerate(episodes):
        bad = []
        attempt = attempts.get(identity(episode.get("attempt_id")))
        if episode.get("schema_version") != "learnflow.learning-episode.v1":
            bad.append("schema_version")
        names = ("source_event_ids", "source_mutation_ids", "source_fact_ids")
        if not all(refs(episode.get(name)) for name in names):
            bad.append("source_reference_shape")
        event_ids = episode.get("source_event_ids") or []
        fact_ids = episode.get("source_fact_ids") or []
        mutation_ids = episode.get("source_mutation_ids") or []
        scope = episode.get("scope") or {}
        if attempt is None or attempt.get("status") != "evaluated":
            bad.append("missing_evaluated_attempt")
        if at is None or stamp(episode.get("occurred_at")) is None or stamp(episode.get("occurred_at")) > at:
            bad.append("episode_query_time")
        for field in ("learner_id", "project_id", "checkpoint_id"):
            if field == "learner_id" or request_scope.get(field) is not None and scope.get(field) is not None:
                if identity(scope.get(field)) != identity(request_scope.get(field)):
                    bad.append("requested_" + field)
            if attempt and identity(attempt.get(field)) != identity(scope.get(field)):
                bad.append("attempt_" + field)
        task, outcome = episode.get("task") or {}, episode.get("outcome") or {}
        if attempt and any(task.get(key) != attempt.get(key) for key in ("item_type", "item_id")):
            bad.append("attempt_task_identity")
        if task.get("canonical_item_id") is not None:
            bad.append("unverified_canonical_item")
        if attempt and task.get("attempt_kind") != attempt.get("attempt_role"):
            bad.append("attempt_role")
        if attempt and (stamp(attempt.get("evaluated_at")) is None or at is None or stamp(attempt.get("evaluated_at")) > at):
            bad.append("attempt_evaluation_time")
        if attempt and (stamp(attempt.get("submitted_at")) is None or stamp(attempt.get("evaluated_at")) is None or
                        stamp(attempt.get("evaluated_at")) < stamp(attempt.get("submitted_at"))):
            bad.append("attempt_time_order")
        linked_times = []
        for event_id in event_ids:
            event = events.get(identity(event_id))
            if not event:
                bad.append("missing_event")
                continue
            payload = event.get("payload") or {}
            expected_type = {"concept": "concept_attempt_evaluated", "exercise": "exercise_attempt_evaluated"}.get(task.get("item_type"))
            if event.get("event_type") != expected_type or event.get("source") != "assessment":
                bad.append("event_assessment_contract")
            if event.get("client_event_id") not in (f"attempt:{episode.get('attempt_id')}:evaluated",
                    f"{scope.get('learner_id')}:attempt:{episode.get('attempt_id')}:evaluated"):
                bad.append("assessment_receipt_binding")
            if identity(payload.get("attempt_id")) != identity(episode.get("attempt_id")) or payload.get("item_id") != task.get("item_id"):
                bad.append("event_attempt_identity")
            if any(identity(event.get(field)) != identity(scope.get(field)) for field in scope_fields):
                bad.append("event_scope")
            correct = payload.get("correct" if task.get("item_type") == "concept" else "passed")
            if type(correct) is not bool or type(outcome.get("correct")) is not bool or correct != outcome["correct"]:
                bad.append("event_outcome")
            assistance = payload.get("assistance_level")
            if outcome.get("assistance_level") != assistance or assistance is not None and attempt and assistance != attempt.get("assistance_level"):
                bad.append("assistance")
            independent = payload.get("independent") if type(payload.get("independent")) is bool else None
            if outcome.get("independent") is not independent or independent is True and assistance in ("hint", "guided"):
                bad.append("independence")
            when = stamp(event.get("occurred_at"))
            if when is None or at is None or when > at:
                bad.append("event_time")
            else:
                linked_times.append(when)
        if linked_times and stamp(episode.get("occurred_at")) != max(linked_times):
            bad.append("episode_timestamp_not_from_source")
        if attempt and task.get("item_type") == "concept":
            correct = (attempt.get("result") or {}).get("correct")
            if type(correct) is not bool or correct is not outcome.get("correct"):
                bad.append("attempt_outcome")
        elif attempt and task.get("item_type") == "exercise":
            result = attempt.get("result") or {}
            passed, total = result.get("passed"), result.get("total")
            if type(passed) is not int or type(total) is not int or total <= 0 or not 0 <= passed <= total or (passed == total) is not outcome.get("correct"):
                bad.append("attempt_exercise_outcome")
        observed = episode.get("observations") or []
        if {o.get("fact_id") for o in observed} != set(fact_ids) or len(observed) != len(fact_ids):
            bad.append("fact_observation_closure")
        observed_events, observed_mutations = set(), set()
        for observation in observed:
            fact_id = observation.get("fact_id")
            fact, node = facts.get(identity(fact_id)), nodes.get(identity(fact_id))
            if not fact or not node:
                bad.append("missing_fact_or_node")
                continue
            mutation = mutations.get(identity(fact.get("mutation_id")))
            if not mutation or mutation.get("status") != "applied":
                bad.append("missing_applied_mutation")
            if mutation and (identity(mutation.get("event_id")) != identity(fact.get("event_id")) or
                             mutation.get("kernel") != node.get("kernel") or
                             identity(mutation.get("learner_id")) != identity(scope.get("learner_id"))):
                bad.append("mutation_chain")
            if observation.get("source_event_id") != fact.get("event_id") or observation.get("source_mutation_id") != fact.get("mutation_id"):
                bad.append("observation_chain")
            if any(identity(node.get(field)) != identity(scope.get(field)) for field in scope_fields):
                bad.append("node_scope")
            if any(identity(fact.get(field)) != identity(scope.get(field)) for field in ("project_id", "checkpoint_id", "session_id")):
                bad.append("fact_scope")
            if node.get("kernel") == "human" or observation.get("kernel") != node.get("kernel"):
                bad.append("fact_kernel")
            observed_events.add(fact.get("event_id")); observed_mutations.add(fact.get("mutation_id"))
        if observed_events != set(event_ids) or observed_mutations != set(mutation_ids):
            bad.append("source_closure")
        # Structural answer-free check only; semantic answer disclosure is unscored.
        if any(key in str_keys(episode) for key in ("submission", "correct_answer", "explanation", "gold", "answer")):
            bad.append("forbidden_answer_field")
        if bad:
            episode_errors.append({"position": position, "reasons": sorted(set(bad))})
        else:
            cited_available.update(event_ids)
    guidance = packet.get("teaching_guidance") or []
    for position, row in enumerate(guidance):
        bad = []
        event = events.get(identity(row.get("source_event_id")))
        version = row.get("policy_version")
        occurred, expires = stamp(row.get("occurred_at")), stamp(row.get("expires_at"))
        cancelled = row.get("cancelled") is True or row.get("evidence_kind") == "explicit_cancellation"
        if version not in ("teaching-guidance.v1", "teaching-guidance.v2") or row.get("status") != "active":
            bad.append("active_version")
        if not event:
            bad.append("missing_event")
        elif identity(event.get("learner_id")) != identity(request_scope.get("learner_id")):
            bad.append("event_learner_ownership")
        if at is None or occurred is None or occurred > at or row.get("lifetime") != "persistent" and (expires is None or expires <= at):
            bad.append("selected_expiry")
        if event and occurred != stamp(event.get("occurred_at")):
            bad.append("event_time")
        scope = row.get("application_scope") if version == "teaching-guidance.v2" else row.get("scope")
        scope = scope or {}
        for field in ("project_id", "checkpoint_id", "session_id"):
            if scope.get(field) is not None:
                if identity(scope.get(field)) != identity(request_scope.get(field)):
                    bad.append("application_" + field)
        if version == "teaching-guidance.v2":
            origin = row.get("source_scope") or {}
            if set(origin) != {"project_id", "checkpoint_id", "session_id"} or set(scope) != {"project_id", "checkpoint_id", "session_id"}:
                bad.append("scope_schema")
            if event and any(identity(origin.get(field)) != identity(event.get(field)) for field in ("project_id", "checkpoint_id", "session_id")):
                bad.append("source_scope")
            if scope != row.get("scope"):
                bad.append("scope_compatibility_alias")
            if row.get("lifetime") == "project_window":
                if scope.get("session_id") is not None or scope.get("project_id") is None or any(
                        identity(scope.get(field)) != identity(origin.get(field)) for field in ("project_id", "checkpoint_id")):
                    bad.append("explicit_window_scope")
                if any(identity(scope.get(field)) != identity(request_scope.get(field)) for field in ("project_id", "checkpoint_id")):
                    bad.append("explicit_window_exact_request_scope")
                if expires is None or occurred is None or not 0 < (expires - occurred).total_seconds() <= 168 * 3600:
                    bad.append("explicit_window_bound")
                if any(not isinstance(row.get(name), str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", row[name]) for name in ("occurred_at", "expires_at")):
                    bad.append("explicit_window_timezone")
                basis = row.get("expiry_basis")
                if basis == "inherited_cancelled_window" and cancelled:
                    original = events.get(identity(row.get("cancelled_window_source_event_id")))
                    original_when = stamp(original.get("occurred_at")) if original else None
                    if not original or original_when is None or occurred is None or original_when >= occurred or any(
                            identity(original.get(field)) != identity(event.get(field) if event else None)
                            for field in ("learner_id", "project_id", "checkpoint_id")):
                        bad.append("cancelled_window_source")
                    if row.get("cancelled_window_expires_at") != row.get("expires_at"):
                        bad.append("cancelled_window_renewed")
                    raw = str((original.get("payload") or {}).get("text") or "") if original else ""
                    dates = re.findall(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})", raw)
                    if expires not in [stamp(value) for value in dates]:
                        bad.append("cancelled_window_expiry_missing_in_original")
                elif basis != "explicit_timezone_iso":
                    bad.append("explicit_window_basis")
            elif row.get("lifetime") == "persistent":
                if any(scope.values()) or row.get("expires_at") is not None:
                    bad.append("persistent_scope_expiry")
            elif origin != scope:
                bad.append("nonwindow_scope_changed")
            span = row.get("source_span")
            text = (event.get("payload") or {}).get("text") if event else None
            if span is not None and (not isinstance(text, str) or not isinstance(span, list) or len(span) != 2 or
                                     any(type(x) is not int for x in span) or not 0 <= span[0] < span[1] <= len(text)):
                bad.append("source_span")
        if bad:
            guidance_errors.append({"position": position, "reasons": sorted(set(bad))})
        elif not cancelled:
            cited_available.add(row.get("source_event_id"))
    decisions = plan.get("teaching_decisions") or []
    supported_actions = {"limit_session", "small_steps", "prioritize_current_goal", "restore_learning_anchor",
                         "verify_reported_resolution", "check_current_gap", "fade_support_then_independent_probe",
                         "independent_variant_or_reasoning_check", "clarify_assistance", "diagnose_first_error", "clarify_nonresponse"}
    for position, row in enumerate(decisions):
        bad = []
        if row.get("action") not in supported_actions or row.get("policy_version") != "learning-plan-guidance.v2":
            bad.append("decision_contract")
        if not refs(row.get("source_event_ids")) or not set(row.get("source_event_ids") or []) <= cited_available:
            bad.append("not_attributed_to_valid_delivered_evidence")
        if row.get("mastery_inference") is not False or not isinstance(row.get("uncertainties"), list):
            bad.append("decision_evidence_boundary")
        if bad:
            decision_errors.append({"position": position, "reasons": bad})
    return [check("episode_source_chain", episode_errors, len(episodes), "Actual Attempt/Event/Mutation/Fact identities, scopes and outcome agree; missing independence remains unknown"),
            check("teaching_guidance_scope_source_expiry", guidance_errors, len(guidance), "Versioned source/application scope and bounded selected lifetime agree with source event"),
            check("teaching_decision_source_trace", decision_errors, len(decisions), "Every decision cites validated delivered guidance or an episode; no mastery inference")]


def str_keys(value):
    result = set()
    if isinstance(value, dict):
        result.update(value)
        for child in value.values():
            result.update(str_keys(child))
    elif isinstance(value, list):
        for child in value:
            result.update(str_keys(child))
    return result


def verify_component_intervention(packet, case):
    variant = case.get("_variant")
    if variant is None:
        return check("component_intervention", [], 0, "An explicit driver-side condition is required")
    errors = []
    policy = (packet.get("manifest") or {}).get("policy") or {}
    diagnostics = packet.get("retrieval_diagnostics") or {}
    if variant == "no_memory":
        if packet.get("learning_episodes") or packet.get("items") or packet.get("relation_paths"):
            errors.append("historical_evidence_in_no_memory")
        return check("component_intervention", errors, 1, "No historical packet output in no_memory")
    components = ("episodes", "bm25", "aliases", "fuzzy", "temporal", "summary_boost")
    for name in components:
        enabled = policy.get("enable_" + name)
        expected = variant != "no_" + name
        actual = diagnostics.get("episodes") if name == "episodes" else (diagnostics.get("components") or {}).get(name)
        actual = actual or {}
        if type(enabled) is not bool or enabled != expected or actual.get("enabled") != enabled:
            errors.append(name + "_configuration")
        if not enabled and (actual.get("activated", 0) or actual.get("matched", 0) or actual.get("selected", 0)):
            errors.append(name + "_activated_while_disabled")
    episodes = packet.get("learning_episodes") or []
    if (diagnostics.get("episodes") or {}).get("selected") != len(episodes):
        errors.append("episode_selected_count")
    paths = (diagnostics.get("components") or {}).get("paths") or {}
    if paths.get("selected") != len(packet.get("relation_paths") or []):
        errors.append("path_selected_count")
    if variant == "no_relations" and (paths.get("enabled") is not False or packet.get("relation_paths")):
        errors.append("relations_not_disabled")
    if variant == "no_episodes" and episodes:
        errors.append("episodes_not_disabled")
    return check("component_intervention", errors, 1, "Declared single-component intervention agrees with actual activation and selected outputs")
