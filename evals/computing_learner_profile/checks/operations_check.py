"""Independent stdlib oracles for synthetic computing tasks; no network or probe eval."""
from __future__ import annotations
import collections
import heapq
import ipaddress
import json
import math
from pathlib import Path


def compute(kind, d):
    if kind == 'subnet':
        net = ipaddress.ip_network(d['cidr'], strict=False)
        ip = ipaddress.ip_address(d['candidate'])
        return {'网络地址': str(net.network_address), '广播地址': str(net.broadcast_address),
                '可用主机数': net.num_addresses - 2,
                '候选可分配': ip in net and ip not in (net.network_address, net.broadcast_address)}
    if kind == 'route':
        ip = ipaddress.ip_address(d['destination'])
        rows = [r for r in d['routes'] if r.get('up', True) and ip in ipaddress.ip_network(r['prefix'])]
        longest = max(ipaddress.ip_network(r['prefix']).prefixlen for r in rows)
        rows = [r for r in rows if ipaddress.ip_network(r['prefix']).prefixlen == longest]
        metric = min(r['metric'] for r in rows)
        return {'前缀长度': longest, '下一跳': sorted(r['next_hop'] for r in rows if r['metric'] == metric)}
    if kind == 'acl':
        packet = d['packet']
        for r in d['rules']:
            match = (r['protocol'] in ('any', packet['protocol']) and
                     (r['src'] == 'any' or ipaddress.ip_address(packet['src']) in ipaddress.ip_network(r['src'])) and
                     (r['dst'] == 'any' or ipaddress.ip_address(packet['dst']) in ipaddress.ip_network(r['dst'])))
            for field in ('sport', 'dport'):
                limit = r.get(field)
                if limit is not None:
                    match = match and packet.get(field) is not None and limit[0] <= packet[field] <= limit[1]
            if match:
                return {'规则': r['id'], '动作': r['action']}
        return {'规则': 'implicit', '动作': 'deny'}
    if kind == 'tcp':
        received = set()
        duplicate = 0
        for start, size in d['segments']:
            data = set(range(start, start + size))
            duplicate += len(data & received)
            received |= data
        ack = d['initial_sequence']
        while ack in received:
            ack += 1
        return {'累计ACK': ack, '缺口后暂存字节': sum(x > ack for x in received), '重复字节': duplicate}
    if kind == 'fragment':
        mtu = min(d['path_mtu'])
        payload = d['payload_bytes']
        header = d['header_bytes']
        if payload + header > mtu and d['df']:
            return {'处理': '丢弃并报告需要分片', '出接口MTU': mtu}
        unit = ((mtu - header) // 8) * 8
        chunks, offset = [], 0
        while payload:
            size = min(payload, unit) if payload + header > mtu else payload
            payload -= size
            chunks.append({'数据字节': size, '偏移单位8字节': offset // 8, 'MF': int(payload > 0)})
            offset += size
        return {'分片': chunks}
    if kind == 'flow':
        rate = min(d['links_mbps'])
        window_rate = d['window_bytes'] * 8 / (d['rtt_ms'] / 1000) / 1000000
        label = '窗口' if window_rate < rate else '链路' if rate < window_rate else '二者相等'
        return {'吞吐上限Mbps': round(min(rate, window_rate), 4),
                '满速最小窗口字节': math.ceil(rate * 1000000 * d['rtt_ms'] / 1000 / 8), '限制因素': label}
    if kind == 'dns':
        q = d['query']
        entries = [r for r in d['cache'] if r['name'] == q['name'] and
                   (r['status'] == 'NXDOMAIN' or r['type'] == q['type']) and
                   r['stored_at'] + r['ttl'] > q['time']]
        if entries:
            r = max(entries, key=lambda x: x['stored_at'])
            return {'来源': '缓存', '状态': r['status'], '值': r.get('value'),
                    '剩余TTL秒': r['stored_at'] + r['ttl'] - q['time']}
        r = d['authoritative'][q['name'] + '/' + q['type']]
        return {'来源': '权威查询', '状态': r['status'], '值': r.get('value'), '剩余TTL秒': r['ttl']}
    if kind == 'rr':
        rows = sorted(enumerate(d['processes']), key=lambda t: (t[1]['arrival'], t[0]))
        remaining = {p['id']: p['burst'] for _, p in rows}
        queue, done, index, clock = collections.deque(), {}, 0, 0
        while len(done) < len(rows):
            while index < len(rows) and rows[index][1]['arrival'] <= clock:
                queue.append(rows[index][1]['id']); index += 1
            if not queue:
                clock = rows[index][1]['arrival']; continue
            pid = queue.popleft()
            for _ in range(min(d['quantum'], remaining[pid])):
                clock += 1; remaining[pid] -= 1
                while index < len(rows) and rows[index][1]['arrival'] <= clock:
                    queue.append(rows[index][1]['id']); index += 1
            if remaining[pid]: queue.append(pid)
            else: done[pid] = clock
        wait = sum(done[p['id']] - p['arrival'] - p['burst'] for _, p in rows) / len(rows)
        return {'完成时刻': dict(sorted(done.items())), '平均等待时间': round(wait, 4)}
    if kind == 'banker':
        work, sequence = d['available'][:], []
        while True:
            found = False
            for p in d['processes']:
                if p['id'] in sequence:
                    continue
                need = [m-a for m, a in zip(p['maximum'], p['allocated'])]
                if all(n <= w for n, w in zip(need, work)):
                    sequence.append(p['id']); work = [w+a for w, a in zip(work, p['allocated'])]
                    found = True; break
            if not found: break
        return {'安全': len(sequence) == len(d['processes']), '可完成序列': sequence,
                '未能证明可完成': [p['id'] for p in d['processes'] if p['id'] not in sequence]}
    if kind == 'lru':
        queue = d['initial_old_to_new'][:]
        misses = 0
        for page in d['references']:
            if page == 'FLUSH': queue.clear(); continue
            if page in queue: queue.remove(page)
            else:
                misses += 1
                if len(queue) == d['frames']: queue.pop(0)
            queue.append(page)
        return {'缺页次数': misses, '最终从旧到新': queue}
    if kind == 'permissions':
        if d['operation'] == 'create':
            return {'最终权限': format(int(d['requested_mode'], 8) & ~int(d['umask'], 8) & 0o777, '04o')}
        actor = d['actor']
        def bits(obj):
            shift = 6 if actor['uid'] == obj['owner'] else 3 if obj['group'] in actor['groups'] else 0
            return (int(obj['mode'], 8) >> shift) & 7
        for directory in d['directories']:
            if not bits(directory) & 1:
                return {'允许': False, '拒绝位置': directory['path']}
        required = {'read': 4, 'write': 2}[d['operation']]
        ok = bool(bits(d['file']) & required)
        return {'允许': ok, '拒绝位置': None if ok else d['file']['path']}
    if kind == 'raid':
        sizes, failed = d['capacity_tb'], set(d['failed_indexes'])
        if d['layout'] == 'raid10':
            capacity = sum(min(sizes[a], sizes[b]) for a, b in d['pairs'])
            usable = all(not ({a, b} <= failed) for a, b in d['pairs'])
        else:
            parity = {'raid5': 1, 'raid6': 2}[d['layout']]
            capacity = min(sizes) * (len(sizes) - parity)
            usable = len(failed) <= parity
        return {'标称可用容量TB': capacity, '故障后仍可读': usable}
    if kind == 'latency':
        samples = sorted(value for value, count in d['bins_ms_count'] for _ in range(count))
        n = len(samples)
        return {'样本数': n, 'p95毫秒': samples[math.ceil(.95*n)-1],
                'SLO通过率百分比': round(100*sum(x <= d['slo_ms'] for x in samples)/n, 4)}
    if kind == 'disk':
        rows = d['inodes']
        allocated = sum(r['physical_mb'] for r in rows if r['paths'] or r['open_handles'])
        visible = sum(r['physical_mb'] for r in rows if any(p.startswith(d['subtree']) for p in r['paths']))
        reclaim = sum(r['physical_mb'] for r in rows if not r['paths'] and r['open_handles'] and
                      set(r['open_handles']) <= set(d['close_handles']))
        return {'已分配MB': allocated, '目录可见唯一inode_MB': visible,
                '关闭指定句柄释放MB': reclaim, '关闭后已分配MB': allocated-reclaim}
    if kind == 'retry':
        markers, ledger, conflicts = {}, [], 0
        for request in d['requests']:
            key, amount = request['key'], request['amount']
            if key in markers:
                if markers[key] != amount: conflicts += 1
                continue
            if request['failure'] == 'after_charge' and d['transaction'] == 'atomic':
                continue
            ledger.append(amount)
            if request['failure'] != 'after_charge': markers[key] = amount
        return {'累计扣款': sum(ledger), '账本条数': len(ledger), '冲突拒绝次数': conflicts}
    if kind == 'metrics':
        if 'candidates' in d:
            eligible = [c for c in d['candidates'] if
                        c['tp']+c['fp'] <= d.get('max_alerts', math.inf) and
                        c['fp'] <= d.get('max_false_positives', math.inf)]
            if not eligible:
                return {'选定阈值': None, '总错误代价': None}
            costs = [(c['fp']*d['fp_cost']+c['fn']*d['fn_cost'], -c['threshold'], c) for c in eligible]
            cost, _, winner = min(costs)
            return {'选定阈值': winner['threshold'], '总错误代价': cost}
        tp, fp, fn, tn = [d[k] for k in ('tp','fp','fn','tn')]
        fn += d.get('abstained_positive', 0)
        tn += d.get('abstained_negative', 0)
        divide = lambda a,b: 100*a/b if b else 0
        return {'准确率百分比': round(divide(tp+tn,tp+fp+fn+tn),4),
                '精确率百分比': round(divide(tp,tp+fp),4), '召回率百分比': round(divide(tp,tp+fn),4),
                'F1百分比': round(divide(2*tp,2*tp+fp+fn),4)}
    if kind == 'drift':
        baseline = sum(r['reference_n'] for r in d['groups'])
        current = sum(r['current_n'] for r in d['groups'])
        old = sum(r['reference_errors'] for r in d['groups'])/baseline
        raw = sum(r['current_errors'] for r in d['groups'])/current
        standardized = sum(r['reference_n']/baseline*r['current_errors']/r['current_n'] for r in d['groups'])
        return {'基准错误率百分比': round(old*100,4), '当前原始错误率百分比': round(raw*100,4),
                '当前标准化错误率百分比': round(standardized*100,4),
                '触发分层退化告警': standardized-old > d['threshold_percentage_points']/100+1e-12}
    if kind == 'knn':
        rows = d['training']; width = len(rows[0]['x'])
        mean = [sum(r['x'][j] for r in rows)/len(rows) for j in range(width)]
        variance = [sum((r['x'][j]-mean[j])**2 for r in rows)/len(rows) for j in range(width)]
        query = [mean[j] if v is None else v for j,v in enumerate(d['query'])]
        distances = {r['id']: sum((v-query[j])**2/variance[j] for j,v in enumerate(r['x']) if variance[j]) for r in rows}
        best = min(distances.values())
        return {'最近样本': sorted(k for k,v in distances.items() if abs(v-best)<1e-9),
                '标准化距离平方': round(best,4), '忽略常量列下标': [j for j,v in enumerate(variance) if not v],
                '插补列下标': [j for j,v in enumerate(d['query']) if v is None]}
    if kind == 'nat':
        packet = d['packet']
        active = [m for m in d['mappings'] if m['expires_at'] > packet['time'] and m['protocol'] == packet['protocol']]
        if packet['direction'] == 'outbound':
            matches = [m for m in active if m['inside_ip'] == packet['src_ip'] and m['inside_port'] == packet['src_port'] and
                       (d['mapping_policy'] == 'endpoint_independent' or (m['remote_ip'], m['remote_port']) == (packet['dst_ip'], packet['dst_port']))]
            if not matches: return {'结果':'需要新建映射', '变换后地址':None}
            m = matches[0]
            return {'结果':'转发', '变换后地址':f"{m['outside_ip']}:{m['outside_port']}"}
        matches = [m for m in active if m['outside_ip'] == packet['dst_ip'] and m['outside_port'] == packet['dst_port']]
        if not matches: return {'结果':'无有效映射，丢弃', '变换后地址':None}
        m = matches[0]
        if d['filter_policy'] == 'address_port_dependent' and (m['remote_ip'],m['remote_port']) != (packet['src_ip'],packet['src_port']):
            return {'结果':'源端点不匹配，丢弃', '变换后地址':None}
        return {'结果':'转发', '变换后地址':f"{m['inside_ip']}:{m['inside_port']}"}
    if kind == 'group_split':
        train, test = [r for r in d['rows'] if r['split']=='train'], [r for r in d['rows'] if r['split']=='test']
        collisions = {}
        for key in d['must_disjoint_keys']:
            overlap = sorted({r[key] for r in train} & {r[key] for r in test})
            if overlap: collisions[key] = overlap
        violating = sorted(r['id'] for r in test if any(r[key] in vals for key,vals in collisions.items()))
        return {'跨集合重叠值':collisions, '受影响测试行':violating, '满足隔离约束':not collisions}
    if kind == 'temporal':
        eligible = [r for r in d['records'] if r['role']=='feature' and r['entity']==d['entity'] and
                    d['window_start'] <= r['event_time'] < d['prediction_time'] and r['available_at'] <= d['prediction_time']]
        return {'允许记录ID':sorted(r['id'] for r in eligible),
                '特征均值':round(sum(r['value'] for r in eligible)/len(eligible),4) if eligible else None}
    if kind == 'quality':
        valid, bad = [], 0
        for row in d['rows']:
            value = row.get('latency'); unit = row.get('unit')
            if not row.get('event_id') or type(value) not in (int,float) or unit not in ('ms','us'):
                bad += 1; continue
            normalized = value if unit=='ms' else value/1000
            if not 0 <= normalized <= 10000:
                bad += 1; continue
            valid.append((row['event_id'],normalized))
        groups = collections.defaultdict(list)
        for key,value in valid: groups[key].append(value)
        accepted, duplicate, conflict = {},0,0
        for key,values in groups.items():
            if len(set(values))>1: conflict += len(values)
            else:
                accepted[key] = values[0]; duplicate += len(values)-1
        return {'有效唯一事件ID':sorted(accepted),'无效行数':bad,'重复排除行数':duplicate,
                '冲突隔离行数':conflict,'平均延迟毫秒':round(sum(accepted.values())/len(accepted),4) if accepted else None}
    raise ValueError('Unknown oracle kind: '+kind)


def run(path=None):
    path = Path(path) if path else Path(__file__).with_name('operations.json')
    families = json.loads(path.read_text())
    checked, reasoned, errors = [], [], []
    counts = collections.Counter(f['domain'] for f in families)
    assert counts == {'networks':8, 'systems':8, 'data_ai':8}, counts
    assert len({f['family_id'] for f in families}) == 24
    for family in families:
        assert [p['id'] for p in family['probes']] == ['base','near_transfer','delayed_transfer']
        for probe in family['probes']:
            name = family['family_id']+'/'+probe['id']
            if probe['answer_validation'] == 'reasoned_draft':
                assert probe['oracle_id'] is None; reasoned.append(name); continue
            try:
                kind, data = probe['oracle_kind'], probe['oracle_input']
                assert json.dumps(data, ensure_ascii=False, indent=2) in probe['artifact'], 'oracle inputs differ from visible artifact'
                actual = compute(kind, data)
                correct = json.loads(probe['correct_response'].split('：',1)[1])
                incorrect = json.loads(probe['incorrect_response'].split('：',1)[1])
                assert correct == actual, {'stored':correct, 'computed':actual}
                assert incorrect != actual, 'incorrect response is actually correct'
                assert probe['oracle_id'] not in checked, 'duplicate oracle id'
                checked.append(probe['oracle_id'])
            except Exception as error:
                errors.append({'probe':name,'error_type':type(error).__name__,'error':str(error)})
    result = {'families':len(families),'probes':sum(len(f['probes']) for f in families),
              'domain_counts':dict(counts),'checked_count':len(checked),'checked_oracle_ids':checked,
              'reasoned_draft_count':len(reasoned),'reasoned_draft_probes':reasoned,
              'checks':['visible inputs equal oracle inputs','independent algorithm recomputation',
                        'stored correct response equals computation','stored incorrect response differs',
                        'unique oracle IDs','domain and family/probe counts'], 'errors':errors}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return not errors


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path)
    args = parser.parse_args()
    raise SystemExit(0 if run(args.catalog) else 1)
