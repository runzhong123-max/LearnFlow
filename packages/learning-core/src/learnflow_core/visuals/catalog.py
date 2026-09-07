"""Versioned maintained teaching recipes, retrieved as data and compiled by the same engine.

Generated artifacts stay in learner-owned conversations. They are never automatically
promoted into this shared library. No user-controlled filesystem or network locations.
"""
from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from .engine import compile_visual, digest

CATALOG_VERSION = '2026-09-07.1'
PATTERNS = [
    {'id': 'trace', 'goal': '观察并解释一次状态变化', 'controls': ['stepper'], 'stop_rule': '有限步骤结束'},
    {'id': 'decomposition', 'goal': '从总览展开一个机制', 'controls': ['stepper', 'selection'], 'stop_rule': '回到输入输出关系'},
    {'id': 'comparison', 'goal': '固定其他条件比较一个变化', 'controls': ['slider', 'history'], 'stop_rule': '能够指出变化项与不变项'},
    {'id': 'parameter_sweep', 'goal': '观察参数改变后的定量边界', 'controls': ['slider'], 'stop_rule': '达到声明参数边界'},
    {'id': 'linked_views', 'goal': '把同一个对象映射到公式、代码与图形', 'controls': ['selection'], 'stop_rule': '对应关系已定位'},
    {'id': 'predict_observe_explain', 'goal': '预测、观察、解释差异', 'controls': ['prediction', 'stepper'], 'stop_rule': '仅使用已安装确定性rubric'},
]

@lru_cache(maxsize=1)
def _entries() -> tuple[dict, ...]:
    entries = []
    for path in sorted(Path(__file__).with_name('library').glob('*.json')):
        entry = json.loads(path.read_text(encoding='utf-8'))
        if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,99}', entry['id']):
            raise ValueError('invalid maintained visual id')
        if not re.fullmatch(r'\d+\.\d+\.\d+', entry['version']):
            raise ValueError('invalid maintained visual version')
        if entry.get('status') != 'production':
            continue
        entries.append(entry)
    keys = [(e['id'], e['version']) for e in entries]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate maintained visual version')
    return tuple(entries)


def _terms(value: str) -> set[str]:
    value = value.casefold()
    terms = set(re.findall(r'[a-z][a-z0-9_]*', value))
    for chunk in re.findall(r'[\u3400-\u9fff]+', value):
        terms.update(chunk[i:i+2] for i in range(len(chunk)-1))
    return terms


def _summary(entry: dict, score: float) -> dict:
    return {k: copy.deepcopy(entry[k]) for k in ('id', 'version', 'title', 'description', 'tags', 'kind', 'patterns')} | {
        'score': score, 'source': 'maintained_library', 'spec_digest': digest(entry['spec']),
        'assumptions': entry['spec']['teaching']['assumptions'],
    }


def search_catalog(query: str, kind: str, include_templates: bool = True) -> dict:
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 6000:
        raise ValueError('visual_catalog_query_required: 1..6000 characters')
    if kind not in ('diagram', 'animation'):
        raise ValueError('visual_catalog_kind_invalid')
    from .engine import capability_manifest
    q = _terms(query)
    hits = []
    for entry in (_entries() if include_templates else ()):
        if kind not in entry['kind']:
            continue
        aliases = entry.get('aliases', [])
        exact = sum(1 for alias in aliases if alias.casefold() in query.casefold())
        topic = _terms(' '.join([entry['title'], *entry['tags'], *aliases]))
        overlap = len(q & topic)
        # A candidate is a suggestion, never an automatic substitution of the request.
        if not exact and overlap < 2:
            continue
        score = round(exact * 10 + overlap / max(1, len(topic)), 4)
        hits.append(_summary(entry, score))
    hits.sort(key=lambda e: (-e['score'], e['id'], e['version']))
    return {
        'catalog_version': CATALOG_VERSION,
        'capabilities': capability_manifest(), 'patterns': PATTERNS,
        'templates': hits[:5], 'candidate_count': len(hits),
        'generation_policy': 'Templates are optional data. Preserve user inputs; choose an exact fit, adapt a copy, or generate a fresh VisualSpec with installed primitives and operations. A retrieval miss does not mean unsupported.',
    }


@lru_cache(maxsize=32)
def _validated_entry(template_id: str, version: str) -> dict:
    entry = next((e for e in _entries() if e['id'] == template_id and e['version'] == version), None)
    if entry is None:
        raise ValueError('visual_template_not_found')
    # Maintained recipes do not bypass runtime validation or gain trusted answer status.
    bundle = compile_visual(entry['spec'])
    return {
        **_summary(entry, 0), 'spec': entry['spec'],
        'provenance': {'source': 'maintained_library', 'id': template_id, 'version': version,
                       'spec_digest': digest(entry['spec']), 'catalog_version': CATALOG_VERSION},
        'verification': bundle['verification'],
    }


def read_template(template_id: str, version: str) -> dict:
    if not isinstance(template_id, str) or not isinstance(version, str):
        raise ValueError('visual_template_identity_required')
    return copy.deepcopy(_validated_entry(template_id, version))
