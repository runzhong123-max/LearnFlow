"""Independent automatic protocol verifier for the counterfactual study.

No production reader, planner, reducer, or representation imports are permitted.
The oracle is operational agreement with CONTRACT.md, not a teaching-quality
gold standard. It reads real saved Event/Attempt/ownership rows; fixture labels,
kernel heads and model output never determine the reference. Mutation controls
are compared with independently parsed requests only as formation diagnostics.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
import re

VERSION = "learnflow.education-counterfactual-verifier.v1"
FIELDS = (
    "latest_result", "latest_assistance", "assessment_event_id",
    "independent_success_supported", "stable_mastery_supported",
    "current_priority", "time_budget_minutes", "support_active",
    "return_anchor", "next_step",
)
SEMANTIC_FIELDS = tuple(f for f in FIELDS if f != "assessment_event_id")
OUTPUT_FIELDS = (*FIELDS, "evidence_event_ids")
SCOPE_FIELDS = ("learner_id", "project_id", "checkpoint_id", "session_id")
ASSESSMENTS = {"concept_attempt_evaluated": "concept", "exercise_attempt_evaluated": "exercise"}
USER_TYPES = {"vnext_teaching_input_received", "learner_concept_observation_recorded", "user_message"}
ENUMS = {
    "latest_result": {"correct", "incorrect", "none"},
    "latest_assistance": {"independent", "supported", "unknown"},
    "next_step": {"diagnose_error", "reduce_help_then_check", "independent_check", "clarify_help", "collect_evidence"},
}
BOOL_FIELDS = {"independent_success_supported", "stable_mastery_supported", "support_active"}


def _positive_id(value):
    return type(value) is int and value > 0


def _time(value):
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(at, datetime):
            return None
        # Native database rows use naive UTC datetimes.
        return at.replace(tzinfo=timezone.utc) if at.tzinfo is None else at.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def _index(formation, name, *, required=True):
    rows = formation.get(name, [] if not required else None)
    if not isinstance(rows, list):
        raise ValueError(f"formation.{name} must be a saved row list")
    result = {}
    for row in rows:
        if not isinstance(row, dict) or not _positive_id(row.get("id")) or row["id"] in result:
            raise ValueError(f"formation.{name} has an invalid or duplicate ID")
        result[row["id"]] = row
    return result


def _context(formation):
    if not isinstance(formation, dict):
        raise ValueError("formation must be an object")
    if "status" in formation and formation["status"] != "formed":
        raise ValueError("unsuccessful formation cannot be scored as a completed condition")
    scope, at = formation.get("scope"), _time(formation.get("at"))
    if not isinstance(scope, dict) or not all(_positive_id(scope.get(f)) for f in SCOPE_FIELDS) or at is None:
        raise ValueError("formation requires a complete positive query scope and UTC time")
    indexes = {name: _index(formation, name) for name in (
        "events", "attempts", "projects", "roadmaps", "checkpoints", "sessions", "questions")}
    indexes["exercises"] = _index(formation, "exercises", required=False)
    problem = _owned(scope, indexes)
    if problem:
        raise ValueError(f"invalid query ownership: {problem}")
    return scope, at, indexes


def _owned(row, indexes):
    learner, project, checkpoint, session = (row.get(f) for f in SCOPE_FIELDS)
    if not all(_positive_id(v) for v in (learner, project, checkpoint)):
        return "incomplete_scope"
    p = indexes["projects"].get(project)
    c = indexes["checkpoints"].get(checkpoint)
    roadmap = indexes["roadmaps"].get(c.get("roadmap_id")) if c else None
    if not p or p.get("learner_id") != learner:
        return "project_ownership"
    if not c or not roadmap or roadmap.get("project_id") != project:
        return "checkpoint_ownership"
    if session is not None:
        s = indexes["sessions"].get(session)
        if not _positive_id(session) or not s or any(s.get(f) != row.get(f) for f in SCOPE_FIELDS[:3]):
            return "session_ownership"
    return None


def _source_error(event, scope, at, indexes):
    if any(event.get(f) != scope[f] for f in SCOPE_FIELDS[:3]):
        return "outside_query_scope"
    problem = _owned(event, indexes)
    if problem:
        return problem
    occurred = _time(event.get("occurred_at"))
    if occurred is None or occurred > at:
        return "invalid_or_future_event_time"
    if not isinstance(event.get("payload"), dict):
        return "invalid_event_payload"
    kind, source = event.get("event_type"), event.get("source")
    if kind in ASSESSMENTS:
        return None if source == "assessment" else "assessment_source_mismatch"
    if kind in USER_TYPES:
        provenance = event.get("provenance") or {}
        if kind == "vnext_teaching_input_received":
            valid_origin = (source == "vnext" and event.get("actor_type") == "learner"
                            and provenance.get("vnext_sync") is True
                            and provenance.get("contract_id") == kind)
        else:
            valid_origin = source == "user" and event.get("actor_type") == "learner" and provenance.get("contract_id") == kind
        if not valid_origin:
            return "user_source_mismatch"
        if event.get("session_id") != scope["session_id"]:
            return "outside_query_session"
        return None
    return "unsupported_event_type"


def _assessment(event, at, indexes):
    payload = event["payload"]
    if not _positive_id(payload.get("attempt_id")):
        return None, "invalid_attempt_id"
    attempt = indexes["attempts"].get(payload.get("attempt_id"))
    if not attempt or attempt.get("status") != "evaluated":
        return None, "missing_evaluated_attempt"
    if any(attempt.get(f) != event.get(f) for f in SCOPE_FIELDS[:3]):
        return None, "attempt_scope_mismatch"
    problem = _owned(attempt, indexes)
    if problem:
        return None, f"attempt_{problem}"
    aid = attempt["id"]
    if event.get("client_event_id") not in {f"attempt:{aid}:evaluated", f"{event['learner_id']}:attempt:{aid}:evaluated"}:
        return None, "unbound_assessment_receipt"
    item_type = ASSESSMENTS[event["event_type"]]
    item = (indexes["questions"] if item_type == "concept" else indexes["exercises"]).get(attempt.get("item_id"))
    if (attempt.get("item_type") != item_type or not _positive_id(payload.get("item_id")) or not _positive_id(attempt.get("item_id"))
            or payload["item_id"] != attempt.get("item_id") or not item
            or item.get("checkpoint_id") != attempt.get("checkpoint_id")):
        return None, "assessment_item_ownership"
    submitted, evaluated = _time(attempt.get("submitted_at")), _time(attempt.get("evaluated_at"))
    if submitted is None or evaluated is None or not submitted <= evaluated <= _time(event["occurred_at"]) <= at:
        return None, "invalid_or_future_attempt_time"
    correct = payload.get("correct" if item_type == "concept" else "passed")
    result = attempt.get("result")
    if type(correct) is not bool or not isinstance(result, dict):
        return None, "invalid_graded_outcome"
    if item_type == "concept":
        if type(result.get("correct")) is not bool or result["correct"] != correct:
            return None, "attempt_result_mismatch"
    else:
        passed, total = result.get("passed"), result.get("total")
        if type(passed) is not int or type(total) is not int or not 0 <= passed <= total or total <= 0 or (passed == total) != correct:
            return None, "attempt_result_mismatch"
    assistance = payload.get("assistance_level")
    if assistance not in (None, "none", "hint", "guided") or assistance != attempt.get("assistance_level"):
        return None, "attempt_assistance_mismatch"
    independent = payload.get("independent")
    if independent is not None and type(independent) is not bool:
        return None, "invalid_independence_type"
    if independent is True and assistance in ("hint", "guided"):
        return None, "contradictory_independence"
    role = attempt.get("attempt_role")
    if payload.get("attempt_role", role) != role:
        return None, "attempt_role_mismatch"
    for key, value in (("attempt_id", aid), ("assistance_level", assistance), ("attempt_role", role)):
        if key in result and not _equal(result[key], value):
            return None, "attempt_result_receipt_mismatch"
    supported = assistance in ("hint", "guided") or role in {"retry", "repeated_original"}
    qualification = "supported" if supported else "independent" if assistance == "none" and independent is True else "unknown"
    return {"event_id": event["id"], "correct": correct, "assistance": qualification,
            "attempt_id": aid, "attempt_role": role, "occurred_at": event["occurred_at"]}, None


# Intentionally small source grammar for this declared benchmark, not a second
# general natural-language parser. Unsupported prose is counted, never guessed.
_MINUTES = re.compile(r"(?:我|今天|现在|本次|这次)(?:我)?(?:的学习时间|时间|预算)?(?:只有|有|为|是)\s*(\d{1,3})\s*分钟")
_PRIORITY = re.compile(r"(?:本次|这次|当前|现在)优先\s*[:：]?\s*([^，,。；;！？!?\n]{1,120})")
_ANCHOR = re.compile(r"(?:先回到|请回到|回到|请带我回到)\s*[:：]?\s*([^，,。；;！？!?\n]{1,120})")
_SUPPORT = re.compile(r"请(?:把任务)?(?:拆成|分成)小步|请一步一步|请每次只讲一步")
_DEADLINE = re.compile(r"(?:截止|有效期至|有效至|有效到)\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))")


def _controls(event):
    text = event["payload"].get("text")
    if not isinstance(text, str) or not text or len(text) > 4000:
        return [], "unsupported_control_text"
    # Quotation, negation, hypothetical and reported requests are outside this
    # restricted corpus grammar. Do not reinterpret them as positive controls.
    if re.search(r"[\"'`“”「」『』]|如果|假设|不再|不要|不是|取消|同学|老师说|可能|也许", text):
        return [], "unsupported_control_expression"
    occurred = _time(event["occurred_at"])
    deadline = _DEADLINE.search(text)
    expiry = _time(deadline.group(1)) if deadline else occurred + timedelta(hours=8)
    if expiry is None or not occurred < expiry <= occurred + timedelta(hours=168):
        return [], "invalid_control_deadline"
    if any(word in text for word in ("截止", "有效期", "有效至", "有效到")) and not deadline:
        return [], "unsupported_control_deadline"
    result = []
    offset = 0
    for segment in re.split(r"([，,。；;！？!?\n]+)", text):
        left = len(segment) - len(segment.lstrip())
        clause = segment.strip()
        for slot, pattern in (("time_budget", _MINUTES), ("current_priority", _PRIORITY),
                              ("return_anchor", _ANCHOR), ("support", _SUPPORT)):
            match = pattern.fullmatch(clause)
            if not match:
                continue
            value = int(match.group(1)) if slot == "time_budget" else True if slot == "support" else match.group(1).strip()
            if slot == "time_budget" and not 1 <= value <= 480:
                continue
            result.append({"slot": slot, "value": value, "event_id": event["id"],
                           "occurred_at": event["occurred_at"],
                           # Native support is session scoped even if an adjacent
                           # time/goal clause declares a project-window deadline.
                           "expires_at": (occurred + timedelta(hours=8) if slot == "support" else expiry).isoformat(),
                           "source_span": [offset + left, offset + left + len(clause)]})
        offset += len(segment)
    return result, None if result else "no_supported_control"


def _native_control_gaps(formation, controls):
    native = []
    for mutation in formation.get("mutations", []):
        if not isinstance(mutation, dict) or mutation.get("status") != "applied":
            continue
        patch = mutation.get("patch")
        if not isinstance(patch, dict):
            continue
        for store in ("short_term", "long_term"):
            section = patch.get(store) or {}
            if not isinstance(section, dict):
                continue
            entries = section.get("teaching_directives" if store == "short_term" else "teaching_preferences", [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict) and entry.get("source_event_id") == mutation.get("event_id"):
                    native.append(entry)
    gaps = []
    keys = {"time_budget": "minutes", "current_priority": "requested_priority", "return_anchor": "requested_anchor"}
    for control in controls:
        matches = [row for row in native if row.get("source_event_id") == control["event_id"] and row.get("slot") == control["slot"]]
        if not matches:
            reason = "native_control_not_formed"
        elif not any((control["slot"] == "support" or row.get(keys[control["slot"]]) == control["value"])
                     and _time(row.get("expires_at")) == _time(control["expires_at"])
                     and row.get("source_span") == control["source_span"] for row in matches):
            reason = "native_control_value_window_or_span_mismatch"
        else:
            continue
        gaps.append({"event_id": control["event_id"], "slot": control["slot"], "reason": reason})
    return gaps


def _derive(formation, available=None):
    scope, at, indexes = _context(formation)
    if available is not None and (not isinstance(available, list) or any(not _positive_id(v) for v in available) or len(set(available)) != len(available)):
        raise ValueError("available_event_ids must be unique positive integers or None")
    selected = set(available) if available is not None else None
    valid, excluded, assessments, controls, self_reports = {}, [], [], [], []
    for eid, event in indexes["events"].items():
        error = _source_error(event, scope, at, indexes)
        assessment = None
        if error is None and event["event_type"] in ASSESSMENTS:
            assessment, error = _assessment(event, at, indexes)
        if error:
            excluded.append({"event_id": eid, "reason": error})
            continue
        parsed = []
        if event["event_type"] == "learner_concept_observation_recorded":
            if not isinstance(event["payload"].get("statement"), str) or not event["payload"]["statement"].strip():
                excluded.append({"event_id": eid, "reason": "missing_self_report_statement"})
                continue
        elif event["event_type"] == "user_message":
            text = event["payload"].get("text")
            if not isinstance(text, str) or not text.strip():
                excluded.append({"event_id": eid, "reason": "missing_user_message_text"})
                continue
        elif event["event_type"] == "vnext_teaching_input_received":
            parsed, error = _controls(event)
            if error:
                excluded.append({"event_id": eid, "reason": error})
                continue
        valid[eid] = event
        if selected is not None and eid not in selected:
            continue
        if assessment:
            assessments.append(assessment)
        elif event["event_type"] == "learner_concept_observation_recorded":
            self_reports.append(event)
        elif event["event_type"] == "vnext_teaching_input_received":
            controls.extend(parsed)
    expected = dict(latest_result="none", latest_assistance="unknown", assessment_event_id=None,
                    independent_success_supported=False, stable_mastery_supported=False,
                    current_priority=None, time_budget_minutes=None, support_active=False,
                    return_anchor=None, next_step="collect_evidence", evidence_event_ids=[])
    dependencies = {field: set() for field in FIELDS}
    if assessments:
        latest = max(assessments, key=lambda x: (_time(x["occurred_at"]), x["event_id"]))
        correct, assistance, eid = latest["correct"], latest["assistance"], latest["event_id"]
        expected.update(latest_result="correct" if correct else "incorrect", latest_assistance=assistance,
                        assessment_event_id=eid, independent_success_supported=correct and assistance == "independent",
                        next_step=("diagnose_error" if not correct else {
                            "supported": "reduce_help_then_check", "independent": "independent_check", "unknown": "clarify_help"}[assistance]))
        for field in ("latest_result", "latest_assistance", "assessment_event_id", "independent_success_supported", "next_step"):
            dependencies[field].add(eid)
    elif self_reports:
        latest_self_report = max(self_reports, key=lambda x: (_time(x["occurred_at"]), x["id"]))
        for field in ("independent_success_supported", "next_step"):
            dependencies[field].add(latest_self_report["id"])
    by_slot = {}
    for control in controls:
        prior = by_slot.get(control["slot"])
        key = lambda x: (_time(x["occurred_at"]), x["event_id"], x["source_span"][0])
        if prior is None or key(control) > key(prior):
            by_slot[control["slot"]] = control
    target = {"current_priority": "current_priority", "return_anchor": "return_anchor", "time_budget": "time_budget_minutes", "support": "support_active"}
    for slot, control in by_slot.items():
        field = target[slot]
        dependencies[field].add(control["event_id"])
        if _time(control["expires_at"]) > at:
            expected[field] = control["value"]
    if expected["support_active"]:
        expected["time_budget_minutes"] = min(expected["time_budget_minutes"] or 20, 20)
        dependencies["time_budget_minutes"].add(by_slot["support"]["event_id"])
    expected["evidence_event_ids"] = sorted(set().union(*dependencies.values()))
    audit = {"valid_source_event_ids": sorted(valid), "selected_valid_event_ids": sorted(set(valid) if selected is None else set(valid) & selected),
             "unavailable_or_invalid_selected_ids": sorted((selected or set()) - set(valid)),
             "excluded_events": excluded, "excluded_reason_counts": dict(Counter(row["reason"] for row in excluded)),
             "assessment_count": len(assessments), "control_count": len(controls), "self_report_count": len(self_reports),
             "formation_gaps": _native_control_gaps(formation, controls),
             "field_evidence_ids": {field: sorted(ids) for field, ids in dependencies.items()}}
    return expected, audit


def derive_expected(formation: dict) -> dict:
    """Return the eleven-field reference solely from native saved evidence."""
    return _derive(formation)[0]


def _equal(actual, expected):
    return type(actual) is type(expected) and actual == expected


def _schema_errors(output):
    if not isinstance(output, dict):
        return ["output_not_object"]
    errors = [f"missing:{field}" for field in OUTPUT_FIELDS if field not in output]
    errors += [f"unexpected:{field}" for field in output if field not in OUTPUT_FIELDS]
    for field in FIELDS:
        if field not in output:
            continue
        value = output[field]
        if field in ENUMS:
            okay = isinstance(value, str) and value in ENUMS[field]
        elif field in BOOL_FIELDS:
            okay = type(value) is bool
        elif field in {"current_priority", "return_anchor"}:
            okay = value is None or isinstance(value, str) and bool(value.strip())
        elif field == "assessment_event_id":
            okay = value is None or _positive_id(value)
        else:
            okay = value is None or type(value) is int and 1 <= value <= 480
        if not okay:
            errors.append(f"invalid:{field}")
    citations = output.get("evidence_event_ids")
    if (not isinstance(citations, list) or any(not _positive_id(v) for v in citations)
            or len(set(citations)) != len(citations)):
        errors.append("invalid:evidence_event_ids")
    return errors


def _score(output, expected, audit, available_ids):
    values = output if isinstance(output, dict) else {}
    errors = _schema_errors(output)
    fields = {field: field in values and _equal(values[field], expected[field]) for field in FIELDS}
    citations = values.get("evidence_event_ids")
    citation_shape = isinstance(citations, list) and all(_positive_id(v) for v in citations) and len(set(citations)) == len(citations)
    cited = set(citations) if citation_shape else set()
    valid_ids = set(audit["valid_source_event_ids"]) & set(available_ids)
    citation_valid = citation_shape and cited <= valid_ids
    assessment_ref = values.get("assessment_event_id")
    if assessment_ref is not None:
        citation_valid = citation_valid and _positive_id(assessment_ref) and assessment_ref in valid_ids and assessment_ref in cited
    required = set(expected["evidence_event_ids"])
    covered = required & cited & valid_ids
    citation_complete = citation_valid and covered == required
    whole = not errors and all(fields.values()) and citation_complete
    dependent = [field for field, ids in audit["field_evidence_ids"].items() if ids]
    usable = [field for field in dependent if set(audit["field_evidence_ids"][field]) <= set(available_ids)]
    return {"expected": expected, "schema_errors": errors, "schema_valid": not errors,
            "field_correct": fields, "field_numerator": sum(fields.values()), "field_denominator": len(FIELDS),
            "evidence_dependent_field_numerator": sum(fields[f] for f in dependent), "evidence_dependent_field_denominator": len(dependent),
            "available_evidence_dependent_field_numerator": sum(fields[f] for f in usable), "available_evidence_dependent_field_denominator": len(usable),
            "whole_record_correct": whole, "whole_record_numerator": int(whole), "whole_record_denominator": 1,
            "action_correct": fields["next_step"],
            "action_obligation_fulfilled": fields["next_step"] and fields["assessment_event_id"] and citation_complete and not errors,
            "unsupported_independent_claim": ((values.get("independent_success_supported") is True and not expected["independent_success_supported"])
                                              or (values.get("latest_assistance") == "independent" and expected["latest_assistance"] != "independent")),
            "unsupported_stable_claim": values.get("stable_mastery_supported") is True,
            "false_abstention": expected["assessment_event_id"] is not None and (values.get("next_step") == "collect_evidence" or values.get("latest_result") == "none" or values.get("assessment_event_id") is None),
            "positive_assessment_denominator": int(expected["assessment_event_id"] is not None),
            "citation_valid": bool(citation_valid), "citation_complete": bool(citation_complete),
            "citation_coverage_numerator": len(covered), "citation_coverage_denominator": len(required),
            "required_evidence_available_numerator": len(required & set(available_ids)), "required_evidence_available_denominator": len(required)}


def score_output(output: object, formation: dict, available_event_ids: list[int] | None = None) -> dict:
    """Score end to end and conditional on delivery without dropping failures.

    available_event_ids denotes actual complete canonical records delivered, not
    merely candidate IDs. Callers must verify record/field delivery independently.
    Formation-derived references remain available only to the scorer.
    """
    expected, audit = _derive(formation)
    available_expected, available_audit = _derive(formation, available_event_ids)
    available = audit["valid_source_event_ids"] if available_event_ids is None else available_event_ids
    full = _score(output, expected, audit, available)
    conditional = _score(output, available_expected, available_audit, available)
    selection_valid = not available_audit["unavailable_or_invalid_selected_ids"]
    if not selection_valid:
        for result in (full, conditional):
            result.update(whole_record_correct=False, whole_record_numerator=0, action_obligation_fulfilled=False)
    return {"schema_version": VERSION, "case_id": formation.get("case_id"), "output": output,
            "available_event_ids": list(available_event_ids) if available_event_ids is not None else None,
            **full, "full_evidence": full, "available_evidence": conditional, "source_audit": audit,
            "available_source_audit": available_audit, "selection_source_valid": selection_valid,
            "selection_changed_expected_fields": [field for field in FIELDS if not _equal(expected[field], available_expected[field])],
            "limitations": ["Automatic operational consistency, not teacher judgment or learning gain.",
                            "Stable mastery is a fixed negative control for this corpus.",
                            "Available-evidence scores require caller-verified complete record delivery."]}


def score_pair(case_a: dict, case_b: dict, result_a: dict, result_b: dict) -> dict:
    """Check semantic changes/invariants; database IDs are checked per side only.

    case arguments are formation snapshots or objects with a formation member;
    result arguments are score_output receipts or raw output objects.
    """
    a, b = case_a.get("formation", case_a), case_b.get("formation", case_b)
    def rescore(result, formation):
        if isinstance(result, dict) and result.get("schema_version") == VERSION:
            return score_output(result.get("output"), formation, result.get("available_event_ids"))
        return score_output(result, formation)
    score_a, score_b = rescore(result_a, a), rescore(result_b, b)
    # Recompute every metric, never trust scores/expected in a passed receipt.
    expected_a, expected_b = derive_expected(a), derive_expected(b)
    values_a = score_a.get("output") if isinstance(score_a.get("output"), dict) else {}
    values_b = score_b.get("output") if isinstance(score_b.get("output"), dict) else {}
    changed = [field for field in SEMANTIC_FIELDS if not _equal(expected_a[field], expected_b[field])]
    invariant = [field for field in SEMANTIC_FIELDS if field not in changed]
    checks = {field: field in values_a and field in values_b and _equal(values_a[field], expected_a[field])
              and _equal(values_b[field], expected_b[field]) for field in SEMANTIC_FIELDS}
    # Require correctness on both endpoints, not just an arbitrary change or an
    # identically wrong invariant answer. References cannot compare cross-DB IDs.
    return {"schema_version": VERSION, "case_ids": [a.get("case_id"), b.get("case_id")],
            "changed_fields": changed, "invariant_fields": invariant,
            "changed_field_checks": {field: checks[field] for field in changed},
            "invariant_field_checks": {field: checks[field] for field in invariant},
            "change_numerator": sum(checks[field] for field in changed), "change_denominator": len(changed),
            "invariance_numerator": sum(checks[field] for field in invariant), "invariance_denominator": len(invariant),
            "joint_success": bool(score_a.get("whole_record_correct") and score_b.get("whole_record_correct") and all(checks.values())),
            "pair_denominator": 1, "cross_database_ids_compared": False}
