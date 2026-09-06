"""Project workflow composition over the existing Roadmap/Checkpoint/LearningTask authority.

Delivery status is operational only. Every persisted learner action is idempotent,
scoped and audited; only the existing graded-attempt runtime can establish learning.
"""
from __future__ import annotations
from typing import Any
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.project import (
    Project, Roadmap, Checkpoint, Source, SourceVersion, Lecture, Exercise,
    ProjectWorkflowState, ProjectWorkflowSubmission, ConceptQuestion,
)
from app.models.learning import LearningTask
from app.schemas.project_workflow import WorkbenchState
from app.services.learning_runtime import record_event
from app.services.learning_tasks import ensure_all_checkpoint_learning_tasks, learning_task_view
from app.services.teaching_contract import normalize_teaching_contract
from app.services.practice_cases import digest, get_case, case_summary, evaluate_case

SCHEMA_VERSION = "learnflow.project-workflow.v1"


def _field(key: str, label: str) -> dict:
    return {"key": key, "label": label, "kind": "textarea", "placeholder": ""}


def _default_stages(mode: str, project: Project) -> list[dict]:
    if mode == "experiment":
        specs = [
            ("define", "明确实验与基线", "读懂接口与先备，确定最小交付物和可检查标准。", "实验前任务书：先列目标、输入输出、限制和最小成功标准。记录你对结果的预测；把核心交付与可选探索分开。", [_field("deliverable", "核心交付与验收方法"), _field("prediction", "预测：预期结果和理由")], "brief"),
            ("implement", "实现、运行与解释失败", "从最小实现开始，分组件检查并保存一次可复现运行。", "关联真实工程目录。先运行基线，再做最小修改，分组件测试，保存运行快照。运行输出通过不代表你已经掌握；解释仍需导师评审。", [_field("observation", "观察：结果与基线的差别"), _field("explanation", "解释：失败原因和修复依据")], "experiment_run"),
            ("reflect", "交付与下一步实验", "整理产物、复现方式与实验结论，选择下一步变式。", "交付需附关联产物与可重现运行。比较预测和观察，说明未覆盖的边界。可选探索：性能、复杂度、设计替代方案。提出一个控制变量的下一步实验。", [_field("conclusion", "结论与复现方式"), _field("next_experiment", "下一步实验：变量、预测、测量方法")], "experiment_run"),
        ]
    else:
        specs = [
            ("orient", "选择资料与学习目标", "从资料出发，明确先备、目标和可检查的应用。", "添加并处理书籍、课程讲义或其他来源，固定一个来源版本。说明你希望读懂什么、能做什么，以及当前的问题。", [_field("goal", "目标、先备与期待的应用")], "source"),
            ("read", "带问题阅读与复述", "保存有位置的阅读记录，区分读过、理解与仍有的问题。", "在来源阅读器记录章节或页码。合上材料后尝试复述，再把解释不清的地方作为问题交给导师。笔记仅记录接触与自述，不能代替独立验证。", [_field("teachback", "用自己的话解释核心机制"), _field("question", "还不确定的问题或边界")], "reading"),
            ("verify", "独立应用与复习", "在正式关卡任务中完成独立验证并安排复习。", "进入本关 Tutor 完成正式练习与独立验证，然后建立复习安排。这里仅引用正式任务运行时的证据，不接收勾选或自述作为掌握。", [_field("reflection", "应用反思与下一次复习重点")], "formal_verification"),
        ]
    return [{"key": key, "title": title, "objective": objective,
             "materials": [{"id": key, "title": title, "body": body}], "fields": fields,
             "validator": validator, "required_artifacts": validator in {"source", "experiment_run"}}
            for key, title, objective, body, fields, validator in specs]


async def _state(db: AsyncSession, project: Project, create: bool = False) -> ProjectWorkflowState | None:
    state = await db.scalar(select(ProjectWorkflowState).where(ProjectWorkflowState.project_id == project.id))
    if not state and create:
        state = ProjectWorkflowState(project_id=project.id, learner_id=project.learner_id,
                                     revision=0, initialized=False, workbench=WorkbenchState().model_dump())
        db.add(state)
        await db.flush()
    return state


async def _rows(db: AsyncSession, project: Project) -> list[Checkpoint]:
    return list((await db.execute(select(Checkpoint).join(Roadmap).where(
        Roadmap.project_id == project.id, Checkpoint.archived.is_(False),
    ).order_by(Checkpoint.order, Checkpoint.id))).scalars().all())


async def _actions(db: AsyncSession, project: Project) -> list[ProjectWorkflowSubmission]:
    return list((await db.execute(select(ProjectWorkflowSubmission).where(
        ProjectWorkflowSubmission.project_id == project.id,
        ProjectWorkflowSubmission.learner_id == project.learner_id,
    ).order_by(ProjectWorkflowSubmission.id))).scalars().all())


async def _replay(db: AsyncSession, project: Project, action_id: str, payload: dict) -> bool:
    action = await db.scalar(select(ProjectWorkflowSubmission).where(
        ProjectWorkflowSubmission.project_id == project.id,
        ProjectWorkflowSubmission.client_action_id == action_id,
    ))
    if not action:
        return False
    if action.request_hash != digest(payload):
        raise HTTPException(409, "同一操作编号不能用于不同请求")
    return True


async def _record(db: AsyncSession, project: Project, action_id: str, kind: str, payload: dict,
                  feedback: dict | None = None, checkpoint_id: int | None = None,
                  event_type: str | None = None) -> ProjectWorkflowSubmission:
    action = ProjectWorkflowSubmission(
        project_id=project.id, learner_id=project.learner_id, checkpoint_id=checkpoint_id,
        client_action_id=action_id, request_hash=digest(payload), kind=kind,
        payload=({"operation": "workbench", "expected_revision": payload.get("expected_revision"),
                  "paper_ids": [paper["id"] for paper in payload.get("workbench", {}).get("papers", [])]}
                 if kind == "workbench" else payload), feedback=feedback or {},
    )
    db.add(action)
    await db.flush()
    if event_type:
        await record_event(db, learner_id=project.learner_id, project_id=project.id,
                           checkpoint_id=checkpoint_id, source="ui", event_type=event_type,
                           payload={"submission_id": action.id, "kind": kind, "mastery_unchanged": True},
                           provenance={"service": "project_workflows", "explicit_click": True,
                                       "policy_version": SCHEMA_VERSION},
                           client_event_id=f"workflow:{project.id}:{action_id}")
    return action


def _stage_for(checkpoint: Checkpoint, state: ProjectWorkflowState | None, project: Project) -> dict:
    key = str((checkpoint.brief or {}).get("checkpoint_key") or "")
    if state and state.case_ref:
        case = get_case(state.case_ref["id"], state.case_ref["version"], state.case_ref["root_hash"])
        return next((stage for stage in case["stages"] if stage["key"] == key), {})
    stage = next((stage for stage in _default_stages(project.project_mode or "learning", project)
                  if stage["key"] == key and (checkpoint.brief or {}).get("workflow_template") == SCHEMA_VERSION), None)
    return stage or {"key": key or f"checkpoint-{checkpoint.id}", "title": checkpoint.title,
                     "objective": checkpoint.description, "materials": [],
                     "fields": [_field("reflection", "交付说明、依据和复盘")],
                     "validator": "formal_verification" if project.project_mode == "learning" else "artifact",
                     "required_artifacts": project.project_mode != "learning"}


def _submission_view(action: ProjectWorkflowSubmission) -> dict:
    return {"id": action.id, "answers": action.payload.get("answers", {}),
            "artifact_refs": action.payload.get("artifact_refs", []),
            "assistance_level": action.feedback.get("effective_assistance_level", action.payload.get("assistance_level", "independent")),
            "feedback": action.feedback, "created_at": action.created_at.isoformat()}


async def workflow_view(db: AsyncSession, project: Project, *, compact: bool = False,
                        checkpoint_id: int | None = None) -> dict:
    state = await _state(db, project)
    actions = await _actions(db, project)
    accepted = {action.checkpoint_id for action in actions if action.kind == "delivery" and action.feedback.get("accepted")}
    milestones = []
    for checkpoint in await _rows(db, project):
        stage = _stage_for(checkpoint, state, project)
        available = all(parent in accepted for parent in (checkpoint.prerequisites or []))
        visible = available and (checkpoint_id is None or checkpoint.id == checkpoint_id)
        submissions = [action for action in actions if action.kind == "delivery" and action.checkpoint_id == checkpoint.id]
        milestones.append({"checkpoint_id": checkpoint.id, "key": stage.get("key"),
                           "title": checkpoint.title, "objective": checkpoint.description,
                           "status": "accepted" if checkpoint.id in accepted else "available" if available else "locked",
                           "materials": stage.get("materials", []) if visible else [],
                           "fields": stage.get("fields", []) if visible else [],
                           "required_artifacts": stage.get("required_artifacts", False),
                           "hint_levels": 2 if visible else 0,
                           "hints_used": [{"level": action.payload["level"], "body": action.feedback["body"]}
                                          for action in actions if visible and action.kind == "hint" and action.checkpoint_id == checkpoint.id],
                           "submission": _submission_view(submissions[-1]) if submissions and visible else None,
                           "formal_learning_status": checkpoint.learning_status or "not_started"})
    readings = [{"id": action.id, **{key: action.payload[key] for key in ("source_id", "source_version_id", "locator", "notes")},
                 "created_at": action.created_at.isoformat()} for action in actions if action.kind == "reading"]
    view = {"schema_version": SCHEMA_VERSION, "project_mode": project.project_mode or "learning",
            "revision": state.revision if state else 0, "initialized": bool(state and state.initialized),
            "brief": project.project_brief or {},
            "workbench": state.workbench if state else WorkbenchState().model_dump(),
            "milestones": milestones, "case_ref": state.case_ref if state else None,
            "reading_records": readings[-100:], "mastery_inference": False,
            "activity": [{"id": item.id, "kind": item.kind, "checkpoint_id": item.checkpoint_id,
                          "created_at": item.created_at.isoformat()} for item in actions[-50:]]}
    if compact:
        # No note body, future materials, evaluator or unrelated checkpoint submissions in Tutor context.
        view.pop("workbench")
        view["reading_records"] = [{key: value for key, value in item.items() if key != "notes"} for item in readings[-8:]]
        for item in view["milestones"]:
            if item["submission"]:
                item["submission"]["answers"] = {key: value[:1800] for key, value in item["submission"]["answers"].items()}
    return view


async def initialize_workflow(db: AsyncSession, project: Project, data: dict) -> dict:
    payload = {"operation": "initialize", **data}
    if await _replay(db, project, data["client_action_id"], payload):
        return await workflow_view(db, project)
    state = await _state(db, project, create=True)
    if state.initialized:
        raise HTTPException(409, "项目工作流已经初始化；不能替换进行中的案例或路线")
    case = None
    if project.project_mode == "practice":
        if not all(data.get(key) for key in ("case_id", "case_version", "case_root_hash")):
            raise HTTPException(422, "实践项目需要明确确认案例及其版本摘要")
        case = get_case(data["case_id"], data["case_version"], data["case_root_hash"])
    elif data.get("case_id"):
        raise HTTPException(422, "仅实践型项目可以绑定岗位案例")
    existing = await _rows(db, project)
    if case and existing:
        raise HTTPException(409, "已有路线不能被案例覆盖，请新建实践项目")
    if not existing:
        stages = case["stages"] if case else _default_stages(project.project_mode or "learning", project)
        roadmap = await db.scalar(select(Roadmap).where(Roadmap.project_id == project.id))
        if not roadmap:
            roadmap = Roadmap(project_id=project.id, raw_json={}, conversation_history=[])
            db.add(roadmap)
            await db.flush()
        prior: int | None = None
        raw = []
        for index, stage in enumerate(stages, 1):
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id, order=index, title=stage["title"], description=stage["objective"],
                prerequisites=[prior] if prior else [], archived=False, learning_status="not_started",
                brief={"project_theme": project.name, "checkpoint_key": stage["key"],
                       "objective": stage["objective"], "workflow_template": SCHEMA_VERSION},
                learning_contract=normalize_teaching_contract({
                    "project_theme": project.name, "exit_criteria": [stage["objective"]],
                    "estimated_minutes": 45, "knowledge_target": {"checkpoint_key": stage["key"]},
                    "practice_target": {"requires_generation": True},
                    "must_preserve": [stage["objective"]], "avoid": ["将流程完成当成掌握", "泄露未来案例材料"],
                }, objective=stage["objective"], outcomes=[stage["objective"]]),
            )
            db.add(checkpoint)
            await db.flush()
            prior = checkpoint.id
            raw.append({"id": checkpoint.id, "key": stage["key"], "title": checkpoint.title,
                        "objective": checkpoint.description, "order": index,
                        "prerequisites": checkpoint.prerequisites, "success_criteria": [stage["objective"]], "estimated_minutes": 45})
        roadmap.raw_json = {"schema_version": "vnext.project.v1", "project_theme": project.name,
                            "revision": 1, "rationale": "学习者确认模式任务书", "checkpoints": raw}
        await ensure_all_checkpoint_learning_tasks(db, learner_id=project.learner_id, project_id=project.id)
        await record_event(db, learner_id=project.learner_id, project_id=project.id,
                           event_type="roadmap_applied", source="ui",
                           payload={"project_id": project.id, "project_theme": project.name, "roadmap_id": roadmap.id,
                                    "checkpoints": raw, "mastery_unchanged": True},
                           provenance={"service": "project_workflows", "explicit_click": True, "proposal_origin": "bundled_template"},
                           client_event_id=f"workflow:{project.id}:{data['client_action_id']}:roadmap")
    state.initialized = True
    state.case_ref = case_summary(case) if case else None
    state.revision += 1
    await _record(db, project, data["client_action_id"], "initialize", payload,
                  event_type="project_workflow_initialized")
    return await workflow_view(db, project)


async def save_workbench(db: AsyncSession, project: Project, data: dict) -> dict:
    payload = {"operation": "workbench", **data}
    if await _replay(db, project, data["client_action_id"], payload):
        return await workflow_view(db, project)
    state = await _state(db, project, create=True)
    workbench = data["workbench"]
    cp_id = workbench.get("active_checkpoint_id")
    checkpoint_ids = {item.id for item in await _rows(db, project)}
    if cp_id and cp_id not in checkpoint_ids:
        raise HTTPException(422, "恢复位置不属于当前项目")
    if any(key not in {str(item) for item in checkpoint_ids} for key in workbench.get("delivery_drafts", {})):
        raise HTTPException(422, "交付草稿必须属于当前项目的正式关卡")
    ids = [paper["id"] for paper in workbench["papers"]]
    if len(ids) != len(set(ids)) or (workbench.get("active_paper_id") and workbench["active_paper_id"] not in ids):
        raise HTTPException(422, "纸张编号重复或活动纸张不存在")
    result = await db.execute(update(ProjectWorkflowState).where(
        ProjectWorkflowState.id == state.id, ProjectWorkflowState.revision == data["expected_revision"],
    ).values(workbench=workbench, revision=data["expected_revision"] + 1))
    if result.rowcount != 1:
        raise HTTPException(409, "工作台已被另一处更新，请重新载入后合并草稿")
    await db.refresh(state)
    await _record(db, project, data["client_action_id"], "workbench", payload,
                  event_type="project_workbench_saved")
    return await workflow_view(db, project)


async def _validate_refs(db: AsyncSession, project: Project, checkpoint_id: int, refs: list[dict]) -> None:
    for ref in refs:
        if ref["kind"] == "source_version":
            row = await db.scalar(select(SourceVersion).join(Source).where(
                SourceVersion.id == int(ref["ref"]) if ref["ref"].isdigit() else False,
                Source.project_id == project.id, Source.status == "processed",
            ))
            if not row:
                raise HTTPException(422, "来源版本不属于当前项目或尚未处理")
        elif ref["kind"] == "experiment_run":
            from app.models.experiment import ExperimentRun
            row = await db.get(ExperimentRun, int(ref["ref"])) if ref["ref"].isdigit() else None
            if (not row or row.project_id != project.id or row.learner_id != project.learner_id
                    or row.status != "completed" or row.action not in {"run", "verify"}
                    or (row.checkpoint_id is not None and row.checkpoint_id != checkpoint_id)):
                raise HTTPException(422, "实验引用必须是本项目、本关或项目范围内已成功完成的运行或验证")
        elif ref["kind"] == "workspace_file":
            # File refs are checked against disk and require a version hash.
            if not ref.get("revision"):
                raise HTTPException(422, "项目文件引用必须包含内容摘要")
            # Use the same path/ownership guard as the existing desktop service.
            from app.models.project import ProjectWorkspace
            workspace = await db.scalar(select(ProjectWorkspace).where(
                ProjectWorkspace.project_id == project.id, ProjectWorkspace.learner_id == project.learner_id,
                ProjectWorkspace.status == "linked"))
            if not workspace:
                raise HTTPException(422, "项目尚未关联文件夹")
            from app.services.workspace_files import read_workspace_file, WorkspaceError
            try:
                value = read_workspace_file(Path(workspace.root_path), ref["ref"])
            except WorkspaceError as exc:
                raise HTTPException(exc.status_code, exc.detail) from exc
            if value.get("sha256") != ref["revision"]:
                raise HTTPException(409, "引用文件已变化，请更新引用")
        elif ref["kind"] == "learning_file":
            # Reuse formal file refs; never accept an arbitrary cross-project numeric id.
            kind, _, number = ref["ref"].partition(":")
            ids = {item.id for item in await _rows(db, project)}
            if kind == "practice" and number.startswith("questions-"):
                raw_id = number.removeprefix("questions-")
                cp_id = int(raw_id) if raw_id.isdigit() else 0
                question = await db.scalar(select(ConceptQuestion.id).where(ConceptQuestion.checkpoint_id == cp_id).limit(1))
                if cp_id not in ids or not question:
                    raise HTTPException(422, "受管题组不属于当前项目")
                continue
            if kind == "practice" and number.startswith("exercise-"):
                kind, number = "exercise", number.removeprefix("exercise-")
            model = Lecture if kind == "lecture" else Exercise if kind == "exercise" else None
            row = await db.get(model, int(number)) if model and number.isdigit() else None
            if not row or row.checkpoint_id not in ids:
                raise HTTPException(422, "受管文件不属于当前项目")


async def deliver_checkpoint(db: AsyncSession, project: Project, checkpoint_id: int, data: dict) -> dict:
    payload = {"operation": "delivery", "checkpoint_id": checkpoint_id, **data}
    if await _replay(db, project, data["client_action_id"], payload):
        return await workflow_view(db, project)
    state = await _state(db, project)
    if not state or not state.initialized:
        raise HTTPException(409, "请先确认项目任务书")
    checkpoint = next((item for item in await _rows(db, project) if item.id == checkpoint_id), None)
    if not checkpoint:
        raise HTTPException(404, "项目关卡不存在")
    actions = await _actions(db, project)
    accepted = {item.checkpoint_id for item in actions if item.kind == "delivery" and item.feedback.get("accepted")}
    if checkpoint_id in accepted:
        raise HTTPException(409, "该交付已经通过；请在纸张补充复盘，保留已验收版本")
    if any(parent not in accepted for parent in checkpoint.prerequisites or []):
        raise HTTPException(409, "前置交付尚未通过，后续材料尚未开放")
    await _validate_refs(db, project, checkpoint_id, data["artifact_refs"])
    stage = _stage_for(checkpoint, state, project)
    answers = data["answers"]
    checks = [{"key": field["key"], "label": field["label"], "passed": bool(answers.get(field["key"], "").strip()),
               "detail": "内容将保留给导师评审；提交文字本身不证明理解。"} for field in stage.get("fields", [])]
    def add(key: str, label: str, passed: bool, detail: str):
        checks.append({"key": key, "label": label, "passed": passed, "detail": detail})
    validator = stage.get("validator")
    if state.case_ref:
        checks.extend(evaluate_case(stage, answers))
    elif validator == "source":
        add("source", "固定来源版本", any(ref["kind"] == "source_version" for ref in data["artifact_refs"]), "请选择本项目已处理的来源版本作为依据。")
    elif validator == "reading":
        add("reading", "带位置的阅读记录", any(item.kind == "reading" for item in actions), "请在来源页保存章节或页码与阅读记录。")
    elif validator == "experiment_run":
        add("run", "可复现的实验运行", any(ref["kind"] == "experiment_run" for ref in data["artifact_refs"]), "请引用本项目一次已结束的真实实验运行；运行结果只证明操作事实。")
    elif validator == "formal_verification":
        task = await db.scalar(select(LearningTask).where(LearningTask.learner_id == project.learner_id, LearningTask.checkpoint_id == checkpoint_id))
        view = await learning_task_view(db, task) if task else {}
        evidence = view.get("runtime", {}).get("evidence", {})
        add("verification", "正式独立验证", evidence.get("successful_verifications", 0) > 0, "请进入本关正式任务完成独立验证，不能用文字或勾选代替。")
        add("review", "正式复习安排", evidence.get("review_items", 0) > 0, "请在正式学习任务中建立复习安排。")
    elif validator == "artifact":
        add("artifact", "交付物引用", bool(data["artifact_refs"]), "请附本项目可检查的交付物引用。")
    passed = all(item["passed"] for item in checks)
    effective_assistance = data["assistance_level"]
    if effective_assistance == "independent" and any(item.kind == "hint" and item.checkpoint_id == checkpoint_id for item in actions):
        effective_assistance = "hint"
    feedback = {"accepted": passed, "checks": checks, "review_required": True,
                "effective_assistance_level": effective_assistance,
                "summary": "交付检查通过；解释与设计质量仍需导师评审。" if passed else "交付尚有未满足项，请按检查结果修改后重新提交。",
                "mastery_inference": False}
    await _record(db, project, data["client_action_id"], "delivery", payload, feedback, checkpoint_id,
                  event_type="project_delivery_submitted")
    return await workflow_view(db, project)


async def record_reading(db: AsyncSession, project: Project, data: dict) -> dict:
    payload = {"operation": "reading", **data}
    if await _replay(db, project, data["client_action_id"], payload):
        return await workflow_view(db, project)
    version = await db.scalar(select(SourceVersion).join(Source).where(
        SourceVersion.id == data["source_version_id"], SourceVersion.source_id == data["source_id"],
        Source.project_id == project.id, Source.status == "processed",
    ))
    if not version:
        raise HTTPException(422, "只能记录本项目已处理来源的固定版本")
    await _record(db, project, data["client_action_id"], "reading", payload,
                  event_type="project_reading_recorded")
    return await workflow_view(db, project)


async def request_hint(db: AsyncSession, project: Project, checkpoint_id: int, data: dict) -> dict:
    payload = {"operation": "hint", "checkpoint_id": checkpoint_id, **data}
    if await _replay(db, project, data["client_action_id"], payload):
        row = await db.scalar(select(ProjectWorkflowSubmission).where(
            ProjectWorkflowSubmission.project_id == project.id,
            ProjectWorkflowSubmission.client_action_id == data["client_action_id"]))
        return {"hint": {"level": data["level"], "body": row.feedback["body"]}, "workflow": await workflow_view(db, project)}
    state = await _state(db, project)
    checkpoint = next((item for item in await _rows(db, project) if item.id == checkpoint_id), None)
    if not checkpoint or not state or not state.initialized:
        raise HTTPException(404, "项目阶段尚未建立")
    actions = await _actions(db, project)
    accepted = {item.checkpoint_id for item in actions if item.kind == "delivery" and item.feedback.get("accepted")}
    if checkpoint_id in accepted or any(parent not in accepted for parent in checkpoint.prerequisites or []):
        raise HTTPException(409, "只能请求当前尚未完成阶段的提示")
    stage = _stage_for(checkpoint, state, project)
    hints = stage.get("hints") or [
        "先把本关的目标、输入、预期输出和限制逐项写清楚。对照材料，提出一个最小的可检查问题。",
        "把预测、实际观察、解释和下一步分开。每次只改一个条件，保存可复现依据；正式独立验证仍需在本关学习任务中完成。",
    ]
    body = hints[data["level"] - 1]
    await _record(db, project, data["client_action_id"], "hint", payload,
                  {"body": body, "mastery_inference": False}, checkpoint_id,
                  event_type="project_assistance_requested")
    return {"hint": {"level": data["level"], "body": body}, "workflow": await workflow_view(db, project)}
