"""Bounded source-preserving segmentation for deterministic teaching controls.

This module proposes no learner facts. Offsets always address the supplied text;
quoted/code content is masked, not concatenated into an apparent user request.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re

PARSER_VERSION = "teaching-control-parser.v2"
MAX_INPUT_CHARS = 4000
MAX_EXPLICIT_WINDOW_HOURS = 168
DEFAULT_SESSION_HOURS = 8
MAX_SEGMENTS = 96
CONTROL_POLICY_LIMITS = {
    "max_input_chars": MAX_INPUT_CHARS,
    "max_segments": MAX_SEGMENTS,
    "default_session_hours": DEFAULT_SESSION_HOURS,
    "max_explicit_window_hours": MAX_EXPLICIT_WINDOW_HOURS,
    "max_diagnostics": 24,
}


@dataclass(frozen=True)
class Segment:
    text: str
    start: int
    end: int
    reason: str | None = None


_QUOTED = re.compile(r"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|\n|$)|[“「『‘][\s\S]*?(?:[”」』’]|$)|\"[^\"\n]*(?:\"|\n|$)|'[^'\n]*(?:'|\n|$)")
_REPORTED = re.compile(r"我(?:的)?(?:同学|朋友|老师|学生|同事)|他(?:们)?说|她(?:们)?说|有人说|^(?:他|她|他们|她们|同学|朋友|老师|同事|同桌)(?:今天|现在|这次|这一次|本轮|接下来|这一步|只有|会|说|表示|要求)|^(?:题目|题干|材料|日志|代码|例题)(?:中|里)?(?:说|要求|写着|写道|规定)|^(?:题目|题干|材料|日志|代码|例题)\s*[:：]")
_HYPOTHETICAL = re.compile(r"假设|假如|假定|假装|如果|测试(?:一下|用例|消息)|举例来说|例如|比如|举个例子")
_UNCERTAIN = re.compile(r"可能|也许|或许|不一定|不确定|考虑")


def user_segments(text: str) -> list[Segment]:
    """Keep grammatical boundaries while rejecting reported or hypothetical spans."""
    raw = str(text)[:MAX_INPUT_CHARS]
    masked = list(raw)
    for match in _QUOTED.finditer(raw):
        for i in range(match.start(), match.end()):
            if masked[i] not in "\n。；;!?！？":
                masked[i] = " "
    view = "".join(masked)
    # An explicit contrast can introduce a new self request without punctuation.
    boundaries = re.compile(r"[，,。；;!?！？\n]+|(?=(?:但是|但|不过|而我|至于我)(?:我|这一次|这次|本轮|本次|现在|今天|接下来)?)")
    result: list[Segment] = []
    start, inherited = 0, None
    cuts = list(boundaries.finditer(view)) + [None]
    for cut in cuts:
        end = cut.start() if cut else len(view)
        left, right = start, end
        while left < right and view[left].isspace():
            left += 1
        while right > left and view[right - 1].isspace():
            right -= 1
        part = view[left:right]
        if part:
            direct = bool(re.search(r"^(?:但是|但|不过|而|至于)(?:我|这一次|这次|本轮|本次|现在|今天|接下来)", part))
            reason = "reported_input" if _REPORTED.search(part) else "hypothetical_input" if _HYPOTHETICAL.search(part) else None
            if reason is None and inherited and not direct:
                reason = inherited
            if reason is None and cut is not None and any(char in cut.group() for char in "?？"):
                reason = "interrogative_input"
            if reason is None and _UNCERTAIN.search(part):
                reason = "uncertain_expression"
            result.append(Segment(part, left, right, reason))
            if reason in {"reported_input", "hypothetical_input"}:
                inherited = reason
            elif direct:
                inherited = None
        if cut is None or len(result) >= MAX_SEGMENTS:
            break
        # Full sentence ends close reported context. Commas alone do not.
        if any(char in cut.group() for char in "。；;!?！？\n"):
            inherited = None
        if cut.start() == cut.end():
            # Preserve the contrast marker in the next segment, without looping.
            start = cut.end()
        else:
            start = cut.end()
    return result


_TIME_PREFIX = r"(?:这一次|这一轮|这次|本次|本轮|接下来|今天|现在|目前|这段时间|我)"
_TIME_NUMBER = r"(\d{1,3}|[零一二两三四五六七八九十]{1,3})"
MINUTES_PATTERN = re.compile(_TIME_PREFIX + r"(?:我)?(?:的)?(?:学习)?(?:时间|预算|可用时间)?\s*(?:只有|仅有|剩下|剩余|剩|有|为|是|可用|能用|能安排|可安排)\s*" + _TIME_NUMBER + r"\s*分钟")
HALF_HOUR_PATTERN = re.compile(_TIME_PREFIX + r"(?:我)?(?:的)?(?:时间|预算)?\s*(?:只有|仅有|剩下|剩余|剩|有|为|是)\s*半(?:个)?小时")
TIME_NEGATION = re.compile(r"不是|并非|不代表|并不|没有(?:只有|剩|可用|预算)|不(?:是|只|仅)有")
ISO_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:\d{2})?")
_WINDOW_WORD = re.compile(r"截止|有效(?:期)?(?:到|至)|(?:只|仅)?(?:持续|保持|延续)到|直到|(?:安排|预算|要求|限制|目标).{0,8}(?:到|至)|(?:到|至).*(?:有效|为止|之前)")
_WINDOW_SUBJECT = re.compile(r"(?:这|该)(?:个|一)?(?:临时)?(?:安排|要求|预算|限制|目标)|(?:本|当前|这个)(?:项目|关卡|任务)|时间预算|^(?:截止|有效期)")


def explicit_window(segments: list[Segment], index: int, occurred_at: datetime) -> dict:
    """Bind a same-clause or adjacent explicit arrangement deadline, never guess TZ."""
    current = segments[index]
    candidates = [(index, current)]
    # A short following explanation such as "请拆成小步" may precede the deadline.
    for offset in (1, 2):
        if index + offset >= len(segments):
            break
        other = segments[index + offset]
        if MINUTES_PATTERN.search(other.text) or HALF_HOUR_PATTERN.search(other.text):
            break
        if _WINDOW_SUBJECT.search(other.text):
            candidates.append((index + offset, other))
    found = []
    for position, segment in candidates:
        if not _WINDOW_WORD.search(segment.text):
            continue
        if segment.reason or re.search(r"不是|并非|不(?:再|会|应)?(?:持续|保持|延续|有效)|不要", segment.text):
            return {"status": "uncertain", "reason": "uncertain_deadline_expression", "span": [segment.start, segment.end]}
        matches = list(ISO_PATTERN.finditer(segment.text))
        if not matches:
            return {"status": "uncertain", "reason": "deadline_requires_explicit_timezone_iso", "span": [segment.start, segment.end]}
        for match in matches:
            value = match.group()
            span = [segment.start + match.start(), segment.start + match.end()]
            if not re.search(r"(?:[Zz]|[+-]\d{2}:\d{2})$", value):
                return {"status": "uncertain", "reason": "deadline_timezone_missing", "span": span}
            try:
                at = datetime.fromisoformat(value.upper().replace("Z", "+00:00")).astimezone(timezone.utc)
            except ValueError:
                return {"status": "uncertain", "reason": "deadline_invalid_iso", "span": span}
            if at <= occurred_at:
                return {"status": "uncertain", "reason": "deadline_not_future", "span": span}
            if at - occurred_at > timedelta(hours=MAX_EXPLICIT_WINDOW_HOURS):
                return {"status": "uncertain", "reason": "deadline_exceeds_policy_window", "span": span}
            found.append((at, span))
    if not found:
        return {"status": "none"}
    if len({entry[0] for entry in found}) != 1:
        return {"status": "uncertain", "reason": "conflicting_deadlines", "span": [current.start, candidates[-1][1].end]}
    return {"status": "explicit", "expires_at": found[0][0].isoformat(), "span": found[0][1]}


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


def parse_text_controls(raw: str, occurred_at: datetime) -> dict:
    """Return finite rule matches plus text-free rejection metadata."""
    segments = user_segments(raw)
    actions = []
    diagnostics = [{"status": "uncertain", "reason": "quoted_or_code_input", "source_span": [match.start(), match.end()]}
                   for match in _QUOTED.finditer(str(raw)[:MAX_INPUT_CHARS])]
    if len(str(raw)) > MAX_INPUT_CHARS:
        diagnostics.insert(0, {"status": "uncertain", "reason": "input_limit", "source_span": [MAX_INPUT_CHARS, len(str(raw))], "omitted_chars": len(str(raw)) - MAX_INPUT_CHARS})
    if len(segments) == MAX_SEGMENTS and segments[-1].end < len(str(raw)[:MAX_INPUT_CHARS].rstrip()):
        diagnostics.insert(0, {"status": "uncertain", "reason": "segment_limit", "source_span": [segments[-1].end, min(len(str(raw)), MAX_INPUT_CHARS)]})
    formats = [
        (r"先(?:举例|给例子|看例子|讲例子).{0,5}再(?:讲|解释)(?:原理|理论)", "representation", "先举一个小例子，再讲对应原理。"),
        (r"(?:讲解|讲得|说得|节奏|讲)(?:请)?慢(?:一点|一些|点)?", "pace", "适当放慢讲解节奏，每次推进一个步骤并检查理解。"),
        (r"(?:回答|解释|讲解)(?:请)?(?:简短|简洁|短一点)(?:些|点)?", "response_length", "回答简洁，先给关键点，保留必要判断依据。"),
    ]
    language_pattern = r"(?i)(Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go)(?:\s*(?:代码)?(?:示例|例子))?"
    for index, segment in enumerate(segments):
        text = segment.text
        if segment.reason:
            diagnostics.append({"status": "uncertain", "reason": segment.reason, "source_span": [segment.start, segment.end]})
            continue
        if re.search(r"不是我|并非我|不代表我", text):
            continue

        def add(kernel, slot, instruction, *, match=None, lifetime="session", evidence_kind="explicit_request", details=None, window=None):
            span = [segment.start + match.start(), segment.start + match.end()] if match else [segment.start, segment.end]
            actions.append({"kernel": kernel, "slot": slot, "instruction": instruction,
                "lifetime": lifetime, "evidence_kind": evidence_kind, "details": details or {},
                "source_span": span, "window": window})

        window_cancel = re.search(r"取消(?:这个项目的|本项目的|该|这个)临时(?:(时间预算)(?:安排|限制)?|(优先事项|优先目标|目标)(?:安排)?|(返回安排|返回锚点))", text)
        if window_cancel and not re.search(r"不要取消|别取消|不取消", text):
            slot = "time_budget" if window_cancel.group(1) else "current_priority" if window_cancel.group(2) else "return_anchor"
            kernel = {"time_budget": "human", "current_priority": "value", "return_anchor": "structure"}[slot]
            add(kernel, slot, "学生明确取消此前带期限的临时安排；仅撤销匹配窗口，不改变长期目标或偏好。",
                match=window_cancel, evidence_kind="explicit_cancellation",
                details={"cancelled": True, "cancel_project_window": True})
            continue
        local_budget_cancel = re.fullmatch(r"(?:请)?取消(?:当前|本次|这次)?(?:时间预算|预算)(?:安排|限制)?", text)
        if local_budget_cancel:
            add("human", "time_budget", "学生明确取消本会话的时间预算限制；不取消其他会话的带期限安排。",
                match=local_budget_cancel, evidence_kind="explicit_cancellation", details={"cancelled": True})
            continue

        durable = bool(re.search(r"以后|今后|一直|长期", text))
        language = re.search(language_pattern, text)
        if durable:
            if re.search(r"[?？]|吗(?:[。！!]|$)", text):
                continue
            if language and re.search(r"示例|例子", text):
                cancel = bool(re.search(r"不用|不要|不再用|取消|别用", text))
                affirmative = bool(re.search(r"优先|请用|都用|用.*(?:示例|例子)|示例.*用|例子.*用", text))
                if cancel or affirmative:
                    add("human", "code_language", f"学生已取消默认使用 {language.group(1)} 示例的偏好；不要继续沿用旧默认，按当前任务选择语言。" if cancel else f"代码示例优先使用 {language.group(1)}；具体任务约束优先。",
                        lifetime="persistent", evidence_kind="explicit_cancellation" if cancel else "explicit_request",
                        details={"language": language.group(1), "cancelled": cancel})
            for pattern, slot, instruction in formats:
                match = re.search(pattern, text)
                if match:
                    cancel = bool(re.search(r"不用|不要|不再|取消|别", text))
                    add("human", slot, f"学生已取消此前的默认讲解要求（{instruction}）；按当前任务安排，不沿用旧默认。" if cancel else instruction,
                        match=match, lifetime="persistent", evidence_kind="explicit_cancellation" if cancel else "explicit_request",
                        details={"cancelled": cancel})
            continue

        gap = re.search(r"(?:我|这一步|这里|这个|这一段|这个问题)[^，。；]{0,12}(?:没看懂|没听懂|没懂|不懂|不明白|不理解|没理解)|这一步不会|^(?:没懂|不懂|没看懂|没听懂|不明白)$", text)
        resolved = re.search(r"我(?:已经)?(?:明白了|懂了|理解了)|这个问题(?:已经)?解决了|^(?:明白了|懂了|理解了)$", text)
        if gap:
            add("knowledge", "current_blocker", "学生明确表示当前这一步尚未理解。先拆解这一小步，用小例子解释，再请学生判断或复述；不要据此判定长期能力。", match=gap, evidence_kind="self_reported_gap")
        if resolved and (not gap or resolved.start() > gap.start()):
            add("knowledge", "current_blocker", "学生自述当前卡点已解决。停止重复讲解，用一个小检查衔接下一步；这不等于稳定掌握。", match=resolved, lifetime="turn", evidence_kind="self_reported_resolution")

        minute_match = MINUTES_PATTERN.search(text)
        half = HALF_HOUR_PATTERN.search(text)
        if (minute_match or half) and not TIME_NEGATION.search(text):
            budget = _minutes(minute_match.group(1)) if minute_match else 30
            matched = minute_match or half
            window = explicit_window(segments, index, occurred_at)
            if not 1 <= budget <= 480:
                diagnostics.append({"status":"uncertain", "reason":"time_budget_out_of_range", "slot":"time_budget", "source_span":[segment.start + matched.start(),segment.start + matched.end()]})
            elif window["status"] == "uncertain":
                diagnostics.append({"status":"uncertain", "reason":window["reason"], "slot":"time_budget", "source_span":window["span"]})
            else:
                add("human", "time_budget", f"本次学习可用时间约 {budget} 分钟。缩小任务，只推进一个可完成目标，并预留收尾。", match=matched, details={"minutes":budget}, window=window if window["status"]=="explicit" else None)

        current = r"(?:今天|这次|这一次|本次|本轮|这一轮|接下来|现在|暂时)"
        if re.search(current + r".{0,8}(?:不想|不要|不).{0,3}(?:写代码|编程)|(?:别|不要)(?:再)?(?:给|写|用)(?:我)?(?:代码|代码例子)", text):
            add("human", "code_participation", "本次先不用写代码或代码例子，改用口头推演、图示或概念判断；不要扩展为长期偏好。", details={"allow_code":False})
        elif re.search(current + r".{0,4}(?:可以|想|要)(?:开始)?(?:写代码|编程)|(?:请)?给我(?:一个|个)?代码例子", text):
            add("human", "code_participation", "学生当前明确希望使用代码；可恢复最小代码例子或动手练习，不继续沿用此前的暂不写代码要求。", details={"allow_code":True})
        if re.search(r"(?:别|不要|不想)(?:再)?(?:用|看|讲|使用)(?:这个|这种|刚才的)(?:例子|示例)", text):
            add("human", "example_selection", "立即停止沿用刚才的例子，换一个不同的小例子，并检查是否更清楚。")
        if re.search(current + r".{0,10}(?:简短|简洁|短一点)|(?:回答|讲得|说得)(?:请)?(?:简短|简洁|短一点)", text) and not re.search(r"(?:不|别|不要).{0,4}(?:简短|简洁|短一点)", text):
            add("human", "response_length", "这一次回答保持简短，先给关键点；不省略必要的判断依据。", lifetime="turn")
        if re.search(r"(?:示例|例子).{0,5}(?:用|改成)\s*(?:Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go)|(?:用|改成)\s*(?:Python|JavaScript|TypeScript|Java|C\+\+|SQL|Rust|Go).{0,5}(?:示例|例子)", text, re.I):
            if language and not re.search(r"不用|不要|不再用|别用", text):
                add("human", "code_language", f"本次代码示例使用 {language.group(1)}。", details={"language":language.group(1)})
        for pattern, slot, instruction in formats:
            match = re.search(pattern,text)
            if slot != "response_length" and match and not re.search(r"不用|不要|不再|取消|别",text):
                add("human",slot,instruction,match=match)
        if re.search(r"(?:请|这次|这一次|本次|本轮|接下来).{0,8}(?:拆成|分成|拆为)(?:更)?小步|(?:请|这次|本轮).{0,8}(?:一步一步|每次只讲一步)",text):
            add("human","support","按小步骤推进，每次只处理一个决策点；先确认当前最小困难，不推断长期能力。")

        starting = re.search(r"我(?:已经)?(?:会|学过|接触过)\s*([^，。；！!?？\n]{1,60})",text)
        if starting and not re.search(r"我(?:还)?不会|我没学过|我没接触过|我会不会|我会吗|[?？]|吗$",text):
            add("knowledge","starting_point",f"学生自述已接触或会用：{starting.group(1)}。减少重复入门介绍，必要时用一个简短问题校准；这不是掌握验证。",match=starting,evidence_kind="self_reported")
        anchor = re.search(r"(?:先回到|(?:之后|稍后|完成后)?(?:请)?带我回到|^(?:之后|稍后)?(?:请)?回到)\s*[:：]?\s*([^，。；！!?？\n]{1,120})|先补\s*([^，。；！!?？\n]{1,60}?)\s*再继续",text)
        if anchor and not re.search(r"(?:不想|不要|别)先(?:回到|补)|(?:不要|不再|别)(?:带我)?回到",text):
            topic=anchor.group(1) or anchor.group(2)
            window = explicit_window(segments, index, occurred_at)
            if window["status"] == "uncertain":
                diagnostics.append({"status": "uncertain", "reason": window["reason"], "slot": "return_anchor", "source_span": window["span"]})
            else:
                add("structure", "return_anchor", f"先回到或补充：{topic}。完成这一小步后再衔接原任务；保留原学习位置。", match=anchor,
                    details={"requested_anchor": topic}, window=window if window["status"] == "explicit" else None)
        cancel_anchor=re.search(r"取消(?:当前|本次|这次)?(?:返回锚点|返回安排)|(?:本次|这次)不再回到",text)
        if cancel_anchor:
            add("structure","return_anchor","学生明确取消本次返回安排；不自动取消长期学习路径。",match=cancel_anchor,evidence_kind="explicit_cancellation",details={"cancelled":True})
        cancel_goal=re.search(r"取消(?:当前|本次|这次)(?:优先目标|目标|优先事项)|(?:原先的|原来的|当前|本次|这次)(?:优先)?目标(?:先)?(?:暂停|取消)",text)
        if cancel_goal:
            add("value","current_priority","学生明确暂停或取消当前优先目标；保留长期目标及其历史。",match=cancel_goal,evidence_kind="explicit_cancellation",details={"cancelled":True})
        priority=re.search(r"(?:今天|这次|这一次|本轮|接下来|现在)?先(?:学|完成)\s*([^，。；！!?？\n]{1,120})|(?:现在|当前|本次|这次|本轮|接下来)(?:改为|换成|调整为)?优先\s*[:：]?\s*([^，。；！!?？\n]{1,120})|我(?:这个阶段|当前|本次)?的(?:优先)?目标(?:是|为|改为|调整为)\s*[:：]?\s*([^，。；！!?？\n]{1,120})|(?:当前|本次|这次|本轮)(?:优先)?目标(?:改为|调整为|换成)\s*[:：]?\s*([^，。；！!?？\n]{1,120})",text)
        if priority and not re.search(r"(?:不想|不要|别)先|不再优先|不要优先|不是.{0,8}目标",text):
            topic=next(value for value in priority.groups() if value)
            window=explicit_window(segments,index,occurred_at)
            if window["status"]=="uncertain":
                diagnostics.append({"status":"uncertain","reason":window["reason"],"slot":"current_priority","source_span":window["span"]})
            else:
                add("value","current_priority",f"本次优先推进：{topic}。据此安排下一步，不覆盖长期目标。",match=priority,details={"requested_priority":topic},window=window if window["status"]=="explicit" else None)
    return {"actions": actions[:64], "diagnostics": diagnostics[:CONTROL_POLICY_LIMITS["max_diagnostics"]]}
