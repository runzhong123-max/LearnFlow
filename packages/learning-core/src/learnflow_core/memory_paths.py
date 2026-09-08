"""Bounded, deterministic edge discovery. Returned chains contain stored edges only."""
from __future__ import annotations
from collections import defaultdict
from sqlalchemy import case, func, or_, select, union_all
from sqlalchemy.orm import aliased
from app.models.learning import MemoryEdge, MemoryNode, MemoryFact

CAUSAL = ('BLOCKS', 'ENABLES')
SEMANTIC = ('BLOCKS', 'ENABLES', 'ADDRESSES', 'MOTIVATES')
HISTORY = ('CONTRADICTS', 'SUPERSEDES')
MAX_ROOTS, MAX_FRONTIER, MAX_FETCHED = 24, 32, 768
RECENT_PER_ANCHOR, OLD_PER_ANCHOR = 6, 2


def priority(relation):
    return 0 if relation in HISTORY else 1 if relation in SEMANTIC else 2


async def collect_path_bundles(db, *, learner_id, anchors, relations, max_hops,
                               node_allowed, scope_predicates, endpoint, relevance):
    """Per-anchor recent/old windows, then filtered causal expansion to depth <= 2.

    SQL windows bound materialized candidates, not database execution complexity.
    Scope is injected from the shared authority and checked again in Python.
    """
    roots = [n.id for n in anchors[:MAX_ROOTS]]
    stats = {'max_hops': max(0, min(2, int(max_hops))), 'max_roots': MAX_ROOTS,
             'max_frontier': MAX_FRONTIER, 'edge_candidate_limit': MAX_FETCHED,
             'recent_edges_per_anchor_kind': RECENT_PER_ANCHOR, 'old_edges_per_anchor_kind': OLD_PER_ANCHOR,
             'candidate_edges': 0, 'filtered_edges': 0, 'cycles_skipped': 0,
             'window_truncated': len(anchors)>MAX_ROOTS, 'max_depth_found': 0,
             'second_hop_branches_per_root': 4, 'second_hop_branches_omitted': 0}
    if not roots or not stats['max_hops']:
        return {}, stats
    nodes, facts = {}, {}

    async def discover(frontier, allowed_relations):
        s, t = aliased(MemoryNode), aliased(MemoryNode)
        filters = [MemoryEdge.learner_id==learner_id, MemoryEdge.relation_type.in_(allowed_relations),
                   s.learner_id==learner_id, t.learner_id==learner_id,
                   *scope_predicates(s), *scope_predicates(t),
                   or_(MemoryEdge.relation_type.in_(HISTORY),
                       (s.status!='superseded') & (t.status!='superseded'))]
        def direction(column):
            return select(MemoryEdge.id.label('edge_id'), column.label('anchor_id'),
                          MemoryEdge.created_at.label('stamp'),
                          case((MemoryEdge.relation_type.in_(HISTORY),0),
                               (MemoryEdge.relation_type.in_(SEMANTIC),1),else_=2).label('kind'))\
                .join(s, s.id==MemoryEdge.source_node_id).join(t, t.id==MemoryEdge.target_node_id)\
                .where(*filters,column.in_(frontier))
        incident=union_all(direction(MemoryEdge.source_node_id),direction(MemoryEdge.target_node_id)).subquery()
        window=select(incident,
            func.row_number().over(partition_by=(incident.c.anchor_id,incident.c.kind),
                order_by=(incident.c.kind,incident.c.stamp.desc(),incident.c.edge_id.desc())).label('recent'),
            func.row_number().over(partition_by=(incident.c.anchor_id,incident.c.kind),
                order_by=(incident.c.kind,incident.c.stamp,incident.c.edge_id)).label('old'),
            func.count().over(partition_by=(incident.c.anchor_id,incident.c.kind)).label('total')).subquery()
        remaining=MAX_FETCHED-stats['candidate_edges']
        selected=list((await db.execute(select(window).where(or_(window.c.recent<=RECENT_PER_ANCHOR,
             window.c.old<=OLD_PER_ANCHOR)).order_by(window.c.recent,window.c.anchor_id,window.c.edge_id)
             .limit(remaining+1))).mappings())
        stats['window_truncated'] |= len(selected)>remaining or any(r['total']>RECENT_PER_ANCHOR+OLD_PER_ANCHOR for r in selected)
        selected=selected[:remaining];stats['candidate_edges']+=len(selected)
        edges={e.id:e for e in (await db.execute(select(MemoryEdge).where(
            MemoryEdge.learner_id==learner_id,MemoryEdge.id.in_({r['edge_id'] for r in selected} or {-1})))).scalars()}
        ids={i for e in edges.values() for i in (e.source_node_id,e.target_node_id)}
        nodes.update({n.id:n for n in (await db.execute(select(MemoryNode).where(
            MemoryNode.learner_id==learner_id,MemoryNode.id.in_(ids or {-1})))).scalars()})
        facts.update({f.node_id:f for f in (await db.execute(select(MemoryFact).where(
            MemoryFact.node_id.in_(ids or {-1})))).scalars()})
        grouped=defaultdict(list)
        for row in selected:
            e=edges[row['edge_id']];a,b=nodes.get(e.source_node_id),nodes.get(e.target_node_id)
            if a is None or b is None or not all(node_allowed(n,facts.get(n.id),e.relation_type in HISTORY) for n in (a,b)):
                stats['filtered_edges']+=1;continue
            if a.id==b.id:
                stats['cycles_skipped']+=1;continue
            other=b if a.id==row['anchor_id'] else a
            grouped[row['anchor_id']].append((e,other,row['old']))
        for anchor,rows in grouped.items():
            # One old causal edge is reserved within each relevance tier.
            rows.sort(key=lambda r:(priority(r[0].relation_type),-relevance(r[1]),
                                    0 if r[2]<=2 else 1,-r[0].id))
        return grouped

    def render(e, root, route):
        return {'relation':e.relation_type,'source':endpoint(nodes[e.source_node_id],facts.get(e.source_node_id)),
                'target':endpoint(nodes[e.target_node_id],facts.get(e.target_node_id)),
                'evidence_event_id':e.evidence_event_id,'root_anchor_id':root,
                'hop':len(route)-1,'via_node_ids':list(route)}

    first=await discover(roots,relations)
    first_chains=defaultdict(list)
    for root in roots:
        for e,neighbor,_ in first.get(root,[]):
            first_chains[root].append((e,[root,neighbor.id]))
    second_seeds=[]
    if stats['max_hops']>1 and set(relations)&set(CAUSAL):
        # Round robin over roots prevents the hottest root owning all second-hop work.
        stats['second_hop_branches_omitted'] = sum(max(0,sum(e.relation_type in CAUSAL for e,_ in first_chains[root])-4) for root in roots)
        stats['window_truncated'] |= stats['second_hop_branches_omitted'] > 0
        for rank in range(4):
            for root in roots:
                causal=[pair for pair in first_chains[root] if pair[0].relation_type in CAUSAL]
                if rank<len(causal):second_seeds.append((root,*causal[rank]))
        frontier=list(dict.fromkeys(route[-1] for _,_,route in second_seeds))
        stats['window_truncated'] |= len(frontier)>MAX_FRONTIER
        frontier=frontier[:MAX_FRONTIER]
        second=await discover(frontier,tuple(r for r in CAUSAL if r in relations)) if frontier else {}
    else:
        second={}
    bundles=defaultdict(list)
    for root,e,route in second_seeds:
        for next_edge,neighbor,_ in second.get(route[-1],[]):
            if neighbor.id in route:
                stats['cycles_skipped']+=1;continue
            bundles[root].append([render(e,root,route),render(next_edge,root,[*route,neighbor.id])])
    for root in roots:
        for e,route in first_chains[root]:
            bundles[root].append([render(e,root,route)])
        # Corrections remain first; complete dependency chains precede sibling links.
        bundles[root].sort(key=lambda chain:(min(priority(p['relation']) for p in chain),-len(chain)))
    stats['max_depth_found']=max((len(c) for v in bundles.values() for c in v),default=0)
    return dict(bundles),stats
