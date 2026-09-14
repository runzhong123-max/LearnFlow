import asyncio

from fastapi.testclient import TestClient
from app.main import app
from app.db.database import async_session
from app.models.learning import LearningTask
from app.models.project import Project, Roadmap, Checkpoint
from app.services.profile import achievement_projection


def test_achievement_thresholds_projects_isolation_and_repeat_reads():
    with TestClient(app) as client:
        def register(name):
            response = client.post('/api/auth/register', json={
                'username': name, 'password': 'learnflow-pass-123',
                'display_name': name, 'education_stage': 'undergraduate',
                'background': 'Python', 'focus_areas': ['编程'], 'weekly_hours': 6,
                'preferred_modes': ['practice'],
            })
            assert response.status_code == 200, response.text
            return response.json()['learner_id']
        owner = register('achievement_owner')
        other = register('achievement_other')

        async def scenario():
            async with async_session() as db:
                initial = await achievement_projection(db, owner)
                assert initial[0]['earned']
                assert sum(item['earned'] for item in initial) == 1
                for i in range(100):
                    db.add(LearningTask(learner_id=owner, title=f'Task {i}', objective='Learn',
                                        status='completed', client_request_id=f'award:{i}'))
                    await db.flush()
                    if i + 1 in (1, 9, 10, 49, 50, 99, 100):
                        awards = await achievement_projection(db, owner)
                        assert [a['target'] for a in awards if a['kind'] == 'tasks' and a['earned']] == [
                            t for t in (1, 10, 50, 100) if t <= i + 1]
                for status in ('active', 'queued', 'canceled', 'paused'):
                    db.add(LearningTask(learner_id=other, title=status, objective='Learn',
                                        status=status, client_request_id=f'other:{status}'))
                for index, states in enumerate(([], ['completed', 'verification_due'], ['completed'], ['completed'])):
                    project = Project(learner_id=owner, name=f'Project {index}')
                    db.add(project)
                    await db.flush()
                    roadmap = Roadmap(project_id=project.id, raw_json={})
                    db.add(roadmap)
                    await db.flush()
                    for order, state in enumerate(states):
                        db.add(Checkpoint(roadmap_id=roadmap.id, title='Gate', order=order,
                                          learning_status=state, archived=False))
                await db.flush()
                awards = await achievement_projection(db, owner)
                assert len([a for a in awards if a['kind'] == 'project' and a['earned']]) == 2
                assert len({a['id'] for a in awards}) == len(awards)
                assert await achievement_projection(db, owner) == awards
                assert sum(a['earned'] for a in await achievement_projection(db, other)) == 1
                assert await achievement_projection(db, -1) == []
                await db.commit()
        asyncio.run(scenario())
        snapshot = client.get('/api/learner-state/snapshot').json()
        assert sum(a['earned'] for a in snapshot['growth']['achievements']) == 1
