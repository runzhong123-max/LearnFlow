"""Answer-safe views and lifecycle operations for managed learning files."""

from __future__ import annotations

from collections import defaultdict
import hashlib

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import LearningTask
from app.models.project import Checkpoint, ConceptQuestion, Exercise, Lecture, Project, Roadmap
from app.services.auth import CurrentLearner, get_current_learner, require_owned_checkpoint, require_owned_exercise, require_owned_source
from app.services.learning_runtime import record_event
from app.services.learning_tasks import learning_task_view, materialize_learning_task
from app.services.dynamic_practice import (
    create_practice_set,
    validate_practice_candidate,
)
from app.services.assessment_design import (
    create_assessment_blueprint,
    validate_candidates_against_blueprint,
)


router = APIRouter(prefix="/learning-files", tags=["learning-files"])


async def _owned_lecture(db: AsyncSession, learner_id: int, lecture_id: int) -> tuple[Lecture, Checkpoint, Project]:
    row = (await db.execute(
        select(Lecture, Checkpoint, Project)
        .join(Checkpoint, Checkpoint.id == Lecture.checkpoint_id)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(
            Lecture.id == lecture_id,
            Project.learner_id == learner_id,
            Project.visibility != "deleted",
        )
    )).first()
    if not row:
        raise HTTPException(404, "讲义不存在")
    return row[0], row[1], row[2]


def _lecture_ref(lecture: Lecture, checkpoint: Checkpoint, project: Project) -> dict:
    return {
        "kind": "lecture",
        "ref": str(lecture.id),
        "id": lecture.id,
        "title": checkpoint.title,
        "logical_filename": f"{str(checkpoint.order).zfill(2)}-{checkpoint.title}.lflecture",
        "project_id": project.id,
        "checkpoint_id": checkpoint.id,
        "version": int(lecture.version or 1),
        "status": lecture.status,
        "updated_at": lecture.updated_at.isoformat() if lecture.updated_at else None,
        "path": f"/files/lecture/{lecture.id}",
    }


def _exercise_ref(exercise: Exercise, checkpoint: Checkpoint, project: Project) -> dict:
    return {
        "kind": "practice",
        "practice_kind": "exercise",
        "ref": f"exercise-{exercise.id}",
        "id": exercise.id,
        "title": exercise.title,
        "logical_filename": f"{str(checkpoint.order).zfill(2)}-{checkpoint.title}-{str(exercise.order).zfill(2)}.lfexercise",
        "project_id": project.id,
        "checkpoint_id": checkpoint.id,
        "path": f"/files/practice/exercise-{exercise.id}",
    }


def _practice_set_ref(items: list[ConceptQuestion], checkpoint: Checkpoint, project: Project) -> dict:
    meta = dict(items[0].assessment_meta or {})
    practice_set_id = str(meta.get("practice_set_id") or "")
    title = str(meta.get("practice_title") or f"{checkpoint.title} · 动态练习")
    return {
        "kind": "practice",
        "practice_kind": "dynamic_question_set",
        "ref": f"practice-set-{practice_set_id}",
        "ids": [item.id for item in items],
        "title": title,
        "logical_filename": f"{checkpoint.title}-{title}.lfexercise",
        "project_id": project.id,
        "checkpoint_id": checkpoint.id,
        "assessment_blueprint_id": meta.get("assessment_blueprint_id"),
        "rubric_id": meta.get("rubric_id"),
        "question_count": len(items),
        "quality_status": "validated_static_uncalibrated",
        "path": f"/files/practice/practice-set-{practice_set_id}",
    }


@router.get("")
async def list_learning_files(
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    base = (
        select(Checkpoint, Project)
        .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
        .join(Project, Project.id == Roadmap.project_id)
        .where(Project.learner_id == current.learner.id, Project.visibility != "deleted")
    )
    checkpoint_rows = (await db.execute(base)).all()
    checkpoint_map = {checkpoint.id: (checkpoint, project) for checkpoint, project in checkpoint_rows}
    checkpoint_ids = list(checkpoint_map)
    if not checkpoint_ids:
        return {"lectures": [], "practices": [], "boundary": "生成或打开文件不等于掌握。"}
    lectures = list((await db.execute(select(Lecture).where(
        Lecture.checkpoint_id.in_(checkpoint_ids),
    ).order_by(Lecture.updated_at.desc()))).scalars().all())
    exercises = list((await db.execute(select(Exercise).where(
        Exercise.checkpoint_id.in_(checkpoint_ids),
    ).order_by(Exercise.checkpoint_id, Exercise.order))).scalars().all())
    questions = list((await db.execute(select(ConceptQuestion).where(
        ConceptQuestion.checkpoint_id.in_(checkpoint_ids),
    ).order_by(ConceptQuestion.checkpoint_id, ConceptQuestion.order))).scalars().all())
    question_groups: dict[int, list[ConceptQuestion]] = defaultdict(list)
    dynamic_groups: dict[tuple[int, str], list[ConceptQuestion]] = defaultdict(list)
    for question in questions:
        practice_set_id = str((question.assessment_meta or {}).get("practice_set_id") or "")
        if practice_set_id:
            dynamic_groups[(question.checkpoint_id, practice_set_id)].append(question)
        else:
            question_groups[question.checkpoint_id].append(question)
    practice_refs = [
        _exercise_ref(exercise, *checkpoint_map[exercise.checkpoint_id])
        for exercise in exercises
    ]
    for checkpoint_id, items in question_groups.items():
        checkpoint, project = checkpoint_map[checkpoint_id]
        practice_refs.append({
            "kind": "practice",
            "practice_kind": "concept_question_set",
            "ref": f"questions-{checkpoint_id}",
            "ids": [item.id for item in items],
            "title": f"{checkpoint.title} · 概念验证",
            "logical_filename": f"{str(checkpoint.order).zfill(2)}-{checkpoint.title}-概念验证.lfexercise",
            "project_id": project.id,
            "checkpoint_id": checkpoint.id,
            "question_count": len(items),
            "path": f"/files/practice/questions-{checkpoint_id}",
        })
    for (checkpoint_id, _practice_set_id), items in dynamic_groups.items():
        practice_refs.append(_practice_set_ref(items, *checkpoint_map[checkpoint_id]))
    return {
        "lectures": [_lecture_ref(item, *checkpoint_map[item.checkpoint_id]) for item in lectures],
        "practices": practice_refs,
        "boundary": "讲义阅读是接触证据；只有正式提交和确定性判题才产生 Knowledge/Practice 证据。",
    }


@router.get("/lecture/{lecture_id}")
async def get_lecture_file(
    lecture_id: int,
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    lecture, checkpoint, project = await _owned_lecture(db, current.learner.id, lecture_id)
    return {
        **_lecture_ref(lecture, checkpoint, project),
        "sections": list(lecture.sections or []),
        "concept_graph": dict(lecture.concept_graph or {}),
        "provenance": {
            "project_id": project.id,
            "checkpoint_id": checkpoint.id,
            "artifact_type": "Lecture",
            "artifact_id": lecture.id,
            "artifact_version": int(lecture.version or 1),
        },
        "mastery_inference": False,
    }


@router.get("/practice/{practice_ref}")
async def get_practice_file(
    practice_ref: str,
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    if practice_ref.startswith("exercise-"):
        try:
            exercise_id = int(practice_ref.removeprefix("exercise-"))
        except ValueError as error:
            raise HTTPException(400, "练习引用无效") from error
        exercise = await require_owned_exercise(db, current.learner.id, exercise_id)
        checkpoint = await require_owned_checkpoint(db, current.learner.id, exercise.checkpoint_id)
        roadmap = await db.get(Roadmap, checkpoint.roadmap_id)
        project = await db.get(Project, roadmap.project_id) if roadmap else None
        if not project:
            raise HTTPException(404, "练习所属项目不存在")
        safe_tests = [
            {key: value for key, value in item.items() if key not in {"expected", "expected_output", "answer", "solution"}}
            for item in (exercise.test_cases or []) if isinstance(item, dict)
        ]
        private_file_keys = {"solution", "answer", "expected", "expected_output", "reference_output", "hidden_tests"}
        return {
            **_exercise_ref(exercise, checkpoint, project),
            "description": exercise.description or "",
            "starter_code": exercise.starter_code or "",
            "files": [
                {key: value for key, value in item.items() if key not in private_file_keys}
                for item in (exercise.files or []) if isinstance(item, dict)
            ],
            "entrypoint": exercise.entrypoint or "",
            "requirements": list(exercise.requirements or []),
            "hints": list(exercise.hints or []),
            "public_test_spec": safe_tests,
            "provenance": {"artifact_type": "Exercise", "artifact_id": exercise.id},
            "answers_hidden": True,
            "mastery_inference": False,
        }
    if practice_ref.startswith("questions-") or practice_ref.startswith("practice-set-"):
        dynamic_set_id = practice_ref.removeprefix("practice-set-") if practice_ref.startswith("practice-set-") else ""
        try:
            checkpoint_id = int(practice_ref.removeprefix("questions-")) if not dynamic_set_id else 0
        except ValueError as error:
            raise HTTPException(400, "练习引用无效") from error
        if dynamic_set_id:
            owned_rows = (await db.execute(
                select(ConceptQuestion, Checkpoint, Roadmap, Project)
                .join(Checkpoint, Checkpoint.id == ConceptQuestion.checkpoint_id)
                .join(Roadmap, Roadmap.id == Checkpoint.roadmap_id)
                .join(Project, Project.id == Roadmap.project_id)
                .where(Project.learner_id == current.learner.id, Project.visibility != "deleted")
            )).all()
            questions = [row[0] for row in owned_rows if str((row[0].assessment_meta or {}).get("practice_set_id") or "") == dynamic_set_id]
            if not questions:
                raise HTTPException(404, "动态练习文件不存在")
            checkpoint = next(row[1] for row in owned_rows if row[0].id == questions[0].id)
            roadmap = next(row[2] for row in owned_rows if row[0].id == questions[0].id)
        else:
            checkpoint = await require_owned_checkpoint(db, current.learner.id, checkpoint_id)
            roadmap = await db.get(Roadmap, checkpoint.roadmap_id)
            questions = list((await db.execute(select(ConceptQuestion).where(
                ConceptQuestion.checkpoint_id == checkpoint.id,
            ).order_by(ConceptQuestion.order, ConceptQuestion.id))).scalars().all())
        title = str((questions[0].assessment_meta or {}).get("practice_title") or f"{checkpoint.title} · 概念验证") if questions else f"{checkpoint.title} · 概念验证"
        return {
            "kind": "practice",
            "practice_kind": "dynamic_question_set" if dynamic_set_id else "concept_question_set",
            "ref": practice_ref,
            "title": title,
            "checkpoint_id": checkpoint.id,
            "project_id": roadmap.project_id if roadmap else None,
            "logical_filename": f"{checkpoint.title}-{title}.lfexercise",
            "questions": [{
                "id": item.id,
                "question": item.question,
                "options": list(item.options or []),
                "q_type": item.q_type,
                "difficulty": item.difficulty,
                "code": item.code or "",
                "order": item.order,
                "response_schema": (item.assessment_meta or {}).get("response_schema", item.q_type),
                "target_skill": (item.assessment_meta or {}).get("target_skill", ""),
                "quality": (item.assessment_meta or {}).get("quality", {}),
            } for item in questions],
            "provenance": {"artifact_type": "ConceptQuestionSet", "checkpoint_id": checkpoint.id},
            "answers_hidden": True,
            "mastery_inference": False,
        }
    raise HTTPException(400, "不支持的练习引用")


async def _owned_learning_task(db: AsyncSession, learner_id: int, task_id: int) -> LearningTask:
    task = (await db.execute(select(LearningTask).where(
        LearningTask.id == task_id,
        LearningTask.learner_id == learner_id,
    ))).scalar_one_or_none()
    if not task or not task.checkpoint_id:
        raise HTTPException(404, "学习任务不存在或未绑定关卡")
    await require_owned_checkpoint(db, learner_id, task.checkpoint_id)
    return task


@router.post("/practice/generate")
async def generate_dynamic_practice_file(
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    """Persist learning-design candidates only after deterministic validation."""
    task = await _owned_learning_task(db, current.learner.id, int(data.get("learning_task_id") or 0))
    candidates = [item for item in (data.get("candidates") or []) if isinstance(item, dict)][:12]
    if not candidates:
        raise HTTPException(400, "没有可验证的候选题")
    client_request_id = str(data.get("client_request_id") or "")[:160]
    if not client_request_id:
        raise HTTPException(400, "缺少 client_request_id")
    set_hash = hashlib.sha256(f"{current.learner.id}:{task.id}:{client_request_id}".encode()).hexdigest()[:20]
    practice_set_id = f"ps-{set_hash}"
    generation_kind = "similar" if data.get("generation_kind") == "similar" else "dynamic"
    reports = [validate_practice_candidate(item) for item in candidates]
    invalid = [report for report in reports if not report.valid]
    if invalid:
        raise HTTPException(422, {
            "message": "候选题未通过静态质量检查",
            "errors": [list(report.errors) for report in invalid],
        })
    requested_blueprint_id = int(data.get("assessment_blueprint_id") or 0)
    if requested_blueprint_id:
        try:
            blueprint, rubric = await validate_candidates_against_blueprint(
                db,
                learner_id=current.learner.id,
                learning_task_id=task.id,
                blueprint_id=requested_blueprint_id,
                candidates=candidates,
            )
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
    else:
        item_counts: dict[str, int] = defaultdict(int)
        difficulty_counts: dict[str, int] = defaultdict(int)
        for candidate in candidates:
            item_counts[str(candidate.get("q_type") or "single")] += 1
            difficulty_counts[str(candidate.get("difficulty") or "medium")] += 1
        first = candidates[0]
        try:
            blueprint, rubric, _ = await create_assessment_blueprint(
                db,
                learner_id=current.learner.id,
                learning_task_id=task.id,
                title=f"{str(data.get('title') or task.title)[:220]} · 评估蓝图",
                client_request_id=f"auto:{client_request_id}",
                data={
                    "purpose": str(first.get("purpose") or "practice"),
                    "target_subjects": [{
                        "name": str(first.get("target_skill") or task.objective),
                        "concept_key": str(first.get("concept_key") or ""),
                    }],
                    "item_mix": [
                        {"q_type": q_type, "count": count}
                        for q_type, count in sorted(item_counts.items())
                    ],
                    "difficulty_distribution": dict(difficulty_counts),
                    "source_refs": list(first.get("source_refs") or []),
                },
                source="dynamic_practice_generator",
            )
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
    try:
        questions = await create_practice_set(
            db,
            checkpoint_id=task.checkpoint_id,
            practice_set_id=practice_set_id,
            title=str(data.get("title") or f"{task.title} · 动态练习")[:255],
            candidates=candidates,
            assessment_blueprint_id=blueprint.id,
            rubric_id=rubric.id,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    checkpoint = await require_owned_checkpoint(db, current.learner.id, task.checkpoint_id)
    roadmap = await db.get(Roadmap, checkpoint.roadmap_id)
    project = await db.get(Project, roadmap.project_id) if roadmap else None
    if not project:
        raise HTTPException(404, "学习任务所属项目不存在")
    ref = _practice_set_ref(questions, checkpoint, project)
    refs = list(task.artifact_refs or [])
    artifact = {"kind": "practice", "ref": ref["ref"], "title": ref["title"]}
    if artifact not in refs:
        task.artifact_refs = [*refs, artifact]
        task.version = int(task.version or 1) + 1
    event_type = "practice_variant_generated" if generation_kind == "similar" else "practice_file_generated"
    tool_id = "similar_practice_generator" if generation_kind == "similar" else "dynamic_practice_generator"
    await record_event(
        db, event_type=event_type, source="dynamic_practice",
        learner_id=current.learner.id, session_id=task.session_id,
        project_id=task.project_id, checkpoint_id=task.checkpoint_id,
        payload={
            "learning_task_id": task.id, "practice_ref": ref["ref"],
            "item_count": len(questions), "quality_status": "validated_static_uncalibrated",
            "generation_kind": generation_kind,
            "source_practice_ref": str(data.get("source_practice_ref") or "")[:180],
            "assessment_blueprint_id": blueprint.id,
            "rubric_id": rubric.id,
            "mastery_unchanged": True,
        },
        artifact_refs=[artifact],
        provenance={"tool": tool_id, "client_request_id": client_request_id},
        client_event_id=f"{event_type}:{current.learner.id}:{practice_set_id}",
    )
    await db.commit()
    return {
        **ref,
        "assessment_blueprint_id": blueprint.id,
        "rubric_id": rubric.id,
        "quality_reports": [report.quality for report in reports],
        "mastery_inference": False,
    }


@router.post("/practice/{practice_ref}/quality")
async def inspect_dynamic_practice_quality(
    practice_ref: str,
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    file = await get_practice_file(practice_ref, current, db)
    reports = [
        {
            "item_id": item["id"],
            "schema_valid": bool(item.get("quality", {}).get("schema_valid")),
            "construct_declared": bool(item.get("quality", {}).get("construct_declared")),
            "answer_deterministic": bool(item.get("quality", {}).get("answer_deterministic")),
            "psychometric_status": item.get("quality", {}).get("psychometric_status", "uncalibrated"),
        }
        for item in file.get("questions", [])
    ]
    result = {
        "practice_ref": practice_ref,
        "valid": bool(reports) and all(item["schema_valid"] and item["construct_declared"] and item["answer_deterministic"] for item in reports),
        "reports": reports,
        "boundary": "静态质量检查不是学生作答评分，也不产生掌握证据。",
    }
    await record_event(
        db, event_type="practice_quality_inspected", source="practice_quality_inspector",
        learner_id=current.learner.id,
        project_id=file.get("project_id"), checkpoint_id=file.get("checkpoint_id"),
        payload={
            "practice_ref": practice_ref, "valid": result["valid"],
            "item_count": len(reports), "mastery_unchanged": True,
        },
        provenance={"tool": "practice_quality_inspector"},
        client_event_id=str(data.get("client_event_id") or f"practice-quality:{current.learner.id}:{practice_ref}")[:160],
    )
    await db.commit()
    return result


@router.post("/tasks/{task_id}/generate")
async def generate_task_learning_files(
    task_id: int,
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    task = (await db.execute(select(LearningTask).where(
        LearningTask.id == task_id,
        LearningTask.learner_id == current.learner.id,
    ))).scalar_one_or_none()
    if not task:
        raise HTTPException(404, "学习任务不存在")
    client_request_id = str(data.get("client_request_id") or f"learning-files:{task.id}:{task.version}")[:160]
    try:
        await materialize_learning_task(
            db,
            task=task,
            source_text=str(data.get("source_text") or "")[:20_000],
            expected_version=int(data.get("expected_version", task.version)),
            client_request_id=client_request_id,
            education_stage=current.profile.education_stage or "",
            background=current.profile.background or "",
        )
    except RuntimeError as error:
        message = str(error)
        status = 409 if message == "version_conflict" else 400
        raise HTTPException(status, message) from error
    view = await learning_task_view(db, task)
    if view.get("artifact_refs"):
        await record_event(
            db, event_type="learning_file_generated", source="learning_task_runtime",
            learner_id=current.learner.id, session_id=task.session_id,
            project_id=task.project_id, checkpoint_id=task.checkpoint_id,
            payload={"task_id": task.id, "artifact_refs": view.get("artifact_refs", []), "mastery_unchanged": True},
            provenance={"endpoint": "POST /api/learning-files/tasks/{id}/generate"},
            client_event_id=f"learning-files:task:{task.id}:{client_request_id}",
        )
    await db.commit()
    return view


async def _record_file_access(
    db: AsyncSession,
    current: CurrentLearner,
    *,
    event_type: str,
    kind: str,
    ref: str,
    data: dict,
) -> dict:
    if kind == "lecture":
        try:
            lecture, checkpoint, project = await _owned_lecture(db, current.learner.id, int(ref))
        except ValueError as error:
            raise HTTPException(400, "讲义引用无效") from error
        project_id, checkpoint_id = project.id, checkpoint.id
        artifact_id = lecture.id
    elif kind == "practice":
        practice = await get_practice_file(ref, current, db)
        project_id = practice.get("project_id")
        checkpoint_id = practice.get("checkpoint_id")
        artifact_id = practice.get("id") or ref
    else:
        try:
            source = await require_owned_source(db, current.learner.id, int(ref))
        except ValueError as error:
            raise HTTPException(400, "资料引用无效") from error
        project_id, checkpoint_id = source.project_id, None
        artifact_id = source.id
    client_key = str(data.get("client_event_id") or f"{event_type}:{kind}:{ref}:{data.get('conversation_id', '')}")[:160]
    await record_event(
        db, event_type=event_type, source="ui",
        learner_id=current.learner.id, project_id=project_id, checkpoint_id=checkpoint_id,
        payload={
            "artifact_kind": kind, "artifact_ref": ref, "artifact_id": artifact_id,
            "conversation_id": str(data.get("conversation_id") or "")[:160],
            "sheet_id": str(data.get("sheet_id") or "")[:160],
            "mastery_unchanged": True,
        },
        provenance={"endpoint": f"POST /api/learning-files/{kind}/{ref}/{event_type}"},
        client_event_id=client_key,
    )
    await db.commit()
    return {"status": "ok", "event_type": event_type, "mastery_unchanged": True}


@router.post("/{kind}/{ref}/opened")
async def record_learning_file_opened(
    kind: str,
    ref: str,
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    if kind not in {"lecture", "practice", "source"}:
        raise HTTPException(400, "文件类型无效")
    return await _record_file_access(db, current, event_type="learning_file_opened", kind=kind, ref=ref, data=data)


@router.post("/{kind}/{ref}/attached")
async def record_learning_file_attached(
    kind: str,
    ref: str,
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    if kind not in {"lecture", "practice", "source"}:
        raise HTTPException(400, "文件类型无效")
    return await _record_file_access(db, current, event_type="learning_file_attached_to_chat", kind=kind, ref=ref, data=data)


@router.post("/lecture/{lecture_id}/read")
async def mark_lecture_read(
    lecture_id: int,
    data: dict = Body(default={}),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    lecture, checkpoint, project = await _owned_lecture(db, current.learner.id, lecture_id)
    await record_event(
        db, event_type="lecture_viewed", source="ui",
        learner_id=current.learner.id, project_id=project.id, checkpoint_id=checkpoint.id,
        payload={
            "lecture_id": lecture.id,
            "lecture_version": int(lecture.version or 1),
            "explicit_completion": bool(data.get("explicit_completion", True)),
            "mastery_unchanged": True,
        },
        provenance={"endpoint": "POST /api/learning-files/lecture/{id}/read"},
        client_event_id=str(data.get("client_event_id") or f"lecture:{lecture.id}:read:v{lecture.version}")[:160],
    )
    await db.commit()
    return {"status": "ok", "evidence_role": "exposure", "mastery_unchanged": True}
