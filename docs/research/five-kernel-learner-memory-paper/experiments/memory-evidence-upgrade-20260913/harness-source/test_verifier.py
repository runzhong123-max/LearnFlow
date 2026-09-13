"""Adversarial calibration fixtures, excluded from the 14 native scenarios."""
from copy import deepcopy
import json
import pytest
from .verifier import verify,eligible_reviews


@pytest.fixture
def fixture():
    def event(i):return dict(id=i,learner_id=1,project_id=i,checkpoint_id=i,session_id=i,
        event_type='user_message',source='user',occurred_at='2026-09-01T11:00:00',payload={})
    spec={'id':'input','op':'read','at':'2026-09-01T11:00:00Z'}
    case={'case_id':'synthetic','purpose':'contract','steps':[spec],
          'assertions':[{'path':'/lens/schedule_count','op':'eq','value':0}]}
    r={'case_id':'synthetic','status':'executed','at':'2026-09-01T12:00:00Z','scope':dict(learner_id=1,project_id=1,checkpoint_id=1,session_id=1),
       'events':[event(1),event(2)],'attempts':[],'schedules':[],'questions':[],'states':[],
       'mutations':[dict(id=i,learner_id=1,event_id=i,kernel_name='knowledge',status='applied',patch={'short_term':{'knowledge_gap':'gap'}}) for i in (1,2)],
       'facts':[dict(node_id=1,source_event_id=1,source_mutation_id=1,fact_ordinal=0,predicate='short_term.knowledge_gap',object_value='gap',project_id=1,checkpoint_id=1,session_id=1)],
       'nodes':[dict(id=1,node_type='fact',learner_id=1,kernel_name='knowledge',project_id=1,checkpoint_id=1,session_id=1)],
       'projects':[dict(id=i,learner_id=1) for i in (1,2)],'roadmaps':[dict(id=i,project_id=i) for i in (1,2)],
       'checkpoints':[dict(id=i,roadmap_id=i) for i in (1,2)],'sessions':[dict(id=i,learner_id=1,project_id=i,checkpoint_id=i) for i in (1,2)],
       'receipts':[dict(operation_id='input',spec=spec,status='executed',new_event_ids=[1],new_event_count=1,new_attempt_ids=[],new_attempt_count=0,before={},after={}),
                   dict(operation_id='foreign',spec={'id':'foreign','op':'control','at':spec['at']},status='executed',new_event_ids=[2],new_event_count=1,new_attempt_ids=[],new_attempt_count=0,before={},after={})],
       'observation':{'plan':{},'compiled':{},'packet':{},'projection':{}},'isolation':{},
       'offline_audit':{'network_attempts':0,'file_database_attempts':0}}
    return case,r


def test_baseline_and_json_reopen(fixture):
    case,r=fixture
    assert verify(case,r)['passed']
    assert verify(case,r)==verify(case,json.loads(json.dumps(r,sort_keys=True)))


@pytest.mark.parametrize('tamper', ['empty','wrong_case','lost_step','duplicate_step','changed_step','wrong_fact','wrong_mutation','wrong_scope','wrong_owner','fake_citation','foreign_content','offline'])
def test_source_or_identity_tampering_fails(fixture,tamper):
    case,r=fixture
    if tamper=='empty':r={}
    elif tamper=='wrong_case':r['case_id']='another'
    elif tamper=='lost_step':r['receipts']=r['receipts'][1:]
    elif tamper=='duplicate_step':r['receipts'].append(deepcopy(r['receipts'][0]))
    elif tamper=='changed_step':r['receipts'][0]['spec']={**r['receipts'][0]['spec'],'id':'changed'}
    elif tamper=='wrong_fact':r['facts'][0]['object_value']='invented'
    elif tamper=='wrong_mutation':r['facts'][0]['source_mutation_id']=2
    elif tamper=='wrong_scope':r['facts'][0]['project_id']=2
    elif tamper=='wrong_owner':r['projects'][0]['learner_id']=999
    elif tamper=='fake_citation':r['observation']['compiled']['sources']=[{'source_event_id':999}]
    elif tamper=='foreign_content':r['observation']['plan']['summary']='异项目私有目标'
    elif tamper=='offline':r['offline_audit']['network_attempts']=1
    assert not verify(case,r)['passed']


@pytest.fixture
def reviewed(fixture):
    case,r=fixture;case['assertions'][0]['value']=1
    e=r['events'][0];e.update(event_type='review_attempt_evaluated',source='review',payload={
        'attempt_id':1,'item_id':1,'review_schedule_id':1,'passed':True,'independent':True,
        'assistance_level':'none','stability_eligible':True,'question_form':'original','presentation_version':'p1'})
    r['attempts']=[dict(id=1,learner_id=1,project_id=1,checkpoint_id=1,item_id=1,status='evaluated',attempt_role='review',
                       assistance_level='none',result={'passed':True},submission={'answer_indexes':[0]},evaluated_at=e['occurred_at'])]
    r['questions']=[dict(id=1,checkpoint_id=1,question='len(range(3))',options=['3','4'])]
    r['schedules']=[dict(id=1,learner_id=1,project_id=1,checkpoint_id=1,item_id=1,last_attempt_id=1,last_event_id=1)]
    rec=r['receipts'][0];rec.update(executed_operation='review',http_status=200,new_attempt_ids=[1],new_attempt_count=1,
        request={'answer_indexes':[0]},response={'attempt_id':1,'outcome':'correct','passed':True},
        calculation={'expression':'len(range(3))','computed_value':'3','public_options':['3','4'],'submitted_index':0,'requested_correct':True},
        before={'review_item':{'presentation':{'version':'p1','question_form':'original','payload':{'prompt':'len(range(3))','options':['3','4']}}}})
    r['isolation']={'http_status':404,'tutor_context':None}
    return case,r


@pytest.mark.parametrize('tamper',['none','result','event','all_grader_agree_wrong','assistance','independent','presentation','schedule','calculation','missing_calculation','answers','outsider'])
def test_review_source_contract_and_independent_computation(reviewed,tamper):
    case,r=reviewed
    assert verify(case,r)['passed'],verify(case,r)
    if tamper=='none':return
    if tamper=='result':r['attempts'][0]['result']['passed']=False
    elif tamper=='event':r['events'][0]['payload']['passed']=False
    elif tamper=='all_grader_agree_wrong':
        r['attempts'][0]['result']['passed']=False;r['events'][0]['payload']['passed']=False;r['receipts'][0]['response']['passed']=False
    elif tamper=='assistance':r['attempts'][0]['assistance_level']='hint'
    elif tamper=='independent':r['events'][0]['payload']['independent']=False
    elif tamper=='presentation':r['events'][0]['payload']['question_form']='validated_variant'
    elif tamper=='schedule':r['schedules'][0]['last_event_id']=999
    elif tamper=='calculation':r['receipts'][0]['calculation']['computed_value']='9'
    elif tamper=='missing_calculation':
        del r['receipts'][0]['calculation']
        r['receipts'][0]['spec']['op']='review';case['steps'][0]['op']='review'
    elif tamper=='answers':r['receipts'][0]['before']['review_item']['presentation']['payload']['answer_indexes']=[0]
    elif tamper=='outsider':r['isolation']['http_status']=200
    assert not verify(case,r)['passed']


@pytest.mark.parametrize('change',['none','short_span','only_original','supported','failure','missing_qualification','foreign','other_item'])
def test_stability_is_from_real_qualified_event_fields(fixture,change):
    _,r=fixture
    r['events']=[]
    r['schedules']=[{'item_type':'concept','item_id':1}]
    for i,day in enumerate((1,8),1):
        r['events'].append(dict(id=i,learner_id=1,project_id=1,checkpoint_id=1,event_type='review_attempt_evaluated',source='review',
            occurred_at=f'2026-09-{day:02}T11:00:00',payload={'source_item_type':'concept','item_id':1,'passed':True,'independent':True,'stability_eligible':True,'question_form':'validated_variant' if i==1 else 'original'}))
    assert len(eligible_reviews(r))==2
    if change=='none':return
    if change=='short_span':r['events'][1]['occurred_at']='2026-09-02T11:00:00'
    elif change=='only_original':r['events'][0]['payload']['question_form']='original'
    elif change=='supported':r['events'][0]['payload']['independent']=False
    elif change=='failure':r['events'][1]['payload']['passed']=False
    elif change=='missing_qualification':del r['events'][0]['payload']['stability_eligible']
    elif change=='foreign':r['events'][0]['project_id']=2
    elif change=='other_item':r['events'][0]['payload']['item_id']=2
    assert not eligible_reviews(r)


def test_output_growth_does_not_drift_source(tmp_path):
    from .run import source_hashes
    code=tmp_path/'backend/app/a.py';code.parent.mkdir(parents=True);code.write_text('x=1\n')
    helper=tmp_path/'evals/education_memory_counterfactual/formation.py';helper.parent.mkdir(parents=True);helper.write_text('x=1\n')
    before=source_hashes(tmp_path)
    output=tmp_path/'evals/five_kernel_interactions/runs/new/PROTOCOL.md';output.parent.mkdir(parents=True);output.write_text('output')
    assert source_hashes(tmp_path)==before
    code.write_text('x=2\n');assert source_hashes(tmp_path)!=before


def test_infrastructure_failure_separate_from_contract_score(fixture):
    from .run import aggregate
    case,r=fixture
    good=aggregate([case],[r]);assert good['execution_complete_count']==1
    r['status']='infrastructure_error'
    bad=aggregate([case],[r])
    assert bad['execution_complete_count']==0 and bad['infrastructure_error_count']==1 and bad['passed']==0


@pytest.mark.parametrize('tamper',['none','no_case','wrong_owner','wrong_source_attempt','missing_review_event','fake_event','missing_started','passed_true'])
def test_failed_review_original_role_requires_native_remediation_closure(tamper):
    from .verifier import review_role_is_bound
    e={'id':1,'learner_id':1,'project_id':1,'checkpoint_id':1,'event_type':'review_attempt_evaluated','payload':{'passed':False}}
    a={'id':1,'learner_id':1,'project_id':1,'checkpoint_id':1,'item_type':'concept','item_id':1,'attempt_role':'original','remediation_case_id':1}
    c={'id':1,'learner_id':1,'project_id':1,'checkpoint_id':1,'item_type':'concept','item_id':1,'source_attempt_id':1,'evidence_event_ids':[1,2]}
    start={'id':2,'learner_id':1,'project_id':1,'checkpoint_id':1,'event_type':'remediation_started','payload':{'case_id':1}}
    r={'events':[e,start],'remediations':[c]}
    assert review_role_is_bound(e,a,r)
    if tamper=='none':return
    if tamper=='no_case':r['remediations']=[]
    elif tamper=='wrong_owner':c['learner_id']=2
    elif tamper=='wrong_source_attempt':c['source_attempt_id']=2
    elif tamper=='missing_review_event':c['evidence_event_ids']=[2]
    elif tamper=='fake_event':c['evidence_event_ids'].append(999)
    elif tamper=='missing_started':start['event_type']='unrelated'
    elif tamper=='passed_true':e['payload']['passed']=True
    assert not review_role_is_bound(e,a,r)
