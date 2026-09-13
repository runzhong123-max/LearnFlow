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
import sys
import tarfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
sys.path.insert(0,str(REPO))
from evals.five_kernel_capabilities.verifier import verify


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
    source_drift=[f for f,h in frozen['source_hashes'].items() if sha(REPO/f)!=h]
    assert not source_drift,source_drift
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
    assert 'REFERENCES_INSERTION_POINT' not in manuscript
    out={'kind':'independent_delivery_recomputation','native_runs':checked,
         'native02_source_files_checked':len(frozen['source_hashes']),'source_drift':source_drift,
         'native02_case_scores_recomputed':len(scores),'case_field_assertions':66,
         'native02_all_scores_match':True,'failed_native01_preserved':True,
         'failed_source_files_checked':len(old_sources),'formal_table_rows_checked':8,
         'references_checked':18,'figure_files_checked':len(fig['figures']),
         'primary_formal_responses':formal['actual_responses'],
         'scope':'No new model responses or educational-effect estimates; visual QA recorded separately.'}
    (HERE/'artifact-audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(out,ensure_ascii=False))


if __name__=='__main__':main()
