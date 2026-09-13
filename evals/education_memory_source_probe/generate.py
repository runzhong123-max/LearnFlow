"""Deterministic post-hoc calibration inputs; no retrieval/scoring imports."""
import json
from pathlib import Path

TOPICS = (
    ('binary_search', '二分查找', '区间中点定位已完成', '仅有序整数数组通过，重复值边界尚未验证'),
    ('lru_cache', 'LRU缓存', '最近最少使用淘汰轨迹已记录', '仅单线程通过，并发访问尚未验证'),
    ('transaction', '事务隔离', '隔离级别的读写日志已整理', '仅读已提交完成，可串行化隔离尚未验证'),
    ('dijkstra', 'Dijkstra最短路径', '非负权最短路径样例已走通', '仅非负边权通过，负权边情形不适用'),
    ('tcp', 'TCP重传', '重传序列号对照已记录', '仅单次丢包完成，连续丢包尚未验证'),
    ('container', '容器端口映射', '容器端口映射已观察', '仅本机回环地址通过，跨主机通信尚未验证'),
    ('asyncio', 'Python协程', '协程切换顺序已记录', '仅无共享状态通过，共享变量竞争尚未验证'),
    ('validation', '训练验证划分', '训练验证划分已检查', '仅同分布样本通过，分布漂移尚未验证'),
)
PATTERNS = ('early', 'tail', 'split_qualifier')
FILLER = '我把练习过程逐段记录，以便下次继续核对。'


def pad(text, size):
    return text + (FILLER * (size // len(FILLER) + 1))[:max(0, size - len(text))]


def cases():
    result = []
    for topic, label, term, qualifier in TOPICS:
        for pattern in PATTERNS:
            prefix = f'我不懂{label}，请保留这次学习练习的实际边界。'
            observation, condition = f'本次观察：{term}。', f'限制条件：{qualifier}。'
            if pattern == 'early':
                text = prefix + observation + condition
            elif pattern == 'tail':
                text = pad(prefix, 310) + '。' + observation + condition
            else:
                text = pad(prefix + observation, 330) + '。' + condition
            text = pad(text, 460)
            assert len(text) == 460 and text.count(term) == text.count(qualifier) == 1
            result.append({'case_id': f'source-probe-{topic}-{pattern}', 'topic_id': topic,
                'topic': label, 'pattern': pattern, 'event_type': 'user_message',
                'text': text, 'query': f'{label}本次练习的观察与限制是什么？',
                'target_term': term, 'qualifier': qualifier,
                'term_offset': text.index(term), 'qualifier_offset': text.index(qualifier),
                'event_time': '2026-09-01T09:00:00', 'read_time': '2026-09-01T12:00:00'})
    return sorted(result, key=lambda c:c['case_id'])


if __name__ == '__main__':
    path = Path(__file__).with_name('data')/'cases.jsonl'
    with path.open('x', encoding='utf-8') as stream:
        for row in cases():
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True)+'\n')
    print(f'Prepared {len(cases())} cases; no retrieval or model executed.')
