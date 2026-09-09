"""Deterministic, scoped teaching controls inside the five-kernel projection.

These controls are not mastery claims and never wait for memory consolidation.
The caller persists returned patches through the ordinary evidence reducer.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import re
from typing import Any

from .teaching_control_parser import (
    PARSER_VERSION, CONTROL_POLICY_LIMITS, DEFAULT_SESSION_HOURS,
    MAX_EXPLICIT_WINDOW_HOURS, parse_text_controls,
)

GUIDANCE_VERSION = "teaching-guidance.v2"
SUPPORTED_GUIDANCE_VERSIONS = frozenset({"teaching-guidance.v1", GUIDANCE_VERSION})
GUIDANCE_EVENT_TYPES = frozenset({
    "user_message", "vnext_teaching_input_received",
    "vnext_human_adaptation_requested", "semantic_observation_proposed",
    "concept_attempt_evaluated", "exercise_attempt_evaluated",
    "remediation_retry_evaluated", "remediation_variant_evaluated",
    "review_attempt_evaluated", "transfer_attempt_evaluated",
})
_USER_EVENTS = {"user_message", "vnext_teaching_input_received"}
_GRADE_EVENTS = GUIDANCE_EVENT_TYPES - _USER_EVENTS - {
    "vnext_human_adaptation_requested", "semantic_observation_proposed",
}
_SCOPE_KEYS = ("project_id", "checkpoint_id", "session_id")
_PRIORITY = {
    "time_budget": 95, "practice_feedback": 90, "current_blocker": 90,
    "current_priority": 85, "return_anchor": 85, "code_participation": 80,
    "example_selection": 80, "response_length": 80, "pace": 75,
    "representation": 75, "support": 75, "code_language": 70,
    "starting_point": 60, "clarification": 10,
}
_ARCHIVE_KEYS = {
    "time_budget": {"planning_availability", "weekly_hours", "cognitive_load"},
    "pace": {"pace_adjustment", "pace_preference", "support_need"},
    "representation": {"format_request", "preferred_modes", "learning_preferences"},
    "code_language": {"format_request", "preferred_modes", "learning_preferences"},
    "response_length": {"format_request", "cognitive_load", "support_need"},
    "support": {"support_need", "frustration", "affect", "cognitive_load"},
    "code_participation": {"format_request", "support_need"},
    "example_selection": {"format_request", "support_need"},
}


def _time(value: Any) -> datetime | None:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _scope(event: Any) -> dict:
    return {key: getattr(event, key, None) for key in _SCOPE_KEYS}


def _same_scope(left: dict, right: dict) -> bool:
    return all(left.get(key) == right.get(key) for key in _SCOPE_KEYS)


def _items(states: dict, kernel: str, storage: str, key: str) -> list[dict]:
    values = ((states.get(kernel) or {}).get(storage) or {}).get(key)
    return deepcopy([item for item in values if isinstance(item, dict)]) if isinstance(values, list) else []


def reduce_teaching_guidance(event: Any, states: dict) -> dict:
    """Return changed kernel patches; replay depends only on event and prior state."""
    event_type = getattr(event, "event_type", "")
    if event_type not in GUIDANCE_EVENT_TYPES:
        return {}
    payload = getattr(event, "payload", None) or {}
    if not isinstance(payload, dict):
        return {}
    at = _time(getattr(event, "occurred_at", None)) or _time(getattr(event, "created_at", None))
    # Undated legacy input cannot acquire a freshly renewed eight-hour lifetime.
    if at is None:
        return {}
    scope = _scope(event)
    event_id = getattr(event, "id", None)
    patches: dict[str, dict] = {}

    def get(kernel: str, storage: str = "short_term") -> list[dict]:
        key = "teaching_preferences" if storage == "long_term" else "teaching_directives"
        cached = (patches.get(kernel) or {}).get(storage, {}).get(key)
        return deepcopy(cached) if cached is not None else _items(states, kernel, storage, key)

    def save(kernel: str, values: list[dict], storage: str = "short_term") -> None:
        key = "teaching_preferences" if storage == "long_term" else "teaching_directives"
        original = _items(states, kernel, storage, key)
        if values != original:
            patches.setdefault(kernel, {"short_term": {}, "long_term": {}})[storage][key] = values
        elif kernel in patches:
            patches[kernel][storage].pop(key, None)
            if not any(patches[kernel].values()):
                patches.pop(kernel)

    def put(kernel: str, slot: str, instruction: str, *, lifetime: str = "session",
            evidence_kind: str = "explicit_request", item_key: str | None = None,
            status: str = "active", details: dict | None = None,
            source_span: list[int] | None = None, window: dict | None = None) -> None:
        persistent = lifetime == "persistent"
        if not persistent and not any(scope.values()):
            return
        if lifetime == "turn" and scope.get("session_id") is None:
            return
        storage = "long_term" if persistent else "short_term"
        entry_scope = {key: None for key in _SCOPE_KEYS} if persistent else dict(scope)
        expiration = None if persistent else (at + timedelta(hours=DEFAULT_SESSION_HOURS)).isoformat()
        if window:
            # Source identity is retained. Only this explicit, bounded window can
            # have a different application session, never a different project.
            if type(scope.get("project_id")) is not int or scope["project_id"] <= 0 or scope.get("session_id") is None:
                status, instruction = "uncertain", ""
                details = {**(details or {}), "diagnostic_only": True, "diagnostic_reason": "explicit_window_requires_project_session"}
            else:
                entry_scope["session_id"] = None
                lifetime = "project_window"
                expiration = window["expires_at"]
        values = get(kernel, storage)
        diagnostic_only = bool((details or {}).get("diagnostic_only"))
        matching = [entry for entry in values if entry.get("slot") == slot
                    and entry.get("item_key") == item_key
                    and bool(entry.get("diagnostic_only")) == diagnostic_only
                    and _same_scope(entry.get("application_scope") or entry.get("scope") or {}, entry_scope)]
        order = (at, int(event_id or 0), (source_span or [0])[0])
        def entry_order(entry):
            return (_time(entry.get("occurred_at")) or datetime.min.replace(tzinfo=timezone.utc),
                    int(entry.get("source_event_id") or 0), (entry.get("source_span") or [0])[0])
        if any(entry_order(entry) > order for entry in matching):
            return
        entry = {
            "kernel": kernel, "slot": slot, "instruction": instruction,
            "scope": deepcopy(entry_scope), "source_scope": deepcopy(scope),
            "application_scope": deepcopy(entry_scope), "source_event_id": event_id,
            "source_span": deepcopy(source_span), "parser_version": PARSER_VERSION,
            "occurred_at": at.isoformat(), "expires_at": expiration,
            "lifetime": lifetime, "evidence_kind": evidence_kind, "status": status,
            "policy_version": GUIDANCE_VERSION, "priority": _PRIORITY[slot],
            "mastery_inference": False,
        }
        if window and lifetime == "project_window":
            entry.update(expiry_basis=window.get("expiry_basis", "explicit_timezone_iso"), deadline_source_span=window.get("span"))
        if item_key is not None:
            entry["item_key"] = item_key
        if details:
            entry.update(details)
        # Re-delivery of the same source/span is an exact no-op. Prior successful
        # controls remain auditable within the existing bounded control storage.
        values = [value for value in values if not (value.get("source_event_id") == event_id
                  and value.get("source_span") == source_span and value.get("slot") == slot
                  and value.get("item_key") == item_key)]
        for value in values:
            if value in matching and value.get("status") != "superseded":
                value["status"] = "superseded"
                value["superseded_by_event_id"] = event_id
        values.append(entry)
        values.sort(key=entry_order)
        save(kernel, values[-(8 if persistent else 24):], storage)

    if event_type in _USER_EVENTS:
        # Consumption is represented by the next input, not by a read side effect.
        # A retried read and a replay therefore return exactly the same controls.
        if scope.get("session_id") is not None:
            for kernel in states:
                values = get(kernel)
                save(kernel, [entry for entry in values if not (
                    entry.get("lifetime") == "turn"
                    and (entry.get("scope") or {}).get("session_id") == scope["session_id"]
                    and entry.get("source_event_id") != event_id
                    and _entry_order(entry)[:2] < (at, int(event_id or 0))
                )])
        raw = str(payload.get("text") or payload.get("content") or "")
        parsed = parse_text_controls(raw, at)
        for action in parsed["actions"]:
            if action["lifetime"] != "persistent" and scope.get("session_id") is None:
                continue
            if action["details"].get("cancel_project_window"):
                values = get(action["kernel"])
                if any(entry.get("source_event_id") == event_id and entry.get("source_span") == action["source_span"]
                       and entry.get("slot") == action["slot"] for entry in values):
                    continue
                matching = [entry for entry in values if entry.get("policy_version") == GUIDANCE_VERSION
                    and entry.get("lifetime") == "project_window" and entry.get("slot") == action["slot"]
                    and entry.get("status") == "active" and not entry.get("cancelled")
                    and _v2_scope_reason(entry, "short_term") is None
                    and all((entry.get("application_scope") or {}).get(key) == scope.get(key) for key in ("project_id", "checkpoint_id"))
                    and _entry_order(entry) <= (at, int(event_id or 0), action["source_span"][0])
                    and (_strict_time(entry.get("expires_at")) or at) > at]
                if matching:
                    original = max(matching, key=_entry_order)
                    action["window"] = {"expires_at": original["expires_at"], "expiry_basis": "inherited_cancelled_window"}
                    action["details"].update(cancelled_window_source_event_id=original["source_event_id"],
                        cancelled_window_expires_at=original["expires_at"])
                    put(**action)
                else:
                    put(action["kernel"], action["slot"], "", status="uncertain", source_span=action["source_span"],
                        details={"diagnostic_only": True, "diagnostic_reason": "no_matching_project_window"})
                continue
            if action["evidence_kind"] == "self_reported_resolution":
                save("knowledge", [entry for entry in get("knowledge") if not (
                    entry.get("slot") == "current_blocker" and _same_scope(entry.get("scope") or {}, scope)
                    and _entry_order(entry) <= (at, int(event_id or 0), action["source_span"][0])
                )])
            put(**action)
        # Unsafe/no-request text keeps the old empty-patch behavior. An explicit
        # but malformed control window is retained as metadata-only uncertainty.
        for diagnostic in parsed["diagnostics"]:
            if diagnostic.get("slot") and scope.get("session_id") is not None:
                put({"time_budget": "human", "current_priority": "value", "return_anchor": "structure"}[diagnostic["slot"]], diagnostic["slot"], "",
                    status="uncertain", source_span=diagnostic["source_span"],
                    details={"diagnostic_only": True, "diagnostic_reason": diagnostic["reason"]})
    elif event_type == "vnext_human_adaptation_requested":
        if payload.get("explicit", True) is not True or scope.get("session_id") is None:
            return patches
        kind, value = payload.get("signal_kind"), payload.get("value")
        mapping = {
            ("pace_adjustment", "slower"): ("pace", "放慢节奏，每次推进一个步骤并检查理解。"),
            ("pace_adjustment", "faster"): ("pace", "适度加快节奏，压缩已理解部分，保留必要检查。"),
            ("format_request", "concise"): ("response_length", "本次解释保持简洁，先呈现关键点。"),
            ("format_request", "visual"): ("representation", "用一个简洁图示辅助当前解释。"),
            ("format_request", "example"): ("representation", "先给一个小例子，再解释它对应的原理。"),
            ("format_request", "code"): ("representation", "用一个最小代码例子说明当前概念。"),
            ("format_request", "steps"): ("representation", "按步骤解释，每一步说明目的。"),
            ("format_request", "alternative"): ("representation", "换一种讲法，不重复刚才的解释。"),
        }
        matched = mapping.get((kind, value))
        if matched:
            put("human", *matched, details={"format": value} if kind == "format_request" else None)
        elif kind in {"cognitive_load", "frustration", "support_need"}:
            put("human", "support", "学生明确请求当前学习支持。缩小步幅，先处理一个可完成的小目标，并询问是否需要调整。")
    elif event_type in _GRADE_EVENTS:
        if not any(scope.values()):
            return patches
        identifier = payload.get("item_id")
        item_type = str(payload.get("source_item_type") or payload.get("item_type") or
                        ("concept" if event_type == "concept_attempt_evaluated" else "exercise"))
        item_key = f"{item_type}:{identifier}" if identifier is not None else (
            f"case:{payload['case_id']}" if payload.get("case_id") is not None else None)
        # Without a verified item identity, a grade must not clear another blocker.
        if item_key is None:
            item_key = f"event:{event_id}"
        result = payload.get("passed", payload.get("correct"))
        outcome = payload.get("outcome")
        assisted = payload.get("independent") is False or payload.get("assistance_level") not in {None, "none"}
        independent = not assisted and (payload.get("independent") is True or payload.get("assistance_level") == "none")
        if outcome in {"unknown", "skipped", "missing", "unanswered"} or not isinstance(result, bool):
            instruction = "本题尚无可判定的完整作答。先确认是不会、跳过还是未提交，再提供一个起步提示；不要当作答错。"
            kind = "incomplete_attempt"
        elif result:
            kind = "supported_success" if assisted else "independent_success" if independent else "success_assistance_unspecified"
            instruction = ("本次在支持下完成；下一步减少提示，检查能否独立完成一个小变式。" if assisted else
                           "本次独立完成；下一步可用一个小变式或解释理由检查理解，不据此认定稳定掌握。" if independent else
                           "本次通过，但辅助情况尚不明确；下一步确认独立完成情况，不据此认定稳定掌握。")
        else:
            kind = "evaluated_error"
            instruction = "本题本次未通过。先定位第一个出错步骤，给一个针对性小提示再尝试；不要重复整段讲解或推断情绪和固定能力。"
        put("practice", "practice_feedback", instruction, lifetime="task", evidence_kind=kind,
            item_key=item_key, details={"outcome": kind, "assistance_known": assisted or independent})
    elif event_type == "semantic_observation_proposed" and scope.get("session_id") is not None:
        put("knowledge", "clarification", "有一条尚未确认的学习线索；只有它影响当前下一步时，用一个简短问题澄清，不将推测当作学生事实。",
            lifetime="turn", evidence_kind="inferred_candidate")
    return patches


def _entry_order(entry: dict) -> tuple:
    source_id = entry.get("source_event_id")
    span = entry.get("source_span")
    offset = span[0] if isinstance(span, list) and span and type(span[0]) is int else 0
    return (_time(entry.get("occurred_at")) or datetime.min.replace(tzinfo=timezone.utc),
            source_id if type(source_id) is int else 0, offset)


def _strict_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
        return None
    return _time(value)


def _v2_scope_reason(entry: dict, storage: str) -> str | None:
    source, application = entry.get("source_scope"), entry.get("application_scope")
    for scope in (source, application):
        if not isinstance(scope, dict) or set(scope) != set(_SCOPE_KEYS):
            return "invalid_scope_schema"
        if any(value is not None and (type(value) is not int or value <= 0) for value in scope.values()):
            return "invalid_scope_identity"
    if entry.get("scope") != application:
        return "scope_alias_mismatch"
    lifetime = entry.get("lifetime")
    if lifetime == "persistent":
        if storage != "long_term" or any(application.values()) or entry.get("expires_at") is not None:
            return "invalid_persistent_scope"
    elif lifetime == "project_window":
        if (storage != "short_term" or source["project_id"] is None or source["session_id"] is None
                or application["project_id"] != source["project_id"]
                or application["checkpoint_id"] != source["checkpoint_id"]
                or application["session_id"] is not None):
            return "invalid_project_window_scope"
        occurred, expiry = _strict_time(entry.get("occurred_at")), _strict_time(entry.get("expires_at"))
        basis = entry.get("expiry_basis")
        inherited = basis == "inherited_cancelled_window" and entry.get("cancelled") is True
        if inherited and (type(entry.get("cancelled_window_source_event_id")) is not int
                          or entry["cancelled_window_source_event_id"] <= 0
                          or entry["cancelled_window_source_event_id"] == entry.get("source_event_id")
                          or entry.get("cancelled_window_expires_at") != entry.get("expires_at")):
            return "invalid_window_cancellation_link"
        if ((basis != "explicit_timezone_iso" and not inherited) or occurred is None or expiry is None
                or not timedelta(0) < expiry - occurred <= timedelta(hours=MAX_EXPLICIT_WINDOW_HOURS)):
            return "invalid_project_window_expiry"
    elif lifetime not in {"session", "turn", "task"} or source != application or storage != "short_term":
        return "invalid_scoped_lifetime"
    else:
        occurred, expiry = _strict_time(entry.get("occurred_at")), _strict_time(entry.get("expires_at"))
        if occurred is None or expiry is None or not timedelta(0) < expiry - occurred <= timedelta(hours=DEFAULT_SESSION_HOURS):
            return "invalid_session_expiry"
    return None


def _guidance_selection(states: dict, *, project_id=None, checkpoint_id=None,
                        session_id=None, now=None, archived_paths=(), item_key=None) -> tuple[list[dict], list[dict]]:
    at = _time(now) if now is not None else datetime.now(timezone.utc)
    if at is None:
        return [], [{"status": "uncertain", "reason": "invalid_read_time"}]
    requested = {"project_id": project_id, "checkpoint_id": checkpoint_id, "session_id": session_id}
    archives = [tuple(path.split(".")) if isinstance(path, str) else tuple(path) for path in archived_paths]
    diagnostics, candidates = [], []

    def note(entry, status, reason):
        diagnostics.append({key: deepcopy(entry[key]) for key in (
            "kernel", "slot", "source_event_id", "policy_version", "parser_version", "source_span",
            "cancelled_window_source_event_id", "superseded_by_event_id"
        ) if key in entry} | {"status": status, "reason": reason})

    def archived(kernel, storage, entry):
        key = "teaching_preferences" if storage == "long_term" else "teaching_directives"
        related = {key} | _ARCHIVE_KEYS.get(entry.get("slot"), set())
        return any(path and path[0] == kernel and (
            len(path) == 1 or (len(path) >= 2 and path[1] == storage and
                              (len(path) == 2 or path[2] in related)) or
            (len(path) >= 3 and path[2] in related - {key})
        ) for path in archives)

    for kernel in states:
        for storage, key in (("short_term", "teaching_directives"), ("long_term", "teaching_preferences")):
            for entry in _items(states, kernel, storage, key):
                entry["kernel"] = kernel
                version = entry.get("policy_version")
                if version not in SUPPORTED_GUIDANCE_VERSIONS:
                    note(entry, "uncertain", "unsupported_policy_version")
                    continue
                invalid = _v2_scope_reason(entry, storage) if version == GUIDANCE_VERSION else None
                if invalid:
                    note(entry, "uncertain", invalid)
                    continue
                scope = entry.get("scope")
                if not isinstance(scope, dict):
                    note(entry, "uncertain", "invalid_scope_schema")
                    continue
                mismatch = any(value is not None and requested.get(name) != value
                               for name, value in scope.items() if name in _SCOPE_KEYS)
                if entry.get("lifetime") == "project_window":
                    mismatch = mismatch or any(requested[name] != scope.get(name) for name in ("project_id", "checkpoint_id"))
                if mismatch:
                    note(entry, "scope_mismatch", "application_scope_mismatch")
                    continue
                if archived(kernel, storage, entry):
                    note(entry, "scope_mismatch", "archived_control")
                    continue
                if item_key is not None and entry.get("item_key") not in {None, item_key}:
                    note(entry, "scope_mismatch", "item_scope_mismatch")
                    continue
                persistent = storage == "long_term" and entry.get("lifetime") == "persistent"
                time_reader = _strict_time if version == GUIDANCE_VERSION else _time
                occurred = time_reader(entry.get("occurred_at"))
                if occurred is None or occurred > at or type(entry.get("source_event_id")) is not int or entry["source_event_id"] <= 0:
                    note(entry, "uncertain", "invalid_source_identity_or_time")
                    continue
                if not persistent:
                    expiration = time_reader(entry.get("expires_at"))
                    if expiration is None or not any(scope.get(name) is not None for name in _SCOPE_KEYS):
                        note(entry, "uncertain", "invalid_expiry_or_scope")
                        continue
                    if expiration <= at:
                        note(entry, "expired", "validity_ended")
                        continue
                    if entry.get("lifetime") == "turn" and scope.get("session_id") is None:
                        note(entry, "uncertain", "turn_requires_session")
                        continue
                if entry.get("diagnostic_only") or entry.get("status") == "uncertain":
                    note(entry, "uncertain", entry.get("diagnostic_reason", "uncertain_control"))
                    continue
                if entry.get("status") == "superseded":
                    note(entry, "superseded", "newer_control_recorded")
                    continue
                if entry.get("status") not in {"active", "cancelled"} or not entry.get("instruction") or entry.get("slot") not in _PRIORITY:
                    note(entry, "uncertain", "invalid_control_status_or_slot")
                    continue
                entry["priority"] = _PRIORITY[entry["slot"]]
                candidates.append(entry)
    grouped = {}
    for entry in candidates:
        grouped.setdefault((entry["kernel"], entry["slot"], entry.get("item_key")), []).append(entry)
    selected = []
    for entries in grouped.values():
        cancellations = [entry for entry in entries if entry.get("cancelled") or entry.get("status") == "cancelled"]
        cutoff = max((_entry_order(entry) for entry in cancellations), default=None)
        eligible = [entry for entry in entries if cutoff is None or _entry_order(entry) >= cutoff]
        winner = max(eligible, key=lambda entry: (entry.get("lifetime") != "persistent", _entry_order(entry),
                     sum(value is not None for value in entry["scope"].values())))
        selected.append(winner)
        for entry in entries:
            if entry is not winner:
                note(entry, "superseded", "newer_or_local_control_selected")
    no_code = any(entry["slot"] == "code_participation" and entry.get("allow_code") is not True for entry in selected)
    if no_code:
        for entry in list(selected):
            if entry["slot"] == "code_language" or (entry["slot"] == "representation" and entry.get("format") == "code"):
                selected.remove(entry)
                note(entry, "superseded", "current_code_participation_control")
    if item_key is None:
        feedback = [entry for entry in selected if entry["slot"] == "practice_feedback"]
        latest = max(feedback, key=_entry_order) if feedback else None
        for entry in feedback:
            if entry is not latest:
                selected.remove(entry)
                note(entry, "superseded", "latest_practice_feedback_selected")
    selected.sort(key=lambda entry: (entry["priority"], entry.get("lifetime") != "persistent", _entry_order(entry)), reverse=True)
    for entry in selected[8:]:
        note(entry, "superseded", "selection_limit")
    selected = selected[:8]
    for entry in selected:
        note(entry, "cancelled" if entry.get("cancelled") or entry.get("status") == "cancelled" else "selected", "explicit_cancellation" if entry.get("cancelled") else "applicable_control")
    return selected, diagnostics


def select_teaching_guidance(states: dict, *, project_id=None, checkpoint_id=None,
                             session_id=None, now=None, archived_paths=(), item_key=None) -> list[dict]:
    """Read v1 as recorded and v2 under its explicit scope and lifetime policy."""
    return _guidance_selection(states, project_id=project_id, checkpoint_id=checkpoint_id,
        session_id=session_id, now=now, archived_paths=archived_paths, item_key=item_key)[0]


def diagnose_teaching_guidance(states: dict, *, project_id=None, checkpoint_id=None,
                               session_id=None, now=None, archived_paths=(), item_key=None,
                               input_event=None) -> dict:
    """Read-only bounded diagnostics. Never return Human instruction or raw text.

    Like the selector, this consumes an ownership-checked learner projection. An
    optional event must be from that same learner and the exact requested scope.
    """
    selected, diagnostics = _guidance_selection(states, project_id=project_id, checkpoint_id=checkpoint_id,
        session_id=session_id, now=now, archived_paths=archived_paths, item_key=item_key)
    # Preserve the current input's rejection reason before truncating historical
    # diagnostics; another project's controls must not crowd it out.
    prior_diagnostics, diagnostics = diagnostics, []
    if input_event is not None:
        requested = {"project_id": project_id, "checkpoint_id": checkpoint_id, "session_id": session_id}
        if not _same_scope(_scope(input_event), requested):
            diagnostics.append({"status": "scope_mismatch", "reason": "input_event_scope_mismatch"})
        elif getattr(input_event, "event_type", None) in _USER_EVENTS:
            payload = getattr(input_event, "payload", {}) or {}
            at = _time(getattr(input_event, "occurred_at", None))
            if at is not None and isinstance(payload, dict):
                parsed = parse_text_controls(str(payload.get("text") or payload.get("content") or ""), at)
                for entry in parsed["diagnostics"]:
                    diagnostics.append({**entry, "source_event_id": getattr(input_event, "id", None), "policy_version": GUIDANCE_VERSION, "parser_version": PARSER_VERSION})
                if not parsed["actions"] and not parsed["diagnostics"]:
                    diagnostics.append({"status": "no_request", "reason": "no_supported_control", "source_event_id": getattr(input_event, "id", None), "policy_version": GUIDANCE_VERSION})
    diagnostics.extend(prior_diagnostics)
    if not diagnostics:
        diagnostics.append({"status": "no_request", "reason": "no_control_projection"})
    counts = {}
    for entry in diagnostics:
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
    limit = CONTROL_POLICY_LIMITS["max_diagnostics"]
    return {"policy_version": GUIDANCE_VERSION, "status": "selected" if selected else "uncertain" if counts.get("uncertain") else diagnostics[0]["status"],
            "selected_event_ids": sorted({entry["source_event_id"] for entry in selected}),
            "counts": counts, "diagnostics": diagnostics[:limit], "omitted": max(0, len(diagnostics) - limit)}
