"""Independent field/source invariants. No product scorer or reducer imports."""
from datetime import datetime,timezone,timedelta
import json
import re

MISSING=object()


def time(value):
    d=datetime.fromisoformat(value.replace('Z','+00:00'))
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def pointer(obj,path):
    try:
        for k in path.strip('/').split('/'):
            obj=obj[int(k)] if isinstance(obj,list) else obj[k]
        return obj
    except (KeyError,IndexError,ValueError,TypeError):return MISSING


def eligible_reviews(result):
    scope=result['scope'];events=[]
    schedules=result.get('schedules') or []
    if len(schedules)!=1:return []
    schedule=schedules[0]
    for e in result.get('events',[]):
        p=e.get('payload') or {}
        if e.get('event_type')=='review_attempt_evaluated' and e.get('source')=='review' and all(e.get(k)==scope[k] for k in ('learner_id','project_id','checkpoint_id')) and p.get('source_item_type')==schedule.get('item_type') and p.get('item_id')==schedule.get('item_id'):
            events.append(e)
    events.sort(key=lambda e:(time(e['occurred_at']),e['id']))
    tail=[]
    for e in events:
        p=e['payload']
        if p.get('passed') is not True:tail=[]
        elif p.get('independent') is True and p.get('stability_eligible') is True:tail.append(e)
    if len(tail)<2 or time(tail[-1]['occurred_at'])-time(tail[0]['occurred_at'])<timedelta(hours=72):return []
    if not any(e['payload'].get('question_form')=='validated_variant' for e in tail):return []
    return tail


def lens(result):
    obs=result.get('observation') or {};proj=obs.get('projection') or {}
    structure=(proj.get('structure') or {}).get('long_term') or {};value=(proj.get('value') or {}).get('long_term') or {}
    knowledge=proj.get('knowledge') or {};practice=proj.get('practice') or {}
    path=(structure.get('learning_path_plans') or {}).get('interaction-path') or {}
    goal=(value.get('confirmed_goals') or {}).get('path-plan:interaction-path') or {}
    schedules=result.get('schedules') or [];schedule=schedules[0] if schedules else {}
    item=obs.get('review_item') or {};events=[e for e in result.get('events',[]) if e.get('event_type')=='review_attempt_evaluated']
    eligible=eligible_reviews(result);key='review:concept:'+str(schedule.get('item_id'))
    mastery=((knowledge.get('long_term') or {}).get('mastery') or {}).get(key) or {}
    proof=((practice.get('long_term') or {}).get('proof_chain') or {}).get(key) or {}
    retention=((knowledge.get('short_term') or {}).get('retention_status') or {}).get('concept:'+str(schedule.get('item_id'))) or {}
    defer=next((r for r in result.get('receipts',[]) if r['spec']['op']=='defer'),None)
    return {'path_revision':path.get('revision'),'path_status':path.get('status'),'goal_status':goal.get('status'),
        'goal_statement':goal.get('statement'),'path_events':[e['event_type'] for e in result.get('events',[]) if e['event_type'].startswith('vnext_learning_path_plan_')],
        'schedule_count':len(schedules),'attempt_count':len(result.get('attempts',[])),'review_count':len(events),
        'last_grade':schedule.get('last_grade'),'bucket':item.get('bucket'),'defer_count':schedule.get('defer_count'),
        'current_evidence':item.get('evidence_state'),'retention':retention.get('status'),
        'review_forms':[e['payload'].get('question_form') for e in events],
        'review_independent':[e['payload'].get('independent') for e in events],
        'stable_eligible':bool(eligible),'long_stable':mastery.get('level')=='stable',
        'stable_source_coverage':bool(eligible) and set(mastery.get('evidence_ids') or [])=={e['id'] for e in eligible} and set(proof.get('evidence_ids') or [])=={e['id'] for e in eligible},
        'last_attempt_status':(result.get('attempts') or [{}])[-1].get('status'),
        'plan_actions':[d.get('action') for d in (obs.get('plan') or {}).get('teaching_decisions') or []],
        'defer_moves_one_day':bool(defer) and time(defer['response']['item']['due_at'])-time(defer['spec']['at'])==timedelta(days=1)}


def hidden_answers(obj):
    if isinstance(obj,dict):
        return bool({'answer_indexes','expected','solution','test_cases','private'} & set(obj)) or any(hidden_answers(x) for x in obj.values())
    if isinstance(obj,list):return any(hidden_answers(x) for x in obj)
    return False


def chain_errors(result):
    errors=[]
    def require(v,reason):
        if not v:errors.append(reason)
    owner=result['scope']['learner_id'];events={e['id']:e for e in result.get('events',[])}
    attempts={a['id']:a for a in result.get('attempts',[])};mutations={m['id']:m for m in result.get('mutations',[])}
    nodes={n['id']:n for n in result.get('nodes',[])};schedules={s['id']:s for s in result.get('schedules',[])}
    projects={p['id']:p for p in result.get('projects',[])};roads={p['id']:p for p in result.get('roadmaps',[])}
    cps={p['id']:p for p in result.get('checkpoints',[])};sessions={p['id']:p for p in result.get('sessions',[])}
    questions={p['id']:p for p in result.get('questions',[])}
    require(bool(events) and bool(mutations),'empty_native_chain')
    emitted_e=[];emitted_a=[]
    for r in result.get('receipts',[]):
        eids=r.get('new_event_ids') or [];aids=r.get('new_attempt_ids') or []
        emitted_e+=eids;emitted_a+=aids
        require(r['new_event_count']==len(eids) and r['new_attempt_count']==len(aids),'receipt_counts:'+r['operation_id'])
        require(r['status'] in {'executed','expected_rejection'},'operation_failed:'+r['operation_id'])
        require(all(i in events and time(events[i]['occurred_at'])==time(r['spec']['at']) for i in eids),'receipt_time:'+r['operation_id'])
        require(all(i in attempts for i in aids),'receipt_attempt:'+r['operation_id'])
        if r['spec']['op']=='replay':
            original=next(x for x in result['receipts'] if x['operation_id']==r['spec']['request_from'])
            require(not eids and not aids,'replay_created_evidence:'+r['operation_id'])
            if original.get('response',{}).get('attempt_id'):
                require(original['response']['attempt_id']==r.get('response',{}).get('attempt_id'),'replay_changed_attempt')
        needs_calculation=r['spec']['op'] in {'grade','review'} and r.get('http_status')==200 and r['spec'].get('response_status','answered')=='answered' and not r['spec'].get('empty')
        if needs_calculation:require(bool(r.get('calculation')),'missing_calculation_receipt')
        if r.get('calculation'):
            calc=r['calculation'];match=re.fullmatch(r'len\(range\((\d+)\)\)',calc.get('expression',''))
            n=int(match[1]) if match else -1;options=calc.get('public_options') or []
            require(0<=n<=100 and calc.get('computed_value')==str(n),'public_computation')
            index=calc.get('submitted_index');request=r.get('request') or {}
            require(type(index) is int and 0<=index<len(options) and request.get('answer_indexes')==[index],'calculation_submission')
            if type(index) is int and 0<=index<len(options):
                require((options[index]==str(n)) is calc.get('requested_correct'),'calculation_outcome')
                truth=options[index]==str(n)
                scored=[events[i] for i in eids if i in events and events[i]['event_type'] in {'concept_attempt_evaluated','review_attempt_evaluated'}]
                require(len(scored)==1,'computed_grade_event_count')
                for e in scored:
                    p=e.get('payload') or {};review=e['event_type']=='review_attempt_evaluated'
                    a=attempts.get(p.get('attempt_id'),{})
                    require(p.get('passed' if review else 'correct') is truth,'independent_grader_oracle')
                    require((a.get('result') or {}).get('passed' if review else 'correct') is truth,'independent_attempt_oracle')
                    require(r.get('response',{}).get('passed' if review else 'correct') is truth,'independent_response_oracle')
            if r.get('executed_operation')=='grade':
                q=next(iter(questions.values()),{})
                require(calc.get('expression') in q.get('question','') and options==q.get('options'),'initial_public_binding')
            else:
                pub=r.get('before',{}).get('review_item',{}).get('presentation',{}).get('payload',{})
                require(calc.get('expression') in pub.get('prompt','') and options==pub.get('options'),'review_public_binding')
        if r.get('executed_operation')=='review' and r.get('http_status')==200 and r.get('response',{}).get('outcome')!='skipped':
            a=attempts.get(r['response'].get('attempt_id'),{})
            require(bool(a) and a.get('submission',{}).get('answer_indexes',[])==r.get('request',{}).get('answer_indexes',[]),'review_submission_bound:'+r['operation_id'])
        for location in ('before','after'):
            shot=r.get(location) or {}
            if shot.get('review_item'):
                require(not hidden_answers(shot['review_item'].get('presentation',{})),'public_presentation_answer_leak')
            if shot.get('review_tutor'):
                require(not hidden_answers(shot['review_tutor']),'tutor_answer_leak')
    require(len(emitted_e)==len(set(emitted_e)) and set(emitted_e)==set(events),'event_receipt_coverage')
    require(len(emitted_a)==len(set(emitted_a)) and set(emitted_a)==set(attempts),'attempt_receipt_coverage')
    for e in events.values():
        require(e.get('learner_id')==owner,'event_owner')
        pid=e.get('project_id');cid=e.get('checkpoint_id');sid=e.get('session_id')
        if pid is not None:require(projects.get(pid,{}).get('learner_id')==owner,'project_owner')
        if cid is not None:require(roads.get(cps.get(cid,{}).get('roadmap_id'),{}).get('project_id')==pid,'checkpoint_owner')
        if sid is not None:require(all(sessions.get(sid,{}).get(k)==e.get(k) for k in ('learner_id','project_id','checkpoint_id')),'session_owner')
        if e['event_type'] in {'concept_attempt_evaluated','review_attempt_evaluated'}:
            p=e.get('payload') or {};a=attempts.get(p.get('attempt_id'),{});review=e['event_type']=='review_attempt_evaluated'
            require(bool(a) and all(a.get(k)==e.get(k) for k in ('learner_id','project_id','checkpoint_id')),'attempt_owner')
            require(a.get('status') in {'evaluated','abstained'},'attempt_status')
            require(e.get('source')==('review' if review else 'assessment'),'grade_source')
            require(a.get('item_id')==p.get('item_id') and questions.get(a.get('item_id'),{}).get('checkpoint_id')==cid,'item_owner')
            require(a.get('assistance_level')==p.get('assistance_level'),'assistance_bound')
            require(type(p.get('independent')) is bool and p['independent']==(a.get('assistance_level')=='none' and a.get('attempt_role')!='retry'),'independence_bound')
            require(time(a['evaluated_at'])==time(e['occurred_at']),'grade_time')
            actual=a.get('result') or {};passed=actual.get('passed') if review else actual.get('correct')
            require(type(passed) is bool and passed==p.get('passed' if review else 'correct'),'grade_result')
            if review:
                require(a.get('attempt_role')=='review' and type(p.get('stability_eligible')) is bool,'review_evidence_fields')
                require(p.get('review_schedule_id') in schedules,'review_schedule_ref')
                receipt=next((r for r in result['receipts'] if e['id'] in r.get('new_event_ids',[])),{})
                before=receipt.get('before',{}).get('review_item',{}).get('presentation',{})
                require(p.get('question_form')==before.get('question_form') and p.get('presentation_version')==before.get('version'),'presentation_bound')
    for s in schedules.values():
        a=attempts.get(s.get('last_attempt_id'),{});e=events.get(s.get('last_event_id'),{})
        require(s['learner_id']==owner and bool(a) and bool(e),'schedule_source')
        require(all(s.get(k)==a.get(k)==e.get(k) for k in ('learner_id','project_id','checkpoint_id')),'schedule_scope')
        require(e.get('payload',{}).get('attempt_id')==a.get('id'),'schedule_last_event')
    for m in mutations.values():
        e=events.get(m.get('event_id'),{})
        require(bool(e) and m.get('learner_id')==owner and m.get('status')=='applied','mutation_chain')
    ordinals=set()
    for f in result.get('facts',[]):
        n=nodes.get(f['node_id'],{});m=mutations.get(f.get('source_mutation_id'),{});e=events.get(f.get('source_event_id'),{})
        require(bool(n) and bool(m) and bool(e) and m.get('event_id')==e.get('id'),'fact_chain')
        require(n.get('node_type')=='fact' and n.get('learner_id')==owner and n.get('kernel_name')==m.get('kernel_name'),'fact_node')
        require(all(f.get(k)==e.get(k)==n.get(k) for k in ('project_id','checkpoint_id','session_id')),'fact_scope')
        pred=f.get('predicate','').split('.',1)
        require(len(pred)==2 and (m.get('patch') or {}).get(pred[0],{}).get(pred[1],MISSING)==f.get('object_value'),'fact_value')
        marker=(f.get('source_mutation_id'),f.get('fact_ordinal'))
        require(type(marker[1]) is int and marker[1]>=0 and marker not in ordinals,'fact_ordinal');ordinals.add(marker)
    isolation=result.get('isolation') or {}
    if schedules:require(isolation.get('http_status')==404 and not isolation.get('tutor_context'),'outsider_review_access')
    foreign={i for r in result.get('receipts',[]) if r['operation_id']=='foreign' for i in r.get('new_event_ids',[])}
    require(bool(foreign),'missing_current_scope_distractor')
    obs=result.get('observation') or {}
    for key in ('packet','planner_context','compiled','plan'):
        require('异项目私有目标' not in json.dumps(obs.get(key),ensure_ascii=False,sort_keys=True),'foreign_project_content:'+key)
    for s in (obs.get('compiled') or {}).get('sources',[]):
        require(s.get('source_event_id') in events and s.get('source_event_id') not in foreign,'consumer_source')
    require(not foreign & set((obs.get('packet') or {}).get('manifest',{}).get('evidence_ids') or []),'packet_scope')
    for c in (obs.get('packet') or {}).get('teaching_guidance') or []:
        e=events.get(c.get('source_event_id'),{})
        require(bool(e) and time(c['occurred_at'])==time(e['occurred_at'])<=time(result['at']),'control_time')
        require(c.get('lifetime')=='persistent' or time(c['expires_at'])>time(result['at']),'expired_control_delivered')
        candidates=[]
        def walk(x):
            if isinstance(x,dict):
                if x.get('source_event_id')==c.get('source_event_id') and x.get('slot')==c.get('slot'):candidates.append(x)
                for v in x.values():walk(v)
            elif isinstance(x,list):
                for v in x:walk(v)
        for m in mutations.values():
            if m.get('event_id')==c.get('source_event_id') and m.get('kernel_name')==c.get('kernel'):walk(m.get('patch'))
        fields=('kernel','slot','source_event_id','occurred_at','expires_at','minutes','evidence_kind','requested_priority','requested_anchor')
        require(any(all(x.get(k)==c.get(k) for k in fields) for x in candidates),'control_native_value')
    require(result.get('offline_audit')=={'network_attempts':0,'file_database_attempts':0},'offline_boundary')
    return sorted(set(errors))


def verify(case,result):
    checks=[]
    try:
        errors=chain_errors(result)
        if result.get('case_id')!=case['case_id']:errors.append('case_identity')
        requested={s['id']:s for s in case['steps']};receipts=result.get('receipts') or []
        actual={r['operation_id']:r for r in receipts}
        if len(actual)!=len(receipts) or set(actual)!=set(requested)|{'foreign'}:errors.append('declared_operation_coverage')
        for key,spec in requested.items():
            if actual.get(key,{}).get('spec')!=spec:errors.append('declared_operation_mismatch:'+key)
        if result.get('status')!='executed':errors.append('incomplete_execution')
        observed=lens(result);data={**result,'lens':observed,'steps':{r['operation_id']:r for r in result['receipts']}}
        for c in case['assertions']:
            value=pointer(data,c['path']);op=c['op'];expected=c.get('value')
            if op=='eq':ok=value is not MISSING and type(value) is type(expected) and value==expected
            elif op=='contains':ok=value is not MISSING and expected in value
            elif op=='absent':ok=value is MISSING
            else:raise ValueError('unknown_op')
            checks.append({**c,'actual':'<missing>' if value is MISSING else value,'passed':ok})
    except Exception as exc:errors=['verifier_input_error:'+repr(exc)];observed={}
    return {'case_id':case['case_id'],'purpose':case['purpose'],'passed':not errors and bool(checks) and all(x['passed'] for x in checks),
        'chain_errors':errors,'checks':checks,'observed':observed,
        'counts':{k:len(result.get(k,[])) for k in ('events','attempts','schedules','mutations','facts','nodes')},
        'known_null_session_grade_count':sum(e.get('session_id') is None and e.get('event_type') in {'concept_attempt_evaluated','review_attempt_evaluated'} for e in result.get('events',[]))}
