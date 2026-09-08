import json
import httpx
import pytest
from fastapi import FastAPI, Request
from app.core.config import settings
from app.services.cloud_connection import CloudConnection, cloud_origin


@pytest.fixture
def relay(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', True)
    monkeypatch.setattr(settings, 'desktop_token', 'native-only')
    seen = []
    def upstream(request):
        seen.append(request)
        assert 'x-learnflow-desktop-token' not in request.headers
        assert 'authorization' not in request.headers
        if request.url.path == '/api/auth/login':
            value = json.loads(request.content)
            if value.get('password') != 'valid':
                return httpx.Response(401, json={'detail': '用户名或密码错误'})
            return httpx.Response(200, json={'learner_id': value.get('id', 7), 'username': 'cloud'},
                                  headers={'set-cookie': 'session=private-cloud-cookie; Path=/; Secure; HttpOnly'})
        assert 'private-cloud-cookie' in request.headers.get('cookie', '')
        if request.url.path == '/api/auth/csrf':
            return httpx.Response(200, json={'csrf_token': 'cloud-csrf'})
        if request.method == 'POST':
            assert request.headers['x-csrf-token'] == 'cloud-csrf'
        if request.url.path == '/api/redirect':
            return httpx.Response(302, headers={'location': 'https://untrusted.example/api'})
        return httpx.Response(200, json={'ok': True})
    connection = CloudConnection('https://learn.example', httpx.MockTransport(upstream))
    app = FastAPI()
    @app.api_route('/{path:path}', methods=['GET','POST','PUT'])
    async def call(path: str, request: Request):
        return await connection.forward(request, path)
    return connection, app, seen


async def login(client, **extra):
    result = await client.post('/auth/login', json={'password': 'valid', **extra})
    assert result.status_code == 200
    assert 'set-cookie' not in result.headers
    assert 'private-cloud-cookie' not in result.text
    client.headers['Authorization'] = 'Bearer ' + result.json()['desktop_auth_token']
    return result.json()


@pytest.mark.asyncio
async def test_native_gate_cookie_csrf_and_logout(relay):
    connection, app, seen = relay
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
        assert (await client.post('/auth/login', json={'password':'valid'})).status_code == 403
        client.headers['X-LearnFlow-Desktop-Token'] = 'native-only'
        assert (await client.get('/auth/status')).json()['authenticated'] is False
        assert (await client.post('/auth/login', json={'password':'wrong'})).status_code == 401
        await login(client)
        assert (await client.post('/projects', json={'name':'test'})).status_code == 200
        assert (await client.get('/redirect')).status_code == 502
        assert (await client.post('/auth/logout')).status_code == 200
        assert (await client.get('/projects')).status_code == 401
    assert not connection.sessions


@pytest.mark.asyncio
async def test_account_switch_revokes_old_handle_and_pet_is_scoped(relay):
    connection, app, seen = relay
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        first = await login(client)
        await login(client, id=8)
        client.headers['Authorization'] = 'Bearer ' + first['desktop_auth_token']
        assert (await client.get('/projects')).status_code == 401
        current = await login(client)
        client.headers['Authorization'] = 'Bearer ' + current['desktop_pet_capability_token']
        assert (await client.get('/auth/model-credential')).status_code == 403
        assert (await client.post('/auth/login', json={'password':'valid'})).status_code == 403
        assert (await client.get('/agent/sessions')).status_code == 200
    await connection.close()


@pytest.mark.parametrize('url', ['http://example.com','https://user:password@example.com','https://example.com/path','https://example.com?q=1'])
def test_reject_untrusted_authority(url):
    with pytest.raises(ValueError): cloud_origin(url)


@pytest.mark.asyncio
async def test_conversion_import_is_native_main_only_and_dispatches_local_adapter(relay, monkeypatch):
    from fastapi.responses import JSONResponse
    from app.services import cloud_conversion_import
    connection, app, seen = relay
    called = []
    async def import_fake(session, origin, ticket, body):
        called.append((session.learner_id, origin, ticket, json.loads(body)))
        return JSONResponse({'status': 'imported', 'project_id': 11})
    monkeypatch.setattr(cloud_conversion_import, 'import_handoff', import_fake)
    path = '/desktop/conversions/' + 'a' * 43 + '/import'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
        assert (await client.post(path, json={})).status_code == 403
        client.headers['X-LearnFlow-Desktop-Token'] = 'native-only'
        assert (await client.post(path, json={})).status_code == 401
        account = await login(client)
        assert (await client.post(path, json={'confirmed': True})).status_code == 200
        client.headers['Authorization'] = 'Bearer ' + account['desktop_pet_capability_token']
        assert (await client.post(path, json={})).status_code == 403
    assert called == [(7, 'https://learn.example', 'a' * 43, {'confirmed': True})]
    assert not any('/desktop/conversions/' in str(request.url) for request in seen)
    await connection.close()
