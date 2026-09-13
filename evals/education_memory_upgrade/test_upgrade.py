"""Pure-data calibration only; these fixtures are not reported experiment results."""
import copy
from dataclasses import make_dataclass, asdict
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT/'evals/education_memory_v2'),str(ROOT/'scripts')]
from components import UPGRADE_VARIANTS, UPGRADE_PRESETS, COMPONENT_FIELDS, policy_for, packet_tokens
from education_verifier import _estimated_tokens, _original_source, _excerpt_error
from projection_checks import verify_component_intervention
from report import validate_matrix, educational_diagnostics, rank_education, verify_probe_counts, model_execution_audit, ALWAYS, CONDITIONAL
from test_audit_education_episode_freshness import fixture, deliver_episode, deliver_guidance
from audit_education_episode_freshness import state_indexes


def row(case='c', variant='legacy', action=True, complete=True, topic=1, raw=1):
    metrics={name:True for name in (*ALWAYS,*CONDITIONAL)}
    metrics.update(applicable_assessment=True,applicable_action_coverage=action,latest_conditions_delivered=complete,
        stale_action_count=0,unsupported_or_wrong_assessment_action_count=0,packet_token_estimate=1500,latency_ms=10,
        source_fact_evidence_delivered_assessment_topic_numerator=topic,
        source_fact_evidence_delivered_assessment_topic_denominator=1,
        source_fact_evidence_delivered_raw_statement_numerator=raw,
        source_fact_evidence_delivered_raw_statement_denominator=1)
    return {'case_id':case,'family_id':'f','variant':variant,'budget':1800,'metrics':metrics}


def source_fixture():
    text='I understand heaps but cannot yet prove the running time.'
    scope={'learner_id':1,'project_id':2,'checkpoint_id':3,'session_id':4}
    node={**scope,'text':'knowledge_gap: '+text,'node_type':'fact','kernel':'knowledge','status':'active',
          'payload':{'scope':'short_term','key':'knowledge_gap'}}
    fact={**scope,'object_value':text,'predicate':'short_term.knowledge_gap','fact_ordinal':0,'event_id':10,'mutation_id':20}
    event={**scope,'id':10,'event_type':'vnext_teaching_input_received','payload':{'text':text}}
    mutation={'id':20,'event_id':10,'status':'applied','kernel':'knowledge','learner_id':1,
              'patch':{'short_term':{'knowledge_gap':text}}}
    packet={'_source_facts':{5:fact},'_source_events':{10:event},'_source_mutations':{20:mutation}}
    item={'id':5,'text':text}
    detail={'source_text':{'source_kind':'fact_object_value','source_path':'/object_value','source_event_id':10,
            'source_mutation_id':20,'sha256':hashlib.sha256(text.encode()).hexdigest(),'chars':len(text),'ranges':[[0,len(text)]]}}
    return packet,item,detail,node


class UpgradeTests(unittest.TestCase):
    def test_run_output_growth_is_excluded_but_product_changes_still_drift(self):
        spec=importlib.util.spec_from_file_location('upgrade_suite_under_test',HERE/'run_suite.py')
        suite=importlib.util.module_from_spec(spec);spec.loader.exec_module(suite)
        with tempfile.TemporaryDirectory() as temporary:
            repo=Path(temporary)
            initial={
                'evals/education_memory_upgrade/run_suite.py':'driver source',
                'evals/education_memory_v2/education.py':'old driver source',
                'packages/learning-core/src/learnflow_core/context.py':'product source',
                'backend/app/runs/worker.py':'real product module named runs',
                'scripts/audit_education_episode_freshness.py':'audit source',
            }
            for name,text in initial.items():
                path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
            before=suite.source_hashes(repo)
            for name in ('evals/education_memory_upgrade/runs/formal-01/PROTOCOL.md',
                         'evals/education_memory_upgrade/runs/formal-01/snapshot/driver-source.py',
                         'evals/education_memory_v2/runs/pilot/REPORT.md',
                         'evals/education_memory_v2/results/retained/source.py'):
                path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('new run artifact')
            self.assertEqual(suite.source_hashes(repo),before)
            product='packages/learning-core/src/learnflow_core/context.py'
            (repo/product).write_text('changed product implementation')
            after=suite.source_hashes(repo)
            self.assertNotEqual(after[product],before[product])
            self.assertIn('backend/app/runs/worker.py',after)
            (repo/'backend/app/runs/worker.py').write_text('changed real product runs implementation')
            self.assertNotEqual(suite.source_hashes(repo)['backend/app/runs/worker.py'],after['backend/app/runs/worker.py'])

    def test_frozen_presets_change_only_named_new_fields_and_remove_paths_explicitly(self):
        defaults={'token_budget':1,'max_paths':8,'enable_episodes':True,'max_episodes':3,'max_episode_facts':6,
          'enable_bm25':True,'enable_aliases':True,'enable_fuzzy':True,'enable_temporal':True,'enable_summary_boost':True,
          'enable_source_text':False,'enable_compact_episodes':False,'candidate_mode':'legacy'}
        policy=make_dataclass('P',[(k,type(v)) for k,v in defaults.items()])(**defaults)
        for variant in UPGRADE_VARIANTS:
            actual=asdict(policy_for(policy,variant,1800))
            self.assertEqual(actual,{**defaults,'token_budget':1800,**UPGRADE_PRESETS[variant]})
        self.assertNotIn('education_full_no_graph',UPGRADE_VARIANTS)

    def test_independent_budget_includes_new_fields(self):
        packet={'manifest':{'policy':{k:False for k in COMPONENT_FIELDS}}}
        self.assertEqual(packet_tokens(packet),_estimated_tokens(packet))
        before=packet_tokens(packet)
        packet['manifest']['policy']['candidate_mode']='hybrid'*100
        self.assertGreater(packet_tokens(packet),before)
        self.assertEqual(packet_tokens(packet),_estimated_tokens(packet))

    def test_reject_missing_duplicate_extra_and_nonfinite_conditions(self):
        with self.assertRaises(ValueError):validate_matrix([],['c'],['legacy'],[1800])
        with self.assertRaises(ValueError):validate_matrix([row(),row()],['c'],['legacy'],[1800])
        with self.assertRaises(ValueError):validate_matrix([row()],['different'],['legacy'],[1800])
        broken=row();broken['metrics']['latency_ms']=float('nan')
        with self.assertRaises(ValueError):validate_matrix([broken],['c'],['legacy'],[1800])
        self.assertEqual(len(validate_matrix([row()],['c'],['legacy'],[1800])),1)

    def test_no_action_does_not_remove_applicable_denominator(self):
        state,raw=fixture();raw['plan']['teaching_decisions']=[]
        metrics,diag=educational_diagnostics(raw,state_indexes(state))
        self.assertTrue(metrics['applicable_assessment'])
        self.assertFalse(metrics['applicable_action_coverage'])
        self.assertFalse(metrics['latest_conditions_delivered'])
        self.assertEqual(diag['latest_event_id'],2)

    def test_latest_complete_receipt_and_matching_action_get_coverage(self):
        state,raw=fixture();deliver_episode(state,raw,2)
        raw['packet']['learning_episodes'][0]['limitations']=['One observed attempt is not mastery']
        raw['plan']['teaching_decisions'][0].update(action='fade_support_then_independent_probe',source_event_ids=[2])
        metrics,_=educational_diagnostics(raw,state_indexes(state))
        self.assertTrue(metrics['applicable_action_coverage'])
        self.assertTrue(metrics['latest_conditions_delivered'])
        raw['packet']['learning_episodes'][0]['outcome']['independent']=True
        metrics,_=educational_diagnostics(raw,state_indexes(state))
        self.assertFalse(metrics['latest_conditions_delivered'])
        self.assertEqual(metrics['unsupported_or_wrong_assessment_action_count'],1)

    def test_guidance_can_support_action_but_is_not_complete_assessment_conditions(self):
        state,raw=fixture();deliver_guidance(state,raw,2)
        raw['plan']['teaching_decisions'][0].update(action='fade_support_then_independent_probe',source_event_ids=[2])
        metrics,_=educational_diagnostics(raw,state_indexes(state))
        self.assertTrue(metrics['applicable_action_coverage'])
        self.assertFalse(metrics['latest_conditions_delivered'])

    def test_stale_action_is_not_rewarded_as_coverage(self):
        state,raw=fixture();metrics,_=educational_diagnostics(raw,state_indexes(state))
        self.assertEqual(metrics['stale_action_count'],1)
        self.assertFalse(metrics['applicable_action_coverage'])

    def test_probe_denominators_are_recomputed_from_raw_scorer_decisions(self):
        checks={'source_fact_evidence_delivered':{'actual':[{'kind':'assessment_topic','delivered':False} for _ in range(10)]}}
        metrics={'source_fact_evidence_delivered_assessment_topic_numerator':0,'source_fact_evidence_delivered_assessment_topic_denominator':10,
                 'source_fact_evidence_delivered_raw_statement_numerator':0,'source_fact_evidence_delivered_raw_statement_denominator':0}
        verify_probe_counts(checks,metrics)
        metrics.update(source_fact_evidence_delivered_assessment_topic_numerator=1,
                       source_fact_evidence_delivered_assessment_topic_denominator=1)
        with self.assertRaises(ValueError):verify_probe_counts(checks,metrics)

    def test_gate_rejects_unsafe_high_coverage(self):
        unsafe=row(variant='source');unsafe['metrics']['budget']=False
        ranked={r['variant']:r for r in rank_education([row(action=False,complete=False),unsafe])}
        self.assertFalse(ranked['source']['admitted'])
        self.assertEqual(ranked['legacy']['priority_layer'],1)

    def test_pareto_keeps_tradeoffs_tied_and_secondary_only_breaks_equal_primary(self):
        data=[row(variant='a',action=True,complete=False),row(variant='b',action=False,complete=True),
              row(variant='c',action=False,complete=False),row(variant='d',action=True,complete=False,topic=0)]
        ranked={r['variant']:r for r in rank_education(data)}
        self.assertEqual([ranked[k]['priority_layer'] for k in 'abcd'],[1,1,2,1])
        self.assertEqual(ranked['a']['secondary_layer'],1)
        self.assertEqual(ranked['b']['secondary_layer'],1)
        self.assertEqual(ranked['d']['secondary_layer'],2)

    def test_actual_model_identity_and_execution_must_match_frozen_hybrid(self):
        data=row(variant='hybrid'); data['component_diagnostics']={'provider':{'semantic_model_sha256':'expected','semantic_used':True}}
        result=model_execution_audit([data],'expected',{'hybrid'})
        self.assertEqual(result[0]['semantic_used_conditions'],1)
        with self.assertRaises(ValueError):model_execution_audit([data],'other',{'hybrid'})
        data['component_diagnostics']['provider']['semantic_used']=False
        with self.assertRaises(ValueError):model_execution_audit([data],'expected',{'hybrid'})

    def test_source_object_reconstructs_real_original_and_rejects_forgery(self):
        packet,item,detail,node=source_fixture()
        original=_original_source(packet,item,detail,node)
        self.assertEqual(original,item['text'])
        self.assertEqual(_excerpt_error(item['text'],detail['source_text'],original),[])
        for field,value in [('source_path','/payload/text'),('source_kind','invented'),('source_event_id',99)]:
            forged=copy.deepcopy(detail);forged['source_text'][field]=value
            self.assertIsNone(_original_source(packet,item,forged,node))
        detail['source_text']['sha256']='forged'
        self.assertIn('sha256_mismatch',_excerpt_error(item['text'],detail['source_text'],original))
        packet['_source_facts'][5]['fact_ordinal']=99
        self.assertIsNone(_original_source(packet,item,detail,node))

    def test_source_unknown_field_sensitive_payload_and_scope_fail_closed(self):
        for transform in [lambda p,n:p['_source_events'][10]['payload'].update(ANSWER='secret'),
                          lambda p,n:p['_source_facts'][5].update(project_id=99),
                          lambda p,n:n.update(kernel='human'),
                          lambda p,n:p['_source_mutations'][20]['patch']['short_term'].update(knowledge_gap='different')]:
            packet,item,detail,node=source_fixture();transform(packet,node)
            self.assertIsNone(_original_source(packet,item,detail,node))

    def test_only_registered_nested_statement_path_is_accepted(self):
        p,i,d,n=source_fixture();value={'statement':'A misconception, not mastery','verification':'unverified'}
        import json
        n.update(text='concept_observation: '+json.dumps(value,ensure_ascii=False,sort_keys=True),
                 payload={'scope':'short_term','key':'concept_observation'})
        p['_source_facts'][5].update(object_value=value,predicate='short_term.concept_observation')
        p['_source_mutations'][20]['patch']={'short_term':{'concept_observation':value}}
        p['_source_events'][10]['event_type']='learner_concept_observation_recorded'
        d['source_text'].update(source_kind='fact_object_field',source_path='/object_value/statement')
        self.assertEqual(_original_source(p,i,d,n),value['statement'])
        d['source_text']['source_path']='/object_value/verification'
        self.assertIsNone(_original_source(p,i,d,n))


if __name__=='__main__':unittest.main()
