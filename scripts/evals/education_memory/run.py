#!/usr/bin/env python3
"""Run real educational memory paths in a disposable, offline process.

No product behavior is changed. Truth is specified before observations. The
only derived-data deletion occurs in disposable read-ablation database copies.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager, ExitStack
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

from verifier import evaluate, stable_json

VERSION = 'education-memory-ablation.v1'
VARIANTS = ('full', 'facts_only', 'recent_facts', 'no_relations', 'no_guidance', 'no_head_cache', 'no_memory')
BASE_TIME = datetime(2026, 8, 1, 8)
COURSES = [
    ('数学', '分数比较', '比较分数前需要统一什么？', ['分子', '分母'], '比较四分之一和三分之一时，先统一什么？'),
    ('物理', '串联电路', '理想串联电路各处哪个量相等？', ['电压', '电流'], '两个不同电阻串联，流过它们的哪个量相等？'),
    ('编程', '递归终止', '递归必须设置什么以确保适当输入时停止？', ['更多递归调用', '终止条件'], '递归计算阶乘时，需要用什么处理零的情况？'),
    ('生物', '光合作用', '植物光合作用固定碳的主要碳源是什么？', ['氧气', '二氧化碳'], '温室植物合成糖所需碳主要来自哪种气体？'),
]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + '\n')


def check(name, path, op='eq', value=None, **extra):
    row = dict(name=name, path=path, op=op, **extra)
    if op in {'eq', 'contains', 'not_contains', 'json_not_contains', 'lte'}:
        row['value'] = value
    return row


def guidance(slot, *, kernel='human', **fields):
    sources=fields.pop('accepted_source_events',None)
    row=check(f'指导:{kernel}.{slot}', ['guidance'], 'some', fields={'kernel': kernel, 'slot': slot, **fields})
    if sources is not None:row['accepted_source_events']=sources
    return row


class ClockMeta(type):
    def __instancecheck__(cls, value):
        return isinstance(value, datetime)


class Clock(datetime, metaclass=ClockMeta):
    current = BASE_TIME

    @classmethod
    def utcnow(cls):
        return cls.current

    @classmethod
    def now(cls, tz=None):
        return cls.current if tz is None else cls.current.replace(tzinfo=timezone.utc).astimezone(tz)


@contextmanager
def business_clock():
    # Patch only application module clocks. Database audit timestamps are left
    # real and excluded from deterministic comparison, never edited afterwards.
    with ExitStack() as stack:
        for name, module in list(sys.modules.items()):
            if name.startswith(('app.', 'learnflow_core.')) and getattr(module, 'datetime', None) is datetime:
                stack.enter_context(patch.object(module, 'datetime', Clock))
        yield


class Experiment:
    def __init__(self, output, temporary, args):
        self.output, self.temporary, self.args = output, temporary, args
        self.operations, self.snapshots, self.trials = [], [], []
        self.tags = {}
        self.counter = 0

    async def initialize(self):
        import app.models
        from app.db.database import Base, engine, async_session
        from app.services import learning_runtime, five_kernel_context, memory_worker, learning_tasks, profile
        from app.api import phase3, review, remediation, learner_state, memory
        from app.models import learning, project
        from sqlalchemy import select, func
        self.sa, self.func = select, func
        self.engine, self.sessions = engine, async_session
        self.lr, self.ctx, self.worker, self.planner, self.profile = learning_runtime, five_kernel_context, memory_worker, learning_tasks, profile
        self.phase3, self.review, self.remediation, self.learner_api = phase3, review, remediation, learner_state
        self.memory_api=memory
        self.models, self.content = learning, project
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def seed_content(self, index):
        m, p = self.models, self.content
        domain, topic, prompt, options, variant = COURSES[index]
        async with self.sessions() as db:
            learner = m.Learner(key=f'education-eval-{index}', display_name=f'合成学习者-{index}')
            db.add(learner)
            await db.flush()
            project = p.Project(learner_id=learner.id, name=f'{domain}课程', description='Synthetic evaluation curriculum')
            other = p.Project(learner_id=learner.id, name='另一课程')
            db.add_all([project, other])
            await db.flush()
            roadmap = p.Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            cp = p.Checkpoint(roadmap_id=roadmap.id, title=topic, order=1, prerequisites=[], learning_status='in_progress')
            db.add(cp)
            await db.flush()
            sessions = [m.AgentSession(learner_id=learner.id, project_id=project.id, checkpoint_id=cp.id, session_type='checkpoint') for _ in range(2)]
            foreign_session=m.AgentSession(learner_id=learner.id,project_id=other.id,session_type='project')
            db.add(foreign_session)
            db.add_all(sessions)
            questions = [p.ConceptQuestion(checkpoint_id=cp.id, question=prompt, options=options,
                answer_indexes=[1], q_type='single', difficulty='easy', explanation=f'本题正确概念为：{options[1]}。', order=j,
                assessment_meta={'targets':[topic], 'variant':{'type':'concept_choice', 'validated':True,
                    'prompt':variant, 'options':options, 'answer_indexes':[1]}}) for j in range(1, 4)]
            db.add_all(questions)
            await db.commit()
            return SimpleNamespace(learner=learner, project=project.id, other=other.id, checkpoint=cp.id,
                session=sessions[0].id, other_session=sessions[1].id, questions=[q.id for q in questions],
                foreign_session=foreign_session.id,domain=domain, topic=topic, index=index)

    async def action(self, person, label, kind, payload, *, older=None, client_key=None):
        Clock.current += timedelta(minutes=1)
        self.counter += 1
        key = client_key or f'edu-{person.index}-{label}-{self.counter}'
        original_payload=json.loads(stable_json(payload))
        async with self.sessions() as db:
            if kind == 'text':
                request = self.learner_api.LearnerEventRequest(event_type='vnext_teaching_input_received',
                    client_event_id=key, project_id=person.project, checkpoint_id=person.checkpoint,
                    session_id=person.session, payload={'text':payload}, occurred_at=older)
                from fastapi import HTTPException
                try:
                    result = await self.learner_api.sync_learner_event(request, current=person, db=db)
                    self.tags[label] = result['event_id']
                except HTTPException as exc:
                    if label!='text_changed_replay' or exc.status_code!=409:raise
                    await db.rollback()
                    result={'expected_rejection':409,'detail':exc.detail}
            elif kind == 'event':
                event = await self.lr.record_event(db, learner_id=person.learner.id,
                    project_id=person.project, checkpoint_id=person.checkpoint, session_id=person.session,
                    source='user', client_event_id=key, provenance={'synthetic_script':True}, **payload)
                await db.commit()
                result = {'event_id':event.id, 'event_type':event.event_type}
                self.tags[label] = event.id
            elif kind == 'concept':
                result = await self.phase3.submit_concept(person.checkpoint, payload.pop('question_id'),
                    data={**payload, 'client_submission_id':key}, current=person, db=db)
            elif kind == 'switch':
                result = await self.remediation.change_remediation_explanation(payload['case_id'],
                    data={'action':'switch'}, current=person, db=db)
            elif kind == 'variant':
                result = await self.remediation.evaluate_remediation_variant(payload.pop('case_id'),
                    data={**payload, 'client_submission_id':key}, current=person, db=db)
            elif kind == 'feedback':
                result=await self.memory_api.submit_claim_feedback(payload['claim_id'],
                    self.memory_api.ClaimFeedbackRequest(action=payload['action'],correction=payload.get('correction','')),
                    current=person,db=db)
                self.tags[label]=result['event_id']
            elif kind == 'review':
                from app.schemas.review import ReviewSubmitRequest
                sid = payload.pop('schedule_id')
                item = await self.review.get_review_item(sid, current=person, db=db)
                request = ReviewSubmitRequest(expected_version=item['version'],
                    presentation_version=item['presentation']['version'], client_submission_id=key, **payload)
                from fastapi import HTTPException
                try:
                    result = await self.review.submit_review_item(sid, request, current=person, db=db)
                except HTTPException as exc:
                    if exc.status_code != 422 or label != 'missing':
                        raise
                    await db.rollback()
                    result = {'expected_rejection':exc.status_code, 'detail':exc.detail}
            else:
                raise ValueError(kind)
            if kind=='concept' and result.get('attempt_id'):
                grade_events=(await db.execute(self.sa(self.models.EvidenceEvent).where(
                    self.models.EvidenceEvent.learner_id==person.learner.id,
                    self.models.EvidenceEvent.event_type.in_(['concept_attempt_evaluated','remediation_retry_evaluated'])))).scalars().all()
                matching=[e for e in grade_events if (e.payload or {}).get('attempt_id')==result['attempt_id']]
                self.tags[label+'_events']=[e.id for e in matching]
                grade=next((e for e in matching if e.event_type=='concept_attempt_evaluated'),None)
                if grade:self.tags[label]=grade.id
        self.operations.append({'learner':person.index, 'label':label, 'kind':kind, 'at':Clock.current,
            'input':original_payload, 'client_submission_or_event_id':key, 'result':result})
        write_json(self.output/'operations.json', self.operations)
        return result

    async def drain_worker(self):
        Clock.current += timedelta(seconds=3)
        total = 0
        for _ in range(64):
            processed = await self.worker.process_due_runs(limit=8)
            total += processed
            if not processed:
                return total
        raise RuntimeError('Synthesis did not reach a bounded idle state')

    async def state(self, person):
        m, select = self.models, self.sa
        async with self.sessions() as db:
            rows = (await db.execute(select(m.KernelState).where(m.KernelState.learner_id==person.learner.id))).scalars().all()
            states = {r.kernel_name:{'short_term':r.short_term, 'long_term':r.long_term} for r in rows}
            attempts = (await db.execute(select(m.LearningAttempt).where(m.LearningAttempt.learner_id==person.learner.id))).scalars().all()
            facts = (await db.execute(select(m.MemoryNode, m.MemoryFact).join(m.MemoryFact, m.MemoryFact.node_id==m.MemoryNode.id)
                .where(m.MemoryNode.learner_id==person.learner.id))).all()
            events = {r.id:r for r in (await db.execute(select(m.EvidenceEvent).where(m.EvidenceEvent.learner_id==person.learner.id))).scalars().all()}
            mutations = {r.id:r for r in (await db.execute(select(m.KernelMutation).where(m.KernelMutation.learner_id==person.learner.id))).scalars().all()}
            chain_errors = []
            for node, fact in facts:
                event, mutation = events.get(fact.source_event_id), mutations.get(fact.source_mutation_id)
                if not event or not mutation or mutation.event_id != event.id or mutation.kernel_name != node.kernel_name:
                    chain_errors.append(node.id)
            runs = (await db.execute(select(m.MemorySynthesisRun).where(m.MemorySynthesisRun.learner_id==person.learner.id))).scalars().all()
            modules=(await db.execute(select(m.MemoryNode,m.MemoryModule).join(m.MemoryModule,m.MemoryModule.node_id==m.MemoryNode.id)
                .where(m.MemoryNode.learner_id==person.learner.id))).all()
            claims=(await db.execute(select(m.MemoryNode,m.MemoryClaim).join(m.MemoryClaim,m.MemoryClaim.node_id==m.MemoryNode.id)
                .where(m.MemoryNode.learner_id==person.learner.id))).all()
            fact_map={n.id:(n,f) for n,f in facts}
            closure_errors=[]
            for n,module in modules:
                if not module.evidence_fact_ids or any(fid not in fact_map for fid in module.evidence_fact_ids):
                    closure_errors.append(n.id)
            for n,claim in claims:
                if not (n.payload or {}).get('evidence_fact_ids') or any(fid not in fact_map for fid in n.payload['evidence_fact_ids']):
                    closure_errors.append(n.id)
            return {'states':states, 'attempt_count':len(attempts), 'event_count':len(events), 'mutation_count':len(mutations),
                'fact_count':len(facts), 'chain_errors':chain_errors,
                'module_count':len(modules),'claim_count':len(claims),'closure_errors':closure_errors,
                'guidance_records':[g for state in states.values() for storage,key in
                    [('short_term','teaching_directives'),('long_term','teaching_preferences')]
                    for g in (state.get(storage) or {}).get(key,[])],
                'claims':[{'id':n.id,'text':n.text,'status':n.status,'verification_status':c.verification_status,
                    'evidence_fact_ids':n.payload.get('evidence_fact_ids',[])} for n,c in claims],
                'events':[{'id':e.id,'event_type':e.event_type,'payload':e.payload,'provenance':e.provenance,
                    'occurred_at':e.occurred_at,'client_event_id':e.client_event_id} for e in events.values()],
                'mutations':[{'id':r.id,'event_id':r.event_id,'kernel':r.kernel_name,'patch':r.patch} for r in mutations.values()],
                'attempts':[{'id':a.id,'item_id':a.item_id,'role':a.attempt_role,'assistance':a.assistance_level,
                    'status':a.status,'result':a.result} for a in attempts],
                'operation_results':{r['label']:r['result'] for r in self.operations if r['learner']==person.index},
                'facts':[{'id':n.id, 'event':f.source_event_id, 'kernel':n.kernel_name, 'text':n.text,
                    'grade':f.evidence_grade, 'predicate':f.predicate, 'status':n.status, 'object':f.object_value} for n,f in facts],
                'runs':[{'id':r.id,'status':r.status,'kernel':r.kernel_name,'model':r.model_name,'errors':r.validation_errors} for r in runs],
                'profile':await self.profile.memory_projection(db, person.learner.id)}

    async def snapshot(self, person, name, formation=(), delivery=(), planning=(), *, session=None, family=None, query=None):
        state = await self.state(person)
        state_checks = list(formation)
        for item in delivery:
            if item['op']=='some' and item['path']==['guidance']:
                state_checks.append({**item,'path':['guidance_records'],'name':'形成:'+item['name']})
        record = {'id':f'{person.index}:{name}', 'name':name, 'family':family or name, 'learner':person.index,
            'domain':person.domain, 'at':Clock.current.isoformat(), 'formation':evaluate(state,state_checks),
            'observed':state, 'delivery_gold':list(delivery), 'planning_gold':list(planning)}
        record['audit']={'fact_count':state['fact_count'],'fact_chain_valid':not state['chain_errors'] if state['fact_count'] else None,
            'module_claim_count':state['module_count']+state['claim_count'],
            'closure_valid':not state['closure_errors'] if state['module_count'] else None}
        self.snapshots.append(record)
        write_json(self.output/'snapshots.json', self.snapshots)
        source = Path(os.environ['DATABASE_URL'].removeprefix('sqlite+aiosqlite:///'))
        # SQLite backup works even with a live pooled connection/WAL. The source
        # is the disposable base DB, never the user's configured database.
        paths = {}
        for variant in ('full','facts_only','recent_facts'):
            dest = self.temporary/f'read-{variant}.db'
            dest.unlink(missing_ok=True)
            with sqlite3.connect(source) as src, sqlite3.connect(dest) as out:
                src.backup(out)
                if variant != 'full':
                    out.execute('DELETE FROM memory_edges WHERE source_node_id IN (SELECT id FROM memory_nodes WHERE node_type != ?) OR target_node_id IN (SELECT id FROM memory_nodes WHERE node_type != ?)', ('fact','fact'))
                    out.execute('DELETE FROM memory_claims')
                    out.execute('DELETE FROM memory_modules')
                    out.execute("DELETE FROM memory_nodes WHERE node_type != 'fact'")
                    out.execute('DELETE FROM kernel_heads')
                if variant == 'recent_facts':
                    out.execute('''DELETE FROM memory_nodes WHERE id NOT IN (SELECT id FROM
                        (SELECT id, ROW_NUMBER() OVER (PARTITION BY learner_id ORDER BY occurred_at DESC,id DESC) rn FROM memory_nodes) WHERE rn<=24)''')
                    out.execute('DELETE FROM memory_facts WHERE node_id NOT IN (SELECT id FROM memory_nodes)')
                    out.execute('DELETE FROM memory_edges WHERE source_node_id NOT IN (SELECT id FROM memory_nodes) OR target_node_id NOT IN (SELECT id FROM memory_nodes)')
                out.commit()
            paths[variant] = dest
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        engines = {key:create_async_engine(f'sqlite+aiosqlite:///{path}') for key,path in paths.items()}
        for engine in engines.values():
            async with async_sessionmaker(engine,expire_on_commit=False)() as db:
                await self.ctx.ensure_kernel_heads(db,person.learner.id)
                await db.commit()
        query = query or f'围绕{person.topic}继续学习，回顾学习背景、当前困难和目标，安排下一步。'
        record['query']=query
        jobs = [(v,b) for v in VARIANTS for b in self.args.budgets]
        random.Random(710+len(self.snapshots)).shuffle(jobs)
        original = self.ctx.build_five_kernel_context
        async def uncached(db, learner_id):
            return [await self.ctx.refresh_kernel_head(db,learner_id,k) for k in self.ctx.KERNEL_NAMES]
        for variant,budget in jobs:
            engine = engines[variant if variant in paths else 'full']
            maker = async_sessionmaker(engine,expire_on_commit=False)
            policy = replace(self.ctx.CONTEXT_POLICIES['checkpoint_tutor'],token_budget=budget)
            if variant == 'no_relations':
                policy = replace(policy,max_paths=0)
            times, fingerprints = [], []
            for repetition in range(self.args.repetitions):
                captured = {}
                async def reader(db, **kwargs):
                    if variant == 'no_memory':
                        packet = {'scope':{},'items':[],'teaching_guidance':[],'adaptation_directives':[]}
                    else:
                        kwargs['policy'] = policy
                        packet = await original(db,**kwargs)
                        if variant == 'no_guidance':
                            packet['teaching_guidance'] = []
                    captured['packet'] = packet
                    return packet
                with ExitStack() as stack:
                    stack.enter_context(patch.object(self.ctx,'build_five_kernel_context',reader))
                    if variant == 'no_head_cache':
                        stack.enter_context(patch.object(self.ctx,'ensure_kernel_heads',uncached))
                    async with maker() as db:
                        start = time.perf_counter()
                        context = await self.planner._scoped_planner_context(db,learner_id=person.learner.id,
                            project_id=person.project,checkpoint_id=person.checkpoint,
                            session_id=session or person.session,objective=query)
                        if variant == 'no_memory':
                            context = {}
                        plan = await self.planner.generate_learning_task_plan(title=person.topic,objective=query,
                            origin_kind='checkpoint',estimated_minutes=45,learner_context=context)
                        times.append((time.perf_counter()-start)*1000)
                        packet = captured['packet']
                        # Only actual visible text counts; evidence manifests cannot
                        # satisfy a content assertion on their own.
                        evidence,violations=await self.audit_packet(db,packet,person,session or person.session)
                        view = {'guidance':packet.get('teaching_guidance',[]),'adaptation':packet.get('adaptation_directives',[]),
                            'evidence':evidence,'violations':violations,'context':context,'plan':plan,
                            'budget_ok':packet.get('manifest',{}).get('token_estimate',0)<=budget}
                        scores = {'delivery':evaluate(view,delivery),'planning':evaluate(view,planning)}
                        semantic = {'view':view,'scores':scores}
                        # Snapshot IDs are cache/audit identities, not learner outcomes.
                        encoded = stable_json(semantic)
                        for kernel in context.values():
                            if isinstance(kernel,dict) and kernel.get('context_snapshot_id'):
                                encoded = encoded.replace(kernel['context_snapshot_id'],'<snapshot>')
                        fingerprints.append(hashlib.sha256(encoded.encode()).hexdigest())
                        await db.rollback()
                trial = {'snapshot':record['id'],'family':record['family'],'variant':variant,'budget':budget,
                    'repeat':repetition,'latency_ms':times[-1],'semantic_hash':fingerprints[-1],
                    'packet':packet,'planner_context':context,'plan':plan,'scores':scores,
                    'violations':violations,
                    'packet_characters':len(stable_json(packet)),'budget_ok':view['budget_ok']}
                with (self.output/'trials.jsonl').open('a') as f:
                    f.write(stable_json(trial)+'\n')
                self.trials.append({k:v for k,v in trial.items() if k not in {'packet','planner_context','plan'}})
            if len(set(fingerprints)) != 1:
                record.setdefault('repeat_instability',[]).append({'variant':variant,'budget':budget})
        for engine in engines.values():
            await engine.dispose()
        print(f"snapshot {record['id']} facts={state['fact_count']} checks={len(state_checks)}",flush=True)

    async def audit_packet(self,db,packet,person,session):
        m=self.models
        nodes={r.id:r for r in (await db.execute(self.sa(m.MemoryNode))).scalars().all()}
        facts={r.node_id:r for r in (await db.execute(self.sa(m.MemoryFact))).scalars().all()}
        events={r.id:r for r in (await db.execute(self.sa(m.EvidenceEvent))).scalars().all()}
        evidence,violations=[],[]
        visible=[(row,'item') for row in packet.get('items',[])]
        for path in packet.get('relation_paths',[]):
            visible.extend((path[side],'path') for side in ('source','target') if side in path)
        for row,channel in visible:
            node=nodes.get(row.get('id'))
            if node is None:
                violations.append('unknown_node');continue
            scoped=node.learner_id==person.learner.id and node.project_id in (None,person.project) and node.checkpoint_id in (None,person.checkpoint)
            if node.status=='transient' and node.session_id not in (None,session):scoped=False
            if not scoped:violations.append('scope_leak')
            if node.kernel_name=='human':violations.append('human_raw_leak')
            expired=bool(node.valid_to and node.valid_to<=Clock.current)
            if expired:violations.append('expired_memory')
            current=node.status in {'active','transient','legacy'} and not expired
            if not current and not (channel=='path' and node.status=='superseded'):violations.append('inactive_as_current')
            if row.get('status')!=node.status:violations.append('status_mismatch');current=False
            detail=row.get('detail',{}) if channel=='item' else row
            provenance_ok=True
            if node.node_type=='fact':
                fact=facts[node.id]
                source_events=[detail.get('source_event_id')] if detail.get('source_event_id') is not None else []
                provenance_ok=(source_events==[fact.source_event_id] and detail.get('evidence_grade')==fact.evidence_grade
                    and (channel!='item' or row.get('evidence_refs')==source_events))
                if not provenance_ok:violations.append('fact_provenance_or_grade_mismatch')
            else:
                declared=(row.get('provenance') or {}).get('evidence_fact_ids',[])
                actual=(node.payload or {}).get('evidence_fact_ids',[])
                provenance_ok=bool(declared) and set(declared)==set(actual) and all(fid in facts for fid in declared)
                source_events=[facts[fid].source_event_id for fid in declared if fid in facts]
                # A path endpoint is addressable by ID but carries no inline
                # closure. It cannot satisfy the stricter attributed-text gold.
                if channel=='item' and not provenance_ok:violations.append('derived_inline_provenance_missing')
            source_text=detail.get('source_text') or {}
            ranges=source_text.get('ranges',[])
            original=node.text or ''
            reconstructed=' … '.join(original[a:b] for a,b in ranges)
            excerpt_ok=source_text.get('sha256')==hashlib.sha256(original.encode()).hexdigest() and reconstructed==row.get('text','')
            if not excerpt_ok:violations.append('excerpt_provenance_mismatch')
            evidence.append({'id':node.id,'text':row.get('text',''),'source_events':source_events,
                'scope_valid':scoped and provenance_ok and excerpt_ok,'current':current})
        for g in packet.get('teaching_guidance',[]):
            event=events.get(g.get('source_event_id'))
            scope=g.get('scope') or {}
            if not event or event.learner_id!=person.learner.id:violations.append('guidance_source_leak')
            if any(scope.get(key) not in (None,value) for key,value in [('project_id',person.project),('checkpoint_id',person.checkpoint),('session_id',session)]):violations.append('guidance_scope_leak')
            if not g.get('instruction') or g.get('mastery_inference') is not False:violations.append('invalid_guidance')
            if g.get('expires_at') and datetime.fromisoformat(g['expires_at']).replace(tzinfo=None)<=Clock.current:violations.append('expired_guidance')
        encoded=stable_json(packet)
        if 'FOREIGN_LEARNER_' in encoded:violations.append('foreign_learner_in_envelope')
        if person.project!=person.other and 'FOREIGN_COURSE_' in encoded:violations.append('foreign_course_in_envelope')
        return evidence,sorted(set(violations))

    async def isolation_and_replay(self,person):
        await self.action(person,'text_first','text','这次回答简短',client_key=f'replay-text-{person.index}')
        before=await self.state(person)
        await self.action(person,'text_replay','text','这次回答简短',client_key=f'replay-text-{person.index}')
        await self.action(person,'text_changed_replay','text','今天只有30分钟',client_key=f'replay-text-{person.index}')
        await self.snapshot(person,'text_idempotency',[
            check('重复文字不增事件',['event_count'],'eq',before['event_count']),
            check('重复文字不增归约',['mutation_count'],'eq',before['mutation_count']),
            check('相同ID异内容必须409',['operation_results','text_changed_replay','expected_rejection'],'eq',409)])
        foreign=SimpleNamespace(**{**vars(person),'project':person.other,'checkpoint':None,'session':person.foreign_session})
        sentinel=f'FOREIGN_COURSE_{person.index}'
        await self.action(foreign,'foreign_background','event',{'event_type':'profile_updated','payload':{'background':sentinel}})
        await self.snapshot(person,'course_isolation',[],[check('别的课程背景不进入规划',['context'],'json_not_contains',sentinel),check('无跨课程输出',['violations'],'empty')])
        await self.snapshot(foreign,'other_course',[],[check('本会话临时指导不进入另一课程',['guidance'],'none',fields={'slot':'response_length'})])
        async with self.sessions() as db:
            outsider=self.models.Learner(key=f'outsider-{person.index}',display_name='隔离负例')
            db.add(outsider);await db.flush()
            outsider_project=self.content.Project(learner_id=outsider.id,name='其他学生课程')
            db.add(outsider_project);await db.commit()
            await self.lr.record_event(db,learner_id=outsider.id,event_type='profile_updated',source='user',
                project_id=outsider_project.id,payload={'background':f'FOREIGN_LEARNER_{person.index}'},
                provenance={'synthetic_script':True})
            await db.commit()
            from fastapi import HTTPException
            try:
                await self.phase3.submit_concept(person.checkpoint,person.questions[0],data={'answer_indexes':[1]},
                    db=db,current=SimpleNamespace(learner=outsider))
            except HTTPException as exc:
                if exc.status_code!=404:raise
                self.operations.append({'label':'cross_owner_submit','result':{'expected_rejection':404},'learner':person.index})
            else:
                raise RuntimeError('Cross-owner submission unexpectedly accepted')
            await db.rollback()
        await self.snapshot(person,'learner_isolation',[],[check('无跨范围输出',['violations'],'empty')])

    async def trajectory(self, person):
        s = ['states']; k = s+['knowledge']; h=s+['human']; p=s+['practice']; v=s+['value']
        no_mastery = check('无稳定掌握升级',k+['long_term','mastery'],'absent_or_empty')
        await self.action(person,'starting','text',f'我已经学过{person.topic}')
        await self.snapshot(person,'self_report',[no_mastery], [guidance('starting_point',kernel='knowledge',evidence_kind='self_reported',source_event_id=self.tags['starting'])])
        await self.action(person,'budget','text','今天只有10分钟，这一步没看懂')
        await self.snapshot(person,'time_and_gap',[no_mastery],
            [guidance('time_budget',minutes=10,source_event_id=self.tags['budget']),guidance('current_blocker',kernel='knowledge',evidence_kind='self_reported_gap',source_event_id=self.tags['budget'])],
            [check('计划遵守本次10分钟',['plan','estimated_minutes'],'lte',10)])
        await self.action(person,'resolved','text','这个问题已经解决了')
        await self.snapshot(person,'resolution',[no_mastery], [guidance('current_blocker',kernel='knowledge',evidence_kind='self_reported_resolution',lifetime='turn',source_event_id=self.tags['resolved'])])
        await self.action(person,'next_turn','text','继续学习')
        await self.snapshot(person,'turn_consumed',[no_mastery], [check('单轮解除提示已消费',['guidance'],'none',fields={'evidence_kind':'self_reported_resolution'})])
        gap=f'我不懂{person.topic}的适用条件'
        await self.action(person,'native_gap','event',{'event_type':'user_message','payload':{'text':gap,'direct_user_input':True}})
        await self.snapshot(person,'native_chat_gap',[no_mastery,check('原生对话记录明确知识缺口',k+['short_term','knowledge_gap'],'eq',gap)],
            [check('缺口正文带来源交付',['evidence'],'evidence',source_event_id=self.tags['native_gap'],terms=[gap])],
            [check('计划优先处理明确缺口',['plan','phases',0,'purpose'],'contains',gap)])
        await self.action(person,'return_anchor','text',f'先补{person.topic}的基础再继续')
        await self.snapshot(person,'return_anchor',[no_mastery],[guidance('return_anchor',kernel='structure',requested_anchor=f'{person.topic}的基础',source_event_id=self.tags['return_anchor'])])
        await self.action(person,'preference','text','以后先举例再讲原理。以后代码示例优先用 Python')
        await self.snapshot(person,'durable_preference',[no_mastery], [guidance('representation',lifetime='persistent',source_event_id=self.tags['preference']),guidance('code_language',language='Python',cancelled=False,source_event_id=self.tags['preference'])])
        await self.action(person,'local','text','这次代码示例用 JavaScript。这次回答简短')
        await self.snapshot(person,'local_override',[no_mastery], [guidance('code_language',language='JavaScript',lifetime='session',source_event_id=self.tags['local']),guidance('response_length',lifetime='turn',source_event_id=self.tags['local'])])
        await self.snapshot(person,'other_session',[no_mastery], [guidance('code_language',language='Python',source_event_id=self.tags['preference']),check('局部要求不跨会话',['guidance'],'none',fields={'lifetime':'turn'})],session=person.other_session)
        Clock.current += timedelta(hours=9)
        await self.snapshot(person,'expired',[no_mastery], [guidance('code_language',language='Python',source_event_id=self.tags['preference']),check('时间要求到期',['guidance'],'none',fields={'slot':'time_budget'})])
        old_time=Clock.current
        await self.action(person,'preference_update','text','以后代码示例优先用 Rust')
        await self.snapshot(person,'preference_updated',[no_mastery],[guidance('code_language',language='Rust',cancelled=False,source_event_id=self.tags['preference_update'])])
        await self.action(person,'cancel','text','以后不用 Rust 示例')
        await self.action(person,'late','text','以后代码示例优先用 Python',older=old_time)
        await self.snapshot(person,'cancel_and_late',[no_mastery],[guidance('code_language',language='Rust',cancelled=True,source_event_id=self.tags['cancel'])])
        await self.action(person,'quoted','text','我的同学说以后代码示例优先用 Java')
        await self.snapshot(person,'third_party',[no_mastery],[guidance('code_language',language='Rust',cancelled=True,source_event_id=self.tags['cancel'])])
        await self.isolation_and_replay(person)
        await self.action(person,'natural_time','text','只剩10分钟')
        await self.snapshot(person,'natural_time_probe',[no_mastery],[guidance('time_budget',minutes=10,source_event_id=self.tags['natural_time'])],
            [check('自然表述计划时间',['plan','estimated_minutes'],'lte',10)],family='natural_language_probe')
        await self.action(person,'natural_hour','text','今天只有1小时')
        await self.snapshot(person,'natural_hour_probe',[no_mastery],[guidance('time_budget',minutes=60,source_event_id=self.tags['natural_hour'])],family='natural_language_probe')
        await self.action(person,'natural_fatigue','text','我今天很累，请放慢节奏')
        await self.snapshot(person,'natural_fatigue_probe',[no_mastery],[guidance('support',source_event_id=self.tags['natural_fatigue'])],family='natural_language_probe')
        await self.action(person,'load','event',{'event_type':'vnext_human_adaptation_requested','payload':{
            'signal_kind':'cognitive_load','value':'reduce_chunk_size','strength':0.9,'explicit':True,
            'evidence_quote':'现在信息量太大，请分小步讲'}})
        await self.snapshot(person,'explicit_load',[check('记录明确当前负荷',h+['short_term','cognitive_load'],'eq',0.9)],
            [guidance('support',source_event_id=self.tags['load'])],[check('高负荷计划缩至20分钟',['plan','estimated_minutes'],'lte',20)])
        await self.snapshot(person,'load_other_session',[],[check('负荷指导不跨会话',['guidance'],'none',fields={'slot':'support'})],session=person.other_session)
        Clock.current+=timedelta(hours=9)
        await self.snapshot(person,'load_expired',[],[check('负荷指导过期',['guidance'],'none',fields={'slot':'support'})])
        await self.action(person,'goal_candidate','event',{'event_type':'profile_updated','payload':{'career_goal':f'探索{person.topic}方向','career_goal_status':'exploring'}})
        await self.snapshot(person,'goal_exploring',[check('探索目标不写确认长期目标',v+['long_term','career_goal'],'absent_or_empty')])
        goal=f'完成{person.topic}课程项目'
        await self.action(person,'goal_confirm','event',{'event_type':'profile_updated','payload':{'career_goal':goal,'career_goal_status':'confirmed'}})
        await self.snapshot(person,'goal_confirmed',[check('确认目标进入长期值',v+['long_term','career_goal'],'eq',goal)],
            [check('当前目标可见',['evidence'],'evidence',source_event_id=self.tags['goal_confirm'],terms=[goal])], [check('规划采用确认目标',['plan','summary'],'contains',goal)])
        await self.action(person,'background','event',{'event_type':'profile_updated','payload':{'background':f'{person.topic}基础尚待验证','preferred_modes':['practice'],'weekly_hours':4}})
        await self.action(person,'concept_self_a','event',{'event_type':'learner_concept_observation_recorded','payload':{
            'concept_key':person.topic,'concept_name':person.topic,'observation_type':'exposure','statement':f'我接触过{person.topic}的课堂例子','verification':'self_reported','source_tag':'user_self_input'}})
        await self.action(person,'concept_self_b','event',{'event_type':'learner_concept_observation_recorded','payload':{
            'concept_key':person.topic,'concept_name':person.topic,'observation_type':'question','statement':f'我需要验证{person.topic}的适用条件','verification':'self_reported','source_tag':'user_self_input'}})
        summary_query=f'总结{person.topic}的知识背景与学习历程'
        await self.snapshot(person,'before_worker',[no_mastery,check('未运行合成无Module',['module_count'],'eq',0)], [check('概念自述待验证内容',['evidence'],'evidence',source_event_id=self.tags['concept_self_b'],terms=[f'我需要验证{person.topic}的适用条件'])],query=summary_query)
        await self.drain_worker()
        await self.snapshot(person,'after_worker',[no_mastery,check('实际完成知识合成',['runs'],'some',fields={'kernel':'knowledge','status':'completed','model':'deterministic'}),
            check('知识Claim保持自述级',['claims'],'some',fields={'verification_status':'self_reported'})], [check('合成后保留待验证内容',['evidence'],'evidence',source_event_id=self.tags['concept_self_b'],terms=[f'我需要验证{person.topic}的适用条件'])],query=summary_query)
        state=await self.state(person)
        knowledge_claim=next((c for c in state['claims'] if f'我需要验证{person.topic}' in c['text'] and c['status']=='active'),None)
        if knowledge_claim:
            await self.action(person,'claim_correction','feedback',{'claim_id':knowledge_claim['id'],'action':'correct',
                'correction':f'我尚未独立验证{person.topic}，需要先做无提示练习'})
            await self.drain_worker()
            await self.snapshot(person,'corrected_claim',[no_mastery,check('旧声明已失效',['claims'],'some',fields={'id':knowledge_claim['id'],'status':'superseded'})],
                [check('纠正正文带来源可见',['evidence'],'evidence',source_event_id=self.tags['claim_correction'],terms=[f'我尚未独立验证{person.topic}'])])
            corrected=next((c for c in (await self.state(person))['claims'] if c['status']=='active' and f'我尚未独立验证{person.topic}' in c['text']),None)
            if corrected:
                await self.action(person,'claim_retraction','feedback',{'claim_id':corrected['id'],'action':'retract'})
                await self.drain_worker()
                await self.snapshot(person,'retracted_claim',[no_mastery,check('撤回声明不再活动',['claims'],'none',fields={'id':corrected['id'],'status':'active'})],
                    [check('撤回后未用失效内容当当前事实',['violations'],'empty')])
            else:self.operations.append({'learner':person.index,'label':'retraction_unavailable','result':{'reason':'failed_corrected_consolidation'}})
        else:self.operations.append({'learner':person.index,'label':'correction_unavailable','result':{'reason':'failed_consolidation'}})
        # Genuine extra observations create history; no MemoryFact is seeded.
        for j in range(self.args.history):
            await self.action(person,f'history-{j}','event',{'event_type':'learner_concept_observation_recorded','payload':{
                'concept_key':f'课程练习{j}','concept_name':f'课程练习{j}','observation_type':'exposure',
                'statement':f'我接触过第{j}个课堂例子','verification':'self_reported','source_tag':'user_self_input'}})
        await self.snapshot(person,'older_learning_context',[no_mastery],[check('较旧课程背景仍可见',['evidence'],'evidence',source_event_id=self.tags['background'],terms=[f'{person.topic}基础尚待验证'])])
        wrong=await self.action(person,'wrong','concept',{'question_id':person.questions[0],'answer_indexes':[0],'assistance_level':'none'},client_key=f'replay-attempt-{person.index}')
        before=await self.state(person)
        await self.action(person,'wrong_replay','concept',{'question_id':person.questions[0],'answer_indexes':[0],'assistance_level':'none'},client_key=f'replay-attempt-{person.index}')
        await self.snapshot(person,'attempt_idempotency',[check('重复提交不增Attempt',['attempt_count'],'eq',before['attempt_count']),
            check('重复提交不增证据',['event_count'],'eq',before['event_count']),check('重复提交不增归约',['mutation_count'],'eq',before['mutation_count'])])
        case=wrong['remediation']['id']
        await self.snapshot(person,'wrong_answer',[no_mastery,check('失败尝试存在',['attempt_count'],'eq',1)],
            [guidance('practice_feedback',kernel='practice',evidence_kind='evaluated_error',source_event_id=self.tags['wrong'])])
        switched=await self.action(person,'switch','switch',{'case_id':case})
        await self.snapshot(person,'change_explanation',[no_mastery,check('原讲法记录无效',h+['short_term','ineffective_explanation_modes'],'contains',wrong['remediation']['current_delivery_mode'])])
        await self.action(person,'assisted_retry','concept',{'question_id':person.questions[0],'answer_indexes':[1],
            'assistance_level':'guided','remediation_case_id':case,'attempt_role':'retry'})
        await self.snapshot(person,'assisted_success',[no_mastery,check('保留辅助等级',p+['short_term','assistance_level'],'eq','guided')],
            [guidance('practice_feedback',kernel='practice',evidence_kind='supported_success',accepted_source_events=self.tags['assisted_retry_events'])],
            [check('规划保留撤除提示步骤',['plan','phases',1,'purpose'],'contains','撤除提示')])
        await self.action(person,'variant','variant',{'case_id':case,'answer_indexes':[1]})
        await self.snapshot(person,'single_variant',[no_mastery,check('变式通过关闭纠错',p+['short_term','remediation_status'],'eq','completed')])
        initial=await self.action(person,'review_initial','concept',{'question_id':person.questions[1],'answer_indexes':[1],'assistance_level':'none'})
        schedule=initial['review_schedule_id']
        before=(await self.state(person))['attempt_count']
        await self.action(person,'missing','review',{'schedule_id':schedule,'response_status':'answered'})
        await self.snapshot(person,'missing_input',[check('缺失不产生Attempt',['attempt_count'],'eq',before),no_mastery,
            check('缺失回答明确422',['operation_results','missing','expected_rejection'],'eq',422)])
        await self.action(person,'skip','review',{'schedule_id':schedule,'response_status':'skipped'})
        await self.snapshot(person,'skip',[check('跳过不产生Attempt',['attempt_count'],'eq',before),no_mastery])
        await self.action(person,'unknown','review',{'schedule_id':schedule,'response_status':'unknown'})
        await self.snapshot(person,'unknown',[check('不会形成独立结果',p+['short_term','review_history',f'concept:{person.questions[1]}','outcome'],'eq','unknown'),no_mastery])
        initial=await self.action(person,'stable_initial','concept',{'question_id':person.questions[2],'answer_indexes':[1],'assistance_level':'none'})
        await self.snapshot(person,'duplicate_question_ids',[check('相同题面换ID不应形成稳定掌握',k+['long_term','mastery',f'checkpoint:{person.checkpoint}'],'absent_or_empty')],family='duplicate_content_probe')
        schedule=initial['review_schedule_id']
        await self.action(person,'review_one','review',{'schedule_id':schedule,'response_status':'answered','answer_indexes':[1],'assistance_level':'none'})
        await self.snapshot(person,'one_independent_review',[check('仅一次复习不形成间隔稳定',k+['long_term','mastery',f'review:concept:{person.questions[2]}'],'absent_or_empty')])
        Clock.current+=timedelta(days=4)
        await self.action(person,'review_two','review',{'schedule_id':schedule,'response_status':'answered','answer_indexes':[1],'assistance_level':'none'})
        mastery_key=f'review:concept:{person.questions[2]}'
        await self.snapshot(person,'spaced_independent',[check('真实复习经过模拟间隔形成稳定证据',k+['long_term','mastery',mastery_key,'level'],'eq','stable'),
            check('保留独立迁移证据',p+['long_term','proof_chain',mastery_key,'kind'],'eq','spaced_independent_transfer')])
        await self.drain_worker()


def summarize(experiment):
    from collections import defaultdict
    rows = defaultdict(list)
    for trial in experiment.trials:
        if trial['repeat'] == 0:
            rows[(trial['variant'],trial['budget'])].append(trial)
    summary=[]
    for (variant,budget),trials in sorted(rows.items()):
        values={'variant':variant,'budget':budget,'conditions':len(trials)}
        for layer in ('delivery','planning'):
            checks=[c for t in trials for c in t['scores'][layer]]
            values[layer]={'passed':sum(c['passed'] for c in checks),'total':len(checks),
                'failed':[{'snapshot':t['snapshot'],'check':c['name']} for t in trials for c in t['scores'][layer] if not c['passed']]}
        values['latency_median_ms']=statistics.median(t['latency_ms'] for t in trials)
        values['packet_characters_mean']=statistics.mean(t['packet_characters'] for t in trials)
        values['budget_failures']=sum(not t['budget_ok'] for t in trials)
        values['safety_violations']=[{'snapshot':t['snapshot'],'violations':t['violations']} for t in trials if t['violations']]
        for layer in ('delivery','planning'):
            for category in ('positive','negative'):
                checks=[c for t in trials for c in t['scores'][layer] if
                    (c['op'] in {'none','empty','not_contains','json_not_contains'})==(category=='negative')]
                values[layer][category]={'passed':sum(c['passed'] for c in checks),'total':len(checks)}
        summary.append(values)
    formation=[c for s in experiment.snapshots for c in s['formation']]
    return {'version':VERSION,'host':experiment.args.host,'courses':experiment.args.courses,'history':experiment.args.history,
        'snapshot_count':len(experiment.snapshots),'operation_count':len(experiment.operations),'trial_count':len(experiment.trials),
        'formation':{'passed':sum(c['passed'] for c in formation),'total':len(formation),
            'failed':[{'snapshot':s['id'],'check':c['name'],'actual':c['actual']} for s in experiment.snapshots for c in s['formation'] if not c['passed']]},
        'repeat_instability':[s['id'] for s in experiment.snapshots if s.get('repeat_instability')], 'variants':summary,
        'formation_by_family':{family:{'passed':sum(c['passed'] for s in experiment.snapshots if s['family']==family for c in s['formation']),
            'total':sum(len(s['formation']) for s in experiment.snapshots if s['family']==family)} for family in sorted({s['family'] for s in experiment.snapshots})},
        'source_audits':[{'snapshot':s['id'],**s['audit']} for s in experiment.snapshots],
        'cache_semantic_differences':[{'snapshot':t['snapshot'],'budget':t['budget']} for t in experiment.trials if t['variant']=='no_head_cache' and t['repeat']==0
            and any(f['snapshot']==t['snapshot'] and f['budget']==t['budget'] and f['repeat']==0 and f['variant']=='full' and f['semantic_hash']!=t['semantic_hash'] for f in experiment.trials)],
        'limits':['synthetic_scripted_trajectories','direct_api_function_boundary_no_http_auth',
            'virtual_business_time_not_actual_delayed_learning','deterministic_worker_and_planner_no_llm',
            'no_student_learning_gain_or_population_accuracy','development_cases_not_blind_holdout']}


async def run(args, output, temporary):
    exp=Experiment(output,temporary,args)
    await exp.initialize()
    with business_clock():
        for index in range(args.courses):
            Clock.current=BASE_TIME+timedelta(days=10*index)
            person=await exp.seed_content(index)
            await exp.trajectory(person)
    write_json(output/'summary.json',summarize(exp))
    write_json(output/'snapshots.json',exp.snapshots)
    write_json(output/'operations.json',exp.operations)
    await exp.engine.dispose()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--host',choices=['web','desktop'],default='web')
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--courses',type=int,choices=range(1,5),default=4)
    parser.add_argument('--history',type=int,default=32)
    parser.add_argument('--budgets',type=int,nargs='+',default=[1800,3200])
    parser.add_argument('--repetitions',type=int,default=2)
    args=parser.parse_args()
    output=args.output.resolve()
    output.mkdir(parents=True,exist_ok=False)
    root=Path(__file__).resolve().parents[3]
    host=root/('backend' if args.host=='web' else 'apps/desktop/backend')
    sys.path.insert(0,str(host))
    sys.path.insert(1,str(root/'packages/learning-core/src'))
    with tempfile.TemporaryDirectory(prefix='learnflow-education-eval-') as temp:
        temporary=Path(temp)
        os.environ.update(DATABASE_URL=f'sqlite+aiosqlite:///{temporary}/base.db',LLM_API_KEY='',
            MEMORY_AUTO_SYNTHESIS_ENABLED='false',MEMORY_WORKER_EMBEDDED='false')
        source_files=list(Path(__file__).parent.glob('*.py'))+[Path(__file__).with_name('PROTOCOL.md')]
        source_files+=list((root/'packages/learning-core/src/learnflow_core').rglob('*.py'))
        source_files+=list((host/'app').rglob('*.py'))
        source_files=list(set(source_files))
        hashes={str(p.relative_to(root)):sha(p) for p in sorted(source_files)}
        import shutil
        for p in source_files:
            dest=output/'source'/p.relative_to(root)
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(p,dest)
        manifest={'version':VERSION,'host':args.host,'arguments':vars(args),
            'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
            'source_hashes':hashes,
            'python_version':sys.version,'python_executable':sys.executable,
            'clock':'virtual business UTC; ORM audit creation timestamps remain real',
            'network':'socket.connect and socket.connect_ex rejected; no LLM keys'}
        from importlib.metadata import version
        manifest['dependencies']={name:version(name) for name in ['SQLAlchemy','pydantic','fastapi','aiosqlite']}
        write_json(output/'manifest.json',manifest)
        network_attempts=[]
        def blocked(*_args,**_kwargs):
            network_attempts.append('blocked')
            raise RuntimeError('Experiment forbids network connections')
        try:
            with patch.object(socket.socket,'connect',blocked),patch.object(socket.socket,'connect_ex',blocked):
                asyncio.run(run(args,output,temporary))
            manifest['status']='completed'
        except BaseException as exc:
            manifest['status']='failed'
            manifest['error']=f'{type(exc).__name__}: {exc}'
            raise
        finally:
            manifest['end_source_hashes']={str(p.relative_to(root)):sha(p) for p in sorted(source_files)}
            manifest['source_changes']=[name for name,h in hashes.items() if manifest['end_source_hashes'][name]!=h]
            manifest['blocked_network_attempts']=len(network_attempts)
            write_json(output/'manifest.json',manifest)
        if manifest['source_changes'] or network_attempts:
            raise RuntimeError('Run cannot be accepted: source changed or network attempted')
    print(str(output/'summary.json'))


if __name__=='__main__':
    main()
