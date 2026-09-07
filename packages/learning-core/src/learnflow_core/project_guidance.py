"""Learner-confirmed project composition; devices supply reports, never grades."""
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.project import Project, Checkpoint, Roadmap
from app.models.learning import AgentSession, LearningTask
from app.services.learning_runtime import record_event
from learnflow_core.project_guidance_models import ProjectGuidanceCandidate, ProjectDeviceReport
from learnflow_core.practice_cases import digest, get_case, case_summary
from learnflow_core.project_workflows import initialize_workflow, save_workbench, workflow_view

SCHEMA_VERSION = "learnflow.project-guidance.v1"


async def validate_sources(db, learner_id, refs):
    for ref in refs:
        session = await db.scalar(select(AgentSession).where(
            AgentSession.id == ref["session_id"], AgentSession.learner_id == learner_id,
            AgentSession.status == "active"))
        if not session:
            raise HTTPException(404, "原始对话不存在或不属于当前学习者")


def candidate_view(row):
    return {"schema_version": SCHEMA_VERSION, "candidate_id": row.id, "root_hash": row.root_hash,
            "candidate": row.candidate, "requires_confirmation": True, "mastery_inference": False}


async def prepare(db: AsyncSession, learner_id: int, data: dict):
    await validate_sources(db, learner_id, data["source_refs"])
    request_hash = digest(data)
    previous = await db.scalar(select(ProjectGuidanceCandidate).where(
        ProjectGuidanceCandidate.learner_id == learner_id,
        ProjectGuidanceCandidate.client_action_id == data["client_action_id"]))
    if previous:
        if previous.request_hash != request_hash:
            raise HTTPException(409, "同一准备编号不能用于不同项目内容")
        return candidate_view(previous)
    candidate = {key: value for key, value in data.items() if key != "client_action_id"}
    candidate.update(schema_version=SCHEMA_VERSION, authority="learnflow_project_design", execution_surface="desktop")
    if data["project_mode"] == "practice":
        if not all(data.get(key) for key in ("case_id", "case_version", "case_root_hash")):
            raise HTTPException(422, {"code": "practice_case_selection_required", "message": "请先选择目录中的固定案例。自定义工作任务需要先设计案例，不能自动套用现有案例。"})
        case = get_case(data["case_id"], data["case_version"], data["case_root_hash"])
        candidate["case_ref"] = case_summary(case)
    elif any(data.get(key) for key in ("case_id", "case_version", "case_root_hash")):
        raise HTTPException(422, "实验项目不能携带实践案例绑定")
    row = ProjectGuidanceCandidate(id="pg_" + uuid4().hex, learner_id=learner_id,
        client_action_id=data["client_action_id"], request_hash=request_hash,
        root_hash=digest(candidate), candidate=candidate)
    db.add(row)
    await db.flush()
    await record_event(db, learner_id=learner_id, event_type="project_guidance_prepared", source="ui",
        payload={"candidate_id": row.id, "root_hash": row.root_hash, "project_mode": data["project_mode"], "mastery_unchanged": True},
        client_event_id=f"project-guidance:{row.id}:prepared")
    return candidate_view(row)


async def confirm(db: AsyncSession, learner_id: int, candidate_id: str, data: dict):
    # A no-op UPDATE acquires the database write lock before checking promotion.
    # The row remains locked through the caller's transaction, including on SQLite.
    claimed = await db.execute(update(ProjectGuidanceCandidate).where(
        ProjectGuidanceCandidate.id == candidate_id, ProjectGuidanceCandidate.learner_id == learner_id
    ).values(root_hash=ProjectGuidanceCandidate.root_hash))
    if claimed.rowcount != 1:
        raise HTTPException(404, "项目候选不存在")
    row = await db.get(ProjectGuidanceCandidate, candidate_id, populate_existing=True)
    if row.root_hash != data["expected_root_hash"] or row.root_hash != digest(row.candidate):
        raise HTTPException(409, "候选版本已变化，请重新查看并确认当前版本")
    if data.get("confirmed") is not True:
        raise HTTPException(422, "需要明确确认")
    from learnflow_core.api.vnext_projects import _workspace_view
    if row.project_id:
        project = await db.scalar(select(Project).where(Project.id == row.project_id, Project.learner_id == learner_id, Project.visibility == "visible"))
        if not project:
            raise HTTPException(409, "原确认项目已不可用；请准备新的候选")
        created = False
    else:
        candidate = row.candidate
        await validate_sources(db, learner_id, candidate["source_refs"])
        # Recheck the pinned bundle before any project is materialized.
        if candidate["project_mode"] == "practice":
            get_case(candidate["case_id"], candidate["case_version"], candidate["case_root_hash"])
        description = candidate["objective"] + ("\n\n预期产物：" + candidate["expected_outcome"] if candidate["expected_outcome"] else "")
        project = Project(learner_id=learner_id, name=candidate["name"], description=description,
            project_kind="apprenticeship", visibility="visible", project_mode=candidate["project_mode"],
            project_brief={**candidate["project_brief"], "source_refs": candidate["source_refs"],
                           "guidance_candidate_id": row.id, "guidance_root_hash": row.root_hash})
        db.add(project)
        await db.flush()
        row.project_id = project.id
        await record_event(db, learner_id=learner_id, project_id=project.id, event_type="project_created", source="ui",
            payload={"project_id": project.id, "name": project.name, "learning_goal": candidate["objective"], "expected_outcome": candidate["expected_outcome"]},
            provenance={"service": "project_guidance", "explicit_click": True}, client_event_id=f"project-guidance:{row.id}:project")
        workflow = await initialize_workflow(db, project, {"client_action_id": f"guidance:{row.id}:initialize",
            **{key: candidate.get(key) for key in ("case_id", "case_version", "case_root_hash")}})
        brief = candidate["project_brief"]
        text = f"目标：{candidate['objective']}\n\n预期产物：{candidate['expected_outcome']}"
        for key, label in (("deliverables", "核心交付"), ("constraints", "约束"), ("success_criteria", "验收标准")):
            text += "\n\n" + label + "：\n" + "\n".join(brief.get(key) or [])
        # Preserve the full brief across bounded papers; every generated paper
        # must be valid for the same API used when the learner next saves it.
        chunks = [text[index:index + 29000] for index in range(0, len(text), 29000)]
        papers = [{"id": f"brief-{row.id}-{index}",
                   "title": candidate["name"][:180] + f" · 任务书 {index + 1}",
                   "kind": "note", "body": chunk} for index, chunk in enumerate(chunks)]
        if candidate["project_mode"] == "experiment":
            papers.append({"id": f"hypothesis-{row.id}", "title": "实验预测与观察", "kind": "hypothesis", "body": "我的预测：\n\n控制条件与变量：\n\n运行观察：\n\n解释与下一步：\n"})
        from learnflow_core.project_workflow_schema import WorkbenchSaveRequest
        initial = WorkbenchSaveRequest.model_validate({"client_action_id": f"guidance:{row.id}:papers", "expected_revision": workflow["revision"],
            "workbench": {**workflow["workbench"], "papers": papers, "active_paper_id": papers[0]["id"],
                          "active_checkpoint_id": workflow["milestones"][0]["checkpoint_id"]}})
        await save_workbench(db, project, initial.model_dump())
        tasks = (await db.scalars(select(LearningTask).where(LearningTask.project_id == project.id, LearningTask.learner_id == learner_id))).all()
        for task in tasks:
            task.source_refs = [*list(task.source_refs or []), {"type": "project_guidance_candidate", "id": row.id, "root_hash": row.root_hash}, *candidate["source_refs"]]
        await record_event(db, learner_id=learner_id, project_id=project.id, event_type="project_guidance_confirmed", source="ui",
            payload={"candidate_id": row.id, "root_hash": row.root_hash, "project_id": project.id, "mastery_unchanged": True},
            client_event_id=f"project-guidance:{row.id}:confirmed")
        created = True
    workspace = await _workspace_view(db, learner_id, project)
    return {"schema_version": SCHEMA_VERSION, "created": created, "project_id": project.id,
        "session_id": workspace["project_tutor"]["session_id"], "navigation": {"kind": "project", "path": f"/projects/{project.id}"},
        "source_refs": row.candidate["source_refs"], "workspace": workspace,
        "workflow": await workflow_view(db, project), "mastery_inference": False}


def report_view(row):
    return {"schema_version": "learnflow.device-report.v1", "report_id": row.id,
        "project_id": row.project_id, "checkpoint_id": row.checkpoint_id,
        "artifact_ref": {"kind": "device_report", "ref": str(row.id), "revision": row.report_hash},
        "authority": "device_reported", "validation": "structure_and_ownership_only", "mastery_inference": False,
        "report": row.report}


async def record_device_report(db: AsyncSession, project: Project, data: dict):
    checkpoint = await db.scalar(select(Checkpoint.id).join(Roadmap).where(
        Checkpoint.id == data["checkpoint_id"], Roadmap.project_id == project.id, Checkpoint.archived.is_(False)))
    if not checkpoint:
        raise HTTPException(404, "关卡不属于当前项目")
    if project.project_mode not in {"experiment", "practice"}:
        raise HTTPException(422, "设备操作报告只用于实验或实践项目")
    # Device-local run IDs are descriptive; referenced learning scopes must still
    # belong to this authenticated project, including older applied stages.
    provenance = data.get("engineering_provenance") or {}
    run_checkpoints = {run["checkpoint_id"] for run in provenance.get("runs", []) if run.get("checkpoint_id") is not None}
    if run_checkpoints:
        owned = set(await db.scalars(select(Checkpoint.id).join(Roadmap).where(
            Checkpoint.id.in_(run_checkpoints), Roadmap.project_id == project.id,
        )))
        if run_checkpoints != owned:
            raise HTTPException(422, "工程辅助来源的关卡不属于当前项目")
    report_hash = digest(data)
    previous = await db.scalar(select(ProjectDeviceReport).where(
        ProjectDeviceReport.project_id == project.id, ProjectDeviceReport.client_action_id == data["client_action_id"]))
    if previous:
        if previous.report_hash != report_hash:
            raise HTTPException(409, "同一报告编号不能用于不同运行")
        return report_view(previous)
    row = ProjectDeviceReport(learner_id=project.learner_id, project_id=project.id, checkpoint_id=checkpoint,
        client_action_id=data["client_action_id"], report_hash=report_hash, report=data)
    db.add(row)
    await db.flush()
    await record_event(db, learner_id=project.learner_id, project_id=project.id, checkpoint_id=checkpoint,
        event_type="project_device_report_recorded", source="ui", actor_type="user",
        payload={"report_id": row.id, "report_hash": report_hash, "authority": "device_reported", "mastery_unchanged": True},
        provenance={"service": "project_device_report", "validation": "structure_and_ownership_only"},
        client_event_id=f"project-device-report:{row.id}")
    return report_view(row)
