#!/usr/bin/env python3
"""Stdlib-only finite task oracles for original computing curriculum drafts.

Loads a catalog, recomputes from each supplied task input, and checks both the
authored correct response and incorrect response. It does not execute arbitrary
artifact code. Browser/queue/layout tasks use the explicit bounded task model,
not a browser or React runtime. Design tasks remain reasoned drafts.
"""
import argparse
from collections import Counter, deque
from copy import deepcopy
from fractions import Fraction
from itertools import combinations
import json
from pathlib import Path
import re


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def etag(d):
    quantity, version = d['quantity'], d['version']
    statuses = []
    for request in d['requests']:
        if request['match'] is None:
            status = 428
        elif request['match'] != f'"v{version}"':
            status = 412
        elif request['take'] > quantity:
            status = 409
        else:
            quantity -= request['take']
            version += 1
            status = 200
        statuses.append(status)
    return dict(statuses=statuses, quantity=quantity, etag=f'"v{version}"')


def idempotency(d):
    balance, cache, statuses, receipts = d['balance'], {}, [], []
    for request in d['requests']:
        receipt = None
        if request['op'] == 'deposit':
            balance += request['amount']
            status = 204
        elif request['key'] in cache:
            amount, cached_receipt = cache[request['key']]
            status = 201 if amount == request['amount'] else 409
            if status == 201:
                receipt = cached_receipt
        elif balance < request['amount']:
            status = 422
        else:
            balance -= request['amount']
            status, receipt = 201, f'r{len(cache) + 1}'
            cache[request['key']] = request['amount'], receipt
        statuses.append(status)
        receipts.append(receipt)
    return dict(statuses=statuses, receipts=receipts, balance=balance, charge_count=len(cache))


def authorization(d):
    statuses, user = [], d['user']
    for request in d['requests']:
        document = d['documents'].get(str(request['id']))
        if document is None or document['team'] != user['team']:
            status = 404
        elif request['action'] == 'GET':
            status = 200
        elif document['owner'] == user['id'] or user['role'] == 'admin':
            status = 200
        else:
            status = 403
        statuses.append(status)
    return dict(statuses=statuses)


def transaction(d):
    stock, balance, orders, outcomes = d['stock'], d['balance'], 0, []
    for request in d['requests']:
        proposed_stock = stock - request['qty']
        proposed_balance = balance - request['qty'] * request['price']
        if proposed_stock < 0 or proposed_balance < 0:
            outcomes.append('rolled_back')
        else:
            stock, balance, orders = proposed_stock, proposed_balance, orders + 1
            outcomes.append('committed')
    return dict(outcomes=outcomes, stock=stock, balance=balance, orders=orders)


def pagination(d):
    page = sorted((tuple(row) for row in d['rows'] if tuple(row) < tuple(d['cursor'])), reverse=True)[:d['limit']]
    return dict(ids=[row[1] for row in page], next_cursor=list(page[-1]) if page else None)


def patch_profile(d):
    patch = d['patch']
    valid = ('age' not in patch or type(patch['age']) is int and 0 <= patch['age'] <= 150)
    valid = valid and ('nickname' not in patch or patch['nickname'] is None or isinstance(patch['nickname'], str))
    return dict(status=200 if valid else 422,
                profile={**d['profile'], **patch} if valid else deepcopy(d['profile']))


def rate(d):
    accepted, statuses, counts = [], [], []
    for timestamp in d['times']:
        accepted = [t for t in accepted if t > timestamp - d['window']]
        if len(accepted) < d['limit']:
            accepted.append(timestamp)
            statuses.append(200)
        else:
            statuses.append(429)
        counts.append(len(accepted))
    return dict(statuses=statuses, active_counts=counts)


def eventloop(d):
    logs, micros, timers = [], deque(), deque()

    def run(operations):
        for operation in operations:
            if operation['op'] == 'log':
                logs.append(operation['text'])
            elif operation['op'] == 'micro':
                micros.append(operation['body'])
            elif operation['op'] == 'timer':
                timers.append(operation['body'])
            else:
                raise ValueError('Unsupported operation')

    run(d['program'])
    while micros or timers:
        while micros:
            run(micros.popleft())
        if timers:
            run(timers.popleft())
    return logs


def cascade(d):
    candidates = []
    element = d['element']
    for index, rule in enumerate(d['rules']):
        selector = rule['selector']
        assert re.fullmatch(r'(?:[A-Za-z][\w-]*)?(?:[.#][\w-]+)*', selector)
        tag = re.match(r'^[A-Za-z][\w-]*', selector)
        ids = re.findall(r'#([\w-]+)', selector)
        classes = re.findall(r'\.([\w-]+)', selector)
        matches = (tag is None or tag.group() == element['tag'])
        matches = matches and all(item == element.get('id') for item in ids)
        matches = matches and all(item in element.get('classes', []) for item in classes)
        if matches:
            candidates.append(((bool(rule['important']), len(ids), len(classes), int(tag is not None), index), rule['color']))
    rank, color = max(candidates)
    return dict(color=color, rule_index=rank[-1])


def dom_events(d):
    logs, stopped, immediate = [], False, False

    def listeners(node, capture):
        nonlocal stopped, immediate
        for listener in d['listeners']:
            if listener['node'] != node or listener['capture'] != capture:
                continue
            logs.append(listener['label'])
            if listener['effect'] == 'stop':
                stopped = True
            elif listener['effect'] == 'immediate':
                stopped = immediate = True
                break

    for node in d['path'][:-1]:
        listeners(node, True)
        if stopped:
            return logs
    target = d['path'][-1]
    listeners(target, True)
    if not immediate:
        listeners(target, False)
    if stopped:
        return logs
    for node in reversed(d['path'][:-1]):
        listeners(node, False)
        if stopped:
            break
    return logs


def form(d):
    fields = []
    for control in d['controls']:
        if not control.get('name') or control.get('disabled'):
            continue
        if control['type'] in ('checkbox', 'radio') and not control.get('checked'):
            continue
        if control['type'] == 'submit' and control['id'] != d['submitter']:
            continue
        values = control['selected'] if control['type'] == 'select-multiple' else [control['value']]
        fields.extend([[control['name'], value] for value in values])
    return fields


def flex(d):
    free = Fraction(d['inner_width'] - sum(item['basis'] for item in d['items']))
    weights = [item['grow'] if free >= 0 else item['shrink'] * item['basis'] for item in d['items']]
    assert sum(weights) > 0
    widths = [Fraction(item['basis']) + free * Fraction(weight, sum(weights)) for item, weight in zip(d['items'], weights)]
    assert all(width >= 0 for width in widths)
    return dict(widths=[int(width) if width.denominator == 1 else float(width) for width in widths])


def state_queue(d):
    value = d['initial']
    for update in d['updates']:
        if update['type'] == 'replace_snapshot_delta':
            value = d['initial'] + update['delta']
        elif update['type'] == 'increment':
            value += update['delta']
        else:
            raise ValueError('Unsupported state operation')
    return dict(n=value)


def search_race(d):
    latest, identities, renders = 0, {}, []
    for event in d['events']:
        if event['op'] == 'start':
            latest += 1
            assert event['name'] not in identities
            identities[event['name']] = latest
        elif identities[event['name']] == latest:
            renders.append(dict(status='ready' if event['ok'] else 'error',
                                value=event['data'] if event['ok'] else event['error']))
    return dict(renders=renders, final=renders[-1] if renders else None)


def focus(d):
    focusable = []
    for position, element in enumerate(d['elements']):
        if element.get('hidden') or element.get('ancestor_hidden') or element.get('disabled'):
            continue
        tabindex = element.get('tabindex')
        if tabindex is None:
            if element['tag'] not in ('button', 'input') and not (element['tag'] == 'a' and 'href' in element):
                continue
            tabindex = 0
        if tabindex < 0:
            continue
        key = (0, tabindex, position) if tabindex > 0 else (1, 0, position)
        focusable.append((key, element['id']))
    return [name for _, name in sorted(focusable)]


def boundaries(d):
    required = {d['L'] + offset for offset in (-1, 0, 1)} | {d['U'] + offset for offset in (-1, 0, 1)}
    return dict(required=sorted(required), missing=sorted(required - set(d['existing'])))


def branches(d):
    covered, outputs = set(), []
    order = ['member:T', 'member:F', 'amount:T', 'amount:F']
    for test in d['tests']:
        member, threshold = test['member'], test['amount'] >= 100
        covered.add('member:' + ('T' if member else 'F'))
        covered.add('amount:' + ('T' if threshold else 'F'))
        outputs.append((10 if member else 0) + (5 if threshold else 0))
    return dict(outputs=outputs, covered=[x for x in order if x in covered], missing=[x for x in order if x not in covered])


def mcdc(d):
    rows = d['tests']
    decisions = [(row[0] and row[1]) or row[2] for row in rows]
    pairs = {key: [] for key in ('A', 'B', 'C')}
    for left, right in combinations(range(len(rows)), 2):
        changed = [i for i in range(3) if rows[left][i] != rows[right][i]]
        if len(changed) == 1 and decisions[left] != decisions[right]:
            pairs['ABC'[changed[0]]].append([left, right])
    return dict(decisions=decisions, pairs=pairs, missing=[key for key, values in pairs.items() if not values])


def fixture(d):
    shared, seen, failed = deepcopy(d['initial']), [], []
    for test in d['tests']:
        value = shared if d['shared'] else deepcopy(d['initial'])
        for operation in test['ops']:
            if operation['op'] == 'append':
                value.append(operation['value'])
            elif operation['op'] == 'clear':
                value.clear()
            else:
                raise ValueError('Unsupported fixture operation')
        seen.append(deepcopy(value))
        if value != test['expected']:
            failed.append(test['name'])
    return dict(seen=seen, failed=failed)


def sort_properties(d):
    original, value = list(d['values']), list(d['values'])
    if d['implementation'] == 'dedup':
        result = sorted(set(value))
    elif d['implementation'] == 'inplace':
        value.sort()
        result = value
    elif d['implementation'] == 'absolute':
        result = sorted(value, key=abs)
    else:
        raise ValueError('Unknown implementation')
    properties = dict(nondecreasing=all(a <= b for a, b in zip(result, result[1:])),
                      multiset_preserved=Counter(original) == Counter(result),
                      input_unchanged=original == value,
                      length_preserved=len(original) == len(result))
    return dict(result=result, input_after=value, violated=[key for key, passed in properties.items() if not passed])


def interleaving(d):
    counter, local, completed = d['initial'], {}, 0
    for thread, operation in d['trace']:
        if operation == 'read':
            local[thread] = counter
        elif operation == 'write':
            counter = local[thread] + 1
            completed += 1
        else:
            raise ValueError('Unknown thread operation')
    return dict(final=counter, lost_increments=d['initial'] + completed - counter)


def mutation(d):
    inputs = d['totals']
    expected = [0 if total >= 100 else 10 for total in inputs]
    mutants = dict(m1=[0 if total > 100 else 10 for total in inputs],
                   m2=[10 if total >= 100 else 0 for total in inputs],
                   m3=[0 if total >= 100 else 9 for total in inputs])
    return dict(expected=expected, killed=[name for name, values in mutants.items() if values != expected],
                survived=[name for name, values in mutants.items() if values == expected])


def boundary_contract(d):
    low, high = d['lower_exclusive'] + 1, d['upper_inclusive']
    return dict(effective_bounds=[low, high], **boundaries(dict(L=low, U=high, existing=d['existing'])))


ORACLES = dict(etag=etag, idempotency=idempotency, authorization=authorization,
               transaction=transaction, pagination=pagination, patch=patch_profile,
               rate=rate, eventloop=eventloop, cascade=cascade, dom_events=dom_events,
               form=form, flex=flex, state_queue=state_queue, search_race=search_race,
               focus=focus, boundaries=boundaries, boundary_contract=boundary_contract, branches=branches, mcdc=mcdc,
               fixture=fixture, sort_properties=sort_properties,
               interleaving=interleaving, mutation=mutation)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path, default=Path(__file__).with_name('software.json'))
    args = parser.parse_args()
    data = json.loads(args.catalog.read_text())
    required_family = ('family_id', 'domain', 'title', 'course', 'level', 'project_context',
                       'competency', 'prerequisites', 'misconception', 'misconception_probe',
                       'remediation_activity', 'next_activity', 'return_anchor', 'goal_a',
                       'goal_b', 'task_prompt', 'probes', 'source_basis')
    required_probe = ('id', 'prompt', 'artifact', 'correct_response', 'incorrect_response',
                      'explanation', 'observable_checks', 'novelty', 'answer_validation', 'oracle_id')
    assert len(data) == 24
    assert Counter(f['domain'] for f in data) == Counter(web_backend=8, frontend=8, testing=8)
    assert len({f['family_id'] for f in data}) == 24
    checked, reasoned = [], []
    per_domain = Counter()
    for family in data:
        assert all(field in family for field in required_family)
        assert re.fullmatch(r'[a-z0-9_]+', family['family_id'])
        assert family['level'] in ('foundation', 'intermediate', 'integrated')
        assert 2 <= len(family['prerequisites']) <= 4
        assert len(family['probes']) == 3
        assert [p['id'] for p in family['probes']] == ['base', 'near_transfer', 'delayed_transfer']
        assert len({p['artifact'] for p in family['probes']}) == 3
        for probe in family['probes']:
            assert all(field in probe for field in required_probe)
            assert all(probe[field] for field in ('prompt', 'artifact', 'correct_response', 'incorrect_response', 'explanation', 'observable_checks', 'novelty'))
            assert probe['correct_response'] != probe['incorrect_response']
            if probe['answer_validation'] == 'reasoned_draft':
                assert probe['oracle_id'] is None
                reasoned.append(family['family_id'] + '.' + probe['id'])
                continue
            assert probe['answer_validation'] == 'executable'
            assert probe['oracle_id'] == family['family_id'] + '.' + probe['id']
            oracle_input = probe['oracle_input']
            # The structured inputs must also be visible in the learner material;
            # no hidden oracle-only numbers or state may determine the answer.
            visible_input = {key: value for key, value in oracle_input.items() if key != 'kind'}
            assert json.dumps(visible_input, ensure_ascii=False, indent=2) in probe['artifact']
            expected = ORACLES[oracle_input['kind']](oracle_input)
            correct = json.loads(probe['correct_response'])
            incorrect = json.loads(probe['incorrect_response'])
            assert canonical(correct) == canonical(expected), (probe['oracle_id'], 'correct response mismatch', correct, expected)
            assert canonical(incorrect) != canonical(expected), (probe['oracle_id'], 'incorrect response accepted')
            checked.append(probe['oracle_id'])
            per_domain[family['domain']] += 1
    assert len(set(checked)) == len(checked)
    assert len(checked) + len(reasoned) == 72
    print(json.dumps(dict(catalog=str(args.catalog), family_count=len(data), probe_count=72,
                          checked_oracle_ids=checked, executable_count=len(checked),
                          executable_by_domain=dict(per_domain), reasoned_draft_ids=reasoned,
                          correct_responses_verified=len(checked), incorrect_responses_rejected=len(checked),
                          checks_performed=['schema and unique IDs', 'three distinct artifacts per family',
                                            'oracle inputs also present in visible artifacts',
                                            'independent bounded computation from task inputs',
                                            'correct response exact typed JSON equality',
                                            'incorrect response typed JSON inequality'],
                          teacher_review='pending', actual_browser_framework_runtime=False,
                          system_or_model_ablation_performed=False), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
