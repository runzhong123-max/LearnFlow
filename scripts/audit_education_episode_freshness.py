#!/usr/bin/env python3
"""Post-hoc audit of current teaching feedback against actual assessment receipts.

This does not modify the frozen evaluator/gold or measure teaching quality. It
reads saved formation and packet/plan rows, independently validates assessment
links, and checks whether current feedback cites the latest applicable event.
No product imports, model calls, answer text, submissions or question text enter
the output. Run separately on each formal run; do not combine repeated cases.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import sys

VERSION = "learnflow.education-episode-freshness-audit.v2"
ASSESSMENTS = {"concept_attempt_evaluated": "concept", "exercise_attempt_evaluated": "exercise"}
PRACTICE_ACTIONS = {"fade_support_then_independent_probe", "independent_variant_or_reasoning_check",
                    "diagnose_first_error", "clarify_nonresponse", "clarify_assistance"}
SCOPE = ("project_id", "checkpoint_id", "session_id")
LIMITATIONS = [
    "Post-hoc diagnostic introduced after observing formal-02; not a preregistered score or independent holdout.",
    "Current-feedback applicability uses the declared current query projection and exact owned checkpoint scope; query-intent semantics are not independently judged.",
    "The reference is the latest available valid same-checkpoint assessment, ordered by occurred_at then Event ID; it does not prove stable mastery or the best pedagogical action.",
    "Project/item ownership tables are absent from the saved snapshot; this audit checks the saved Event/Attempt/Fact/Node scope chain, not an independent database ownership query.",
    "No practice action, no valid applicable assessment, missing query time or non-current/non-checkpoint query is NA, never a pass.",
    "A decision source must be delivered by a validated current packet episode or active assessment guidance; formation-only references are invalid, not fresh.",
    "Transient Fact references require the current session; persistent active references may cross sessions within the same checkpoint.",
    "Assistance and independence use explicit event fields only; absent independence remains unknown. Original retry feedback stays conservative.",
    "Results identify pipeline freshness failures; no teacher ratings, real learners, learning gains or official QA accuracy are inferred.",
]


def timestamp(value):
    try:
        result = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def integer(value):
    return type(value) is int and value > 0


def same_id(left, right):
    return (left is None and right is None) or (integer(left) and integer(right) and left == right)


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def unique_index(rows):
    result = {}
    for row in rows:
        identifier = row.get("id")
        if not integer(identifier) or identifier in result:
            raise ValueError("Missing, invalid or duplicate snapshot entity ID")
        result[identifier] = row
    return result


def state_indexes(state):
    events, attempts, facts, mutations = (unique_index(state.get(name) or [])
                                         for name in ("events", "attempts", "facts", "mutations"))
    nodes = {}
    for key, row in (state.get("source_nodes") or {}).items():
        try:
            identifier = int(key)
        except (ValueError, TypeError):
            raise ValueError("Invalid source node identity") from None
        if identifier <= 0 or identifier in nodes:
            raise ValueError("Duplicate source node identity")
        nodes[identifier] = row
    return {"events": events, "attempts": attempts, "facts": facts, "mutations": mutations, "nodes": nodes}


def expected_action(outcome, attempt_role):
    """Label explicit feedback state without interpreting prose or upgrading mastery."""
    if outcome["correct"] is False:
        return "diagnose_first_error"
    if outcome["correct"] is not True:
        return "clarify_nonresponse"
    if outcome["assistance_level"] in ("hint", "guided") or attempt_role == "retry":
        return "fade_support_then_independent_probe"
    if outcome["assistance_level"] == "none" and outcome["independent"] is True:
        return "independent_variant_or_reasoning_check"
    return "clarify_assistance"


def valid_assessment(event, indexes, scope, at):
    """Return a text-free receipt reference or a precise exclusion reason."""
    item_type = ASSESSMENTS.get(event.get("event_type"))
    if item_type is None or event.get("source") != "assessment":
        return None, "not_native_assessment"
    if any(not same_id(event.get(name), scope.get(name)) for name in ("learner_id", "project_id", "checkpoint_id")):
        return None, "outside_query_scope"
    occurred = timestamp(event.get("occurred_at"))
    if occurred is None or occurred > at:
        return None, "invalid_or_future_event_time"
    payload = event.get("payload") or {}
    if not integer(payload.get("attempt_id")):
        return None, "invalid_attempt_id"
    attempt = indexes["attempts"].get(payload.get("attempt_id"))
    if not attempt or attempt.get("status") != "evaluated":
        return None, "missing_evaluated_attempt"
    if event.get("client_event_id") not in (f"attempt:{attempt['id']}:evaluated",
                                           f"{scope['learner_id']}:attempt:{attempt['id']}:evaluated"):
        return None, "unbound_assessment_receipt"
    if any(not same_id(attempt.get(name), scope.get(name)) for name in ("learner_id", "project_id", "checkpoint_id")):
        return None, "attempt_scope_mismatch"
    if (attempt.get("item_type") != item_type or not integer(payload.get("item_id"))
            or payload["item_id"] != attempt.get("item_id")):
        return None, "attempt_item_mismatch"
    submitted, evaluated = timestamp(attempt.get("submitted_at")), timestamp(attempt.get("evaluated_at"))
    if submitted is None or evaluated is None or not submitted <= evaluated <= at:
        return None, "invalid_attempt_time"
    correct = payload.get("correct" if item_type == "concept" else "passed")
    result = attempt.get("result") or {}
    if type(correct) is not bool:
        return None, "missing_boolean_outcome"
    if item_type == "concept" and (type(result.get("correct")) is not bool or result["correct"] != correct):
        return None, "attempt_result_mismatch"
    if item_type == "exercise":
        passed, total = result.get("passed"), result.get("total")
        if type(passed) is not int or type(total) is not int or not 0 <= passed <= total or total <= 0 or (passed == total) != correct:
            return None, "attempt_result_mismatch"
    assistance = payload.get("assistance_level")
    if assistance not in (None, "none", "hint", "guided") or assistance is not None and assistance != attempt.get("assistance_level"):
        return None, "attempt_assistance_mismatch"
    independent = payload.get("independent") if type(payload.get("independent")) is bool else None
    if independent is True and assistance in ("hint", "guided"):
        return None, "contradictory_independence"
    linked_facts = []
    for fact in indexes["facts"].values():
        if not same_id(fact.get("event_id"), event["id"]) or not integer(fact.get("mutation_id")):
            continue
        node, mutation = indexes["nodes"].get(fact["id"]), indexes["mutations"].get(fact.get("mutation_id"))
        if not node or not mutation or mutation.get("status") != "applied":
            continue
        if (not same_id(mutation.get("event_id"), event["id"]) or not same_id(mutation.get("learner_id"), scope["learner_id"])
                or mutation.get("kernel") != node.get("kernel") or fact.get("kernel") != node.get("kernel")):
            continue
        if node.get("node_type") != "fact" or node.get("kernel") not in ("knowledge", "practice", "structure", "value") or not same_id(node.get("learner_id"), scope["learner_id"]):
            continue
        if node.get("status") not in ("active", "transient", "legacy"):
            continue
        if node.get("status") == "transient" and (
                not integer(scope.get("session_id")) or not same_id(node.get("session_id"), scope.get("session_id"))):
            continue
        valid_to = timestamp(node.get("valid_to")) if node.get("valid_to") is not None else None
        if node.get("valid_to") is not None and (valid_to is None or valid_to <= at):
            continue
        if any(not same_id(fact.get(name), event.get(name)) or not same_id(node.get(name), event.get(name)) for name in SCOPE):
            continue
        linked_facts.append(fact["id"])
    if not linked_facts:
        return None, "no_current_valid_fact_chain"
    outcome = {"correct": correct, "assistance_level": assistance, "independent": independent}
    return {"event_id": event["id"], "attempt_id": attempt["id"], "item_type": item_type,
            "item_id": attempt["item_id"], "attempt_role": attempt.get("attempt_role"),
            "occurred_at": occurred.isoformat(), "scope": {name: event.get(name) for name in ("learner_id", *SCOPE)},
            "outcome": outcome, "reference_action": expected_action(outcome, attempt.get("attempt_role")),
            "fact_ids": sorted(linked_facts)}, None


def reference_ids(value):
    return (isinstance(value, list) and bool(value) and all(integer(v) for v in value)
            and len(set(value)) == len(value))


def valid_excerpt(observation, fact, node):
    """Require the selected observation's text, not merely its source ID/hash."""
    text, source = observation.get("text"), observation.get("source_text")
    original = node.get("text")
    if (not isinstance(text, str) or not text or not isinstance(original, str)
            or fact.get("text") != original or not isinstance(source, dict)):
        return False
    spans = source.get("ranges")
    if (not isinstance(spans, list) or not spans or any(not isinstance(pair, list) or len(pair) != 2
            or any(type(x) is not int for x in pair) or not 0 <= pair[0] < pair[1] <= len(original) for pair in spans)):
        return False
    return (source.get("sha256") == hashlib.sha256(original.encode()).hexdigest()
            and type(source.get("chars")) is int and source["chars"] == len(original)
            and text == " … ".join(original[start:end] for start, end in spans))


def episode_delivery(episode, indexes, eligible):
    """Validate selected episode closure against already checked native receipts."""
    if not isinstance(episode, dict) or episode.get("schema_version") != "learnflow.learning-episode.v1":
        return set(), "episode_schema"
    fields = ("source_event_ids", "source_fact_ids", "source_mutation_ids", "anchor_fact_ids")
    if not all(reference_ids(episode.get(name)) for name in fields):
        return set(), "episode_reference_shape"
    event_ids = set(episode["source_event_ids"])
    if not event_ids <= eligible.keys():
        return set(), "episode_receipt_not_applicable"
    scope, task, outcome = episode.get("scope"), episode.get("task"), episode.get("outcome")
    if not all(isinstance(value, dict) for value in (scope, task, outcome)):
        return set(), "episode_fields"
    if not integer(episode.get("attempt_id")) or task.get("canonical_item_id") is not None:
        return set(), "episode_attempt_identity"
    for event_id in event_ids:
        reference = eligible[event_id]
        if (episode["attempt_id"] != reference["attempt_id"]
                or task.get("item_type") != reference["item_type"]
                or not same_id(task.get("item_id"), reference["item_id"])
                or task.get("attempt_kind") != (reference["attempt_role"] if reference["attempt_role"] in ("original", "retry", "variant") else None)
                or any(not same_id(scope.get(name), reference["scope"].get(name)) for name in ("learner_id", *SCOPE))):
            return set(), "episode_receipt_identity_or_scope"
        if (type(outcome.get("correct")) is not bool or outcome["correct"] != reference["outcome"]["correct"]
                or outcome.get("assistance_level") != reference["outcome"]["assistance_level"]
                or outcome.get("independent") is not reference["outcome"]["independent"]):
            return set(), "episode_receipt_outcome"
    if timestamp(episode.get("occurred_at")) != max(timestamp(eligible[e]["occurred_at"]) for e in event_ids):
        return set(), "episode_receipt_time"
    observations = episode.get("observations")
    if not isinstance(observations, list) or not observations or any(not isinstance(o, dict) for o in observations):
        return set(), "episode_observations"
    fact_ids, observed_events, mutation_ids = set(), set(), set()
    for observation in observations:
        fid, eid, mid = (observation.get(name) for name in ("fact_id", "source_event_id", "source_mutation_id"))
        if not all(integer(value) for value in (fid, eid, mid)) or fid in fact_ids or eid not in event_ids:
            return set(), "episode_observation_references"
        fact, node = indexes["facts"].get(fid), indexes["nodes"].get(fid)
        if (not fact or not node or fid not in eligible[eid]["fact_ids"]
                or fact.get("event_id") != eid or fact.get("mutation_id") != mid
                or observation.get("kernel") != node.get("kernel") or not valid_excerpt(observation, fact, node)):
            return set(), "episode_observation_binding_or_excerpt"
        fact_ids.add(fid)
        observed_events.add(eid)
        mutation_ids.add(mid)
    # Native anchor IDs describe validated candidates before the observation
    # cap; an omitted anchor is not itself delivered evidence. Require a real
    # observed anchor and bind the other anchors to these same source receipts.
    anchors = set(episode["anchor_fact_ids"])
    eligible_fact_ids = {fid for eid in event_ids for fid in eligible[eid]["fact_ids"]}
    if (fact_ids != set(episode["source_fact_ids"]) or observed_events != event_ids
            or mutation_ids != set(episode["source_mutation_ids"]) or not anchors & fact_ids
            or not anchors <= eligible_fact_ids):
        return set(), "episode_source_closure"
    return event_ids, None


def guidance_delivery(guidance, eligible, query_scope, at):
    """Bind only native assessment feedback; ordinary current controls do not count."""
    if not isinstance(guidance, dict):
        return set(), "guidance_shape"
    if guidance.get("kernel") != "practice" or guidance.get("slot") != "practice_feedback":
        return set(), None
    eid, version = guidance.get("source_event_id"), guidance.get("policy_version")
    if not integer(eid) or eid not in eligible:
        return set(), "guidance_receipt_not_applicable"
    if (version not in ("teaching-guidance.v1", "teaching-guidance.v2") or guidance.get("status") != "active"
            or guidance.get("cancelled") is True or guidance.get("lifetime") != "task"
            or guidance.get("evidence_kind") not in {"supported_success", "independent_success", "success_assistance_unspecified",
                                                    "evaluated_error", "incomplete_attempt"}
            or not isinstance(guidance.get("instruction"), str) or not guidance["instruction"].strip()):
        return set(), "guidance_active_assessment_contract"
    occurred, expires = timestamp(guidance.get("occurred_at")), timestamp(guidance.get("expires_at"))
    if occurred != timestamp(eligible[eid]["occurred_at"]) or expires is None or not occurred <= at < expires:
        return set(), "guidance_receipt_time_or_expiry"
    scope = guidance.get("application_scope") if version == "teaching-guidance.v2" else guidance.get("scope")
    if not isinstance(scope, dict) or any(not same_id(scope.get(name), eligible[eid]["scope"].get(name)) for name in SCOPE):
        return set(), "guidance_receipt_scope"
    if any(scope.get(name) is not None and not same_id(scope[name], query_scope.get(name)) for name in SCOPE):
        return set(), "guidance_application_scope"
    if version == "teaching-guidance.v2":
        origin = guidance.get("source_scope")
        if (set(scope) != set(SCOPE) or scope != guidance.get("scope") or not isinstance(origin, dict)
                or set(origin) != set(SCOPE) or any(not same_id(origin.get(name), eligible[eid]["scope"].get(name)) for name in SCOPE)):
            return set(), "guidance_source_scope"
    item_key = guidance.get("item_key")
    if item_key is not None and item_key != f"{eligible[eid]['item_type']}:{eligible[eid]['item_id']}":
        return set(), "guidance_item_binding"
    return {eid}, None


def delivered_assessments(packet, indexes, eligible, query_scope, at):
    available, errors = set(), []
    for field in ("learning_episodes", "teaching_guidance"):
        projections = packet.get(field) or []
        if not isinstance(projections, list):
            errors.append({"projection": field, "reason": "projection_list_required"})
            continue
        for position, projection in enumerate(projections):
            ids, error = (episode_delivery(projection, indexes, eligible) if field == "learning_episodes"
                          else guidance_delivery(projection, eligible, query_scope, at))
            if error:
                errors.append({"projection": field, "position": position, "reason": error})
            else:
                available.update(ids)
    return available, errors


def audit_condition(row, indexes):
    packet, plan = row.get("packet") or {}, row.get("plan") or {}
    result = {key: row.get(key) for key in ("case_id", "family_id", "domain", "pattern", "split", "variant", "budget", "repeat")}
    result.update(post_hoc_audit=True, status="not_applicable", reason=None, freshness_passed=None,
                  stale_event_reference=None, action_differs_from_latest_assessment=None)
    actions = [action for action in plan.get("teaching_decisions") or [] if action.get("action") in PRACTICE_ACTIONS]
    if not actions:
        result["reason"] = "no_actual_assessment_feedback_action"
        return result
    scope = packet.get("scope") or {}
    if (scope.get("mode") != "checkpoint" or any(not integer(scope.get(name)) for name in ("learner_id", "project_id", "checkpoint_id"))):
        result["reason"] = "query_scope_not_an_explicit_checkpoint"
        return result
    if (packet.get("manifest", {}).get("query_plan") or {}).get("temporal") != "current":
        result["reason"] = "query_not_declared_current_feedback"
        return result
    current = [event for event in indexes["events"].values()
               if event.get("event_type") == "vnext_teaching_input_received" and event.get("source") == "vnext"
               and event.get("client_event_id") in (f"current-{row['case_id']}", f"{scope['learner_id']}:current-{row['case_id']}")
               and all(same_id(event.get(name), scope.get(name)) for name in ("learner_id", *SCOPE))]
    if len(current) != 1 or timestamp(current[0].get("occurred_at")) is None:
        result["reason"] = "missing_unique_current_input_time_receipt"
        return result
    at = timestamp(current[0]["occurred_at"])
    result.update(query_at=at.isoformat(), query_time_source_event_id=current[0]["id"],
                  query_scope={name: scope.get(name) for name in ("learner_id", *SCOPE)})
    eligible, exclusions = {}, Counter()
    for event in indexes["events"].values():
        if event.get("event_type") not in ASSESSMENTS:
            continue
        reference, error = valid_assessment(event, indexes, scope, at)
        if reference:
            eligible[reference["event_id"]] = reference
        else:
            exclusions[error] += 1
    result.update(eligible_assessment_count=len(eligible), excluded_assessments=dict(exclusions))
    if not eligible:
        result["reason"] = "no_valid_assessment_applicable_to_query"
        return result
    latest = max(eligible.values(), key=lambda e: (timestamp(e["occurred_at"]), e["event_id"]))
    result["latest_applicable_assessment"] = latest
    if len(actions) != 1:
        result.update(status="invalid", reason="multiple_actual_assessment_actions")
        return result
    action = actions[0]
    ids = action.get("source_event_ids")
    if not isinstance(ids, list) or not ids or not all(integer(x) for x in ids) or len(set(ids)) != len(ids):
        result.update(status="invalid", reason="invalid_decision_source_ids")
        return result
    result.update(actual_action=action["action"], actual_source_event_ids=ids)
    if any(identifier not in eligible for identifier in ids):
        result.update(status="invalid", reason="decision_source_is_not_valid_applicable_assessment")
        return result
    delivered, projection_errors = delivered_assessments(packet, indexes, eligible, scope, at)
    result.update(delivered_assessment_event_ids=sorted(delivered), delivery_projection_errors=projection_errors)
    if not set(ids) <= delivered:
        result.update(status="invalid", reason="decision_source_not_delivered_by_valid_packet_projection")
        return result
    cited = max((eligible[identifier] for identifier in ids), key=lambda e: (timestamp(e["occurred_at"]), e["event_id"]))
    stale = (timestamp(cited["occurred_at"]), cited["event_id"]) < (timestamp(latest["occurred_at"]), latest["event_id"])
    result.update(status="fail" if stale else "pass", reason="older_assessment_used_as_current_feedback" if stale else "latest_applicable_assessment_cited",
                  freshness_passed=not stale, stale_event_reference=stale,
                  action_differs_from_latest_assessment=action["action"] != latest["reference_action"],
                  cited_assessment=cited, packet_episode_count=len(packet.get("learning_episodes") or []),
                  packet_episode_budget_omitted=(packet.get("retrieval_diagnostics", {}).get("episodes") or {}).get("budget_omitted"))
    return result


def summarize(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["budget"], row["variant"])].append(row)
    result = []
    for (budget, variant), members in sorted(groups.items()):
        counts = Counter(row["status"] for row in members)
        applicable = sum(counts[name] for name in ("pass", "fail"))
        result.append({"budget": budget, "variant": variant, "conditions": len(members),
                       "status_counts": dict(counts), "freshness_pass_numerator": counts["pass"],
                       "freshness_denominator": applicable, "freshness_pass_rate": counts["pass"] / applicable if applicable else None,
                       "stale_references": sum(row["stale_event_reference"] is True for row in members),
                       "stale_with_different_action": sum(row["stale_event_reference"] is True and row["action_differs_from_latest_assessment"] is True for row in members),
                       "na_reasons": dict(Counter(row["reason"] for row in members if row["status"] == "not_applicable")),
                       "failure_patterns": dict(Counter(row["pattern"] for row in members if row["status"] == "fail"))})
    return result


def run_audit(raw_paths, output, variants=None):
    raw_paths = [Path(path).absolute() for path in raw_paths]
    if not 1 <= len(raw_paths) <= 8 or len(set(raw_paths)) != len(raw_paths):
        raise ValueError("Provide one to eight distinct raw files from the same run")
    output = Path(output).absolute()
    if output.exists():
        raise FileExistsError("Audit output must be new; previous audits are immutable")
    script_sha256 = file_hash(Path(__file__))
    sources, rows, formations, conditions = {}, [], set(), set()
    for raw in raw_paths:
        before = file_hash(raw)
        source = {"sha256": before, "bytes": raw.stat().st_size}
        manifest = raw.with_name("manifest.json")
        if manifest.exists():
            metadata = json.loads(manifest.read_text())
            source.update(formation_manifest_sha256=file_hash(manifest), declared_run_status=metadata.get("status"),
                          declared_changed_sources=metadata.get("changed_sources"),
                          product_and_driver_source_hashes_sha256=json_hash(metadata.get("source_hashes")))
        indexes_by_case = {}
        with (gzip.open if raw.suffix == ".gz" else open)(raw, "rt", encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("kind") == "formation":
                    case_id = row["case_id"]
                    if case_id in formations:
                        raise ValueError("Duplicate formation case; do not combine separate runs")
                    formations.add(case_id)
                    indexes_by_case[case_id] = state_indexes(row["state"])
                elif row.get("plan") is not None and row.get("packet") is not None:
                    if variants and row.get("variant") not in variants:
                        continue
                    identity = (row["case_id"], row["budget"], row["variant"], row.get("repeat", 0))
                    if identity in conditions:
                        raise ValueError("Duplicate actual condition")
                    conditions.add(identity)
                    if row["case_id"] not in indexes_by_case:
                        raise ValueError("Actual plan is missing its preceding formation snapshot")
                    rows.append(audit_condition(row, indexes_by_case[row["case_id"]]))
        if file_hash(raw) != before:
            raise RuntimeError("Raw evidence changed during audit")
        sources[str(raw)] = source
    if not rows:
        raise ValueError("No actual saved packet/plan conditions selected")
    if file_hash(Path(__file__)) != script_sha256:
        raise RuntimeError("Audit script changed during execution")
    summary = {"schema": VERSION, "post_hoc_audit": True, "audit_completed": True,
               "created_at": datetime.now(timezone.utc).isoformat(), "conditions": len(rows), "formation_cases": len(formations),
               "variants_selected": sorted(set(row["variant"] for row in rows)),
               "audit_script_sha256": script_sha256, "raw_sources": sources,
               "ordering": ["EvidenceEvent.occurred_at", "EvidenceEvent.id"],
               "query_time_source": "same-scope current input receipt occurred_at; naive database UTC timestamps interpreted as UTC",
               "groups": summarize(rows), "limitations": LIMITATIONS}
    output.mkdir(parents=True, exist_ok=False)
    for name, members in (("conditions.jsonl", rows), ("issues.jsonl", [row for row in rows if row["status"] in ("fail", "invalid")])):
        with (output / name).open("x", encoding="utf-8") as stream:
            for row in sorted(members, key=lambda r: (r["case_id"], r["budget"], r["variant"], r.get("repeat") or 0)):
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    summary["output_sha256"] = {name: file_hash(output / name) for name in ("conditions.jsonl", "issues.jsonl")}
    with (output / "summary.json").open("x", encoding="utf-8") as stream:
        json.dump(summary, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, nargs="+", required=True, help="Saved education raw.jsonl[.gz] shards, normally four files")
    parser.add_argument("--output", type=Path, required=True, help="New audit artifact directory")
    parser.add_argument("--variants", nargs="+", help="Optional selection, e.g. full no_episodes; default audits all")
    args = parser.parse_args()
    summary = run_audit(args.raw, args.output, set(args.variants or []))
    print(json.dumps({key: summary[key] for key in ("schema", "post_hoc_audit", "conditions", "formation_cases", "groups")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
