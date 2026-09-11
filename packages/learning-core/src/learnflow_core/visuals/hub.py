"""Internal authored curriculum and immutable, reviewed interactive works.

Only bundled manifest references can execute. Generated code, paths and URLs are
never accepted. This is teaching content, not learner state or mastery evidence.
"""
from pathlib import Path
from hashlib import sha256
import json
from .engine import digest

ROOT = Path(__file__).with_name('hub')
VERSION = '1.0.0'


def curriculum():
    return json.loads((ROOT / 'curriculum.json').read_text(encoding='utf-8'))


def works():
    return json.loads((ROOT / 'works.json').read_text(encoding='utf-8'))


def reference(work):
    return {'hub_version': VERSION, 'work_id': work['id'], 'version': work['version'],
            'title': work['title'], 'sha256': work['sha256']}


def entries():
    data = curriculum()
    sessions = {s['id']: s for m in data['modules'] for c in m['chapters'] for s in c['sessions']}
    modules = {m['id']: m for m in data['modules']}
    owners = {s['id']: m for m in data['modules'] for c in m['chapters'] for s in c['sessions']}
    result = []
    for w in works():
        if w['status'] != 'ready':
            continue
        result.append({'id': w['id'], 'version': w['version'], 'title': w['title'],
            'description': w.get('description', w['scope']), 'builder': 'interactive_html', 'spec': reference(w),
            'kind': w['kind'], 'patterns': ['linked_views', 'parameter_sweep'],
            'tags': [sessions[s]['title'] for s in w['session_ids']],
            'aliases': w['questions'] + [w['title'], w['id']] + w.get('aliases', []),
            'assumptions': [w['scope']],
            'retrieval': w.get('retrieval', {'questions': w['questions'], 'use_when': w.get('description', w['scope']),
                'not_for': ['超出该作品声明的输入范围与模型假设；不要据此推断真实系统性能或学习者掌握。'],
                'prerequisites': list(dict.fromkeys(modules[p]['title'] for s in w['session_ids'] for p in owners[s]['prerequisite_module_ids'])),
                'learning_path': {'graph_id': 'visual-hub-curriculum/v1', 'nodes': [{'id': s, 'title': sessions[s]['title']} for s in w['session_ids']]}})})
    return result


def query_hub(query='', module_id=None, offset=0, limit=20):
    if not isinstance(query, str) or len(query) > 6000 or (module_id is not None and not isinstance(module_id, str)):
        raise ValueError('visual_hub_query_invalid')
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError('visual_hub_page_invalid')
    data = curriculum()
    if module_id and not any(m['id'] == module_id for m in data['modules']):
        raise ValueError('visual_hub_module_not_found')
    from .catalog import _terms
    terms = _terms(query)
    hits = []
    for m in data['modules']:
        if module_id and m['id'] != module_id:
            continue
        for chapter in m['chapters']:
            for session in chapter['sessions']:
                row = {'module_id': m['id'], 'module_title': m['title'], 'area': m['area'],
                    'chapter_id': chapter['id'], 'chapter_title': chapter['title'], **session}
                target = json.dumps(row, ensure_ascii=False)
                overlap = len(terms & _terms(target))
                if query and query.casefold() not in target.casefold() and overlap < 2:
                    continue
                hits.append((overlap, row))
    hits.sort(key=lambda pair: -pair[0])
    return {'schema_version': VERSION, 'visibility': 'agent_internal', 'coverage': data['coverage'],
        'total': len(hits), 'offset': offset, 'next_offset': offset+limit if offset+limit<len(hits) else None,
        'sessions': [row for _, row in hits[offset:offset+limit]],
        'modules': [{k:m[k] for k in ('id','title','area','prerequisite_module_ids')} for m in data['modules']],
        'tracks': data['tracks'], 'sources': data['sources'],
        'policy': 'planned is a topic proposal, never an available work. Reuse only ready work_refs; fresh generation remains available.'}


BASE_STYLE = '''
:root{color-scheme:light dark;--background:#fff;--foreground:#172d34;--border:#d5dfe1;--muted-foreground:#526b72;--viz-series-1:#067b99;--viz-series-2:#c76c18;--viz-series-3:#7b52b5;--muted:#f2f7f7;font-family:system-ui,sans-serif;font-size:14px}
@media(prefers-color-scheme:dark){:root{--background:#142125;--foreground:#e2eff2;--border:#48616a;--muted-foreground:#aac1c8;--viz-series-1:#54bbd2;--viz-series-2:#f7ae60;--muted:#203239}}
[data-lab]{max-width:620px;margin:auto}[data-lab] svg{max-height:320px;width:100%;display:block}[data-lab] [data-note]{min-height:0!important}[data-lab] h3{font-size:17px;margin-bottom:10px}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--background);color:var(--foreground)}h3{font-size:18px;margin:0 0 16px}button,select,input{font:inherit;color:inherit}button,select{background:var(--background);border:1px solid var(--border);border-radius:7px;padding:7px 12px}button{cursor:pointer}.btn-primary{background:var(--viz-series-1);color:var(--background);border-color:var(--viz-series-1)}button:disabled{opacity:.45}.viz-controls,.viz-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.viz-controls label{flex:1;min-width:130px}.viz-controls input[type=range],.form-range{display:block;width:100%;accent-color:var(--viz-series-1)}.text-small{font-size:12px}.tabular-nums{font-variant-numeric:tabular-nums}p{line-height:1.65}svg{max-width:100%}@media(max-width:420px){[data-lab] svg text{font-size:18px}[data-lab=bayes] svg text{font-size:20px}}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--viz-series-2);outline-offset:2px}
'''


def compile_work(source, template_ref=None):
    if not isinstance(source, dict):
        raise ValueError('visual_hub_reference_required')
    work = next((w for w in works() if w['id']==source.get('work_id') and w['version']==source.get('version') and w['status']=='ready'), None)
    if work is None or source != reference(work):
        raise ValueError('visual_hub_immutable_reference_invalid')
    if template_ref is not None and template_ref != {'id':work['id'], 'version':work['version']}:
        raise ValueError('visual_hub_template_identity_conflict')
    path = ROOT / 'works' / work['file']
    # The filename is deployment-controlled, still reject accidental path escape.
    if path.resolve().parent != (ROOT / 'works').resolve():
        raise ValueError('visual_hub_asset_path_invalid')
    payload = path.read_bytes()
    # Git 在 Windows 上可能把维护资源落盘为 CRLF，而清单按 LF 字节生成。
    # 统一换行后再校验，保证桌面端与云端的完整性语义一致。
    canonical_payload = payload.replace(b'\r\n', b'\n')
    if sha256(canonical_payload).hexdigest() != work['sha256']:
        raise ValueError('visual_hub_asset_digest_mismatch')
    csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
    resize = "<script>new ResizeObserver(()=>parent.postMessage({type:'learnflow-visual-height',height:document.body.scrollHeight},'*')).observe(document.body);</script>"
    html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><style>'+BASE_STYLE+'</style></head><body>'+canonical_payload.decode('utf-8')+resize+'</body></html>'
    return {'runtime_version': 'maintained-html/1', 'html': html, 'params': {},
        'verification': {'status':'pass','scope':work['scope'], 'method':'maintained_asset_digest',
                         'meaning':'The reviewed version is intact; this is not a learner assessment.'},
        'source_provenance': {'source':'maintained_library','id':work['id'],'version':work['version'],'spec_digest':digest(source)}}


def browse_works(query='', module_id=None, kind=None, offset=0, limit=16):
    """Only completed works are browseable; no candidate is promoted by listing."""
    if not isinstance(query,str) or len(query)>1000 or kind not in (None,'diagram','animation'):
        raise ValueError('visual_gallery_query_invalid')
    if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=50:
        raise ValueError('visual_gallery_page_invalid')
    from .catalog import _entries, _summary, _terms
    links={}
    data=curriculum()
    for m in data['modules']:
        for ch in m['chapters']:
            for session in ch['sessions']:
                for candidate in session['visual_candidates']:
                    for ref in candidate['work_refs']:
                        links.setdefault((ref['id'],ref['version']),[]).append({'module_id':m['id'],'module_title':m['title'],'chapter':ch['title'],'session':session['title'],'session_id':session['id']})
    if module_id is not None and (not isinstance(module_id,str) or module_id not in {m['id'] for m in data['modules']}):
        raise ValueError('visual_gallery_module_invalid')
    rows=[];terms=_terms(query)
    latest={}
    for entry in _entries():
        if entry['id'] not in latest or tuple(map(int,entry['version'].split('.')))>tuple(map(int,latest[entry['id']]['version'].split('.'))):latest[entry['id']]=entry
    for e in latest.values():
        related=links.get((e['id'],e['version']),next((v for (i,_),v in links.items() if i==e['id']),[]))
        if module_id and not any(x['module_id']==module_id for x in related):continue
        if kind and kind not in e['kind']:continue
        text=' '.join([e['title'],e['description'],*e.get('aliases',[]),*e['tags']])
        score=len(terms&_terms(text))
        if query and query.casefold() not in text.casefold() and score<2:continue
        rows.append({**_summary(e,score),'curriculum':related})
    session_order={s['id']:i for i,s in enumerate(s for m in data['modules'] for ch in m['chapters'] for s in ch['sessions'])}
    if query:
        rows.sort(key=lambda r:-r['score'])  # Preserve maintained tie order for existing queries.
    else:
        rows.sort(key=lambda r:(min((session_order.get(c['session_id'],10000) for c in r['curriculum']),default=10000),r['id']))
    return {'items':rows[offset:offset+limit],'total':len(rows),'offset':offset,
            'next_offset':offset+limit if offset+limit<len(rows) else None,
            'modules':[{'id':m['id'],'title':m['title']} for m in data['modules']]}


def preview_work(work_id, version, params=None):
    from .catalog import read_template
    from .engine import compile_visual
    if params is not None and not isinstance(params,dict):raise ValueError('visual_preview_params_invalid')
    e=read_template(work_id,version)
    if e['builder']=='interactive_html':return {'builder':e['builder'],'title':e['title'],'html':compile_work(e['spec'])['html']}
    return {'builder':'visual_spec','title':e['title'],'bundle':{**compile_visual(e['spec'],params or {}),'owner_scope':'public:maintained'}}
