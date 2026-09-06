"""Generate the current HTTP/IPC inventory without starting services or touching data."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PROBE = '''
import inspect,json
from fastapi.routing import APIRoute
from app.main import app
routes=[]
for route in app.routes:
    if isinstance(route,APIRoute):
        routes.append(route)
    elif hasattr(route,'effective_route_contexts'):
        contexts=route.effective_route_contexts
        routes.extend(contexts() if callable(contexts) else contexts)
rows=[dict(method=method,path=r.path_format,module=r.endpoint.__module__,handler=r.endpoint.__name__,source=inspect.getsourcefile(r.endpoint),line=inspect.getsourcelines(r.endpoint)[1]) for r in routes for method in sorted(r.methods)]
assert rows, 'no mounted API routes discovered'
discovered={(r['path'],r['method'].lower()) for r in rows}
expected={(path,method) for path,op in app.openapi()['paths'].items() for method in op if method in {'get','post','put','patch','delete','head','options'}}
assert expected <= discovered, expected-discovered
print(json.dumps(rows,ensure_ascii=False))
'''

def collect(python: str) -> list[dict]:
    rows = []
    for host, directory in [('Web FastAPI','backend'),('Desktop FastAPI','apps/desktop/backend')]:
        env = dict(os.environ, DATABASE_URL='sqlite+aiosqlite:///:memory:', MEMORY_AUTO_SYNTHESIS_ENABLED='false', LLM_API_KEY='')
        result = subprocess.run([python,'-c',PROBE],cwd=ROOT/directory,env=env,text=True,capture_output=True)
        if result.returncode:
            raise RuntimeError(f'{host}: {result.stderr}')
        for row in json.loads(result.stdout):
            row.update(host=host,source=Path(row['source']).relative_to(ROOT).as_posix(),kind='HTTP')
            rows.append(row)
    for prefix, host in [('frontend','Web Node Tutor'),('apps/desktop/frontend','Desktop Node Tutor (dev/preview)')]:
        source = ROOT/prefix/'vite.config.ts'
        content = source.read_text()
        for method,path in [('POST','/api/tutor'),('POST','/api/tutor/stream'),('GET','/api/tutor/status')]:
            assert path in content, (source,path)
            line = next(i for i,s in enumerate(content.splitlines(),1) if repr(path) in s)
            rows.append(dict(host=host,kind='HTTP',method=method,path=path,module='tutorProxy',handler='middleware',source=source.relative_to(ROOT).as_posix(),line=line))
    for source in sorted((ROOT/'apps/role-atlas/app/api').rglob('route.ts')):
        path = '/' + source.parent.relative_to(ROOT/'apps/role-atlas/app').as_posix()
        path = re.sub(r'\[([^]]+)\]',r'{\1}',path)
        content = source.read_text()
        matches = list(re.finditer(r'export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b',content))
        assert matches, f'Unrecognized route exports: {source}'
        for match in matches:
            rows.append(dict(host='Role Atlas / Graph Hub',kind='HTTP',method=match[1],path=path,module=path.split('/')[2],handler=match[1],source=source.relative_to(ROOT).as_posix(),line=content[:match.start()].count('\n')+1))
    source=ROOT/'apps/desktop/desktop/src-tauri/src/lib.rs'
    content=source.read_text()
    handlers=re.search(r'generate_handler!\[([^]]+)\]',content,re.S)[1]
    for name in re.findall(r'\b\w+\b',handlers):
        match=re.search(r'\b(?:async\s+)?fn\s+'+re.escape(name)+r'\s*\(',content)
        assert match,name
        rows.append(dict(host='Desktop Tauri IPC',kind='IPC',method='invoke',path=name,module='native bridge',handler=name,source=source.relative_to(ROOT).as_posix(),line=content[:match.start()].count('\n')+1))
    return sorted(rows,key=lambda r:(r['host'],r['module'],r['path'],r['method']))

def render(rows: list[dict]) -> str:
    out=['# LearnFlow API 与桌面 IPC 清单','', '由 `scripts/generate_api_catalog.py` 从当前代码生成。每行按宿主 + 方法 + 路径计数；相同路径在不同宿主属于不同入口，不据此断言行为或鉴权相同。FastAPI 来源为已挂载 APIRoute（含被运行策略限制的接口），不包含框架自动生成的 /docs、/redoc、/openapi.json；Node 为显式 Tutor 中间件；Atlas 为显式 route.ts 方法；IPC 为 generate_handler 注册项。代理转发不重复计数。','', '本清单是导航索引，不是访问授权或完整 schema 文档；身份、权限、请求响应字段以源代码和各 FastAPI 的 `/openapi.json` 为准。运行中的 registry 提供能力状态，路由存在不等于当前环境可用。','', '[模块与调用关系总览](PROJECT_MAP.md)','', '| 宿主 | 方法与路径条目数 |','|---|---:|']
    hosts=sorted({r['host'] for r in rows})
    for host in hosts:out.append(f'| {host} | {sum(r["host"]==host for r in rows)} |')
    for host in hosts:
        out += ['',f'## {host}','']
        for module in sorted({r['module'] for r in rows if r['host']==host}):
            out += [f'### {module}','','| 方法 | 路径 / 命令 | 实现 |','|---|---|---|']
            for r in rows:
                if r['host']==host and r['module']==module:
                    out.append(f'| {r["method"]} | `{r["path"]}` | [{r["handler"]}](../{r["source"]}#L{r["line"]}) |')
            out.append('')
    return '\n'.join(out).rstrip()+'\n'

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    default=ROOT/'backend/venv/bin/python'
    parser.add_argument('--python',default=str(default) if default.is_file() else sys.executable)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    python=str(Path(args.python).absolute()) if Path(args.python).is_file() else args.python
    rows=collect(python)
    artifacts={ROOT/'docs/API_CATALOG.md':render(rows),ROOT/'docs/api-catalog.json':json.dumps(rows,ensure_ascii=False,indent=2)+'\n'}
    for path,content in artifacts.items():
        if args.check:
            assert path.read_text()==content,f'API catalog drift: {path}'
        else:path.write_text(content)
    print(json.dumps({host:sum(r['host']==host for r in rows) for host in sorted({r['host'] for r in rows})},ensure_ascii=False))
