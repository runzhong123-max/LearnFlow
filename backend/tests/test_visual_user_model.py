"""BYOK golden: supplied credential only, private work lifecycle, bounded public egress."""
import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import settings
from learnflow_core.visuals import user_model as provider
from learnflow_core.api import visuals
from test_visual_workspace import register, call

CONFIG = {'base_url': 'https://model.example/v1', 'model': 'my-model', 'api_key': 'synthetic-user-secret-for-test'}
STORY = {'story_version': '1', 'title': '请求与响应', 'goal': '看清双向消息',
         'nodes': [{'id': 'client', 'label': '客户端'}, {'id': 'server', 'label': '服务端'}],
         'edges': [{'id': 'request', 'from': 'client', 'to': 'server', 'label': '请求'}, {'id': 'response', 'from': 'server', 'to': 'client', 'label': '响应'}],
         'steps': [{'title': '发出请求', 'note': '客户端发出请求。', 'active_nodes': ['client'], 'active_edges': ['request']},
                   {'title': '返回响应', 'note': '服务端返回响应。', 'active_nodes': ['server'], 'active_edges': ['response']}]}


def test_byok_auth_ownership_no_platform_fallback_and_private_publish(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', False)
    monkeypatch.setattr(settings, 'desktop_token', '')
    monkeypatch.setattr(settings, 'llm_api_key', 'synthetic-platform-must-not-be-used')
    calls = []
    async def completion(config, prompt, testing=False):
        calls.append((config.copy(), prompt, testing))
        return {'ok': True} if testing else {'text': json.dumps({'source_mode': 'fresh', 'builder': 'svg_story', 'source': STORY})}
    monkeypatch.setattr(provider, 'post_completion', completion)
    with TestClient(app) as client:
        assert client.post('/api/visuals/user-model', json={'operation': 'test', 'config': CONFIG}).status_code == 401
        register(client, 'hub_byok_owner')
        assert client.post('/api/visuals/user-model', json={'operation': 'test', 'config': {}}).status_code == 422
        assert not calls
        r = client.post('/api/visuals/user-model', json={'operation': 'test', 'config': CONFIG})
        assert r.status_code == 200 and r.json() == {'ok': True} and r.headers['cache-control'] == 'no-store'
        before_gallery = client.post('/api/visuals/gallery', json={'query': '请求与响应'}).json()
        job = call(client, 'start_job', {'request_id': 'hub-byok', 'request': '请求与响应', 'kind': 'animation', 'source_mode': 'fresh'})
        request = {'operation': 'generate', 'config': CONFIG, 'job_id': job['job_id'], 'prompt': '生成请求与响应动画'}
        r = client.post('/api/visuals/user-model', json=request)
        assert r.status_code == 200
        assert calls[-1][0]['api_key'] == CONFIG['api_key'] and calls[-1][0]['model'] == CONFIG['model']
        assert CONFIG['api_key'] not in r.text
        candidate = json.loads(r.json()['text'])
        artifact = call(client, 'publish', {'job_id': job['job_id'], 'expected_version': job['version'], 'builder': candidate['builder'], 'source': candidate['source']})
        saved = call(client, 'read', {'revision_id': artifact['revision_id']})
        assert len(saved['scenes']) == 2
        assert CONFIG['api_key'] not in json.dumps(saved) + json.dumps(call(client, 'get_job', {'job_id': job['job_id']}))
        assert client.post('/api/visuals/user-model', json=request).status_code == 409
        assert client.post('/api/visuals/gallery', json={'query': '请求与响应'}).json() == before_gallery
        register(client, 'hub_byok_other')
        assert client.post('/api/visuals/user-model', json=request).status_code == 404
        call(client, 'read', {'revision_id': artifact['revision_id']}, 404)
        assert len(calls) == 2
    assert not visuals._user_model_active


@pytest.mark.parametrize('base', ['http://model.example/v1', 'https://user:key@model.example', 'https://model.example/?token=x', 'https://model.example/#x', 'https://model.example/\nfoo'])
def test_base_url_rejects_unsafe_syntax(base):
    with pytest.raises(provider.UserModelError): provider.configuration({**CONFIG, 'base_url': base})


def test_endpoint_normalization_and_private_addresses():
    assert provider.configuration(CONFIG)['url'] == 'https://model.example/v1/chat/completions'
    assert provider.configuration({**CONFIG, 'base_url': 'https://model.example/v1/chat/completions/'})['url'] == 'https://model.example/v1/chat/completions'
    for address in ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', '224.0.0.1', '2002:7f00:1::']:
        with pytest.raises(provider.UserModelError): provider.public_address(address)
    assert provider.public_address('8.8.8.8') == '8.8.8.8'


def test_dns_is_pinned_to_checked_numeric_ip(monkeypatch):
    connected = []
    async def connect(self, host, port, timeout=None, **kwargs): connected.append(host); return 'socket'
    monkeypatch.setattr(provider.AutoBackend, 'connect_tcp', connect)
    async def run():
        loop = asyncio.get_running_loop()
        async def public(*args, **kwargs): return [(None, None, None, None, ('8.8.8.8', 443))]
        monkeypatch.setattr(loop, 'getaddrinfo', public)
        assert await provider.PublicNetworkBackend().connect_tcp('model.example', 443) == 'socket'
        async def mixed(*args, **kwargs): return [(None, None, None, None, ('8.8.8.8', 443)), (None, None, None, None, ('127.0.0.1', 443))]
        monkeypatch.setattr(loop, 'getaddrinfo', mixed)
        with pytest.raises(provider.UserModelError): await provider.PublicNetworkBackend().connect_tcp('model.example', 443)
    asyncio.run(run())
    assert connected == ['8.8.8.8']


def test_provider_protocol_redaction_redirects_and_output_bounds(monkeypatch):
    status, response_body = 200, b''
    requests = []
    class Response:
        @property
        def status(self): return status
        async def aiter_stream(self): yield response_body
    class Pool:
        def __init__(self, **kwargs): assert kwargs['retries'] == 0 and isinstance(kwargs['network_backend'], provider.PublicNetworkBackend)
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        @asynccontextmanager
        async def stream(self, method, url, **kwargs):
            requests.append((method, url, kwargs)); yield Response()
    monkeypatch.setattr(provider.httpcore, 'AsyncConnectionPool', Pool)
    config = provider.configuration(CONFIG)
    response_body = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': '{"ok":true}'}}]}).encode()
    assert asyncio.run(provider.post_completion(config, 'private brief')) == {'text': '{"ok":true}'}
    _, url, request = requests[-1]
    assert url == config['url'] and request['headers']['Authorization'] == 'Bearer ' + CONFIG['api_key']
    assert CONFIG['api_key'].encode() not in request['content']
    for status, response_body, code in [(302, b'private redirect', 'provider_unavailable'), (401, CONFIG['api_key'].encode(), 'credential_rejected'), (429, b'quota', 'provider_rate_limit'), (200, b'x' * 1000001, 'provider_output_large'), (200, b'{}', 'provider_format_invalid'), (200, json.dumps({'choices': [{'message': {'content': CONFIG['api_key']}}]}).encode(), 'provider_unsafe_response')]:
        with pytest.raises(provider.UserModelError) as caught: asyncio.run(provider.post_completion(config, 'brief'))
        assert caught.value.code == code and CONFIG['api_key'] not in str(caught.value)


def test_failed_model_call_releases_slot_and_redacts_errors(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', False); monkeypatch.setattr(settings, 'desktop_token', '')
    async def fail(*args): raise provider.UserModelError('credential_rejected', '请检查密钥。')
    monkeypatch.setattr(provider, 'post_completion', fail)
    with TestClient(app) as client:
        register(client, 'hub_byok_failure')
        for _ in range(2):
            response = client.post('/api/visuals/user-model', json={'operation': 'test', 'config': CONFIG})
            assert response.status_code == 422 and response.json()['code'] == 'visual_user_model:credential_rejected'
            assert not visuals._user_model_active


def test_svg_story_reverse_edge_labels_are_separated():
    from xml.etree import ElementTree as ET
    from learnflow_core.visuals.svg_story import compile_svg_story
    scene = ET.fromstring(compile_svg_story(STORY, 'animation')['scenes'][0]['svg'])
    labels = [node for node in scene.iter() if node.tag.endswith('text') and node.text in ('请求', '响应')]
    assert len(labels) == 2 and abs(float(labels[0].attrib['y']) - float(labels[1].attrib['y'])) >= 20


def test_concurrent_model_calls_are_not_duplicated(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    monkeypatch.setattr(settings, 'desktop_mode', False); monkeypatch.setattr(settings, 'desktop_token', '')
    started, release = threading.Event(), threading.Event()
    async def completion(*args):
        started.set()
        while not release.is_set(): await asyncio.sleep(.01)
        return {'ok': True}
    monkeypatch.setattr(provider, 'post_completion', completion)
    with TestClient(app) as client:
        register(client, 'hub_byok_concurrent')
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(client.post, '/api/visuals/user-model', json={'operation': 'test', 'config': CONFIG})
            try:
                assert started.wait(3)
                second = client.post('/api/visuals/user-model', json={'operation': 'test', 'config': CONFIG})
                assert second.status_code == 409 and second.json()['code'] == 'visual_user_model:request_in_progress'
            finally: release.set()
            assert first.result().status_code == 200
    assert not visuals._user_model_active
