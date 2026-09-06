import json
from types import SimpleNamespace
import httpx
import pytest
from app.core.config import settings
from app.services.cloud_device import device_request


@pytest.mark.asyncio
async def test_cloud_binding_ownership_files_conflict_and_no_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path/'runtime'))
    root=tmp_path/'project'; root.mkdir()
    (root/'main.c').write_text('int main(void) { return 0; }')
    requests=[]
    allowed=True
    def cloud(request):
        requests.append(request)
        assert request.method=='GET'
        assert not request.content
        if request.url.path=='/api/auth/me': return httpx.Response(200,json={'learner_id':7})
        return httpx.Response(200 if allowed else 404,json={})
    async with httpx.AsyncClient(base_url='https://learn.example',transport=httpx.MockTransport(cloud)) as client:
        session=SimpleNamespace(client=client,learner_id=7)
        async def call(action,method='GET',payload=None):
            return await device_request(session,'https://learn.example',11,'workspace',action,method,json.dumps(payload or {}).encode())
        assert (await call('tree')).status_code==404
        assert (await call('link','POST',{'root_path':str(root),'client_request_id':'link-1'})).status_code==200
        original=json.loads((await call('files/main.c')).body)
        payload={'content':'int main(void) { return 1; }','base_hash':original['sha256'],'idempotency_key':'write-1'}
        assert (await call('files/main.c','PUT',payload)).status_code==200
        assert (await call('files/main.c','PUT',payload)).status_code==200
        payload['idempotency_key']='write-2'
        assert (await call('files/main.c','PUT',payload)).status_code==409
        assert (await call('files/../outside')).status_code==400
        allowed=False
        assert (await call('tree')).status_code==404
        allowed=True
        # Same device, a different cloud authority cannot reuse this binding.
        other=await device_request(session,'https://other.example',11,'workspace','tree','GET',b'')
        assert other.status_code==404
        session.learner_id=8
        assert (await call('tree')).status_code==401


@pytest.mark.asyncio
async def test_experiment_requires_confirmation_and_replays_without_execution(tmp_path,monkeypatch):
    from app.services import cloud_device as device
    monkeypatch.setattr(settings,'runtime_dir',str(tmp_path/'runtime'))
    monkeypatch.setattr(device,'discover_compiler',lambda:'/usr/bin/clang')
    root=tmp_path/'source';root.mkdir();(root/'main.c').write_text('int main(void){return 0;}')
    calls=[]
    monkeypatch.setattr(device,'run_snapshot',lambda *args:(calls.append(args) or ('completed',{'steps':[],'learning_evidence':False})))
    async with httpx.AsyncClient(base_url='https://learn.example',transport=httpx.MockTransport(
            lambda request:httpx.Response(200,json={'learner_id':7}))) as client:
        session=SimpleNamespace(client=client,learner_id=7)
        async def call(area,action,method='GET',payload=None):
            return await device.device_request(session,'https://learn.example',11,area,action,method,json.dumps(payload or {}).encode())
        await call('workspace','link','POST',{'root_path':str(root),'client_request_id':'link'})
        response=await call('experiments','runs/preview','POST',{'files':['main.c'],'action':'syntax','client_request_id':'run1'})
        assert response.status_code==200,response.body
        run=json.loads(response.body)
        assert not calls
        assert (await call('experiments','runs/1/confirm','POST',{'snapshot_hash':run['snapshot_hash']})).status_code==422
        confirmation={'snapshot_hash':run['snapshot_hash'],'acknowledge_trusted_local':True}
        assert (await call('experiments','runs/1/confirm','POST',confirmation)).status_code==200
        assert (await call('experiments','runs/1/confirm','POST',confirmation)).status_code==200
        assert len(calls)==1
