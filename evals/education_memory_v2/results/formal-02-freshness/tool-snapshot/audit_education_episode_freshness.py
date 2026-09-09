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

VERSION = "learnflow.education-episode-freshness-audit.v1"
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
