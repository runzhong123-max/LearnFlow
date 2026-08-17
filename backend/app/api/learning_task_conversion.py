"""LearnFlow-facing API for the岗位典型工作任务转化 adapter."""
from __future__ import annotations

import re
from hashlib import sha256
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.models.learning import AgentMessage, AgentSession
from app.services.auth import CurrentLearner, get_current_learner
from app.services.learning_task_conversion_gateway import (
    LearningTaskConversionError,
    LearningTaskConversionGateway,
)
from app.services.learning_task_conversion_xfyun import (
    XfyunLearningTaskWorkflowClient,
    XfyunWorkflowConfigError,
    XfyunWorkflowError,
)
from app.services.learning_runtime import record_event


router = APIRouter(
    prefix="/learning-task-conversion",
    tags=["岗位典型工作任务转化集成"],
)


class LearningTaskGenerationRequest(BaseModel):
    query: str = Field(min_length=2, max_length=2000)
    session_id: int | None = Field(default=None, ge=1)
    client_turn_id: str | None = Field(default=None, min_length=3, max_length=120)


def _knowledge_handoff_entry(
    bundle: dict[str, Any],
    task_card_id: str,
    knowledge_id: str,
) -> dict[str, Any]:
    """Build the smallest complete handoff for one personalized-learning focus."""

    task_envelope = bundle.get("task")
    work_task = (
        task_envelope.get("work_task")
        if isinstance(task_envelope, dict)
        else None
    )
    if not isinstance(work_task, dict):
        raise LearningTaskConversionError(
            "个性化学习交接缺少学习型工作任务",
            status_code=422,
        )

    knowledge_points = work_task.get("knowledge_points") or []
    knowledge = next(
        (
            item for item in knowledge_points
            if isinstance(item, dict)
            and str(item.get("knowledge_id") or "") == knowledge_id
        ),
        None,
    )
    if knowledge is None:
        raise LearningTaskConversionError(
            "当前学习型任务中不存在该知识点",
            status_code=404,
        )

    source_steps = [
        step for step in work_task.get("task_steps") or []
        if isinstance(step, dict)
        and knowledge_id in {
            str(value) for value in step.get("knowledge_point_ids") or []
        }
    ]
    if not source_steps:
        raise LearningTaskConversionError(
            "该知识点没有可追溯的任务步骤映射",
            status_code=422,
        )

    skill_ids = {
        str(skill_id)
        for step in source_steps
        for skill_id in step.get("skill_point_ids") or []
        if str(skill_id).strip()
    }
    skill_ids.update(
        str(skill_id)
        for skill_id in knowledge.get("related_skill_ids") or []
        if str(skill_id).strip()
    )
    related_skills = [
        skill for skill in work_task.get("skill_points") or []
        if isinstance(skill, dict)
        and str(skill.get("skill_id") or "") in skill_ids
    ]

    explicit_relations = [
        relation for relation in bundle.get("strong_relationships") or []
        if isinstance(relation, dict)
        and str(relation.get("knowledge_id") or "") == knowledge_id
    ]
    if explicit_relations:
        relationships = explicit_relations
    else:
        relationships = [
            {
                "relation_id": f"{step.get('step_id')}:{knowledge_id}",
                "relation_type": "required_for_step",
                "strength": "strong",
                "step_id": str(step.get("step_id") or ""),
                "knowledge_id": knowledge_id,
                "skill_ids": [
                    str(value) for value in step.get("skill_point_ids") or []
                ],
                "basis": "validated_step_mapping",
                "reason": "该知识点与技能点由已校验任务步骤显式共同引用。",
            }
            for step in source_steps
        ]

    entry_seed = f"{task_card_id}:{knowledge_id}"
    entry_id = f"ple_{sha256(entry_seed.encode('utf-8')).hexdigest()[:24]}"
    artifacts = bundle.get("artifacts") if isinstance(bundle.get("artifacts"), dict) else {}
    entry_path = (
        "/personalized-learning/tasks/"
        f"{task_card_id}/knowledge/{knowledge_id}"
    )
    handoff_path = (
        "/api/learning-task-conversion/tasks/"
        f"{task_card_id}/knowledge/{knowledge_id}/personalized-learning-entry"
    )

    return {
        "schema_version": "learning-task-knowledge-to-personalized-learning-v1",
        "entry_id": entry_id,
        "status": "ready",
        "source": {
            "source_system": "learning-work-task-conversion",
            "task_card_id": task_card_id,
            "verification_status": str(bundle.get("verification_status") or ""),
            "full_handoff_json_url": str(
                artifacts.get("personalized_learning_json_url") or ""
            ),
        },
        "task_context": {
            "work_task_id": str(work_task.get("work_task_id") or ""),
            "enterprise_task_name": str(
                work_task.get("enterprise_task_name") or ""
            ),
            "enterprise_task_description": str(
                work_task.get("enterprise_task_description") or ""
            ),
            "teaching_task_name": str(work_task.get("teaching_task_name") or ""),
            "teaching_task_description": str(
                work_task.get("teaching_task_description") or ""
            ),
            "work_situation": work_task.get("work_situation"),
        },
        "focus": {
            "knowledge_point": knowledge,
            "source_steps": source_steps,
            "strongly_related_skills": related_skills,
            "relationships": relationships,
        },
        "generation_contract": {
            "purpose": "围绕选中知识点生成个性化学习目标、内容、练习与评价。",
            "immutable_fields": [
                "task_context.work_task_id",
                "task_context.enterprise_task_name",
                "focus.source_steps[].step_id",
                "focus.source_steps[].action",
                "focus.source_steps[].deliverable",
                "focus.source_steps[].check",
                "focus.relationships",
            ],
            "downstream_may_generate": [
                "learning_objectives",
                "learning_content",
                "learning_sequence",
                "practice_activities",
                "assessment_plan",
                "learner_adaptations",
            ],
            "must_preserve_relation_traceability": True,
        },
        "feedback_contract": {
            "schema_version": "personalized-learning-to-task-conversion-feedback-v1",
            "method": "POST",
            "url": "/api/learning-task-conversion/downstream-feedback",
            "supported_issue_targets": [
                "step_id", "knowledge_id", "skill_id", "relation_id",
            ],
        },
        "navigation": {
            "route_key": "personalized_learning.generate_from_knowledge",
            "entry_path": entry_path,
            "handoff_json_path": handoff_path,
            "return_path": f"/wf03/tasks/{task_card_id}",
        },
    }


def _gateway() -> LearningTaskConversionGateway:
    return LearningTaskConversionGateway()


def _xfyun_client() -> XfyunLearningTaskWorkflowClient:
    # This client alone reads backend/.private/learning_task_conversion.xfyun.env.
    # Do not move these credentials into app.core.config or the global .env.
    return XfyunLearningTaskWorkflowClient()


def _raise_gateway_error(exc: LearningTaskConversionError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _raise_xfyun_error(
    exc: XfyunWorkflowError | XfyunWorkflowConfigError,
) -> None:
    status_code = getattr(exc, "status_code", 503)
    raise HTTPException(status_code=status_code, detail=str(exc)) from exc


def _task_card_id_from_content(content: str) -> str:
    patterns = (
        r"/learning-task-conversion/tasks/(ltc_[A-Za-z0-9_-]{1,96})/",
        r"/learning-tasks/(ltc_[A-Za-z0-9_-]{1,96})/",
        r'"task_card_id"\s*:\s*"(ltc_[A-Za-z0-9_-]{1,96})"',
    )
    for pattern in patterns:
        match = re.search(pattern, content)
        if match:
            return match.group(1)
    return ""


def _failure_reason_from_content(content: str) -> str:
    """Extract a short public reason without exposing workflow internals."""

    match = re.search(r'"hard_errors"\s*:\s*\[\s*"([^"]+)"', content)
    if match:
        return match.group(1).strip()
    match = re.search(r'"errors"\s*:\s*\[\s*"([^"]+)"', content)
    if match:
        return match.group(1).strip()
    return "当前候选任务尚未通过内容与证据门禁"


def _non_success_result(
    workflow_run: dict[str, Any],
    user_input: str,
) -> dict[str, Any]:
    content = str(workflow_run.get("content") or "").strip()
    clarification_markers = (
        "请补充", "还无法从这句话确定", "不能唯一确定", "需要确认一个",
    )
    if any(marker in content for marker in clarification_markers):
        # Workflow output may contain provider-only URLs or empty Markdown
        # links. Clarification is a fixed public response, never a pass-through
        # of orchestration content.
        message = _clarification_result(user_input)["message"]
        status = "needs_clarification"
    else:
        reason = _failure_reason_from_content(content)
        message = (
            f"我已经锁定“{user_input}”这个方向，但当前草稿还不能发布：{reason}。"
            "你可以补充更具体的工作对象或交付结果，我会沿用本轮继续生成；"
            "如果这是岗位方向，系统也会继续从岗位中选择一个可执行的典型工作任务。"
        )
        status = "needs_revision"
    return {
        "schema_version": "learnflow-learning-task-generation-v2",
        "execute_id": workflow_run.get("run_id") or "",
        "status": status,
        "task_card_id": "",
        "message": message,
        "usage": workflow_run.get("usage") or {},
        "bundle": None,
    }


def _fresh_workflow_uid(learner_id: int) -> str:
    """Keep every task-conversion run isolated from Xingchen stage state."""

    return f"lf-{learner_id}-{uuid4().hex[:24]}"


def _is_workflow_stage_conflict(exc: XfyunWorkflowError) -> bool:
    message = str(exc)
    return "21812" in message or "当前阶段" in message or "INTAKE" in message


def _clarification_result(user_input: str) -> dict[str, Any]:
    """Translate Xingchen's INTAKE state into a user-facing follow-up turn."""

    return {
        "schema_version": "learnflow-learning-task-generation-v2",
        "execute_id": "",
        "status": "needs_clarification",
        "task_card_id": "",
        "message": (
            f"我已识别到你想围绕“{user_input}”生成学习型工作任务，但目前还不能唯一确定"
            "要转换的企业真实工作任务。请再补充一个可执行对象或结果，例如："
            "“Linux系统安装与基础配置”“风力发电机组日常巡检”或"
            "“新能源汽车电池包安装”。补充后我会沿用本次功能继续生成。"
        ),
        "usage": {},
        "bundle": None,
    }


async def _owned_generation_session(
    db: AsyncSession,
    learner_id: int,
    session_id: int | None,
) -> AgentSession | None:
    if session_id is None:
        return None
    session = (await db.execute(select(AgentSession).where(
        AgentSession.id == session_id,
        AgentSession.learner_id == learner_id,
        AgentSession.status == "active",
    ))).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="当前任务生成会话不存在或已结束")
    return session


async def _replay_generation_result(
    db: AsyncSession,
    session: AgentSession | None,
    client_turn_id: str,
) -> dict[str, Any] | None:
    if session is None:
        return None
    idempotency_key = f"learning-task-result:{session.learner_id}:{client_turn_id}"
    message = (await db.execute(select(AgentMessage).where(
        AgentMessage.session_id == session.id,
        AgentMessage.idempotency_key == idempotency_key,
    ))).scalar_one_or_none()
    if message is None:
        return None
    stored = dict((message.meta_data or {}).get("generation_result") or {})
    task_card_id = str(stored.get("task_card_id") or "")
    bundle = await _gateway().task_bundle(task_card_id) if task_card_id else None
    return {
        "schema_version": "learnflow-learning-task-generation-v2",
        "execute_id": str(stored.get("execute_id") or ""),
        "status": str(stored.get("status") or "needs_revision"),
        "task_card_id": task_card_id,
        "message": message.content,
        "usage": {},
        "bundle": bundle,
        "replayed": True,
    }


async def _persist_generation_exchange(
    db: AsyncSession,
    session: AgentSession | None,
    *,
    client_turn_id: str,
    user_input: str,
    result: dict[str, Any],
) -> None:
    if session is None:
        return
    learner_id = session.learner_id
    request_key = f"learning-task-request:{learner_id}:{client_turn_id}"
    result_key = f"learning-task-result:{learner_id}:{client_turn_id}"
    request_statement = sqlite_insert(AgentMessage).values(
        session_id=session.id,
        role="user",
        content=user_input,
        meta_data={
            "message_kind": "learning_task_request",
            "client_turn_id": client_turn_id,
        },
        idempotency_key=request_key,
    ).on_conflict_do_nothing(index_elements=["idempotency_key"])
    await db.execute(request_statement)
    public_result = {
        "status": result["status"],
        "task_card_id": result.get("task_card_id") or "",
        "execute_id": result.get("execute_id") or "",
    }
    result_statement = sqlite_insert(AgentMessage).values(
        session_id=session.id,
        role="assistant",
        content=str(result.get("message") or ""),
        meta_data={
            "message_kind": (
                "learning_task_generated"
                if result["status"] == "success"
                else "learning_task_follow_up"
            ),
            "generation_result": public_result,
            "client_turn_id": client_turn_id,
        },
        idempotency_key=result_key,
    ).on_conflict_do_nothing(index_elements=["idempotency_key"])
    inserted_result = await db.execute(result_statement)
    if inserted_result.rowcount:
        await record_event(
            db,
            learner_id=learner_id,
            event_type=(
                "learning_work_task_generated"
                if result["status"] == "success"
                else "learning_work_task_generation_follow_up"
            ),
            source="learning_task_conversion",
            session_id=session.id,
            payload={
                "query": user_input,
                **public_result,
            },
            artifact_refs=(
                [f"learning-task:{result['task_card_id']}"]
                if result.get("task_card_id") else []
            ),
            client_event_id=f"learning-task:{client_turn_id}",
        )
    await db.commit()


async def _run_isolated_workflow(
    client: XfyunLearningTaskWorkflowClient,
    user_input: str,
    *,
    learner_id: int,
) -> dict[str, Any]:
    """Run in a fresh provider session and self-heal one stale-stage failure."""

    try:
        return await client.run(
            user_input,
            uid=_fresh_workflow_uid(learner_id),
        )
    except XfyunWorkflowError as exc:
        if not _is_workflow_stage_conflict(exc):
            raise
        return await client.run(
            user_input,
            uid=_fresh_workflow_uid(learner_id),
        )


@router.post("/workflow-runs")
async def run_learning_task_conversion_workflow(
    payload: dict[str, Any] = Body(...),
    current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    """Run only the bound Plan workflow for this feature.

    Callers cannot provide a host, API key, secret, or flow ID.  Those values
    stay in the ignored feature-private file, preventing this endpoint from
    becoming a generic Xingchen proxy.
    """

    user_input = str(payload.get("user_input") or "").strip()
    if not user_input:
        raise HTTPException(status_code=422, detail="请提供明确的岗位典型工作任务")
    if len(user_input) > 2000:
        raise HTTPException(status_code=422, detail="岗位典型工作任务描述不能超过2000字")

    try:
        return await _run_isolated_workflow(
            _xfyun_client(),
            user_input,
            learner_id=current.learner.id,
        )
    except (XfyunWorkflowError, XfyunWorkflowConfigError) as exc:
        _raise_xfyun_error(exc)


@router.post("/generate")
async def generate_learning_task_from_conversation(
    request: LearningTaskGenerationRequest,
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Generate and resolve one task into the LearnFlow review workspace.

    The endpoint composes the feature-private Xingchen workflow with the fixed
    artifact gateway.  It never accepts credentials, hosts, or flow IDs from
    the browser.
    """

    user_input = request.query.strip()
    client_turn_id = request.client_turn_id or f"learning-task-{uuid4().hex}"
    session = await _owned_generation_session(
        db, current.learner.id, request.session_id,
    )
    replayed = await _replay_generation_result(db, session, client_turn_id)
    if replayed is not None:
        return replayed

    try:
        workflow_run = await _run_isolated_workflow(
            _xfyun_client(),
            user_input,
            learner_id=current.learner.id,
        )
        task_card_id = _task_card_id_from_content(workflow_run["content"])
        if not task_card_id:
            result = _non_success_result(workflow_run, user_input)
            await _persist_generation_exchange(
                db, session, client_turn_id=client_turn_id,
                user_input=user_input, result=result,
            )
            return result
        bundle = await _gateway().task_bundle(task_card_id)
        local_url = f"/wf03/tasks/{task_card_id}"
        result = {
            "schema_version": "learnflow-learning-task-generation-v2",
            "execute_id": workflow_run.get("run_id") or "",
            "status": "success",
            "task_card_id": task_card_id,
            "message": (
                "学习型任务已经生成并在中间工作区打开。"
                "你可以按步骤查看产物与验收点，点击知识点直接进入个性化学习。\n\n"
                f"[查看学习型任务]({local_url})"
            ),
            "usage": workflow_run.get("usage") or {},
            "bundle": bundle,
        }
        await _persist_generation_exchange(
            db, session, client_turn_id=client_turn_id,
            user_input=user_input, result=result,
        )
        return result
    except (XfyunWorkflowError, XfyunWorkflowConfigError) as exc:
        if isinstance(exc, XfyunWorkflowError) and _is_workflow_stage_conflict(exc):
            result = _clarification_result(user_input)
            await _persist_generation_exchange(
                db, session, client_turn_id=client_turn_id,
                user_input=user_input, result=result,
            )
            return result
        _raise_xfyun_error(exc)
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.get("/capabilities")
async def get_learning_task_conversion_capabilities(
    _current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    try:
        return await _gateway().capabilities()
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.post("/upstream-handoffs")
async def submit_competency_graph_handoff(
    payload: dict[str, Any] = Body(...),
    _current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    try:
        return await _gateway().submit_upstream_handoff(payload)
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.get("/tasks/{task_card_id}/bundle")
async def get_learning_task_conversion_bundle(
    task_card_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    _current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    try:
        return await _gateway().task_bundle(task_card_id)
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.get("/tasks/{task_card_id}/personalized-learning")
async def get_personalized_learning_handoff(
    task_card_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    _current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    try:
        return await _gateway().personalized_learning_handoff(task_card_id)
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.get(
    "/tasks/{task_card_id}/knowledge/{knowledge_id}/personalized-learning-entry"
)
async def get_knowledge_personalized_learning_entry(
    task_card_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    knowledge_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    _current: CurrentLearner = Depends(get_current_learner),
) -> dict[str, Any]:
    """Return a knowledge-scoped, versioned JSON handoff for downstream use."""

    try:
        bundle = await _gateway().task_bundle(task_card_id)
        return _knowledge_handoff_entry(bundle, task_card_id, knowledge_id)
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.post(
    "/tasks/{task_card_id}/knowledge/{knowledge_id}/personalized-learning-entry"
)
async def open_knowledge_personalized_learning_entry(
    task_card_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    knowledge_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,100}$"),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Prepare the handoff and record the explicit cross-function navigation."""

    try:
        bundle = await _gateway().task_bundle(task_card_id)
        entry = _knowledge_handoff_entry(bundle, task_card_id, knowledge_id)
        await record_event(
            db,
            learner_id=current.learner.id,
            event_type="personalized_learning_handoff_opened",
            source="learning_task_conversion",
            payload={
                "entry_id": entry["entry_id"],
                "task_card_id": task_card_id,
                "knowledge_id": knowledge_id,
                "schema_version": entry["schema_version"],
            },
            artifact_refs=[
                f"learning-task:{task_card_id}",
                f"knowledge:{knowledge_id}",
            ],
            client_event_id=f"personalized-entry:{current.learner.id}:{entry['entry_id']}",
        )
        await db.commit()
        return entry
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)


@router.post("/downstream-feedback")
async def submit_personalized_learning_feedback(
    payload: dict[str, Any] = Body(...),
    current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    issues = payload.get("issues")
    if issues is None:
        issues = []
    elif not isinstance(issues, list):
        raise HTTPException(status_code=422, detail="issues 必须是数组")
    try:
        result = await _gateway().submit_downstream_feedback(payload)
        task_card_id = str(payload.get("task_card_id") or "")
        await record_event(
            db,
            learner_id=current.learner.id,
            event_type="learning_work_task_review_submitted",
            source="learning_task_conversion",
            payload={
                "task_card_id": task_card_id,
                "issue_count": len(issues),
                "status": str(payload.get("status") or ""),
            },
            artifact_refs=([f"learning-task:{task_card_id}"] if task_card_id else []),
            client_event_id=str(payload.get("correlation_id") or uuid4()),
        )
        await db.commit()
        return result
    except LearningTaskConversionError as exc:
        _raise_gateway_error(exc)
