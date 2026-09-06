import asyncio
from types import SimpleNamespace

import pytest

from app.services.provider_compat import (
    ProviderResponseError,
    create_chat_completion,
    normalize_spark_chat_response,
)


def spark_payload():
    return {
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "OK"},
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "code": 0,
        "message": "Success",
        "sid": "spark-session-1",
        "status": "complete",
    }


def test_normalize_spark_chat_response_fills_openai_required_fields():
    response = normalize_spark_chat_response(spark_payload(), "spark-x")

    assert response.id == "spark-session-1"
    assert response.model == "spark-x"
    assert response.object == "chat.completion"
    assert response.choices[0].finish_reason == "stop"
    assert response.choices[0].message.content == "OK"


def test_normalize_spark_chat_response_rejects_provider_error():
    payload = {"code": 11200, "message": "授权错误"}

    with pytest.raises(ProviderResponseError, match="授权错误"):
        normalize_spark_chat_response(payload, "spark-x")


def test_create_chat_completion_uses_raw_response_for_spark():
    calls: list[dict] = []

    class FakeRawResponse:
        def json(self):
            return spark_payload()

    class FakeCompletions:
        def __init__(self):
            self.with_raw_response = SimpleNamespace(create=self.create_raw)

        async def create_raw(self, **kwargs):
            calls.append(kwargs)
            return FakeRawResponse()

        async def create(self, **kwargs):
            raise AssertionError(f"strict SDK path should not be used: {kwargs}")

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())
            self.kwargs = kwargs
            self.closed = False

        async def close(self):
            self.closed = True

    result = asyncio.run(create_chat_completion(
        api_key="api-password",
        base_url="https://spark-api-open.xf-yun.com/agent/v1",
        model="spark-x",
        messages=[{"role": "user", "content": "只回复 OK"}],
        client_class=FakeClient,
        max_tokens=16,
    ))

    assert result.model == "spark-x"
    assert calls[0]["max_tokens"] == 16


def test_create_chat_completion_reads_legacy_raw_response_text():
    class FakeRawResponse:
        text = '{"code":0,"sid":"legacy-session","choices":[{"message":{"role":"assistant","content":"OK"}}]}'

    class FakeCompletions:
        def __init__(self):
            self.with_raw_response = SimpleNamespace(create=self.create_raw)

        async def create_raw(self, **kwargs):
            return FakeRawResponse()

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self):
            return None

    result = asyncio.run(create_chat_completion(
        api_key="api-password",
        base_url="https://spark-api-open.xf-yun.com/agent/v1",
        model="spark-x",
        messages=[{"role": "user", "content": "只回复 OK"}],
        client_class=FakeClient,
    ))

    assert result.id == "legacy-session"
    assert result.choices[0].message.content == "OK"
