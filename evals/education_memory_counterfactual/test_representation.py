"""Mechanistic controls, not synthetic performance claims."""
from copy import deepcopy
import json
from .representation import normalize, pack, render, VARIANTS, annotated


def fixture():
    scope={'learner_id':1,'project_id':1,'checkpoint_id':1,'session_id':1}
    event={**scope,'id':1,'event_type':'concept_attempt_evaluated','occurred_at':'2026-09-01T10:00:00Z','source':'assessment','client_event_id':'1:attempt:1:evaluated','payload':{'attempt_id':1,'item_id':1,'assistance_level':'guided','correct':True}}
    return {'case_id':'unit','at':'2026-09-01T12:00:00Z','scope':scope,'request':'根据学习证据决定下一步。',
      'events':[event], 'attempts':[{**scope,'id':1,'result':{'correct':True},'assistance_level':'guided','item_type':'concept','item_id':1,'status':'evaluated','submitted_at':'2026-09-01T10:00:00Z','evaluated_at':'2026-09-01T10:00:00Z'}],
      'mutations':[{'id':1,'event_id':1,'learner_id':1,'status':'applied','kernel_name':'practice','patch':{}}],
      'questions':[{'id':1,'checkpoint_id':1}], 'facts':[], 'projects':[{'id':1,'learner_id':1}], 'roadmaps':[{'id':1,'project_id':1}],
      'checkpoints':[{'id':1,'roadmap_id':1}], 'sessions':[{'id':1,**scope}]}


def test_equal_information_and_no_author_answers():
    f=fixture();f['oracle_sidecar']={'answer':'SHOULD_NOT_BE_IN_PROMPT'}
    records=normalize(f)['records'];assert len(records)==1
    packets={v:json.loads(render(records,f,v)[1]['content'])['evidence'] for v in VARIANTS}
    def flatten(e):
        return sorted((r for group in e.values() for r in group),key=lambda r:r['id']) if isinstance(e,dict) else sorted(e,key=lambda r:r['id'])
    assert flatten(packets['five_kernel_gated'])==flatten(packets['flat_gated'])
    assert flatten(packets['five_kernel_source'])==flatten(packets['flat_source'])
    for v in VARIANTS:
        clean=[{k:val for k,val in r.items() if k!='eligibility'} for r in flatten(packets[v])]
        assert clean==records
        assert 'SHOULD_NOT_BE_IN_PROMPT' not in str(render(records,f,v))


def test_scope_future_and_link_tamper_rejected():
    f=fixture();bad=deepcopy(f['events'][0]);bad.update(id=2,learner_id=99)
    future=deepcopy(f['events'][0]);future.update(id=3,occurred_at='2026-09-02T00:00:00Z')
    f['events'] += [bad,future]
    n=normalize(f);assert [r['source_event_id'] for r in n['records']]==[1]
    assert {a.get('reason') for a in n['audit']} >= {'scope_mismatch','future_or_undated'}
    f['attempts'][0]['learner_id']=2
    assert normalize(f)['records']==[]


def test_common_budget_selection_and_read_only():
    f=fixture();before=deepcopy(f);packed=pack(f,2200)
    assert f==before
    jobs=packed['jobs'];assert len({j['canonical_selected_sha256'] for j in jobs})==1
    assert all(j['input_budget_units']<=2200 for j in jobs)
    assert all(j['all_records_delivered'] for j in jobs)


def test_expired_and_supported_annotations_dont_replace_evidence():
    record=normalize(fixture())['records'][0]
    assert annotated(record,'2026-09-01T12:00:00Z')['eligibility']['completion_condition']=='supported'
    record['expires_at']='2026-09-01T11:00:00Z'
    assert annotated(record,'2026-09-01T12:00:00Z')['eligibility']['time_applicability']=='expired'


def test_ungraded_mismatched_and_future_attempts_never_become_evidence():
    for field,value in (('status','started'),('item_id',9),('evaluated_at','2026-09-02T10:00:00Z'),('assistance_level','none')):
        f=fixture();f['attempts'][0][field]=value
        assert normalize(f)['records']==[]
    f=fixture();f['attempts'][0]['result']={}
    assert normalize(f)['records']==[]
    f=fixture();f['events'][0]['source']='user'
    assert normalize(f)['records']==[]


def test_one_event_bundle_is_never_partially_delivered():
    f=fixture()
    f['mutations'][0]['patch']={'short_term':{'teaching_directives':[
      {'source_event_id':1,'kernel':'human','slot':'time_budget','source_span':[0,2],
       'minutes':8,'occurred_at':'2026-09-01T10:00:00Z','expires_at':'2026-09-01T18:00:00Z','status':'active'}]}}
    all_ids={r['id'] for r in normalize(f)['records']}
    assert len(all_ids)==2
    for budget in (900,1200,2200):
        ids=set(pack(f,budget)['jobs'][0]['selected_record_ids'])
        assert ids in (set(),all_ids)
