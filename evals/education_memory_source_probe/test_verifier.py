"""Verifier calibration fixtures only; never inserted into a product database."""
import json
import unittest
from verifier import digest, estimate, excerpt_error, indexes, native_chain, verify


def fixture():
    scope={'learner_id':1,'project_id':2,'checkpoint_id':3,'session_id':4}
    text='我不懂协程。观察完整。仅单线程通过，并发未验证。'
    case={'text':text,'target_term':'观察完整','qualifier':'仅单线程通过，并发未验证'}
    event={'id':7,**scope,'event_type':'user_message','source':'user','payload':{'text':text},'occurred_at':'2026-09-01T09:00:00'}
    mutation={'id':8,'learner_id':1,'event_id':7,'kernel_name':'knowledge','status':'applied','before_version':1,'after_version':2,'patch':{'short_term':{'pending_question':text,'knowledge_gap':text},'long_term':{}}}
    nodes=[];facts=[]
    for ordinal,key in enumerate(('pending_question','knowledge_gap')):
        nodes.append({'id':10+ordinal,**scope,'node_type':'fact','kernel_name':'knowledge','status':'active','text':key+': '+text,'payload':{'scope':'short_term','key':key,'event_type':'user_message'},'occurred_at':event['occurred_at']})
        facts.append({'node_id':10+ordinal,**{k:scope[k] for k in ('project_id','checkpoint_id','session_id')},'source_event_id':7,'source_mutation_id':8,'predicate':'short_term.'+key,'fact_ordinal':ordinal,'object_value':text,'consumption_status':'eligible'})
    snapshot={'nodes':nodes,'facts':facts,'events':[event],'mutations':[mutation],'states':[{'id':9,'learner_id':1,'kernel_name':'knowledge','version':2,'evidence_refs':[7],'action_chain':[{'event_id':7}]}],'projects':[{'id':2,'learner_id':1}],'roadmaps':[{'id':5,'project_id':2}],'checkpoints':[{'id':3,'roadmap_id':5,'archived':False}],'sessions':[{'id':4,**scope}]}
    item={'id':10,'text':text,'scope':{k:scope[k] for k in ('project_id','checkpoint_id','session_id')},'evidence_refs':[7],'detail':{'source_event_id':7,'source_text':{'source_kind':'fact_object_value','source_path':'/object_value','source_event_id':7,'source_mutation_id':8,'sha256':digest(text),'chars':len(text),'ranges':[[0,len(text)]]}}}
    packet={'items':[item],'kernel_heads':{'knowledge':{'focus_refs':[10]}},'omitted':{'candidate_count':2},'manifest':{'policy':{}}}
    packet['manifest']['token_estimate']=estimate(packet)
    return case,snapshot,packet,scope


def check(c,s,p,scope,budget=1800):return verify(c,s,p,scope,7,[10,11],[[10,11]],budget)


class VerifierTests(unittest.TestCase):
    def test_valid_source_is_positive(self):
        result=check(*fixture());self.assertTrue(result['checks_passed']);self.assertTrue(result['metrics']['joint_term_qualifier_delivered'])
    def test_saved_sorted_json_preserves_independent_check(self):
        c,s,p,scope=fixture();self.assertTrue(check(c,json.loads(json.dumps(s,sort_keys=True)),p,scope)['checks_passed'])
    def test_wrong_hash_is_not_ignored(self):
        c,s,p,scope=fixture();p['items'][0]['detail']['source_text']['sha256']='0'*64
        result=check(c,s,p,scope);self.assertFalse(result['checks_passed']);self.assertFalse(result['metrics']['joint_term_qualifier_delivered'])
    def test_foreign_scope_is_rejected(self):
        c,s,p,scope=fixture();s['events'][0]['learner_id']=20
        self.assertIn('learner_mismatch',native_chain(indexes(s),10,scope)[1])
    def test_changed_mutation_or_ordinal_is_rejected(self):
        c,s,p,scope=fixture();s['facts'][0]['fact_ordinal']=1
        self.assertIn('ordinal_patch_value',native_chain(indexes(s),10,scope)[1])
    def test_range_overlap_and_reconstruction_are_rejected(self):
        self.assertEqual(excerpt_error('abc',{'ranges':[[0,2],[1,3]]},'abc'),['invalid_ranges'])
        self.assertIn('source_reconstruction',excerpt_error('axc',{'ranges':[[0,3]],'sha256':digest('abc'),'chars':3},'abc'))
    def test_absent_target_is_zero_not_removed(self):
        c,s,p,scope=fixture();p['items']=[];p['manifest']['token_estimate']=estimate(p)
        result=check(c,s,p,scope);self.assertTrue(result['checks_passed']);self.assertFalse(result['metrics']['joint_term_qualifier_delivered'])
    def test_candidate_omission_invalidates_check(self):
        c,s,p,scope=fixture();result=verify(c,s,p,scope,7,[10],[[10]],1800)
        self.assertFalse(result['candidate_pool_verified']);self.assertFalse(result['checks_passed'])
    def test_budget_and_foreign_head_are_checked(self):
        c,s,p,scope=fixture();p['kernel_heads']['knowledge']['focus_refs']=[99]
        result=check(c,s,p,scope,1);self.assertIn('head_scope:focus_refs',result['errors']);self.assertIn('budget',result['errors'])


if __name__=='__main__':unittest.main()
