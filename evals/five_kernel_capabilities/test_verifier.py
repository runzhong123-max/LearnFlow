"""Adversarial synthetic verifier calibration; never counted as native cases."""
from copy import deepcopy
import pytest
from .verifier import verify


@pytest.fixture
def fixture():
    def event(ident,pid,cp,sid):
        return dict(id=ident,learner_id=1,project_id=pid,checkpoint_id=cp,session_id=sid,
                    event_type='user_message',source='user',occurred_at='2026-09-01T11:00:00',payload={})
    events=[event(1,1,1,1),event(2,2,2,2)]
    r={'case_id':'synthetic','status':'formed','at':'2026-09-01T12:00:00Z',
       'scope':dict(learner_id=1,project_id=1,checkpoint_id=1,session_id=1),
       'events':events,'mutations':[dict(id=i,learner_id=1,event_id=i,kernel_name='knowledge',status='applied',
                                patch={'short_term':{'knowledge_gap':'gap'}}) for i in (1,2)],
       'facts':[dict(node_id=1,source_event_id=1,source_mutation_id=1,fact_ordinal=0,predicate='short_term.knowledge_gap',
                     object_value='gap',project_id=1,checkpoint_id=1,session_id=1)],
       'nodes':[dict(id=1,node_type='fact',learner_id=1,kernel_name='knowledge',project_id=1,checkpoint_id=1,session_id=1)],
       'attempts':[],'questions':[],
       'projects':[dict(id=i,learner_id=1) for i in (1,2)],'roadmaps':[dict(id=i,project_id=i) for i in (1,2)],
       'checkpoints':[dict(id=i,roadmap_id=i) for i in (1,2)],
       'sessions':[dict(id=i,learner_id=1,project_id=i,checkpoint_id=i) for i in (1,2)],
       'receipts':[{'operation_id':'input','event_ids':[1]},{'operation_id':'foreign','event_ids':[2]}],
       'observation':{'plan':{'estimated_minutes':35},'compiled':{'sources':[]},'packet':{},'projection':{}},
       'offline_audit':{'network_attempts':0,'file_database_attempts':0}}
    case={'case_id':'synthetic','kernel':'knowledge','assertions':[{'path':'/observation/plan/estimated_minutes','op':'eq','value':35}]}
    return case,r


def test_positive(fixture):
    assert verify(*fixture)['passed']


@pytest.mark.parametrize('tamper,expected',[
    ('empty','verifier_input_error'),('wrong_value','fact_value'),('wrong_mutation','fact_chain'),
    ('foreign_scope','fact_scope'),('fake_citation','consumer_source'),('foreign_citation','consumer_source'),
    ('leak','foreign_project_content_leak'),('mastery','unsupported_mastery'),
    ('offline','offline_boundary'),('lost_receipt','receipt_event_coverage'),
    ('duplicate_ordinal','fact_ordinal'),('wrong_owner','project_owner'),
])
def test_corruption_rejected(fixture,tamper,expected):
    case,r=deepcopy(fixture)
    if tamper=='empty':r={}
    elif tamper=='wrong_value':r['facts'][0]['object_value']='invented'
    elif tamper=='wrong_mutation':r['facts'][0]['source_mutation_id']=2
    elif tamper=='foreign_scope':r['facts'][0]['project_id']=2
    elif tamper=='fake_citation':r['observation']['compiled']['sources']=[{'source_event_id':999}]
    elif tamper=='foreign_citation':r['observation']['compiled']['sources']=[{'source_event_id':2}]
    elif tamper=='leak':r['observation']['plan']['summary']='异项目私有目标'
    elif tamper=='mastery':r['observation']['projection']={'knowledge':{'long_term':{'mastery':{'checkpoint:1':'stable'}}}}
    elif tamper=='offline':r['offline_audit']['network_attempts']=1
    elif tamper=='lost_receipt':r['receipts'][0]['event_ids']=[]
    elif tamper=='duplicate_ordinal':r['facts'].append(deepcopy(r['facts'][0]))
    elif tamper=='wrong_owner':r['projects'][0]['learner_id']=999
    result=verify(case,r)
    assert not result['passed']
    assert any(expected in error for error in result['chain_errors']),result


def test_wrong_or_missing_output_rejected(fixture):
    case,r=fixture
    for value in (None,36,True,'35'):
        r['observation']['plan']['estimated_minutes']=value
        assert not verify(case,r)['passed']
    r['observation']={}
    assert not verify(case,r)['passed']


@pytest.mark.parametrize('tamper',['expired','future','unformed'])
def test_native_control_time_and_provenance(fixture,tamper):
    case,r=fixture
    c=dict(kernel='human',slot='time_budget',source_event_id=1,occurred_at='2026-09-01T11:00:00',
           expires_at='2026-09-01T19:00:00',minutes=8,evidence_kind='explicit_request')
    r['mutations'][0]['patch']['short_term']['teaching_directives']=[deepcopy(c)]
    r['mutations'][0]['kernel_name']='human';r['nodes'][0]['kernel_name']='human'
    r['observation']['packet']['teaching_guidance']=[c]
    assert verify(case,r)['passed']
    if tamper=='expired':c['expires_at']='2026-09-01T10:00:00'
    if tamper=='future':c['occurred_at']='2026-09-02T11:00:00'
    if tamper=='unformed':c['minutes']=9
    assert not verify(case,r)['passed']


@pytest.mark.parametrize('tamper',['wrong_assistance','wrong_independent','wrong_result','wrong_question','wrong_time'])
def test_grade_is_bound_to_real_attempt(fixture,tamper):
    case,r=fixture
    e=r['events'][0]
    e.update(event_type='concept_attempt_evaluated',source='assessment',payload={
        'attempt_id':1,'item_id':1,'correct':True,'assistance_level':'hint','attempt_role':'original','independent':False})
    r['attempts']=[dict(id=1,learner_id=1,project_id=1,checkpoint_id=1,item_id=1,status='evaluated',
        result={'correct':True},assistance_level='hint',attempt_role='original',evaluated_at=e['occurred_at'])]
    r['questions']=[dict(id=1,checkpoint_id=1)]
    r['receipts'][0]['response']={'attempt_id':1}
    assert verify(case,r)['passed']
    if tamper=='wrong_assistance':e['payload']['assistance_level']='none'
    if tamper=='wrong_independent':e['payload']['independent']=True
    if tamper=='wrong_result':e['payload']['correct']=False
    if tamper=='wrong_question':r['questions'][0]['checkpoint_id']=2
    if tamper=='wrong_time':r['attempts'][0]['evaluated_at']='2026-09-01T10:00:00'
    assert not verify(case,r)['passed']


def test_freeze_excludes_outputs_but_detects_product_change(tmp_path):
    from .run import source_hashes
    product=tmp_path/'backend/app/native.py';product.parent.mkdir(parents=True);product.write_text('x=1\n')
    helper=tmp_path/'evals/education_memory_counterfactual/formation.py';helper.parent.mkdir(parents=True);helper.write_text('x=1\n')
    output=tmp_path/'evals/five_kernel_capabilities/runs/new/PROTOCOL.md';output.parent.mkdir(parents=True)
    before=source_hashes(tmp_path);output.write_text('new output');assert source_hashes(tmp_path)==before
    product.write_text('x=2\n');assert source_hashes(tmp_path)!=before


def test_reopen_sorted_json_does_not_change_audit_display(fixture):
    import json
    case,r=fixture
    r['observation']['learning_plan_packet']={'zeta':{'b':2,'a':1},'alpha':['capability-path']}
    case['assertions'].append({'path':'/lens/learning_plan_packet_text','op':'contains','value':'capability-path'})
    before=verify(case,r)
    after=verify(case,json.loads(json.dumps(r,sort_keys=True)))
    assert before['passed'] and before==after
