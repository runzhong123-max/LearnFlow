"""Calibration of the independent evidence-content verifier and isolation."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
from run_ablation import score_packet, VARIANTS


def fixture():
    statement = '第一次正式尝试使用了步骤提示，只能记录受助完成。'
    case = {'required':['help'], 'learner_id':1, 'project_id':10, 'at':'2026-09-08T04:00:00',
            'family':'assistance', 'adaptation':None}
    base = {'learner_id':1,'project_id':10,'kernel':'practice','status':'active',
            'sensitive':False,'units':{'help':statement},'node_type':'fact','grade':'observed'}
    meta = {'1':base,'2':{**base,'node_type':'claim'}}
    return case,meta,statement


def item(identifier, body, **extra):
    return {'id':identifier,'text':body,'status':'active','detail':{'evidence_grade':'observed'},**extra}


def test_equivalent_fact_and_claim_are_accepted():
    case,meta,statement=fixture()
    for identifier in (1,2):
        result=score_packet({'items':[item(identifier,statement)]},case,meta)
        assert result['coverage']==1 and result['complete'] and not result['violations']


def test_id_reference_and_truncated_content_do_not_count():
    case,meta,statement=fixture()
    for packet in ({'items':[], 'manifest':{'evidence_ids':[1]}},
                   {'items':[item(1,statement[:8])]},
                   {'kernel_heads':{'practice':{'focus_refs':[1],'summary':''}}}):
        assert score_packet(packet,case,meta)['coverage']==0


def test_supported_neighbor_content_counts_without_requiring_primary_item():
    case,meta,statement=fixture()
    packet={'relation_paths':[{'source':{'id':1,'text':statement},'target':{'id':2,'text':statement}}]}
    assert score_packet(packet,case,meta)['coverage']==1


def test_scope_status_and_evidence_grade_errors_are_explicit():
    case,meta,statement=fixture()
    meta['1']={**meta['1'],'project_id':99,'status':'retracted'}
    result=score_packet({'items':[item(1,statement,detail={'evidence_grade':'verified'})]},case,meta)
    assert set(result['violations'])=={'scope_leak','inactive_as_current','evidence_grade_changed'}


def test_superseded_history_is_not_current_evidence():
    case,meta,statement=fixture()
    meta['1']={**meta['1'],'status':'superseded'}
    packet={'relation_paths':[{'source':{'id':1,'text':statement,'status':'superseded'},
                              'target':{'id':2,'text':''}}]}
    result=score_packet(packet,case,meta)
    assert result['coverage']==0 and result['historical_units']==['help'] and not result['violations']


def test_unknown_memory_returns_no_credit():
    case,meta,statement=fixture()
    result=score_packet({'items':[item(999,statement)]},case,meta)
    assert result['coverage']==0 and result['violations']==['unknown_node']


def test_smoke_all_conditions_and_database_isolation(tmp_path):
    sentinel=tmp_path/'configured-production.db'
    sentinel.write_bytes(b'DO NOT OPEN OR CHANGE')
    out=tmp_path/'results'
    run=subprocess.run([sys.executable,str(Path(__file__).with_name('run_ablation.py')),
        '--trajectories','1','--repetitions','1','--budgets','2800','--output',str(out)],
        env={**os.environ,'DATABASE_URL':f'sqlite+aiosqlite:///{sentinel}'},
        capture_output=True,text=True,timeout=90)
    assert run.returncode==0,run.stderr
    assert sentinel.read_bytes()==b'DO NOT OPEN OR CHANGE'
    report=json.loads((out/'summary.json').read_text())
    assert report['network_attempts']==[] and 'configured.db' not in report['sqlite_files_opened']
    assert report['cases']==14 and report['retrieval_calls']==14*6
    rows=[json.loads(line) for line in (out/'queries.jsonl').read_text().splitlines()]
    assert {row['variant'] for row in rows}==set(VARIANTS)
    assert all(row['budget_ok'] and row['repeat_stable'] for row in rows)
    assert all(row['path_count']==0 for row in rows if row['variant']=='no_relations')
    base={row['case_id']:row for row in rows if row['variant']=='full'}
    for row in rows:
        if row['variant']=='no_head_cache':
            assert row['observed_units']==base[row['case_id']]['observed_units']
            assert row['adaptation_ok']==base[row['case_id']]['adaptation_ok']
