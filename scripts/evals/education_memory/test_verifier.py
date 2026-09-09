from datetime import datetime
import importlib.util
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).parent))
from verifier import judge


def test_negative_checks_do_not_reward_missing_or_wrong_output_shapes():
    for op,extra in [('none',{'fields':{'slot':'time_budget'}}),('empty',{}),('not_contains',{'value':'secret'})]:
        for actual in [None,False,1]:
            assert not judge({'x':actual},{'path':['x'],'op':op,**extra})['passed']
    assert not judge({'x':False},{'path':['x'],'op':'lte','value':10})['passed']
    assert judge({}, {'path':['mastery'],'op':'absent_or_empty'})['passed']


def test_evidence_requires_origin_scope_active_status_and_visible_content():
    gold={'path':['evidence'],'op':'evidence','source_event_id':7,'terms':['尚待验证']}
    good={'source_events':[7],'scope_valid':True,'current':True,'text':'本次独立完成情况尚待验证。'}
    assert judge({'evidence':[good]},gold)['passed']
    for change in [{'source_events':[8]},{'scope_valid':False},{'current':False},{'text':'已完成'}]:
        assert not judge({'evidence':[{**good,**change}]},gold)['passed']
    # No splicing the source from one item onto the text of another.
    assert not judge({'evidence':[{**good,'text':''},{**good,'source_events':[8]}]},gold)['passed']


def test_structured_cancellation_and_resolution_accept_equivalent_wording():
    gold={'path':['guidance'],'op':'some','fields':{'slot':'code_language','cancelled':True}}
    assert judge({'guidance':[{'slot':'code_language','cancelled':True,'instruction':'停止沿用旧默认'}]},gold)['passed']
    assert not judge({'guidance':[{'slot':'code_language','instruction':'已取消'}]},gold)['passed']


def test_same_value_from_expired_earlier_input_cannot_satisfy_new_request():
    gold={'path':['guidance'],'op':'some','fields':{'slot':'time_budget','minutes':10,'source_event_id':9}}
    assert not judge({'guidance':[{'slot':'time_budget','minutes':10,'source_event_id':2}]},gold)['passed']


def test_nested_scope_sentinel_is_detected():
    gold={'path':['context'],'op':'json_not_contains','value':'FOREIGN'}
    assert not judge({'context':{'knowledge':{'evidence':[{'text':'FOREIGN'}]}}},gold)['passed']
    assert judge({'context':{}},gold)['passed']
    assert not judge({},gold)['passed']


def test_same_attempt_grader_or_retry_event_are_valid_sources():
    gold={'path':['guidance'],'op':'some','fields':{'evidence_kind':'supported_success'},'accepted_source_events':[63,64]}
    for source in [63,64]:
        assert judge({'guidance':[{'evidence_kind':'supported_success','source_event_id':source}]},gold)['passed']
    assert not judge({'guidance':[{'evidence_kind':'supported_success','source_event_id':59}]},gold)['passed']


def test_virtual_clock_preserves_datetime_instance_contract():
    spec=importlib.util.spec_from_file_location('education_driver',Path(__file__).with_name('run.py'))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert isinstance(datetime(2026,8,1),module.Clock)
    assert isinstance(module.Clock.utcnow(),module.Clock)
    assert module.Clock.utcnow().year==2026
