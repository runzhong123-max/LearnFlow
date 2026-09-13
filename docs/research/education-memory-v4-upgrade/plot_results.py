"""Draw fixed-sample results without inventing uncertainty or a weighted score."""
from pathlib import Path
import argparse
import json

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np

LABELS = {
    'legacy': 'Legacy', 'source': 'Source reader', 'compact': 'Compact episode',
    'bm25': 'Corpus BM25', 'hybrid': 'Hybrid', 'source_hybrid': 'Source + hybrid',
    'education_full': 'Combined', 'education_full_no_episodes': 'Combined − episodes',
    'education_full_no_paths': 'Combined − paths',
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--aggregate', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    data = json.loads(args.aggregate.read_text())
    if data.get('integrity_verified') is not True:
        raise ValueError('Refusing to plot unverified/incomplete results')
    groups = {(row['variant'], row['budget']): row for row in data['education_priority']}
    variants, budgets = list(LABELS), (1800, 3200)
    arrays = []
    for key in ('applicable_actions', 'complete_latest_conditions'):
        arrays.append(np.array([[100 * groups[(v,b)][key] / groups[(v,b)]['applicable_assessments']
                                 for b in budgets] for v in variants]))
    for key in ('topic_probe', 'raw_probe'):
        arrays.append(np.array([[100 * groups[(v,b)][key]['rate'] for b in budgets] for v in variants]))
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'svg.fonttype': 'none',
                         'axes.spines.top': False, 'axes.spines.right': False})
    colors = LinearSegmentedColormap.from_list('education', ['#f4f5f6', '#b1d1d1', '#21666e'])
    fig, axes = plt.subplots(1, 4, figsize=(10.5, 4.9), sharey=True)
    for panel, (axis, values, title) in enumerate(zip(axes, arrays, [
            'Applicable action\ncoverage', 'Structured condition\ndelivery', 'Assessment-topic\nrecall', 'Strict source-text\nrecall'])):
        axis.imshow(values, vmin=0, vmax=100, cmap=colors, aspect='auto')
        axis.set_xticks([0, 1], ['1,800', '3,200'])
        axis.set_yticks(range(len(variants)), [LABELS[v] for v in variants])
        axis.set_title(title, fontsize=9.5, pad=12)
        axis.text(-.09, 1.055, chr(97+panel), transform=axis.transAxes, weight='bold', fontsize=12)
        axis.set_xlabel('Estimated token budget', labelpad=9)
        axis.tick_params(length=0, pad=7)
        for spine in axis.spines.values():
            spine.set_visible(False)
        for i in range(len(variants)):
            for j in range(2):
                mark = '' if groups[(variants[i],budgets[j])]['admitted'] else '*'
                axis.text(j, i, f'{values[i,j]:.1f}{mark}', ha='center', va='center', fontsize=9,
                          color='white' if values[i,j] >= 72 else '#183238')
        axis.set_xticks(np.arange(-.5,2,1), minor=True)
        axis.set_yticks(np.arange(-.5,len(variants),1), minor=True)
        axis.grid(which='minor', color='white', linewidth=2)
        axis.tick_params(which='minor', length=0)
    fig.subplots_adjust(left=.20, right=.985, top=.80, bottom=.19, wspace=.27)
    fig.text(.20, .96, 'Computing education memory: measured component comparison', fontsize=12, weight='bold')
    fig.text(.20, .915, '1,584 cases · 72 families · Denominators: action 1,311 / topic 1,794 / raw 1,152 · Percent (%)', fontsize=8, color='#4f5c63')
    fig.text(.20, .055, '* Excluded by admission checks. Row order is not a ranking. See report for denominators and Pareto groups.', fontsize=7.6, color='#4f5c63')
    fig.text(.20, .020, 'Raw-probe targets have no native Fact in this input route; this column does not identify the reader effect.', fontsize=7.6, color='#4f5c63')
    args.output.mkdir(parents=True, exist_ok=True)
    for suffix in ('png', 'svg'):
        fig.savefig(args.output / ('education-comparison.'+suffix), dpi=220, facecolor='white')
    svg_path = args.output / 'education-comparison.svg'
    svg_path.write_text('\n'.join(line.rstrip() for line in svg_path.read_text().splitlines())+'\n')
    plt.close(fig)


if __name__ == '__main__':
    main()
