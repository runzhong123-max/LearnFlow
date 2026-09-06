"""Deterministic, scoped teaching controls inside the five-kernel projection.

These controls are not mastery claims and never wait for memory consolidation.
The caller persists returned patches through the ordinary evidence reducer.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import re
from typing import Any

GUIDANCE_VERSION = "teaching-guidance.v1"
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


def _minutes(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = dict(zip("零一二三四五六七八九", range(10)))
    digits["两"] = 2
    if value in digits:
        return digits[value]
    if "十" in value:
        tens, units = value.split("十", 1)
        if (not tens or tens in digits) and (not units or units in digits):
            return digits.get(tens, 1) * 10 + digits.get(units, 0)
    return 0


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
            status: str = "active", details: dict | None = None) -> None:
        persistent = lifetime == "persistent"
        if not persistent and not any(scope.values()):
            return
        # Turn-lifetime instructions cannot safely be consumed without a session.
        if lifetime == "turn" and scope.get("session_id") is None:
            return
        storage = "long_term" if persistent else "short_term"
        entry_scope = {key: None for key in _SCOPE_KEYS} if persistent else scope
        values = get(kernel, storage)
        matching = [entry for entry in values if entry.get("slot") == slot
                    and entry.get("item_key") == item_key
                    and _same_scope(entry.get("scope") or {}, entry_scope)]
        if any((_time(entry.get("occurred_at")) or at) > at for entry in matching):
            return  # A delayed event must not replace a newer explicit correction.
        values = [entry for entry in values if entry not in matching]
        entry = {
            "kernel": kernel, "slot": slot, "instruction": instruction,
            "scope": deepcopy(entry_scope), "source_event_id": event_id,
            "occurred_at": at.isoformat(),
            "expires_at": None if persistent else (at + timedelta(hours=8)).isoformat(),
            "lifetime": lifetime, "evidence_kind": evidence_kind, "status": status,
            "policy_version": GUIDANCE_VERSION, "priority": _PRIORITY[slot],
            "mastery_inference": False,
        }
        if item_key is not None:
            entry["item_key"] = item_key
        if details:
            entry.update(details)
        values.append(entry)
        values.sort(key=lambda entry: str(entry.get("occurred_at") or ""))
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
                    and (_time(entry.get("occurred_at")) or at) <= at
                )])
        text = str(payload.get("text") or payload.get("content") or "").strip()[:4000]
        # Conservative whole-message guard: quoted/third-party/testing statements
        # are not learner facts. Negative teaching requests remain supported below.
        if not text or re.search(r"[“”‘’\"「」『』]|假设|假如|假定|假装|如果|测试(?:一下|用例|消息)|我(?:的)?(?:同学|朋友|老师|学生)|他说|她说|有人说|举例来说|例如|比如|举个例子|^(?:他|她|他们|她们|同学|朋友|老师)|不是|并非|不代表", text):
            return patches
        clauses = re.split(r"[，。；\n]", text)
        durable_clauses = [clause for clause in clauses if re.search(r"以后|今后|一直|长期", clause)]
        language_pattern = r"(?i)(Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go)(?:\s*(?:代码)?(?:示例|例子))?"
        for clause in durable_clauses:
            if re.search(r"可能|也许|或许|考虑|不一定|[?？]|吗(?:[。！!]|$)", clause):
                continue
            language = re.search(language_pattern, clause)
            if language and re.search(r"示例|例子", clause):
                cancel = bool(re.search(r"不用|不要|不再用|取消|别用", clause))
                affirmative = bool(re.search(r"优先|请用|都用|用.*(?:示例|例子)|示例.*用|例子.*用", clause))
                if cancel or affirmative:
                    put("human", "code_language", f"学生已取消默认使用 {language.group(1)} 示例的偏好；不要继续沿用旧默认，按当前任务选择语言。" if cancel else f"代码示例优先使用 {language.group(1)}；具体任务约束优先。",
                        lifetime="persistent", evidence_kind="explicit_cancellation" if cancel else "explicit_request",
                        details={"language": language.group(1), "cancelled": cancel})
        # Durable format defaults are explicit requests, not inferred learning styles.
        format_requests = [
            (r"先(?:举例|给例子|看例子|讲例子).{0,5}再(?:讲|解释)(?:原理|理论)", "representation", "先举一个小例子，再讲对应原理。"),
            (r"(?:讲解|讲得|说得|节奏|讲)(?:请)?慢(?:一点|一些|点)?", "pace", "适当放慢讲解节奏，每次推进一个步骤并检查理解。"),
            (r"(?:回答|解释|讲解)(?:请)?(?:简短|简洁|短一点)(?:些|点)?", "response_length", "回答简洁，先给关键点，保留必要判断依据。"),
        ]
        for clause in durable_clauses:
            if re.search(r"可能|也许|或许|考虑|不一定|[?？]|吗(?:[。！!]|$)", clause):
                continue
            for pattern, slot, instruction in format_requests:
                if re.search(pattern, clause):
                    cancelled = bool(re.search(r"不用|不要|不再|取消|别", clause))
                    put("human", slot, f"学生已取消此前的默认讲解要求（{instruction}）；按当前任务安排，不沿用旧默认。" if cancelled else instruction,
                        lifetime="persistent", evidence_kind="explicit_cancellation" if cancelled else "explicit_request",
                        details={"cancelled": cancelled})
        # A durable request and today's exception may coexist in the same message.
        text = "，".join(clause for clause in clauses if clause not in durable_clauses)
        language = re.search(language_pattern, text)
        # Session-free chat is never promoted to project/global temporary guidance.
        if scope.get("session_id") is None:
            return patches
        gap_matches = list(re.finditer(r"(?:我|这一步|这里|这个|这一段|这个问题)[^，。；]{0,12}(?:没看懂|没听懂|没懂|不懂|不明白|不理解|没理解)|这一步不会|^(?:没懂|不懂|没看懂|没听懂|不明白)[。！!]?$", text))
        acknowledgment_matches = list(re.finditer(r"我(?:已经)?(?:明白了|懂了|理解了)|这个问题(?:已经)?解决了|^(?:明白了|懂了|理解了)[。！!]?$", text))
        if gap_matches:
            put("knowledge", "current_blocker", "学生明确表示当前这一步尚未理解。先拆解这一小步，用小例子解释，再请学生判断或复述；不要据此判定长期能力。",
                evidence_kind="self_reported_gap")
        if acknowledgment_matches and (not gap_matches or acknowledgment_matches[-1].start() > gap_matches[-1].start()):
            save("knowledge", [entry for entry in get("knowledge") if not (
                entry.get("slot") == "current_blocker" and _same_scope(entry.get("scope") or {}, scope)
                and (_time(entry.get("occurred_at")) or at) <= at
            )])
            put("knowledge", "current_blocker", "学生自述当前卡点已解决。停止重复讲解，用一个小检查衔接下一步；这不等于稳定掌握。",
                lifetime="turn", evidence_kind="self_reported_resolution")
        minutes = re.search(r"(?:今天|现在|这次|我).{0,8}(?:只有|剩下|剩|有)\s*(\d{1,3}|[零一二两三四五六七八九十]{1,3})\s*分钟", text)
        half_hour = re.search(r"(?:今天|现在|这次|我).{0,8}(?:只有|剩下|剩|有)\s*半(?:个)?小时", text)
        budget = _minutes(minutes.group(1)) if minutes else 30 if half_hour else 0
        if 0 < budget <= 480:
            put("human", "time_budget", f"本次学习可用时间约 {budget} 分钟。缩小任务，只推进一个可完成目标，并预留收尾。", details={"minutes": budget})
        if re.search(r"(?:今天|这次|现在|暂时).{0,8}(?:不想|不要|不).{0,3}(?:写代码|编程)|(?:别|不要)(?:再)?(?:给|写|用)(?:我)?(?:代码|代码例子)", text):
            put("human", "code_participation", "本次先不用写代码或代码例子，改用口头推演、图示或概念判断；不要扩展为长期偏好。", details={"allow_code": False})
        elif re.search(r"(?:今天|这次|现在).{0,4}(?:可以|想|要)(?:开始)?(?:写代码|编程)|(?:请)?给我(?:一个|个)?代码例子", text):
            put("human", "code_participation", "学生当前明确希望使用代码；可恢复最小代码例子或动手练习，不继续沿用此前的暂不写代码要求。", details={"allow_code": True})
        if re.search(r"(?:别|不要|不想)(?:再)?(?:用|看|讲|使用)(?:这个|这种|刚才的)(?:例子|示例)", text):
            put("human", "example_selection", "立即停止沿用刚才的例子，换一个不同的小例子，并检查是否更清楚。")
        if re.search(r"(?:这次|本次|这轮|这一轮|这个回答).{0,10}(?:简短|简洁|短一点)|(?:回答|讲得|说得)(?:请)?(?:简短|简洁|短一点)", text) and not re.search(r"(?:不|别|不要).{0,4}(?:简短|简洁|短一点)", text):
            put("human", "response_length", "这一次回答保持简短，先给关键点；不省略必要的判断依据。", lifetime="turn")
        if re.search(r"(?:示例|例子).{0,5}(?:用|改成)\s*(?:Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go)|(?:用|改成)\s*(?:Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go).{0,5}(?:示例|例子)", text, re.I):
            if language and not re.search(r"不用|不要|不再用|别用", text):
                put("human", "code_language", f"本次代码示例使用 {language.group(1)}。", details={"language": language.group(1)})
        for pattern, slot, instruction in format_requests:
            if slot != "response_length" and re.search(pattern, text) and not re.search(r"不用|不要|不再|取消|别", text):
                put("human", slot, instruction)
        starting = re.search(r"我(?:已经)?(?:会|学过|接触过)\s*([^，。；！!?？\n]{1,60})", text)
        if starting and not re.search(r"我(?:还)?不会|我没学过|我没接触过|我会不会|我会吗|[?？]|吗(?:[。！!]|$)", text):
            put("knowledge", "starting_point", f"学生自述已接触或会用：{starting.group(1)}。减少重复入门介绍，必要时用一个简短问题校准；这不是掌握验证。", evidence_kind="self_reported")
        anchor = re.search(r"先回到\s*([^，。；！!?？\n]{1,60})|先补\s*([^，。；！!?？\n]{1,60}?)\s*再继续", text)
        if anchor and not re.search(r"(?:不想|不要|别)先(?:回到|补)", text):
            topic = anchor.group(1) or anchor.group(2)
            put("structure", "return_anchor", f"先回到或补充：{topic}。完成这一小步后再衔接原任务；保留原学习位置。", details={"requested_anchor": topic})
        priority = re.search(r"(?:今天|这次|现在)?先(?:学|完成)\s*([^，。；！!?？\n]{1,60})", text)
        if priority and not re.search(r"(?:不想|不要|别)先", text):
            put("value", "current_priority", f"本次优先推进：{priority.group(1)}。据此安排下一步，不覆盖长期目标。", details={"requested_priority": priority.group(1)})
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


def select_teaching_guidance(states: dict, *, project_id=None, checkpoint_id=None,
                             session_id=None, now=None, archived_paths=(), item_key=None) -> list[dict]:
    """Select at most eight current controls without consuming or mutating them."""
    at = _time(now) if now is not None else datetime.now(timezone.utc)
    if at is None:
        return []
    requested_scope = {"project_id": project_id, "checkpoint_id": checkpoint_id, "session_id": session_id}
    archives = [tuple(path.split(".")) if isinstance(path, str) else tuple(path) for path in archived_paths]

    def archived(kernel: str, storage: str, entry: dict) -> bool:
        key = "teaching_preferences" if storage == "long_term" else "teaching_directives"
        related = {key} | _ARCHIVE_KEYS.get(entry.get("slot"), set())
        return any(path and path[0] == kernel and (
            len(path) == 1 or (len(path) >= 2 and path[1] == storage and
                              (len(path) == 2 or path[2] in related)) or
            (len(path) >= 3 and path[2] in related - {key})
        ) for path in archives)

    candidates = []
    for kernel in states:
        for storage, key in (("short_term", "teaching_directives"), ("long_term", "teaching_preferences")):
            for entry in _items(states, kernel, storage, key):
                if entry.get("policy_version") != GUIDANCE_VERSION or archived(kernel, storage, entry):
                    continue
                if item_key is not None and entry.get("item_key") not in {None, item_key}:
                    continue
                entry_scope = entry.get("scope") or {}
                if any(value is not None and requested_scope.get(name) != value for name, value in entry_scope.items() if name in _SCOPE_KEYS):
                    continue
                persistent = storage == "long_term" and entry.get("lifetime") == "persistent"
                if not persistent:
                    expiration = _time(entry.get("expires_at"))
                    if not any(entry_scope.get(name) is not None for name in _SCOPE_KEYS) or expiration is None or expiration <= at:
                        continue
                    if entry.get("lifetime") == "turn" and entry_scope.get("session_id") is None:
                        continue
                occurred = _time(entry.get("occurred_at"))
                if occurred is None or occurred > at:
                    continue
                entry["kernel"] = kernel
                # Priority is policy-controlled, never accepted from stored/model text.
                entry["priority"] = _PRIORITY.get(entry.get("slot"), 0)
                candidates.append(entry)
    # A local override beats a durable default; a cancellation tombstone suppresses
    # its old same-slot default even when legacy duplicate versions are present.
    candidates.sort(key=lambda entry: (
        entry.get("lifetime") != "persistent",
        sum(value is not None for value in (entry.get("scope") or {}).values()),
        str(entry.get("occurred_at") or ""),
    ), reverse=True)
    selected, seen = [], set()
    for entry in candidates:
        identity = (entry["kernel"], entry.get("slot"), entry.get("item_key"))
        if identity in seen:
            continue
        seen.add(identity)
        if entry.get("status") not in {"active", "cancelled"} or not entry.get("instruction"):
            continue
        selected.append(entry)
    no_code = any(entry.get("slot") == "code_participation" and entry.get("allow_code") is not True for entry in selected)
    if no_code:
        selected = [entry for entry in selected if entry.get("slot") != "code_language"
                    and not (entry.get("slot") == "representation" and entry.get("format") == "code")]
    if item_key is None:
        feedback = [entry for entry in selected if entry.get("slot") == "practice_feedback"]
        if feedback:
            latest = max(feedback, key=lambda entry: (entry["occurred_at"], str(entry.get("source_event_id") or "")))
            selected = [entry for entry in selected if entry.get("slot") != "practice_feedback" or entry is latest]
    selected.sort(key=lambda entry: (entry["priority"], entry.get("lifetime") != "persistent", entry["occurred_at"]), reverse=True)
    return selected[:8]
