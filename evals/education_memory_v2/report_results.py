#!/usr/bin/env python3
"""Render selected actual metrics; no fabricated targets or pooled track score."""
import argparse
from collections import defaultdict
import gzip
import json
from pathlib import Path


def rows(path):
    with (gzip.open if path.suffix == '.gz' else open)(path, 'rt', encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def rate(values):
    valid = [v for v in values if type(v) in (bool, int, float)]
    return 'NA' if not valid else f'{sum(valid) / len(valid) * 100:.2f}% (n={len(valid)})'


def aggregate(items, numerator, denominator):
    n = sum(r['metrics'].get(numerator) or 0 for r in items)
    d = sum(r['metrics'].get(denominator) or 0 for r in items)
    return 'NA' if not d else f'{n}/{d} ({n/d*100:.2f}%)'


def render(root):
    manifest = json.loads((root / 'evidence-manifest.json').read_text())
    if not manifest.get('full_coverage_verified') or manifest.get('execution_errors'):
        raise ValueError('Only completely audited runs can produce this report; retain failure artifacts separately')
    suite = json.loads((root / 'suite.json').read_text())
    education = rows(root / 'education-trials.jsonl.gz')
    locomo = rows(root / 'locomo-trials.jsonl.gz')
    lines = ['# 教育记忆升级：实际消融结果', '',
        f"本报告从经过全量条件覆盖校验的制品生成。教育{len(education):,}条件，LoCoMo{len(locomo):,}条件；两轨分别计分。",
        '全部教育数据为合成且作者已见；教师审核pending，真实学生收益未测。LoCoMo仅验证证据检索，不是官方问答准确率。', '',
        '## 教育当前控制与历史窗口', '',
        '| 预算 | 组 | 当前10分钟落实 | 历史有效10分钟落实 | 预算正确 |',
        '| --- | --- | --- | --- | --- |']
    groups = defaultdict(list)
    for row in education:
        groups[(row['budget'], row['variant'])].append(row)
    for (budget, variant), members in sorted(groups.items()):
        current = [r['metrics'].get('actual_plan_minutes') for r in members if r.get('pattern') == 'current_input_override']
        historical = [r['metrics'].get('actual_plan_minutes') for r in members if r.get('pattern') == 'temporary_constraint_active']
        lines.append(f'| {budget} | {variant} | {rate(current)} | {rate(historical)} | {rate([r["metrics"].get("budget") for r in members])} |')
    lines += ['', '这两项检查真实plan.estimated_minutes，不能替代教学适切性或实际用时。no_memory保留当前输入控制，但不保存历史有效窗口。', '',
        '## 教育证据交付与追溯', '',
        '| 预算 | 组 | 原话逐字交付 | 题目标题交付 | episode数量 | 决策来源检查 |',
        '| --- | --- | --- | --- | --- | --- |']
    prefix = 'source_fact_evidence_delivered_'
    for (budget, variant), members in sorted(groups.items()):
        raw = aggregate(members, prefix+'raw_statement_numerator', prefix+'raw_statement_denominator')
        topic = aggregate(members, prefix+'assessment_topic_numerator', prefix+'assessment_topic_denominator')
        episodes = sum(r['metrics'].get('episode_count') or 0 for r in members)
        trace = rate([r['metrics'].get('teaching_decision_source_trace') for r in members])
        lines.append(f'| {budget} | {variant} | {raw} | {topic} | {episodes} | {trace} |')
    lines += ['', '逐字原话与题目标题是不同强度的诊断探针，不能合成教学质量分。NA意味着没有选中相应对象，不算满分。episode次数是交付量，决策引用检查是来源正确性，都不证明动作有效。', '',
        '## LoCoMo有效主类1/2/4', '',
        '| 预算 | 组 | 完整原文证据召回 | 所有证据齐备 | 预算正确 |',
        '| --- | --- | --- | --- | --- |']
    lgroups = defaultdict(list)
    for row in locomo:
        if row['category'] in (1, 2, 4) and row.get('scoring_status') == 'valid':
            lgroups[(row['budget'], row['variant'])].append(row)
    for (budget, variant), members in sorted(lgroups.items()):
        lines.append(f'| {budget} | {variant} | {rate([r["metrics"].get("full_text_recall") for r in members])} | {rate([r["metrics"].get("full_evidence_complete") for r in members])} | {rate([r["metrics"].get("budget_ok") for r in members])} |')
    lines += ['', '外部知识类3、对抗类5和无效引用保留在原始清单与分组analysis，不混入主类分母。只检索原文，无模型回答或拒答评分。', '',
        '## 组件实际激活', '',
        '| 轨道 | 预算 | 组 | BM25匹配候选之和 | alias触发之和 | fuzzy触发之和 | temporal触发之和 |',
        '| --- | --- | --- | --- | --- | --- | --- |']
    for track, rows_by_group in (('education', groups), ('locomo', lgroups)):
        for (budget, variant), members in sorted(rows_by_group.items()):
            cells = []
            for name in ('component_bm25_matched', 'component_aliases_activated', 'component_fuzzy_activated', 'component_temporal_activated'):
                values = [r['metrics'].get(name) for r in members if type(r['metrics'].get(name)) in (int, float)]
                cells.append('NA' if not values else str(sum(values)))
            lines.append(f'| {track} | {budget} | {variant} | ' + ' | '.join(cells) + ' |')
    lines += ['', '启用但未触发的组件不能从这个测试集得到贡献结论。BM25 matched是候选匹配次数；alias/fuzzy是查询归一触发；temporal是候选配额激活，均不是正确率。', '',
        '## 解释与复现边界', '',
        f"源commit：`{suite['source_commit']}`。全部逐文件SHA、CLI和数据校验记录见suite.json及evidence-manifest.json。",
        '同轨成对差值与按任务族/对话聚类的区间见education-analysis.json、locomo-analysis.json。当前报告没有合并总分，也没有从固定作者已见样本推断真实学生群体。',
        '新增episode、诊断与component policy均纳入字符预算；相同数值预算下的新旧比较同时包含增加载荷的影响。读取单组件消融共用新版形成快照，不能单独识别解析器升级贡献。',
        '完整原始packet/计划保存在本地runs制品；公开导出不包含LoCoMo对话原文。教师审核、真实学生前后测、延迟保持和迁移收益尚未执行。', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = render(args.results)
    with args.output.open('x', encoding='utf-8') as stream:
        stream.write(report)
    print(args.output)
