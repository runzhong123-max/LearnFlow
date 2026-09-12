"""Read-only re-tabulation of preserved formal-03; no product or evaluation run."""
from pathlib import Path
import collections, gzip, hashlib, json
repo=Path(__file__).resolve().parents[3]
root=repo/'evals/education_memory_v2/runs/formal-03'
assert len(list(root.glob('education-*/formation.jsonl')))==4, 'Requires the four retained local detailed formation shards'
assert len(list(root.glob('education-*/raw.jsonl.gz')))==4, 'Requires the four retained local detailed raw shards'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
gaps={}; meta={}; source_hashes={}; gap_kinds=collections.Counter(); operations=collections.Counter()
for p in sorted(root.glob('education-*/formation.jsonl')):
 source_hashes[str(p.relative_to(repo))]=sha(p)
 for line in p.open():
  row=json.loads(line); cid=row['case_id']; gaps[cid]=row.get('formation_delivery_gaps',[])
  meta[cid]={'pattern':row['pattern'],'operations':row['operations']}
  for gap in gaps[cid]:
   gap_kinds[(gap['kind'],gap['reason'])]+=1
   op=next(x for x in row['operations'] if gap['source_event_id'] in x.get('event_ids',[]))
   operations[(op['kind'],op['status'])]+=1
counts=collections.Counter(); kernels=collections.Counter(); examples={}; noep=collections.defaultdict(collections.Counter); guides=collections.defaultdict(collections.Counter)
for p in sorted(root.glob('education-*/raw.jsonl.gz')):
 source_hashes[str(p.relative_to(repo))]=sha(p)
 with gzip.open(p,'rt') as stream:
  for line in stream:
   row=json.loads(line)
   if row.get('kind')=='formation':
    cid=row['case_id']; state=row['state']
    for gap in gaps[cid]:
     eid=gap['source_event_id']; events=[e for e in state['events'] if e['id']==eid]
     assert len(events)==1
     event=events[0]; mutations=[m for m in state['mutations'] if m['event_id']==eid]
     facts=[f for f in state['facts'] if f['event_id']==eid]
     assert not facts
     category='has_mutation_no_fact' if mutations else 'no_mutation'
     counts[category]+=1
     kernels[(category,','.join(sorted({m['kernel'] for m in mutations})) or 'none')]+=1
     if category not in examples:
      op=next(x for x in meta[cid]['operations'] if eid in x.get('event_ids',[]))
      examples[category]={'case_id':cid,'pattern':meta[cid]['pattern'],'event_id':eid,'event_type':event['event_type'],'payload_field_types':{k:type(v).__name__ for k,v in event['payload'].items()},'input_characters':len(event['payload'].get('text','')),'operation_kind':op['kind'],'operation_status':op['status'],'mutation_rows':mutations,'fact_count':len(facts)}
   elif row.get('variant')=='no_episodes' and 'packet' in row and 'plan' in row:
    b=row['budget']; noep[b]['conditions']+=1;noep[b]['episode_count']+=len(row['packet'].get('learning_episodes') or [])
    for d in row['plan'].get('teaching_decisions') or []:noep[b]['action:'+d['action']]+=1
    for g in row['packet'].get('teaching_guidance') or []:guides[b][(g.get('kernel'),g.get('slot'),g.get('evidence_kind'))]+=1
assert len(gaps)==1584 and sum(counts.values())==1152
assert counts=={'has_mutation_no_fact':430,'no_mutation':722}
assert all(v['conditions']==1584 and v['action:limit_session']==144 for v in noep.values())
summary={'kind':'posthoc_read_only_retabulation_not_new_experiment','source_run':'formal-03','formation_cases':len(gaps),'raw_target_gap_counts':{' / '.join(k):v for k,v in gap_kinds.items()},'source_operation_counts':{' / '.join(k):v for k,v in operations.items()},'event_projection_counts':dict(counts),'kernel_sets':{' / '.join(k):v for k,v in kernels.items()},'examples_without_raw_text':examples,'no_episodes_actual_plans':{b:dict(v) for b,v in noep.items()},'no_episodes_guidance':{b:{' / '.join(str(x) for x in k):v for k,v in g.items()} for b,g in guides.items()},'raw_source_sha256':source_hashes,'script_sha256':sha(Path(__file__)),'limitations':['722 no-mutation targets are not individually semantically adjudicated; no-mutation alone does not prove parser failure.','430 mutation-without-Fact targets do not establish a new memory failure; product excludes teaching control keys from Fact synthesis.','Targets can repeat source-like language across distinct synthetic cases; count is expected evidence instances, not unique learners or statements.','No runtime, original scoring, gold or product files changed.']}
print(json.dumps(summary,ensure_ascii=False,indent=2))
