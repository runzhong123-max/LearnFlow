"""Actual file progress, bounded support and pause/resume regression coverage."""
import asyncio
from datetime import timedelta
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.main import app
from app.db.database import async_session
from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, LearningSkillRun, LearningTask
from app.models.project import Checkpoint, ConceptQuestion, Lecture, Project, Roadmap
from app.services.learning_runtime import create_attempt, record_event
from app.services.learning_skill_runtime import SUPPORT_TURN_BUDGET, pause_active_skill_run_for_selection, transition_learning_skill_turn

@pytest.fixture(scope="module")
def client():
    with TestClient(app) as client:
        user = next(row for row in client.get("/api/dev/accounts").json() if row["username"] == "legacy-demo")
        assert client.post(f"/api/dev/accounts/{user['id']}/login").status_code == 200
        client.headers["x-csrf-token"] = client.get("/api/auth/csrf").json()["csrf_token"]
        yield client


def start(client, skill="learning_file_study", goal="程序链接"):
    session = client.post("/api/agent/sessions", json={"session_type": "global", "create_new": True}).json()
    result = client.post(f"/api/agent/sessions/{session['id']}/skill-runs", json={
        "skill_id": skill, "goal": goal, "client_request_id": uuid.uuid4().hex})
    assert result.status_code == 200, result.text
    return session["id"], result.json()["active_skill_run"]


def action(client, session_id, run, name, key=None):
    result = client.post(f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions", json={
        "action": name, "expected_version": run["version"], "client_action_id": key or uuid.uuid4().hex})
    assert result.status_code == 200, result.text
    return result.json()["active_skill_run"]


def turn(client, session_id, run, text):
    result = client.post(f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/turns", json={
        "message": text, "expected_version": run["version"], "client_turn_id": uuid.uuid4().hex})
    assert result.status_code == 200, result.text
    return result.json()


def test_file_chat_cannot_manufacture_progress():
    for message in ("已完成练习", "继续", "我选这份讲义", "文件在哪里", "我不知道"):
        step = transition_learning_skill_turn(skill_id="learning_file_study", current_state="selecting_learning_artifact",
            step_index=1, turn_count=0, support_count=0, goal="程序链接", message=message)
        assert step["state"] == "selecting_learning_artifact"
        assert step["turn_count"] == step["support_count"] == 0
        assert step["advanced"] is False


def test_file_progress_requires_current_owned_reading_and_real_attempt(client):
    session_id, run = start(client)
    run = turn(client, session_id, run, "我都完成了，继续")["active_skill_run"]
    assert run["state"] == "selecting_learning_artifact"

    async def seed():
        async with async_session() as db:
            formal = await db.get(LearningSkillRun, run["id"])
            task = await db.get(LearningTask, formal.learning_task_id)
            project = Project(learner_id=formal.learner_id, name="文件进度测试")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="链接", description="链接机制", order=1)
            db.add(checkpoint)
            await db.flush()
            lecture = Lecture(checkpoint_id=checkpoint.id, sections=[{"title": "符号", "content": "符号解析"}], version=2)
            question = ConceptQuestion(checkpoint_id=checkpoint.id, question="链接做什么", options=["符号解析", "语法分析"], answer_indexes=[0])
            db.add_all([lecture, question])
            await db.flush()
            task.execution_state = {**dict(task.execution_state or {}), "artifact_scope": {"project_id": project.id, "checkpoint_id": checkpoint.id}}
            task.artifact_refs = [{"type": "managed_lecture", "id": lecture.id}, {"type": "concept_question_set", "ids": [question.id]}]
            old = await create_attempt(db, learner_id=formal.learner_id, checkpoint_id=checkpoint.id,
                item_type="concept", item_id=question.id, submission={}, result={"correct": True})
            old.submitted_at = formal.started_at - timedelta(days=1)
            await record_event(db, learner_id=formal.learner_id, project_id=project.id, checkpoint_id=checkpoint.id,
                session_id=session_id, event_type="lecture_viewed", source="ui",
                payload={"lecture_id": lecture.id, "lecture_version": 1, "explicit_completion": True}, client_event_id=uuid.uuid4().hex)
            await db.commit()
            return formal.learner_id, project.id, checkpoint.id, lecture.id, question.id

    learner_id, project_id, checkpoint_id, lecture_id, question_id = asyncio.run(seed())
    run = action(client, session_id, run, "sync_artifacts")
    assert run["state"] == "reading_with_anchor"
    assert run["file_progress"]["attempt_ids"] == run["file_progress"]["read_lecture_ids"] == []
    assert action(client, session_id, run, "sync_artifacts")["version"] == run["version"]

    async def read():
        async with async_session() as db:
            await record_event(db, learner_id=learner_id, project_id=project_id, checkpoint_id=checkpoint_id,
                session_id=session_id, event_type="lecture_viewed", source="ui", payload={
                    "lecture_id": lecture_id, "lecture_version": 2, "explicit_completion": True,
                    "learning_task_id": run["learning_task"]["id"]}, client_event_id=uuid.uuid4().hex)
            await db.commit()
    asyncio.run(read())
    run = action(client, session_id, run, "sync_artifacts")
    assert run["state"] == "practicing_in_file"
    assert run["can_start_verification"] is False
    run = turn(client, session_id, run, "我在聊天里说我答对了")["active_skill_run"]
    assert run["state"] == "practicing_in_file"

    async def submit():
        async with async_session() as db:
            attempt = await create_attempt(db, learner_id=learner_id, checkpoint_id=checkpoint_id,
                item_type="concept", item_id=question_id, submission={"indexes": [1]}, result={"correct": False}, assistance_level="hint")
            await db.commit()
            return attempt.id
    attempt_id = asyncio.run(submit())
    previous, key = run, uuid.uuid4().hex
    run = action(client, session_id, run, "sync_artifacts", key)
    assert run["state"] == "verification_ready"
    assert run["file_progress"]["attempt_ids"] == [attempt_id]
    assert run["turn_count"] == 0
    assert action(client, session_id, previous, "sync_artifacts", key)["version"] == run["version"]

    async def audit():
        async with async_session() as db:
            events = select(EvidenceEvent.id).where(EvidenceEvent.session_id == session_id, EvidenceEvent.event_type == "learning_skill_run_advanced")
            mutations = list((await db.execute(select(KernelMutation).where(KernelMutation.event_id.in_(events)))).scalars())
            session = await db.get(AgentSession, session_id)
            task = await db.get(LearningTask, run["learning_task"]["id"])
            return mutations, session.project_id, task.project_id, task.checkpoint_id
    assert asyncio.run(audit()) == ([], None, None, None)


def test_grounded_choice_applies_once_and_repeated_pause_keeps_anchor(client):
    session_id, run = start(client, "socratic_dialogue", "什么是程序链接")
    run = turn(client, session_id, run, "B")["active_skill_run"]
    assert run["last_response_signal"] == "orientation_example_choice"
    run = turn(client, session_id, run, "B")["active_skill_run"]
    assert run["state"] == "testing_assumption"
    run = action(client, session_id, run, "pause")
    async def switch_again():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            await pause_active_skill_run_for_selection(db, session=session, selected_skill_id=None)
            await pause_active_skill_run_for_selection(db, session=session, selected_skill_id="feynman_dialogue")
            await db.commit()
    asyncio.run(switch_again())
    assert action(client, session_id, run, "resume")["state"] == "testing_assumption"


def test_support_budget_allows_requested_explanation_and_pause(client):
    session_id, run = start(client, "guided_explanation")
    for _ in range(SUPPORT_TURN_BUDGET):
        run = turn(client, session_id, run, "我不知道")["active_skill_run"]
    assert run["support_exit"]["status"] == "required"
    result = turn(client, session_id, run, "请直接解释")
    assert result["active_skill_run"]["version"] == run["version"]
    assert result["turn_plan"]["response_signal"] == "direct_explanation_requested"
    assert result["active_skill_run"]["turn_count"] == 0
    assert action(client, session_id, run, "pause")["status"] == "paused"

@pytest.mark.parametrize("internal", [True, False])
def test_legacy_generated_global_scope_repairs_only_owned_internal_artifacts(client, internal):
    from app.models.learning import MicroLearningRun
    session_id, run = start(client)

    async def seed_legacy_scope():
        async with async_session() as db:
            formal = await db.get(LearningSkillRun, run["id"])
            task = await db.get(LearningTask, formal.learning_task_id)
            project = Project(learner_id=formal.learner_id, name="旧生成包",
                project_kind="task_artifact" if internal else "apprenticeship",
                visibility="internal" if internal else "visible")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title="旧链接文件", order=1)
            db.add(checkpoint)
            await db.flush()
            micro = MicroLearningRun(learner_id=formal.learner_id, project_id=project.id,
                checkpoint_id=checkpoint.id, goal=formal.goal, client_request_id=uuid.uuid4().hex,
                skill_plan={"learning_task_id": task.id})
            db.add(micro)
            await db.flush()
            task.project_id, task.checkpoint_id, task.micro_learning_run_id = project.id, checkpoint.id, micro.id
            await db.commit()
            return project.id, checkpoint.id
    old_project_id, old_checkpoint_id = asyncio.run(seed_legacy_scope())
    response = client.post(f"/api/agent/sessions/{session_id}/skill-runs/{run['id']}/actions", json={
        "action": "sync_artifacts", "expected_version": run["version"], "client_action_id": uuid.uuid4().hex})
    assert response.status_code == (200 if internal else 400), response.text

    async def check():
        async with async_session() as db:
            task = await db.get(LearningTask, run["learning_task"]["id"])
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.client_event_id.endswith(f"learning-skill-run:{run['id']}:legacy-artifact-scope-recovered")))).scalars())
            return task.project_id, task.checkpoint_id, dict(task.execution_state or {}).get("artifact_scope"), len(events)
    if internal:
        assert asyncio.run(check()) == (None, None, {"project_id": old_project_id, "checkpoint_id": old_checkpoint_id}, 1)
        restored = response.json()["active_skill_run"]
        action(client, session_id, restored, "sync_artifacts")
        assert asyncio.run(check())[-1] == 1
    else:
        assert asyncio.run(check()) == (old_project_id, old_checkpoint_id, None, 0)


def _ready_generated_file(client, goal="程序链接"):
    session_id, run = start(client, goal=goal)
    task = client.get(f"/api/learning-tasks/{run['learning_task']['id']}").json()
    generated = client.post(f"/api/learning-files/tasks/{task['id']}/generate", json={
        "expected_version": task["version"], "client_request_id": uuid.uuid4().hex,
        "file_kinds": ["lecture", "practice"],
    })
    assert generated.status_code == 200, generated.text
    task = generated.json()
    lecture_id = next(ref["id"] for ref in task["artifact_refs"] if ref["type"] == "managed_lecture")
    question_ids = next(ref["ids"] for ref in task["artifact_refs"] if ref["type"] == "concept_question_set")

    async def file_activity():
        async with async_session() as db:
            lecture = await db.get(Lecture, lecture_id)
            formal = await db.get(LearningSkillRun, run["id"])
            scope = task["execution_state"]["artifact_scope"]
            await record_event(db, learner_id=formal.learner_id, project_id=scope["project_id"],
                checkpoint_id=scope["checkpoint_id"], session_id=session_id, event_type="lecture_viewed", source="ui",
                payload={"lecture_id": lecture.id, "lecture_version": lecture.version, "explicit_completion": True},
                client_event_id=uuid.uuid4().hex)
            for question_id in question_ids:
                await create_attempt(db, learner_id=formal.learner_id, checkpoint_id=scope["checkpoint_id"],
                    item_type="concept", item_id=question_id, submission={}, result={"correct": True})
            await db.commit()
    asyncio.run(file_activity())
    run = action(client, session_id, run, "sync_artifacts")
    assert run["state"] == "verification_ready"
    return session_id, run, task, question_ids


def test_file_verification_uses_new_scenarios_and_closes_with_real_variant(client):
    from app.models.learning import MicroLearningRun
    from app.services.micro_learning import normalize_question_stem
    session_id, run, task, original_ids = _ready_generated_file(client)
    run = action(client, session_id, run, "start_verification")
    micro_id = run["micro_learning_run"]["id"]

    async def read():
        async with async_session() as db:
            micro = await db.get(MicroLearningRun, micro_id)
            original = list((await db.execute(select(ConceptQuestion).where(ConceptQuestion.id.in_(original_ids)))).scalars())
            fresh = list((await db.execute(select(ConceptQuestion).where(ConceptQuestion.checkpoint_id == micro.checkpoint_id))).scalars())
            stored_task = await db.get(LearningTask, task["id"])
            stems = lambda rows: {normalize_question_stem(text) for row in rows for text in
                (row.question, row.assessment_meta["variant"]["prompt"])}
            assert not stems(original) & stems(fresh)
            assert len(stems(fresh)) == 2 * len(fresh)
            assert stored_task.project_id is stored_task.checkpoint_id is None
            assert stored_task.artifact_refs == task["artifact_refs"]
            assert stored_task.execution_state["artifact_scope"] == task["execution_state"]["artifact_scope"]
            assert set(micro.skill_plan["excluded_question_stems"]) >= stems(original)
            return {row.id: (row.answer_indexes, row.assessment_meta["variant"]["answer_indexes"]) for row in fresh}
    answers = asyncio.run(read())
    micro = client.get(f"/api/micro-learning/runs/{micro_id}").json()
    def advance(current, name):
        response = client.post(f"/api/micro-learning/runs/{micro_id}/advance", json={
            "action": name, "expected_version": current["version"], "client_action_id": uuid.uuid4().hex})
        assert response.status_code == 200, response.text
        return response.json()
    micro = advance(micro, "complete_card")
    response = client.post(f"/api/micro-learning/runs/{micro_id}/teach-back", json={
        "response": "目标文件的符号解析用于找到外部定义，重定位依据最终布局修正地址，静态链接纳入目标代码，动态链接保留共享库依赖。",
        "expected_version": micro["version"], "client_submission_id": uuid.uuid4().hex})
    assert response.status_code == 200, response.text
    micro = advance(response.json(), "continue_after_feedback")
    for index, (question_id, (correct, variant_correct)) in enumerate(answers.items()):
        endpoint = f"/api/checkpoints/{micro['checkpoint_id']}/concepts/{question_id}/submit"
        if index == 0:
            wrong = next(value for value in range(4) if value not in correct)
            grade = client.post(endpoint, json={"answer_indexes": [wrong], "assistance_level": "none", "client_submission_id": uuid.uuid4().hex})
            assert grade.status_code == 200, grade.text
            case_id = grade.json()["remediation"]["id"]
            retry = client.post(endpoint, json={"answer_indexes": correct, "assistance_level": "guided",
                "remediation_case_id": case_id, "attempt_role": "retry", "client_submission_id": uuid.uuid4().hex})
            assert retry.status_code == 200, retry.text
            variant = client.post(f"/api/remediation/{case_id}/variant/submit", json={
                "answer_indexes": variant_correct, "client_submission_id": uuid.uuid4().hex})
            assert variant.status_code == 200, variant.text
            assert variant.json()["remediation"]["status"] == "completed"
        else:
            grade = client.post(endpoint, json={"answer_indexes": correct, "assistance_level": "none", "client_submission_id": uuid.uuid4().hex})
            assert grade.status_code == 200, grade.text
        micro = client.get(f"/api/micro-learning/runs/{micro_id}").json()
    assert micro["status"] == "completed"
    assert micro["summary"]["mastery_claim"] == "not_stable_yet"
    assert len(micro["summary"]["remediated_question_ids"]) == 1
    assert len(micro["summary"]["independently_verified_question_ids"]) == len(answers) - 1


def test_duplicate_verification_candidate_rolls_back_handoff_and_preserves_scope(client, monkeypatch):
    from copy import deepcopy
    from sqlalchemy import func
    from app.models.learning import MicroLearningRun, RemediationCase, LearningAttempt
    from app.services.learning_skill_runtime import act_on_learning_skill_run, _file_verification_excluded_stems
    from app.services.topic_primers import PROGRAM_LINKING
    from app.services.micro_learning import normalize_question_stem
    session_id, run, task, question_ids = _ready_generated_file(client)
    captured = {}
    async def duplicate(**kwargs):
        captured.update(kwargs)
        candidate = deepcopy(PROGRAM_LINKING)
        # Cosmetic punctuation, fullwidth Latin and option ordering cannot make
        # an exposed item fresh. The final publication guard sees this too.
        candidate["questions"][0]["question"] = " **" + candidate["questions"][0]["question"].replace("main", "ＭＡＩＮ") + "** "
        candidate["generation"] = {"mode": "model_enhanced"}
        return candidate
    monkeypatch.setattr("app.services.micro_learning.generate_micro_learning_artifact", duplicate)
    async def verify_rollback():
        async with async_session() as db:
            formal = await db.get(LearningSkillRun, run["id"])
            current = await db.get(LearningTask, task["id"])
            question = await db.get(ConceptQuestion, question_ids[0])
            old_attempt = (await db.execute(select(LearningAttempt).where(LearningAttempt.item_id == question.id,
                LearningAttempt.item_type == "concept", LearningAttempt.learner_id == formal.learner_id))).scalars().first()
            case = RemediationCase(learner_id=formal.learner_id, project_id=task["execution_state"]["artifact_scope"]["project_id"],
                checkpoint_id=question.checkpoint_id, source_attempt_id=old_attempt.id, item_type="concept", item_id=question.id,
                error_fingerprint=uuid.uuid4().hex, error_class="test", variant_payload={"prompt": "曾经展示过的独特迁移情境"})
            db.add(case)
            await db.commit()
            excluded = await _file_verification_excluded_stems(db, current)
            assert normalize_question_stem("曾经展示过的独特迁移情境") in excluded
            before = (current.version, current.status, current.current_phase_id, deepcopy(current.execution_state), deepcopy(current.artifact_refs))
            before_counts = [(await db.execute(select(func.count(model.id)))).scalar_one() for model in (MicroLearningRun, Project, Checkpoint)]
            with pytest.raises(RuntimeError, match="verification_questions_not_fresh"):
                await act_on_learning_skill_run(db, run=formal, action="start_verification", expected_version=run["version"], client_action_id=uuid.uuid4().hex)
            await db.refresh(current)
            await db.refresh(formal)
            assert before == (current.version, current.status, current.current_phase_id, current.execution_state, current.artifact_refs)
            assert current.project_id is current.checkpoint_id is None
            assert formal.state == "verification_ready" and formal.micro_learning_run_id is None
            assert before_counts == [(await db.execute(select(func.count(model.id)))).scalar_one() for model in (MicroLearningRun, Project, Checkpoint)]
            await db.commit()  # Even a caller that catches the error cannot retain half a handoff.
    asyncio.run(verify_rollback())
    assert captured["excluded_question_stems"]


def test_offline_topic_without_unused_questions_fails_explicitly():
    from app.services.micro_learning import generate_micro_learning_artifact, normalize_question_stem, _require_fresh_verification_questions
    from app.services.topic_primers import NAIVE_BAYES, PROGRAM_LINKING_VERIFICATION_QUESTIONS
    from copy import deepcopy
    excluded = [normalize_question_stem(row["question"]) for row in NAIVE_BAYES["questions"]]
    with pytest.raises(RuntimeError, match="verification_questions_not_fresh"):
        asyncio.run(generate_micro_learning_artifact(goal="朴素贝叶斯", source_text="", education_stage="", background="", excluded_question_stems=excluded))
    fresh = {"questions": deepcopy(PROGRAM_LINKING_VERIFICATION_QUESTIONS)}
    fresh["questions"][1]["variant"]["prompt"] = fresh["questions"][0]["question"]
    with pytest.raises(RuntimeError, match="verification_questions_not_fresh"):
        _require_fresh_verification_questions(fresh, [])
