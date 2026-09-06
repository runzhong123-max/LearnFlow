"""Compare real imports and common contracts in separate host processes (read-only)."""
from __future__ import annotations
import argparse
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MODULES = ('learning_runtime', 'memory_graph', 'five_kernel_context', 'teaching_guidance', 'agent_observations', 'remediation')
PROBE = r'''
import dataclasses, importlib, json
from app.services import architecture_registry as registry
from learnflow_core.registry_core import SHARED_CORE_VERSION
from learnflow_core.api import SHARED_API_MODULES
names = ('learning_runtime', 'memory_graph', 'five_kernel_context', 'teaching_guidance', 'agent_observations', 'remediation')
paths = {}
for name in names:
    legacy = importlib.import_module('app.services.' + name)
    shared = importlib.import_module('learnflow_core.' + name)
    assert legacy is shared, 'split module identity: ' + name
    paths[name] = shared.__file__
api_paths = {}
for name in (*SHARED_API_MODULES, 'platform'):
    legacy = importlib.import_module('app.api.' + name)
    shared = importlib.import_module('learnflow_core.api.' + name)
    assert legacy is shared, 'split API module identity: ' + name
    api_paths[name] = shared.__file__
assert not registry.validate_registry(), registry.validate_registry()
print(json.dumps({
    'version': SHARED_CORE_VERSION, 'paths': paths, 'apiPaths': api_paths,
    'agents': {k: dataclasses.asdict(v) for k, v in registry.AGENTS.items()},
    'kernels': {k: dataclasses.asdict(v) for k, v in registry.KERNELS.items()},
    'events': {k: dataclasses.asdict(v) for k, v in registry.EVENTS.items()},
    'eventSchema': registry.EVENT_SCHEMA_VERSION,
}, ensure_ascii=False))
'''

def check(web_python: str, desktop_python: str) -> None:
    snapshots = []
    env = dict(os.environ, DATABASE_URL='sqlite+aiosqlite:///:memory:', MEMORY_AUTO_SYNTHESIS_ENABLED='false', LLM_API_KEY='')
    for host, interpreter in [('backend', web_python), ('apps/desktop/backend', desktop_python)]:
        # Resolve before changing cwd, preserving venv symlinks and PATH names.
        interpreter = str(Path(interpreter).absolute()) if Path(interpreter).is_file() else (shutil.which(interpreter) or interpreter)
        result = subprocess.run([interpreter, '-c', PROBE], cwd=ROOT / host, env=env, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(f'{host}: shared imports failed\n{result.stderr}')
        snapshots.append(json.loads(result.stdout))
    web, desktop = snapshots
    for field in ('version', 'agents', 'kernels', 'eventSchema'):
        if web[field] != desktop[field]:
            raise RuntimeError(f'shared contract diverged: {field}')
    common_events = web['events'].keys() & desktop['events'].keys()
    for event in sorted(common_events):
        if web['events'][event] != desktop['events'][event]:
            raise RuntimeError(f'common event contract diverged: {event}')
    if web['apiPaths'] != desktop['apiPaths']:
        raise RuntimeError('API implementations diverged between hosts')
    for name in MODULES:
        expected = (ROOT / 'packages/learning-core/src/learnflow_core' / f'{name}.py').resolve()
        for state in snapshots:
            if Path(state['paths'][name]).resolve() != expected:
                raise RuntimeError(f'{name} does not resolve to shared source')
    for app in (ROOT/'frontend', ROOT/'apps/desktop/frontend'):
        for name in ('password-policy', 'latency-budgets', 'teaching-guidance-context', 'runtime-surface'):
            source = (app/'src'/f'{name}.ts').read_text().strip()
            relative = os.path.relpath(ROOT/'packages/learning-client/src'/f'{name}.ts', app/'src').replace(os.sep, '/')
            if source != f"export * from '{relative}'":
                raise RuntimeError(f'duplicated client implementation: {app.name}/{name}')
    for host in ('frontend', 'apps/desktop/frontend'):
        app = ROOT / host
        for local, shared in (
            ('src/visualize.ts', 'types.ts'),
            ('src/visualize-presentation.ts', 'presentation.ts'),
            ('server/visualize-artifact.ts', 'artifact.ts'),
            ('server/visualize-authoring.ts', 'authoring.ts'),
        ):
            path = app / local
            target = ROOT / 'packages/learning-client/src/visuals' / shared
            relative = os.path.relpath(target, path.parent).replace(os.sep, '/')
            if path.read_text().strip() != f"export * from '{relative}'":
                raise RuntimeError(f'duplicated visual implementation: {path}')
    if (ROOT/'apps/desktop/.git').exists():
        raise RuntimeError('nested desktop Git repository is not allowed')
    print(f'Shared core {web["version"]}: both hosts use the same 6 Python modules, 22 API modules, 4 TS sources, three agents, five kernels and {len(common_events)} common event contracts.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    default = ROOT/'backend/venv'/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    parser.add_argument('--python-web', default=str(default) if default.exists() else sys.executable)
    parser.add_argument('--python-desktop')
    args = parser.parse_args()
    check(args.python_web, args.python_desktop or args.python_web)
