"""Rebuild authored batch 2 artifacts. Existing v1 works are never replaced.
Legacy first-publication builder. Published versions are verified and skipped.
Use build_visual_hub_completion.cjs with a new version for subsequent edits.
"""
from pathlib import Path
import json, hashlib, html
root=Path(__file__).resolve().parents[1]/'packages/learning-core/src/learnflow_core/visuals/hub'
def main():
    configs=json.loads((root/'authoring/batch2.json').read_text())
    model=(root/'authoring/batch2-models.js').read_text();player=(root/'authoring/batch2-player.js').read_text()
    works=json.loads((root/'works.json').read_text()); existing={(w['id'],w['version']):w for w in works}; built=0
    curriculum=json.loads((root/'curriculum.json').read_text());sessions={s['id']:s for m in curriculum['modules'] for c in m['chapters'] for s in c['sessions']}
    for cfg in configs:
        id,title,sid,label,minimum,maximum,step,initial,scope=cfg
        published=existing.get(('lab2-'+id,'1.0.0'))
        if published:
            source=root/'works'/published['file']
            if hashlib.sha256(source.read_bytes()).hexdigest()!=published['sha256']:
                raise ValueError(f'Published asset integrity mismatch: {source.name}')
            continue  # Keep both immutable v1 bytes and any newer curriculum reference.
        # player config excludes session id, so indices are stable and small.
        pc=[id,title,label,minimum,maximum,step,initial]
        fragment=f'''<section data-hub-demo data-config="{html.escape(json.dumps(pc,ensure_ascii=False),quote=True)}"><h3>{html.escape(title)}</h3><label>{html.escape(label)} <output data-value>{initial}</output><input data-param aria-label="{html.escape(label)}" class="form-range" type="range" min="{minimum}" max="{maximum}" step="{step}" value="{initial}"></label><div data-scene></div><p data-note aria-live="polite"></p><p data-formula class="text-small"></p><div data-transport class="viz-controls"><button data-play class="btn-primary">播放</button><button data-prev>上一步</button><button data-next>下一步</button><output data-progress></output></div><input data-seek aria-label="演示进度" class="form-range" type="range" min="0" value="0"><details><summary>演示范围</summary><p>{html.escape(scope)}</p></details></section>
<style>[data-hub-demo] svg{{width:100%;height:clamp(200px,42vw,300px);display:block}}[data-scene]{{min-height:180px;margin-top:16px}}[data-note]{{min-height:3em}}.cells,.flow{{display:flex;flex-wrap:wrap;gap:8px;padding:25px 0;align-items:center}}.cells span,.flow span{{border:1px solid var(--border);padding:10px;border-radius:8px;min-width:44px}}.cells small{{display:block;text-align:center;color:var(--muted-foreground)}}.active{{background:color-mix(in srgb,var(--viz-series-2) 22%,var(--background));outline:2px solid var(--viz-series-2)}}.matrices{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:20px;padding:30px 0}}.matrix{{display:grid;gap:6px;margin-top:10px}}.matrix span{{padding:10px 3px;text-align:center;background:var(--muted);border-radius:6px}}.timeline{{display:flex;flex-wrap:wrap;margin:60px 0 25px;gap:2px}}.timeline span{{color:white;text-align:center;min-width:32px;padding:15px 2px}}.timeline small{{display:block;font-size:11px}}details{{margin-top:12px;color:var(--muted-foreground);font-size:12px}}[hidden]{{display:none!important}}</style>
<script>{model}\n{player}</script>'''
        file=f'lab2-{id}.html';(root/'works'/file).write_text(fragment)
        diagrams={'projection','eigen','svd','normal','entropy','deadlock','subnet','perceptron','logistic','crossentropy','pca','consistenthash'}
        entry={'id':'lab2-'+id,'version':'1.0.0','title':title,'file':file,'session_ids':[sid],'questions':[title.replace('：','如何：',1),scope],'aliases':[title.split('：')[0],id],'kind':['diagram'] if id in diagrams else ['diagram','animation'],'scope':scope,'sha256':hashlib.sha256(fragment.encode()).hexdigest(),'status':'ready','builder':'interactive_html'}
        works.append(entry);built+=1
        session=sessions[sid];vid=sid+'.lab2-'+id;session['visual_candidates']=[v for v in session['visual_candidates'] if v['id']!=vid]
        session['visual_candidates'].append({'id':vid,'question':title,'concepts':[title.split('：')[0]],'representation':'interactive_model','interaction':f'调整{label}，重算并观察状态','acceptance':scope,'status':'ready','work_refs':[{'id':entry['id'],'version':'1.0.0'}]})
    if not built:
        print(f'Verified and preserved {len(configs)} published v1 works; no changes')
        return
    (root/'works.json').write_text(json.dumps(works,ensure_ascii=False,indent=2)+'\n');(root/'curriculum.json').write_text(json.dumps(curriculum,ensure_ascii=False,indent=2)+'\n')
    print(f'Built {len(configs)} works; maintained HTML total {len(works)}')
if __name__=='__main__':main()
