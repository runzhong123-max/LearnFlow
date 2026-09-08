"""Deterministic snapshot checks; no model, pedagogy judge, or product imports.

These checks establish data consistency, visible delivery and declared plan bounds.
They do not establish mastery, answer quality, or teaching effectiveness.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def _check(name: str, passed: bool | None, actual: Any, expected: Any, *, denominator: int | None = None) -> dict:
    result = {"name": name, "passed": None if passed is None else bool(passed), "actual": actual, "expected": expected}
    if denominator is not None:
        result["denominator"] = denominator
        if denominator == 0:
            result["passed"] = None
            result["not_applicable_reason"] = "No corresponding observations; excluded from pass/fail denominator"
    return result


def _key(value: Any) -> str | None:
    return None if value is None or isinstance(value, bool) else str(value)


def _index(rows: list[dict]) -> tuple[dict, list]:
    result, bad = {}, []
    for row in rows:
        key = _key(row.get("id"))
        if key is None or key in result:
            bad.append(row.get("id"))
        else:
            result[key] = row
    return result, bad


def _stable_paths(value: Any, path: str = "") -> list[str]:
    """Inspect status/level values only, avoiding incidental policy prose."""
    found = []
    if isinstance(value, dict):
        for name, child in value.items():
            child_path = f"{path}.{name}"
            if name in {"level", "status"} and child in ("stable", "spaced_stable"):
                found.append(child_path)
            elif name == "stable" and child is True:
                found.append(child_path)
            elif isinstance(child, (dict, list)):
                found.extend(_stable_paths(child, child_path))
            elif isinstance(child, str) and child in {"stable", "spaced_stable"} and name not in {
                "policy", "policy_version", "description", "reason", "instruction"
            }:
                found.append(child_path)
    elif isinstance(value, list):
        for position, child in enumerate(value):
            found.extend(_stable_paths(child, f"{path}[{position}]"))
    elif value in ("stable", "spaced_stable"):
        found.append(path)
    return found


def verify_formation(state: dict) -> dict:
    """Check a scenario consisting of ordinary concept attempts, not spaced review."""
    events, event_dupes = _index(state.get("events", []))
    attempts, attempt_dupes = _index(state.get("attempts", []))
    mutations, mutation_dupes = _index(state.get("mutations", []))
    _, fact_dupes = _index(state.get("facts", []))
    stable = []
    for kernel, projection in (state.get("states") or {}).items():
        for section in ("short_term", "long_term"):
            data = projection.get(section) or {}
            names = ("mastery", "proof_chain") if section == "long_term" else ("proof_chain",)
            for name in names:
                stable.extend(_stable_paths(data.get(name), f"{kernel}.{section}.{name}"))
    attempt_errors, concept_count = [], 0
    for event in events.values():
        if event.get("event_type") != "concept_attempt_evaluated":
            continue
        concept_count += 1
        payload = event.get("payload") or {}
        attempt = attempts.get(_key(payload.get("attempt_id")))
        result = attempt.get("result") if attempt else None
        actual = result.get("correct") if isinstance(result, dict) else result
        expected = payload.get("correct")
        if attempt is None or type(actual) is not bool or type(expected) is not bool or actual != expected:
            attempt_errors.append({"event_id": event.get("id"), "attempt_id": payload.get("attempt_id"),
                                   "event_correct": expected, "attempt_correct": actual})
        elif payload.get("item_id") is not None and _key(payload["item_id"]) != _key(attempt.get("item_id")):
            attempt_errors.append({"event_id": event.get("id"), "reason": "item_id_mismatch"})
    chain_errors = []
    for fact in state.get("facts", []):
        mutation = mutations.get(_key(fact.get("mutation_id")))
        event = events.get(_key(fact.get("event_id")))
        reasons = []
        if mutation is None:
            reasons.append("missing_mutation")
        if event is None:
            reasons.append("missing_event")
        if mutation:
            if _key(mutation.get("event_id")) != _key(fact.get("event_id")):
                reasons.append("event_link_mismatch")
            if not fact.get("kernel") or mutation.get("kernel") != fact.get("kernel"):
                reasons.append("kernel_mismatch")
        if reasons:
            chain_errors.append({"fact_id": fact.get("id"), "reasons": reasons})
    return {"checks": [
        _check("no_stable_mastery", not stable, stable, "No stable mastery or proof-chain status from ordinary concept attempts"),
        _check("snapshot_unique_ids", not any((event_dupes, attempt_dupes, mutation_dupes, fact_dupes)),
               {"events": event_dupes, "attempts": attempt_dupes, "mutations": mutation_dupes, "facts": fact_dupes}, "Unique non-null IDs per entity"),
        _check("attempt_event_link", not attempt_errors and not event_dupes and not attempt_dupes,
               {"concept_events_checked": concept_count, "errors": attempt_errors}, "Every concept event links to a real attempt with the same Boolean result and item", denominator=concept_count),
        _check("fact_chain", not chain_errors and not event_dupes and not mutation_dupes and not fact_dupes,
               {"facts_checked": len(state.get("facts", [])), "errors": chain_errors}, "Fact -> mutation -> event exists; fact/mutation kernel and event IDs agree", denominator=len(state.get("facts", []))),
    ], "unscored": [
        {"name": "evidence_grade_semantics", "reason": "Grade labels and confidence thresholds are not independently justified by this snapshot checker"},
        {"name": "learning_effectiveness", "reason": "Ordinary concept scoring is not validated spaced review or stable mastery evidence"},
    ]}


def _visible(packet: dict) -> list[tuple[str, dict, dict]]:
    result = []
    for index, item in enumerate(packet.get("items") or []):
        result.append((f"items[{index}]", item, item.get("detail") or {}))
    for index, path in enumerate(packet.get("relation_paths") or []):
        for side in ("source", "target"):
            endpoint = path.get(side)
            if isinstance(endpoint, dict):
                result.append((f"relation_paths[{index}].{side}", endpoint, endpoint))
    return result


def _lookup(mapping: dict, value: Any) -> Any:
    key = _key(value)
    if key is None:
        return None
    return next((row for identifier, row in mapping.items() if _key(identifier) == key), None)


def _excerpt_error(text: Any, metadata: Any, source: Any) -> list[str]:
    if not isinstance(source, str) or not isinstance(text, str) or not isinstance(metadata, dict):
        return ["missing_source_text_or_metadata"]
    reasons = []
    if metadata.get("sha256") != hashlib.sha256(source.encode("utf-8")).hexdigest():
        reasons.append("sha256_mismatch")
    if type(metadata.get("chars")) is not int or metadata["chars"] != len(source):
        reasons.append("source_length_mismatch")
    ranges = metadata.get("ranges")
    valid = isinstance(ranges, list) and bool(ranges)
    last_end = -1
    pieces = []
    for span in ranges if isinstance(ranges, list) else []:
        if not isinstance(span, (list, tuple)) or len(span) != 2 or any(type(x) is not int for x in span):
            valid = False
            continue
        start, end = span
        if not 0 <= start <= end <= len(source) or start < last_end:
            valid = False
        else:
            pieces.append(source[start:end])
        last_end = end
    if not valid:
        reasons.append("invalid_ranges")
    elif " … ".join(pieces) != text:
        reasons.append("visible_text_does_not_match_ranges")
    return reasons


def _estimated_tokens(packet: dict) -> int:
    body = {"heads": packet.get("kernel_heads", {}), "items": packet.get("items", []),
            "paths": packet.get("relation_paths", []),
            "personal_concept_graph": packet.get("personal_concept_graph", {}),
            "adaptation_directives": packet.get("adaptation_directives", {}),
            "teaching_guidance": packet.get("teaching_guidance", {})}
    return max(1, math.ceil(len(json.dumps(body, ensure_ascii=False, sort_keys=True, default=str)) / 3.2))


def _source_association(source: dict | None, item: dict, detail: dict, events: dict) -> tuple[set, bool, list]:
    """Trust only the driver's DB-derived node binding/Fact event closure.

    A module/claim closure demonstrates attribution, not that its summary is
    semantically correct. Packet event declarations cannot enlarge this closure.
    """
    errors = []
    if source is None:
        return set(), False, ["missing_source_node"]
    node_type = source.get("node_type")
    direct = _key(source.get("source_event_id"))
    is_fact = node_type == "fact" or (node_type is None and direct is not None)
    if is_fact:
        allowed = {direct} if direct is not None else set()
        if direct is None:
            errors.append("missing_fact_event_binding")
        if _key(detail.get("source_event_id")) != direct:
            errors.append("node_event_mismatch")
    else:
        closure = source.get("evidence_event_ids")
        if not isinstance(closure, list) or any(_key(value) is None for value in closure):
            errors.append("missing_or_invalid_event_closure")
            allowed = set()
        else:
            allowed = {_key(value) for value in closure}
    if node_type is not None and item.get("node_type") is not None and node_type != item["node_type"]:
        errors.append("node_type_mismatch")
    declared = [detail.get("source_event_id")]
    refs = item.get("evidence_refs")
    if refs is not None and not isinstance(refs, list):
        errors.append("invalid_event_refs")
    elif refs:
        declared.extend(refs)
    for value in declared:
        if value is not None and _key(value) not in allowed:
            errors.append("declared_event_outside_node_closure")
    if any(_lookup(events, value) is None for value in allowed):
        errors.append("missing_event")
    return allowed, is_fact, sorted(set(errors))


def verify_trial(packet: dict, plan: dict, case: dict, rubric: dict, expected_evidence: list[dict]) -> dict:
    """Verify observable packet/plan invariants without keyword-grading pedagogy."""
    visible = _visible(packet)
    scope = case.get("_scope") or {}
    sources = packet.get("_source_nodes") or {}
    events = packet.get("_source_events") or {}
    excerpt_errors, scope_errors, source_errors = [], [], []
    valid_paths = set()
    associations = {}
    for path, item, detail in visible:
        source = _lookup(sources, item.get("id"))
        errors = _excerpt_error(item.get("text"), detail.get("source_text"), source.get("text") if source else None)
        if errors:
            excerpt_errors.append({"path": path, "id": item.get("id"), "reasons": errors})
        current_scope_errors = []
        if source is None:
            current_scope_errors.append("missing_source_node")
        else:
            for name in ("learner_id", "project_id", "checkpoint_id"):
                expected, actual = scope.get(name), source.get(name)
                if name == "learner_id":
                    if expected is None or _key(actual) != _key(expected):
                        current_scope_errors.append(name)
                elif expected is not None and actual is not None and _key(actual) != _key(expected):
                    current_scope_errors.append(name)
            if source.get("status") not in {"active", "transient", "legacy", "superseded"}:
                current_scope_errors.append("source_status")
            if item.get("status") != source.get("status"):
                current_scope_errors.append("status_mismatch")
        if current_scope_errors:
            scope_errors.append({"path": path, "reasons": current_scope_errors})
        allowed_events, is_fact, current_source_errors = _source_association(source, item, detail, events)
        associations[path] = (allowed_events, is_fact)
        if current_source_errors:
            source_errors.append({"path": path, "reasons": current_source_errors})
        if not errors and not current_scope_errors and not current_source_errors:
            valid_paths.add(path)
    fact_delivered, attributed_delivered = [], []
    for index, evidence in enumerate(expected_evidence):
        terms = evidence.get("terms")
        well_formed = (evidence.get("source_event_id") is not None and isinstance(terms, list)
                       and bool(terms) and all(isinstance(term, str) and bool(term) for term in terms))
        matching, fact_matching = [], []
        if well_formed:
            for path, item, detail in visible:
                allowed_events, is_fact = associations[path]
                if path not in valid_paths or _key(evidence["source_event_id"]) not in allowed_events:
                    continue
                if all(term in item["text"] for term in terms):
                    matching.append(path)
                    if is_fact:
                        fact_matching.append(path)
        for rows, paths in ((fact_delivered, fact_matching), (attributed_delivered, matching)):
            rows.append({"index": index, "kind": evidence.get("kind"), "source_event_id": evidence.get("source_event_id"),
                         "terms": terms, "delivered": bool(paths), "visible_paths": paths,
                         "valid_expectation": well_formed})
    phases = plan.get("phases") or []
    verify = [phase for phase in phases if phase.get("kind", phase.get("id")) == "verify"]
    completed = [phase.get("id") for phase in phases if phase.get("status") == "completed"]
    reported = (packet.get("manifest") or {}).get("token_estimate")
    actual_tokens = _estimated_tokens(packet)
    budget = case.get("_budget")
    checks = [
        _check("budget", type(budget) is int and budget > 0 and type(reported) is int and reported == actual_tokens and actual_tokens <= budget,
               {"reported_token_estimate": reported, "recomputed_token_estimate": actual_tokens}, {"maximum": budget, "manifest_matches_recomputation": True}),
        _check("no_human_raw_memory", all(item.get("kernel") != "human" for _, item, _ in visible),
               [path for path, item, _ in visible if item.get("kernel") == "human"], "No human-kernel raw item or path endpoint"),
        _check("verify_required", bool(verify) and all(phase.get("required") is True for phase in verify),
               [{"id": p.get("id"), "required": p.get("required")} for p in verify], "A required verify phase exists"),
        _check("no_premature_completion", bool(phases) and not completed, completed, "No newly generated phase marked completed"),
        _check("source_excerpts", not excerpt_errors, {"visible_nodes_checked": len(visible), "errors": excerpt_errors}, "Visible text exactly reconstructs source ranges and original SHA-256/length", denominator=len(visible)),
        _check("visible_memory_scope", not scope_errors, {"visible_nodes_checked": len(visible), "errors": scope_errors}, "Same learner, compatible project/checkpoint and allowed source status", denominator=len(visible)),
        _check("visible_event_sources", not source_errors, source_errors, "Source events exist; declarations are within the DB-derived Fact binding or Module/Claim event closure", denominator=len(visible)),
        _check("source_fact_evidence_delivered", all(row["delivered"] for row in fact_delivered), fact_delivered,
               "Each expected event has every complete term in one valid original Fact excerpt with the actual Fact event binding", denominator=len(expected_evidence)),
        _check("attributed_evidence_delivered", all(row["delivered"] for row in attributed_delivered), attributed_delivered,
               "Each expected event has every complete term in one valid Fact/Module/Claim excerpt whose DB-derived event closure contains it; text delivery only, not semantic accuracy", denominator=len(expected_evidence)),
    ]
    unscored = [
        {"name": "semantic_rubrics", "reason": "Teaching semantics, next-step quality and rubric free text require separate reviewed scoring"},
        {"name": "withhold_full_solution", "reason": "No validated semantic answer-disclosure judge; keyword checks are not used"},
        {"name": "actual_session_duration", "reason": "Declared plan minutes are observable; elapsed learner time is not measured"},
        {"name": "teaching_guidance_scope_source_expiry", "reason": "Native selector consumed; current controls checked by event IDs, historical source/scope/expiry not independently scored"},
        {"name": "evidence_grade_semantics", "reason": "Labels do not independently establish evidence quality or learning achievement"},
        {"name": "summary_semantic_accuracy", "reason": "Module/Claim event attribution and literal term presence do not validate summary meaning"},
    ]
    constraint = (rubric.get("active_constraints") or {}).get("max_session_minutes")
    if type(constraint) is int and constraint == 10:
        actual_minutes = plan.get("estimated_minutes")
        checks.append(_check("actual_plan_minutes", type(actual_minutes) in (int, float) and math.isfinite(actual_minutes) and 0 < actual_minutes <= 10,
                             actual_minutes, "0 < plan.estimated_minutes <= 10; metadata alone does not count"))
    return {"checks": checks, "unscored": unscored}
