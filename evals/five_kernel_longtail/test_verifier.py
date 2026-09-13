"""Handwritten verifier fixtures only; never persisted as product memory."""
from copy import deepcopy
import json
import unittest
try:
    from .generate import scenarios,variants,HISTORIES,BUDGETS
    from .verifier import digest,estimate,verify,has_evidence_body,audit_formation,verify_paths,indexes
    from .run import expected_jobs
except ImportError:
    from generate import scenarios,variants,HISTORIES,BUDGETS
    from verifier import digest,estimate,verify,has_evidence_body,audit_formation,verify_paths,indexes
    from run import expected_jobs


def fixture():
    scope={'learner_id':1,'project_id':2,'checkpoint_id':3,'session_id':4}
    text='我不懂协程。观察完整。仅单线程通过，并发未验证。'
    q={'id':'dev','query':'协程','target_operation':'target','required_terms':['观察完整'],'qualifier':'仅单线程通过，并发未验证'}
    event={'id':7,**scope,'event_type':'user_message','source':'user','payload':{'text':text},'occurred_at':'2026-09-01T09:00:00'}
    mutation={'id':8,'learner_id':1,'event_id':7,'kernel_name':'knowledge','status':'applied','before_version':1,'after_version':2,'patch':{'short_term':{'pending_question':text,'knowledge_gap':text},'long_term':{}}}
    nodes=[];facts=[]
    for ordinal,key in enumerate(('pending_question','knowledge_gap')):
        nodes.append({'id':10+ordinal,**scope,'node_type':'fact','kernel_name':'knowledge','status':'active','text':key+': '+text,'payload':{'scope':'short_term','key':key,'event_type':'user_message'},'occurred_at':event['occurred_at']})
        facts.append({'node_id':10+ordinal,**{k:scope[k] for k in ('project_id','checkpoint_id','session_id')},'source_event_id':7,'source_mutation_id':8,'predicate':'short_term.'+key,'fact_ordinal':ordinal,'object_value':text,'consumption_status':'eligible','evidence_grade':'self_reported'})
    snapshot={'nodes':nodes,'facts':facts,'events':[event],'mutations':[mutation],'states':[{'id':9,'learner_id':1,'kernel_name':'knowledge','version':2,'evidence_refs':[],'action_chain':[]}],'projects':[{'id':2,'learner_id':1}],'roadmaps':[{'id':5,'project_id':2}],'checkpoints':[{'id':3,'roadmap_id':5,'archived':False}],'sessions':[{'id':4,**scope}]}
    item={'id':10,'text':text,'scope':{k:scope[k] for k in ('project_id','checkpoint_id','session_id')},'evidence_refs':[7],'detail':{'source_event_id':7,'source_text':{'source_kind':'fact_object_value','source_path':'/object_value','source_event_id':7,'source_mutation_id':8,'sha256':digest(text),'chars':len(text),'ranges':[[0,len(text)]]}}}
    packet={'items':[item],'kernel_heads':{'knowledge':{'focus_refs':[10]}},'omitted':{'candidate_count':2},'manifest':{'policy':{}}};packet['manifest']['token_estimate']=estimate(packet)
    return q,snapshot,packet,scope


def trace(calls):return [{'ids':ids,'caller_function':'build_five_kernel_context','caller_line':1042} for ids in calls]

def check(q,s,p,scope,calls=None,budget=1800):return verify(q,s,p,scope,7,trace([[10,11]] if calls is None else calls),budget,[])


class Tests(unittest.TestCase):
    def test_frozen_matrix(self):
        rows=scenarios();self.assertEqual(len(rows),12);self.assertEqual(sum(len(r['queries']) for r in rows),13);self.assertEqual(len(expected_jobs(rows)),228)
    def test_valid_source_and_retired_receipt(self):
        result=check(*fixture());self.assertTrue(result['checks_passed'],result['errors']);self.assertTrue(result['metrics']['joint_term_qualifier_delivered'])
    def test_changed_hash_never_scores(self):
        q,s,p,scope=fixture();p['items'][0]['detail']['source_text']['sha256']='0'*64
        r=check(q,s,p,scope);self.assertFalse(r['checks_passed']);self.assertFalse(r['metrics']['joint_term_qualifier_delivered'])
    def test_wrong_ranges_and_missing_qualifier(self):
        q,s,p,scope=fixture();original=p['items'][0]['text'];p['items'][0]['text']=original[:12];p['items'][0]['detail']['source_text']['ranges']=[[0,12]];p['manifest']['token_estimate']=estimate(p)
        r=check(q,s,p,scope);self.assertTrue(r['checks_passed'],r['errors']);self.assertFalse(r['metrics']['joint_term_qualifier_delivered'])
        p['items'][0]['detail']['source_text']['ranges']=[[1,13]];self.assertFalse(check(q,s,p,scope)['checks_passed'])
    def test_foreign_scope_source_and_ordinal(self):
        for mutate in ('scope','source','ordinal'):
            q,s,p,scope=fixture()
            if mutate=='scope':s['events'][0]['session_id']=999
            elif mutate=='source':p['items'][0]['detail']['source_text']['source_event_id']=999
            else:s['facts'][0]['fact_ordinal']=1
            self.assertFalse(check(q,s,p,scope)['checks_passed'])
    def test_empty_target_stays_failure(self):
        q,s,p,scope=fixture();p['items']=[];p['manifest']['token_estimate']=estimate(p)
        r=check(q,s,p,scope);self.assertTrue(r['checks_passed']);self.assertFalse(r['metrics']['target_fact_delivered'])
    def test_candidate_trace_ambiguity_is_error(self):
        self.assertFalse(check(*fixture(),calls=[[10,11],[10,99]])['candidate_trace_verified'])
    def test_budget_overflow_is_error(self):self.assertFalse(check(*fixture(),budget=1)['checks_passed'])
    def test_uncovered_checks_all_body_channels(self):
        for p in ({'items':[{}]},{'relation_paths':[{}]},{'learning_episodes':[{}]},{'kernel_heads':{'knowledge':{'summary':'foreign'}}},{'personal_concept_graph':{'nodes':[{}]}},{'teaching_guidance':[{}]}):self.assertTrue(has_evidence_body(p))
        self.assertFalse(has_evidence_body({'kernel_heads':{'knowledge':{'focus_refs':[10],'summary':''}},'personal_concept_graph':{'nodes':[],'edges':[]}}))
    def test_formation_rejects_mutation_gap(self):
        q,s,p,scope=fixture();op={'id':'target','text':s['events'][0]['payload']['text'],'event_id':7,'scope':scope}
        self.assertTrue(audit_formation(s,[op],scope)['checks_passed'])
        s['mutations'][0]['before_version']=2;s['mutations'][0]['after_version']=3;s['states'][0]['version']=3
        self.assertIn('mutation_sequence_gap',audit_formation(s,[op],scope)['errors'])
    def test_null_target_not_automatic_recall_success(self):
        q,s,p,scope=fixture();q.update(target_operation=None,negative='no_history')
        r=verify(q,s,p,scope,None,trace([[10,11]]),1800,[])
        self.assertIsNone(r['metrics']['target_fact_delivered']);self.assertFalse(r['metrics']['strict_empty_on_uncovered'])
    def test_saved_json_order_does_not_change_check(self):
        values=json.loads(json.dumps(fixture(),sort_keys=True));self.assertTrue(check(*values)['checks_passed'])
    def test_real_path_tuple_scope_and_hash_are_required(self):
        q,s,p,scope=fixture()
        def endpoint(node):return {'id':node['id'],'kernel':'knowledge','occurred_at':node['occurred_at'],'evidence_grade':'self_reported','source_event_id':7,'text':node['text'],'source_text':{'sha256':digest(node['text']),'chars':len(node['text']),'ranges':[[0,len(node['text'])]]}}
        path={'source':endpoint(s['nodes'][0]),'target':endpoint(s['nodes'][1]),'relation':'SAME_SUBJECT','evidence_event_id':7,'root_anchor_id':10,'hop':1,'via_node_ids':[10,11]}
        s['edges']=[{'id':20,'learner_id':1,'source_node_id':10,'target_node_id':11,'relation_type':'SAME_SUBJECT','evidence_event_id':7}]
        self.assertEqual(verify_paths(indexes(s),[path],scope)[1],[])
        tampered=deepcopy(path);tampered['target']['source_text']['sha256']='0'*64
        self.assertTrue(verify_paths(indexes(s),[tampered],scope)[1])
        incomplete=deepcopy(path);incomplete.update(hop=2,root_anchor_id=12,via_node_ids=[12,10,11])
        self.assertTrue(any(e.endswith('missing_path_prefix') for e in verify_paths(indexes(s),[incomplete],scope)[1]))
        s['edges'][0]['learner_id']=9;self.assertTrue(verify_paths(indexes(s),[path],scope)[1])
    def test_head_same_size_does_not_count_as_candidate_call(self):
        q,s,p,scope=fixture();calls=[{'ids':[98,99],'caller_function':'build_five_kernel_context','caller_line':869},*trace([[10,11]])]
        self.assertEqual(verify(q,s,p,scope,7,calls,1800,[])['candidate_pool_ids'],[10,11])


if __name__=='__main__':unittest.main()
