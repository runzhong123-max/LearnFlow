"""Recompute original synthetic task answers from bounded structured inputs.

No Python probe text is eval/exec'd. SQL executes only in a fresh in-memory
SQLite connection with a restrictive authorizer and a progress budget.
"""
import argparse
import bisect
import collections
import copy
import csv
import hashlib
import io
import itertools
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

ROOT = Path(__file__).resolve().parent
PREFIX = '我的结果是：'


def program(data):
    kind = data['kind']
    if kind == 'aliases':
        variables = copy.deepcopy(data['initial'])
        for step in data['steps']:
            if step['op'] in {'bind', 'shallow_copy', 'deep_copy'}:
                value = variables[step['src']]
                variables[step['dst']] = (value if step['op'] == 'bind' else
                    copy.copy(value) if step['op'] == 'shallow_copy' else copy.deepcopy(value))
            elif step['op'] == 'append':
                target = variables[step['var']]
                for index in step.get('path', []):
                    target = target[index]
                target.append(copy.deepcopy(step['value']))
            else:
                raise AssertionError('unknown finite operation')
        return {key: variables[key] for key in data['outputs']}
    if kind == 'division':
        a, b = data['a'], data['b']
        q, r = divmod(a, b)
        assert a == b * q + r and (0 <= r < b if b > 0 else b < r <= 0)
        return [q, r]
    if kind == 'defaults':
        shared = []
        outputs = []
        for call in data['calls']:
            if data['mode'] == 'shared_default':
                bucket = shared if 'bucket' not in call else copy.deepcopy(call['bucket'])
            else:
                bucket = copy.deepcopy(call.get('bucket'))
                if bucket is None:
                    bucket = []
            bucket.append(call['value'])
            outputs.append(list(bucket))
        return outputs
    if kind == 'guards':
        outputs = []
        for xs in data['values']:
            try:
                if data['mode'] == 'safe':
                    result = xs is not None and len(xs) > 0 and xs[0] > data['limit']
                elif data['mode'] == 'unsafe_order':
                    result = len(xs) > 0 and xs is not None and xs[0] > data['limit']
                elif data['mode'] == 'fallback':
                    result = xs[0] if xs else data['fallback']
                else:
                    raise AssertionError('unknown guard')
            except TypeError:
                result = 'TypeError'
            outputs.append(result)
        return outputs
    if kind == 'finally':
        log = []
        def job():
            try:
                log.append('open')
                if data['raise_body']:
                    raise ValueError('fixture')
                return data['body_value']
            finally:
                log.append('close')
                if data['override']:
                    return data['final_value']
        try:
            value, error = job(), None
        except ValueError:
            value, error = None, 'ValueError'
        return {'result': value, 'error': error, 'log': log}
    if kind == 'unicode':
        value = data['text']
        normalized = unicodedata.normalize('NFC', value)
        try:
            prefix = value.encode('utf-8')[:data['prefix_bytes']].decode('utf-8')
        except UnicodeDecodeError:
            prefix = 'UnicodeDecodeError'
        return {'characters': len(value), 'utf8_bytes': len(value.encode('utf-8')),
                'nfc_characters': len(normalized), 'nfc_bytes': len(normalized.encode('utf-8')), 'prefix': prefix}
    if kind == 'csv_totals':
        totals, rejected = {}, []
        for number, row in enumerate(csv.DictReader(io.StringIO(data['csv'])), 1):
            try:
                sku = row['sku'].strip().casefold()
                amount = int(row['qty'])
                if not sku or amount < 0:
                    raise ValueError('invalid row')
                totals[sku] = totals.get(sku, 0) + amount
            except (TypeError, ValueError, KeyError):
                rejected.append(number)
        return {'totals': totals, 'rejected_data_rows': rejected}
    if kind == 'packet':
        packet = bytes(data['bytes'])
        if len(packet) < 3:
            return {'status': 'length_error'}
        length = int.from_bytes(packet[:2], data['byteorder'])
        if len(packet) != length + 3:
            return {'status': 'length_error'}
        body = packet[2:-1]
        if sum(body) % 256 != packet[-1]:
            return {'status': 'checksum_error'}
        return {'status': 'ok', 'length': length, 'payload': list(body)}
    raise AssertionError(f'unknown programming oracle {kind}')


def algorithm(data):
    kind = data['kind']
    if kind == 'lower_bound':
        assert data['values'] == sorted(data['values'])
        return bisect.bisect_left(data['values'], data['target'])
    if kind == 'stable_insertion':
        items = data['items']
        inversions = sum(items[i][0] > items[j][0] for i in range(len(items)) for j in range(i + 1, len(items)))
        return {'items': sorted(items, key=lambda item: item[0]), 'shifts': inversions}
    if kind == 'bfs':
        # Enumerate simple paths instead of copying the learner-facing BFS loop.
        graph, start, target = data['graph'], data['start'], data['target']
        def distances(node, seen):
            if node == target:
                return [len(seen) - 1]
            return [length for nxt in graph.get(node, []) if nxt not in seen
                    for length in distances(nxt, seen + [nxt])]
        paths = distances(start, [start])
        return min(paths) if paths else None
    if kind == 'dijkstra':
        # Bellman-Ford is an independent shortest-distance oracle for these
        # small, nonnegative graphs; unreachable is serialized as null.
        distances = {node: None for node in data['nodes']}
        distances[data['start']] = 0
        for _ in range(len(distances) - 1):
            for a, b, weight in data['edges']:
                assert weight >= 0
                if distances[a] is not None and (distances[b] is None or distances[a] + weight < distances[b]):
                    distances[b] = distances[a] + weight
        return distances
    if kind == 'topological':
        remaining, order = set(data['nodes']), []
        while remaining:
            ready = sorted(node for node in remaining if not any(b == node and a in remaining for a, b in data['edges']))
            if not ready:
                break
            order.append(ready[0])
            remaining.remove(ready[0])
        return {'order': order, 'blocked': sorted(remaining)}
    if kind == 'intervals':
        best = 0
        for mask in range(1 << len(data['intervals'])):
            subset = [interval for i, interval in enumerate(data['intervals']) if mask & (1 << i)]
            valid = all((a[1] <= b[0] or b[1] <= a[0]) if data['boundary'] == 'half_open'
                        else (a[1] < b[0] or b[1] < a[0]) for a, b in itertools.combinations(subset, 2))
            if valid:
                score = sum(interval[2] for interval in subset) if data['objective'] == 'weight' else len(subset)
                best = max(best, score)
        return best
    if kind == 'coins':
        coins, amount = data['coins'], data['amount']
        caps = data.get('counts') or [amount // coin for coin in coins]
        solutions = [sum(counts) for counts in itertools.product(*(range(cap + 1) for cap in caps))
                     if sum(n * coin for n, coin in zip(counts, coins)) == amount]
        return min(solutions) if solutions else None
    if kind == 'linear_hash':
        slots, results = [None] * data['size'], []
        tombstone = 'DELETED'
        for operation, key in data['operations']:
            sequence = [(key + offset) % data['size'] for offset in range(data['size'])]
            found = None
            for index in sequence:
                if slots[index] is None:
                    break
                if slots[index] == key:
                    found = index
                    break
            if operation == 'get':
                results.append(found)
            elif operation == 'delete':
                if found is not None:
                    slots[found] = tombstone
            elif operation == 'put':
                if found is None:
                    empty = next((i for i in sequence if slots[i] in (None, tombstone)), None)
                    if empty is None:
                        raise AssertionError('fixture insert exceeds capacity')
                    slots[empty] = key
            else:
                raise AssertionError('unknown hash operation')
        return {'slots': slots, 'get_indexes': results}
    raise AssertionError(f'unknown algorithm oracle {kind}')


def sql_oracle(data):
    connection = sqlite3.connect(':memory:', isolation_level=None)
    connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 100000)
    try:
        for table in data['tables']:
            assert re.fullmatch('[a-z_][a-z_0-9]*', table['name'])
            for name, datatype in table['columns']:
                assert re.fullmatch('[a-z_][a-z_0-9]*', name)
                assert datatype in ('INTEGER', 'TEXT')
            columns = ','.join('"' + name + '" ' + datatype for name, datatype in table['columns'])
            constraints = table.get('constraints', [])
            assert all(re.fullmatch(r'UNIQUE\([a-z_, ]+\)', constraint) for constraint in constraints)
            ddl = columns + (',' + ','.join(constraints) if constraints else '')
            connection.execute(f'CREATE TABLE "{table["name"]}" ({ddl})')
            placeholders = ','.join('?' for _ in table['columns'])
            for row in table['rows']:
                connection.execute(f'INSERT INTO "{table["name"]}" VALUES ({placeholders})', row)
        forbidden = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_PRAGMA,
                     sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_ALTER_TABLE}
        def authorize(action, arg1, arg2, _database, _trigger):
            if action in forbidden or (action == sqlite3.SQLITE_FUNCTION and str(arg2).lower() in ('load_extension', 'writefile', 'readfile')):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        connection.set_authorizer(authorize)
        ticks = [0]
        def progress():
            ticks[0] += 1
            return int(ticks[0] > 1000)
        connection.set_progress_handler(progress, 1000)
        errors = []
        for statement in data.get('operations', []):
            assert re.match(r'^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|UPDATE|INSERT)\b', statement, re.I)
            try:
                connection.execute(statement)
                errors.append(None)
            except sqlite3.IntegrityError:
                errors.append('IntegrityError')
        assert re.match(r'^(SELECT|WITH)\b', data['query'], re.I)
        cursor = connection.execute(data['query'])
        rows = [list(row) for row in cursor.fetchmany(129)]
        assert len(rows) <= 128
        return {'errors': errors, 'rows': rows} if data.get('report_errors') else rows
    finally:
        connection.close()


def parse_response(text):
    assert text.startswith(PREFIX)
    return json.loads(text[len(PREFIX):])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalog_path', nargs='?', type=Path)
    parser.add_argument('--catalog', type=Path)
    args = parser.parse_args()
    path = args.catalog or args.catalog_path or ROOT / 'foundations.json'
    families = json.loads(path.read_text())
    assert isinstance(families, list) and len(families) == 24
    counts = collections.Counter(family['domain'] for family in families)
    assert counts == {'programming': 8, 'algorithms': 8, 'databases': 8}
    assert len({family['family_id'] for family in families}) == 24
    checked = []
    for family in families:
        assert [probe['id'] for probe in family['probes']] == ['base', 'near_transfer', 'delayed_transfer']
        for probe in family['probes']:
            assert probe['answer_validation'] == 'executable'
            data = probe['oracle_input']
            assert json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) in probe['artifact']
            if family['domain'] == 'databases':
                assert data['query'] in probe['artifact']
                actual = sql_oracle(data)
            elif family['domain'] == 'programming':
                actual = program(data)
            else:
                actual = algorithm(data)
            assert parse_response(probe['correct_response']) == actual, (probe['oracle_id'], actual, probe['correct_response'])
            assert parse_response(probe['incorrect_response']) != actual, ('incorrect answer accepted', probe['oracle_id'])
            checked.append(probe['oracle_id'])
    assert len(checked) == len(set(checked)) == 72
    print(json.dumps({'families': len(families), 'domain_counts': counts,
        'checked_probes': len(checked), 'checked_oracle_ids': checked,
        'checks_per_probe': ['artifact_contains_exact_structured_input', 'correct_response_matches_recomputation',
                             'incorrect_response_differs_from_recomputation'],
        'sql_version': sqlite3.sqlite_version, 'dataset_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'limitations': ['No teacher or independent human review', 'Python display code is not executed',
                       'No evaluation of learner ability or remediation effectiveness']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
