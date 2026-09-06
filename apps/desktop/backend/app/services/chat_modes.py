"""Deterministic, persisted chat-mode coordination for Tutor sessions.

The mode runtime is intentionally smaller than an Agent graph.  It gives the
existing Tutor a recoverable interaction posture without introducing another
Agent, another database authority, or model-owned routing.  LearningTask,
SkillRun, project proposal and checkpoint runtimes remain the durable domain
objects behind the modes.
"""

from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import AgentMessage, AgentSession
from app.services.architecture_registry import CHAT_MODES
from app.services.learning_runtime import record_event


CHAT_MODE_RUNTIME_VERSION = "chat-mode-runtime.v1"
CHAT_MODE_IDS = frozenset(CHAT_MODES)

_LONG_HORIZON_MARKERS = (
    "系统学习", "系统学", "从零开始", "从零到", "学习路线", "学习路径",
    "帮我规划", "制定计划", "长期学习", "分阶段", "几个月", "这学期",
    "完整掌握", "做一个项目", "通过项目", "多个知识点", "一整套",
)
_DEEP_LEARNING_MARKERS = (
    "深入理解", "深度理解", "彻底搞懂", "真正弄懂", "带我学会", "带我学懂",
    "帮我弄懂", "帮我搞懂", "教我学会", "学习闭环", "练习并验证", "学会并验证",
    "做完这道题", "完成这道题", "逐步带我", "一步步带我",
)
_SIMPLE_EXPLANATION_PATTERNS = (
    r"^(?:请|你能|可以)?(?:先)?(?:简单|简要|通俗)?(?:地)?(?:跟我)?(?:讲讲|说说|解释(?:一下)?|介绍(?:一下)?)?\s*(?:什么是|啥是|何为)\s*.+",
    r"^(?:请|你能|可以)?(?:简单|简要|通俗)?(?:地)?(?:跟我)?(?:讲讲|说说|解释(?:一下)?|介绍(?:一下)?)\s*.+(?:是什么意思|的定义|的概念)[？?。.]?$",
    r"^(?:请|你能|可以)?(?:简单|简要|通俗)?(?:地)?(?:解释|说明)\s*.+[？?。.]?$",
)


def _clean_text(value: Any, limit: int = 500) -> str:
    return " ".join(str(value or "").split())[:limit]


def _iso_now() -> str:
    return datetime.utcnow().isoformat()


def free_mode_view(*, last_segment: dict[str, Any] | None = None) -> dict[str, Any]:
    contract = CHAT_MODES["free"]
    result = {
        "id": contract.id,
        "name": contract.name,
        "status": "active",
        "goal": "",
        "reason": "等待当前意图收敛",
        "skills": list(contract.skills),
        "returns_to": None,
        "runtime_version": CHAT_MODE_RUNTIME_VERSION,
    }
    if last_segment:
        result["last_segment"] = dict(last_segment)
    return result


def chat_mode_view(session: AgentSession) -> dict[str, Any]:
    raw = dict((session.context_summary or {}).get("chat_mode") or {})
    if not raw and session.session_type == "checkpoint":
        contract = CHAT_MODES["learn"]
        return {
            "id": "learn",
            "name": contract.name,
            "status": "active",
            "goal": "完成当前关卡的学习任务",
            "reason": "关卡会话天然承载一个已规划的学习任务",
            "skills": list(contract.skills),
            "returns_to": "free",
            "runtime_version": CHAT_MODE_RUNTIME_VERSION,
            "last_segment": {},
        }
    mode_id = str(raw.get("id") or "free")
    if mode_id not in CHAT_MODE_IDS:
        return free_mode_view()
    contract = CHAT_MODES[mode_id]
    return {
        "id": mode_id,
        "name": contract.name,
        "status": str(raw.get("status") or "active"),
        "goal": _clean_text(raw.get("goal")),
        "reason": _clean_text(raw.get("reason")),
        "skills": list(raw.get("skills") or contract.skills),
        "returns_to": raw.get("returns_to"),
        "segment_id": raw.get("segment_id"),
        "learning_task_id": raw.get("learning_task_id"),
        "project_proposal_id": raw.get("project_proposal_id"),
        "entry_message_id": raw.get("entry_message_id"),
        "started_at": raw.get("started_at"),
        "completed_at": raw.get("completed_at"),
        "runtime_version": CHAT_MODE_RUNTIME_VERSION,
        "last_segment": dict(raw.get("last_segment") or {}),
    }


def classify_chat_mode(
    message: str,
    *,
    session_type: str,
    selected_skill_id: str | None = None,
    has_active_task: bool = False,
    has_active_skill_run: bool = False,
    has_active_plan: bool = False,
) -> tuple[str, str]:
    """Return a coarse mode and an inspectable deterministic reason."""
    text = _clean_text(message, 2_000)
    compact = "".join(text.casefold().split())

    if session_type == "checkpoint":
        return "learn", "关卡会话天然承载一个已规划的学习任务"
    if selected_skill_id and selected_skill_id not in {"", "adaptive"}:
        return "learn", "学习者显式选择了运行型学习方法"
    if has_active_skill_run:
        return "learn", "当前对话有未完成的学习方法运行"
    if has_active_task:
        return "learn", "当前对话有未完成的原子学习任务"
    if any(marker in compact for marker in _LONG_HORIZON_MARKERS):
        return "plan", "目标跨多个任务、阶段或真实产物"
    if any(marker in compact for marker in _DEEP_LEARNING_MARKERS):
        return "learn", "学习者要求形成有练习和验证的深度理解"
    if any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in _SIMPLE_EXPLANATION_PATTERNS):
        return "explain", "这是边界清楚的单次概念讲解"
    if has_active_plan:
        return "plan", "当前对话有尚未完成的项目规划提案"
    return "free", "当前意图保持开放，等待进一步收敛"


def chat_mode_prompt(mode: dict[str, Any]) -> str:
    mode_id = str(mode.get("id") or "free")
    contract = CHAT_MODES.get(mode_id, CHAT_MODES["free"])
    return (
        f"当前 Chat 模式：{contract.name}（{contract.id}）。\n"
        f"模式边界：{contract.boundary}\n"
        f"允许调用的产品 Skill：{'、'.join(contract.skills)}。\n"
        f"本轮目标：{_clean_text(mode.get('goal')) or '尚未收敛'}。"
    )


async def _complete_previous_segment(
    db: AsyncSession,
    session: AgentSession,
    previous: dict[str, Any],
    *,
    exit_message_id: int,
    outcome: str,
) -> dict[str, Any]:
    if previous.get("id") == "free" or previous.get("status") == "completed":
        return dict(previous.get("last_segment") or {})
    segment_id = str(previous.get("segment_id") or "")
    event = await record_event(
        db,
        learner_id=session.learner_id,
        project_id=session.project_id,
        checkpoint_id=session.checkpoint_id,
        session_id=session.id,
        event_type="learning_action_segment_completed",
        source="tutor_runtime",
        payload={
            "segment_id": segment_id,
            "mode": previous.get("id"),
            "goal": previous.get("goal", ""),
            "entry_message_id": previous.get("entry_message_id"),
            "exit_message_id": exit_message_id,
            "learning_task_id": previous.get("learning_task_id"),
            "project_proposal_id": previous.get("project_proposal_id"),
            "skills": list(previous.get("skills") or []),
            "outcome": outcome,
            "content_exposure": previous.get("id") in {"explain", "learn"},
        },
        confidence=1.0,
        provenance={"segment_id": segment_id, "mode": previous.get("id")},
        client_event_id=f"chat-mode-segment:{segment_id}:completed",
    )
    return {
        "id": segment_id,
        "mode": previous.get("id"),
        "name": previous.get("name"),
        "goal": previous.get("goal", ""),
        "outcome": outcome,
        "evidence_event_id": event.id,
        "completed_at": _iso_now(),
    }


async def enter_chat_mode(
    db: AsyncSession,
    session: AgentSession,
    *,
    mode_id: str,
    goal: str,
    reason: str,
    entry_message_id: int,
    learning_task_id: int | None = None,
    project_proposal_id: int | None = None,
) -> dict[str, Any]:
    if mode_id not in CHAT_MODE_IDS:
        mode_id = "free"
    previous = chat_mode_view(session)
    previous_effective_id = (
        "free" if previous.get("status") == "completed" else previous.get("id")
    )
    last_segment = dict(previous.get("last_segment") or {})
    if previous_effective_id != mode_id:
        last_segment = await _complete_previous_segment(
            db, session, previous, exit_message_id=entry_message_id,
            outcome="returned_to_free" if mode_id == "free" else f"transitioned_to_{mode_id}",
        )

    contract = CHAT_MODES[mode_id]
    same_active_segment = (
        previous_effective_id == mode_id
        and previous.get("status") == "active"
        and previous.get("segment_id")
    )
    segment_id = (
        str(previous["segment_id"])
        if same_active_segment
        else f"session-{session.id}:message-{entry_message_id}:{mode_id}"
    )
    mode = {
        "id": mode_id,
        "name": contract.name,
        "status": "active",
        "goal": _clean_text(goal),
        "reason": _clean_text(reason),
        "skills": list(contract.skills),
        "returns_to": "free" if mode_id != "free" else None,
        "segment_id": segment_id,
        "learning_task_id": learning_task_id or previous.get("learning_task_id") if same_active_segment else learning_task_id,
        "project_proposal_id": project_proposal_id or previous.get("project_proposal_id") if same_active_segment else project_proposal_id,
        "entry_message_id": previous.get("entry_message_id") if same_active_segment else entry_message_id,
        "started_at": previous.get("started_at") if same_active_segment else _iso_now(),
        "runtime_version": CHAT_MODE_RUNTIME_VERSION,
        "last_segment": last_segment,
    }
    summary = dict(session.context_summary or {})
    summary["chat_mode"] = mode
    session.context_summary = summary
    if not same_active_segment:
        await record_event(
            db,
            learner_id=session.learner_id,
            project_id=session.project_id,
            checkpoint_id=session.checkpoint_id,
            session_id=session.id,
            event_type="chat_mode_entered",
            source="tutor_runtime",
            payload={
                "segment_id": segment_id,
                "mode": mode_id,
                "goal": mode["goal"],
                "reason": mode["reason"],
                "skills": mode["skills"],
            },
            confidence=1.0,
            provenance={"message_id": entry_message_id, "mode": mode_id},
            client_event_id=f"chat-mode-segment:{segment_id}:entered",
        )
    return chat_mode_view(session)


def attach_mode_domain_refs(
    session: AgentSession,
    *,
    learning_task_id: int | None = None,
    project_proposal_id: int | None = None,
) -> dict[str, Any]:
    mode = chat_mode_view(session)
    if learning_task_id is not None:
        mode["learning_task_id"] = learning_task_id
    if project_proposal_id is not None:
        mode["project_proposal_id"] = project_proposal_id
    summary = dict(session.context_summary or {})
    summary["chat_mode"] = mode
    session.context_summary = summary
    return chat_mode_view(session)


async def complete_explanation_mode(
    db: AsyncSession,
    session: AgentSession,
    *,
    assistant_message: AgentMessage,
) -> dict[str, Any]:
    mode = chat_mode_view(session)
    if mode.get("id") != "explain" or mode.get("status") == "completed":
        return mode
    last_segment = await _complete_previous_segment(
        db,
        session,
        mode,
        exit_message_id=assistant_message.id,
        outcome="explanation_delivered",
    )
    mode.update({
        "status": "completed",
        "completed_at": _iso_now(),
        "returns_to": "free",
        "last_segment": last_segment,
    })
    summary = dict(session.context_summary or {})
    summary["chat_mode"] = mode
    session.context_summary = summary
    return chat_mode_view(session)
