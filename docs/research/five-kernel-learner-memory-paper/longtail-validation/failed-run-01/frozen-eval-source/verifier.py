"""Independent standard-library verifier for native long-history retrieval. Derived from source-probe verifier; no product imports."""
import hashlib
import json
import math

FIELDS = ('enable_episodes','max_episodes','max_episode_facts','enable_bm25','enable_aliases',
          'enable_fuzzy','enable_temporal','enable_summary_boost','enable_source_text',
          'enable_compact_episodes','candidate_mode')
SCOPE = ('project_id','checkpoint_id','session_id')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def budget_body(packet):
    return {'heads':packet.get('kernel_heads',{}),'items':packet.get('items',[]),
        'paths':packet.get('relation_paths',[]),'personal_concept_graph':packet.get('personal_concept_graph',{}),
        'adaptation_directives':packet.get('adaptation_directives',[]),
        'teaching_guidance':packet.get('teaching_guidance',[]),'learning_episodes':packet.get('learning_episodes',[]),
        'retrieval_diagnostics':packet.get('retrieval_diagnostics',{}),
        'component_policy':{key:packet.get('manifest',{}).get('policy',{}).get(key) for key in FIELDS}}


def estimate(packet):
    return max(1,math.ceil(len(json.dumps(budget_body(packet),ensure_ascii=False,sort_keys=True,default=str))/3.2))


def indexes(snapshot):
    result={}
    for name,rows in snapshot.items():
        key='node_id' if name=='facts' else 'id'
        result[name]={row[key]:row for row in rows}
        if len(result[name])!=len(rows):raise ValueError('duplicate_snapshot_id:'+name)
    return result


def native_chain(idx, node_id, request_scope):
    errors=[]
    node=idx['nodes'].get(node_id);fact=idx['facts'].get(node_id)
    if not node or not fact:return None,['missing_node_or_fact']
    event=idx['events'].get(fact.get('source_event_id'));mutation=idx['mutations'].get(fact.get('source_mutation_id'))
    if not event or not mutation:return None,['missing_event_or_mutation']
    if node.get('learner_id')!=request_scope['learner_id'] or event.get('learner_id')!=request_scope['learner_id'] or mutation.get('learner_id')!=request_scope['learner_id']:
        errors.append('learner_mismatch')
    for key in SCOPE:
        if any(row.get(key)!=request_scope[key] for row in (node,fact,event)):errors.append('scope_mismatch:'+key)
    if node.get('node_type')!='fact' or node.get('kernel_name')!='knowledge' or node.get('status')!='active':errors.append('node_not_active_knowledge_fact')
    project=idx['projects'].get(event.get('project_id'));checkpoint=idx['checkpoints'].get(event.get('checkpoint_id'));session=idx['sessions'].get(event.get('session_id'))
    roadmap=idx['roadmaps'].get(checkpoint.get('roadmap_id')) if checkpoint else None
    if not project or project.get('learner_id')!=request_scope['learner_id'] or project.get('visibility')=='deleted':errors.append('project_not_owned')
    if not checkpoint or checkpoint.get('archived') or not roadmap or roadmap.get('project_id')!=event.get('project_id'):errors.append('checkpoint_not_owned')
    if not session or session.get('learner_id')!=request_scope['learner_id'] or session.get('project_id')!=event.get('project_id') or session.get('checkpoint_id')!=event.get('checkpoint_id'):errors.append('session_not_owned')
    if mutation.get('status')!='applied' or mutation.get('event_id')!=event['id'] or mutation.get('kernel_name')!='knowledge':errors.append('mutation_link')
    if not isinstance(mutation.get('before_version'),int) or mutation.get('after_version')!=mutation['before_version']+1:errors.append('mutation_version')
    states=[s for s in idx['states'].values() if s.get('learner_id')==event.get('learner_id') and s.get('kernel_name')=='knowledge']
    if len(states)!=1 or states[0].get('version',0)<mutation.get('after_version',0):errors.append('state_version_does_not_cover_mutation')
    predicate=fact.get('predicate','')
    if predicate not in ('short_term.pending_question','short_term.knowledge_gap'):errors.append('unreviewed_predicate')
    scope,key=predicate.split('.',1) if '.' in predicate else ('','')
    # This probe allows only the two-key native user_message patch.  JSON
    # object ordering can change when snapshots are saved with sort_keys;
    # the reviewed reducer's declared ordinal order is explicit here.
    patch=mutation.get('patch') or {};short=patch.get('short_term') or {}
    ordered_keys=('pending_question','knowledge_gap')
    if set(short)!=set(ordered_keys) or patch.get('long_term'):errors.append('unexpected_native_patch')
    pairs=[('short_term',k,short.get(k)) for k in ordered_keys]
    ordinal=fact.get('fact_ordinal')
    if type(ordinal) is not int or ordinal<0 or ordinal>=len(pairs) or pairs[ordinal]!=(scope,key,fact.get('object_value')):errors.append('ordinal_patch_value')
    if fact.get('consumption_status')!='eligible':errors.append('ineligible_fact')
    if event.get('event_type')!='user_message' or event.get('source')!='user' or not isinstance(fact.get('object_value'),str) or fact['object_value']!=(event.get('payload') or {}).get('text'):errors.append('raw_event_value')
    payload=node.get('payload') or {}
    if payload.get('scope')!=scope or payload.get('key')!=key or payload.get('event_type')!=event.get('event_type'):errors.append('node_metadata')
    if node.get('occurred_at')!=event.get('occurred_at'):errors.append('node_event_time')
    return (node,fact,event,mutation),errors


def excerpt_error(text, metadata, original):
    if not isinstance(text,str) or not isinstance(metadata,dict) or not isinstance(original,str):return ['source_shape']
    spans=metadata.get('ranges')
    if not isinstance(spans,list) or not spans:return ['empty_ranges']
    previous=-1
    for pair in spans:
        if not isinstance(pair,list) or len(pair)!=2 or any(type(x) is not int for x in pair) or not 0<=pair[0]<pair[1]<=len(original) or pair[0]<previous:return ['invalid_ranges']
        previous=pair[1]
    errors=[]
    if metadata.get('sha256')!=digest(original) or metadata.get('chars')!=len(original):errors.append('source_hash_length')
    if text!=' … '.join(original[a:b] for a,b in spans):errors.append('source_reconstruction')
    return errors


def valid_item(idx, item, scope):
    chain,bad=native_chain(idx,item.get('id'),scope)
    if not chain:return None,bad
    node,fact,event,mutation=chain
    metadata=item.get('detail',{}).get('source_text',{})
    kind=metadata.get('source_kind','node_text')
    if kind=='node_text':original=node['text']
    elif kind=='fact_object_value' and metadata.get('source_path')=='/object_value':
        original=fact['object_value']
        if metadata.get('source_event_id')!=event['id'] or metadata.get('source_mutation_id')!=mutation['id']:bad.append('declared_source_ids')
    else:original=None;bad.append('unreviewed_source_kind_path')
    bad.extend(excerpt_error(item.get('text'),metadata,original))
    if item.get('detail',{}).get('source_event_id')!=event['id'] or item.get('evidence_refs')!=[event['id']]:bad.append('item_event_binding')
    if any(item.get('scope',{}).get(k)!=scope[k] for k in SCOPE):bad.append('item_scope')
    return chain,bad


def has_evidence_body(packet):
    """Strict returned-body check independent of target/gold matches.

    Navigation ids/empty metadata are not semantic bodies. Any item, path,
    episode, guidance, adaptation or concept node counts as nonempty.
    """
    if any(packet.get(key) for key in ('items','relation_paths','learning_episodes','teaching_guidance','adaptation_directives')):return True
    for name,head in packet.get('kernel_heads',{}).items():
        if name!='human' and str(head.get('summary','')).strip():return True
        if name=='human' and (str(head.get('summary','')).strip() or (head.get('facets') or {}).get('states')):return True
    graph=packet.get('personal_concept_graph') or {}
    # Public graph schema is expected to contain nodes; unknown nonempty graph
    # bodies are counted conservatively as evidence instead of ignored.
    if graph.get('nodes') or graph.get('edges'):return True
    return any(graph.get(k) for k in ('concepts','items','summary','text','facts'))


def audit_formation(snapshot, operations, scope):
    idx=indexes(snapshot);errors=[];receipts=[]
    for op in operations:
        event=idx['events'].get(op['event_id'])
        if not event or event.get('payload',{}).get('text')!=op['text']:errors.append('event_text_not_bound:'+op['id'])
        ids=[fid for fid,f in idx['facts'].items() if f.get('source_event_id')==op['event_id']]
        if len(ids)!=2:errors.append('expected_two_native_facts:'+op['id'])
        retained=False
        for fid in ids:
            chain,bad=native_chain(idx,fid,op['scope']);errors.extend(op['id']+':'+b for b in bad)
            if chain and chain[1]['object_value']!=op['text']:errors.append('fact_original_differs:'+op['id'])
        state=next((s for s in idx['states'].values() if s.get('learner_id')==op['scope']['learner_id'] and s.get('kernel_name')=='knowledge'),{})
        retained=op['event_id'] in state.get('evidence_refs',[]) and any(r.get('event_id')==op['event_id'] for r in state.get('action_chain',[]))
        receipts.append({'operation_id':op['id'],'event_id':op['event_id'],'fact_ids':ids,'current_state_receipt_retained':retained})
    # Complete persisted mutation sequence is stronger than requiring every
    # old source to survive the current state's intentionally bounded rings.
    for learner in {op['scope']['learner_id'] for op in operations}:
        mutations=sorted((m for m in idx['mutations'].values() if m.get('learner_id')==learner and m.get('kernel_name')=='knowledge'),key=lambda m:m['after_version'])
        if [m['after_version'] for m in mutations]!=list(range(2,len(mutations)+2)):errors.append('mutation_sequence_gap')
        state=next((s for s in idx['states'].values() if s.get('learner_id')==learner and s.get('kernel_name')=='knowledge'),{})
        if state.get('version')!=len(mutations)+1:errors.append('state_final_version')
    if any(f.get('evidence_grade')!='self_reported' for f in idx['facts'].values()):errors.append('unexpected_evidence_upgrade')
    if snapshot.get('attempts') or snapshot.get('modules') or snapshot.get('claims'):errors.append('unexpected_assessment_or_consolidation')
    if any(s.get('long_term') for s in idx['states'].values()):errors.append('unexpected_longterm_state')
    return {'checks_passed':not errors,'errors':errors,'receipts':receipts,'event_count':len(idx['events']),'fact_count':len(idx['facts']),
            'kernel_counts':{k:sum(n.get('kernel_name')==k for n in idx['nodes'].values()) for k in ('structure','knowledge','human','value','practice')}}


def verify(question, snapshot, packet, scope, target_event_id, metadata_calls, budget, foreign_markers):
    idx=indexes(snapshot);errors=[]
    expected={n['id'] for n in snapshot['nodes'] if n.get('learner_id')==scope['learner_id'] and n.get('kernel_name')=='knowledge' and n.get('status')=='active' and all(n.get(k)==scope[k] for k in SCOPE)}
    target_ids={fid for fid,f in idx['facts'].items() if target_event_id is not None and f.get('source_event_id')==target_event_id}
    count=packet.get('omitted',{}).get('candidate_count')
    candidates=[sorted(set(call)) for call in metadata_calls if len(set(call))==count]
    if candidates and all(call==candidates[0] for call in candidates):
        candidate_ids=candidates[0]
        if not set(candidate_ids)<=expected:errors.append('candidate_scope')
    else:candidate_ids=[];errors.append('candidate_trace_unresolved')
    for head in packet.get('kernel_heads',{}).values():
        for name in ('focus_refs','alert_refs','working_refs','stable_refs'):
            if any(ref not in expected for ref in head.get(name,[])):errors.append('head_scope:'+name)
    if any(marker in json.dumps(packet,ensure_ascii=False) for marker in foreign_markers):errors.append('foreign_text_marker')
    hits=[];valid_items=[]
    for item in packet.get('items',[]):
        chain,bad=valid_item(idx,item,scope)
        errors.extend('item:'+str(item.get('id'))+':'+e for e in bad)
        if chain and not bad:
            node,fact,event,mutation=chain;valid_items.append((item,event))
            if event['id']==target_event_id:
                hits.append({'fact_id':item['id'],'term':all(term in item['text'] for term in question['required_terms']),
                    'qualifier':question['qualifier'] in item['text'],'source_kind':item['detail']['source_text'].get('source_kind','node_text')})
    # This native text fixture has no graph/assessment producers. Nonempty
    # alternate bodies are an integrity surprise, not silently ignored.
    graph=packet.get('personal_concept_graph') or {}
    if packet.get('relation_paths') or packet.get('learning_episodes') or graph.get('nodes') or graph.get('edges'):
        errors.append('unexpected_nontext_projection')
    actual=estimate(packet)
    if packet.get('manifest',{}).get('token_estimate')!=actual or actual>budget:errors.append('budget')
    empty=not has_evidence_body(packet)
    first_target=(valid_items[0][1]['id']==target_event_id) if valid_items and target_event_id is not None else False
    metrics={'target_in_candidate':bool(target_ids & set(candidate_ids)) if target_event_id is not None else None,
             'target_fact_delivered':bool(hits) if target_event_id is not None else None,
             'term_delivered':any(h['term'] for h in hits) if target_event_id is not None else None,
             'qualifier_delivered':any(h['qualifier'] for h in hits) if target_event_id is not None else None,
             'joint_term_qualifier_delivered':any(h['term'] and h['qualifier'] for h in hits) if target_event_id is not None else None,
             'first_item_is_target':first_target if question.get('temporal') else None,
             'strict_empty_on_uncovered':empty if question.get('negative') else None,
             'budget_ok':actual<=budget,'source_scope_ok':not errors,'token_estimate':actual,
             'selected_items':len(packet.get('items',[])),'candidate_count':count}
    return {'checks_passed':not errors,'errors':errors,'target_fact_ids':sorted(target_ids),
            'candidate_pool_ids':candidate_ids,'candidate_trace_verified':not any(e.startswith('candidate_') for e in errors),
            'valid_target_items':hits,'evidence_body_empty':empty,'metrics':metrics}
