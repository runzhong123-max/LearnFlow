"""Deterministic, explainable review proficiency and memory projections.

This module deliberately produces a rebuildable read model.  It does not
write KernelState and it is not a second mastery authority.  LearningAttempt,
EvidenceEvent and the five-kernel reducer remain authoritative.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.models.learning import EvidenceEvent, LearningAttempt, RemediationCase, ReviewSchedule


PROFICIENCY_POLICY_VERSION = "concept-proficiency-v2"
REVIEW_INTERVAL_DAYS = (1, 3, 7, 14, 30, 60)
DSR_DECAY = -0.5
DSR_TARGET_RETENTION = 0.9
DSR_FACTOR = DSR_TARGET_RETENTION ** (1 / DSR_DECAY) - 1
RESEARCH_SOURCES = (
    {
        "id": "cepeda-2006-spacing",
        "title": "Distributed practice in verbal recall tasks: a quantitative synthesis",
        "url": "https://escholarship.org/content/qt3rr6q10c/qt3rr6q10c.pdf",
        "use": "间隔应随目标保持时长变化，不能使用一条普适艾宾浩斯百分比表",
    },
    {
        "id": "settles-meeder-2016-hlr",
        "title": "A Trainable Spaced Repetition Model for Language Learning",
        "url": "https://aclanthology.org/P16-1174/",
        "use": "用半衰期/遗忘曲线预测回忆概率，并强调模型必须由真实日志训练",
    },
    {
        "id": "roediger-karpicke-2006-retrieval",
        "title": "Test-Enhanced Learning: Taking Memory Tests Improves Long-Term Retention",
        "url": "https://doi.org/10.1111/j.1467-9280.2006.01693.x",
        "use": "复习必须包含主动检索，重复阅读或内容曝光不能替代检索证据",
    },
    {
        "id": "ye-su-cao-2022-ssp",
        "title": "A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling",
        "url": "https://doi.org/10.1145/3534678.3539081",
        "use": "个体化调度需要时序日志、记忆状态模型和成本目标，固定参数只是冷启动",
    },
    {
        "id": "fsrs-dsr-algorithm",
        "title": "FSRS DSR algorithm specification",
        "url": "https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm",
        "use": "以 Difficulty、Stability、Retrievability 分离描述记忆状态",
    },
)
DIMENSION_WEIGHTS = {
    "accuracy": 0.35,
    "retrievability": 0.20,
    "independence": 0.20,
    "transfer": 0.15,
    "spacing": 0.10,
}


def attempt_passed(attempt: LearningAttempt) -> bool:
    result = dict(attempt.result or {})
    if isinstance(result.get("passed"), bool):
        return bool(result["passed"])
    if isinstance(result.get("correct"), bool):
        return bool(result["correct"])
    if attempt.item_type == "concept":
        return bool(result.get("correct"))
    total = int(result.get("total") or 0)
    passed = result.get("passed")
    return total > 0 and not isinstance(passed, bool) and int(passed or 0) == total


def _event_by_attempt(events: list[EvidenceEvent]) -> dict[int, EvidenceEvent]:
    result: dict[int, EvidenceEvent] = {}
    for event in events:
        attempt_id = (event.payload or {}).get("attempt_id")
        if isinstance(attempt_id, int):
            result[attempt_id] = event
    return result


def _question_form(attempt: LearningAttempt, event: EvidenceEvent | None) -> str:
    # A retry is evidence about recovering the source item, never transfer,
    # even when a legacy assessment event carried a variant-shaped label.
    if attempt.attempt_role == "retry":
        return "original"
    if attempt.attempt_role in {"variant", "transfer"}:
        return "validated_variant"
    if event:
        value = str((event.payload or {}).get("question_form") or "")
        if value:
            return value
    return "original"


def _days_between(start: datetime | None, end: datetime) -> float:
    if not start:
        return 0.0
    return max(0.0, (end - start).total_seconds() / 86_400)


def _round_score(value: float) -> int:
    return max(0, min(100, round(value)))


def build_concept_proficiency(
    schedule: ReviewSchedule,
    attempts: list[LearningAttempt],
    events: list[EvidenceEvent],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build an interpretable proficiency estimate from graded evidence only."""
    now = now or datetime.utcnow()
    evaluated = [attempt for attempt in attempts if attempt.evaluated_at or attempt.submitted_at]
    event_map = _event_by_attempt(events)

    weighted_success = 0.0
    weighted_total = 0.0
    independent_passes = 0
    passed_attempts = 0
    independent_variants = 0
    variant_attempts = 0
    unknown_count = 0

    for attempt in evaluated:
        event = event_map.get(attempt.id)
        passed = attempt_passed(attempt)
        independent = attempt.assistance_level == "none"
        form = _question_form(attempt, event)
        is_variant = form == "validated_variant" or attempt.attempt_role in {"variant", "transfer"}
        evidence_weight = 1.0 if independent else 0.45
        if is_variant:
            evidence_weight *= 1.15
            variant_attempts += 1
        weighted_total += evidence_weight
        if passed:
            weighted_success += evidence_weight
            passed_attempts += 1
            independent_passes += int(independent)
            independent_variants += int(independent and is_variant)
        if attempt.status == "abstained" or (event and (event.payload or {}).get("outcome") == "unknown"):
            unknown_count += 1

    if not evaluated:
        accuracy = independence = transfer = 0.0
    else:
        # A Beta(1, 1) prior prevents one observation from looking certain.
        accuracy = 100 * (1 + weighted_success) / (2 + weighted_total)
        independence = 100 * independent_passes / max(1, passed_attempts)
        transfer = min(100.0, independent_variants * 75.0 + max(0, variant_attempts - independent_variants) * 25.0)

    last_seen = schedule.last_reviewed_at
    if not last_seen and evaluated:
        last_seen = max(
            (attempt.evaluated_at or attempt.submitted_at for attempt in evaluated if attempt.evaluated_at or attempt.submitted_at),
            default=None,
        )
    interval_level = max(0, min(int(schedule.interval_level or 0), len(REVIEW_INTERVAL_DAYS) - 1))
    # Cold-start DSR proxy.  ReviewSchedule's interval is treated as the
    # current 90%-retention stability horizon.  It can be replaced by fitted
    # per-user parameters once enough timestamped review logs exist.
    stability_days = float(REVIEW_INTERVAL_DAYS[interval_level])
    elapsed_days = _days_between(last_seen, now)
    retrievability = (
        100 * (1 + DSR_FACTOR * elapsed_days / stability_days) ** DSR_DECAY
        if evaluated else 0.0
    )
    failed_weight = sum(
        1.0 if not attempt_passed(attempt) else 0.35 if attempt.assistance_level != "none" else 0.0
        for attempt in evaluated
    )
    difficulty = 5.0 if not evaluated else 1 + 9 * (1 + failed_weight) / (2 + len(evaluated))
    difficulty = round(max(1.0, min(10.0, difficulty)), 2)
    spacing = min(100.0, int(schedule.successful_reviews or 0) * 32.0)
    if int(schedule.interval_level or 0) >= 5:
        spacing = 100.0

    dimensions = {
        "accuracy": _round_score(accuracy),
        "retrievability": _round_score(retrievability),
        "independence": _round_score(independence),
        "transfer": _round_score(transfer),
        "spacing": _round_score(spacing),
    }
    raw_score = sum(dimensions[key] * weight for key, weight in DIMENSION_WEIGHTS.items())

    caps: list[dict[str, Any]] = []
    cap = 100
    if not evaluated:
        cap = 0
        caps.append({"code": "no_graded_evidence", "limit": 0, "reason": "没有已判分证据"})
    elif independent_passes == 0:
        cap = min(cap, 40)
        caps.append({"code": "assisted_only", "limit": 40, "reason": "目前只有带提示或失败证据"})
    elif independent_passes == 1:
        cap = min(cap, 65)
        caps.append({"code": "single_independent_success", "limit": 65, "reason": "只有一次独立成功"})
    if independent_variants == 0:
        cap = min(cap, 80)
        caps.append({"code": "no_transfer_variant", "limit": 80, "reason": "尚无独立变式迁移证据"})
    if int(schedule.successful_reviews or 0) < 2:
        cap = min(cap, 88)
        caps.append({"code": "insufficient_spacing", "limit": 88, "reason": "尚未形成跨时检索证据"})
    if int(schedule.lapse_count or 0) > 0 and schedule.last_grade in {"again", "hard"}:
        cap = min(cap, 72)
        caps.append({"code": "recent_lapse", "limit": 72, "reason": "最近出现提取失败或需支架"})
    score = _round_score(min(raw_score, cap))

    if score == 0:
        level = "unobserved"
        label = "尚未量化"
    elif score < 40:
        level = "fragile"
        label = "脆弱"
    elif score < 65 or independent_variants == 0:
        level = "developing"
        label = "形成中"
    elif score < 85:
        level = "transferable"
        label = "可迁移"
    else:
        level = "durable"
        label = "较稳定"

    evidence_diversity = sum((bool(independent_passes), bool(variant_attempts), bool(schedule.successful_reviews)))
    confidence = min(0.95, 0.12 + min(6, len(evaluated)) * 0.09 + evidence_diversity * 0.10)
    if not evaluated:
        confidence = 0.0

    if independent_passes == 0:
        next_evidence = "完成一次无提示作答"
    elif independent_variants == 0:
        next_evidence = "完成一题已校验变式，检查能否迁移"
    elif int(schedule.successful_reviews or 0) < 2:
        next_evidence = "按期完成下一次无提示检索，形成跨时证据"
    else:
        next_evidence = "在后续到期点继续检索，监测遗忘与恢复"

    return {
        "policy_version": PROFICIENCY_POLICY_VERSION,
        "score": score,
        "level": level,
        "label": label,
        "confidence": round(confidence, 2),
        "dimensions": dimensions,
        "dimension_weights": DIMENSION_WEIGHTS,
        "caps": caps,
        "evidence": {
            "evaluated_attempts": len(evaluated),
            "passed_attempts": passed_attempts,
            "independent_passes": independent_passes,
            "variant_attempts": variant_attempts,
            "independent_variant_passes": independent_variants,
            "successful_reviews": int(schedule.successful_reviews or 0),
            "lapses": int(schedule.lapse_count or 0),
            "unknown": unknown_count,
            "elapsed_days": round(elapsed_days, 2),
            "estimated_stability_days": round(stability_days, 2),
        },
        "next_evidence": next_evidence,
        "memory_state": {
            "model_family": "DSR",
            "difficulty": difficulty,
            "stability_days": round(stability_days, 2),
            "retrievability": round(retrievability / 100, 4),
            "target_retention": DSR_TARGET_RETENTION,
            "calibration": "cold_start_schedule_proxy_not_user_trained",
        },
        "research_basis": list(RESEARCH_SOURCES),
        "authority": "rebuildable_read_model_from_graded_evidence",
        "mastery_boundary": "该分数用于复习排序与解释；当前 DSR 参数尚未由本用户日志训练，不替代 Knowledge/Practice 的证据结论。",
    }


def build_review_memory_notes(
    schedule: ReviewSchedule,
    attempts: list[LearningAttempt],
    cases: list[RemediationCase],
    events: list[EvidenceEvent],
) -> list[dict[str, Any]]:
    """Project concrete, provenance-bearing learning memories for one item."""
    notes: list[dict[str, Any]] = []
    event_map = _event_by_attempt(events)

    for case in cases[:8]:
        notes.append({
            "id": f"remediation:{case.id}:misconception",
            "kind": "misconception",
            "title": "具体误解",
            "text": case.misconception_tag or case.error_class or "存在待澄清的错误模式",
            "status": "corrected" if case.status == "completed" else "active",
            "source": "deterministic_remediation",
            "evidence_refs": [f"event:{value}" for value in list(case.evidence_event_ids or [])[:8]],
            "occurred_at": case.created_at.isoformat() if case.created_at else None,
            "mastery_inference": False,
        })
        if case.status == "completed" and case.current_delivery_mode:
            notes.append({
                "id": f"remediation:{case.id}:effective-support",
                "kind": "insight",
                "title": "有效启发",
                "text": f"采用“{case.current_delivery_mode}”后完成原题重做与变式验证。",
                "status": "observed",
                "source": "completed_remediation_loop",
                "evidence_refs": [f"attempt:{value}" for value in (case.retry_attempt_id, case.variant_attempt_id) if value],
                "occurred_at": case.completed_at.isoformat() if case.completed_at else None,
                "mastery_inference": False,
            })
        for mode in list(case.ineffective_modes or [])[:4]:
            notes.append({
                "id": f"remediation:{case.id}:ineffective:{mode}",
                "kind": "support",
                "title": "暂时无效的讲法",
                "text": f"“{mode}”在这次纠错中未帮助完成闭环。",
                "status": "observed",
                "source": "learner_feedback",
                "evidence_refs": [f"remediation:{case.id}"],
                "occurred_at": case.updated_at.isoformat() if case.updated_at else None,
                "mastery_inference": False,
            })

    for attempt in attempts:
        if not attempt_passed(attempt) or attempt.assistance_level != "none":
            continue
        event = event_map.get(attempt.id)
        form = _question_form(attempt, event)
        if form == "validated_variant" or attempt.attempt_role in {"variant", "transfer"}:
            text = "在无提示条件下完成了已校验变式，表现出一次迁移证据。"
            title = "做得好的地方 · 迁移"
        else:
            text = "在无提示条件下独立完成了这道题。"
            title = "做得好的地方 · 独立完成"
        notes.append({
            "id": f"attempt:{attempt.id}:strength",
            "kind": "strength",
            "title": title,
            "text": text,
            "status": "verified_once",
            "source": "graded_attempt",
            "evidence_refs": [f"attempt:{attempt.id}", *([f"event:{event.id}"] if event else [])],
            "occurred_at": (attempt.evaluated_at or attempt.submitted_at).isoformat() if (attempt.evaluated_at or attempt.submitted_at) else None,
            "mastery_inference": False,
        })

    for event in events:
        if event.event_type != "review_reflection_recorded":
            continue
        payload = dict(event.payload or {})
        if int(payload.get("review_schedule_id") or 0) != schedule.id:
            continue
        kind = str(payload.get("reflection_kind") or "insight")
        title = {
            "insight": "我的启发",
            "misconception": "我发现的误解",
            "strength": "我做得好的地方",
            "question": "仍待解决的问题",
        }.get(kind, "学习反思")
        notes.append({
            "id": f"event:{event.id}:reflection",
            "kind": kind,
            "title": title,
            "text": str(payload.get("text") or "")[:1000],
            "status": "self_reported_unverified",
            "source": "learner_self_report",
            "evidence_refs": [f"event:{event.id}"],
            "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
            "mastery_inference": False,
            "correctable": True,
        })

    unique: dict[str, dict[str, Any]] = {}
    for note in notes:
        if note.get("text"):
            unique[note["id"]] = note
    return sorted(
        unique.values(),
        key=lambda item: (item.get("occurred_at") or "", item["id"]),
        reverse=True,
    )[:24]
