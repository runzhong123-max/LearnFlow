"""Publication-friendly plots from actual audited aggregate; no invented points."""
import argparse
import json
import os
from pathlib import Path
os.environ.setdefault('MPLCONFIGDIR','/tmp/learnflow-counterfactual-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

p=argparse.ArgumentParser();p.add_argument('--aggregate',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
r=json.loads(a.aggregate.read_text())
assert r['matrix_complete'] and r['audit']['ok']
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':9,'axes.titlesize':10,'axes.labelsize':9,
 'axes.spines.top':False,'axes.spines.right':False,'pdf.fonttype':42,'svg.fonttype':'none','figure.dpi':180})
variants=['five_kernel_gated','flat_gated','five_kernel_source','flat_source']
labels=['Five kernels\n+ eligibility','Flat\n+ eligibility','Five kernels\nsource only','Flat\nsource only']
colors=['#2F6B94','#68A197'];budgets=[2200,8000]
index={(g['variant'],g['budget']):g for g in r['groups']}
fig,axes=plt.subplots(1,2,figsize=(9.2,3.5),layout='constrained')
for panel,(ax,title,field,denom) in enumerate(zip(axes,['Complete output consistency','Counterfactual pair success'],['whole_record_correct','pair_joint_success'],['n','pair_denominator'])):
 for pos,b in enumerate(budgets):
  nums=[index[v,b]['metrics'][field] if field=='whole_record_correct' else index[v,b][field] for v in variants]
  ds=[index[v,b][denom] for v in variants];ys=[n/d*100 for n,d in zip(nums,ds)]
  xs=np.arange(4)+(pos-.5)*.36;ax.bar(xs,ys,width=.33,color=colors[pos],label=f'{b:,} budget units',zorder=3)
  for x,y,n,d in zip(xs,ys,nums,ds):ax.text(x,y+1.5,f'{n}/{d}',ha='center',fontsize=7)
 ax.set(xticks=np.arange(4),xticklabels=labels,ylim=(0,108),yticks=[0,25,50,75,100],ylabel='Success (%)',title=title)
 ax.grid(axis='y',color='#E1E5E8',linewidth=.5,zorder=0);ax.text(-.12,1.04,chr(65+panel),transform=ax.transAxes,fontweight='bold',fontsize=12)
axes[0].legend(frameon=False,loc='upper center',bbox_to_anchor=(.52,-.21),ncol=2,fontsize=8)
a.output.mkdir(parents=True,exist_ok=True)
for ext in ('svg','pdf','png'):fig.savefig(a.output/f'consistency.{ext}',bbox_inches='tight',dpi=300)
plt.close(fig)
fig,ax=plt.subplots(figsize=(6.3,3.4),layout='constrained')
rows=r['paired_differences'];y=np.arange(len(rows))[::-1]
for yy,row in zip(y,rows):
 delta=row['delta']*100;lo,hi=[x*100 for x in row['topic_cluster_bootstrap_95_percentile']]
 ax.errorbar(delta,yy,xerr=[[max(0,delta-lo)],[max(0,hi-delta)]],fmt='o',color=colors[budgets.index(row['budget'])],markersize=4,capsize=3,lw=1)
ax.set(yticks=y,yticklabels=[f"{row['comparison'].replace('_',' ')} | {row['budget']}" for row in rows],xlabel='Paired difference in complete consistency (percentage points)')
ax.axvline(0,color='#666666',lw=.8,ls='--');ax.grid(axis='x',color='#E1E5E8',lw=.5)
for ext in ('svg','pdf','png'):fig.savefig(a.output/f'paired-effects.{ext}',bbox_inches='tight',dpi=300)
plt.close(fig)
for svg in a.output.glob('*.svg'):
 svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
print(json.dumps({'figures':6,'source':str(a.aggregate),'actual_responses':r['actual_responses']}))
