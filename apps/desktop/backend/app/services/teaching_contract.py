"""Deterministic teaching-contract gates for checkpoint learning artifacts.

The contract lives in ``Checkpoint.learning_contract``.  This module does not
create a second authority: it normalizes legacy fields, reports bounded gaps,
and blocks publication when domain knowledge cannot satisfy the contract.
"""

from __future__ import annotations

from typing import Any, Iterable

from app.services.architecture_registry import SEMANTIC_MEMORY_KEYS


TEACHING_CONTRACT_SCHEMA = "learnflow.teaching-contract.v2"
TEACHING_GATE_POLICY = "teaching-contract-gate.v2"
KNOWLEDGE_INPUT_SCHEMA = "learnflow.knowledge-input-contract.v2"
KNOWLEDGE_INPUT_POLICY = "teaching-knowledge-input.v2"
DEFAULT_KNOWLEDGE_FACETS = (
    "active_concepts",
    "knowledge_gap",
    "pending_question",
    "misconceptions",
    "recent_errors",
)


def _text(value: Any, limit: int = 1600) -> str:
    return " ".join(str(value or "").split())[:limit]


def _texts(values: Any, *, limit: int = 8, item_limit: int = 500) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    return list(dict.fromkeys(
        item for item in (_text(value, item_limit) for value in values[:limit]) if item
    ))


def _source_refs(values: Any) -> tuple[list[dict[str, Any]], list[str]]:
    normalized: list[dict[str, Any]] = []
    errors: list[str] = []
    if values in (None, ""):
        return normalized, errors
    if not isinstance(values, list):
        return [], ["source_refs 必须是列表"]
    for index, value in enumerate(values[:20]):
        if isinstance(value, int) and value > 0:
            normalized.append({"type": "chunk", "id": value})
            continue
        if not isinstance(value, dict):
            errors.append(f"source_refs[{index}] 不是合法引用")
            continue
        ref_type = _text(value.get("type"), 40)
        ref_id = value.get("id")
        if not ref_type or not isinstance(ref_id, (int, str)) or not str(ref_id).strip():
            errors.append(f"source_refs[{index}] 缺少 type 或 id")
            continue
        normalized.append({"type": ref_type, "id": ref_id})
    return normalized, errors


def normalize_knowledge_input_contract(value: Any) -> dict[str, Any]:
    """Normalize learner hints and the required domain packet independently."""
    raw = dict(value) if isinstance(value, dict) else {}
    requested = _texts(raw.get("facets"), limit=12, item_limit=80)
    allowed = SEMANTIC_MEMORY_KEYS["knowledge"]
    facets = [item for item in requested if item in allowed]
    if not facets:
        facets = list(DEFAULT_KNOWLEDGE_FACETS)
    packet_raw = raw.get("domain_packet") if isinstance(raw.get("domain_packet"), dict) else raw
    packet_id = packet_raw.get("id") or packet_raw.get("packet_id")
    packet_status = _text(packet_raw.get("status"), 40)
    coverage = dict(packet_raw.get("coverage") or {}) if isinstance(packet_raw.get("coverage"), dict) else {}
    return {
        "schema_version": KNOWLEDGE_INPUT_SCHEMA,
        "policy_version": KNOWLEDGE_INPUT_POLICY,
        "source": "scoped_answer_free_context_packet",
        "context_policy": "learning_design",
        "mode": "required_for_formal_publish",
        "facets": facets,
        "use_for": ["starting_point", "example_selection", "practice_difficulty", "gap_coverage"],
        "missing_behavior": "blocked_knowledge_without_published_artifact",
        "domain_packet": {
            "id": packet_id if isinstance(packet_id, int) and packet_id > 0 else None,
            "status": packet_status or "unavailable",
            "input_fingerprint": _text(packet_raw.get("input_fingerprint"), 80),
            "coverage": coverage,
            "source_version_refs": [
                dict(item) for item in list(packet_raw.get("source_version_refs") or [])[:20]
                if isinstance(item, dict)
            ],
            "unresolved_gaps": _texts(packet_raw.get("unresolved_gaps"), limit=20, item_limit=100),
        },
        "writes_kernels": [],
        "mastery_inference": False,
    }


def knowledge_design_input_from_context(packet: Any) -> dict[str, Any]:
    """Extract a bounded Knowledge-only design hint from an answer-free packet."""
    if not isinstance(packet, dict) or (packet.get("manifest") or {}).get("answer_free") is not True:
        return {
            "status": "unavailable",
            "summary": "",
            "facets": {},
            "observations": [],
            "mastery_inference": False,
        }
    head = dict((packet.get("kernel_heads") or {}).get("knowledge") or {})
    allowed_facets = SEMANTIC_MEMORY_KEYS["knowledge"]
    facets = {
        key: value for key, value in dict(head.get("facets") or {}).items()
        if key in allowed_facets
    }
    observations = []
    for item in packet.get("items") or []:
        if not isinstance(item, dict) or item.get("kernel") != "knowledge":
            continue
        text = _text(item.get("text") or item.get("summary"), 320)
        if text:
            observations.append({
                "kind": _text(item.get("memory_kind") or item.get("kind"), 60),
                "text": text,
            })
        if len(observations) >= 6:
            break
    summary = _text(head.get("summary"), 800)
    return {
        "status": "available" if summary or facets or observations else "empty",
        "snapshot_id": _text(packet.get("snapshot_id"), 80),
        "summary": summary,
        "facets": facets,
        "observations": observations,
        "mastery_inference": False,
    }


def normalize_teaching_contract(
    contract: Any,
    *,
    objective: str = "",
    outcomes: Iterable[str] = (),
) -> dict[str, Any]:
    raw = dict(contract) if isinstance(contract, dict) else {}
    normalized_outcomes = _texts(raw.get("outcomes") or raw.get("exit_criteria") or list(outcomes))
    refs, ref_errors = _source_refs(raw.get("source_refs"))
    normalized = {
        **raw,
        "schema_version": TEACHING_CONTRACT_SCHEMA,
        "objective": _text(raw.get("objective") or objective, 1600),
        "outcomes": normalized_outcomes,
        "must_preserve": _texts(raw.get("must_preserve")),
        "avoid": _texts(raw.get("avoid")),
        "source_refs": refs,
        "knowledge_input_contract": normalize_knowledge_input_contract(
            raw.get("knowledge_input_contract")
        ),
    }
    # Preserve the established roadmap/task API while making the new contract
    # readable by old clients.
    normalized["exit_criteria"] = _texts(raw.get("exit_criteria") or normalized_outcomes)
    normalized["teaching_gate"] = evaluate_teaching_contract(normalized, ref_errors=ref_errors)
    return normalized


def evaluate_teaching_contract(
    contract: Any,
    *,
    ref_errors: Iterable[str] = (),
) -> dict[str, Any]:
    if not isinstance(contract, dict):
        return {
            "policy_version": TEACHING_GATE_POLICY,
            "status": "blocked_knowledge",
            "hard_errors": ["learning_contract 不是可解析对象"],
            "gaps": ["缺少教学目标", "缺少可检查学习结果"],
            "max_model_revisions": 1,
        }
    hard_errors = list(ref_errors)
    if contract.get("scope_violation") is True:
        hard_errors.append("教学内容越过当前关卡 scope")
    if contract.get("answer_leakage") is True:
        hard_errors.append("教学内容包含独立验证答案")
    gaps: list[str] = []
    knowledge_errors: list[str] = []
    if not _text(contract.get("objective")):
        gaps.append("缺少教学目标")
    if not _texts(contract.get("outcomes") or contract.get("exit_criteria")):
        gaps.append("缺少可检查学习结果")
    if not _texts(contract.get("must_preserve")):
        gaps.append("未声明必须保留的核心事实")
    knowledge_contract = normalize_knowledge_input_contract(contract.get("knowledge_input_contract"))
    domain_packet = dict(knowledge_contract.get("domain_packet") or {})
    packet_status = str(domain_packet.get("status") or "unavailable")
    if not domain_packet.get("id"):
        knowledge_errors.append("缺少正式 DomainKnowledgePacket")
    if packet_status in {"unavailable", "draft", "blocked", "stale", "quarantined"}:
        knowledge_errors.append(f"领域知识包状态不可发布：{packet_status}")
    if list(dict(domain_packet.get("coverage") or {}).get("critical_gaps") or []):
        knowledge_errors.append("领域知识仍有关键缺口")
    if not domain_packet.get("source_version_refs") and not contract.get("source_refs"):
        knowledge_errors.append("当前没有版本化可定位来源")
    status = "blocked_knowledge" if hard_errors or knowledge_errors else "ready_with_gaps" if gaps else "ready"
    return {
        "policy_version": TEACHING_GATE_POLICY,
        "status": status,
        "hard_errors": hard_errors,
        "knowledge_errors": knowledge_errors,
        "gaps": gaps,
        "max_model_revisions": 1,
    }


def build_fallback_section(
    contract: Any,
    *,
    checkpoint_title: str,
    failure_reason: str = "",
) -> dict[str, Any]:
    normalized = normalize_teaching_contract(contract, objective=checkpoint_title)
    objective = normalized["objective"] or f"理解并完成：{checkpoint_title}"
    outcomes = normalized["outcomes"] or normalized["exit_criteria"]
    preserved = normalized["must_preserve"]
    gap = _text(failure_reason, 500) or "当前领域证据不足，正式讲义尚未发布。"
    content = (
        f"## 学习目标\n\n{objective}\n\n"
        f"## 当前缺口\n\n{gap}\n\n"
        "## 下一步\n\n补充或核验与目标直接相关的教材、官方文档或用户资料后重新生成。\n\n"
        "> 这是知识缺口通知，不是讲义，也不表示已经掌握。"
    )
    return {
        "title": f"{checkpoint_title} · 最小讲解",
        "content": content,
        "keywords": [],
        "questions": [],
        "source_file": "",
        "source_heading": "",
        "cited_chunks": [],
        "delivery_state": "blocked_knowledge",
        "publishable": False,
        "mastery_inference": False,
    }


def ensure_teaching_sections(
    sections: Any,
    *,
    contract: Any,
    checkpoint_title: str,
    failure_reason: str = "",
) -> list[dict[str, Any]]:
    normalized_contract = normalize_teaching_contract(contract, objective=checkpoint_title)
    if normalized_contract["teaching_gate"]["status"] == "blocked_knowledge":
        return []
    valid = [dict(item) for item in (sections or []) if isinstance(item, dict) and _text(item.get("content"))]
    return valid
