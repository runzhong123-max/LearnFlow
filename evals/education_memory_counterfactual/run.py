"""Freeze, audit and analyze the automatic equal-information reader study."""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import random
import sys

from .representation import pack, VARIANTS, compact, digest

HERE=Path(__file__).resolve().parent

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value): Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def readlines(path):
    opener=gzip.open if str(path).endswith('.gz') else open
    with opener(path,'rt') as f: return [json.loads(s) for s in f if s.strip()]
def writelines(path,rows):
    opener=gzip.open if str(path).endswith('.gz') else open
    with opener(path,'wt') as f:
        for row in rows: f.write(compact(row)+'\n')
def code_hashes(repo):
    paths=[*HERE.glob('*.py'),*HERE.glob('*.md')]
    paths += list((repo/'packages/learning-core/src/learnflow_core').rglob('*.py'))
    paths += list((repo/'backend/app').rglob('*.py'))
    return {str(p.relative_to(repo)):sha(p) for p in sorted(set(paths))}

def freeze(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    forms=readlines(args.formations);cases=readlines(args.cases)
    cases=[c for c in cases if c['split']==args.split]
    ids={c['case_id'] for c in cases};forms=[f for f in forms if f['case_id'] in ids]
    if {f['case_id'] for f in forms} != ids or len(forms)!=len(cases): raise ValueError('Formation matrix mismatch')
    index={c['case_id']:c for c in cases}; jobs=[];packets=[]
    for form in forms:
        case=index[form['case_id']]
        for key in ('request','topic','at'): form[key]=case[key]
        for budget in args.budgets:
            packet=pack(form,budget);packets.append(packet);jobs.extend(packet['jobs'])
    random.Random(20260913).shuffle(jobs)
    writelines(out/'cases.jsonl',cases);writelines(out/'formations.jsonl.gz',forms)
    writelines(out/'packets.jsonl.gz',packets);writelines(out/'jobs.jsonl',jobs)
    writelines(out/'transport.jsonl',[{k:j[k] for k in ('job_id','messages')} for j in jobs])
    from .reader import load_web_config
    model_metadata=load_web_config(args.config_repo).metadata()
    manifest={'schema':'learnflow.counterfactual-reader.v1','status':'frozen_before_scored_calls',
        'split':args.split,'created_at':datetime.now(timezone.utc).isoformat(),'case_count':len(cases),
        'paired_families':len({c['pair_id'] for c in cases}),'variants':VARIANTS,'budgets':args.budgets,
        'expected_jobs':len(jobs),'seed':20260913,'independently_unseen':False,
        'tokenizer':'cl100k_base serialized messages; proxy, not provider chat-template token count',
        'reader':{'temperature':0,'max_tokens':400,'timeout_seconds':90,'max_retries':0,'concurrency':4},
        'model_config':model_metadata,'source_hashes':code_hashes(args.repo.resolve()),'artifact_hashes':{p.name:sha(p) for p in out.iterdir() if p.is_file()},
        'full_input_jobs':sum(j['all_records_delivered'] for j in jobs),
        'canonical_equality':all(len({j['canonical_selected_sha256'] for j in p['jobs']})==1 for p in packets)}
    save(out/'manifest.json',manifest)
    print(compact({k:manifest[k] for k in ('status','case_count','paired_families','expected_jobs','full_input_jobs','canonical_equality')}))

def audit_frozen(out,repo):
    manifest=json.loads((out/'manifest.json').read_text())
    current=code_hashes(repo)
    changed=[p for p in set(current)|set(manifest['source_hashes']) if current.get(p)!=manifest['source_hashes'].get(p)]
    bad=[p for p,h in manifest['artifact_hashes'].items() if sha(out/p)!=h]
    return {'source_drift':changed,'artifact_drift':bad,'ok':not changed and not bad}

def analyze(args):
    from .verifier import score_output, derive_expected, score_pair
    out=args.output.resolve();manifest=json.loads((out/'manifest.json').read_text())
    audit=audit_frozen(out,args.repo.resolve())
    if not audit['ok']: raise ValueError('Frozen study drift; scores withheld: '+compact(audit))
    forms={f['case_id']:f for f in readlines(out/'formations.jsonl.gz')}
    cases={c['case_id']:c for c in readlines(out/'cases.jsonl')}
    jobs=readlines(out/'jobs.jsonl'); answers=readlines(out/'responses.jsonl') if (out/'responses.jsonl').exists() else []
    ans={r['job_id']:r for r in answers}
    if len(ans)!=len(answers): raise ValueError('Duplicate response IDs')
    if set(ans)-{j['job_id'] for j in jobs}: raise ValueError('Unexpected response IDs')
    ledger=readlines(out/'responses.jsonl.attempts.jsonl') if (out/'responses.jsonl.attempts.jsonl').exists() else []
    reservations={r['job_id']:r for r in ledger}
    if len(reservations)!=len(ledger):raise ValueError('Duplicate call reservations')
    rows=[]
    for job in jobs:
        reply=ans.get(job['job_id'],{}); form=forms[job['case_id']]
        if reply:
            reservation=reservations.get(job['job_id'],{})
            request_hash=digest({'messages':job['messages'],'config':manifest['model_config'],'schema':'education'})
            if (reply.get('input_sha256')!=job['input_sha256'] or reply.get('request_sha256')!=request_hash
                or reply.get('config')!=manifest['model_config'] or reservation.get('request_sha256')!=request_hash
                or reservation.get('config_sha256')!=digest(manifest['model_config'])):
                raise ValueError('Response/input/config/ledger mismatch; scores withheld')
        parsed=reply.get('parsed') if reply.get('status')=='ok' else None
        checked=score_output(parsed,form,available_event_ids=job['available_event_ids'])
        rows.append({**{k:job[k] for k in ('job_id','case_id','variant','budget','input_budget_units','all_records_delivered','selected_count','formed_count','available_event_ids')},
            'family_id':cases[job['case_id']]['family_id'],'contrast':cases[job['case_id']]['contrast'],
            'reader_status':reply.get('status','not_called'),'usage':reply.get('usage'),
            'latency_ms':reply.get('latency_ms'),'score':checked})
    writelines(out/'scored.jsonl.gz',rows)
    groups=[]
    metric_keys=('whole_record_correct','action_correct','unsupported_independent_claim','unsupported_stable_claim','false_abstention','citation_valid','citation_complete')
    for budget in manifest['budgets']:
        for variant in VARIANTS:
            group=[r for r in rows if r['budget']==budget and r['variant']==variant]
            fields=sorted({key for r in group for key in r['score'].get('field_correct',{})})
            groups.append({'budget':budget,'variant':variant,'n':len(group),
                'reader_completed':sum(r['reader_status']=='ok' for r in group),
                'all_normalized_records_delivered':sum(r['all_records_delivered'] for r in group),
                'full_input':sum(r['all_records_delivered'] for r in group),
                'available_evidence_whole_correct':sum(r['score']['available_evidence']['whole_record_correct'] for r in group),
                'available_evidence_action_correct':sum(r['score']['available_evidence']['action_correct'] for r in group),
                'required_sources_delivered':sum(r['score']['required_evidence_available_numerator'] for r in group),
                'required_sources_total':sum(r['score']['required_evidence_available_denominator'] for r in group),
                'selection_changed_reference_cases':sum(bool(r['score']['selection_changed_expected_fields']) for r in group),
                'metrics':{k:sum(r['score'].get(k) is True for r in group) for k in metric_keys},
                'fields':{k:sum(r['score'].get('field_correct',{}).get(k) is True for r in group) for k in fields}})
    pair_rows=[]; families=defaultdict(list)
    for cid,case in cases.items(): families[case['pair_id']].append(cid)
    idx={(r['case_id'],r['variant'],r['budget']):r for r in rows}
    for family,cids in sorted(families.items()):
        if len(cids)!=2: raise ValueError('Counterfactual family must contain two sides')
        a,b=sorted(cids)
        for budget in manifest['budgets']:
            for variant in VARIANTS:
                pair_rows.append({'family_id':family,'contrast':cases[a]['contrast'],'variant':variant,'budget':budget,
                    **score_pair(forms[a],forms[b],idx[a,variant,budget]['score'],idx[b,variant,budget]['score'])})
    writelines(out/'pairs.jsonl',pair_rows)
    for group in groups:
        pairs=[r for r in pair_rows if r['variant']==group['variant'] and r['budget']==group['budget']]
        group['pair_joint_success']=sum(r['joint_success'] for r in pairs)
        group['pair_denominator']=len(pairs)
    # Paired differences clustered by computing topic (8 formal topics), not 768 independent observations.
    differences=[]
    for budget in manifest['budgets']:
        for label,a,b in (('grouping_gated','five_kernel_gated','flat_gated'),('grouping_source','five_kernel_source','flat_source'),
                          ('eligibility_five','five_kernel_gated','five_kernel_source'),('eligibility_flat','flat_gated','flat_source')):
            topic_deltas=defaultdict(list)
            for cid,case in cases.items():
                topic=case['topic']['id'];topic_deltas[topic].append(int(idx[cid,a,budget]['score']['whole_record_correct'])-int(idx[cid,b,budget]['score']['whole_record_correct']))
            topic_means=[sum(v)/len(v) for v in topic_deltas.values()]
            rng=random.Random(20260913);samples=sorted(sum(rng.choices(topic_means,k=len(topic_means)))/len(topic_means) for _ in range(10000))
            differences.append({'budget':budget,'comparison':label,'a':a,'b':b,'delta':sum(topic_means)/len(topic_means),
                'topic_cluster_bootstrap_95_percentile':[samples[249],samples[9749]],'topic_clusters':len(topic_means),
                'qualification':'Exploratory author-generated topic clusters; not population inference or confirmatory significance.'})
    usage=defaultdict(int);missing_usage=0
    for reply in answers:
        if not reply.get('usage'): missing_usage+=1;continue
        for k,v in reply['usage'].items():
            if type(v) is int:usage[k]+=v
    aggregate={'schema':manifest['schema'],'split':manifest['split'],'expected_jobs':len(jobs),'actual_responses':len(answers),
        'matrix_complete':len(answers)==len(jobs),'audit':audit,'case_count':len(cases),'paired_families':len(families),
        'groups':groups,'paired_differences':differences,'usage_totals':dict(usage),'missing_usage':missing_usage,
        'reader_status_counts':{s:sum(r['reader_status']==s for r in rows) for s in sorted({r['reader_status'] for r in rows})},
        'models':sorted({str(r.get('returned_model')) for r in answers}),'requested_models':sorted({str(r.get('requested_model')) for r in answers}),
        'formation_audit':{cid:{'native_gaps':form.get('formation_gaps',[]),'independent_control_gaps':score_output(None,form)['source_audit']['formation_gaps']} for cid,form in forms.items()},
        'limitations':['Author-generated synthetic cases; no independent teacher annotation.',
          'Operational evidence/action consistency only; no student learning gain.',
          'Closed-choice formal grading; Python/SQL oracles validate authored answers, not human coding skill.',
          'Grouping test retains kernel labels and equal typed records; not full production memory versus another system.',
          'Hosted model alias and one completion per condition; weight immutability and repeat variance unmeasured.',
          'cl100k budget is a proxy; actual provider usage reported separately.']}
    save(out/'aggregate.json',aggregate)
    lines=['# 教育记忆等信息反事实实验（自动执行）','',
        f"样本 {len(cases)} 条、反事实对 {len(families)} 对；实际响应 {len(answers)}/{len(jobs)}。",'',
        '|预算单位|配置|完整输出正确|下一步正确|规范记录全入包|模型成功|','|---|---|---|---|---|---|']
    for g in groups:
        lines.append(f"|{g['budget']}|{g['variant']}|{g['metrics']['whole_record_correct']}/{g['n']}|{g['metrics']['action_correct']}/{g['n']}|{g['full_input']}/{g['n']}|{g['reader_completed']}/{g['n']}|")
    lines += ['','结果依据独立自动规则核验，不能称为教师认可、教学质量或学习增益。完整指标、错误记录及分组差值见 aggregate.json、scored.jsonl.gz 与 pairs.jsonl。',
              '',f"原始数据与代码审计：{compact(audit)}",f"实际模型用量：{compact(dict(usage))}",'']
    (out/'REPORT.md').write_text('\n'.join(lines))
    save(out/'artifact-manifest.json',{str(p.relative_to(out)):sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name!='artifact-manifest.json'})
    print(compact({'actual_responses':len(answers),'groups':groups,'audit':audit}))

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=('freeze','audit','analyze'))
    p.add_argument('--repo',type=Path,default=HERE.parents[1]);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--config-repo',type=Path,default=Path('/Users/a1-6/LearnFlow'));p.add_argument('--cases',type=Path);p.add_argument('--formations',type=Path);p.add_argument('--split',choices=('dev','formal'),default='formal')
    p.add_argument('--budgets',type=int,nargs='+',default=[2200,8000]);args=p.parse_args()
    if args.mode=='freeze':freeze(args)
    elif args.mode=='analyze':analyze(args)
    else:
        result=audit_frozen(args.output.resolve(),args.repo.resolve());print(compact(result));sys.exit(0 if result['ok'] else 1)
if __name__=='__main__':main()
