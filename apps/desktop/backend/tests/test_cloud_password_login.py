import httpx
import pytest
from fastapi import FastAPI, Request
from app.core.config import settings
from app.services.cloud_connection import CloudConnection


@pytest.mark.asyncio
async def test_password_cookie_csrf_and_disabled_key_entry(monkeypatch):
    monkeypatch.setattr(settings, 'desktop_mode', True)
    monkeypatch.setattr(settings, 'desktop_token', 'native-only')
    monkeypatch.setattr(settings, 'auth_api_keys_enabled', False)
    seen = []
    def upstream(request):
        seen.append(request)
        assert 'authorization' not in request.headers
        assert 'x-learnflow-desktop-token' not in request.headers
        assert request.headers['origin'] == 'https://learn.example'
        if request.url.path == '/api/auth/login':
            return httpx.Response(200, json={'id': 3, 'learner_id': 7}, headers={
                'set-cookie': 'session=cloud-secret; Path=/; Secure; HttpOnly'})
        assert request.headers['cookie'] == 'session=cloud-secret'
        if request.url.path == '/api/auth/csrf':
            return httpx.Response(200, json={'csrf_token': 'csrf-secret'})
        if request.method == 'POST':
            assert request.headers['x-csrf-token'] == 'csrf-secret'
        return httpx.Response(200, json={'ok': True})
    connection = CloudConnection('https://learn.example', httpx.MockTransport(upstream))
    app = FastAPI()
    @app.api_route('/{path:path}', methods=['GET', 'POST'])
    async def call(path: str, request: Request):
        return await connection.forward(request, path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://local',
            headers={'X-LearnFlow-Desktop-Token': 'native-only'}) as client:
        assert (await client.post('/auth/api-key/connect', json={'api_key': 'lfak_'+'a'*43})).status_code == 404
        assert not seen
        response = await client.post('/auth/login', json={'username': 'user', 'password': 'secret'})
        assert response.status_code == 200
        assert 'set-cookie' not in response.headers and 'cloud-secret' not in response.text
        old = response.json()['desktop_auth_token']
        client.headers['Authorization'] = 'Bearer ' + old
        assert (await client.post('/projects', json={'name': 'test'})).status_code == 200
        assert (await client.post('/auth/logout')).status_code == 200
        assert (await client.get('/projects')).status_code == 401
    await connection.close()
