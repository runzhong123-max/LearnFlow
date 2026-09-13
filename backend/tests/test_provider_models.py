"""Model picker must use the Web host's managed credentials."""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.api.auth import list_model_credential_models
from app.core.config import settings


@pytest.mark.asyncio
async def test_models_use_platform_credentials_without_account_key(monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "platform-test-key")
    monkeypatch.setattr(settings, "llm_base_url", "https://provider.example/v1")
    original_client = httpx.AsyncClient

    def respond(request):
        assert str(request.url) == "https://provider.example/v1/models"
        assert request.headers["Authorization"] == "Bearer platform-test-key"
        return httpx.Response(200, json={"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "model-b"}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond)))
    result = await list_model_credential_models(SimpleNamespace(account=None))
    assert result == {"models": ["model-a", "model-b"], "base_url": "https://provider.example/v1"}
    assert "platform-test-key" not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["", "***", "sk-your-key-here"])
async def test_unconfigured_platform_returns_actionable_error(monkeypatch, key):
    monkeypatch.setattr(settings, "llm_api_key", key)
    with pytest.raises(HTTPException) as error:
        await list_model_credential_models(SimpleNamespace(account=None))
    assert error.value.status_code == 503
    assert error.value.detail == "后台模型服务尚未配置"
