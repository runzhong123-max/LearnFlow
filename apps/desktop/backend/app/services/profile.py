from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from sqlalchemy import Integer, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.learning import (
    EvidenceEvent, KernelState, LearnerBadge, LearnerProfile, LearningLifeEvent,
    MemoryArchive, MemoryFact, MemoryNode, MicroLearningRun, ReviewSchedule,
)
from app.models.project import Checkpoint, Project, Roadmap
from app.services.learning_runtime import KERNEL_NAMES, record_event
from app.services.review import schedule_bucket


KERNEL_LABELS = {
    "structure": "结构记忆",
    "knowledge": "知识记忆",
    "human": "人因记忆",
    "value": "价值记忆",
    "practice": "实践记忆",
}

GROWTH_AREA_META = {
    "structure": {
        "id": "progress",
        "title": "正在进行",
        "description": "你正在学什么，以及下次从哪里继续",
    },
    "knowledge": {
        "id": "understanding",
        "title": "理解情况",
        "description": "已经理解、还需巩固和有待解决的内容",
    },
    "practice": {
        "id": "ability",
        "title": "实践表现",
        "description": "练习、作品和独立完成情况",
    },
    "human": {
        "id": "rhythm",
        "title": "学习节奏",
        "description": "更适合你的时间、节奏和支持方式",
    },
    "value": {
        "id": "direction",
        "title": "目标与兴趣",
        "description": "你想去哪里，以及当下更值得投入的方向",
    },
}

GROWTH_AREA_ORDER = ("structure", "knowledge", "practice", "human", "value")

EVIDENCE_KIND_LABELS = {
    "verified": "学习中验证过",
    "corrected": "你主动修正过",
    "self_reported": "你告诉我的",
    "exposure_only": "刚接触，还需验证",
    "inferred": "根据对话整理",
    "legacy": "过去的学习记录",
    "observed": "根据学习记录",
}

EVIDENCE_EVENT_LABELS = {
    "registration_profile_completed": "你补充了学习资料",
    "profile_updated": "你更新了个人资料",
    "career_goal_confirmed": "你确认了一个长期方向",
    "concept_attempt_evaluated": "完成了一次知识检验",
    "exercise_attempt_evaluated": "完成了一次练习",
    "transfer_attempt_evaluated": "完成了一次变式验证",
    "review_attempt_evaluated": "完成了一次复习",
    "lecture_viewed": "学习了一段新内容",
    "teach_back_analyzed": "完成了一次复述",
}

MEMORY_LABELS = {
    "teaching_directives": "当前教学指导",
    "teaching_preferences": "你明确要求的持续教学方式",
    "active_project_id": "当前学习项目",
    "active_checkpoint_id": "当前检查点",
    "current_task": "当前任务",
    "path_position": "当前路径位置",
    "path_dependencies": "当前位置的先修关系",
    "learning_path_statuses": "课程图中的自报状态",
    "personal_learning_path_nodes": "个人学习路径节点",
    "learning_path_last_edit": "最近一次路径调整",
    "goal_candidate_node": "当前路径目标候选",
    "resume_anchor": "返回学习线索",
    "focus_transition": "最近一次学习转向",
    "deferred_threads": "稍后回到的知识线索",
    "navigation_blocker": "路径阻塞",
    "current_goal": "当前学习目标",
    "current_blocker": "当前阻塞",
    "project_graph": "长期项目图谱",
    "declared_background": "你填写的已有基础",
    "declared_starting_point": "你描述的学习起点",
    "declared_course_exposure": "你标记的课程接触情况",
    "concept_understanding": "知识点理解状态",
    "knowledge_gap": "待补知识缺口",
    "misconceptions": "重要误解",
    "mastery": "稳定掌握",
    "pending_question": "待解决问题",
    "learning_preferences": "学习节奏与偏好",
    "weekly_hours": "每周投入",
    "preferred_modes": "喜欢的学习方式",
    "affect": "近期状态",
    "cognitive_load": "近期认知负荷",
    "focus_areas": "关注方向",
    "career_goal": "职业理想",
    "career_goal_candidate": "正在考虑的长期方向",
    "current_priority": "当前优先级",
    "proof_chain": "独立实践证明",
    "artifact_candidate": "实践产物目标",
    "artifact_state": "近期产物状态",
    "assistance_level": "辅助程度",
    "last_explanation": "最近学习内容",
    "active_concepts": "当前概念",
    "proposal_status": "项目提案状态",
    "goal_candidate": "长期目标候选",
    "goal_status": "目标状态",
    "confirmed_goals": "你确认的长期方向",
    "proposal_pace": "预计学习投入",
    "recent_feedback": "最近实践反馈",
    "current_attempt": "最近一次尝试",
    "recent_errors": "近期易错点",
}

HIDDEN_MEMORY_KEYS = {
    "active_proposal_id", "proposal_id", "self_report_only", "exposure_only",
    "mastery_unchanged", "career_goal_status",
}

VALUE_LABELS = {
    "active": "持续优化中",
    "dismissed": "已暂缓",
    "source_added": "学习来源已加入",
    "source_processed": "学习来源已处理",
    "passed": "已通过",
    "failed": "需要继续尝试",
    "guided": "有引导完成",
    "hint": "使用提示完成",
    "none": "独立完成",
}

MODE_VALUE_LABELS = {
    "explanation": "小讲解",
    "example": "例子",
    "practice": "动手练习",
    "project": "项目推进",
    "reflection": "复盘",
}


def _memory_id(kernel: str, scope: str, key: str) -> str:
    return f"{kernel}:{scope}:{key}"


def parse_memory_id(memory_id: str) -> tuple[str, str, str]:
    parts = memory_id.split(":", 2)
    if len(parts) != 3 or parts[0] not in KERNEL_NAMES or parts[1] not in {"short_term", "long_term"}:
        raise ValueError("无效的记忆标识")
    return parts[0], parts[1], parts[2]


def _display_value(value, key: str = ""):
    if isinstance(value, str):
        return VALUE_LABELS.get(value, value)
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, list):
        if key in {"teaching_directives", "teaching_preferences"}:
            active = []
            for item in value:
                if not isinstance(item, dict) or item.get("status", "active") != "active":
                    continue
                if item.get("expires_at"):
                    try:
                        expiry = datetime.fromisoformat(str(item["expires_at"]).replace("Z", "+00:00"))
                        if expiry.tzinfo is None:
                            expiry = expiry.replace(tzinfo=timezone.utc)
                        if expiry <= datetime.now(timezone.utc):
                            continue
                    except ValueError:
                        continue
                active.append(item)
            return "；".join(str(item.get("instruction", "")) for item in active[-4:]) or "当前没有有效指导"
        if key == "path_dependencies":
            titles = [
                str(item.get("title")) for item in value
                if isinstance(item, dict) and item.get("title")
            ]
            return "需先衔接：" + "、".join(titles[:8]) if titles else "暂无显式先修关卡"
        if key == "preferred_modes":
            return "、".join(MODE_VALUE_LABELS.get(str(item), str(item)) for item in value[:8]) or "暂无"
        return "、".join(str(item) for item in value[:8]) or "暂无"
    if isinstance(value, dict):
        if not value:
            return "暂无"
        if key == "project_graph":
            names = [str(item.get("name")) for item in value.values() if isinstance(item, dict) and item.get("name")]
            return "、".join(names[:8]) or f"{len(value)} 个学习项目"
        if key == "mastery":
            return f"{len(value)} 个知识点已有稳定验证"
        if key == "path_position":
            checkpoint_title = value.get("checkpoint_title")
            checkpoint_order = value.get("checkpoint_order")
            project_name = value.get("project_name")
            if checkpoint_title:
                prefix = f"第 {checkpoint_order} 关 · " if checkpoint_order else ""
                return f"{project_name + ' · ' if project_name else ''}{prefix}{checkpoint_title}"
            return project_name or "项目入口"
        if key == "resume_anchor":
            return value.get("note") or value.get("checkpoint_title") or "保留当前返回位置"
        if key == "focus_transition":
            source = value.get("from_title") or "上一学习位置"
            target = value.get("to_title") or "当前学习位置"
            return f"从「{source}」转到「{target}」；返回线索已保留"
        if key == "concept_understanding":
            statuses = [
                item.get("status") for item in value.values() if isinstance(item, dict)
            ]
            stable = statuses.count("stable")
            verified_once = statuses.count("verified_once")
            needs_review = statuses.count("needs_review")
            parts = []
            if stable:
                parts.append(f"{stable} 项稳定验证")
            if verified_once:
                parts.append(f"{verified_once} 项完成一次独立验证")
            if needs_review:
                parts.append(f"{needs_review} 项需要复习")
            return "；".join(parts) or f"正在跟踪 {len(value)} 个知识点"
        if key == "misconceptions":
            return "；".join(str(item) for item in list(value.values())[:6])
        if key == "proof_chain":
            return f"{len(value)} 项独立实践证明"
        if key == "learning_preferences":
            hours = value.get("weekly_hours")
            modes = value.get("preferred_modes") or []
            mode_text = "、".join(MODE_VALUE_LABELS.get(str(item), str(item)) for item in modes)
            return f"每周 {hours} 小时；偏好 {mode_text}"
        return "；".join(
            f"{MEMORY_LABELS.get(str(item_key), str(item_key))}：{_display_value(item_value, str(item_key))}"
            for item_key, item_value in list(value.items())[:6]
        )
    if key == "weekly_hours" and isinstance(value, (int, float)):
        return f"每周 {value:g} 小时"
    return str(value)


async def award_career_goal(
    db: AsyncSession,
    *,
    learner_id: int,
    career_goal: str,
    confidence: float,
    source_event_id: int | None = None,
) -> tuple[LearningLifeEvent, LearnerBadge | None]:
    goal = career_goal.strip()[:200]
    goal_hash = hashlib.sha256(goal.casefold().encode("utf-8")).hexdigest()[:16]
    dedupe = f"career-goal:{goal_hash}"
    life_event = (await db.execute(select(LearningLifeEvent).where(
        LearningLifeEvent.learner_id == learner_id,
        LearningLifeEvent.dedupe_key == dedupe,
    ))).scalar_one_or_none()
    if not life_event:
        life_event = LearningLifeEvent(
            learner_id=learner_id,
            event_type="career_goal_confirmed",
            title="职业方向确立",
            summary=f"确定职业理想：{goal}",
            payload={"career_goal": goal},
            source_event_id=source_event_id,
            confidence=confidence,
            dedupe_key=dedupe,
        )
        db.add(life_event)
        await db.flush()
    badge = (await db.execute(select(LearnerBadge).where(
        LearnerBadge.learner_id == learner_id,
        LearnerBadge.award_key == dedupe,
    ))).scalar_one_or_none()
    if badge:
        return life_event, None
    badge = LearnerBadge(
        learner_id=learner_id,
        badge_type="career_goal_confirmed",
        title="方向已定",
        description=goal,
        icon_key="compass",
        color_token="indigo",
        award_key=dedupe,
        life_event_id=life_event.id,
        meta_data={"career_goal": goal},
    )
    db.add(badge)
    await db.flush()
    return life_event, badge


def _has_explicit_first_person_career_intent(message: str) -> bool:
    compact = re.sub(r"\s+", "", message)
    patterns = (
        r"我(?:已经)?(?:决定|确定|立志|想要|希望|打算)(?:成为|当|做|从事)",
        r"我的(?:职业)?(?:理想|目标|方向)是",
        r"我以后要(?:成为|当|做|从事)",
    )
    return any(re.search(pattern, compact) for pattern in patterns)


async def process_major_event_candidates(
    db: AsyncSession,
    *,
    learner_id: int,
    message: str,
    message_id: int,
    candidates: list[dict],
) -> tuple[list[dict], list[dict]]:
    if not _has_explicit_first_person_career_intent(message):
        return [], []
    profile = await db.get(LearnerProfile, learner_id)
    life_events: list[dict] = []
    awarded_badges: list[dict] = []
    for candidate in candidates[:1]:
        if candidate.get("event_type") != "career_goal_confirmed":
            continue
        confidence = float(candidate.get("confidence") or 0.0)
        goal = str(candidate.get("career_goal") or "").strip()[:200]
        evidence_text = str(candidate.get("evidence_text") or "").strip()
        if confidence < 0.90 or len(goal) < 2:
            continue
        if evidence_text and evidence_text not in message:
            continue
        evidence = await record_event(
            db,
            learner_id=learner_id,
            event_type="career_goal_confirmed",
            source="tutor_semantic",
            payload={"career_goal": goal, "evidence_text": evidence_text},
            confidence=confidence,
            provenance={"message_id": message_id, "rule": "explicit_first_person_intent"},
            client_event_id=f"message:{message_id}:career-goal",
        )
        if profile:
            profile.career_goal = goal
            profile.career_goal_status = "confirmed"
        life_event, badge = await award_career_goal(
            db,
            learner_id=learner_id,
            career_goal=goal,
            confidence=confidence,
            source_event_id=evidence.id,
        )
        life_events.append(life_event_view(life_event, badge))
        if badge:
            awarded_badges.append(badge_view(badge))
    return life_events, awarded_badges


async def evaluate_project_badge(
    db: AsyncSession,
    *,
    learner_id: int,
    project_id: int,
) -> tuple[LearningLifeEvent | None, LearnerBadge | None]:
    project = (await db.execute(select(Project).where(
        Project.id == project_id, Project.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not project:
        return None, None
    total, completed = (await db.execute(
        select(
            func.count(Checkpoint.id),
            func.sum((Checkpoint.learning_status == "completed").cast(Integer)),
        )
        .select_from(Roadmap)
        .join(Checkpoint, Checkpoint.roadmap_id == Roadmap.id)
        .where(Roadmap.project_id == project_id, Checkpoint.archived.is_(False))
    )).one()
    total, completed = total or 0, completed or 0
    if total == 0 or completed != total:
        return None, None
    dedupe = f"project:{project_id}:completed"
    life_event = (await db.execute(select(LearningLifeEvent).where(
        LearningLifeEvent.learner_id == learner_id,
        LearningLifeEvent.dedupe_key == dedupe,
    ))).scalar_one_or_none()
    if not life_event:
        evidence = await record_event(
            db,
            learner_id=learner_id,
            project_id=project_id,
            event_type="project_completed",
            source="runtime",
            payload={
                "project_id": project_id,
                "name": project.name,
                "checkpoint_count": total,
            },
            confidence=1.0,
            provenance={"rule": "all_non_archived_checkpoints_completed"},
            client_event_id=dedupe,
        )
        life_event = LearningLifeEvent(
            learner_id=learner_id,
            event_type="project_completed",
            title=f"完成学习项目：{project.name}",
            summary=f"已完成 {total} 个检查点的独立验证",
            payload={"project_id": project_id, "checkpoint_count": total},
            source_event_id=evidence.id,
            project_id=project_id,
            confidence=1.0,
            dedupe_key=dedupe,
        )
        db.add(life_event)
        await db.flush()
    badge = (await db.execute(select(LearnerBadge).where(
        LearnerBadge.learner_id == learner_id,
        LearnerBadge.award_key == dedupe,
    ))).scalar_one_or_none()
    if badge:
        return life_event, None
    badge = LearnerBadge(
        learner_id=learner_id,
        badge_type="project_completed",
        title=f"完成「{project.name}」",
        description=f"完成全部 {total} 个检查点",
        icon_key="trophy",
        color_token="emerald",
        award_key=dedupe,
        life_event_id=life_event.id,
        project_id=project_id,
        meta_data={"checkpoint_count": total},
    )
    db.add(badge)
    await db.flush()
    return life_event, badge


async def memory_projection(db: AsyncSession, learner_id: int) -> list[dict]:
    states = (await db.execute(select(KernelState).where(
        KernelState.learner_id == learner_id,
    ))).scalars().all()
    archives = (await db.execute(select(MemoryArchive).where(
        MemoryArchive.learner_id == learner_id,
    ))).scalars().all()
    archive_map = {
        (item.kernel_name, item.memory_scope, item.memory_key): item for item in archives
    }
    state_map = {item.kernel_name: item for item in states}
    dimensions = []
    for kernel in KERNEL_NAMES:
        memories = []
        state = state_map.get(kernel)
        memory_sources = [(kernel, state)] if state else []
        if kernel == "value":
            structure_state = state_map.get("structure")
            value_has_goal = False
            if state:
                value_has_goal = any(
                    "current_goal" in (getattr(state, scope) or {})
                    for scope in ("short_term", "long_term")
                )
            if structure_state and not value_has_goal:
                memory_sources.append(("structure", structure_state))
        for source_kernel, source_state in memory_sources:
            for scope, payload in (("short_term", source_state.short_term or {}), ("long_term", source_state.long_term or {})):
                for key, value in payload.items():
                    if source_kernel == "structure" and key != "current_goal" and kernel == "value":
                        continue
                    if kernel == "structure" and key == "current_goal":
                        continue
                    if key in {"transient_expires_at", *HIDDEN_MEMORY_KEYS} or value in (None, "", [], {}):
                        continue
                    archive = archive_map.get((source_kernel, scope, key))
                    evidence_count = len(source_state.evidence_refs or [])
                    confidence = float(source_state.confidence or 0.0)
                    summary = _display_value(value, key)
                    if key in {"declared_background", "declared_starting_point"}:
                        summary = f"{summary}（由你提供，尚未通过答题或实践验证）"
                    if key == "active_project_id":
                        project = (await db.execute(select(Project).where(
                            Project.id == value, Project.learner_id == learner_id,
                        ))).scalar_one_or_none()
                        summary = project.name if project else "当前项目"
                    elif key == "active_checkpoint_id":
                        checkpoint = (await db.execute(
                            select(Checkpoint)
                            .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                            .join(Project, Project.id == Roadmap.project_id)
                            .where(Checkpoint.id == value, Project.learner_id == learner_id)
                        )).scalar_one_or_none()
                        summary = checkpoint.title if checkpoint else "当前检查点"
                    memories.append({
                        "memory_id": _memory_id(source_kernel, scope, key),
                        "key": key,
                        "label": MEMORY_LABELS.get(key, key.replace("_", " ")),
                        "value": value,
                        "summary": summary,
                        "scope": scope,
                        "confidence": confidence,
                        "confidence_range": [
                            round(max(0.0, confidence - 0.1), 2),
                            round(min(1.0, confidence + 0.1), 2),
                        ],
                        "evidence_count": evidence_count,
                        "updated_at": source_state.updated_at.isoformat() if source_state.updated_at else None,
                        "status": archive.status if archive else "active",
                        "transient_expires_at": (source_state.short_term or {}).get("transient_expires_at") if scope == "short_term" else None,
                        "verification_status": (
                            "self_reported" if key in {"declared_background", "declared_starting_point"}
                            else "verified" if key == "mastery"
                            else "exposure_only" if key in {"active_concepts", "last_explanation"}
                            else "observed"
                        ),
                    })
        dimensions.append({"kernel": kernel, "label": KERNEL_LABELS[kernel], "memories": memories})
    return dimensions


async def journey_projection(
    db: AsyncSession, learner_id: int, *, limit: int = 50,
) -> dict:
    events = (await db.execute(select(LearningLifeEvent).where(
        LearningLifeEvent.learner_id == learner_id,
    ).order_by(LearningLifeEvent.occurred_at.desc()).limit(min(max(limit, 1), 100)))).scalars().all()
    badges = (await db.execute(select(LearnerBadge).where(
        LearnerBadge.learner_id == learner_id,
    ))).scalars().all()
    badge_by_event = {badge.life_event_id: badge for badge in badges}
    return {
        "events": [life_event_view(event, badge_by_event.get(event.id)) for event in events],
        "badges": [
            badge_view(badge)
            for badge in sorted(badges, key=lambda item: item.awarded_at, reverse=True)
        ],
    }


def _growth_memory(memory: dict) -> dict:
    source_kind = memory.get("verification_status") or "observed"
    return {
        "memory_id": memory["memory_id"],
        "title": memory["label"],
        "summary": memory["summary"],
        "retention": "long" if memory["scope"] == "long_term" else "recent",
        "retention_label": "长期保留" if memory["scope"] == "long_term" else "近期参考",
        "source_kind": source_kind,
        "source_label": EVIDENCE_KIND_LABELS.get(source_kind, "根据学习记录"),
        "related_record_count": int(memory.get("evidence_count") or 0),
        "updated_at": memory.get("updated_at"),
        "status": memory.get("status") or "active",
        "expires_at": memory.get("transient_expires_at"),
    }


async def recent_growth_evidence(
    db: AsyncSession, learner_id: int, *, limit: int = 12,
) -> list[dict]:
    rows = (await db.execute(
        select(MemoryNode, MemoryFact, EvidenceEvent)
        .join(MemoryFact, MemoryFact.node_id == MemoryNode.id)
        .join(EvidenceEvent, EvidenceEvent.id == MemoryFact.source_event_id)
        .where(
            MemoryNode.learner_id == learner_id,
            EvidenceEvent.learner_id == learner_id,
            MemoryNode.status.in_(["active", "transient", "legacy"]),
        )
        .order_by(MemoryNode.occurred_at.desc(), MemoryNode.id.desc())
        .limit(min(max(limit, 1), 30) * 5)
    )).all()
    hidden_keys = HIDDEN_MEMORY_KEYS | {
        "active_project_id", "active_checkpoint_id", "project_graph", "memory_graph_claims",
    }
    results: list[dict] = []
    seen_events: set[int] = set()
    for node, fact, event in rows:
        key = str((node.payload or {}).get("key") or fact.predicate.rsplit(".", 1)[-1])
        if key in hidden_keys or event.id in seen_events:
            continue
        seen_events.add(event.id)
        meta = GROWTH_AREA_META.get(node.kernel_name, GROWTH_AREA_META["structure"])
        summary = _display_value(fact.object_value, key)
        if key in {"declared_background", "declared_starting_point"}:
            summary = f"{summary}（由你提供，尚未经过练习验证）"
        results.append({
            "id": event.id,
            "title": EVIDENCE_EVENT_LABELS.get(event.event_type, "新增了一条学习记录"),
            "summary": f"{MEMORY_LABELS.get(key, key.replace('_', ' '))}：{summary}",
            "area": meta["id"],
            "area_title": meta["title"],
            "source_kind": fact.evidence_grade,
            "source_label": EVIDENCE_KIND_LABELS.get(fact.evidence_grade, "根据学习记录"),
            "occurred_at": (event.occurred_at or node.occurred_at).isoformat(),
        })
        if len(results) >= limit:
            break
    return results


async def growth_projection(db: AsyncSession, learner_id: int) -> dict:
    """Build a learner-facing read model from existing authoritative projections.

    This function only reads KernelState, evidence-backed memory facts, review
    schedules and journey records. It deliberately does not create evidence or
    infer new mastery state.
    """
    dimensions = await memory_projection(db, learner_id)
    dimension_map = {item["kernel"]: item for item in dimensions}
    raw_memories = [
        memory
        for dimension in dimensions
        for memory in dimension.get("memories", [])
    ]
    active_memories = [item for item in raw_memories if item.get("status") != "archived"]
    memory_by_key = {item["key"]: item for item in active_memories}

    areas = []
    for kernel in GROWTH_AREA_ORDER:
        meta = GROWTH_AREA_META[kernel]
        memories = [
            _growth_memory(memory)
            for memory in dimension_map.get(kernel, {}).get("memories", [])
        ]
        areas.append({
            **meta,
            "active_count": sum(item["status"] != "archived" for item in memories),
            "memories": memories,
        })

    journey = await journey_projection(db, learner_id)
    evidence = await recent_growth_evidence(db, learner_id)
    evidence_counts = dict((await db.execute(
        select(MemoryFact.evidence_grade, func.count(MemoryFact.node_id))
        .join(MemoryNode, MemoryNode.id == MemoryFact.node_id)
        .where(MemoryNode.learner_id == learner_id)
        .group_by(MemoryFact.evidence_grade)
    )).all())
    schedules = (await db.execute(select(ReviewSchedule).where(
        ReviewSchedule.learner_id == learner_id,
    ))).scalars().all()
    due_reviews = sum(
        schedule_bucket(schedule) in {"wrong", "overdue", "due"}
        for schedule in schedules
    )
    project_count = int(await db.scalar(select(func.count(Project.id)).where(
        Project.learner_id == learner_id,
        Project.visibility == "visible",
    )) or 0)
    completed_loops = int(await db.scalar(select(func.count(MicroLearningRun.id)).where(
        MicroLearningRun.learner_id == learner_id,
        MicroLearningRun.status == "completed",
    )) or 0)

    current_project = memory_by_key.get("active_project_id")
    current_checkpoint = memory_by_key.get("active_checkpoint_id")
    current_task = memory_by_key.get("current_task")
    current_goal = (
        memory_by_key.get("current_goal")
        or memory_by_key.get("current_priority")
        or memory_by_key.get("career_goal")
        or memory_by_key.get("career_goal_candidate")
    )
    focus_memory = current_task or current_checkpoint or current_project or current_goal
    current_focus = focus_memory["summary"] if focus_memory else "还没有确定当前学习重点"
    if current_checkpoint and current_project and focus_memory is current_checkpoint:
        focus_context = f"当前项目：{current_project['summary']}"
    elif current_goal and focus_memory is not current_goal:
        focus_context = f"当前目标：{current_goal['summary']}"
    else:
        focus_context = "从一个足够小、可以完成验证的目标开始"

    if due_reviews:
        next_action = {
            "title": f"完成 {due_reviews} 项待处理复习",
            "description": "先处理最需要巩固的内容，学习会更稳。",
            "route": "/review",
            "action_label": "去复习",
        }
    elif current_project and isinstance(current_project.get("value"), int):
        next_action = {
            "title": f"继续「{current_project['summary']}」",
            "description": current_checkpoint["summary"] if current_checkpoint else "回到上次的学习位置继续推进。",
            "route": f"/projects/{current_project['value']}",
            "action_label": "继续学习",
        }
    else:
        next_action = {
            "title": "完成第一个可验证的小目标",
            "description": "告诉主 Agent 你现在最想学会什么，它会带你跑完一个小闭环。",
            "route": "/agent",
            "action_label": "开始学习",
        }

    badge_count = len(journey["badges"])
    verified_records = int(evidence_counts.get("verified", 0) or 0)
    if badge_count:
        encouragement = f"你已经获得 {badge_count} 枚成长徽章。每一枚都对应一次真实完成。"
    elif completed_loops:
        encouragement = f"你已经完成 {completed_loops} 次专注学习闭环，进步正在累积。"
    elif verified_records:
        encouragement = f"已有 {verified_records} 条学习表现经过验证，可以继续积累稳定掌握。"
    else:
        encouragement = "完成一次复述或练习后，这里会开始记录你的真实进步。"

    return {
        "overview": {
            "current_focus": current_focus,
            "focus_context": focus_context,
            "encouragement": encouragement,
            "next_action": next_action,
        },
        "stats": {
            "projects": project_count,
            "badges": badge_count,
            "completed_learning_loops": completed_loops,
            "active_memories": len(active_memories),
            "archived_memories": len(raw_memories) - len(active_memories),
            "verified_records": verified_records,
            "learning_records": sum(int(value or 0) for value in evidence_counts.values()),
            "due_reviews": due_reviews,
        },
        "areas": areas,
        "evidence": evidence,
        "journey": journey,
    }


async def set_memory_archive(
    db: AsyncSession,
    *,
    learner_id: int,
    memory_id: str,
    archived: bool,
    reason: str = "",
) -> MemoryArchive:
    kernel, scope, key = parse_memory_id(memory_id)
    state = (await db.execute(select(KernelState).where(
        KernelState.learner_id == learner_id, KernelState.kernel_name == kernel,
    ))).scalar_one_or_none()
    payload = dict(getattr(state, scope) or {}) if state else {}
    if key not in payload:
        raise ValueError("记忆不存在")
    archive = (await db.execute(select(MemoryArchive).where(
        MemoryArchive.learner_id == learner_id,
        MemoryArchive.kernel_name == kernel,
        MemoryArchive.memory_scope == scope,
        MemoryArchive.memory_key == key,
    ))).scalar_one_or_none()
    if not archive:
        archive = MemoryArchive(
            learner_id=learner_id,
            kernel_name=kernel,
            memory_scope=scope,
            memory_key=key,
            archived_value=payload[key],
        )
        db.add(archive)
    archive.status = "archived" if archived else "restored"
    archive.reason = reason.strip()[:500]
    archive.archived_at = datetime.utcnow() if archived else archive.archived_at
    archive.restored_at = None if archived else datetime.utcnow()
    evidence = await record_event(
        db,
        learner_id=learner_id,
        event_type="memory_archived" if archived else "memory_restored",
        source="profile",
        payload={"memory_id": memory_id, "reason": archive.reason, "value": payload[key]},
        confidence=1.0,
        provenance={"user_correction": True},
        client_event_id=f"memory:{memory_id}:{archive.status}:{int(datetime.utcnow().timestamp() * 1000)}",
    )
    archive.evidence_id = evidence.id
    if archived and kernel == "value" and key in {"career_goal", "career_goal_candidate"}:
        events = (await db.execute(select(LearningLifeEvent).where(
            LearningLifeEvent.learner_id == learner_id,
            LearningLifeEvent.event_type == "career_goal_confirmed",
            LearningLifeEvent.status == "active",
        ))).scalars().all()
        for event in events:
            if (event.payload or {}).get("career_goal") == payload[key]:
                event.status = "corrected"
                event.corrected_at = datetime.utcnow()
    await db.flush()
    return archive


def life_event_view(event: LearningLifeEvent, badge: LearnerBadge | None = None) -> dict:
    return {
        "id": event.id,
        "event_type": event.event_type,
        "status": event.status,
        "title": event.title,
        "summary": event.summary,
        "payload": event.payload or {},
        "confidence": event.confidence,
        "project_id": event.project_id,
        "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
        "badge": badge_view(badge) if badge else None,
    }


def badge_view(badge: LearnerBadge) -> dict:
    return {
        "id": badge.id,
        "badge_type": badge.badge_type,
        "title": badge.title,
        "description": badge.description,
        "icon_key": badge.icon_key,
        "color_token": badge.color_token,
        "project_id": badge.project_id,
        "awarded_at": badge.awarded_at.isoformat() if badge.awarded_at else None,
    }
