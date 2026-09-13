"""Independent structural contract verifier. No product decision/reducer imports."""
from __future__ import annotations
from collections import Counter
from datetime import datetime,timezone
import json

MISSING=object()


def pointer(root,path):
    try:
        for part in path.strip('/').split('/'):
            root=root[int(part)] if isinstance(root,list) else root[part.replace('~1','/').replace('~0','~')]
        return root
    except (KeyError,IndexError,ValueError,TypeError):return MISSING


def moment(text):
    dt=datetime.fromisoformat(text.replace('Z','+00:00'))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def lens(result):
    obs=result.get('observation') or {};projection=obs.get('projection') or {}
    knowledge=projection.get('knowledge') or {};structure=projection.get('structure') or {};value=projection.get('value') or {}
    plans=(structure.get('long_term') or {}).get('learning_path_plans') or {}
    path=plans.get('capability-path') or {}
    goal=((value.get('long_term') or {}).get('confirmed_goals') or {}).get('path-plan:capability-path') or {}
    grade=[e for e in result.get('events',[]) if e['event_type']=='concept_attempt_evaluated']
    gids={e['id'] for e in grade}
    states=(knowledge.get('short_term') or {}).get('concept_understanding') or {}
    gapfacts=[f['object_value'] for f in result.get('facts',[]) if f['predicate']=='short_term.knowledge_gap']
    return {'actions':[d.get('action') for d in (obs.get('compiled') or {}).get('decisions',[])],
        'plan_actions':[d.get('action') for d in (obs.get('plan') or {}).get('teaching_decisions',[])],
        'knowledge_gap_fact':gapfacts[-1] if gapfacts else None,
        'concept_statuses':[v.get('status') for k,v in sorted(states.items())],
        'grade_correct':[e['payload'].get('correct') for e in grade],
        'grade_independent':[e['payload'].get('independent') for e in grade],
        'grade_assistance':[e['payload'].get('assistance_level') for e in grade],
        'attempt_roles':[a.get('attempt_role') for a in result.get('attempts',[])],
        'grade_human_value_mutations':sum(m['event_id'] in gids and m['kernel_name'] in {'human','value'} for m in result.get('mutations',[])),
        'path_status':path.get('status'),'path_revision':path.get('revision'),'route':path.get('route_node_ids'),
        'goal_status':goal.get('status'),
        'path_event_types':[e['event_type'] for e in result.get('events',[]) if e['event_type'].startswith('vnext_learning_path_plan_')],
        'intermediate_goal_statuses':[
            (((r.get('projection_after') or {}).get('value') or {}).get('long_term') or {}).get('confirmed_goals',{}).get('path-plan:capability-path',{}).get('status')
            for r in result.get('receipts',[]) if r.get('operation',{}).get('op','').startswith('path_')],
        'learning_plan_packet_text':json.dumps(obs.get('learning_plan_packet') or {},ensure_ascii=False,sort_keys=True)}


def chain_errors(result):
    """Cross-check real rows, ownership, evaluated Attempts and consumed sources."""
    errors=[]
    def require(condition,code):
        if not condition:errors.append(code)
    scope=result.get('scope') or {};learner=scope.get('learner_id')
    events={e['id']:e for e in result.get('events',[])};mutations={m['id']:m for m in result.get('mutations',[])}
    nodes={n['id']:n for n in result.get('nodes',[])};attempts={a['id']:a for a in result.get('attempts',[])}
    projects={p['id']:p for p in result.get('projects',[])};roads={r['id']:r for r in result.get('roadmaps',[])}
    cps={c['id']:c for c in result.get('checkpoints',[])};sessions={s['id']:s for s in result.get('sessions',[])}
    questions={q['id']:q for q in result.get('questions',[])}
    require(bool(events) and bool(mutations),'empty_native_chain')
    require(len(events)==len(result.get('events',[])),'duplicate_event_id')
    actualids={i for r in result.get('receipts',[]) for i in r.get('event_ids',[])}
    require(actualids==set(events),'receipt_event_coverage')
    for e in events.values():
        ident=e['id'];require(e.get('learner_id')==learner,f'event_owner:{ident}')
        p=e.get('project_id');cp=e.get('checkpoint_id');s=e.get('session_id')
        if p is not None:require(projects.get(p,{}).get('learner_id')==learner,f'project_owner:{ident}')
        if cp is not None:require(roads.get(cps.get(cp,{}).get('roadmap_id'),{}).get('project_id')==p,f'checkpoint_owner:{ident}')
        if s is not None:require(all(sessions.get(s,{}).get(k)==e.get(k) for k in ('learner_id','project_id','checkpoint_id')),f'session_owner:{ident}')
        if e.get('event_type')=='concept_attempt_evaluated':
            payload=e.get('payload') or {};a=attempts.get(payload.get('attempt_id'),{});q=questions.get(payload.get('item_id'),{})
            require(e.get('source')=='assessment' and a.get('status')=='evaluated',f'formal_grade:{ident}')
            require(all(a.get(k)==e.get(k) for k in ('learner_id','project_id','checkpoint_id')),f'attempt_owner:{ident}')
            require(a.get('item_id')==payload.get('item_id') and q.get('checkpoint_id')==cp,f'question_owner:{ident}')
            require((a.get('result') or {}).get('correct') is payload.get('correct'),f'grade_result:{ident}')
            require(a.get('assistance_level')==payload.get('assistance_level'),f'grade_assistance:{ident}')
            require(a.get('attempt_role')==payload.get('attempt_role'),f'grade_role:{ident}')
            require(payload.get('independent') is (a.get('assistance_level')=='none' and a.get('attempt_role')=='original'),f'grade_independence:{ident}')
            require(moment(a['evaluated_at'])==moment(e['occurred_at']),f'grade_time:{ident}')
            require(any(r.get('response',{}).get('attempt_id')==a.get('id') and ident in r.get('event_ids',[]) for r in result.get('receipts',[])),f'grade_receipt:{ident}')
    for m in mutations.values():
        e=events.get(m.get('event_id'),{})
        require(bool(e) and m.get('learner_id')==e.get('learner_id') and m.get('status')=='applied',f'mutation_chain:{m["id"]}')
    ordinals=set()
    for f in result.get('facts',[]):
        ident=f['node_id'];n=nodes.get(ident,{});m=mutations.get(f.get('source_mutation_id'),{});e=events.get(f.get('source_event_id'),{})
        require(bool(n) and bool(m) and bool(e) and m.get('event_id')==e.get('id'),f'fact_chain:{ident}')
        require(n.get('node_type')=='fact' and n.get('learner_id')==learner and n.get('kernel_name')==m.get('kernel_name'),f'fact_node:{ident}')
        require(all(f.get(k)==e.get(k)==n.get(k) for k in ('project_id','checkpoint_id','session_id')),f'fact_scope:{ident}')
        pred=f.get('predicate','').split('.',1)
        require(len(pred)==2 and pred[0] in {'short_term','long_term'} and
                (m.get('patch') or {}).get(pred[0],{}).get(pred[1],MISSING)==f.get('object_value'),f'fact_value:{ident}')
        marker=(f.get('source_mutation_id'),f.get('fact_ordinal'))
        require(type(marker[1]) is int and marker[1]>=0 and marker not in ordinals,f'fact_ordinal:{ident}');ordinals.add(marker)
    obs=result.get('observation') or {};at=moment(result['at'])
    foreign={i for r in result.get('receipts',[]) if r.get('operation_id')=='foreign' for i in r.get('event_ids',[])}
    require(bool(foreign),'missing_scope_distractor')
    # Check current scoped controls against native mutation entries, not product diagnostics.
    controls=(obs.get('packet') or {}).get('teaching_guidance') or []
    for c in controls:
        e=events.get(c.get('source_event_id'),{});ident=c.get('source_event_id')
        require(bool(e) and ident not in foreign,f'control_source:{ident}')
        require(all(e.get(k) is None or e.get(k)==scope.get(k) for k in ('project_id','checkpoint_id','session_id')),f'control_scope:{ident}')
        require(moment(c['occurred_at'])==moment(e['occurred_at'])<=at,f'control_time:{ident}')
        require(c.get('lifetime')=='persistent' or moment(c['expires_at'])>at,f'control_expired:{ident}')
        candidates=[]
        def walk(x):
            if isinstance(x,dict):
                if x.get('source_event_id')==ident and x.get('slot')==c.get('slot'):candidates.append(x)
                for v in x.values():walk(v)
            elif isinstance(x,list):
                for v in x:walk(v)
        for m in mutations.values():
            if m.get('event_id')==ident and m.get('kernel_name')==c.get('kernel'):walk(m.get('patch'))
        fields=('slot','kernel','source_event_id','occurred_at','expires_at','minutes','evidence_kind','requested_priority','requested_anchor')
        require(any(all(x.get(k)==c.get(k) for k in fields) for x in candidates),f'control_native_value:{ident}')
    for s in (obs.get('compiled') or {}).get('sources',[]):
        ident=s.get('source_event_id');require(ident in events and ident not in foreign,f'consumer_source:{ident}')
    # The global learning_plan packet may intentionally contain learner-global records.
    targettext=json.dumps({'context':obs.get('planner_context'),'compiled':obs.get('compiled'),'plan':obs.get('plan')},ensure_ascii=False)
    require('异项目私有目标' not in targettext,'foreign_project_content_leak')
    for kernel in ('knowledge','practice'):
        long=((obs.get('projection') or {}).get(kernel) or {}).get('long_term') or {}
        require(not long.get('mastery') and not long.get('stable_mastery') and not long.get('transfer_mastery'),f'unsupported_mastery:{kernel}')
        for state in result.get('states',[]):
            if state.get('kernel_name')==kernel:
                native_long=state.get('long_term') or {}
                require(not native_long.get('mastery') and not native_long.get('proof_chain'),f'unsupported_native_mastery:{kernel}')
    require(result.get('offline_audit')=={'network_attempts':0,'file_database_attempts':0},'offline_boundary')
    return errors


def verify(case,result):
    checks=[]
    try:
        errors=chain_errors(result)
        if result.get('status')!='formed':errors.append('formation_not_complete')
        data={**result,'lens':lens(result)}
        for spec in case['assertions']:
            value=pointer(data,spec['path']);op=spec['op'];expected=spec.get('value')
            if op=='eq':passed=value is not MISSING and type(value) is type(expected) and value==expected
            elif op=='absent':passed=value is MISSING
            elif op=='contains':passed=value is not MISSING and expected in value
            elif op=='not_contains':passed=value is not MISSING and expected not in value
            else:raise ValueError('unknown_assertion:'+op)
            checks.append({**spec,'actual':'<missing>' if value is MISSING else value,'passed':passed})
    except Exception as exc:
        errors=['verifier_input_error:'+repr(exc)]
    return {'case_id':case['case_id'],'kernel':case['kernel'],'passed':not errors and bool(checks) and all(c['passed'] for c in checks),
            'chain_errors':errors,'checks':checks,'counts':{k:len(result.get(k,[])) for k in ('events','attempts','mutations','facts','nodes')},
            'formation_gaps':result.get('formation_gaps',[])}
