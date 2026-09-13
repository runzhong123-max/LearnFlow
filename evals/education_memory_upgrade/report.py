#!/usr/bin/env python3
"""Strict artifact audit and descriptive education ranking; never a teaching judge."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'evals/education_memory_v2'), str(ROOT/'scripts')]
from analyze import summary, paired_deltas
from audit_education_episode_freshness import (
    state_indexes, valid_assessment, delivered_assessments, episode_delivery, audit_condition,
    timestamp, same_id, ASSESSMENTS, PRACTICE_ACTIONS, SCOPE)

ALWAYS = ('budget', 'no_human_raw_memory', 'verify_required', 'no_premature_completion',
          'current_controls_identical', 'component_intervention')
CONDITIONAL = ('source_excerpts', 'visible_memory_scope', 'visible_event_sources',
               'episode_source_chain', 'teaching_guidance_scope_source_expiry', 'teaching_decision_source_trace')
PRIMARY = ('applicable_action_coverage', 'latest_conditions_delivered')
SECONDARY = ('topic_coverage', 'raw_statement_coverage')
PAIR_METRICS = (*PRIMARY, *SECONDARY, 'actual_plan_minutes', 'packet_token_estimate', 'latency_ms')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, obj):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(obj, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def iter_rows(path):
    path = Path(path)
    with (gzip.open if path.suffix=='.gz' else open)(path, 'rt', encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def key(row):
    return row['case_id'], row['variant'], row['budget']


def finite_tree(value):
    if isinstance(value, dict):
        return all(finite_tree(v) for v in value.values())
    if isinstance(value, list):
        return all(finite_tree(v) for v in value)
    return not isinstance(value, float) or math.isfinite(value)


def validate_matrix(rows, case_ids, variants, budgets):
    expected = {(case, variant, budget) for case in case_ids for variant in variants for budget in budgets}
    seen = set()
    for row in rows:
        identity = key(row)
        if identity in seen:
            raise ValueError(f'Duplicate condition: {identity}')
        if row.get('repeat', 0) != 0 or row.get('repetitions', 1) != 1:
            raise ValueError('This protocol requires exactly one observation per condition')
        if not isinstance(row.get('metrics'), dict) or not finite_tree(row):
            raise ValueError(f'Missing metrics or nonfinite value: {identity}')
        seen.add(identity)
    if seen != expected:
        raise ValueError(f'Incomplete condition matrix: missing={len(expected-seen)} extra={len(seen-expected)}')
    return seen


def educational_diagnostics(raw, indexes):
    """Assess coverage against source receipts even when the plan has no action.

    No product or gold imports: this reuses the frozen independent receipt audit.
    The denominator is source-defined, not conditional on retrieval success.
    """
    packet, plan = raw['packet'], raw['plan']
    current = [event for event in indexes['events'].values()
               if event.get('event_type')=='vnext_teaching_input_received' and event.get('source')=='vnext'
               and event.get('client_event_id') in (f"current-{raw['case_id']}", f"{event.get('learner_id')}:current-{raw['case_id']}")]
    if len(current) != 1 or timestamp(current[0].get('occurred_at')) is None:
        raise ValueError('Missing unique source current input receipt')
    source = current[0]
    scope = {name: source.get(name) for name in ('learner_id', *SCOPE)}
    at = timestamp(source['occurred_at'])
    eligible = {}
    exclusions = Counter()
    for event in indexes['events'].values():
        if event.get('event_type') in ASSESSMENTS:
            reference, error = valid_assessment(event, indexes, scope, at)
            if reference:
                eligible[reference['event_id']] = reference
            else:
                exclusions[error] += 1
    actions = [d for d in plan.get('teaching_decisions') or [] if d.get('action') in PRACTICE_ACTIONS]
    old_audit = audit_condition(raw, indexes)
    latest = max(eligible.values(), key=lambda e:(timestamp(e['occurred_at']),e['event_id'])) if eligible else None
    delivered, errors = delivered_assessments(packet, indexes, eligible, scope, at)
    complete_delivered=set()
    for episode in packet.get('learning_episodes') or []:
        event_ids, error=episode_delivery(episode,indexes,eligible)
        if (error is None and {'item_type','item_id','attempt_kind','canonical_item_id'} <= (episode.get('task') or {}).keys()
                and {'correct','assistance_level','independent'} <= (episode.get('outcome') or {}).keys()
                and {'learner_id',*SCOPE} <= (episode.get('scope') or {}).keys()
                and isinstance(episode.get('limitations'),list)):
            complete_delivered.update(event_ids)
    covered = (old_audit['status']=='pass'  and old_audit.get('action_differs_from_latest_assessment') is False)
    metrics = {'applicable_assessment': bool(latest),
               'applicable_action_coverage': bool(covered) if latest else None,
               'latest_conditions_delivered': latest['event_id'] in complete_delivered if latest else None,
               'stale_action_count': int(old_audit.get('stale_event_reference') is True),
               'unsupported_or_wrong_assessment_action_count': int(bool(actions) and
                    (old_audit['status'] not in ('pass','fail') or old_audit.get('action_differs_from_latest_assessment') is True)),
               'actual_assessment_action_count': len(actions),
               'time_control_action_count': sum(d.get('action')=='limit_session' for d in plan.get('teaching_decisions') or [])}
    diagnostic = {**{k:raw.get(k) for k in ('case_id','family_id','variant','budget','pattern')},
                  'applicable_assessment_count':len(eligible), 'latest_event_id': latest['event_id'] if latest else None,
                  'latest_outcome': latest['outcome'] if latest else None, 'delivered_event_ids':sorted(delivered),
                  'complete_condition_event_ids':sorted(complete_delivered),
                  'projection_errors':errors, 'excluded_assessments':dict(exclusions),
                  'freshness':old_audit, 'metrics':metrics}
    return metrics, diagnostic


def ratio(metrics, stem):
    n, d = metrics.get(stem+'_numerator'), metrics.get(stem+'_denominator')
    if type(n) is not int or type(d) is not int or not 0<=n<=d:
        raise ValueError('Missing or invalid probe numerator/denominator: '+stem)
    return n/d if d else None



def verify_probe_counts(checks, metrics):
    """Recount the unchanged scorer's raw decisions, never trust aggregate rates."""
    check=checks.get('source_fact_evidence_delivered')
    if not isinstance(check,dict) or not isinstance(check.get('actual'),list):
        raise ValueError('Missing raw source Fact probe decisions')
    probes=check['actual']
    if any(type(p.get('delivered')) is not bool for p in probes):
        raise ValueError('Invalid raw probe delivery flag')
    for kind in ('raw_statement','assessment_topic'):
        members=[p for p in probes if p.get('kind')==kind]
        stem='source_fact_evidence_delivered_'+kind
        expected={'numerator':sum(p['delivered'] for p in members),'denominator':len(members)}
        for suffix,value in expected.items():
            if type(metrics.get(stem+'_'+suffix)) is not int or metrics[stem+'_'+suffix]!=value:
                raise ValueError('Probe count differs from raw independent scorer: '+stem+'_'+suffix)


def audit_education(job, root, plan):
    folder = root/job['id']
    manifest = json.loads((folder/'manifest.json').read_text())
    if manifest.get('status')!='completed' or manifest.get('changed_sources') or manifest.get('blocked_network_attempts'):
        raise ValueError('Education execution/source/isolation failure')
    if list(iter_rows(folder/'errors.jsonl')):
        raise ValueError('Education runtime error rows retained; cannot produce a valid rank')
    trials = list(iter_rows(folder/'trials.jsonl'))
    expected = validate_matrix(trials, job['case_ids'], plan['variants'], plan['budgets'])
    indexed = {key(row):row for row in trials}
    formations, packets, checked = set(), set(), set()
    indexes = None
    active_case = None
    diagnostics = []
    for raw in iter_rows(folder/'raw.jsonl.gz'):
        if raw.get('kind')=='formation':
            active_case = raw['case_id']
            if active_case in formations:
                raise ValueError('Duplicate raw formation')
            formations.add(active_case)
            indexes = state_indexes(raw['state'])
            continue
        if raw.get('kind')=='trial':
            identity = key(raw)
            if identity in checked or identity not in indexed:
                raise ValueError('Duplicate/unexpected raw checks')
            checked.add(identity)
            checks = {c['name']:c for c in raw['checks']}
            row = indexed[identity]
            verify_probe_counts(checks,row['metrics'])
            for name in (*ALWAYS, *CONDITIONAL):
                if name not in checks or name not in row['metrics'] or row['metrics'][name] is not checks[name]['passed']:
                    raise ValueError('Missing/mismatched independent check: '+name)
                if name in CONDITIONAL and checks[name]['passed'] is None and checks[name].get('denominator')!=0:
                    raise ValueError('Unmeasured conditional check is not a valid vacuous denominator')
            continue
        if 'packet' not in raw or 'plan' not in raw:
            raise ValueError('Unknown education raw row shape')
        identity = key(raw)
        if identity in packets or identity not in indexed or active_case != raw['case_id'] or indexes is None:
            raise ValueError('Missing/duplicate/misbound packet or formation snapshot')
        packets.add(identity)
        extra, diag = educational_diagnostics(raw, indexes)
        row = indexed[identity]
        row['metrics'].update(extra)
        row['metrics']['topic_coverage'] = ratio(row['metrics'],'source_fact_evidence_delivered_assessment_topic')
        row['metrics']['raw_statement_coverage'] = ratio(row['metrics'],'source_fact_evidence_delivered_raw_statement')
        diagnostics.append(diag)
    if packets!=expected or checked!=expected or formations!=set(job['case_ids']):
        raise ValueError('Raw education coverage differs from exact matrix')
    formation_rows = list(iter_rows(folder/'formation.jsonl'))
    if len(formation_rows)!=len(formations) or {r['case_id'] for r in formation_rows}!=formations:
        raise ValueError('Formation rows do not match cases')
    formation_failures = [{'case_id':r['case_id'],'check':c['name']} for r in formation_rows for c in r.get('checks',[])
                          if c.get('passed') is False]
    # Baseline assistance equality can legitimately fail on exposure/retry; the
    # independent no-promotion safety gate remains separate and mandatory.
    authority_failures = [r for r in formation_failures if r['check'] in
                          ('no_stable_mastery','snapshot_unique_ids','attempt_event_link','fact_chain','oracle_response_grade','assistance_not_promoted')]
    return trials, diagnostics, {'formations':len(formations),'formation_failures':formation_failures,
                                'authority_failures':authority_failures, 'manifest':manifest}


def audit_locomo(job, root, plan):
    folder = root/job['id']
    manifest = json.loads((folder/'summary.json').read_text())
    if manifest.get('source_unchanged') is not True or manifest.get('source',{}).get('sha256')!=plan['locomo_sha256']:
        raise ValueError('LoCoMo source evidence missing/mismatched')
    if manifest.get('isolation',{}).get('network_attempts'):
        raise ValueError('LoCoMo network attempt')
    rows = list(iter_rows(folder/'trials.jsonl'))
    expected = validate_matrix(rows, job['case_ids'], plan['variants'], plan['budgets'])
    for row in rows:
        if row.get('scoring_status')=='execution_error_not_scored' or row.get('diagnostics',{}).get('error'):
            raise ValueError('LoCoMo execution failure cannot be omitted')
        if row['metrics'].get('budget_ok') is not True:
            raise ValueError('Missing/failed LoCoMo budget check; retain raw failure, exclude headline comparison')
        if row['metrics'].get('attribution_error_count') != 0:
            raise ValueError('LoCoMo attribution errors or missing attribution check')
        if row.get('scoring_status')=='valid' and row.get('category')!=5:
            for name in ('source_recall','full_text_recall','evidence_precision'):
                value=row['metrics'].get(name)
                if type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=1:
                    raise ValueError('Missing/invalid scored LoCoMo metric: '+name)
            if any(type(row['metrics'].get(name)) is not bool for name in ('source_complete','full_evidence_complete')):
                raise ValueError('Missing/invalid LoCoMo completeness metric')
    seen = set()
    for raw in iter_rows(folder/'packets.jsonl.gz'):
        identity = key(raw)
        if identity in seen or raw.get('repetition')!=0 or not isinstance(raw.get('packet'),dict):
            raise ValueError('Invalid/duplicate raw LoCoMo packet')
        seen.add(identity)
    if seen!=expected:
        raise ValueError('LoCoMo packet matrix differs from trials')
    return rows, manifest


def mean(rows, metric):
    values = [r['metrics'][metric] for r in rows if type(r['metrics'].get(metric)) in (bool,int,float)]
    return statistics.mean(values) if values else None


def pooled_probe(rows, kind):
    stem='source_fact_evidence_delivered_'+kind
    n=sum(r['metrics'][stem+'_numerator'] for r in rows)
    d=sum(r['metrics'][stem+'_denominator'] for r in rows)
    return {'numerator':n,'denominator':d,'rate':n/d if d else None}


def dominates(a, b):
    return all(x>=y for x,y in zip(a,b)) and any(x>y for x,y in zip(a,b))


def rank_education(rows, authority_failures=False):
    result=[]
    def assign_layers(groups, field, output):
        left=list(groups); layer=1
        while left:
            frontier=[g for g in left if not any(dominates(h[field],g[field]) for h in left)]
            for g in frontier:
                g[output]=layer
                left.remove(g)
            layer+=1
    for budget in sorted({r['budget'] for r in rows}):
        groups=[]
        for variant in sorted({r['variant'] for r in rows}):
            members=[r for r in rows if r['budget']==budget and r['variant']==variant]
            failures={name:sum(r['metrics'].get(name) is not True for r in members) for name in ALWAYS}
            failures.update({name:sum(r['metrics'].get(name) is False for r in members) for name in CONDITIONAL})
            failures['actual_plan_minutes']=sum(r['metrics'].get('actual_plan_minutes') is False for r in members)
            for name in ('stale_action_count','unsupported_or_wrong_assessment_action_count'):
                failures[name]=sum(r['metrics'].get(name,0) for r in members)
            failures['formation_authority']=int(bool(authority_failures))
            primary=tuple(mean(members,m) for m in PRIMARY)
            topic, raw=pooled_probe(members,'assessment_topic'),pooled_probe(members,'raw_statement')
            secondary=(topic['rate'],raw['rate'])
            admitted=not any(failures.values()) and all(v is not None for v in (*primary,*secondary))
            groups.append({'budget':budget,'variant':variant,'conditions':len(members),
                'admitted':admitted,'gate_failures':failures,'primary_vector':primary,'secondary_vector':secondary,
                'applicable_assessments':sum(r['metrics']['applicable_assessment'] for r in members),
                'applicable_actions':sum(r['metrics']['applicable_action_coverage'] is True for r in members),
                'complete_latest_conditions':sum(r['metrics']['latest_conditions_delivered'] is True for r in members),
                'topic_probe':topic,'raw_probe':raw,'estimated_tokens_mean':mean(members,'packet_token_estimate'),
                'latency_ms_mean':mean(members,'latency_ms'),'priority_layer':None,'secondary_layer':None})
        admitted_groups=[g for g in groups if g['admitted']]
        assign_layers(admitted_groups, 'primary_vector', 'priority_layer')
        equal_primary=defaultdict(list)
        for g in admitted_groups:
            equal_primary[g['primary_vector']].append(g)
        for peers in equal_primary.values():
            assign_layers(peers, 'secondary_vector', 'secondary_layer')
        result.extend(groups)
    return result


def pair_report(rows, track, bootstrap):
    primary=[r for r in rows if track=='education' or r.get('category') in (1,2,4) and r.get('scoring_status')=='valid']
    metrics=PAIR_METRICS if track=='education' else ('full_text_recall','full_evidence_complete','source_recall','latency_ms','tokens_estimate')
    out=[]
    for baseline, comparisons in [('education_full', None),('legacy',{'source','compact','bm25','hybrid'})]:
        chosen=[{**r,'variant':'full' if r['variant']==baseline else r['variant'],
                 'metrics':{m:r['metrics'].get(m) for m in metrics}}
                for r in primary if r['variant']==baseline or (r['variant']!='education_full' and (comparisons is None or r['variant'] in comparisons))]
        if not any(r['variant']=='full' for r in chosen):
            continue
        for item in paired_deltas(chosen,'family_id' if track=='education' else 'conversation_id',bootstrap):
            item['comparison']=item['comparison'].replace('full-minus-',baseline+'-minus-',1)
            out.append(item)
    return out


def render(aggregate):
    lines=['# 教育记忆只读索引升级：实际结果','',
           '仅从完整冻结矩阵与实际保存的 packet/plan 生成。教育合成数据与标签均作者已见，教师盲评 pending；本报告不测教学有效性或学生收益。',
           f"教育 {aggregate['conditions']['education']} 条件；LoCoMo {aggregate['conditions']['locomo']} 条件。两轨、两个预算分别解释。",'',
           '## 教育描述性优先组','',
           '| 预算 | 配置 | 准入 | 一级层 | 二级层 | 适用动作 | 结构条件交付 | 主题探针 | 原文探针 | 估计单位均值 | 毫秒均值 |',
           '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    def probe(x):return f"{x['numerator']}/{x['denominator']}"
    def num(v):return 'NA' if v is None else f'{v:.2f}'
    for g in sorted(aggregate['education_priority'],key=lambda g:(g['budget'],not g['admitted'],g['priority_layer'] or 999,g['secondary_layer'] or 999,g['variant'])):
        lines.append(f"| {g['budget']} | {g['variant']} | {'通过' if g['admitted'] else '不进入排序'} | {g['priority_layer'] or 'NA'} | {g['secondary_layer'] or 'NA'} | {g['applicable_actions']}/{g['applicable_assessments']} | {g['complete_latest_conditions']}/{g['applicable_assessments']} | {probe(g['topic_probe'])} | {probe(g['raw_probe'])} | {num(g['estimated_tokens_mean'])} | {num(g['latency_ms_mean'])} |")
    lines += ['', '一级是动作与完整条件覆盖的 Pareto 层；二级仅在一级向量完全相同时比较主题和原文探针。权衡和同值保留并列，名称顺序没有质量含义；这不是显著性排名。具体准入失败计数见 aggregate.json。',
              '动作覆盖分母来自形成快照中的最新适用评估；无动作不会从该分母消失。可独立验证的结构化条件交付仅覆盖当前 schema 的 episode 字段核验。合法 guidance 可支持动作，未达到此完整字段标准；这不意味着普通事实文本不能表达相同条件，也不意味着其他教育系统只能使用 episode。','',
              '## LoCoMo 辅助轨','', '| 预算 | 配置 | 主类原文召回均值 | 完整证据比例 | 主类问题数 |', '| --- | --- | --- | --- | --- |']
    for group in aggregate['locomo_primary']:
        m=group['metrics']
        lines.append(f"| {group['budget']} | {group['variant']} | {num(m['full_text_recall']['mean'])} | {num(m['full_evidence_complete']['mean'])} | {group['conditions']} |")
    lines += ['', '主类限定有效标注的 1/2/4 类。类别3、5与无效标注完整保留于分组制品；没有模型回答、拒答评分或官方 QA 准确率。LoCoMo 不参与教育优先组排序。','',
              '## 可核查范围与不确定性','',aggregate['timing_caveat'],
              'paired_cluster_deltas 记录同条件配对差及按任务族/对话聚类的95%描述性区间；不是学习者总体推断，不采用“所有指标均显著提升”等表述。',
              'source 同时扩大 SQL 候选扫描至4096，并增加原文来源解析与元数据，source−legacy 是组合读方案效应。source_hybrid 与 hybrid 共同扩大候选，更接近来源投影差异，仍包含元数据预算成本；LoCoMo没有Fact时亦不能把source视为纯未激活负控制。',
              'no_paths 仅关闭关系路径，不关闭独立概念附件；LoCoMo没有原生评估、Module/Claim或边。未激活组件无法从相同分数推断贡献。',
              '本轮没有五核逐核完整消融、等证据平面表示对照、未见任务族或完整图能力评测。结构安全门不等于全部隐私与语义泄露防御已验证。',
              f"冻结源 commit：`{aggregate['source_commit']}`；逐源SHA、参数、raw制品与制品hash见 suite.json、artifact-manifest.json。",'']
    return '\n'.join(lines)



def model_execution_audit(rows, expected_identity, variants):
    def snapshots(value):
        if isinstance(value,dict):
            if 'semantic_model_sha256' in value:
                yield value
            for child in value.values():
                yield from snapshots(child)
        elif isinstance(value,list):
            for child in value:
                yield from snapshots(child)
    by_group=defaultdict(lambda:{'conditions':0,'model_identity_conditions':0,'semantic_used_conditions':0,'identities':Counter()})
    for row in rows:
        group=by_group[(row['budget'],row['variant'])];group['conditions']+=1
        observed=list(snapshots(row.get('component_diagnostics') or {}))
        if observed:
            group['model_identity_conditions']+=1
            group['semantic_used_conditions']+=int(any(s.get('semantic_used') is True for s in observed))
        for item in observed:
            identifier=item.get('semantic_model_sha256')
            if identifier!=expected_identity:
                raise ValueError('Actual semantic model identity differs from the frozen identity')
            group['identities'][identifier]+=1
    for (budget,variant),group in by_group.items():
        if variant in variants and not group['semantic_used_conditions']:
            raise ValueError('Declared hybrid group has no verified actual semantic execution')
    return [{'budget':budget,'variant':variant,**group,'identities':dict(group['identities'])}
            for (budget,variant),group in sorted(by_group.items())]


def audit_and_report(root, bootstrap=2000):
    root=Path(root)
    plan=json.loads((root/'suite.json').read_text())
    if plan.get('schema')!='learnflow-memory-upgrade.v1' or plan.get('status')!='completed' or plan.get('source_drift'):
        raise ValueError('Only a completed source-stable frozen run can be reported')
    if plan.get('model_source_unchanged') is not True:
        raise ValueError('Model source files changed or were not audited')
    if not plan.get('source_hashes') or any(j.get('exit_code')!=0 for j in plan['jobs']):
        raise ValueError('Missing frozen sources or failed job')
    if sha(root/'PROTOCOL.md')!=plan['source_hashes'].get('evals/education_memory_upgrade/PROTOCOL.md'):
        raise ValueError('Frozen protocol mismatch')
    for track,count in (('education',1584),('locomo',1986)):
        ids=[case for job in plan['jobs'] if job['track']==track for case in job['case_ids']]
        if len(ids)!=count or len(set(ids))!=count:
            raise ValueError('Formal report requires the entire frozen corpus: '+track)
    all_rows={'education':[],'locomo':[]}; diagnostics=[]; audits=[]
    for job in plan['jobs']:
        if job['track']=='education':
            rows, diag, audit=audit_education(job,root,plan);diagnostics.extend(diag)
            manifest=audit.pop('manifest');audits.append({'job':job['id'],**audit})
        else:
            rows,manifest=audit_locomo(job,root,plan)
        # Child hashes can use absolute paths; compare every matching frozen path.
        child=manifest.get('source_hashes') or {}
        if not child:
            raise ValueError('Missing child source hashes')
        matched=0
        for rel, digest in plan['source_hashes'].items():
            values=[value for name,value in child.items() if name==rel or name.endswith('/'+rel)]
            if values:
                matched+=1
                if any(value!=digest for value in values):
                    raise ValueError('Child source differs from suite freeze: '+rel)
        required=[rel for rel in plan['source_hashes'] if rel.startswith(('packages/learning-core/src/learnflow_core/','backend/app/')) and rel.endswith('.py')]
        for rel in required:
            if not any(name==rel or name.endswith('/'+rel) for name in child):
                raise ValueError('Missing child product source hash: '+rel)
        for rel,digest in plan['source_hashes'].items():
            if rel.startswith('evals/education_memory_v2/') and '/' not in rel[len('evals/education_memory_v2/'):] and rel.endswith('.py'):
                values=[value for name,value in child.items() if name==rel or name.endswith('/'+rel) or name=='driver:'+Path(rel).name]
                if not values or any(v!=digest for v in values):
                    raise ValueError('Missing/mismatched child driver hash: '+rel)
        if not matched:
            raise ValueError('Child/source manifest intersection is empty')
        all_rows[job['track']].extend(rows)
    for track,rows in all_rows.items():
        ids=[case for j in plan['jobs'] if j['track']==track for case in j['case_ids']]
        if len(ids)!=len(set(ids)):
            raise ValueError('Overlapping shards')
        validate_matrix(rows,ids,plan['variants'],plan['budgets'])
        if len(rows)!=plan['conditions_expected'][track]:
            raise ValueError('Condition total differs from frozen plan')
    # Applicability must be invariant across read configurations and budgets.
    cases=defaultdict(set)
    for row in all_rows['education']:
        cases[row['case_id']].add((row['metrics']['applicable_assessment'],
                                  row['metrics']['source_fact_evidence_delivered_assessment_topic_denominator'],
                                  row['metrics']['source_fact_evidence_delivered_raw_statement_denominator']))
    if any(len(values)!=1 for values in cases.values()):
        raise ValueError('Read variant changed source-defined applicability or probe denominator')
    hybrid_variants={v for v,changes in plan['preset_overrides'].items() if changes.get('candidate_mode')=='hybrid'}
    model_audits={track:model_execution_audit(rows,(plan.get('semantic_model') or {}).get('expected_runtime_identity'),hybrid_variants)
                  for track,rows in all_rows.items()}
    primary=[r for r in all_rows['locomo'] if r.get('category') in (1,2,4) and r.get('scoring_status')=='valid']
    result={'schema':'learnflow-memory-upgrade-analysis.v1','source_commit':plan['source_commit'],
            'conditions':{track:len(rows) for track,rows in all_rows.items()},'integrity_verified':True,
            'semantic_model':plan.get('semantic_model'),'semantic_execution_audit':model_audits,
            'education_priority':rank_education(all_rows['education'],any(a['authority_failures'] for a in audits)),
            'education_formation_audit':audits,'education_by_pattern':summary(all_rows['education'],['budget','variant','pattern']),
            'locomo_primary':summary(primary,['budget','variant']),
            'locomo_all_categories':summary(all_rows['locomo'],['budget','variant','category','scoring_status']),
            'paired_cluster_deltas':{track:pair_report(rows,track,bootstrap) for track,rows in all_rows.items()},
            'timing_caveat':plan['timing_caveat'],'teacher_review':'pending','no_pooled_track_score':True}
    for track,rows in all_rows.items():
        with gzip.open(root/(track+'-trials.jsonl.gz'),'xt',encoding='utf-8') as stream:
            for row in rows:stream.write(json.dumps(row,ensure_ascii=False,allow_nan=False)+'\n')
    with gzip.open(root/'education-diagnostics.jsonl.gz','xt',encoding='utf-8') as stream:
        for row in diagnostics:stream.write(json.dumps(row,ensure_ascii=False,allow_nan=False)+'\n')
    write(root/'aggregate.json',result)
    with (root/'REPORT.md').open('x',encoding='utf-8') as stream:stream.write(render(result))
    artifacts={str(p.relative_to(root)):sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
    write(root/'artifact-manifest.json',{'schema':'learnflow-memory-upgrade-artifacts.v1','integrity_verified':True,
          'files':artifacts,'conditions':result['conditions'],'source_hashes':plan['source_hashes']})
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results',type=Path,required=True)
    parser.add_argument('--bootstrap',type=int,default=2000)
    args=parser.parse_args()
    if args.bootstrap<100:parser.error('bootstrap must be >=100')
    audit_and_report(args.results,args.bootstrap)
