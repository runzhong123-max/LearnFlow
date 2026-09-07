"""Operational help history can lower independence, never establish mastery."""
import asyncio
import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.main import app
from app.db.database import async_session
from app.models.project import Project
from learnflow_core.project_guidance import record_device_report
from learnflow_core.project_guidance_models import ProjectDeviceReport


def key():
    return uuid.uuid4().hex


@pytest.fixture(scope='module')
def client():
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield client


def make_project(client):
    response = client.post('/api/vnext-projects', json={'name': '辅助来源 ' + key(), 'objective': '实现并解释转换', 'project_mode': 'experiment'})
    assert response.status_code == 200, response.text
    pid = response.json()['project']['id']
    result = client.post(f'/api/vnext-projects/{pid}/workflow/initialize', json={'client_action_id': key()})
    assert result.status_code == 200, result.text
    return pid, result.json()['milestones'][0]['checkpoint_id']


def test_prior_report_assistance_cannot_be_removed_by_omitting_its_reference(client):
    pid, cp = make_project(client)
    async def seed():
        async with async_session() as db:
            project = await db.get(Project, pid)
            db.add(ProjectDeviceReport(learner_id=project.learner_id, project_id=pid, checkpoint_id=cp,
                client_action_id=key(), report_hash='a'*64, report={'engineering_provenance': {'assisted': True}}))
            await db.commit()
    asyncio.run(seed())
    response = client.post(f'/api/vnext-projects/{pid}/checkpoints/{cp}/deliver', json={
        'client_action_id': key(), 'answers': {'deliverable':'转换程序', 'prediction':'固定输出'},
        'artifact_refs': [], 'assistance_level': 'independent'})
    assert response.status_code == 200, response.text
    result = response.json()['milestones'][0]['submission']
    assert result['assistance_level'] == 'together'
    assert result['feedback']['engineering_assisted'] is True
    assert result['feedback']['mastery_inference'] is False
    # Help history in another project must not contaminate this one.
    other, other_cp = make_project(client)
    clean = client.post(f'/api/vnext-projects/{other}/checkpoints/{other_cp}/deliver', json={
        'client_action_id':key(),'answers':{'deliverable':'程序','prediction':'输出'},'artifact_refs':[],'assistance_level':'independent'})
    assert clean.status_code == 200, clean.text
    assert clean.json()['milestones'][0]['submission']['assistance_level'] == 'independent'


def test_historical_engineering_scope_still_must_belong_to_same_project(client):
    pid, cp = make_project(client)
    other, other_cp = make_project(client)
    async def check():
        async with async_session() as db:
            project = await db.get(Project, pid)
            data = {'checkpoint_id':cp, 'client_action_id':key(),
                'engineering_provenance':{'runs':[{'checkpoint_id':other_cp}]}}
            with pytest.raises(HTTPException) as error:
                await record_device_report(db, project, data)
            assert error.value.status_code == 422
            assert await db.scalar(select(ProjectDeviceReport.id).where(ProjectDeviceReport.project_id == pid)) is None
    asyncio.run(check())
