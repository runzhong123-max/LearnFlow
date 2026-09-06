"""Bounded five-kernel hot heads and capability-scoped memory retrieval.

The evidence ledger and deterministic reducer remain authoritative.  This
module only builds rebuildable projections used for prompt/context assembly;
it never writes KernelState and never calls an LLM.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
import hashlib
import json
import math
import re
from typing import Any, Iterable

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    KernelHead,
    KernelState,
    MemoryClaim,
    MemoryEdge,
    MemoryFact,
    MemoryModule,
    MemoryNode,
    MemoryArchive,
)
from app.services.architecture_registry import KERNEL_NAMES
from app.services.personal_concept_graph import build_personal_concept_context
from app.services.teaching_guidance import GUIDANCE_VERSION, select_teaching_guidance


MEMORY_SCHEMA_VERSION = "memory-item.v2"
CONTEXT_PACKET_VERSION = "five-kernel-context.v2"
HEAD_LIMITS = {"focus": 3, "alerts": 5, "working": 8, "stable": 5}
DEFAULT_RELATIONS = (
    "SAME_SUBJECT", "SUPPORTS", "CONTRADICTS", "REFINES", "SUPERSEDES",
    "MOTIVATES", "ADDRESSES", "BLOCKS", "ENABLES", "CONSOLIDATED_INTO",
)
SENSITIVE_FIELDS = {
    "answer", "answers", "answer_indexes", "correct_answer", "correct_indexes",
    "expected", "expected_output", "solution", "solutions", "test_cases",
    "judge_config", "private", "hidden_tests",
}
ALERT_KINDS = {
    "blocker", "gap", "misconception", "retention", "affect", "load",
    "support_need", "feedback", "remediation",
}
HUMAN_TRANSIENT_KEYS = {
    "affect", "cognitive_load", "frustration", "support_need",
    "pace_adjustment", "format_request", "planning_availability", "adaptation_source",
    "adaptation_scope", "transient_expires_at",
}


@dataclass(frozen=True)
class ContextPolicy:
    id: str
    head_kernels: tuple[str, ...]
    deep_kernels: tuple[str, ...]
    max_items: int
    max_paths: int
    token_budget: int
    scope_mode: str
    relations: tuple[str, ...] = DEFAULT_RELATIONS


CONTEXT_POLICIES = {
    item.id: item for item in (
        ContextPolicy(
            "global_tutor", KERNEL_NAMES, KERNEL_NAMES,
            10, 4, 2400, "portfolio_reference",
        ),
        ContextPolicy(
            "project_tutor", KERNEL_NAMES, KERNEL_NAMES,
            12, 6, 2800, "project",
        ),
        ContextPolicy(
            "checkpoint_tutor", KERNEL_NAMES, KERNEL_NAMES,
            12, 6, 2900, "checkpoint",
        ),
        ContextPolicy(
            "review_tutor", KERNEL_NAMES, ("knowledge", "practice"),
            12, 6, 2800, "review_item",
        ),
        ContextPolicy(
            "learning_design", KERNEL_NAMES, ("structure", "knowledge", "human", "value"),
            10, 4, 2600, "project",
        ),
        ContextPolicy(
            "learning_plan", ("structure", "knowledge", "human", "value"),
            ("structure", "knowledge", "human", "value"),
            14, 6, 3200, "portfolio_reference",
        ),
        ContextPolicy(
            "practice_validation", KERNEL_NAMES, ("knowledge", "practice"),
            10, 5, 2500, "checkpoint",
        ),
    )
}

CAPABILITY_CONTEXT_POLICIES = {
    "start_learning_skill_run": "global_tutor",
    "advance_learning_skill_run": "global_tutor",
    "start_skill_verification": "global_tutor",
    "start_micro_learning": "global_tutor",
    "continue_micro_learning": "checkpoint_tutor",
    "analyze_teach_back": "practice_validation",
    "draft_learning_project": "global_tutor",
    "create_project": "global_tutor",
    "plan_learning_path": "learning_design",
    "plan_vnext_learning_path": "learning_plan",
    "manage_vnext_learning_path_plan": "learning_plan",
    "run_vnext_learning_plan": "learning_plan",
    "read_vnext_learning_path_graph": "learning_plan",
    "lookup_vnext_learning_path_node": "learning_plan",
    "search_vnext_learning_path_graph": "learning_plan",
    "propose_vnext_personal_path_node": "learning_plan",
    "generate_lecture": "learning_design",
    "generate_assessment": "learning_design",
    "evaluate_attempt": "practice_validation",
    "request_remediation_explanation": "practice_validation",
    "retry_attempt": "practice_validation",
    "evaluate_transfer_variant": "practice_validation",
    "plan_review_queue": "review_tutor",
    "evaluate_review_attempt": "review_tutor",
    "manage_review_item": "review_tutor",
}


def resolve_context_policy(
    *, capability: str | None = None, session_type: str | None = None,
    surface: str | None = None,
) -> ContextPolicy:
    if surface == "review":
        return CONTEXT_POLICIES["review_tutor"]
    if capability in CAPABILITY_CONTEXT_POLICIES:
        return CONTEXT_POLICIES[CAPABILITY_CONTEXT_POLICIES[capability]]
    return CONTEXT_POLICIES.get(f"{session_type}_tutor", CONTEXT_POLICIES["global_tutor"])


_KIND_KEYS = {
    "structure": (
        ("blocker", "blocker"), ("resume", "resume"), ("depend", "dependency"),
        ("transition", "transition"), ("path", "anchor"), ("project", "anchor"),
    ),
    "knowledge": (
        ("misconception", "misconception"), ("error", "gap"), ("gap", "gap"),
        ("question", "question"), ("retention", "retention"),
        ("mastery", "understanding"), ("understanding", "understanding"),
        ("concept", "understanding"),
    ),
    "human": (
        ("affect", "affect"), ("frustration", "affect"), ("load", "load"),
        ("attention", "attention"), ("preference", "preference"),
        ("mode", "preference"), ("support", "support_need"),
    ),
    "value": (
        ("goal", "goal"), ("priority", "priority"), ("motivation", "motivation"),
        ("interest", "interest"), ("relevance", "relevance"),
    ),
    "practice": (
        ("remediation", "remediation"), ("transfer", "transfer"),
        ("review", "attempt"), ("attempt", "attempt"), ("assistance", "assistance"),
        ("artifact", "artifact"), ("feedback", "feedback"),
    ),
}


def memory_kind_for(kernel_name: str, key: str, *, node_type: str = "fact") -> str:
    if node_type == "module":
        return "topic_summary"
    if node_type == "claim":
        return "semantic_claim"
    lowered = str(key or "").casefold()
    for marker, kind in _KIND_KEYS.get(kernel_name, ()):
        if marker in lowered:
            return kind
    return "observation"


def subject_parts(subject_key: str) -> tuple[str, str]:
    subject = str(subject_key or "global")
    if ":" not in subject:
        return subject or "global", ""
    subject_type, subject_id = subject.split(":", 1)
    return subject_type or "global", subject_id


def memory_salience(
    *, memory_kind: str, evidence_grade: str = "observed",
    scope: str = "short_term", confidence: float = 0.0,
) -> float:
    grade_boost = {
        "verified": 0.24, "corrected": 0.22, "self_reported": 0.12,
        "observed": 0.08, "inferred": 0.02, "exposure_only": -0.08,
        "legacy": -0.12,
    }.get(evidence_grade, 0.0)
    kind_boost = 0.12 if memory_kind in ALERT_KINDS else 0.0
    scope_boost = 0.12 if scope == "long_term" else 0.0
    value = 0.28 + grade_boost + kind_boost + scope_boost + 0.24 * float(confidence or 0)
    return round(max(0.05, min(value, 1.0)), 3)


def _compact(value: Any, limit: int = 260) -> str:
    if isinstance(value, str):
        rendered = value
    else:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    rendered = " ".join(rendered.split())
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"


def _token_estimate(value: Any) -> int:
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return max(1, math.ceil(len(rendered) / 3.2))


def _optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _active_human_short_term(value: dict[str, Any]) -> dict[str, Any]:
    """Hide expired turn-level adaptation without mutating authoritative state."""
    short = dict(value or {})
    raw_expiry = str(short.get("transient_expires_at") or "").strip()
    if not raw_expiry:
        return short
    try:
        expiry = datetime.fromisoformat(raw_expiry.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        # Malformed TTL metadata must fail closed: do not keep sensitive or
        # potentially stale current-context adaptation alive indefinitely.
        expiry = datetime.min
    if expiry <= datetime.utcnow():
        for key in HUMAN_TRANSIENT_KEYS:
            short.pop(key, None)
    return short


def _scoped_human_states(
    value: dict[str, Any], *, project_id: int | None,
    checkpoint_id: int | None, session_id: int | None,
) -> dict[str, Any]:
    """Keep turn-level adaptation inside the exact context that produced it."""
    states = dict(value or {})
    if states.get("adaptation_source") != "explicit_current_context":
        return states
    raw_scope = states.get("adaptation_scope")
    if not isinstance(raw_scope, dict):
        for key in HUMAN_TRANSIENT_KEYS:
            states.pop(key, None)
        return states
    requested = {
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
    }
    normalized_scope = {
        key: _optional_int(raw_scope.get(key)) for key in requested
    }
    if any(normalized_scope[key] != requested[key] for key in requested):
        for key in HUMAN_TRANSIENT_KEYS:
            states.pop(key, None)
    return states


def _head_summary(kernel_name: str, state: KernelState) -> str:
    short = dict(state.short_term or {})
    if kernel_name == "human":
        short = _active_human_short_term(short)
    long = dict(state.long_term or {})
    preferred = {
        "structure": ("active_learning_path_plan", "path_position", "current_task", "current_blocker", "resume_anchor"),
        "knowledge": ("pending_question", "knowledge_gap", "active_concepts", "retention_status"),
        "human": ("affect", "cognitive_load", "support_need", "preferred_modes"),
        "value": ("current_priority", "goal_candidate", "current_motivation", "interest_signal"),
        "practice": ("current_attempt", "assistance_level", "recent_feedback", "remediation_status"),
    }[kernel_name]
    parts: list[str] = []
    for key in preferred:
        value = short.get(key)
        if value not in (None, "", [], {}):
            parts.append(f"{key}={_compact(value, 110)}")
        if len(parts) >= 3:
            break
    if len(parts) < 3:
        for key, value in long.items():
            if key == "memory_graph_claims" or value in (None, "", [], {}):
                continue
            parts.append(f"stable:{key}={_compact(value, 110)}")
            if len(parts) >= 3:
                break
    return "；".join(parts)[:420]


def _facet_states(kernel_name: str, state: KernelState) -> dict[str, Any]:
    short = dict(state.short_term or {})
    if kernel_name == "human":
        short = _active_human_short_term(short)
    long = dict(state.long_term or {})
    keys = {
        "structure": ("active_learning_path_plan", "active_project_id", "active_checkpoint_id", "current_blocker"),
        "knowledge": ("pending_question", "recent_errors", "active_concepts"),
        "human": (
            "affect", "cognitive_load", "support_need", "pace_adjustment",
            "format_request", "pace_preference", "format_preference",
            "preferred_modes", "adaptation_source", "adaptation_scope",
        ),
        "value": ("current_priority", "current_motivation", "goal_status"),
        "practice": ("assistance_level", "artifact_state", "remediation_status"),
    }[kernel_name]
    result: dict[str, Any] = {}
    for key in keys:
        value = short.get(key)
        if value in (None, "", [], {}) and kernel_name == "human":
            value = long.get(key)
            if value in (None, "", [], {}) and key in {"pace_preference", "format_preference", "preferred_modes"}:
                value = dict(long.get("learning_preferences") or {}).get(key)
        if value in (None, "", [], {}):
            continue
        if key == "adaptation_scope" and isinstance(value, dict):
            # Scope is machine-readable control metadata. Compacting it into a
            # display string would make the exact-session comparison fail
            # closed for the very session that produced the adaptation.
            result[key] = dict(value)
        elif isinstance(value, (dict, list)):
            result[key] = _compact(value, 180)
        else:
            result[key] = value
    return result


def _human_adaptation_directives(states: dict[str, Any]) -> list[dict[str, str]]:
    """Convert Human state into compact teaching directives without raw sensitive text."""
    directives: list[dict[str, str]] = []

    def add(kind: str, instruction: str, source: str = "current_context") -> None:
        if instruction and all(item["instruction"] != instruction for item in directives):
            directives.append({"kind": kind, "instruction": instruction, "source": source})

    pace = str(states.get("pace_adjustment") or states.get("pace_preference") or "")
    if pace == "slower":
        add("pace", "放慢节奏；一次只推进一个小步骤，并在继续前留出回应空间")
    elif pace == "faster":
        add("pace", "加快节奏；压缩已知铺垫，但不要跳过验证边界")

    format_value = str(states.get("format_request") or states.get("format_preference") or "")
    format_instructions = {
        "visual": "优先使用图示或空间化表征，并同时提供可读文字说明",
        "example": "定义后立即给一个最小、可检查的例子",
        "code": "定义后给最小可运行代码，并解释关键输出",
        "steps": "把当前动作拆成清楚的编号步骤，每次只处理一个决策点",
        "concise": "减少铺垫和重复，只保留当前任务必需信息",
        "alternative": "不要重复当前讲法；改用另一种表征后再检查理解",
    }
    if format_value in format_instructions:
        add("format", format_instructions[format_value])

    modes = states.get("preferred_modes")
    if isinstance(modes, list):
        safe_modes = {str(item).casefold() for item in modes}
        if safe_modes & {"visual", "visualization", "图示", "可视化"}:
            add("format", format_instructions["visual"], "confirmed_preference")
        if safe_modes & {"example", "examples", "示例"}:
            add("format", format_instructions["example"], "confirmed_preference")
        if safe_modes & {"code", "代码"}:
            add("format", format_instructions["code"], "confirmed_preference")

    load = states.get("cognitive_load")
    if isinstance(load, (int, float)) and float(load) >= 0.7:
        add("load", "降低单轮信息量，先收紧目标并确认当前最小阻碍")
    if str(states.get("affect") or "") == "frustrated":
        add("support", "先简短承认当前受阻，再缩小任务；不要推断人格或长期能力")

    support = str(states.get("support_need") or "")
    support_instructions = {
        "reduce_pacing": "放慢节奏并减少单轮新概念数量",
        "increase_pacing": "加快节奏但保留独立验证",
        "reduce_chunk_size": "把内容切成更小块，并在每块后让学习者回应",
        "switch_explanation_mode": "切换表征方式，不要原样重复上一段解释",
        "acknowledge_and_reduce_scope": "先回应当前困难，再将任务缩成一个可完成动作",
        "repeat_key_point": "只重述关键点，并换一个例子检查理解",
    }
    if support in support_instructions:
        add("support", support_instructions[support])
    return directives[:6]


async def refresh_kernel_head(
    db: AsyncSession, learner_id: int, kernel_name: str,
) -> KernelHead:
    if kernel_name not in KERNEL_NAMES:
        raise ValueError("unknown kernel")
    state = (await db.execute(select(KernelState).where(
        KernelState.learner_id == learner_id,
        KernelState.kernel_name == kernel_name,
    ))).scalar_one()
    now = datetime.utcnow()
    nodes = list((await db.execute(
        select(MemoryNode).where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name == kernel_name,
            MemoryNode.status.in_(("active", "transient", "legacy")),
            or_(MemoryNode.valid_to.is_(None), MemoryNode.valid_to > now),
        ).order_by(
            MemoryNode.salience.desc(), MemoryNode.occurred_at.desc(), MemoryNode.id.desc(),
        ).limit(80)
    )).scalars().all())
    working = [node.id for node in nodes if node.node_type == "fact"][:HEAD_LIMITS["working"]]
    stable = [
        node.id for node in nodes
        if node.node_type == "claim" and node.status == "active"
    ][:HEAD_LIMITS["stable"]]
    alerts = [
        node.id for node in nodes
        if node.memory_kind in ALERT_KINDS
        or any(word in node.text.casefold() for word in ("error", "failed", "不懂", "答错", "阻塞"))
    ][:HEAD_LIMITS["alerts"]]
    focus = [node.id for node in nodes if node.status != "legacy"][:HEAD_LIMITS["focus"]]
    subjects: list[str] = []
    for node in nodes:
        if node.subject_key not in subjects:
            subjects.append(node.subject_key)
        if len(subjects) >= 8:
            break
    facets = {
        "subjects": subjects,
        "states": _facet_states(kernel_name, state),
        "confidence": round(float(state.confidence or 0), 3),
    }
    summary = _head_summary(kernel_name, state)
    body = {
        "summary": summary,
        "focus_refs": focus,
        "alert_refs": alerts,
        "working_refs": working,
        "stable_refs": stable,
        "facets": facets,
    }
    head = (await db.execute(select(KernelHead).where(
        KernelHead.learner_id == learner_id,
        KernelHead.kernel_name == kernel_name,
    ))).scalar_one_or_none()
    if not head:
        head = KernelHead(learner_id=learner_id, kernel_name=kernel_name, version=1)
        db.add(head)
    else:
        head.version = int(head.version or 0) + 1
    head.summary = summary
    head.focus_refs = focus
    head.alert_refs = alerts
    head.working_refs = working
    head.stable_refs = stable
    head.facets = facets
    head.token_estimate = _token_estimate(body)
    head.source_kernel_version = int(state.version or 0)
    head.updated_at = now
    await db.flush()
    return head


async def ensure_kernel_heads(db: AsyncSession, learner_id: int) -> list[KernelHead]:
    states = list((await db.execute(select(KernelState).where(
        KernelState.learner_id == learner_id,
    ))).scalars().all())
    state_map = {state.kernel_name: state for state in states}
    existing = list((await db.execute(select(KernelHead).where(
        KernelHead.learner_id == learner_id,
    ))).scalars().all())
    head_map = {head.kernel_name: head for head in existing}
    for kernel_name in KERNEL_NAMES:
        state = state_map.get(kernel_name)
        if not state:
            continue
        head = head_map.get(kernel_name)
        expired_human_projection = False
        if kernel_name == "human" and head:
            projected = dict((head.facets or {}).get("states") or {})
            active = _active_human_short_term(dict(state.short_term or {}))
            expired_human_projection = any(
                key in projected and key not in active
                for key in HUMAN_TRANSIENT_KEYS - {"transient_expires_at", "adaptation_source"}
            )
        if (
            not head
            or int(head.source_kernel_version or 0) != int(state.version or 0)
            or expired_human_projection
        ):
            head_map[kernel_name] = await refresh_kernel_head(db, learner_id, kernel_name)
    return [head_map[name] for name in KERNEL_NAMES if name in head_map]


def _safe_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _safe_payload(item) for key, item in value.items()
            if str(key).casefold() not in SENSITIVE_FIELDS
        }
    if isinstance(value, list):
        return [_safe_payload(item) for item in value[:20]]
    if isinstance(value, str):
        return value[:800]
    return value


def _search_terms(text: str) -> set[str]:
    lowered = str(text or "").casefold()
    latin = set(re.findall(r"[a-z0-9_\-]{2,}", lowered))
    han_runs = re.findall(r"[\u4e00-\u9fff]+", lowered)
    han = {
        run[index:index + 2]
        for run in han_runs for index in range(max(1, len(run) - 1))
        if run[index:index + 2]
    }
    return latin | han


def _in_scope(
    node: MemoryNode, policy: ContextPolicy, *, project_id: int | None,
    checkpoint_id: int | None, session_id: int | None,
    allow_superseded: bool = False,
) -> bool:
    if node.status not in {"active", "transient", "legacy"} and not (
        allow_superseded and node.status == "superseded"
    ):
        return False
    if node.valid_to is not None and node.valid_to <= datetime.utcnow():
        return False
    if node.status == "transient":
        if session_id is None or node.session_id != session_id:
            return False
    if policy.scope_mode == "portfolio_reference":
        return node.node_type == "claim" or node.project_id is None
    if node.status == "legacy" and project_id is not None and node.project_id is None:
        return False
    if project_id is not None and node.project_id not in (None, project_id):
        return False
    if checkpoint_id is not None and node.checkpoint_id not in (None, checkpoint_id):
        return False
    if policy.scope_mode == "review_item" and node.kernel_name not in {"knowledge", "practice"}:
        return False
    return True


def _scope_filters(policy: ContextPolicy, project_id, checkpoint_id, session_id):
    """Apply scope before bounding candidates; old relevant memories stay reachable."""
    filters = [
        MemoryNode.status.in_(("active", "transient", "legacy")),
        or_(MemoryNode.valid_to.is_(None), MemoryNode.valid_to > datetime.utcnow()),
        or_(MemoryNode.status != "transient", MemoryNode.session_id == session_id)
        if session_id is not None else MemoryNode.status != "transient",
    ]
    if policy.scope_mode == "portfolio_reference":
        filters.append(or_(MemoryNode.node_type == "claim", MemoryNode.project_id.is_(None)))
    else:
        if project_id is not None:
            filters.extend([
                or_(MemoryNode.project_id.is_(None), MemoryNode.project_id == project_id),
                or_(MemoryNode.status != "legacy", MemoryNode.project_id.is_not(None)),
            ])
        if checkpoint_id is not None:
            filters.append(or_(MemoryNode.checkpoint_id.is_(None), MemoryNode.checkpoint_id == checkpoint_id))
    return filters


async def _archived_projection_ids(db: AsyncSession, learner_id: int, archives) -> set[int]:
    if not archives:
        return set()
    predicates = []
    for entry in archives:
        keys = [entry.memory_key]
        if entry.kernel_name == "human" and entry.memory_key == "learning_preferences":
            keys.extend(("preferred_modes", "pace_preference", "format_preference", "weekly_hours"))
        matching_key = and_(
            MemoryNode.payload["key"].as_string().in_(keys),
            # Aggregate preferences also project into individual short-term facts.
            True if len(keys) > 1 else MemoryNode.payload["scope"].as_string() == entry.memory_scope,
        )
        if entry.kernel_name == "human" and entry.memory_key in {
            "preferred_modes", "pace_preference", "format_preference", "weekly_hours",
        }:
            # Older versions stored aggregate preference facts. Hiding one key
            # must also hide their summaries, which can repeat that archived value.
            matching_key = or_(matching_key, MemoryNode.payload["key"].as_string() == "learning_preferences")
        predicates.append(and_(MemoryNode.kernel_name == entry.kernel_name, matching_key))
    excluded = set((await db.execute(select(MemoryNode.id).where(
        MemoryNode.learner_id == learner_id, or_(*predicates),
    ))).scalars().all())
    # Facts support claims directly, and modules one level above those facts.
    for _ in range(2):
        excluded.update((await db.execute(select(MemoryEdge.target_node_id).where(
            MemoryEdge.learner_id == learner_id,
            MemoryEdge.source_node_id.in_(excluded or {-1}),
            MemoryEdge.relation_type.in_(("SUPPORTS", "CONSOLIDATED_INTO")),
        ))).scalars().all())
    return excluded


async def _node_metadata(
    db: AsyncSession, node_ids: Iterable[int],
) -> tuple[dict[int, MemoryFact], dict[int, MemoryClaim], dict[int, MemoryModule]]:
    ids = list(dict.fromkeys(int(item) for item in node_ids))
    if not ids:
        return {}, {}, {}
    facts = list((await db.execute(select(MemoryFact).where(
        MemoryFact.node_id.in_(ids),
    ))).scalars().all())
    claims = list((await db.execute(select(MemoryClaim).where(
        MemoryClaim.node_id.in_(ids),
    ))).scalars().all())
    modules = list((await db.execute(select(MemoryModule).where(
        MemoryModule.node_id.in_(ids),
    ))).scalars().all())
    return (
        {item.node_id: item for item in facts},
        {item.node_id: item for item in claims},
        {item.node_id: item for item in modules},
    )


def _sensitive_node(node: MemoryNode, fact: MemoryFact | None) -> bool:
    predicate = str(fact.predicate if fact else "").casefold()
    key = str((node.payload or {}).get("key") or "").casefold()
    path_tokens = set(re.split(r"[.:/_\-]+", predicate)) | set(re.split(r"[.:/_\-]+", key))
    payload_keys: set[str] = set()
    stack = [node.payload or {}]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            payload_keys.update(str(item).casefold() for item in value)
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value[:20])
    return bool((path_tokens | payload_keys) & SENSITIVE_FIELDS)


def _serialize_item(
    node: MemoryNode, *, score: float, reasons: list[str],
    fact: MemoryFact | None, claim: MemoryClaim | None, module: MemoryModule | None,
) -> dict[str, Any]:
    evidence_refs = [fact.source_event_id] if fact else []
    detail: dict[str, Any] = {}
    if fact:
        detail = {
            "predicate": fact.predicate,
            "evidence_grade": fact.evidence_grade,
            "source_event_id": fact.source_event_id,
        }
    elif claim:
        detail = {
            "predicate": claim.predicate,
            "verification_status": claim.verification_status,
            "module_id": claim.module_node_id,
        }
    elif module:
        detail = {
            "module_type": module.module_type,
            "version": int(module.version or 1),
            "parent_module_id": module.parent_module_node_id,
            "revision_kind": module.revision_kind,
            "policy_version": module.policy_version,
        }
    return {
        "id": node.id,
        "kernel": node.kernel_name,
        "node_type": node.node_type,
        "memory_kind": node.memory_kind,
        "subject": {
            "key": node.subject_key,
            "type": node.subject_type,
            "id": node.subject_id,
        },
        "scope": {
            "project_id": node.project_id,
            "checkpoint_id": node.checkpoint_id,
            "session_id": node.session_id,
        },
        "text": node.text[:900],
        "status": node.status,
        "confidence": round(float(node.confidence or 0), 3),
        "salience": round(float(node.salience or 0), 3),
        "occurred_at": node.occurred_at.isoformat() if node.occurred_at else None,
        "evidence_refs": evidence_refs,
        "detail": detail,
        "provenance": _safe_payload(dict(node.payload or {})),
        "retrieval": {"score": round(score, 4), "reasons": reasons},
        "schema_version": node.schema_version or MEMORY_SCHEMA_VERSION,
    }


async def build_five_kernel_context(
    db: AsyncSession,
    *,
    learner_id: int,
    policy: ContextPolicy | str,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    session_id: int | None = None,
    subject_keys: Iterable[str] = (),
    query: str = "",
) -> dict[str, Any]:
    """Build a deterministic, answer-free and budgeted ContextPacket."""
    if isinstance(policy, str):
        policy = CONTEXT_POLICIES[policy]
    archives = list((await db.execute(select(MemoryArchive).where(
        MemoryArchive.learner_id == learner_id, MemoryArchive.status == "archived",
    ))).scalars().all())
    archived_ids = await _archived_projection_ids(db, learner_id, archives)
    guidance_states = (await db.execute(select(KernelState).where(
        KernelState.learner_id == learner_id,
    ))).scalars().all()
    teaching_guidance = select_teaching_guidance(
        {row.kernel_name: {"short_term": dict(row.short_term or {}),
                           "long_term": dict(row.long_term or {})} for row in guidance_states},
        project_id=project_id, checkpoint_id=checkpoint_id, session_id=session_id,
        archived_paths={(entry.kernel_name, entry.memory_scope, entry.memory_key) for entry in archives},
    )
    guidance_omitted = 0
    while teaching_guidance and _token_estimate(teaching_guidance) > min(800, policy.token_budget // 3):
        teaching_guidance.pop()
        guidance_omitted += 1
    heads = await ensure_kernel_heads(db, learner_id)
    head_rows = [head for head in heads if head.kernel_name in policy.head_kernels]
    raw_head_refs = {
        int(ref)
        for head in head_rows
        for ref in (
            list(head.focus_refs or []) + list(head.alert_refs or [])
            + list(head.working_refs or []) + list(head.stable_refs or [])
        )
    }
    referenced_nodes = list((await db.execute(select(MemoryNode).where(
        MemoryNode.learner_id == learner_id,
        MemoryNode.id.in_(raw_head_refs or {-1}),
    ))).scalars().all())
    referenced_map = {node.id: node for node in referenced_nodes}
    head_facts, _, _ = await _node_metadata(db, raw_head_refs)
    hidden_refs = {
        node.id for node in referenced_nodes
        if node.id in archived_ids or node.kernel_name == "human" or not _in_scope(
            node, policy, project_id=project_id, checkpoint_id=checkpoint_id,
            session_id=session_id,
        ) or _sensitive_node(node, head_facts.get(node.id))
    }
    head_payload: dict[str, dict[str, Any]] = {}
    for head in head_rows:
        def visible(refs: Iterable[int], limit: int) -> list[int]:
            return [
                int(ref) for ref in refs
                if int(ref) not in hidden_refs and int(ref) in referenced_map
            ][:limit]

        focus_refs = visible(head.focus_refs or [], HEAD_LIMITS["focus"])
        alert_refs = visible(head.alert_refs or [], HEAD_LIMITS["alerts"])
        working_refs = visible(head.working_refs or [], HEAD_LIMITS["working"])
        stable_refs = visible(head.stable_refs or [], HEAD_LIMITS["stable"])
        ordered_refs = list(dict.fromkeys(
            focus_refs + alert_refs + working_refs + stable_refs
        ))
        scoped_nodes = [referenced_map[ref] for ref in ordered_refs]
        head_states = dict((head.facets or {}).get("states") or {})
        if head.kernel_name == "human":
            for archived in archives:
                if archived.kernel_name == "human":
                    head_states.pop(archived.memory_key, None)
                    if archived.memory_key == "learning_preferences":
                        for key in ("preferred_modes", "pace_preference", "format_preference", "weekly_hours"):
                            head_states.pop(key, None)
            head_states = _scoped_human_states(
                head_states,
                project_id=project_id,
                checkpoint_id=checkpoint_id,
                session_id=session_id,
            )
            summary = "；".join(
                item["instruction"] for item in _human_adaptation_directives(head_states)
            )[:420]
            head_states.pop("adaptation_source", None)
            head_states.pop("adaptation_scope", None)
        else:
            summary = "；".join(node.text for node in scoped_nodes[:3])[:420]
        subjects = list(dict.fromkeys(node.subject_key for node in scoped_nodes))[:8]
        head_payload[head.kernel_name] = {
            "summary": summary,
            "focus_refs": focus_refs,
            "alert_refs": alert_refs,
            "working_refs": working_refs,
            "stable_refs": stable_refs,
            "facets": {
                "subjects": subjects,
                "states": head_states if head.kernel_name == "human" else {
                    "active_memory_kinds": list(dict.fromkeys(
                        node.memory_kind for node in scoped_nodes
                    ))[:8],
                    "alert_count": len(alert_refs),
                },
                "confidence": float((head.facets or {}).get("confidence") or 0),
            },
            "version": int(head.version or 0),
        }
    requested_subjects = {str(item) for item in subject_keys if str(item)}
    if project_id is not None:
        requested_subjects.add(f"project:{project_id}")
    if checkpoint_id is not None:
        requested_subjects.add(f"checkpoint:{checkpoint_id}")
    head_refs = {
        int(ref)
        for head in head_payload.values()
        for ref in (
            list(head.get("focus_refs") or []) + list(head.get("alert_refs") or [])
            + list(head.get("working_refs") or []) + list(head.get("stable_refs") or [])
        )
    }
    base = select(MemoryNode).where(
        MemoryNode.learner_id == learner_id,
        MemoryNode.kernel_name.in_(policy.deep_kernels),
        MemoryNode.id.not_in(archived_ids or {-1}),
        *_scope_filters(policy, project_id, checkpoint_id, session_id),
    )
    recent_order = (MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
    query_terms = _search_terms(query)
    nodes_by_id = {}
    channels = [MemoryNode.subject_key.in_(requested_subjects or {"__none__"}),
                MemoryNode.id.in_(head_refs or {-1})]
    if query_terms:
        channels.append(or_(*(MemoryNode.text.contains(term, autoescape=True)
                              for term in sorted(query_terms)[:48])))
    for channel in [*channels, None]:
        statement = base.where(channel) if channel is not None else base
        for node in (await db.execute(statement.order_by(*recent_order).limit(240))).scalars():
            nodes_by_id[node.id] = node
    nodes = list(nodes_by_id.values())
    facts, claims, modules = await _node_metadata(db, [node.id for node in nodes])
    concept_context = await build_personal_concept_context(
        db,
        learner_id,
        query,
        project_id=project_id,
        checkpoint_id=checkpoint_id,
        session_id=session_id,
    )
    now = datetime.utcnow()
    ranked: list[tuple[float, int, MemoryNode, list[str]]] = []
    excluded_sensitive = 0
    excluded_scope = 0
    for node in nodes:
        # Human facts may be sensitive even when their compact directive is
        # safe.  Tutor receives only the typed adaptation directives below.
        if node.kernel_name == "human":
            excluded_sensitive += 1
            continue
        if not _in_scope(
            node, policy, project_id=project_id, checkpoint_id=checkpoint_id,
            session_id=session_id,
        ):
            excluded_scope += 1
            continue
        fact = facts.get(node.id)
        if _sensitive_node(node, fact):
            excluded_sensitive += 1
            continue
        score = float(node.salience or 0.25)
        reasons: list[str] = ["salience"]
        if node.subject_key in requested_subjects:
            score += 5.0
            reasons.append("exact_subject")
        if node.id in head_refs:
            score += 2.2
            reasons.append("kernel_head_ref")
        if project_id is not None and node.project_id == project_id:
            score += 1.4
            reasons.append("project_scope")
        if checkpoint_id is not None and node.checkpoint_id == checkpoint_id:
            score += 1.8
            reasons.append("checkpoint_scope")
        if session_id is not None and node.session_id == session_id:
            score += 1.0
            reasons.append("session_scope")
        corpus_terms = _search_terms(
            f"{node.subject_key} {node.memory_kind} {node.text}"
        )
        overlap = len(query_terms & corpus_terms)
        if overlap:
            lexical = 2.5 * overlap / max(1, len(query_terms))
            score += lexical
            reasons.append("lexical_match")
        if node.node_type == "claim" and node.status == "active":
            # An evidence-backed current claim is a denser summary than a raw
            # event and must survive when concept history competes for the
            # bounded packet.
            score += 3.0
            reasons.append("active_claim")
        age_days = max(0.0, (now - node.occurred_at).total_seconds() / 86400) if node.occurred_at else 999
        score += 0.5 / (1.0 + age_days)
        ranked.append((score, node.id, node, reasons))
    ranked.sort(key=lambda item: (-item[0], -item[1]))

    items: list[dict[str, Any]] = []
    # The personal concept graph is part of the Agent packet, not an unbudgeted
    # attachment added by an API route after retrieval has finished.
    adaptation_directives = _human_adaptation_directives(
        dict((head_payload.get("human") or {}).get("facets", {}).get("states") or {})
    )
    used_tokens = (
        _token_estimate(head_payload) + _token_estimate(concept_context)
        + _token_estimate(adaptation_directives)
        + _token_estimate(teaching_guidance)
    )
    for score, _, node, reasons in ranked:
        candidate = _serialize_item(
            node, score=score, reasons=reasons, fact=facts.get(node.id),
            claim=claims.get(node.id), module=modules.get(node.id),
        )
        candidate_tokens = _token_estimate(candidate)
        if used_tokens + candidate_tokens > policy.token_budget:
            continue
        items.append(candidate)
        used_tokens += candidate_tokens
        if len(items) >= policy.max_items:
            break

    selected_ids = {int(item["id"]) for item in items}
    relation_paths: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    if selected_ids and policy.max_paths:
        edges = list((await db.execute(select(MemoryEdge).where(
            MemoryEdge.learner_id == learner_id,
            MemoryEdge.relation_type.in_(policy.relations),
            or_(
                MemoryEdge.source_node_id.in_(selected_ids),
                MemoryEdge.target_node_id.in_(selected_ids),
            ),
        ).order_by(MemoryEdge.created_at.desc(), MemoryEdge.id.desc()).limit(80))).scalars().all())
        neighbor_ids = {
            node_id for edge in edges
            for node_id in (edge.source_node_id, edge.target_node_id)
            if node_id not in selected_ids
        }
        neighbors = list((await db.execute(select(MemoryNode).where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.id.in_(neighbor_ids or {-1}),
        ))).scalars().all())
        neighbor_map = {node.id: node for node in neighbors}
        neighbor_facts, _, _ = await _node_metadata(db, neighbor_ids)
        selected_map = {int(item["id"]): item for item in items}
        for edge in edges:
            source = selected_map.get(edge.source_node_id) or neighbor_map.get(edge.source_node_id)
            target = selected_map.get(edge.target_node_id) or neighbor_map.get(edge.target_node_id)
            if not source or not target:
                continue
            if any(isinstance(value, MemoryNode) and (
                value.id in archived_ids or value.kernel_name == "human"
                or _sensitive_node(value, neighbor_facts.get(value.id))
            ) for value in (source, target)):
                continue
            if isinstance(source, MemoryNode) and not _in_scope(
                source, policy, project_id=project_id, checkpoint_id=checkpoint_id,
                session_id=session_id,
                allow_superseded=edge.relation_type in {"CONTRADICTS", "SUPERSEDES"},
            ):
                continue
            if isinstance(target, MemoryNode) and not _in_scope(
                target, policy, project_id=project_id, checkpoint_id=checkpoint_id,
                session_id=session_id,
                allow_superseded=edge.relation_type in {"CONTRADICTS", "SUPERSEDES"},
            ):
                continue
            def endpoint(value: dict[str, Any] | MemoryNode) -> dict[str, Any]:
                if isinstance(value, dict):
                    return {"id": value["id"], "kernel": value["kernel"], "text": value["text"][:240]}
                return {"id": value.id, "kernel": value.kernel_name, "text": value.text[:240], "status": value.status}
            path = {
                "relation": edge.relation_type,
                "source": endpoint(source),
                "target": endpoint(target),
                "evidence_event_id": edge.evidence_event_id,
            }
            relation_paths.append(path)
            if edge.relation_type == "CONTRADICTS":
                conflicts.append(path)
            if len(relation_paths) >= policy.max_paths:
                break

    def current_packet_tokens() -> int:
        return _token_estimate({
            "heads": head_payload,
            "items": items,
            "paths": relation_paths,
            "personal_concept_graph": concept_context,
            "adaptation_directives": adaptation_directives,
            "teaching_guidance": teaching_guidance,
        })

    # One-hop paths are discovered after item selection.  Trim the least
    # essential tail deterministically so every caller receives a packet that
    # actually respects the declared policy budget.
    while current_packet_tokens() > policy.token_budget:
        if relation_paths:
            relation_paths.pop()
            continue
        if items:
            items.pop()
            continue
        concept_edges = concept_context.get("edges") or []
        if concept_edges:
            concept_edges.pop()
            continue
        concept_nodes = concept_context.get("nodes") or []
        if len(concept_nodes) > 1:
            concept_nodes.pop()
            continue
        break
    conflicts = [
        path for path in relation_paths
        if path["relation"] == "CONTRADICTS"
    ]

    evidence_ids = sorted({
        int(ref) for item in items for ref in item.get("evidence_refs", []) if ref is not None
    } | {int(item["source_event_id"]) for item in teaching_guidance if item.get("source_event_id")})
    represented_kernels = {item["kernel"] for item in items}
    missing_facets = [
        kernel for kernel in policy.deep_kernels
        if kernel not in represented_kernels and not head_payload.get(kernel, {}).get("summary")
    ]
    manifest_base = {
        "version": CONTEXT_PACKET_VERSION,
        "policy": policy.id,
        "learner_id": learner_id,
        "project_id": project_id,
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
        "subject_keys": sorted(requested_subjects),
        "head_versions": {
            name: value["version"] for name, value in head_payload.items()
        },
        "teaching_guidance": teaching_guidance,
        "item_ids": [item["id"] for item in items],
        "path_keys": [
            [path["source"]["id"], path["relation"], path["target"]["id"]]
            for path in relation_paths
        ],
        "concept_keys": [
            node["concept_key"] for node in concept_context.get("nodes", [])
        ],
        "concept_edge_ids": [
            edge["id"] for edge in concept_context.get("edges", [])
        ],
    }
    snapshot_id = hashlib.sha256(
        json.dumps(manifest_base, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    packet = {
        "snapshot_id": snapshot_id,
        "version": CONTEXT_PACKET_VERSION,
        "scope": {
            "learner_id": learner_id,
            "project_id": project_id,
            "checkpoint_id": checkpoint_id,
            "session_id": session_id,
            "mode": policy.scope_mode,
        },
        "kernel_heads": head_payload,
        "items": items,
        "relation_paths": relation_paths,
        "personal_concept_graph": concept_context,
        "adaptation_directives": adaptation_directives,
        "teaching_guidance": teaching_guidance,
        "teaching_guidance_version": GUIDANCE_VERSION,
        "missing_facets": missing_facets,
        "conflicts": conflicts,
        "resolved_updates": [path for path in relation_paths if path["relation"] == "SUPERSEDES"],
        "omitted": {
            "teaching_guidance_budget_filtered": guidance_omitted,
            "candidate_count": len(nodes),
            "candidate_limit_per_channel": 240,
            "candidate_channels": len(channels) + 1,
            "candidate_window_may_be_truncated": len(nodes) >= 240,
            "selected_count": len(items),
            "scope_filtered": excluded_scope,
            "sensitive_filtered": excluded_sensitive,
            "budget_or_rank_filtered": max(
                0, len(ranked) - len(items)
            ),
        },
        "manifest": {
            "policy": asdict(policy),
            "evidence_ids": evidence_ids,
            "token_estimate": _token_estimate({
                "heads": head_payload,
                "items": items,
                "paths": relation_paths,
                "personal_concept_graph": concept_context,
                "adaptation_directives": adaptation_directives,
                "teaching_guidance": teaching_guidance,
            }),
            "answer_free": True,
            "retrieval_order": ["exact_scope", "subject_and_lexical", "one_hop_relations"],
            "authority": "read_only_projection_from_evidence_and_memory_graph",
            "personal_concept_graph": (
                "read-only Knowledge node history + Structure relations "
                "sharing ConceptAnchor identity"
            ),
        },
    }
    return packet


def compact_projection_from_packet(
    packet: dict[str, Any], *, project_id: int | None = None,
    checkpoint_id: int | None = None,
) -> dict[str, Any]:
    """Compatibility adapter for callers that still expect five kernel rows."""
    heads = dict(packet.get("kernel_heads") or {})
    result: dict[str, Any] = {}
    for kernel_name in KERNEL_NAMES:
        head = dict(heads.get(kernel_name) or {})
        short = {
            "head_summary": head.get("summary", ""),
            "focus_refs": list(head.get("focus_refs") or []),
            "alert_refs": list(head.get("alert_refs") or []),
            "working_refs": list(head.get("working_refs") or []),
            "facets": dict(head.get("facets") or {}),
        }
        if kernel_name == "structure" and project_id is not None:
            short["session_scope"] = {
                "project_id": project_id,
                "checkpoint_id": checkpoint_id,
            }
        result[kernel_name] = {
            "short_term": short,
            "long_term": {"stable_refs": list(head.get("stable_refs") or [])},
            "confidence": float((head.get("facets") or {}).get("confidence") or 0),
        }
    return result


async def backfill_memory_fabric(db: AsyncSession) -> dict[str, int]:
    """Idempotently type existing nodes, restore scope columns and rebuild heads."""
    nodes = list((await db.execute(select(MemoryNode).order_by(MemoryNode.id))).scalars().all())
    facts = list((await db.execute(select(MemoryFact))).scalars().all())
    fact_map = {fact.node_id: fact for fact in facts}
    consumed_scopes: dict[int, list[MemoryFact]] = {}
    for fact in facts:
        if fact.consumed_by_module_id is not None:
            consumed_scopes.setdefault(fact.consumed_by_module_id, []).append(fact)
    changed = 0
    for node in nodes:
        payload = dict(node.payload or {})
        fact = fact_map.get(node.id)
        key = str(payload.get("key") or "")
        memory_kind = memory_kind_for(node.kernel_name, key, node_type=node.node_type)
        subject_type, subject_id = subject_parts(node.subject_key)
        scopes = [fact] if fact else consumed_scopes.get(node.id, [])
        project_ids = {item.project_id for item in scopes if item.project_id is not None}
        checkpoint_ids = {item.checkpoint_id for item in scopes if item.checkpoint_id is not None}
        session_ids = {item.session_id for item in scopes if item.session_id is not None}
        project_id = next(iter(project_ids)) if len(project_ids) == 1 else payload.get("project_id")
        checkpoint_id = next(iter(checkpoint_ids)) if len(checkpoint_ids) == 1 else payload.get("checkpoint_id")
        session_id = next(iter(session_ids)) if len(session_ids) == 1 else payload.get("session_id")
        grade = fact.evidence_grade if fact else (
            "verified" if node.node_type == "claim" and node.status == "active" else "observed"
        )
        scope = str(
            payload.get("scope")
            or ("long_term" if node.node_type != "fact" else "short_term")
        )
        salience = memory_salience(
            memory_kind=memory_kind, evidence_grade=grade, scope=scope,
            confidence=float(node.confidence or 0),
        )
        values = {
            "memory_kind": memory_kind,
            "subject_type": subject_type,
            "subject_id": subject_id,
            "project_id": _optional_int(project_id),
            "checkpoint_id": _optional_int(checkpoint_id),
            "session_id": _optional_int(session_id),
            "salience": salience,
            "schema_version": MEMORY_SCHEMA_VERSION,
        }
        if any(getattr(node, name) != value for name, value in values.items()):
            for name, value in values.items():
                setattr(node, name, value)
            changed += 1
    learner_ids = list((await db.execute(select(KernelState.learner_id).distinct())).scalars().all())
    heads = 0
    for learner_id in learner_ids:
        heads += len(await ensure_kernel_heads(db, learner_id))
    await db.flush()
    return {"typed_nodes": changed, "kernel_heads": heads}
