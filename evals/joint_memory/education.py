#!/usr/bin/env python3
"""Frozen computing cases through real offline LearnFlow formation and reading.

Authored free responses become a bounded two-option recognition task. Only the
production submit API grades that task; authored outcome never enters an event.
This is not code execution, open-answer assessment, teacher review or learning gain.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

from education_verifier import verify_formation, verify_trial

VERSION = 'joint-education-memory.v1'
VARIANTS = ('full', 'facts_only', 'recent_facts', 'no_relations', 'no_guidance', 'no_memory')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc).replace(tzinfo=None)


class ClockMeta(type):
    def __instancecheck__(cls, value):
        return isinstance(value, datetime)


class Clock(datetime, metaclass=ClockMeta):
    current = datetime(2026, 3, 2, 9)

    @classmethod
    def utcnow(cls):
        return cls.current

    @classmethod
    def now(cls, tz=None):
        return cls.current if tz is None else cls.current.replace(tzinfo=timezone.utc).astimezone(tz)


class Clocks:
    """Refresh after lazy imports; ORM audit defaults remain real, disclosed below."""
    def __init__(self):
        self.saved = {}

    def refresh(self):
        for name, module in list(sys.modules.items()):
            if name.startswith(('app.', 'learnflow_core.')) and getattr(module, 'datetime', None) is datetime:
                self.saved[name] = module
                module.datetime = Clock

    def close(self):
        for module in self.saved.values():
            module.datetime = datetime


def native_current(packet, event_ids):
    """Identity-based control boundary, independent of author slots/gold values."""
    def matches(row):
        refs = [row.get('source_event_id')]
        refs.extend(row.get('source_event_ids') or [])
        refs.extend(row.get('evidence_event_ids') or [])
        return bool(set(ref for ref in refs if type(ref) is int) & set(event_ids))
    return {key: [deepcopy(row) for row in packet.get(key, []) if matches(row)]
            for key in ('teaching_guidance', 'adaptation_directives')}


def packet_tokens(packet):
    body = {'heads':packet.get('kernel_heads',{}), 'items':packet.get('items',[]),
        'paths':packet.get('relation_paths',[]), 'personal_concept_graph':packet.get('personal_concept_graph',{}),
        'adaptation_directives':packet.get('adaptation_directives',{}), 'teaching_guidance':packet.get('teaching_guidance',{})}
    return max(1, math.ceil(len(json.dumps(body,ensure_ascii=False,sort_keys=True,default=str))/3.2))


def intervene(packet, variant, current):
    result = deepcopy(packet)
    if variant == 'no_memory':
        result = {'scope': deepcopy(packet.get('scope', {})), 'items': [], 'relation_paths': [],
                  'kernel_heads': {}, **deepcopy(current),
                  'manifest': {'direct_memory_evidence': False}}
    elif variant == 'no_guidance':
        result['teaching_guidance'] = deepcopy(current['teaching_guidance'])
        # adaptation is an independent channel. Preserve it as in the prior protocol.
    if variant in ('no_guidance','no_memory'):
        result['manifest']['pre_ablation_token_estimate'] = packet.get('manifest',{}).get('token_estimate')
        result['manifest']['token_estimate'] = packet_tokens(result)
        result['manifest']['evaluation_intervention'] = variant
    return result


class Driver:
    def __init__(self, args, temporary, output):
        self.args, self.tmp, self.out = args, Path(temporary), output
        self.clock = Clocks()
        self.formation_rows, self.trial_rows, self.gap_counts = [], [], Counter()
        self.started = time.perf_counter()
        self.real_calls = Counter()
        self.formed_case_ids = set()

    async def initialize(self):
        import app.models
        from app.db.database import Base, engine as bootstrap_engine
        from sqlalchemy import select
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.models import learning, project
        from app.api import phase3, learner_state, agent
        from app.services import learning_runtime, memory_worker, five_kernel_context, learning_tasks
        # Resolve grading/worker dependencies before freezing module clocks.
        for name in ('dynamic_practice', 'progress', 'review', 'remediation', 'profile', 'teaching_guidance',
                     'memory_graph', 'learning_continuity', 'learning_task_runtime'):
            try:
                importlib.import_module('app.services.' + name)
            except ModuleNotFoundError as exc:
                if exc.name != 'app.services.' + name:
                    raise
        from app.core.config import settings
        settings.llm_api_key = ''
        settings.embedding_api_key = ''
        settings.vision_api_key = ''
        settings.memory_auto_synthesis_enabled = False
        settings.memory_worker_embedded = False
        self.m, self.p = learning, project
        self.phase3, self.inputs, self.ui_events = phase3, learner_state, agent
        self.runtime, self.worker, self.context, self.planner = learning_runtime, memory_worker, five_kernel_context, learning_tasks
        self.select, self.engine_factory, self.session_factory = select, create_async_engine, async_sessionmaker
        self.template = self.tmp/'template.db'
        engine = create_async_engine(f'sqlite+aiosqlite:///{self.template}')
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        await engine.dispose()
        await bootstrap_engine.dispose()
        self.clock.refresh()

    async def identities(self, db, case, family):
        learner = self.m.Learner(key=case['case_id'], display_name='合成学习者')
        db.add(learner)
        await db.flush()
        project = self.p.Project(learner_id=learner.id, name=family['course'], description='Isolated synthetic curriculum')
        db.add(project)
        await db.flush()
        roadmap = self.p.Roadmap(project_id=project.id, raw_json={})
        db.add(roadmap)
        await db.flush()
        checkpoint = self.p.Checkpoint(roadmap_id=roadmap.id, title=family['title'], order=1,
            prerequisites=[], learning_status='in_progress')
        db.add(checkpoint)
        await db.flush()
        session_names = {case['current']['session_id']} | {r['scope']['session_id'] for r in case['observations']}
        sessions = {}
        for name in sorted(session_names):
            row = self.m.AgentSession(learner_id=learner.id, project_id=project.id,
                checkpoint_id=checkpoint.id, session_type='checkpoint')
            db.add(row)
            await db.flush()
            sessions[name] = row.id
        questions = {}
        for index, probe in enumerate(family['probes']):
            if probe['answer_validation'] != 'executable':
                continue
            options = [probe['correct_response'], probe['incorrect_response']]
            random.Random(int(digest([family['family_id'], probe['id']])[:12], 16)).shuffle(options)
            question = self.p.ConceptQuestion(checkpoint_id=checkpoint.id,
                question=family['title']+'\n'+probe['prompt']+'\n'+probe['artifact'],
                options=options, answer_indexes=[options.index(probe['correct_response'])], q_type='single',
                difficulty='medium', explanation='本题采用已独立计算校验的封闭候选；不评价原始开放作答能力。',
                order=index+1, assessment_meta={'targets':[family['title']],
                    'family_id':family['family_id'], 'concept_key':family['family_id'],
                    'source':'authored_closed_choice_adapter', 'original_probe_hash':digest(probe)})
            db.add(question)
            await db.flush()
            questions[probe['id']] = (question.id, options)
        await db.commit()
        return SimpleNamespace(learner=learner, project=project.id, checkpoint=checkpoint.id,
            session=sessions[case['current']['session_id']], sessions=sessions, questions=questions)

    async def text(self, db, person, text, key, session, occurred_at):
        request = self.inputs.LearnerEventRequest(event_type='vnext_teaching_input_received',
            client_event_id=key, project_id=person.project, checkpoint_id=person.checkpoint,
            session_id=session, occurred_at=occurred_at, payload={'text':text})
        return await self.inputs.sync_learner_event(request, current=person, db=db)

    async def replay(self, sessions, person, case, family, rubric):
        operations, expected, gaps = [], [], []
        references = set(rubric.get('evidence_refs', []))
        current = case['current']
        for item in sorted(case['observations'], key=lambda row:(row['recorded_at'],row['occurred_at'],row['id'])):
            row = {'observation_id':item['id'], 'kind':item['kind'], 'status':'pending',
                   'original_session_id':item['scope']['session_id']}
            scope = item['scope']
            if scope['learner_id'] != current['learner_id'] or scope['project_id'] != current['project_id']:
                row.update(status='filtered_at_adapter_boundary', reason='foreign_scope_not_ingested')
                operations.append(row)
                continue
            if item['recorded_at'] > current['at'] or item['occurred_at'] > current['at']:
                row.update(status='filtered_at_adapter_boundary', reason='unavailable_at_query_not_ingested')
                operations.append(row)
                continue
            Clock.current = parse_time(item['recorded_at'])
            self.clock.refresh()
            payload = item['payload']
            async with sessions() as db:
                if item['kind'] == 'learner_statement':
                    result = await self.text(db, person, payload['text'], 'input-'+item['id'],
                        person.sessions[scope['session_id']], parse_time(item['occurred_at']))
                    row.update(status='production_input', event_ids=[result['event_id']], input_text=payload['text'])
                    if item['id'] in references:
                        expected.append({'source_event_id':result['event_id'], 'terms':[payload['text']], 'kind':'raw_statement'})
                    if payload.get('valid_until'):
                        gaps.append({'observation_id':item['id'], 'reason':'explicit_valid_until_not_supported_by_native_parser'})
                elif item['kind'] == 'assessment_observation':
                    probe = next(p for p in family['probes'] if p['id']==payload['probe_ref'])
                    if probe['answer_validation'] != 'executable':
                        row.update(status='adapter_gap', reason='reasoned_draft_has_no_executable_answer_oracle')
                    elif payload.get('outcome') in ('missing','skipped','dont_know'):
                        # Do not turn missing/nonanswers into an empty choice and grade it wrong.
                        row.update(status='adapter_gap', reason='nonanswer_requires_formal_review_presentation_not_seeded_here')
                    elif payload.get('assistance') == 'unknown':
                        row.update(status='adapter_gap', reason='concept_api_rejects_unknown_assistance_no_default_none')
                    else:
                        question_id, options = person.questions[payload['probe_ref']]
                        response = payload.get('response')
                        matches = [i for i, option in enumerate(options) if response == option]
                        if len(matches) != 1:
                            row.update(status='adapter_gap', reason='response_not_unique_closed_candidate')
                        else:
                            assistance = {'none':'none','worked_example':'guided'}.get(payload.get('assistance'))
                            if assistance is None:
                                row.update(status='adapter_gap', reason='unsupported_assistance_enum')
                            else:
                                result = await self.phase3.submit_concept(person.checkpoint, question_id,
                                    data={'answer_indexes':matches, 'assistance_level':assistance,
                                          'client_submission_id':'submit-'+item['id']}, current=person, db=db)
                                events = (await db.execute(self.select(self.m.EvidenceEvent).where(
                                    self.m.EvidenceEvent.event_type=='concept_attempt_evaluated'))).scalars().all()
                                grades = [e for e in events if (e.payload or {}).get('attempt_id')==result['attempt_id']]
                                if len(grades) != 1:
                                    raise AssertionError('Production attempt did not create one linked grade event')
                                event = grades[0]
                                row.update(status='production_assessment', attempt_id=result['attempt_id'],
                                    event_ids=[event.id], submitted_response=response, selected_indexes=matches,
                                    requested_assistance=assistance, actual_assistance=event.payload.get('assistance_level'),
                                    actual_correct=event.payload.get('correct'), oracle_expected_correct=response==probe['correct_response'],
                                    original_fixture_outcome=payload.get('outcome'),
                                    production_session_id=event.session_id,
                                    requested_production_session_id=person.sessions[scope['session_id']],
                                    scope_fidelity='learner_project_checkpoint_preserved; concept_API_owns_actual_session_binding',
                                    task_form='closed_choice_adapter_not_open_answer_assessment')
                                if event.session_id!=person.sessions[scope['session_id']]:
                                    gaps.append({'observation_id':item['id'],'reason':'concept_api_does_not_accept_original_historical_session_scope'})
                                if item['id'] in references:
                                    expected.append({'source_event_id':event.id,'terms':[family['title']], 'kind':'assessment_topic'})
                elif item['kind'] == 'resource_view':
                    # Simulate the registered UI exposure receipt. No claim that a
                    # browser was operated or a person spent the authored duration.
                    result=await self.ui_events.create_learning_event(
                        self.ui_events.LearningEventRequest(event_type='lecture_viewed',
                            client_event_id='view-'+item['id'],project_id=person.project,
                            checkpoint_id=person.checkpoint,session_id=person.sessions[scope['session_id']],
                            payload={**payload,'adapter_status':'synthetic_ui_exposure',
                                'original_observation_id':item['id'],
                                'original_provenance':item['provenance']}),db=db,current=person)
                    row.update(status='production_ui_exposure_simulation',event_ids=[result['id']],
                        input_text=payload['text'],reason='simulated_UI_receipt_not_actual_browsing_or_elapsed_reading')
                elif item['kind'] in ('support_feedback','task_paused'):
                    # Preserve the utterance through the genuine input parser, but do not
                    # manufacture interpretation fields or claim a missing tool event exists.
                    result = await self.text(db,person,payload['text'],'text-'+item['id'],
                        person.sessions[scope['session_id']],parse_time(item['occurred_at']))
                    row.update(status='text_only_partial_adapter',event_ids=[result['event_id']],input_text=payload['text'],
                               reason='observation_semantics_not_claimed_as_tool_or_individual_success')
                    gaps.append({'observation_id':item['id'],'reason':item['kind']+'_only_original_text_parser_evaluated'})
                    if item['id'] in references:
                        expected.append({'source_event_id':result['event_id'],'terms':[payload['text']], 'kind':'raw_statement'})
                else:
                    row.update(status='adapter_gap',reason={
                        'resource_view':'no_owned_resource_asset_or_formal_view_receipt',
                        'execution_observation':'no_actual_execution_no_fabricated_infrastructure_result',
                        'source_correction':'no_registered_original_attempt_source_retraction',
                        'artifact_observation':'no_actual_owned_team_artifact_receipt_or_individual_success',
                    }.get(item['kind'],'unmapped_observation_kind'))
            if row['status']=='adapter_gap':
                gaps.append({'observation_id':item['id'],'reason':row['reason']})
            operations.append(row)
        Clock.current = parse_time(current['at'])
        self.clock.refresh()
        async with sessions() as db:
            result = await self.text(db,person,current['request'],'current-'+case['case_id'],person.session,Clock.current)
        current_ids = [result['event_id']]
        operations.append({'observation_id':'current_request','kind':'learner_statement','status':'production_input',
                           'event_ids':current_ids,'input_text':current['request']})
        return operations, expected, gaps, current_ids

    async def state(self, sessions):
        m = self.m
        async with sessions() as db:
            async def rows(model):
                return (await db.execute(self.select(model))).scalars().all()
            events, mutations, states, attempts, nodes, facts, runs = [await rows(model) for model in
                (m.EvidenceEvent,m.KernelMutation,m.KernelState,m.LearningAttempt,m.MemoryNode,m.MemoryFact,m.MemorySynthesisRun)]
            by_node = {n.id:n for n in nodes}
            by_fact = {f.node_id:f for f in facts}
            source_nodes = {}
            for n in nodes:
                fact_ids = [n.id] if n.id in by_fact else (n.payload or {}).get('evidence_fact_ids', [])
                source_nodes[n.id] = {'text':n.text,'learner_id':n.learner_id,'project_id':n.project_id,
                    'checkpoint_id':n.checkpoint_id,'session_id':n.session_id,'status':n.status,'kernel':n.kernel_name, 'node_type':n.node_type,
                    'valid_to':n.valid_to, 'source_event_id':by_fact[n.id].source_event_id if n.id in by_fact else None,
                    'evidence_fact_ids':fact_ids,
                    'evidence_event_ids':sorted({by_fact[f].source_event_id for f in fact_ids if f in by_fact})}
            return {'events':[{'id':e.id,'event_type':e.event_type,'payload':e.payload,'occurred_at':e.occurred_at,
                              'learner_id':e.learner_id,'project_id':e.project_id,'checkpoint_id':e.checkpoint_id,'session_id':e.session_id} for e in events],
                'mutations':[{'id':x.id,'event_id':x.event_id,'kernel':x.kernel_name} for x in mutations],
                'states':{x.kernel_name:{'short_term':x.short_term,'long_term':x.long_term} for x in states},
                'attempts':[{'id':x.id,'item_id':x.item_id,'assistance_level':x.assistance_level,'result':x.result,
                             'status':x.status,'attempt_role':x.attempt_role} for x in attempts],
                'facts':[{'id':x.node_id,'text':by_node[x.node_id].text,'event_id':x.source_event_id,
                          'mutation_id':x.source_mutation_id,'kernel':by_node[x.node_id].kernel_name,'grade':x.evidence_grade} for x in facts],
                'worker_runs':[{'id':x.id,'status':x.status,'model_name':x.model_name} for x in runs],
                'source_nodes':source_nodes,
                'node_type_counts':dict(Counter(n.node_type for n in nodes))}

    async def drain(self, sessions):
        original = self.worker.async_session
        self.worker.async_session = sessions
        count = 0
        try:
            # Existing events queue genuine synthesis; no perfect Module is authored.
            self.clock.refresh()
            await self.worker.reconcile_eligible_synthesis_runs()
            for _ in range(64):
                processed = await self.worker.process_due_runs(limit=16)
                count += processed
                if not processed:
                    break
            else:
                raise RuntimeError('Worker did not reach bounded idle')
        finally:
            self.worker.async_session = original
        return count

    async def run_case(self, case, family, rubric, split, streams):
        case_start = time.perf_counter()
        folder = self.tmp/'case'
        shutil.rmtree(folder,ignore_errors=True)
        folder.mkdir()
        base = folder/'base.db'
        shutil.copyfile(self.template,base)
        engine = self.engine_factory(f'sqlite+aiosqlite:///{base}')
        sessions = self.session_factory(engine,expire_on_commit=False)
        Clock.current = parse_time(case['observations'][0]['occurred_at'])
        try:
            async with sessions() as db:
                person = await self.identities(db,case,family)
            operations,expected,gaps,current_ids = await self.replay(sessions,person,case,family,rubric)
            worker_processed = await self.drain(sessions)
            state = await self.state(sessions)
            formation = verify_formation(state)
            submitted=[r for r in operations if r['status']=='production_assessment']
            independent_grade_errors=[r['observation_id'] for r in submitted if type(r['actual_correct']) is not bool or r['actual_correct']!=r['oracle_expected_correct']]
            assistance_fidelity_errors=[r['observation_id'] for r in submitted if r['actual_assistance']!=r['requested_assistance']]
            for name,errors,rule in [('oracle_response_grade',independent_grade_errors,'Native correct equals independently checked response candidate truth, not authored outcome'),
                ('assistance_adapter_fidelity',assistance_fidelity_errors,'Native assistance equals requested assistance; mismatch may be legitimate native repeat/exposure downgrade')]:
                formation['checks'].append({'name':name,'passed':not errors if submitted else None,'denominator':len(submitted),'actual':errors,'expected':rule})
            fact_event_ids={f['event_id'] for f in state['facts']}
            formation_delivery_gaps=[]
            for entry in expected:
                entry['source_fact_available']=entry['source_event_id'] in fact_event_ids
                if not entry['source_fact_available']:
                    formation_delivery_gaps.append({'source_event_id':entry['source_event_id'],'kind':entry['kind'],'reason':'reference_event_formed_no_memory_fact'})
            assistance_rank={'none':0,'hint':1,'guided':2}
            assistance_errors=[r['observation_id'] for r in submitted if assistance_rank.get(r.get('actual_assistance'),-1)<assistance_rank[r['requested_assistance']]]
            formation['checks'].append({'name':'assistance_not_promoted','passed':not assistance_errors if submitted else None,
                'denominator':len(submitted),'actual':assistance_errors,'expected':'Production assistance cannot be lower than the real submitted level'})
            identity = {'case_id':case['case_id'],'family_id':family['family_id'],'domain':family['domain'],
                        'split':split,'pattern':rubric['pattern']}
            record = {**identity,'checks':formation['checks'],'unscored':formation.get('unscored',[]),
                'operations':operations,'adapter_gaps':gaps,'formation_delivery_gaps':formation_delivery_gaps,'worker_processed':worker_processed,
                'worker_runs':state['worker_runs'],'counts':{key:len(state[key]) for key in
                    ('events','mutations','attempts','facts')},'node_type_counts':state['node_type_counts'],
                'current_event_ids':current_ids,'current_request_sha256':digest(case['current']['request']),
                'actual_assistance_counts':dict(Counter(r['actual_assistance'] for r in submitted)),
                'observation_status_counts':dict(Counter(r['status'] for r in operations)),
                'exposure_formation':{'simulated_ui_receipts':sum(r['status']=='production_ui_exposure_simulation' for r in operations),
                    'facts_from_receipts':sum(f['event_id'] in {e for r in operations if r['status']=='production_ui_exposure_simulation' for e in r['event_ids']} for f in state['facts'])}}
            streams['formation'].write(encoded(record)+'\n')
            self.formed_case_ids.add(case['case_id'])
            streams['raw'].write(encoded({**identity,'kind':'formation','state':state})+'\n')
            self.formation_rows.append({k:v for k,v in record.items() if k not in ('operations','worker_runs')})
            self.gap_counts.update(g['reason'] for g in gaps)
            # Use the real selector before any ablation to freeze native current controls.
            async with sessions() as db:
                self.real_calls['setup_control_selection_retrieval']+=1
                current_packet = await self.context.build_five_kernel_context(db,learner_id=person.learner.id,
                    project_id=person.project,checkpoint_id=person.checkpoint,session_id=person.session,
                    policy=replace(self.context.CONTEXT_POLICIES['checkpoint_tutor'],token_budget=max(self.args.budgets)),
                    query=case['current']['request'])
                current_controls = native_current(current_packet,current_ids)
                await db.rollback()
            paths = {'full':base}
            for name in ('facts_only','recent_facts'):
                path = folder/(name+'.db')
                with sqlite3.connect(base) as source, sqlite3.connect(path) as out:
                    source.backup(out)
                    out.execute('DELETE FROM memory_edges WHERE source_node_id IN (SELECT id FROM memory_nodes WHERE node_type!=?) OR target_node_id IN (SELECT id FROM memory_nodes WHERE node_type!=?)',('fact','fact'))
                    out.execute('DELETE FROM memory_claims')
                    out.execute('DELETE FROM memory_modules')
                    out.execute("DELETE FROM memory_nodes WHERE node_type!='fact'")
                    out.execute('DELETE FROM kernel_heads')
                    if name=='recent_facts':
                        out.execute('DELETE FROM memory_nodes WHERE id NOT IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY learner_id,project_id ORDER BY occurred_at DESC,id DESC) rn FROM memory_nodes) WHERE rn<=24)')
                        out.execute('DELETE FROM memory_facts WHERE node_id NOT IN (SELECT id FROM memory_nodes)')
                        out.execute('DELETE FROM memory_edges WHERE source_node_id NOT IN (SELECT id FROM memory_nodes) OR target_node_id NOT IN (SELECT id FROM memory_nodes)')
                    out.commit()
                paths[name]=path
            reads={name:self.engine_factory(f'sqlite+aiosqlite:///{path}') for name,path in paths.items()}
            try:
                for read_engine in reads.values():
                    async with self.session_factory(read_engine,expire_on_commit=False)() as db:
                        await self.context.ensure_kernel_heads(db,person.learner.id)
                        await db.commit()
                jobs=[(variant,budget) for variant in self.args.variants for budget in self.args.budgets]
                random.Random(int(digest(case['case_id'])[:10],16)).shuffle(jobs)
                original = self.context.build_five_kernel_context
                for variant,budget in jobs:
                    read_engine=reads[variant if variant in paths else 'full']
                    policy=replace(self.context.CONTEXT_POLICIES['checkpoint_tutor'],token_budget=budget)
                    if variant=='no_relations':policy=replace(policy,max_paths=0)
                    hashes=[]
                    for repeat in range(self.args.repetitions):
                        captured={}
                        async def reader(db,**kwargs):
                            kwargs['policy']=policy
                            self.real_calls['trial_memory_retrieval']+=1
                            packet=await original(db,**kwargs)
                            captured['retrieval_calls'] = captured.get('retrieval_calls',0)+1
                            captured['pre_ablation_token_estimate'] = packet.get('manifest',{}).get('token_estimate')
                            captured['pre_ablation_budget_valid'] = packet_tokens(packet)==packet.get('manifest',{}).get('token_estimate') and packet_tokens(packet)<=budget
                            if native_current(packet,current_ids)!=current_controls:
                                raise AssertionError('Native current controls differ by budget/read variant; cannot inject controls and retain original budget')
                            packet=intervene(packet,variant,current_controls)
                            captured['packet']=packet
                            return packet
                        async with self.session_factory(read_engine,expire_on_commit=False)() as db:
                            self.clock.refresh()
                            started=time.perf_counter()
                            if variant=='no_memory':
                                context={}
                                for entry in current_controls['teaching_guidance']:
                                    context.setdefault(entry['kernel'],{}).setdefault('teaching_guidance',[]).append(deepcopy(entry))
                                captured['packet']=intervene({'scope':deepcopy(current_packet.get('scope',{}))},variant,current_controls)
                                captured['retrieval_calls']=0
                                captured['pre_ablation_budget_valid']=None
                            else:
                                with patch.object(self.context,'build_five_kernel_context',reader):
                                    context=await self.planner._scoped_planner_context(db,learner_id=person.learner.id,
                                        project_id=person.project,checkpoint_id=person.checkpoint,session_id=person.session,
                                        objective=case['current']['request'])
                            self.real_calls['offline_planner']+=1
                            plan=await self.planner.generate_learning_task_plan(title=family['title'],
                                objective=case['current']['request'],origin_kind='checkpoint',estimated_minutes=45,learner_context=context)
                            elapsed=(time.perf_counter()-started)*1000
                            packet=captured['packet']
                            control_same=native_current(packet,current_ids)==current_controls
                            if not control_same:raise AssertionError('Current controls changed across ablations')
                            measured_case={**case,'_budget':budget,'_scope':{'learner_id':person.learner.id,
                                'project_id':person.project,'checkpoint_id':person.checkpoint,'session_id':person.session}}
                            audit_packet={**packet,'_source_nodes':state['source_nodes'],
                                '_source_events':{e['id']:e for e in state['events']}}
                            scored=verify_trial(audit_packet,plan,measured_case,rubric,expected)
                            scored['checks'].append({'name':'current_controls_identical','passed':control_same,
                                'actual':digest(native_current(packet,current_ids)),'expected':digest(current_controls)})
                            sem=digest({'packet':packet,'plan':plan,'checks':scored['checks']})
                            hashes.append(sem)
                            metrics={'actual_plan_minutes':None,**{check['name']:check['passed'] for check in scored['checks']}}
                            metrics.update({entry['name']:None for entry in scored.get('unscored',[]) if entry['name'] not in metrics})
                            for check in scored['checks']:
                                if check['name'].endswith('evidence_delivered'):
                                    rows=check['actual'] if isinstance(check['actual'],list) else check['actual'].get('evidence',[])
                                    metrics[check['name']+'_denominator']=len(rows)
                                    metrics[check['name']+'_numerator']=sum(int(r['delivered']) for r in rows)
                                    for kind in ('raw_statement','assessment_topic'):
                                        members=[r for r in rows if r['kind']==kind]
                                        metrics[check['name']+'_'+kind+'_numerator']=sum(int(r['delivered']) for r in members)
                                        metrics[check['name']+'_'+kind+'_denominator']=len(members)
                                    formed=[r for r in rows if expected[r['index']]['source_fact_available']]
                                    metrics[check['name']+'_formed_source_fact_numerator']=sum(int(r['delivered']) for r in formed)
                                    metrics[check['name']+'_formed_source_fact_denominator']=len(formed)
                            metrics['formation_delivery_gap_count']=len(formation_delivery_gaps)
                            metrics.update(latency_ms=elapsed,packet_characters=len(encoded(packet)),
                                packet_token_estimate=packet.get('manifest',{}).get('token_estimate'),
                                plan_estimated_minutes=plan.get('estimated_minutes'),
                                retrieval_calls=captured.get('retrieval_calls',0),planner_calls=1,
                                pre_ablation_budget_valid=captured.get('pre_ablation_budget_valid'))
                            row={**identity,'variant':variant,'budget':budget,'repeat':repeat,'metrics':metrics,'latency_ms':elapsed,
                                'packet_characters':len(encoded(packet)),'packet_token_estimate':packet.get('manifest',{}).get('token_estimate'),
                                'item_count':len(packet.get('items',[])),'path_count':len(packet.get('relation_paths',[])),
                                'checks':scored['checks'],'unscored':scored.get('unscored',[]),'semantic_hash':sem,
                                'current_control_hash':digest(current_controls),'current_request_sha256':digest(case['current']['request']),
                                'adapter_gap_count':len(gaps),'plan_estimated_minutes':plan.get('estimated_minutes'),
                                'node_type_counts':state['node_type_counts']}
                            streams['trials'].write(encoded({k:v for k,v in row.items() if k not in ('checks','unscored')})+'\n')
                            streams['raw'].write(encoded({**identity,'kind':'trial','variant':variant,'budget':budget,'repeat':repeat,
                                'checks':scored['checks'],'unscored':scored.get('unscored',[])})+'\n')
                            if self.args.save_packets:
                                streams['raw'].write(encoded({**identity,'variant':variant,'budget':budget,'repeat':repeat,
                                    'packet':packet,'planner_context':context,'plan':plan})+'\n')
                            self.trial_rows.append({**{k:v for k,v in row.items() if k not in ('checks','unscored')},
                                'checks':[{'name':c['name'],'passed':c['passed']} for c in scored['checks']]})
                            await db.rollback()
                    if len(set(hashes))!=1:
                        streams['errors'].write(encoded({**identity,'kind':'repeat_instability','variant':variant,'budget':budget})+'\n')
            finally:
                for read_engine in reads.values():await read_engine.dispose()
            return {'case_id':case['case_id'],'seconds':round(time.perf_counter()-case_start,3),
                    'gaps':len(gaps),'facts':len(state['facts']),'attempts':len(state['attempts'])}
        finally:
            await engine.dispose()

    def summary(self):
        def summarize(rows, keys):
            groups=defaultdict(list)
            for row in rows:
                if row.get('repeat',0)==0:groups[tuple(row[k] for k in keys)].append(row)
            output=[]
            for values, group in sorted(groups.items()):
                metrics=defaultdict(lambda:{'passed':0,'total':0})
                for row in group:
                    for check in row['checks']:
                        if check['passed'] is not None:
                            metrics[check['name']]['passed']+=int(check['passed'])
                            metrics[check['name']]['total']+=1
                record={**dict(zip(keys,values)),'cases':len(group),'metrics':dict(metrics)}
                if 'latency_ms' in group[0]:
                    record.update(latency_median_ms=statistics.median(r['latency_ms'] for r in group),
                                  packet_characters_mean=statistics.mean(r['packet_characters'] for r in group))
                output.append(record)
            return output
        return {'version':VERSION,'host':self.args.host,'case_count':len(self.formation_rows),'trial_count':len(self.trial_rows),
            'formation':summarize(self.formation_rows,('family_id','split','pattern')),
            'by_family_split_pattern':summarize(self.trial_rows,('family_id','split','pattern','variant','budget')),
            'by_domain_pattern':summarize(self.trial_rows,('domain','pattern','variant','budget')),
            'adapter_gap_reasons':dict(self.gap_counts),'elapsed_seconds':time.perf_counter()-self.started,
            'real_calls':dict(self.real_calls),
            'no_combined_score':True,'teacher_review':'pending',
            'unscored':['Open-ended teaching semantic rubrics','Actual student learning gain','Original code execution',
                        'Free-answer grading equivalence','Custom expiry parsed from ISO valid_until',
                        'Original Attempt source retraction','Cross-scope/future robustness after exporter filtering',
                        'Current adaptation attribution: production directives omit source event IDs',
                        'UI exposure receipts simulate authored events; not actual reading time']}


async def run(args, temporary, output, selected, families, rubrics, splits):
    driver=Driver(args,temporary,output)
    await driver.initialize()
    failures=0
    with ExitStack() as stack:
        streams={name:stack.enter_context(open(output/(name+'.jsonl'),'w',encoding='utf-8'))
                 for name in ('formation','trials','errors')}
        streams['raw']=stack.enter_context(gzip.open(output/'raw.jsonl.gz','wt',encoding='utf-8'))
        try:
            for index,case in enumerate(selected):
                try:
                    result=await driver.run_case(case,families[case['family_id']],rubrics[case['case_id']],splits[case['family_id']],streams)
                    print(encoded({'completed':index+1,'total':len(selected),**result}),flush=True)
                except Exception as exc:
                    import traceback
                    failures+=1
                    if case['case_id'] not in driver.formed_case_ids:
                        streams['formation'].write(encoded({'case_id':case['case_id'],'family_id':case['family_id'],
                            'pattern':rubrics[case['case_id']]['pattern'],'split':splits[case['family_id']],
                            'status':'runtime_error','adapter_gaps':[],'error':type(exc).__name__+': '+str(exc)})+'\n')
                    streams['errors'].write(encoded({'case_id':case['case_id'],'kind':'runtime_error',
                        'error':type(exc).__name__+': '+str(exc),'traceback':traceback.format_exc()})+'\n')
                    print(encoded({'case_id':case['case_id'],'error':type(exc).__name__+': '+str(exc)}),flush=True)
                    if args.fail_fast:raise
                for stream in streams.values():stream.flush()
        finally:
            driver.clock.close()
            summary=driver.summary()
            summary['runtime_failures']=failures
            (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    return failures


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path.cwd())
    parser.add_argument('--dataset',type=Path)
    parser.add_argument('--host',choices=('web','desktop'),default='web')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--family',action='append',default=[])
    parser.add_argument('--pattern',action='append',default=[])
    parser.add_argument('--case-id',action='append',default=[])
    parser.add_argument('--split',choices=('development','validation','holdout'))
    parser.add_argument('--limit',type=int)
    parser.add_argument('--variants',nargs='+',choices=VARIANTS,default=list(VARIANTS))
    parser.add_argument('--budgets',nargs='+',type=int,default=[1800,3200])
    parser.add_argument('--repetitions',type=int,default=1)
    parser.add_argument('--save-packets',action='store_true')
    parser.add_argument('--fail-fast',action='store_true')
    args=parser.parse_args()
    if args.repetitions<1 or min(args.budgets)<1000:parser.error('repetitions>=1, budgets>=1000')
    repo=args.repo.resolve(); dataset=(args.dataset or repo/'evals/computing_learner_profile').resolve()
    families={f['family_id']:f for path in sorted((dataset/'catalog').glob('*.json')) for f in json.loads(path.read_text())}
    cases=read_rows(dataset/'data/cases.jsonl'); rubrics={r['case_id']:r for r in read_rows(dataset/'data/rubrics.jsonl')}
    split_rows=read_rows(dataset/'data/splits.jsonl');splits={r['family_id']:r['split'] for r in split_rows}
    selected=[c for c in cases if (not args.family or c['family_id'] in args.family)
              and (not args.pattern or rubrics[c['case_id']]['pattern'] in args.pattern)
              and (not args.case_id or c['case_id'] in args.case_id)
              and (not args.split or splits[c['family_id']]==args.split)]
    if args.limit is not None:selected=selected[:args.limit]
    if not selected:parser.error('No selected frozen cases')
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    oracle_checks=[]
    for catalog in sorted((dataset/'catalog').glob('*.json')):
        checker=dataset/'checks'/(catalog.stem+'_check.py')
        result=subprocess.run([sys.executable,str(checker),'--catalog',str(catalog)],capture_output=True,text=True,timeout=60)
        if result.returncode:
            raise RuntimeError('Frozen catalog checker failed: '+checker.name+' '+result.stderr[:1000])
        report=json.loads(result.stdout)
        checked=set(report['checked_oracle_ids'])
        required={probe['oracle_id'] for family in json.loads(catalog.read_text()) for probe in family['probes'] if probe['answer_validation']=='executable'}
        if not required<=checked:
            raise AssertionError('Executable probe oracle not actually checked: '+str(sorted(required-checked)))
        oracle_checks.append({'catalog':catalog.name,'checker_sha256':file_hash(checker),
            'checked_oracle_ids':sorted(checked),'required_executable_oracle_count':len(required)})
    (output/'oracle_checks.json').write_text(json.dumps(oracle_checks,ensure_ascii=False,indent=2))
    source_paths=[Path(__file__),Path(__file__).with_name('education_verifier.py')]
    source_paths+=list((repo/'packages/learning-core/src').rglob('*.py'))
    host=repo/('backend' if args.host=='web' else 'apps/desktop/backend')
    source_paths+=list((host/'app').rglob('*.py'))
    source_hashes={str(p):file_hash(p) for p in source_paths}
    manifest={'version':VERSION,'host':args.host,'arguments':vars(args),'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'source_hashes':source_hashes,'dataset_hashes':{str(p.relative_to(dataset)):file_hash(p) for p in
            [dataset/'data/cases.jsonl',dataset/'data/rubrics.jsonl',dataset/'data/splits.jsonl',*sorted((dataset/'catalog').glob('*.json'))]},
        'oracle_checks':oracle_checks,'selected_case_ids':[c['case_id'] for c in selected],'expected_trials':len(selected)*len(args.variants)*len(args.budgets)*args.repetitions,
        'assessment_adapter':'original response exact membership in independently checked two-option candidates; actual production grading; not free-answer/code-execution equivalence',
        'current_input_control':'all groups preserve same native controls selected only by actual current input event IDs',
        'repetition_boundary':'one real formation per isolated case; repeats rerun retrieval and offline planning against that fixed formed snapshot, not independent formation replicates',
        'variant_difference':'no_memory means no historical memory; no_guidance disables historical teaching_guidance only; current input retained; not directly comparable with old seven-group results',
        'clock':'all imported app/core module datetime globals frozen and refreshed; ORM audit creation defaults remain real and are not educational timing evidence',
        'isolation':'fresh per-case SQLite copied from empty schema; sockets blocked; keys cleared; background workers disabled; real worker explicitly drained',
        'teacher_review':'pending','status':'running'}
    def save(): (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2,default=str))
    save(); network=[]
    def blocked(*a,**kw):network.append('blocked');raise RuntimeError('Offline experiment forbids network')
    with tempfile.TemporaryDirectory(prefix='learnflow-joint-education-') as temporary:
        os.environ.update(DATABASE_URL=f'sqlite+aiosqlite:///{temporary}/bootstrap.db',LLM_API_KEY='',EMBEDDING_API_KEY='',VISION_API_KEY='',
                          MEMORY_AUTO_SYNTHESIS_ENABLED='false',MEMORY_WORKER_EMBEDDED='false')
        for key in list(os.environ):
            if key.endswith(('_API_KEY','_API_TOKEN')):os.environ[key]=''
        sys.path.insert(0,str(host));sys.path.insert(1,str(repo/'packages/learning-core/src'))
        try:
            with patch.object(socket.socket,'connect',blocked),patch.object(socket.socket,'connect_ex',blocked):
                failures=asyncio.run(run(args,temporary,output,selected,families,rubrics,splits))
            manifest['status']='completed' if not failures else 'completed_with_runtime_errors'
        except BaseException as exc:
            manifest.update(status='failed',error=type(exc).__name__+': '+str(exc));raise
        finally:
            manifest['changed_sources']=[p for p,h in source_hashes.items() if file_hash(p)!=h]
            manifest['blocked_network_attempts']=len(network);save()
    if failures or manifest['changed_sources'] or network:raise SystemExit(1)
    print(encoded({'output':str(output),'status':manifest['status'],'cases':len(selected)}),flush=True)


if __name__=='__main__':main()
