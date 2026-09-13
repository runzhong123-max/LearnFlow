"""Check the delivered experiment bytes, source snapshots, tables and references.

This is deterministic artifact verification, not new sampling or statistical evidence.
Run with the project backend Python from the repository root.
"""
from pathlib import Path
from collections import Counter
import gzip
import hashlib
import json
import re
import subprocess
import sys
import tarfile
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
sys.path.insert(0,str(REPO))
from evals.five_kernel_capabilities.verifier import verify
from evals.five_kernel_interactions.verifier import verify as verify_interaction
from evals.five_kernel_longtail import run as longtail_runner


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    checked=[]
    for name in ('native-01','native-02'):
        run=HERE/'native-capabilities'/name
        manifest=json.loads((run/'artifact-manifest.json').read_text())
        for file,h in manifest['files'].items():
            assert sha(run/file)==h,(name,file)
        checked.append({'run':name,'manifest_files':len(manifest['files'])})
    run=HERE/'native-capabilities/native-02'
    frozen=json.loads((run/'freeze.json').read_text())
    # Historical evidence must be checked against its frozen product version,
    # not invalidated or relabelled as current when unrelated product work lands.
    source_drift=[f for f,h in frozen['source_hashes'].items() if not (REPO/f).is_file() or sha(REPO/f)!=h]
    historical_checked=[]
    for file in source_drift:
        original=subprocess.check_output(['git','show',f"{frozen['head']}:{file}"],cwd=REPO)
        assert hashlib.sha256(original).hexdigest()==frozen['source_hashes'][file],file
        historical_checked.append(file)
    cases=json.loads((REPO/'evals/five_kernel_capabilities/cases.json').read_text())
    with gzip.open(run/'native.jsonl.gz','rt',encoding='utf8') as f:raw={r['case_id']:r for r in map(json.loads,f)}
    scores=[verify(c,raw[c['case_id']]) for c in cases]
    stored=json.loads((run/'aggregate.json').read_text())
    assert scores==stored['scores']
    assert sum(s['passed'] for s in scores)==stored['case_passed']==15
    assert sum(len(s['checks']) for s in scores)==66
    assert stored['reverification_equal'] and stored['source_unchanged']
    assert Counter(s['kernel'] for s in scores)==Counter({k:3 for k in ['structure','knowledge','human','value','practice']})
    old=json.loads((HERE/'native-capabilities/native-01/aggregate.json').read_text())
    assert not old['reverification_equal'] and old['case_passed']==15
    archive=HERE/'native-capabilities/delivery-audit-and-failed-source.tar.gz'
    with tarfile.open(archive) as tar:
        names={m.name.removeprefix('./'):m for m in tar.getmembers() if m.isfile()}
        old_sources=[n for n in names if n.startswith('diagnostic-01-source/')]
        assert len(old_sources)==8
        oldfreeze=json.loads((HERE/'native-capabilities/native-01/freeze.json').read_text())
        for name in old_sources:
            b=tar.extractfile(names[name]).read()
            key='evals/five_kernel_capabilities/'+name.split('/')[-1]
            assert hashlib.sha256(b).hexdigest()==oldfreeze['source_hashes'][key]
    formal=json.loads((HERE.parent/'education-memory-counterfactual/formal-01-aggregate.json').read_text())
    manuscript=(HERE/'manuscript_zh.md').read_text()
    body,bib=manuscript.split('## 参考文献\n',1)
    names={'five_kernel_gated':'五核＋资格','flat_gated':'平面＋资格','five_kernel_source':'五核仅来源','flat_source':'平面仅来源'}
    for row in formal['groups']:
        expected=f"| {row['budget']:,} | {names[row['variant']]} | {row['metrics']['whole_record_correct']}/96 | {row['pair_joint_success']}/48 | {row['metrics']['action_correct']}/96 | {row['reader_completed']}/96 |"
        assert expected in body,expected
    refs=json.loads((HERE/'references_numbered.json').read_text())
    assert [r['citation_number'] for r in refs]==list(range(1,19))
    assert len({r['key'] for r in refs})==18
    for r in refs:
        assert f"[{r['citation_number']}]" in bib and r['url'] in bib
    used=set()
    for numbers in re.findall(r'\[([\d,–-]+)\]',body):
        for part in numbers.split(','):
            if '–' in part or '-' in part:
                lo,hi=map(int,re.split('[–-]',part));used.update(range(lo,hi+1))
            else:used.add(int(part))
    assert used==set(range(1,19))
    fig=json.loads((HERE/'figures/manifest.json').read_text())
    assert sha(REPO/fig['source'])==fig['source_sha256']
    assert sha(HERE/'build_figures.py')==fig['generator_sha256']
    for file,h in fig['figures'].items():assert sha(HERE/'figures'/file)==h,file
    for file,h in fig.get('additional_sources',{}).items():assert sha(HERE/file)==h,file
    object_sources=json.loads((HERE/'sources/object-interaction-source-hashes.json').read_text())
    for file,h in object_sources['files'].items():
        original=subprocess.check_output(['git','show',f"{object_sources['baseline']}:{file}"],cwd=REPO)
        assert hashlib.sha256(original).hexdigest()==h,file
    for name in ('run-01','run-02'):
        directory=HERE/'interaction-validation'/name
        im=json.loads((directory/'artifact-manifest.json').read_text())
        for file,h in im['files'].items():assert sha(directory/file)==h,(name,file)
    directory=HERE/'interaction-validation/run-02'
    icases=json.loads((directory/'harness-source/cases.json').read_text())
    with gzip.open(directory/'native.jsonl.gz','rt') as f:iraw={r['case_id']:r for r in map(json.loads,f)}
    iscores=[verify_interaction(c,iraw[c['case_id']]) for c in icases]
    iresult=json.loads((directory/'aggregate.json').read_text())
    assert iscores==iresult['scores']
    assert iresult['passed']==13 and iresult['total']==14
    assert iresult['case_assertions']==80 and iresult['execution_complete_count']==14
    assert iresult['source_unchanged'] and iresult['reverification_equal']
    assert iresult['infrastructure_error_count']==0
    assert '| 既有业务合同 | 11/11 |' in manuscript
    assert '| 作者组合边界 | 2/2 |' in manuscript
    assert '| 作者状态失效挑战 | 0/1 |' in manuscript
    ld=HERE/'longtail-validation'
    for directory in (ld,ld/'failed-run-01',ld/'failed-run-02'):
        for filename in ('artifact-manifest.json','handoff-manifest.json'):
            if not (directory/filename).exists():continue
            lm=json.loads((directory/filename).read_text())
            for file,h in lm['files'].items():assert sha(directory/file)==h,(directory.name,file)
    # Suppress only the verifier's derived receipt file write. All formation,
    # packet and score inputs are reopened from immutable delivered bytes.
    with patch.object(longtail_runner,'save',lambda *_:None):
        lr=longtail_runner.reverify_saved(ld)
    assert lr['all_checks_passed'] and lr['raw_packets']==228 and lr['formation_snapshots']==36
    la=json.loads((ld/'aggregate.json').read_text())
    assert la['matrix_complete'] and la['all_integrity_checks_passed']
    for history in (4,64,256):
        for budget in (1800,3200):
            cells=[]
            for metric in ('joint_term_qualifier_delivered','strict_empty_on_uncovered'):
                for variant in ('default','source'):
                    rows=[r for r in la['by_stratum'] if (r['history'],r['budget'],r['variant'])==(history,budget,variant)]
                    numerator=sum(r['metrics'][metric]['numerator'] for r in rows)
                    denominator=sum(r['metrics'][metric]['denominator'] for r in rows)
                    cells.append(f'{numerator}/{denominator}')
            expected=f"| {history} | {budget:,} | "+' | '.join(cells)+' |'
            assert expected in manuscript,expected
    assert 'REFERENCES_INSERTION_POINT' not in manuscript
    out={'kind':'independent_delivery_recomputation','native_runs':checked,
         'native02_source_files_checked':len(frozen['source_hashes']),
         'native02_live_source_differences':source_drift,
         'native02_historical_source_verified':historical_checked,
         'source_drift_during_native02_run':not stored['source_unchanged'],
         'native02_case_scores_recomputed':len(scores),'case_field_assertions':66,
         'native02_all_scores_match':True,'failed_native01_preserved':True,
         'failed_source_files_checked':len(old_sources),'formal_table_rows_checked':8,
         'references_checked':18,'figure_files_checked':len(fig['figures']),
         'object_interaction_source_files_checked':len(object_sources['files']),
         'interaction_cases_recomputed':14,'interaction_passed':13,
         'interaction_assertions':80,'interaction_failure_preserved':True,
         'longtail_raw_reverification':lr,'longtail_table_rows_checked':6,
         'primary_formal_responses':formal['actual_responses'],
         'scope':'No new model responses or educational-effect estimates; visual QA recorded separately.'}
    (HERE/'artifact-audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(out,ensure_ascii=False))


if __name__=='__main__':main()
