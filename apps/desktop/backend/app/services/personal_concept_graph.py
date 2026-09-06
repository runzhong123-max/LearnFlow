"""Rebuildable personal concept-learning graph.

Concept anchors are shared identity coordinates, not a sixth kernel and not a
second mastery authority.  Knowledge facts describe what happened inside one
concept; Structure facts describe relationships between concepts.  Both are
materialized only after registered EvidenceEvents pass through the reducer.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import re
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    EvidenceEvent, MemoryClaim, MemoryFact, MemoryModule, MemoryNode,
)


CONCEPT_GRAPH_VERSION = "personal-concept-graph.v1"
OBSERVATION_TYPES = {
    "first_exposure", "definition_understanding", "mechanism_explanation",
    "example_seen", "counterexample_seen", "question_attempt", "error",
    "misconception", "remediation_effect", "recall", "original_task",
    "variant_task", "transfer", "uncertainty", "conflict",
    "self_reported_exposure", "self_reported_gap",
}
RELATION_TYPES = {
    "hard_prerequisite", "soft_prerequisite", "blocks", "enables",
    "associates", "analogy", "confusable", "co_learning", "applies_to",
    "return_anchor", "transfers_to",
}
RELATION_LABELS = {
    "hard_prerequisite": "硬前置",
    "soft_prerequisite": "软前置",
    "blocks": "阻碍",
    "enables": "推动",
    "associates": "联想",
    "analogy": "类比",
    "confusable": "易混淆",
    "co_learning": "共生",
    "applies_to": "应用",
    "return_anchor": "返回锚点",
    "transfers_to": "迁移",
}


def concept_client_event_id(base: str, *parts: object) -> str:
    raw = ":".join([str(base), *(str(part) for part in parts)])
    if len(raw) <= 145:
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"{str(base)[:100]}:concept:{digest}"[:145]

_ALIASES = {
    "c语言": ("c-programming", "C 语言"),
    "c 语言": ("c-programming", "C 语言"),
    "python": ("python-programming", "Python 程序设计"),
    "微积分": ("calculus", "微积分"),
    "高等数学": ("calculus", "微积分"),
    "概率论": ("probability-statistics", "概率论与数理统计"),
    "概率统计": ("probability-statistics", "概率论与数理统计"),
    "条件概率": ("conditional-probability", "条件概率"),
    "线性代数": ("linear-algebra", "线性代数"),
    "离散数学": ("discrete-mathematics", "离散数学"),
    "数据结构": ("data-structures", "数据结构"),
    "机器学习": ("machine-learning", "机器学习"),
    "机器学习算法": ("machine-learning", "机器学习"),
    "深度学习": ("deep-learning", "深度学习"),
    "强化学习": ("reinforcement-learning", "强化学习"),
    "智能体": ("agent-engineering", "智能体工程"),
    "agent": ("agent-engineering", "智能体工程"),
    "反向传播": ("backpropagation", "反向传播"),
    "链式法则": ("chain-rule", "链式法则"),
    "贝叶斯公式": ("bayes-theorem", "贝叶斯公式"),
}


def normalize_concept_key(value: str) -> str:
    raw = re.sub(r"\s+", " ", str(value or "").strip())
    if not raw:
        return ""
    alias = _ALIASES.get(raw.casefold()) or _ALIASES.get(raw)
    if alias:
        return alias[0]
    ascii_key = re.sub(r"[^a-z0-9]+", "-", raw.casefold()).strip("-")
    if ascii_key:
        return ascii_key[:120]
    return "user-" + "-".join(f"{ord(char):x}" for char in raw)[:110]


def canonical_concept(value: str) -> tuple[str, str, str | None]:
    raw = re.sub(r"\s+", " ", str(value or "").strip())
    alias = _ALIASES.get(raw.casefold()) or _ALIASES.get(raw)
    if alias:
        return alias[0], alias[1], alias[0]
    key = normalize_concept_key(raw)
    return key, raw[:160], None


def _split_concepts(value: str) -> list[str]:
    cleaned = re.sub(r"(?:的)?基础(?:算法|知识)?", "", value)
    cleaned = re.sub(r"(?:相关)?工程知识", "", cleaned)
    parts = re.split(r"[、,，；;]|以及|和(?=[\u4e00-\u9fffA-Za-z])", cleaned)
    result: list[str] = []
    for part in parts:
        part = part.strip()
        candidate = re.sub(
            r"^(?:我)?(?:已经|曾经|目前)?(?:学习过|学过|基础课掌握|了|一些|基础的)",
            "",
            part,
        ).strip(" 。：:")
        if 1 < len(candidate) <= 40 and candidate not in result:
            result.append(candidate)
    return result


def extract_self_report(raw_text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Conservative Chinese extraction for explicit learner self-report.

    It only records exposure/gap signals and explicit relation phrases.  It
    never infers mastery.  Callers may supply structured drafts when richer
    extraction has already been reviewed by the learner.
    """
    text = re.sub(r"\s+", " ", str(raw_text or "").strip())
    observations: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    exposure_matches = re.finditer(
        r"(?:我)?(?:已经|曾经|目前)?学(?:习)?过(?P<body>.+?)(?=。|；|;|目前|现在|后续|我偏好|我喜欢|$)",
        text,
    )
    for match in exposure_matches:
        for name in _split_concepts(match.group("body")):
            key, title, official = canonical_concept(name)
            marker = (key, "self_reported_exposure")
            if not key or marker in seen:
                continue
            seen.add(marker)
            observations.append({
                "concept_key": key,
                "name": title,
                "official_node_id": official,
                "observation_type": "self_reported_exposure",
                "statement": f"学习者自述曾接触或学习过{title}",
            })

    if re.search(r"学(?:习)?过|基础课|接触过|了解过", text):
        for alias_name in sorted(_ALIASES, key=len, reverse=True):
            if alias_name.casefold() not in text.casefold():
                continue
            key, title, official = canonical_concept(alias_name)
            marker = (key, "self_reported_exposure")
            if marker in seen:
                continue
            seen.add(marker)
            observations.append({
                "concept_key": key,
                "name": title,
                "official_node_id": official,
                "observation_type": "self_reported_exposure",
                "statement": f"学习者自述曾接触或学习过{title}",
            })

    gap_patterns = (
        r"(?:我)?(?:总是|一直|还是)?(?:搞不懂|不懂|不理解|忘了)(?P<name>[\u4e00-\u9fffA-Za-z0-9 +_-]{2,30})",
        r"(?:我)?(?:容易|经常|总是)?混淆(?P<name>[\u4e00-\u9fffA-Za-z0-9 +_-]{2,30})",
        r"(?P<name>[\u4e00-\u9fffA-Za-z0-9 +_-]{2,30})(?:总是|容易|经常)?(?:搞混|混在一起)",
    )
    for pattern in gap_patterns:
        for match in re.finditer(pattern, text):
            raw_name = re.split(r"[，。；;、]", match.group("name"))[0].strip()
            key, title, official = canonical_concept(raw_name)
            marker = (key, "self_reported_gap")
            if not key or marker in seen:
                continue
            seen.add(marker)
            observations.append({
                "concept_key": key,
                "name": title,
                "official_node_id": official,
                "observation_type": "self_reported_gap",
                "statement": f"学习者自述对{title}存在待验证的理解缺口或混淆",
            })

    explicit_relations = (
        (r"因为(?P<source>[^，。；]{2,24})(?:忘了|不懂|不会)[^，。；]*(?:所以|导致)?(?:我)?(?:不懂|学不下去|卡在)(?P<target>[^，。；]{2,24})", "blocks"),
        (r"(?P<source>[^，。；]{2,24})(?:帮助|推动)(?:我)?(?:理解|学习)(?P<target>[^，。；]{2,24})", "enables"),
        (r"(?:由|从)(?P<source>[^，。；]{2,24})(?:想到|联想到)(?P<target>[^，。；]{2,24})", "associates"),
    )
    for pattern, relation_type in explicit_relations:
        for match in re.finditer(pattern, text):
            source_key, source_name, source_official = canonical_concept(match.group("source"))
            target_key, target_name, target_official = canonical_concept(match.group("target"))
            if source_key and target_key and source_key != target_key:
                relations.append({
                    "source": {"concept_key": source_key, "name": source_name, "official_node_id": source_official},
                    "target": {"concept_key": target_key, "name": target_name, "official_node_id": target_official},
                    "relation_type": relation_type,
                    "rationale": match.group(0)[:300],
                })
    return observations, relations


def normalize_observation(raw: dict[str, Any]) -> dict[str, Any]:
    key, name, official = canonical_concept(
        str(raw.get("name") or raw.get("concept_key") or "")
    )
    requested_key = normalize_concept_key(str(raw.get("concept_key") or ""))
    concept_key = requested_key or key
    observation_type = str(raw.get("observation_type") or "self_reported_exposure")
    if observation_type not in OBSERVATION_TYPES:
        raise ValueError("不支持的知识历程类型")
    return {
        "concept_key": concept_key,
        "name": str(raw.get("name") or name or concept_key)[:160],
        "aliases": [str(item)[:80] for item in list(raw.get("aliases") or [])[:8]],
        "origin": str(raw.get("origin") or "user_input")[:40],
        "official_node_id": raw.get("official_node_id") or official,
        "observation_type": observation_type,
        "statement": str(raw.get("statement") or "学习者提交了一条概念自述")[:1000],
        "question_ref": dict(raw.get("question_ref") or {}),
    }


def normalize_relation(raw: dict[str, Any]) -> dict[str, Any]:
    relation_type = str(raw.get("relation_type") or "")
    if relation_type not in RELATION_TYPES:
        raise ValueError("不支持的概念关系类型")
    source = normalize_observation({
        **dict(raw.get("source") or {}),
        "observation_type": "self_reported_exposure",
    })
    target = normalize_observation({
        **dict(raw.get("target") or {}),
        "observation_type": "self_reported_exposure",
    })
    if source["concept_key"] == target["concept_key"]:
        raise ValueError("概念关系的起点与终点必须不同")
    return {
        "source": {key: source[key] for key in ("concept_key", "name", "aliases", "origin", "official_node_id")},
        "target": {key: target[key] for key in ("concept_key", "name", "aliases", "origin", "official_node_id")},
        "relation_type": relation_type,
        "rationale": str(raw.get("rationale") or "学习者明确提交的概念关系")[:500],
    }


def _anchor_from_payload(payload: dict[str, Any], fallback_key: str) -> dict[str, Any]:
    fallback = str(payload.get("subject_key") or fallback_key or "")
    for prefix in ("concept:", "target:", "concept-item:", "checkpoint:"):
        if fallback.startswith(prefix):
            fallback = fallback.removeprefix(prefix)
            break
    concept_key = str(payload.get("concept_key") or fallback)
    raw_name = str(payload.get("concept_name") or payload.get("name") or concept_key)
    cleaned_name = re.sub(
        r"^(?:我)?(?:已经|曾经|目前)?(?:学习过|学过|基础课掌握)", "", raw_name,
    ).strip(" 。：:")
    canonical_key, canonical_name, official = canonical_concept(cleaned_name or raw_name)
    # Early profile migrations could preserve a conversational prefix in both
    # key and title.  The graph is a rebuildable projection, so canonicalize
    # those coordinates here without rewriting or deleting source evidence.
    if canonical_key:
        concept_key = canonical_key
    if official or cleaned_name != raw_name:
        raw_name = canonical_name or raw_name
    return {
        "concept_key": concept_key,
        "name": raw_name,
        "aliases": list(payload.get("concept_aliases") or payload.get("aliases") or []),
        "origin": str(payload.get("concept_origin") or payload.get("origin") or "personal"),
        "official_node_id": payload.get("official_node_id") or official,
    }


async def build_personal_concept_graph(
    db: AsyncSession,
    learner_id: int,
    *,
    limit_per_concept: int = 40,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    session_id: int | None = None,
) -> dict[str, Any]:
    rows = list((await db.execute(
        select(MemoryNode, MemoryFact, EvidenceEvent)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name.in_(("knowledge", "structure")),
            MemoryNode.status.in_(("active", "legacy")),
            or_(
                MemoryNode.subject_key.like("concept:%"),
                EvidenceEvent.event_type.in_((
                    "review_attempt_evaluated",
                    "review_reflection_recorded",
                    "remediation_started",
                    "remediation_retry_evaluated",
                    "remediation_completed",
                )),
            ),
        )
        .order_by(MemoryNode.occurred_at.asc(), MemoryNode.id.asc())
        .limit(5000)
    )).all())
    claim_rows = list((await db.execute(
        select(MemoryNode, MemoryClaim, MemoryModule)
        .join(MemoryClaim, MemoryClaim.node_id == MemoryNode.id)
        .join(MemoryModule, MemoryModule.node_id == MemoryClaim.module_node_id)
        .where(
            MemoryNode.learner_id == learner_id,
            MemoryNode.kernel_name == "knowledge",
            MemoryNode.subject_key.like("concept:%"),
            MemoryNode.node_type == "claim",
            MemoryNode.status.in_(("active", "challenged")),
        )
        .order_by(MemoryNode.occurred_at.asc(), MemoryNode.id.asc())
        .limit(1000)
    )).all())
    anchors: dict[str, dict[str, Any]] = {}
    timelines: dict[str, list[dict[str, Any]]] = {}
    relations: list[dict[str, Any]] = []
    claims: dict[str, list[dict[str, Any]]] = {}
    relation_keys: set[tuple[int, str, str, str]] = set()
    timeline_event_keys: set[tuple[int, str]] = set()

    def in_scope(node: MemoryNode) -> bool:
        if project_id is not None and node.project_id not in (None, project_id):
            return False
        if checkpoint_id is not None and node.checkpoint_id not in (None, checkpoint_id):
            return False
        if session_id is not None and node.session_id not in (None, session_id):
            return False
        return True

    def ensure(anchor: dict[str, Any]) -> dict[str, Any]:
        key = str(anchor.get("concept_key") or "")
        current = anchors.setdefault(key, {
            "concept_key": key,
            "name": anchor.get("name") or key,
            "aliases": [],
            "origin": anchor.get("origin") or "personal",
            "official_node_id": anchor.get("official_node_id"),
            "knowledge_event_count": 0,
            "structure_relation_count": 0,
        })
        current["aliases"] = sorted(set(current["aliases"] + list(anchor.get("aliases") or [])))[:12]
        if not current.get("official_node_id") and anchor.get("official_node_id"):
            current["official_node_id"] = anchor["official_node_id"]
        if current.get("name") == key and anchor.get("name"):
            current["name"] = anchor["name"]
        return current

    for node, fact, event in rows:
        if not in_scope(node):
            continue
        payload = dict(event.payload or {})
        anchor = ensure(_anchor_from_payload(payload, node.subject_key))
        if node.kernel_name == "knowledge":
            event_marker = (event.id, anchor["concept_key"])
            if event_marker in timeline_event_keys:
                continue
            timeline_event_keys.add(event_marker)
            anchor["knowledge_event_count"] += 1
            question_ref = dict(payload.get("question_ref") or {})
            for field in ("question_id", "item_id", "attempt_id", "exercise_id"):
                if payload.get(field) is not None and field not in question_ref:
                    question_ref[field] = payload[field]
            entry = {
                "fact_id": node.id,
                "event_id": event.id,
                "occurred_at": (event.occurred_at or event.created_at or datetime.utcnow()).isoformat(),
                "event_type": event.event_type,
                "observation_type": payload.get("observation_type") or node.memory_kind,
                "statement": payload.get("statement") or node.text,
                "evidence_grade": fact.evidence_grade,
                "verification": payload.get("verification") or ("unverified" if fact.evidence_grade == "self_reported" else fact.evidence_grade),
                "source_tag": payload.get("source_tag") or event.source,
                "raw_text": payload.get("raw_text") or "",
                "question_ref": question_ref,
                "mastery_inference": False if fact.evidence_grade in {"self_reported", "exposure_only"} else None,
                "correctable": True,
            }
            timelines.setdefault(anchor["concept_key"], []).append(entry)
            continue

        relation = fact.object_value if isinstance(fact.object_value, dict) else {}
        if not relation.get("relation_type"):
            continue
        source = ensure(dict(relation.get("source") or {}))
        target = ensure(dict(relation.get("target") or {}))
        marker = (event.id, source["concept_key"], target["concept_key"], str(relation["relation_type"]))
        if marker in relation_keys:
            continue
        relation_keys.add(marker)
        source["structure_relation_count"] += 1
        target["structure_relation_count"] += 1
        relations.append({
            "id": f"event:{event.id}:{relation['relation_type']}",
            "source_key": source["concept_key"],
            "target_key": target["concept_key"],
            "relation_type": relation["relation_type"],
            "label": RELATION_LABELS.get(str(relation["relation_type"]), str(relation["relation_type"])),
            "rationale": relation.get("rationale") or "",
            "evidence_event_id": event.id,
            "verification": relation.get("verification") or "unverified",
            "source_tag": relation.get("source_tag") or event.source,
            "mastery_inference": False,
        })

    for claim_node, claim, module in claim_rows:
        if not in_scope(claim_node):
            continue
        key = claim_node.subject_key.removeprefix("concept:")
        ensure({"concept_key": key, "name": key, "origin": "personal"})
        claims.setdefault(key, []).append({
            "claim_id": claim_node.id,
            "statement": claim_node.text,
            "predicate": claim.predicate,
            "verification_status": claim.verification_status,
            "status": claim_node.status,
            "confidence": float(claim_node.confidence or 0),
            "module_version": int(module.version or 1),
            "evidence_fact_ids": list(module.evidence_fact_ids or []),
        })

    nodes: list[dict[str, Any]] = []
    for key, anchor in anchors.items():
        timeline = timelines.get(key, [])[-limit_per_concept:]
        latest = timeline[-1] if timeline else None
        concept_claims = claims.get(key, [])
        uncertain = [
            item for item in timeline
            if item["observation_type"] in {"self_reported_gap", "uncertainty", "misconception", "error", "conflict"}
        ]
        conflicts = [item for item in timeline if item["observation_type"] == "conflict"]
        verified_count = sum(item["evidence_grade"] == "verified" for item in timeline)
        current_status = (
            "conflicting_evidence" if conflicts
            else "evidence_backed_claim" if any(item["status"] == "active" for item in concept_claims)
            else "verified_events" if verified_count
            else "self_report_only" if timeline
            else "relation_only"
        )
        nodes.append({
            **anchor,
            "knowledge": {
                "timeline": timeline,
                "latest_observation": latest,
                "evidence_grades": sorted({item["evidence_grade"] for item in timeline}),
                "verified_count": verified_count,
                "self_reported_count": sum(item["evidence_grade"] == "self_reported" for item in timeline),
                "claims": concept_claims,
                "current_state": {
                    "status": current_status,
                    "certain_claims": [item for item in concept_claims if item["status"] == "active"],
                    "uncertain_observations": uncertain[-6:],
                    "conflicts": conflicts[-6:],
                },
                "mastery_claim": next((item for item in reversed(concept_claims) if item["status"] == "active"), None),
            },
        })
    nodes.sort(key=lambda item: (-item["knowledge_event_count"], item["name"]))
    return {
        "version": CONCEPT_GRAPH_VERSION,
        "authority": "EvidenceEvent -> reducer -> Knowledge/Structure MemoryFact -> ConceptAnchor projection",
        "nodes": nodes,
        "edges": relations,
        "manifest": {
            "node_count": len(nodes),
            "edge_count": len(relations),
            "knowledge_owns_node_history": True,
            "structure_owns_relations": True,
            "shared_identity_only": True,
            "official_course_graph_is_separate": True,
            "self_report_never_implies_mastery": True,
            "truncated_at_fact_count": 5000,
            "scope": {
                "learner_id": learner_id,
                "project_id": project_id,
                "checkpoint_id": checkpoint_id,
                "session_id": session_id,
            },
        },
    }


async def build_personal_concept_context(
    db: AsyncSession,
    learner_id: int,
    query: str = "",
    *,
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    session_id: int | None = None,
) -> dict[str, Any]:
    graph = await build_personal_concept_graph(
        db,
        learner_id,
        limit_per_concept=8,
        project_id=project_id,
        checkpoint_id=checkpoint_id,
        session_id=session_id,
    )
    terms = {item.casefold() for item in re.findall(r"[\u4e00-\u9fffA-Za-z0-9_-]{2,}", query)}
    scored: list[tuple[int, dict[str, Any]]] = []
    for node in graph["nodes"]:
        haystack = " ".join([node["concept_key"], node["name"], *node.get("aliases", [])]).casefold()
        score = sum(term in haystack for term in terms) * 5 + min(node["knowledge_event_count"], 4)
        scored.append((score, node))
    selected = [node for _, node in sorted(scored, key=lambda item: (-item[0], item[1]["name"]))[:6]]
    selected_keys = {node["concept_key"] for node in selected}
    edges = [
        edge for edge in graph["edges"]
        if edge["source_key"] in selected_keys or edge["target_key"] in selected_keys
    ][:8]

    def compact_latest(value: dict[str, Any] | None) -> dict[str, Any] | None:
        if not value:
            return None
        return {
            "observation_type": value.get("observation_type"),
            "statement": str(value.get("statement") or "")[:320],
            "evidence_grade": value.get("evidence_grade"),
            "verification": value.get("verification"),
            "source_tag": value.get("source_tag"),
            "question_ref": dict(value.get("question_ref") or {}),
            "mastery_inference": value.get("mastery_inference"),
        }
    return {
        "version": CONCEPT_GRAPH_VERSION,
        "query": query,
        "nodes": [{
            "concept_key": node["concept_key"],
            "name": node["name"],
            "latest_observation": compact_latest(node["knowledge"]["latest_observation"]),
            "verified_count": node["knowledge"]["verified_count"],
            "self_reported_count": node["knowledge"]["self_reported_count"],
        } for node in selected],
        "edges": [{**edge, "rationale": str(edge.get("rationale") or "")[:240]} for edge in edges],
        "manifest": graph["manifest"],
    }
