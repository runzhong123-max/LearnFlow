"""Native safe SVG for authored structural stories; never a simulation proof."""
from __future__ import annotations

import copy
from html import escape
import json
import math
import re
from .engine import digest

STORY_RUNTIME = 'learnflow.svg-story.1.0.1'
ID = re.compile(r'^[a-z][a-z0-9_.-]{0,63}$')


def require(ok, detail):
    if not ok:
        raise ValueError('svg_story:' + detail)


def text(value, name, limit):
    require(isinstance(value, str) and 0 < len(value.strip()) <= limit, name + ': bounded nonempty text required')
    require(not any(ord(c) < 32 and c not in '\n\t' for c in value), name + ': control characters prohibited')


def compile_svg_story(source, kind='diagram'):
    require(kind in ('diagram', 'animation'), 'invalid kind')
    require(isinstance(source, dict) and set(source) == {'story_version', 'title', 'goal', 'nodes', 'edges', 'steps'}, 'root fields')
    require(len(json.dumps(source, ensure_ascii=False, allow_nan=False).encode()) <= 131072, 'source budget')
    require(source['story_version'] == '1', 'unsupported version')
    text(source['title'], '/title', 240); text(source['goal'], '/goal', 2000)
    nodes, edges, steps = source['nodes'], source['edges'], source['steps']
    require(isinstance(nodes, list) and 1 <= len(nodes) <= 16, '1..16 nodes required')
    require(isinstance(edges, list) and len(edges) <= 40, 'edge budget')
    require(isinstance(steps, list) and 1 <= len(steps) <= 64, '1..64 stages required')
    ids, edge_ids = set(), set()
    for node in nodes:
        require(isinstance(node, dict) and {'id', 'label'} <= set(node) <= {'id', 'label', 'detail'}, 'node fields')
        require(isinstance(node['id'], str) and ID.fullmatch(node['id']) and node['id'] not in ids, 'invalid/duplicate node id')
        ids.add(node['id']); text(node['label'], '/nodes/label', 100)
        if 'detail' in node: text(node['detail'], '/nodes/detail', 1500)
    for edge in edges:
        require(isinstance(edge, dict) and {'id', 'from', 'to'} <= set(edge) <= {'id', 'from', 'to', 'label'}, 'edge fields')
        require(isinstance(edge['id'], str) and ID.fullmatch(edge['id']) and edge['id'] not in edge_ids, 'invalid/duplicate edge id')
        require(isinstance(edge['from'], str) and isinstance(edge['to'], str) and edge['from'] in ids and edge['to'] in ids, 'edge endpoint missing')
        edge_ids.add(edge['id'])
        if 'label' in edge: text(edge['label'], '/edges/label', 100)
    for step in steps:
        require(isinstance(step, dict) and set(step) == {'title', 'note', 'active_nodes', 'active_edges'}, 'step fields')
        text(step['title'], '/steps/title', 240); text(step['note'], '/steps/note', 2000)
        for key, available in (('active_nodes', ids), ('active_edges', edge_ids)):
            selected = step[key]
            require(isinstance(selected, list) and all(isinstance(i, str) and i in available for i in selected) and len(selected) == len(set(selected)), '/steps/' + key + ': references invalid')
    if kind == 'animation':
        signatures = {(tuple(sorted(s['active_nodes'])), tuple(sorted(s['active_edges']))) for s in steps}
        require(len(steps) >= 2 and len(signatures) >= 2, 'animation requires two meaningfully different structural states')
    revision = digest({'source': source, 'runtime': STORY_RUNTIME})
    columns = min(3, len(nodes)); rows = math.ceil(len(nodes)/columns)
    width, height = columns*280 + 60, rows*180 + 80
    positions = {n['id']: (170+(i % columns)*280, 120+(i//columns)*180) for i, n in enumerate(nodes)}
    scenes = []
    for index, step in enumerate(steps):
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="scene-title scene-desc">',
                 f'<title id="scene-title">{escape(step["title"])}</title><desc id="scene-desc">{escape(step["note"])}</desc>',
                 '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>',
                 '<rect width="100%" height="100%" fill="#f8fafc"/>']
        for edge in edges:
            x1,y1 = positions[edge['from']]; x2,y2 = positions[edge['to']]
            active = edge['id'] in step['active_edges']; color = '#0369a1' if active else '#94a3b8'
            if edge['from'] == edge['to']:
                label_x,label_y = x1+65,y1-85
                path = f'M {x1+90} {y1-25} C {x1+160} {y1-110}, {x1-20} {y1-110}, {x1+20} {y1-42}'
            else:
                dx,dy = x2-x1,y2-y1; length = math.hypot(dx,dy)
                label_x,label_y = (x1+x2)/2+dy/length*25,(y1+y2)/2-dx/length*25
                boundary = min(119/abs(dx) if dx else math.inf, 53/abs(dy) if dy else math.inf)
                sx,sy = x1+dx*boundary,y1+dy*boundary
                ex,ey = x2-dx*boundary,y2-dy*boundary
                path = f'M {sx:g} {sy:g} Q {(sx+ex)/2+dy/length*28:g} {(sy+ey)/2-dx/length*28:g} {ex:g} {ey:g}'
            parts.append(f'<g id="edge-{edge["id"]}"><title>{escape(edge.get("label", edge["from"]+" → "+edge["to"]))}</title><path d="{path}" fill="none" stroke="{color}" stroke-width="{3 if active else 1.5}" marker-end="url(#arrow)"/>')
            if edge.get('label'):
                parts.append(f'<text x="{label_x:g}" y="{label_y+4:g}" text-anchor="middle" font-size="12" fill="#334155">{escape(edge["label"][:24])}</text>')
            parts.append('</g>')
        for node in nodes:
            x,y = positions[node['id']]; active = node['id'] in step['active_nodes']
            fill, stroke = ('#dbeafe','#0369a1') if active else ('#ffffff','#94a3b8')
            parts.append(f'<g id="node-{node["id"]}"><title>{escape(node["label"] + ("：" + node["detail"] if node.get("detail") else ""))}</title><rect x="{x-112}" y="{y-46}" width="224" height="92" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="{3 if active else 1.5}"/>')
            label = node['label']; lines = [label[i:i+16] for i in range(0, len(label), 16)]
            visible = lines[:3]
            if len(lines) > 3: visible[-1] = visible[-1][:-1] + '…'
            for row, line in enumerate(visible):
                parts.append(f'<text x="{x}" y="{y-(len(visible)-1)*10+row*20+5}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#0f172a">{escape(line)}</text>')
            if active: parts.append(f'<text x="{x-101}" y="{y-29}" font-size="10" fill="#0369a1">●</text>')
            parts.append('</g>')
        parts.append('</svg>')
        scenes.append({'title':step['title'], 'note':step['note'], 'svg':''.join(parts),
                       'snapshot_ref':digest({'revision':revision,'step':index})})
    require(len(json.dumps(scenes, ensure_ascii=False).encode()) <= 1_500_000, 'rendered story budget')
    return {'runtime_version':STORY_RUNTIME, 'source_revision':revision, 'title':source['title'], 'kind':kind,
            'source':copy.deepcopy(source), 'scenes':scenes,
            'verification':{'status':'pass','scope':'authored_structural_illustration','checker':'svg_story.references_and_safe_svg','version':'1.0.0',
                            'steps_checked':len(scenes),'assumptions':['作者编排的结构示意；仅核验引用、有限状态与安全 SVG，不证明领域计算或掌握度。'],
                            'render_scope':'deterministic bounded layout; labels retain full text in source and SVG accessibility titles'}}
