"""Regression for file submissions from both new and older browser clients."""
import asyncio
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import Learner, LearningAttempt, EvidenceEvent
from app.models.project import Project, Roadmap, Checkpoint, ConceptQuestion


async def seed():
    async with async_session() as db:
        learner = (await db.execute(select(Learner).where(Learner.key == 'local-default'))).scalar_one()
        project = Project(learner_id=learner.id, name=f'file-evidence-{uuid4().hex}')
        db.add(project)
        await db.flush()
        roadmap = Roadmap(project_id=project.id, raw_json={})
        db.add(roadmap)
        await db.flush()
        checkpoint = Checkpoint(roadmap_id=roadmap.id, title='链接与符号', order=1, prerequisites=[])
        db.add(checkpoint)
        await db.flush()
        question = ConceptQuestion(checkpoint_id=checkpoint.id, question='哪个阶段解析跨目标文件的符号引用？',
            options=['预处理', '链接'], answer_indexes=[1], q_type='single', difficulty='easy',
            explanation='链接器解析符号引用。', order=1)
        db.add(question)
        await db.commit()
        return checkpoint.id, question.id


def test_explicit_help_and_repeated_answer_cannot_be_submitted_as_independent_original():
    with TestClient(app) as client:
        accounts = client.get('/api/dev/accounts').json()
        account = next(item for item in accounts if item['username'] == 'legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        checkpoint_id, question_id = asyncio.run(seed())
        path = f'/api/checkpoints/{checkpoint_id}/concepts/{question_id}/submit'
        first = client.post(path, json={'answer_indexes': [1], 'assistance_level': 'none',
            'helpful_format': 'worked_example', 'support_effective': True, 'client_submission_id': 'first'})
        assert first.status_code == 200, first.text
        assert first.json()['assistance_level'] == 'guided'
        assert first.json()['attempt_role'] == 'original'
        retry_payload = {'answer_indexes': [1], 'assistance_level': 'none', 'attempt_role': 'variant', 'client_submission_id': 'retry'}
        retry = client.post(path, json=retry_payload)
        assert retry.status_code == 200, retry.text
        assert retry.json()['assistance_level'] == 'guided'
        assert retry.json()['attempt_role'] == 'retry'
        replay = client.post(path, json=retry_payload)
        assert replay.json()['attempt_id'] == retry.json()['attempt_id']
        assert replay.json()['idempotent_replay'] is True
        async def check():
            async with async_session() as db:
                attempts = (await db.execute(select(LearningAttempt).where(LearningAttempt.item_type == 'concept', LearningAttempt.item_id == question_id))).scalars().all()
                assert len(attempts) == 2
                events = (await db.execute(select(EvidenceEvent).where(EvidenceEvent.event_type == 'concept_attempt_evaluated', EvidenceEvent.checkpoint_id == checkpoint_id))).scalars().all()
                assert len(events) == 2
                assert all(event.payload['independent'] is False for event in events)
        asyncio.run(check())


def test_explanation_before_first_answer_is_guided(monkeypatch):
    from app.services.concept_agent import ConceptAgent
    async def explain(*args, **kwargs):
        return '链接阶段解析跨目标文件符号引用。'
    monkeypatch.setattr(ConceptAgent, '__init__', lambda self: None)
    monkeypatch.setattr(ConceptAgent, 'explain', explain)
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        client.post(f"/api/dev/accounts/{account['id']}/login")
        checkpoint_id, question_id = asyncio.run(seed())
        path = f'/api/checkpoints/{checkpoint_id}/concepts/{question_id}'
        assert client.post(path + '/explain', json={}).status_code == 200
        submitted = client.post(path + '/submit', json={'answer_indexes': [1], 'assistance_level': 'none'})
        assert submitted.status_code == 200, submitted.text
        assert submitted.json()['assistance_level'] == 'guided'
        assert submitted.json()['attempt_role'] == 'original'


def test_repeated_code_feedback_is_not_independent_success(monkeypatch):
    from app.services.execution_policy import EXECUTION_ENV_VAR, EXECUTION_POLICY_VAR
    from app.models.project import Exercise
    monkeypatch.setenv(EXECUTION_ENV_VAR, 'development')
    monkeypatch.setenv(EXECUTION_POLICY_VAR, 'trusted_local_process')
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        client.post(f"/api/dev/accounts/{account['id']}/login")
        checkpoint_id, _ = asyncio.run(seed())
        async def exercise():
            async with async_session() as db:
                row = Exercise(checkpoint_id=checkpoint_id, title='打印2', description='输出数字2', starter_code='',
                    solution='print(2)', test_cases=[{'input': '', 'expected': '2'}], judge_mode='test_cases', order=1)
                db.add(row)
                await db.commit()
                return row.id
        exercise_id = asyncio.run(exercise())
        path = f'/api/exercises/{exercise_id}/submit'
        first = client.post(path, json={'code': 'print(2)', 'client_submission_id': 'first-code'})
        assert first.status_code == 200, first.text
        second = client.post(path, json={'code': 'print(2)', 'client_submission_id': 'retry-code', 'attempt_role': 'original'})
        assert second.status_code == 200, second.text
        assert second.json()['assistance_level'] == 'hint'
        assert second.json()['attempt_role'] == 'retry'


def test_wrong_first_option_reaches_remediation_as_the_actual_selection():
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        client.post(f"/api/dev/accounts/{account['id']}/login")
        checkpoint_id, question_id = asyncio.run(seed())
        submitted = client.post(
            f'/api/checkpoints/{checkpoint_id}/concepts/{question_id}/submit',
            json={'answer_indexes': [0], 'client_submission_id': 'wrong-first-option'},
        )
        assert submitted.status_code == 200, submitted.text
        result = submitted.json()
        assert result['correct'] is False
        case = result['remediation']
        assert case['evidence']['actual_indexes'] == [0]
        assert case['evidence']['actual'] == ['预处理']
        assert case['evidence']['expected'] == ['链接']
        assert case['error_class'] == 'concept_misconception'
        explanation = str(case['explanation'])
        assert '预处理' in explanation
        assert '未形成有效选择' not in explanation


def test_remediation_reads_nested_selection_and_respects_explicit_empty_selection():
    from app.services.remediation import _build_evidence
    snapshot = {'question': '选择链接阶段', 'options': ['预处理', '链接']}
    evaluation = {'answer_indexes': [1], 'submitted_response': {'answer_indexes': [0]}}
    evidence = _build_evidence('concept', snapshot, evaluation)
    assert evidence['actual_indexes'] == [0]
    assert evidence['actual'] == ['预处理']
    empty = _build_evidence('concept', snapshot, {**evaluation, 'user_answer_indexes': []})
    assert empty['actual_indexes'] == []
    assert empty['actual'] == []


@pytest.mark.parametrize(('q_type', 'expected', 'actual', 'expected_text', 'actual_text'), [
    ('numeric', 1, 0, '1', '0'),
    ('numeric', 0, 1, '0', '1'),
    ('exact_text', 'one', 0, 'one', '0'),
    ('trace_table', [[1]], [[0]], '[[1]]', '[[0]]'),
])
def test_structured_remediation_preserves_zero_in_actual_and_expected(
    q_type, expected, actual, expected_text, actual_text,
):
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        client.post(f"/api/dev/accounts/{account['id']}/login")
        checkpoint_id, question_id = asyncio.run(seed())

        async def make_structured():
            async with async_session() as db:
                question = await db.get(ConceptQuestion, question_id)
                question.q_type = q_type
                question.options = []
                question.answer_indexes = []
                question.assessment_meta = {'expected_response': expected}
                await db.commit()

        asyncio.run(make_structured())
        submitted = client.post(
            f'/api/checkpoints/{checkpoint_id}/concepts/{question_id}/submit',
            json={'response': actual, 'client_submission_id': 'structured-zero'},
        )
        assert submitted.status_code == 200, submitted.text
        result = submitted.json()
        assert result['correct'] is False
        assert result['submitted_response'] == actual
        assert result['expected_response'] == expected
        case = result['remediation']
        assert case['evidence']['actual'] == [actual_text]
        assert case['evidence']['expected'] == [expected_text]
        explanation = str(case['explanation'])
        assert actual_text in explanation
        assert expected_text in explanation
        assert '未形成有效选择' not in explanation
