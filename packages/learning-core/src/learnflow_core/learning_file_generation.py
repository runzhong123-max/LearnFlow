"""Materialize managed files without starting or replacing a learning workflow.

The database remains authoritative. Generation fills missing artifacts; existing
lectures, attempts, drafts and annotations are never overwritten by this API.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import func, select, update

from app.models.learning import LearningTask

from app.models.project import Checkpoint, ConceptQuestion, DomainKnowledgePacket, Exercise, Lecture, Project, Roadmap
from app.services.auth import require_owned_checkpoint
from app.services.dynamic_practice import normalized_candidate, validate_practice_candidate


FILE_SCHEMA_VERSION = "learning-file-package.v2"


def task_artifact_checkpoint_id(task) -> int | None:
    return task.checkpoint_id or dict(task.execution_state or {}).get("artifact_scope", {}).get("checkpoint_id")


def task_artifact_project_id(task) -> int | None:
    return task.project_id or dict(task.execution_state or {}).get("artifact_scope", {}).get("project_id")


def _text(value: Any, limit: int = 6000) -> str:
    return str(value or "").strip()[:limit]


def normalize_file_kinds(value: Any) -> list[str]:
    if value is None:
        return ["lecture", "practice"]
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or item not in {"lecture", "practice"} for item in value):
        raise RuntimeError("invalid_file_kinds")
    return list(dict.fromkeys(value))


def lecture_sections(artifact: dict, packet: DomainKnowledgePacket) -> list[dict]:
    """Preserve authored sections, or build explicit sections from actual content."""
    card = dict(artifact.get("card") or {})
    authored = [row for row in artifact.get("lecture_sections", []) if isinstance(row, dict)]
    roles = {row.get("role") for row in authored}
    if len(authored) >= 4 and {"objective", "mechanism", "example", "boundary"} <= roles:
        rows = authored[:8]
    else:
        points = [_text(point) for point in card.get("key_points", []) if _text(point)]
        if not points or not _text(card.get("example")):
            return []
        rows = [
            {"role": "objective", "title": "学习目标与起点", "content": _text(card.get("objective"))},
            {"role": "mechanism", "title": "核心机制与关键关系", "content": "\n\n".join(f"### {index + 1}. 关键关系\n\n{point}" for index, point in enumerate(points))},
            {"role": "example", "title": "具体例子", "content": _text(card.get("example"))},
            {"role": "boundary", "title": "适用边界与常见混淆", "content": _text(card.get("common_confusion"))},
        ]
    result = []
    for index, row in enumerate(rows):
        content = _text(row.get("content"), 16000)
        if not content:
            return []
        result.append({
            "id": f"section-{index + 1}", "anchor": f"section-{index + 1}",
            "schema_version": FILE_SCHEMA_VERSION,
            "role": row.get("role", "mechanism"),
            "title": _text(row.get("title"), 180), "content": content,
            "keywords": list(card.get("target_concepts") or [])[:8], "questions": [],
            "domain_knowledge_packet_id": packet.id,
            "domain_knowledge_fingerprint": packet.input_fingerprint,
            "source_refs": list(packet.source_version_refs or [])[:20],
        })
    return result


def practice_candidates(artifact: dict, packet: DomainKnowledgePacket) -> list[dict]:
    """Static checks declare limits, never claim semantic or psychometric proof."""
    generation = dict(artifact.get("generation") or {})
    # Extracting sentences or asking about learning itself cannot verify a subject.
    if generation.get("source") in {"generic_goal_scaffold", "provided_material_extract"}:
        return []
    result = []
    questions = list(artifact.get("questions") or [])
    if generation.get("mode") == "model_enhanced":
        questions = questions[:int(dict(artifact.get("content_quality") or {}).get("authored_question_count", len(questions)))]
    for question in questions:
        if not isinstance(question, dict):
            continue
        candidate = {
            **question, "target_skill": question.get("learning_target"), "purpose": "practice",
            "source_refs": list(packet.source_version_refs or []),
        }
        report = validate_practice_candidate(candidate)
        if not report.valid or not question.get("explanation"):
            continue
        options = candidate.get("options") or []
        if any(marker in " ".join(map(str, options)) for marker in (
            "宣布掌握", "生成过答案本身", "只要记住主题名称", "只比较关键词",
        )):
            continue
        result.append(candidate)
    return result[:6]


async def generate_task_files(db, *, task, file_kinds, source_text, expected_version,
                              client_request_id, education_stage="", background="") -> dict:
    from app.services.domain_knowledge import compile_domain_knowledge_packet, ensure_inline_source
    from app.services.learning_tasks import _artifact_refs, _resolved_task_source_text
    from app.services.micro_learning import _ground_artifact_in_packet, generate_micro_learning_artifact

    requested = normalize_file_kinds(file_kinds)
    request_hash = hashlib.sha256(json.dumps({"kinds": requested, "source_text": source_text}, sort_keys=True).encode()).hexdigest()
    state = dict(task.execution_state or {})
    operations = list(state.get("file_generation_operations") or [])
    previous = next((row for row in operations if row["request_id"] == client_request_id), None)
    if previous:
        if previous["request_hash"] != request_hash:
            raise RuntimeError("idempotency_conflict")
        return previous["result"]
    if task.version != expected_version:
        raise RuntimeError("version_conflict")
    if task.status not in {"queued", "active", "paused"}:
        raise RuntimeError("invalid_state")
    # Acquire the task's write transaction before any slow generation. The
    # compare-and-swap also works with SQLite, where SELECT FOR UPDATE does not.
    claimed = await db.execute(update(LearningTask).where(
        LearningTask.id == task.id, LearningTask.learner_id == task.learner_id,
        LearningTask.version == expected_version,
    ).values(version=expected_version + 1).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        raise RuntimeError("version_conflict")
    task.version = expected_version + 1

    checkpoint = None
    if task_artifact_checkpoint_id(task):
        checkpoint = await require_owned_checkpoint(db, task.learner_id, task_artifact_checkpoint_id(task))
        roadmap = await db.get(Roadmap, checkpoint.roadmap_id)
        if task.project_id and task.project_id != roadmap.project_id:
            raise RuntimeError("invalid_scope")
    project_id = roadmap.project_id if checkpoint else task_artifact_project_id(task)
    project = await db.get(Project, project_id) if project_id else None
    if project and (project.learner_id != task.learner_id or project.visibility == "deleted"):
        raise RuntimeError("invalid_scope")

    lecture = (await db.execute(select(Lecture).where(Lecture.checkpoint_id == checkpoint.id))).scalar_one_or_none() if checkpoint else None
    questions = list((await db.execute(select(ConceptQuestion).where(ConceptQuestion.checkpoint_id == checkpoint.id))).scalars()) if checkpoint else []
    exercises = list((await db.execute(select(Exercise).where(Exercise.checkpoint_id == checkpoint.id))).scalars()) if checkpoint else []
    available = {"lecture": bool(lecture and lecture.status == "published" and lecture.sections), "practice": bool(questions or exercises)}
    missing = [kind for kind in requested if not available[kind]]
    generated: list[str] = []
    gaps: list[str] = []
    generation: dict = {"mode": "reused"}
    packet = None
    if missing:
        packet_id = int(state.get("domain_knowledge_packet_id") or 0)
        packet = await db.get(DomainKnowledgePacket, packet_id) if packet_id else None
        if packet and packet.learner_id != task.learner_id:
            raise RuntimeError("invalid_scope")
        inline = await ensure_inline_source(db, learner_id=task.learner_id, text=source_text,
            title=f"{task.title} · 任务显式材料") if _text(source_text) else None
        if not packet or packet.status not in {"ready", "ready_with_gaps"} or inline:
            inherited = [ref.get("source_id") for ref in (packet.source_version_refs or []) if isinstance(ref, dict)] if packet else []
            packet = await compile_domain_knowledge_packet(
                db, learner_id=task.learner_id, query=f"{task.title} {task.objective}", kind="teaching_artifact",
                source_ids=list(dict.fromkeys([*(item for item in inherited if item), *([inline.id] if inline else [])])) or None,
                project_id=task.project_id, checkpoint_id=task.checkpoint_id, session_id=task.session_id,
                learning_task_id=task.id,
            )
        state.update(domain_knowledge_packet_id=packet.id, domain_knowledge_status=packet.status,
            domain_knowledge_gaps=list(packet.unresolved_gaps or []))
        task.source_refs = [
            *[ref for ref in (task.source_refs or []) if not isinstance(ref, dict) or ref.get("type") != "domain_knowledge_packet"],
            {"type": "domain_knowledge_packet", "id": packet.id},
        ]
        if packet.status not in {"ready", "ready_with_gaps"}:
            gaps.append("缺少可靠的主题材料；请补充资料后重试。")
        else:
            resolved, _ = await _resolved_task_source_text(db, task, source_text)
            artifact = await generate_micro_learning_artifact(goal=f"{task.title}：{task.objective}", source_text=resolved,
                education_stage=education_stage, background=background, full_lecture="lecture" in missing)
            generation = dict(artifact.get("generation") or {})
            reliable_content = (generation.get("mode") == "model_enhanced" and not dict(artifact.get("content_quality") or {}).get("card_fallback_used")) or str(generation.get("source") or "").startswith("curated.")
            # A complete, cited DomainKnowledgePacket is also a legitimate
            # offline source. Preserve its mechanism/example/boundary content;
            # the generic fallback questions still fail the subject-item gate.
            units = dict(packet.knowledge_units or {})
            if not reliable_content and packet.status == "ready" and units.get("examples") and units.get("misconceptions"):
                artifact, _ = _ground_artifact_in_packet(artifact, task.objective, packet)
                generation = dict(artifact.get("generation") or {})
                reliable_content = True
            sections = lecture_sections(artifact, packet) if reliable_content else []
            candidates = practice_candidates(artifact, packet)
            if "lecture" in missing and not sections:
                gaps.append("完整讲义尚未通过内容检查；已保留资料，请重试生成或补充具体材料。")
            if "practice" in missing and not candidates:
                gaps.append("尚未得到可正式作答的学科题目；没有发布占位题或将阅读视为验证。")
            if packet.status in {"ready", "ready_with_gaps"}:
                if not checkpoint:
                    if not project:
                        project = Project(learner_id=task.learner_id, name=task.title,
                            description=task.objective, project_kind="task_artifact", visibility="internal", user_level="beginner")
                        db.add(project)
                        await db.flush()
                    roadmap = (await db.execute(select(Roadmap).where(Roadmap.project_id == project.id).order_by(Roadmap.id).limit(1))).scalar_one_or_none()
                    if not roadmap:
                        roadmap = Roadmap(project_id=project.id, raw_json={"mode": "managed_learning_files"})
                        db.add(roadmap)
                        await db.flush()
                    order = int(await db.scalar(select(func.max(Checkpoint.order)).where(Checkpoint.roadmap_id == roadmap.id)) or 0) + 1
                    checkpoint = Checkpoint(roadmap_id=roadmap.id, title=task.title, description=task.objective, order=order,
                        brief={"mode": "managed_learning_files", "learning_task_id": task.id})
                    db.add(checkpoint)
                    await db.flush()
                state["artifact_scope"] = {"project_id": project.id, "checkpoint_id": checkpoint.id}
                task.execution_state = dict(state)
                if "lecture" in missing and sections:
                    if lecture:
                        # A draft can belong to another in-flight authoring operation.
                        gaps.append("已有未发布讲义，请在讲义编辑器中完成或重新生成，避免覆盖。")
                    else:
                        lecture = Lecture(checkpoint_id=checkpoint.id, sections=sections, status="published", version=1,
                            plan=[{"title": row["title"], "anchor": row["anchor"]} for row in sections])
                        db.add(lecture)
                        await db.flush()
                        generated.append("lecture")
                if "practice" in missing and candidates:
                    for index, candidate in enumerate(candidates, 1):
                        normalized = normalized_candidate(candidate, practice_set_id="", family_id=f"task:{task.id}:{index}")
                        normalized["assessment_meta"].update(
                            mode="managed_learning_files", learning_target=candidate["target_skill"],
                            variant=candidate.get("variant") or {}, learning_task_id=task.id,
                            lecture_id=lecture.id if lecture else None, lecture_version=lecture.version if lecture else None,
                            source_refs=list(packet.source_version_refs or []),
                        )
                        db.add(ConceptQuestion(checkpoint_id=checkpoint.id, order=index, **normalized))
                    await db.flush()
                    generated.append("practice")
    task.artifact_refs = await _artifact_refs(db, task)
    fulfilled = [kind for kind in requested if available[kind] or kind in generated]
    result = {"schema_version": FILE_SCHEMA_VERSION, "status": "ready" if len(fulfilled) == len(requested) else "partial" if fulfilled else "blocked",
        "requested_kinds": requested, "generated_kinds": generated, "reused_kinds": [kind for kind in requested if available[kind]],
        "gaps": gaps, "generation": generation, "mastery_inference": False}
    operations.append({"request_id": client_request_id, "request_hash": request_hash, "result": result})
    task.execution_state = {**state, "file_generation": result, "file_generation_operations": operations[-50:]}
    await db.flush()
    return result
