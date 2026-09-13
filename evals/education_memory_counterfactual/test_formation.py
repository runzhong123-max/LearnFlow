"""Native formation regression tests; no model scores or human-effect claims."""
import asyncio
from collections import Counter
from copy import deepcopy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

try:
    from .generate import build_cases, CONTRASTS
    from .formation import form_case
except ImportError:
    from generate import build_cases, CONTRASTS
    from formation import form_case


def at(value):return datetime.fromisoformat(value.replace('Z','+00:00'))


def controls(row, slot):
    found={}
    for mutation in row['mutations']:
        for storage,key in (('short_term','teaching_directives'),('long_term','teaching_preferences')):
            for entry in mutation['patch'].get(storage,{}).get(key,[]):
                if entry.get('slot')==slot and entry.get('source_event_id')==mutation['event_id']:
                    found[(entry['source_event_id'],tuple(entry.get('source_span') or []))]=entry
    return list(found.values())


class FormationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo=Path(os.environ.get('LEARNFLOW_CF_REPO',Path(__file__).resolve().parents[2]))
        cls.cases=build_cases()
        chosen=[c for c in cls.cases if c['family_id']=='breadth_first']
        async def execute():
            gate=asyncio.Semaphore(3)
            async def one(case):
                async with gate:return await form_case(case,cls.repo)
            return await asyncio.gather(*(one(c) for c in chosen))
        cls.rows={r['case_id']:r for r in asyncio.run(execute())}

    def row(self,contrast,side):return self.rows[f'cf-breadth_first-{contrast}-{side}']

    def test_fixed_split_pairs_and_executed_oracles(self):
        self.assertEqual(Counter(c['split'] for c in self.cases),{'formal':96,'dev':24})
        self.assertEqual(len({c['family_id'] for c in self.cases if c['split']=='formal'}),8)
        self.assertEqual(len({c['family_id'] for c in self.cases if c['split']=='dev'}),2)
        self.assertEqual(len({c['case_id'] for c in self.cases}),120)
        groups={}
        for c in self.cases:
            groups.setdefault(c['pair_id'],[]).append(c)
            oracle=c['question']['oracle']
            self.assertEqual(oracle['exit_code'],0)
            self.assertEqual(hashlib.sha256(oracle['program'].encode()).hexdigest(),oracle['program_sha256'])
            self.assertEqual(hashlib.sha256(oracle['stdout'].encode()).hexdigest(),oracle['stdout_sha256'])
            self.assertEqual(json.loads(oracle['stdout']),json.loads(oracle['correct_response']))
            self.assertNotEqual(oracle['correct_response'],oracle['incorrect_response'])
        self.assertEqual(len(groups),60)
        for pair in groups.values():
            self.assertEqual({c['side'] for c in pair},{'a','b'})
            backgrounds=[[s for s in c['steps'] if s['id'].startswith('background-')] for c in pair]
            self.assertEqual(backgrounds[0],backgrounds[1]);self.assertEqual(len(backgrounds[0]),10)

    def test_native_chain_ownership_and_offline_formation(self):
        for row in self.rows.values():
            self.assertEqual(row['status'],'formed',row.get('formation_gaps'))
            self.assertEqual(row['offline_audit'],{'network_attempts':0,'file_database_attempts':0})
            self.assertTrue(all(r['status']=='formed' for r in row['receipts']))
            events={e['id']:e for e in row['events']};mutations={m['id']:m for m in row['mutations']};nodes={n['id']:n for n in row['nodes']}
            projects={p['id']:p for p in row['projects']}
            for fact in row['facts']:
                event=events[fact['source_event_id']];mutation=mutations[fact['source_mutation_id']];node=nodes[fact['node_id']]
                self.assertEqual(mutation['event_id'],event['id']);self.assertEqual(mutation['status'],'applied')
                self.assertEqual(mutation['after_version'],mutation['before_version']+1)
                self.assertEqual(node['learner_id'],event['learner_id'])
                self.assertEqual(projects[event['project_id']]['learner_id'],event['learner_id'])
                for key in ('project_id','checkpoint_id','session_id'):
                    self.assertEqual(node[key],fact[key]);self.assertEqual(fact[key],event[key])
                storage,key=fact['predicate'].split('.',1)
                self.assertEqual(mutation['patch'][storage][key],fact['object_value'])
            self.assertTrue(any(e['project_id']!=row['scope']['project_id'] for e in row['events']))
            self.assertTrue(any(datetime.fromisoformat(e['occurred_at'])>at(row['at']).replace(tzinfo=None) for e in row['events']))

    def test_assistance_and_latest_order_use_real_attempts(self):
        for side,expected in (('a','guided'),('b','none')):
            r=next(x for x in self.row('assistance',side)['receipts'] if x['operation_id']=='result')
            self.assertTrue(r['actual_correct']);self.assertEqual(r['actual_assistance'],expected)
            self.assertEqual(r['actual_independent'],side=='b')
        for side,values in (('a',[False,True]),('b',[True,False])):
            rs=[r for r in self.row('latest_outcome',side)['receipts'] if r['operation_id'].startswith('result-')]
            self.assertEqual([r['actual_correct'] for r in rs],values)
            self.assertTrue(all(r['actual_assistance']=='none' for r in rs))
            self.assertEqual(len({r['question_id'] for r in rs}),2)

    def test_native_controls_and_expiry(self):
        for side,minutes in (('a',8),('b',25)):
            entries=controls(self.row('time_budget',side),'time_budget')
            self.assertEqual([e['minutes'] for e in entries],[minutes])
        for side,active in (('a',True),('b',False)):
            row=self.row('support_expiry',side);entries=controls(row,'support')
            self.assertEqual(len(entries),1);self.assertEqual(at(entries[0]['expires_at'])>at(row['at']),active)
            self.assertEqual(entries[0]['source_span'],[0,5])
        latest=[]
        for side in ('a','b'):
            row=self.row('priority_update',side)
            current=[e for e in controls(row,'current_priority') if at(e['expires_at'])>at(row['at'])]
            latest.append(max(current,key=lambda e:at(e['occurred_at']))['requested_priority'])
            self.assertTrue(controls(row,'return_anchor'))
        self.assertEqual(latest,['广度优先遍历例题推演','广度优先遍历边界分析'])

    def test_self_report_never_becomes_a_current_assessment(self):
        row=self.row('self_report_vs_assessment','a')
        valid=[e for e in row['events'] if e['event_type']=='concept_attempt_evaluated'
               and e['project_id']==row['scope']['project_id'] and datetime.fromisoformat(e['occurred_at'])<=at(row['at']).replace(tzinfo=None)]
        self.assertEqual(valid,[])
        event=next(e for e in row['events'] if e['event_type']=='learner_concept_observation_recorded')
        self.assertTrue(any(f['source_event_id']==event['id'] and f['evidence_grade']=='self_reported' for f in row['facts']))
        for row in self.rows.values():
            gaps=[r for r in row['receipts'] if r['op']=='native_gap']
            self.assertEqual(len(gaps),8)
            self.assertTrue(all(any(f['source_event_id']==r['event_id'] for f in row['facts']) for r in gaps))

    def test_parent_credentials_and_environment_unchanged(self):
        case=next(c for c in self.cases if c['family_id']=='sql_join' and c['contrast']=='assistance' and c['side']=='b')
        with patch.dict(os.environ,{'LLM_API_KEY':'sentinel-not-a-credential','OPENAI_API_KEY':'sentinel-parent-value','DATABASE_URL':'sqlite:///must-not-open.db'}):
            before=dict(os.environ);row=asyncio.run(form_case(case,self.repo))
            self.assertEqual(dict(os.environ),before)
            self.assertEqual(row['status'],'formed');self.assertEqual(row['offline_audit']['file_database_attempts'],0)
            self.assertFalse((self.repo/'must-not-open.db').exists())

    def test_changed_answer_cannot_claim_oracle_execution(self):
        case=deepcopy(next(c for c in self.cases if c['family_id']=='sql_join'))
        case['question']['oracle']['correct_response']='999999'
        row=asyncio.run(form_case(case,self.repo))
        self.assertEqual(row['status'],'formation_error')
        self.assertIn('oracle_answer_not_bound_to_execution_stdout',row['formation_gaps'][0]['stderr'])
        self.assertEqual(row['events'],[])


if __name__=='__main__':unittest.main()
