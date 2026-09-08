"""Independent, small predicates over observed artifacts; no product imports."""
from __future__ import annotations

import json


def at(value, path):
    for key in path:
        if isinstance(value, dict):
            value = value.get(str(key))
        elif isinstance(value, list) and isinstance(key, int) and 0 <= key < len(value):
            value = value[key]
        else:
            return None
    return value


def matches(value, fields):
    return isinstance(value, dict) and all(value.get(k) == v for k, v in fields.items())


def judge(observed, check):
    """Accept structured equivalent outcomes; always retain actual values on failure."""
    actual = at(observed, check.get('path', []))
    op = check['op']
    if op == 'eq':
        passed = actual == check['value']
    elif op == 'empty':
        passed = actual in ('', [], {})
    elif op == 'absent_or_empty':
        passed = actual in (None, '', [], {})
    elif op == 'exists':
        passed = actual is not None
    elif op == 'contains':
        passed = check['value'] in actual if isinstance(actual, (str, list, dict)) else False
    elif op == 'not_contains':
        passed = check['value'] not in actual if isinstance(actual, (str, list, dict)) else False
    elif op == 'lte':
        passed = type(actual) in (int, float) and actual <= check['value']
    elif op in {'some', 'none'}:
        hit = any(matches(row, check['fields']) and
            ('accepted_source_events' not in check or row.get('source_event_id') in check['accepted_source_events'])
            for row in actual or [] if isinstance(row, dict)) if isinstance(actual,list) else False
        passed = isinstance(actual,list) and (hit if op == 'some' else not hit)
    elif op == 'evidence':
        passed = isinstance(actual,list) and any(row.get('scope_valid') and row.get('current')
            and check['source_event_id'] in row.get('source_events',[])
            and all(term in row.get('text','') for term in check['terms']) for row in actual)
    elif op == 'text_all':
        passed = isinstance(actual, str) and all(term in actual for term in check['terms'])
    elif op == 'json_not_contains':
        passed = isinstance(actual,(dict,list)) and check['value'] not in stable_json(actual)
    else:
        raise ValueError(f'Unknown verifier operation: {op}')
    return {**check, 'passed': bool(passed), 'actual': actual}


def evaluate(observed, checks):
    return [judge(observed, check) for check in checks]


def stable_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)
