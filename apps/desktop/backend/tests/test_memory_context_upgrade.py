"""Long-horizon and correction regressions through actual storage/read paths."""
import asyncio
import json
import uuid
from datetime import datetime, timedelta
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.main import app
from app.db.database import async_session, init_db
from app.models.learning import Learner, MemoryNode, MemoryEdge, MemoryFact, KernelState, MemoryArchive
from app.models.project import Project
from app.services.learning_runtime import ensure_kernel_states, record_event, apply_semantic_observations
from app.services.five_kernel_context import build_five_kernel_context


def test_exact_old_project_survives_other_project_history():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name='Long history')
            db.add(learner); await db.flush(); await ensure_kernel_states(db, learner.id)
            projects = [Project(learner_id=learner.id, name=name) for name in ['old', 'new']]
            db.add_all(projects); await db.flush()
            old = MemoryNode(learner_id=learner.id, node_type='claim', kernel_name='knowledge',
                subject_key='concept:matrix', project_id=projects[0].id, text='matrix old evidence',
                status='active', salience=.5, occurred_at=datetime.utcnow()-timedelta(days=60))
            db.add(old)
            db.add_all([MemoryNode(learner_id=learner.id, node_type='claim', kernel_name='knowledge',
                subject_key=f'noise:{i}', project_id=projects[1].id, text=f'noise {i}', salience=.9)
                for i in range(300)])
            await db.flush()
            packet = await build_five_kernel_context(db, learner_id=learner.id, policy='project_tutor',
                project_id=projects[0].id, subject_keys=['concept:matrix'], query='matrix')
            assert old.id in [item['id'] for item in packet['items']]
            assert all(item['scope']['project_id'] == projects[0].id for item in packet['items'])
    asyncio.run(scenario())


def test_relation_paths_reapply_answer_human_and_status_filters():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name='Filters')
            db.add(learner); await db.flush(); await ensure_kernel_states(db, learner.id)
            anchor = MemoryNode(learner_id=learner.id,node_type='claim',kernel_name='knowledge',
                subject_key='concept:matrix', text='safe matrix',salience=1)
            hidden = [MemoryNode(learner_id=learner.id,node_type='fact',kernel_name=kernel,
                subject_key='concept:matrix',text=f'HIDDEN_{name}',status=status,payload=payload)
                for name,kernel,status,payload in [('answer','knowledge','active',{'key':'answer'}),
                    ('human','human','active',{}),('withdrawn','knowledge','retracted',{})]]
            db.add_all([anchor,*hidden]); await db.flush()
            db.add_all([MemoryEdge(learner_id=learner.id,source_node_id=anchor.id,
                target_node_id=node.id,relation_type='SUPPORTS') for node in hidden]); await db.flush()
            packet = await build_five_kernel_context(db,learner_id=learner.id,policy='global_tutor',query='matrix')
            assert anchor.id in [item['id'] for item in packet['items']]
            assert 'HIDDEN_' not in json.dumps(packet)
            assert packet['manifest']['answer_free']
    asyncio.run(scenario())


def test_model_observation_is_separate_inferred_candidate_and_idempotent():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner=Learner(key=uuid.uuid4().hex,display_name='Provenance')
            db.add(learner); await db.flush()
            event=await record_event(db,learner_id=learner.id,event_type='user_message',source='user',payload={'text':'你好'})
            observation=[{'kernel':'knowledge','short_term':{'knowledge_gap':'计算机基础欠缺'}}]
            await apply_semantic_observations(db,event,observation)
            await apply_semantic_observations(db,event,observation)
            rows=(await db.execute(select(MemoryFact).join(MemoryNode,MemoryNode.id==MemoryFact.node_id)
                .where(MemoryNode.learner_id==learner.id))).scalars().all()
            assert len(rows)==1 and rows[0].evidence_grade=='inferred'
            assert rows[0].source_event_id != event.id
            state=(await db.execute(select(KernelState).where(KernelState.learner_id==learner.id,
                KernelState.kernel_name=='knowledge'))).scalar_one()
            assert 'knowledge_gap' not in state.short_term
            assert state.short_term['semantic_candidate']['verification']=='inferred'
    asyncio.run(scenario())


def test_archived_aggregate_preferences_hide_individual_facts_and_claims():
    async def scenario():
        await init_db()
        async with async_session() as db:
            learner = Learner(key=uuid.uuid4().hex, display_name='Archived preferences')
            db.add(learner); await db.flush(); await ensure_kernel_states(db, learner.id)
            fact = MemoryNode(learner_id=learner.id, node_type='fact', kernel_name='human',
                subject_key='human:preferences', text='ARCHIVED_MODE',
                payload={'scope': 'short_term', 'key': 'preferred_modes'})
            claim = MemoryNode(learner_id=learner.id, node_type='claim', kernel_name='human',
                subject_key='human:preferences', text='ARCHIVED_CLAIM')
            db.add_all([fact, claim]); await db.flush()
            db.add(MemoryEdge(learner_id=learner.id, source_node_id=fact.id,
                target_node_id=claim.id, relation_type='SUPPORTS'))
            db.add(MemoryArchive(learner_id=learner.id, kernel_name='human',
                memory_scope='long_term', memory_key='learning_preferences'))
            await db.flush()
            from app.services.five_kernel_context import _archived_projection_ids
            archives = (await db.execute(select(MemoryArchive).where(
                MemoryArchive.learner_id == learner.id))).scalars().all()
            assert {fact.id, claim.id} <= await _archived_projection_ids(db, learner.id, archives)
    asyncio.run(scenario())


def test_profile_goal_round_trip_and_partial_update_keep_projections_consistent():
    with TestClient(app) as client:
        response=client.post('/api/auth/register',json={'username':'up'+uuid.uuid4().hex[:12],
            'password':'learnflow-pass-123','display_name':'Upgrade','education_stage':'undergraduate',
            'background':'Python','focus_areas':['AI'],'weekly_hours':6,'preferred_modes':['practice'],
            'career_goal':'','career_goal_status':'exploring'})
        assert response.status_code==200
        learner_id=response.json()['learner_id']
        assert client.patch('/api/profile',json={'weekly_hours':12}).status_code==200
        for goal in ['A','B','A']:
            assert client.patch('/api/profile',json={'career_goal':goal,'career_goal_status':'confirmed'}).status_code==200
        async def states():
            async with async_session() as db:
                return {s.kernel_name:dict(s.long_term or {}) for s in (await db.execute(
                    select(KernelState).where(KernelState.learner_id==learner_id))).scalars()}
        projection=asyncio.run(states())
        assert projection['value']['career_goal']=='A'
        assert projection['human']['learning_preferences']['preferred_modes']==['practice']
        assert projection['human']['learning_preferences']['weekly_hours']==12
        assert client.patch('/api/profile',json={'career_goal_status':'exploring'}).status_code==200
        assert asyncio.run(states())['value']['career_goal']==''
