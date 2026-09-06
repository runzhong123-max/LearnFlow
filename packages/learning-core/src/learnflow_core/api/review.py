from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import (
    EvidenceEvent, KernelState, LearningAttempt, LearningTask, RemediationCase, ReviewSchedule,
)
from app.models.project import Checkpoint, ConceptQuestion, Exercise, Project
from app.schemas.review import ReviewActionRequest, ReviewReflectionRequest, ReviewSubmitRequest
from app.services.auth import CurrentLearner, get_current_learner
from app.services.demo_code_grader import grade_seeded_demo_code
from app.services.learning_runtime import create_attempt, record_event
from app.services.remediation import (
    apply_retry_result, create_remediation_case, serialize_case, submit_variant,
)
from app.services.personal_concept_graph import normalize_concept_key
from app.services.review import (
    ACTIVE_PHASE, REMEDIATION_PHASE, SUSPENDED_PHASE,
    apply_assessment_result, load_owned_schedule, review_presentation,
    review_submission_key, schedule_bucket, serialize_schedule,
)
from app.services.review_proficiency import (
    PROFICIENCY_POLICY_VERSION, build_concept_proficiency, build_review_memory_notes,
)


router = APIRouter(prefix="/review", tags=["Spaced Review"])


def _concept_evidence_fields(
    schedule: ReviewSchedule, *, fallback_name: str = "",
) -> dict[str, Any]:
    """Give Knowledge facts one stable ConceptAnchor coordinate."""
    raw = str(schedule.subject_key or "").strip()
    if raw.startswith("concept:"):
        name = raw.removeprefix("concept:").strip()
    elif raw.startswith("target:"):
        name = raw.removeprefix("target:").strip()
    elif raw.startswith(("concept-item:", "exercise:")):
        name = fallback_name.strip()
    else:
        name = raw or fallback_name.strip()
    name = name or f"{schedule.item_type}-{schedule.item_id}"
    concept_key = normalize_concept_key(name)
    return {
        "subject_key": schedule.subject_key,
        "memory_subject_key": f"concept:{concept_key}",
        "concept_key": concept_key,
        "concept_name": name[:160],
        "concept_origin": "assessment_projection",
    }


def _attempt_passed(attempt: LearningAttempt) -> bool:
    result = dict(attempt.result or {})
    if "passed" in result and isinstance(result.get("passed"), bool):
        return bool(result.get("passed"))
    if "correct" in result and isinstance(result.get("correct"), bool):
        return bool(result.get("correct"))
    if attempt.item_type == "concept":
        return bool(result.get("correct"))
    total = int(result.get("total") or 0)
    return total > 0 and int(result.get("passed") or 0) == total


def _safe_result(value: dict[str, Any] | None) -> dict[str, Any]:
    hidden = {"answer_indexes", "expected", "solution", "test_cases"}

    def clean(item: Any) -> Any:
        if isinstance(item, dict):
            return {key: clean(val) for key, val in item.items() if key not in hidden}
        if isinstance(item, list):
            return [clean(val) for val in item]
        return item

    return clean(dict(value or {}))


async def _open_remediation(
    db: AsyncSession, schedule: ReviewSchedule,
) -> RemediationCase | None:
    return (await db.execute(
        select(RemediationCase)
        .where(
            RemediationCase.learner_id == schedule.learner_id,
            RemediationCase.item_type == schedule.item_type,
            RemediationCase.item_id == schedule.item_id,
            RemediationCase.status != "completed",
        )
        .order_by(RemediationCase.updated_at.desc(), RemediationCase.id.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _all_attempts(
    db: AsyncSession, schedule: ReviewSchedule,
) -> list[LearningAttempt]:
    return list((await db.execute(
        select(LearningAttempt)
        .where(
            LearningAttempt.learner_id == schedule.learner_id,
            LearningAttempt.item_type == schedule.item_type,
            LearningAttempt.item_id == schedule.item_id,
        )
        .order_by(LearningAttempt.evaluated_at.desc(), LearningAttempt.id.desc())
    )).scalars().all())


async def _with_case_attempts(
    db: AsyncSession,
    *,
    learner_id: int,
    attempts: list[LearningAttempt],
    cases: list[RemediationCase],
) -> list[LearningAttempt]:
    """Include retry/variant attempts in evidence projections.

    A remediation variant has its own item identity so it cannot be mistaken
    for another submission to the source question.  Read models still need to
    join it through the owned RemediationCase when calculating transfer.
    """
    linked_attempt_ids = {
        attempt_id
        for case in cases
        for attempt_id in (case.source_attempt_id, case.retry_attempt_id, case.variant_attempt_id)
        if attempt_id is not None
    }
    known_attempt_ids = {attempt.id for attempt in attempts}
    missing_attempt_ids = linked_attempt_ids - known_attempt_ids
    if not missing_attempt_ids:
        return attempts
    linked_attempts = list((await db.execute(select(LearningAttempt).where(
        LearningAttempt.learner_id == learner_id,
        LearningAttempt.id.in_(missing_attempt_ids),
    ))).scalars().all())
    result = [*attempts, *linked_attempts]
    result.sort(
        key=lambda attempt: attempt.evaluated_at or attempt.submitted_at or datetime.min,
        reverse=True,
    )
    return result


async def _review_events(
    db: AsyncSession,
    schedule: ReviewSchedule,
    attempts: list[LearningAttempt],
    cases: list[RemediationCase],
) -> list[EvidenceEvent]:
    attempt_ids = {item.id for item in attempts}
    case_event_ids = {value for case in cases for value in list(case.evidence_event_ids or [])}
    if schedule.last_event_id:
        case_event_ids.add(schedule.last_event_id)
    candidates = list((await db.execute(
        select(EvidenceEvent)
        .where(
            EvidenceEvent.learner_id == schedule.learner_id,
            EvidenceEvent.checkpoint_id == schedule.checkpoint_id,
            EvidenceEvent.event_type.in_((
                "concept_attempt_evaluated", "exercise_attempt_evaluated",
                "remediation_retry_evaluated", "remediation_variant_evaluated",
                "remediation_completed", "review_attempt_evaluated",
                "review_reflection_recorded",
            )),
        )
        .order_by(EvidenceEvent.occurred_at.desc(), EvidenceEvent.id.desc())
        .limit(500)
    )).scalars().all())
    result = []
    for event in candidates:
        payload = dict(event.payload or {})
        same_schedule = int(payload.get("review_schedule_id") or 0) == schedule.id
        same_attempt = payload.get("attempt_id") in attempt_ids
        same_item = (
            payload.get("item_id") == schedule.item_id
            and str(payload.get("source_item_type") or payload.get("item_type") or schedule.item_type)
            == schedule.item_type
            and event.checkpoint_id == schedule.checkpoint_id
        )
        if event.id in case_event_ids or same_schedule or same_attempt or same_item:
            result.append(event)
    return result


async def _question_state(
    db: AsyncSession,
    schedule: ReviewSchedule,
    *,
    include_presentation: bool = True,
) -> dict[str, Any]:
    attempts = await _all_attempts(db, schedule)
    latest = attempts[0] if attempts else None
    cases = list((await db.execute(
        select(RemediationCase)
        .where(
            RemediationCase.learner_id == schedule.learner_id,
            RemediationCase.item_type == schedule.item_type,
            RemediationCase.item_id == schedule.item_id,
        )
        .order_by(RemediationCase.updated_at.desc(), RemediationCase.id.desc())
    )).scalars().all())
    open_case = next((case for case in cases if case.status != "completed"), None)
    completed_case = next((case for case in cases if case.status == "completed"), None)
    wrong_count = sum(1 for attempt in attempts if not _attempt_passed(attempt))
    evidence_attempts = await _with_case_attempts(
        db, learner_id=schedule.learner_id, attempts=attempts, cases=cases,
    )
    events = await _review_events(db, schedule, evidence_attempts, cases)

    if not latest:
        attempt_state = "unseen"
    elif _attempt_passed(latest):
        attempt_state = (
            "correct_independent" if latest.assistance_level == "none"
            else "correct_with_support"
        )
    elif latest.status == "abstained":
        attempt_state = "unknown"
    else:
        attempt_state = "incorrect"

    if open_case:
        remediation_state = open_case.status
    elif completed_case:
        remediation_state = "completed"
    else:
        remediation_state = "none"

    item_key = f"{schedule.item_type}:{schedule.item_id}"
    kernels = list((await db.execute(select(KernelState).where(
        KernelState.learner_id == schedule.learner_id,
        KernelState.kernel_name.in_(("knowledge", "practice")),
    ))).scalars().all())
    kernel_map = {row.kernel_name: row for row in kernels}
    retention = dict(
        ((kernel_map.get("knowledge").short_term if kernel_map.get("knowledge") else {}) or {})
        .get("retention_status") or {}
    ).get(item_key, {})
    practice_review = dict(
        ((kernel_map.get("practice").short_term if kernel_map.get("practice") else {}) or {})
        .get("review_history") or {}
    ).get(item_key, {})

    bucket = schedule_bucket(schedule)
    if retention.get("status") == "spaced_stable":
        evidence_state = "spaced_stable"
    elif completed_case:
        evidence_state = "transfer_verified"
    elif latest and _attempt_passed(latest):
        evidence_state = (
            "verified_once" if latest.assistance_level == "none" else "assisted_success"
        )
    else:
        evidence_state = "none"

    latest_failed = bool(latest and not _attempt_passed(latest))
    if wrong_count == 0:
        wrong_state = "none"
    elif open_case and latest_failed and completed_case:
        wrong_state = "relapsed"
    elif open_case and wrong_count >= 2:
        wrong_state = "repeated_error"
    elif open_case:
        wrong_state = "first_error"
    elif bucket in {"due", "overdue", "wrong"}:
        wrong_state = "corrected_due_review"
    else:
        wrong_state = "corrected"

    project = await db.get(Project, schedule.project_id) if schedule.project_id else None
    checkpoint = await db.get(Checkpoint, schedule.checkpoint_id)
    learning_task = (await db.execute(select(LearningTask).where(
        LearningTask.learner_id == schedule.learner_id,
        LearningTask.checkpoint_id == schedule.checkpoint_id,
    ).limit(1))).scalar_one_or_none()
    if schedule.item_type == "concept":
        source = await db.get(ConceptQuestion, schedule.item_id)
        title = (source.question if source else "概念题")[:180]
        difficulty = source.difficulty if source else ""
        source_href = (
            f"/projects/{schedule.project_id}/checkpoints/{schedule.checkpoint_id}/exercises"
        )
    else:
        source = await db.get(Exercise, schedule.item_id)
        title = source.title if source else "代码题"
        difficulty = ""
        source_href = (
            f"/projects/{schedule.project_id}/checkpoints/{schedule.checkpoint_id}"
            f"/exercises?exercise={schedule.item_id}"
        )

    result = {
        **serialize_schedule(schedule),
        "title": title,
        "difficulty": difficulty,
        "project_name": project.name if project else "",
        "checkpoint_title": checkpoint.title if checkpoint else "",
        "source_href": source_href,
        "attempt_state": attempt_state,
        "remediation_state": remediation_state,
        "evidence_state": evidence_state,
        "wrong_state": wrong_state,
        "wrong_count": wrong_count,
        "reason_codes": [
            value for value in (
                "open_remediation" if open_case else "",
                "repeated_error" if wrong_count >= 2 else "",
                "assisted_success" if attempt_state == "correct_with_support" else "",
                f"schedule_{bucket}",
            ) if value
        ],
        "kernel_projection": {
            "knowledge": retention,
            "practice": practice_review,
        },
        "proficiency": build_concept_proficiency(schedule, evidence_attempts, events),
        "memory_notes": build_review_memory_notes(schedule, attempts, cases, events),
        "learning_task": ({
            "id": learning_task.id,
            "title": learning_task.title,
            "status": learning_task.status,
            "current_phase_id": learning_task.current_phase_id,
            "review_handoff": dict(learning_task.review_handoff or {}),
        } if learning_task else None),
        "remediation": serialize_case(open_case) if open_case else None,
    }
    if include_presentation:
        presentation = await review_presentation(db, schedule)
        result["presentation"] = {
            "question_form": presentation["question_form"],
            "version": presentation["version"],
            "payload": presentation["public"],
        }
    return result


async def _owned_schedule_or_404(
    db: AsyncSession, learner_id: int, schedule_id: int,
) -> ReviewSchedule:
    schedule = await load_owned_schedule(db, learner_id, schedule_id)
    if not schedule:
        raise HTTPException(404, "Review item not found")
    return schedule


def _check_version(schedule: ReviewSchedule, expected: int):
    if int(schedule.version or 1) != expected:
        raise HTTPException(409, "复习状态已更新，请刷新后重试")


@router.get("/summary")
async def review_summary(
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    item_type: str | None = None,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    query = select(ReviewSchedule).where(
        ReviewSchedule.learner_id == current.learner.id,
    )
    if project_id is not None:
        query = query.where(ReviewSchedule.project_id == project_id)
    if checkpoint_id is not None:
        query = query.where(ReviewSchedule.checkpoint_id == checkpoint_id)
    if item_type in {"concept", "exercise"}:
        query = query.where(ReviewSchedule.item_type == item_type)
    rows = list((await db.execute(query)).scalars().all())
    buckets = [schedule_bucket(row) for row in rows]
    return {
        "total": len(rows),
        "due": sum(value in {"due", "overdue", "wrong"} for value in buckets),
        "overdue": buckets.count("overdue"),
        "wrong": sum(int(row.lapse_count or 0) > 0 for row in rows),
        "remediation": buckets.count("wrong"),
        "upcoming": buckets.count("upcoming"),
        "stable": buckets.count("stable"),
        "suspended": buckets.count("suspended"),
        "policy_version": "review-policy-v1",
        "proficiency_policy_version": PROFICIENCY_POLICY_VERSION,
        "interval_days": [1, 3, 7, 14, 30, 60],
    }


@router.get("/items")
async def list_review_items(
    bucket: str = Query(default="due"),
    project_id: int | None = None,
    checkpoint_id: int | None = None,
    item_type: str | None = None,
    subject: str | None = None,
    remediation_status: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    query = select(ReviewSchedule).where(
        ReviewSchedule.learner_id == current.learner.id,
    )
    if project_id is not None:
        query = query.where(ReviewSchedule.project_id == project_id)
    if checkpoint_id is not None:
        query = query.where(ReviewSchedule.checkpoint_id == checkpoint_id)
    if item_type in {"concept", "exercise"}:
        query = query.where(ReviewSchedule.item_type == item_type)
    if subject:
        query = query.where(ReviewSchedule.subject_key.contains(subject[:120]))
    rows = list((await db.execute(query)).scalars().all())

    def included(row: ReviewSchedule) -> bool:
        actual = schedule_bucket(row)
        if bucket == "all":
            return True
        if bucket == "due":
            return actual in {"due", "overdue", "wrong"}
        if bucket == "wrong":
            return int(row.lapse_count or 0) > 0
        return actual == bucket

    rows = [row for row in rows if included(row)]
    items = []
    for row in rows:
        try:
            item = await _question_state(db, row)
        except ValueError:
            # Historical schedules can outlive a deleted source item. They
            # remain auditable projections but are not runnable queue items.
            continue
        if remediation_status and item["remediation_state"] != remediation_status:
            continue
        items.append(item)

    def queue_priority(item: dict[str, Any]) -> tuple:
        if item["phase"] == REMEDIATION_PHASE:
            rank = 0
        elif item["bucket"] == "overdue" and int(item["lapse_count"] or 0) > 0:
            rank = 1
        elif item["attempt_state"] == "correct_with_support":
            rank = 2
        elif item["bucket"] in {"overdue", "due"}:
            rank = 3
        else:
            rank = {"upcoming": 4, "stable": 5, "suspended": 6}.get(item["bucket"], 9)
        return (
            rank,
            datetime.fromisoformat(item["due_at"]),
            -int(item["lapse_count"] or 0),
            int(item["id"]),
        )

    items.sort(key=queue_priority)
    return {"items": items[:limit], "total": len(items), "bucket": bucket}


@router.get("/agent-context")
async def review_agent_context(
    query: str = Query(default="", max_length=300),
    limit: int = Query(default=8, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    """Answer-free, bounded review observation for the Tutor ACI."""
    rows = list((await db.execute(select(ReviewSchedule).where(
        ReviewSchedule.learner_id == current.learner.id,
    ))).scalars().all())
    normalized = "".join(query.casefold().split())
    if normalized:
        matched = [row for row in rows if normalized in "".join((row.subject_key or "").casefold().split())]
        if matched:
            rows = matched
    rows.sort(key=lambda row: (
        0 if schedule_bucket(row) in {"wrong", "overdue", "due"} else 1,
        row.due_at,
        -int(row.lapse_count or 0),
        -int(row.id),
    ))
    items = []
    for row in rows:
        try:
            items.append(await _question_state(db, row, include_presentation=False))
        except ValueError:
            continue
        if len(items) >= limit:
            break
    bucket_values = [item["bucket"] for item in items]
    return {
        "authority": "answer_free_review_evidence_projection",
        "query": query,
        "summary": {
            "visible": len(items),
            "due": sum(value in {"due", "overdue", "wrong"} for value in bucket_values),
            "stable": bucket_values.count("stable"),
        },
        "items": [{
            "schedule_id": item["id"],
            "subject_key": item["subject_key"],
            "title": item["title"],
            "bucket": item["bucket"],
            "due_at": item["due_at"],
            "proficiency": item["proficiency"],
            "memory_notes": item["memory_notes"][:8],
            "learning_task": item["learning_task"],
            "kernel_projection": item["kernel_projection"],
            "reason_codes": item["reason_codes"],
        } for item in items],
        "boundaries": [
            "不包含答案、solution 或测试用例",
            "熟练度是由已判分证据重建的复习决策读模型，不是第二套掌握权威",
            "学习任务完成不会直接提高熟练度，只有已判分 Attempt 与已登记事件参与计算",
            "学习者反思按自述保存且可纠正，不会自动升级掌握",
        ],
        "policy_versions": {
            "review": "review-policy-v1",
            "proficiency": PROFICIENCY_POLICY_VERSION,
        },
    }


@router.get("/items/{schedule_id}")
async def get_review_item(
    schedule_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    return await _question_state(db, schedule)


@router.get("/items/{schedule_id}/history")
async def get_review_history(
    schedule_id: int,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    attempts = await _all_attempts(db, schedule)
    cases = list((await db.execute(
        select(RemediationCase)
        .where(
            RemediationCase.learner_id == current.learner.id,
            RemediationCase.item_type == schedule.item_type,
            RemediationCase.item_id == schedule.item_id,
        )
        .order_by(RemediationCase.created_at.desc())
    )).scalars().all())
    attempts = await _with_case_attempts(
        db, learner_id=current.learner.id, attempts=attempts, cases=cases,
    )
    events = await _review_events(db, schedule, attempts, cases)
    return {
        "schedule": serialize_schedule(schedule),
        "proficiency": build_concept_proficiency(schedule, attempts, events),
        "memory_notes": build_review_memory_notes(schedule, attempts, cases, events),
        "attempts": [{
            "id": item.id,
            "status": item.status,
            "attempt_role": item.attempt_role,
            "assistance_level": item.assistance_level,
            "passed": _attempt_passed(item),
            "result": _safe_result(item.result),
            "evaluated_at": item.evaluated_at.isoformat() if item.evaluated_at else None,
        } for item in attempts],
        "remediation_cases": [serialize_case(case) for case in cases],
        "events": [{
            "id": item.id,
            "event_type": item.event_type,
            "evidence_role": (item.provenance or {}).get("evidence_role"),
            "occurred_at": item.occurred_at.isoformat() if item.occurred_at else None,
        } for item in events],
    }


@router.post("/items/{schedule_id}/reflections")
async def record_review_reflection(
    schedule_id: int,
    request: ReviewReflectionRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    state = await _question_state(db, schedule, include_presentation=False)
    concept_fields = _concept_evidence_fields(
        schedule, fallback_name=str(state.get("title") or ""),
    )
    event = await record_event(
        db,
        learner_id=current.learner.id,
        project_id=schedule.project_id,
        checkpoint_id=schedule.checkpoint_id,
        event_type="review_reflection_recorded",
        source="user",
        payload={
            "review_schedule_id": schedule.id,
            "source_item_type": schedule.item_type,
            "item_id": schedule.item_id,
            **concept_fields,
            "reflection_kind": request.reflection_kind,
            "observation_type": request.reflection_kind,
            "statement": " ".join(request.text.split()),
            "text": " ".join(request.text.split()),
            "source_tag": "user_self_input",
            "verification": "unverified",
            "mastery_inference": False,
            "correctable": True,
        },
        confidence=1.0,
        provenance={
            "self_report": True,
            "learner_visible": True,
            "mastery_inference": False,
        },
        client_event_id=request.client_event_id,
        actor_type="learner",
    )
    await db.commit()
    return {"event_id": event.id, "item": await _question_state(db, schedule)}


def _normalize_text(value: str) -> str:
    return " ".join(str(value or "").split()).casefold()


async def _grade_code(exercise: Exercise, code: str, files: list[dict]) -> dict[str, Any]:
    if (exercise.files or []) and exercise.judge_mode == "stdout_check":
        from app.services.project_runner import check_stdout, run_project
        client = {item.get("name"): item for item in files if item.get("name")}
        merged = []
        for original in list(exercise.files or []):
            name = original.get("name", "")
            if name in client and not original.get("read_only"):
                merged.append({**original, "content": client[name].get("content", original.get("content", ""))})
            else:
                merged.append(original)
        result = run_project(
            exercise.id, merged, exercise.entrypoint or "main.py", exercise.requirements or [],
        )
        if result["exit_code"] != 0 and not result["timed_out"]:
            return {"passed": 0, "total": 1, "results": [{
                "passed": False,
                "expected": "正常运行",
                "actual": f"退出码 {result['exit_code']}",
                "stderr": result["stderr"][:200],
            }]}
        checked = check_stdout(result["stdout"], exercise.judge_config or {})
        return {
            "passed": 1 if checked["passed"] else 0,
            "total": 1,
            "results": [{
                "passed": checked["passed"],
                "expected": checked["expected"],
                "actual": checked["actual"],
                "detail": checked["detail"],
            }],
            "stdout": result["stdout"][-1000:],
        }
    test_cases = exercise.test_cases or []
    if not test_cases:
        return {"passed": 0, "total": 0, "results": [], "error": "该题没有测试用例"}
    seeded_demo_result = grade_seeded_demo_code(exercise, code)
    if seeded_demo_result is not None:
        return seeded_demo_result
    from app.services.exercise_agent import ExerciseAgent
    results = ExerciseAgent.verify_exercise(code, test_cases)
    return {
        "passed": sum(1 for item in results if item["passed"]),
        "total": len(results),
        "results": results,
    }


@router.post("/items/{schedule_id}/submit")
async def submit_review_item(
    schedule_id: int,
    request: ReviewSubmitRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    submission_key = review_submission_key(
        current.learner.id, schedule.id, request.client_submission_id,
    )
    replay = (await db.execute(select(LearningAttempt).where(
        LearningAttempt.learner_id == current.learner.id,
        LearningAttempt.client_submission_id == submission_key,
    ))).scalar_one_or_none()
    if replay:
        return {**dict(replay.result or {}), "attempt_id": replay.id, "idempotent_replay": True}
    skip_event_key = f"{current.learner.id}:{submission_key}:skipped"
    skip_replay = (await db.execute(select(EvidenceEvent).where(
        EvidenceEvent.learner_id == current.learner.id,
        EvidenceEvent.client_event_id == skip_event_key,
    ))).scalar_one_or_none()
    if skip_replay:
        return {
            "outcome": "skipped",
            "item": await _question_state(db, schedule),
            "idempotent_replay": True,
        }
    _check_version(schedule, request.expected_version)
    presentation = await review_presentation(db, schedule)
    if presentation["version"] != request.presentation_version:
        raise HTTPException(409, "复习题面已更新，请刷新后重试")

    if request.response_status == "skipped":
        await record_event(
            db,
            learner_id=current.learner.id,
            project_id=schedule.project_id,
            checkpoint_id=schedule.checkpoint_id,
            event_type="review_item_skipped",
            source="review",
            payload={"review_schedule_id": schedule.id, "item_id": schedule.item_id},
            client_event_id=f"{submission_key}:skipped",
        )
        await db.commit()
        return {"outcome": "skipped", "item": await _question_state(db, schedule)}

    open_case = await _open_remediation(db, schedule)
    if open_case and open_case.status == "variant_ready":
        if request.response_status == "answered":
            variant_type = str((open_case.variant_payload or {}).get("type") or "")
            if variant_type == "concept_choice" and not request.answer_indexes:
                raise HTTPException(422, "未提交答案；如暂时不会，请使用‘不会’")
            if variant_type != "concept_choice" and not request.answer_text.strip():
                raise HTTPException(422, "未提交答案；如暂时不会，请使用‘不会’")
        remediation, public_result = await submit_variant(
            db,
            remediation=open_case,
            submission={
                "answer_indexes": request.answer_indexes,
                "answer_text": request.answer_text,
                "response_status": request.response_status,
            },
            client_submission_id=submission_key,
        )
        outcome = (
            "unknown" if request.response_status == "unknown"
            else "correct" if public_result.get("correct") else "incorrect"
        )
        response = {
            "outcome": outcome,
            "passed": bool(public_result.get("correct")),
            "attempt_id": remediation.variant_attempt_id,
            "result": public_result,
            "remediation": serialize_case(remediation),
            "submission_contract": "remediation_variant",
            "item": await _question_state(db, schedule),
        }
        attempt = await db.get(LearningAttempt, remediation.variant_attempt_id)
        if attempt:
            attempt.result = _safe_result(response)
        await db.commit()
        return response

    private = dict(presentation["private"])
    unknown = request.response_status == "unknown"
    if request.response_status == "answered":
        if private["type"] == "concept_choice" and not request.answer_indexes:
            raise HTTPException(422, "未提交答案；如暂时不会，请使用‘不会’")
        if private["type"] == "predict_output" and not request.answer_text.strip():
            raise HTTPException(422, "未提交答案；如暂时不会，请使用‘不会’")
        if private["type"] == "code" and not request.code.strip() and not request.files:
            raise HTTPException(422, "未提交代码；如暂时不会，请使用‘不会’")
    submission: dict[str, Any]
    if private["type"] == "concept_choice":
        expected = sorted(int(value) for value in private.get("answer_indexes") or [])
        actual = sorted(int(value) for value in request.answer_indexes)
        passed = not unknown and bool(actual) and actual == expected
        submission = {"answer_indexes": actual, "response_status": request.response_status}
        stored_result = {
            "correct": passed,
            "answer_indexes": expected,
            "user_answer_indexes": actual,
        }
    elif private["type"] == "predict_output":
        expected_text = str(private.get("expected") or "")
        actual_text = request.answer_text
        passed = not unknown and bool(actual_text.strip()) and _normalize_text(actual_text) == _normalize_text(expected_text)
        submission = {"answer_text": actual_text[:1000], "response_status": request.response_status}
        stored_result = {
            "passed": 1 if passed else 0,
            "total": 1,
            "results": [{
                "passed": passed,
                "expected": expected_text,
                "actual": actual_text[:1000],
            }],
        }
    else:
        exercise = await db.get(Exercise, schedule.item_id)
        if not exercise:
            raise HTTPException(404, "Exercise not found")
        submission = {
            "code": request.code[:65536],
            "files": [{"name": item.get("name", ""), "content": str(item.get("content", ""))[:65536]} for item in request.files],
            "response_status": request.response_status,
        }
        stored_result = (
            {"passed": 0, "total": 0, "results": [], "outcome": "unknown"}
            if unknown else await _grade_code(exercise, request.code, request.files)
        )
        total = int(stored_result.get("total") or 0)
        passed = total > 0 and int(stored_result.get("passed") or 0) == total

    outcome = "unknown" if unknown else "correct" if passed else "incorrect"
    remediation_retry = bool(open_case and open_case.status == "explaining")
    attempt = await create_attempt(
        db,
        learner_id=current.learner.id,
        checkpoint_id=schedule.checkpoint_id,
        item_type=schedule.item_type,
        item_id=schedule.item_id,
        submission=submission,
        result=stored_result,
        assistance_level=request.assistance_level,
        attempt_role="review",
        status="abstained" if unknown else "evaluated",
        client_submission_id=submission_key,
    )
    learning_task_id = (await db.execute(select(LearningTask.id).where(
        LearningTask.learner_id == current.learner.id,
        LearningTask.checkpoint_id == schedule.checkpoint_id,
    ))).scalar_one_or_none()
    event = await record_event(
        db,
        learner_id=current.learner.id,
        project_id=schedule.project_id,
        checkpoint_id=schedule.checkpoint_id,
        event_type="review_attempt_evaluated",
        source="review",
        payload={
            "review_schedule_id": schedule.id,
            "attempt_id": attempt.id,
            "learning_task_id": learning_task_id,
            "source_item_type": schedule.item_type,
            "item_id": schedule.item_id,
            **_concept_evidence_fields(
                schedule, fallback_name=str(private.get("prompt") or ""),
            ),
            "prompt": private.get("prompt", ""),
            "observation_type": (
                "variant_task" if presentation["question_form"] == "validated_variant"
                else "recall" if passed else "error"
            ),
            "statement": (
                "独立完成了迁移变式" if passed and presentation["question_form"] == "validated_variant"
                else "完成了一次主动检索" if passed
                else "主动检索中表示暂时不会" if unknown
                else "主动检索暴露了待纠正错误"
            ),
            "outcome": outcome,
            "passed": passed,
            "independent": request.assistance_level == "none",
            "stability_eligible": not remediation_retry,
            "assistance_level": request.assistance_level,
            "question_form": presentation["question_form"],
            "presentation_version": presentation["version"],
        },
        confidence=0.8 if unknown else 1.0,
        provenance={
            "grader": str(stored_result.get("grader_id") or "deterministic_review_contract"),
            "execution_performed": stored_result.get("execution_performed"),
            "policy_version": "review-policy-v1",
        },
        client_event_id=f"review-attempt:{attempt.id}:evaluated",
    )

    remediation_payload = None
    if open_case and open_case.status == "explaining" and not unknown:
        open_case = await apply_retry_result(
            db,
            remediation=open_case,
            attempt=attempt,
            passed=passed,
            evidence_event_id=event.id,
        )
        remediation_payload = serialize_case(open_case)
    elif open_case and unknown:
        attempt.remediation_case_id = open_case.id
        remediation_payload = serialize_case(open_case)
    elif not passed:
        if schedule.item_type == "concept":
            source = await db.get(ConceptQuestion, schedule.item_id)
            remediation = await create_remediation_case(
                db,
                attempt=attempt,
                evidence_event_id=event.id,
                item_snapshot={
                    "question": private.get("prompt", ""),
                    "options": private.get("options", []),
                    "explanation": getattr(source, "explanation", "") or "",
                    "source_chunk_ids": getattr(source, "source_chunk_ids", None) or [],
                    "assessment_meta": getattr(source, "assessment_meta", None) or {},
                },
                evaluation={
                    "answer_indexes": private.get("answer_indexes", []),
                    "user_answer_indexes": request.answer_indexes if not unknown else [],
                },
            )
        else:
            source = await db.get(Exercise, schedule.item_id)
            remediation = await create_remediation_case(
                db,
                attempt=attempt,
                evidence_event_id=event.id,
                item_snapshot={
                    "title": getattr(source, "title", "复习实践题"),
                    "description": private.get("prompt") or getattr(source, "description", ""),
                    "hints": getattr(source, "hints", None) or [],
                    "judge_mode": getattr(source, "judge_mode", "test_cases"),
                    "assessment_meta": getattr(source, "assessment_meta", None) or {},
                },
                evaluation=stored_result,
            )
        remediation_payload = serialize_case(remediation)

    await apply_assessment_result(
        db,
        attempt=attempt,
        passed=passed,
        event_id=event.id,
        question_form=presentation["question_form"],
        remediation_status=(remediation_payload or {}).get("status"),
        is_review=True,
    )
    response = {
        "outcome": outcome,
        "passed": passed,
        "attempt_id": attempt.id,
        "result": _safe_result(stored_result),
        "remediation": remediation_payload,
        "item": await _question_state(db, schedule),
    }
    attempt.result = _safe_result(response)
    await db.commit()
    return response


async def _action_replay(
    db: AsyncSession, learner_id: int, event_key: str,
) -> EvidenceEvent | None:
    return (await db.execute(select(EvidenceEvent).where(
        EvidenceEvent.learner_id == learner_id,
        EvidenceEvent.client_event_id.in_((event_key, f"{learner_id}:{event_key}")),
    ))).scalar_one_or_none()


async def _record_action(
    db: AsyncSession,
    schedule: ReviewSchedule,
    *,
    event_type: str,
    client_event_id: str,
    payload: dict[str, Any],
):
    await record_event(
        db,
        learner_id=schedule.learner_id,
        project_id=schedule.project_id,
        checkpoint_id=schedule.checkpoint_id,
        event_type=event_type,
        source="review",
        payload={"review_schedule_id": schedule.id, **payload},
        client_event_id=client_event_id,
    )


@router.post("/items/{schedule_id}/defer")
async def defer_review_item(
    schedule_id: int,
    request: ReviewActionRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    event_key = f"review:{schedule.id}:defer:{request.client_event_id}"
    if await _action_replay(db, current.learner.id, event_key):
        return {"item": await _question_state(db, schedule), "idempotent_replay": True}
    _check_version(schedule, request.expected_version)
    if schedule.phase == REMEDIATION_PHASE:
        raise HTTPException(409, "待纠错题不能延期，可暂停后稍后恢复")
    if schedule.phase == SUSPENDED_PHASE:
        raise HTTPException(409, "题目已暂停")
    if int(schedule.defer_count or 0) >= 1:
        raise HTTPException(409, "本轮已经延期过一次")
    schedule.due_at = datetime.utcnow() + timedelta(days=1)
    schedule.defer_count = int(schedule.defer_count or 0) + 1
    schedule.version = int(schedule.version or 0) + 1
    schedule.updated_at = datetime.utcnow()
    await _record_action(
        db, schedule, event_type="review_item_deferred", client_event_id=event_key,
        payload={"due_at": schedule.due_at.isoformat()},
    )
    await db.commit()
    return {"item": await _question_state(db, schedule)}


@router.post("/items/{schedule_id}/suspend")
async def suspend_review_item(
    schedule_id: int,
    request: ReviewActionRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    event_key = f"review:{schedule.id}:suspend:{request.client_event_id}"
    if await _action_replay(db, current.learner.id, event_key):
        return {"item": await _question_state(db, schedule), "idempotent_replay": True}
    _check_version(schedule, request.expected_version)
    if schedule.phase != SUSPENDED_PHASE:
        schedule.phase = SUSPENDED_PHASE
        schedule.suspended_at = datetime.utcnow()
        schedule.version = int(schedule.version or 0) + 1
        schedule.updated_at = datetime.utcnow()
    await _record_action(
        db, schedule, event_type="review_item_suspended", client_event_id=event_key,
        payload={"suspended_at": schedule.suspended_at.isoformat()},
    )
    await db.commit()
    return {"item": await _question_state(db, schedule)}


@router.post("/items/{schedule_id}/resume")
async def resume_review_item(
    schedule_id: int,
    request: ReviewActionRequest,
    db: AsyncSession = Depends(get_db),
    current: CurrentLearner = Depends(get_current_learner),
):
    schedule = await _owned_schedule_or_404(db, current.learner.id, schedule_id)
    event_key = f"review:{schedule.id}:resume:{request.client_event_id}"
    if await _action_replay(db, current.learner.id, event_key):
        return {"item": await _question_state(db, schedule), "idempotent_replay": True}
    _check_version(schedule, request.expected_version)
    open_case = await _open_remediation(db, schedule)
    schedule.phase = REMEDIATION_PHASE if open_case else ACTIVE_PHASE
    schedule.suspended_at = None
    schedule.due_at = datetime.utcnow()
    schedule.version = int(schedule.version or 0) + 1
    schedule.updated_at = datetime.utcnow()
    await _record_action(
        db, schedule, event_type="review_item_resumed", client_event_id=event_key,
        payload={"phase": schedule.phase},
    )
    await db.commit()
    return {"item": await _question_state(db, schedule)}
