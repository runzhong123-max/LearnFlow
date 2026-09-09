import json
import httpx
import pytest
from fastapi import FastAPI, Request
from app.core.config import settings
from app.services.cloud_connection import CloudConnection, cloud_origin

VALID_KEY = "lfak_" + "a" * 43
OTHER_KEY = "lfak_" + "b" * 43


@pytest.fixture
def relay(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', True)
    monkeypatch.setattr(settings, 'desktop_token', 'native-only')
    seen = []
    def upstream(request):
        seen.append(request)
        assert 'x-learnflow-desktop-token' not in request.headers
        assert 'cookie' not in request.headers
        assert 'x-csrf-token' not in request.headers
        assert request.headers['authorization'] in {'Bearer ' + VALID_KEY, 'Bearer ' + OTHER_KEY}
        if request.url.path == '/api/auth/me':
            return httpx.Response(200, json={'learner_id': 8 if request.headers['authorization'].endswith(OTHER_KEY) else 7,
                                           'username': 'cloud'},
                                 headers={'set-cookie': 'session=private-cloud-cookie; Path=/; Secure; HttpOnly'})
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
    result = await client.post('/auth/api-key/connect', json={'api_key': OTHER_KEY if extra.get('id') == 8 else VALID_KEY})
    assert result.status_code == 200, result.text
    assert 'set-cookie' not in result.headers
    assert 'private-cloud-cookie' not in result.text
    assert VALID_KEY not in result.text and OTHER_KEY not in result.text
    client.headers['Authorization'] = 'Bearer ' + result.json()['desktop_auth_token']
    return result.json()


@pytest.mark.asyncio
async def test_native_gate_key_only_and_offline_logout(relay):
    connection, app, seen = relay
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local') as client:
        assert (await client.post('/auth/api-key/connect', json={'api_key':VALID_KEY})).status_code == 403
        client.headers['X-LearnFlow-Desktop-Token'] = 'native-only'
        assert (await client.get('/auth/status')).json()['authenticated'] is False
        assert (await client.post('/auth/login', json={'password':'wrong'})).status_code == 403
        assert (await client.post('/auth/api-key/connect', json={'api_key':'wrong'})).status_code == 422
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
        assert (await client.post('/auth/api-key/connect', json={'api_key':VALID_KEY})).status_code == 403
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


@pytest.mark.asyncio
async def test_invalid_key_does_not_expose_upstream_body_or_cookie(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', True)
    monkeypatch.setattr(settings, 'desktop_token', 'native-only')
    def upstream(request):
        return httpx.Response(401, json={'detail': VALID_KEY}, headers={'set-cookie': 'unsafe=secret'})
    connection = CloudConnection('https://8.148.28.98', httpx.MockTransport(upstream))
    app = FastAPI()
    @app.post('/{path:path}')
    async def call(path: str, request: Request):
        return await connection.forward(request, path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        response = await client.post('/auth/api-key/connect', json={'api_key':VALID_KEY})
        assert response.status_code == 401
        assert VALID_KEY not in response.text and 'set-cookie' not in response.headers
    assert not connection.sessions


@pytest.mark.asyncio
async def test_disconnect_cancels_pending_connect(relay):
    import asyncio
    connection, app, seen = relay
    started, release = asyncio.Event(), asyncio.Event()
    async def slow_upstream(request):
        started.set()
        await release.wait()
        return httpx.Response(200, json={'learner_id':7})
    connection.transport = httpx.MockTransport(slow_upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        pending = asyncio.create_task(client.post('/auth/api-key/connect', json={'api_key':VALID_KEY}))
        await started.wait()
        assert (await client.post('/auth/logout')).status_code == 200
        release.set()
        assert (await pending).status_code == 409
    assert not connection.sessions and not connection.pet_handles


@pytest.mark.asyncio
async def test_key_never_sent_to_other_authority_or_non_api(relay):
    connection, app, seen = relay
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        await login(client)
        session = next(iter(connection.sessions.values()))
        for url in ['http://learn.example/api/projects', 'https://evil.example/api/projects',
                    'https://learn.example:444/api/projects', 'https://learn.example/login']:
            before = len(seen)
            with pytest.raises(ValueError):
                await session.client.get(url)
            assert len(seen) == before
        await client.post('/auth/logout')


@pytest.mark.asyncio
async def test_revoked_key_invalidates_local_and_pet_handles(relay):
    connection, app, seen = relay
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        account = await login(client)
        session = next(iter(connection.sessions.values()))
        # Switching only the mock handler represents revocation on the server.
        session.client._transport = httpx.MockTransport(lambda request: httpx.Response(401, json={'detail':'revoked'}))
        assert (await client.get('/projects')).status_code == 401
        assert not connection.sessions and not connection.pet_handles
        client.headers['Authorization'] = 'Bearer ' + account['desktop_pet_capability_token']
        assert (await client.get('/agent/sessions')).status_code == 401


@pytest.mark.asyncio
async def test_disconnect_during_old_client_cleanup_cannot_publish_new_identity(relay):
    import asyncio
    connection, app, seen = relay
    started, release = asyncio.Event(), asyncio.Event()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
                                headers={'X-LearnFlow-Desktop-Token':'native-only'}) as client:
        await login(client)
        old = next(iter(connection.sessions.values())).client
        close = old.aclose
        async def delayed_close():
            started.set()
            await release.wait()
            await close()
        old.aclose = delayed_close
        pending = asyncio.create_task(client.post('/auth/api-key/connect', json={'api_key':OTHER_KEY}))
        await started.wait()
        assert (await client.post('/auth/logout')).status_code == 200
        release.set()
        assert (await pending).status_code == 409
    assert not connection.sessions and not connection.pet_handles
