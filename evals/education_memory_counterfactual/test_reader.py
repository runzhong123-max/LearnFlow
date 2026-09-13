"""Reader protocol tests use injected clients and never contact a provider."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

import pytest


_SPEC = importlib.util.spec_from_file_location("counterfactual_reader_under_test", Path(__file__).with_name("reader.py"))
reader = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = reader
_SPEC.loader.exec_module(reader)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Tests forbid network calls")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)


@pytest.fixture
def config():
    return reader.ReaderConfig("unit-test-secret", "https://unit-test-endpoint.invalid/v1", "reader-test-model")


def answer(**changes):
    return {"latest_result": "correct", "latest_assistance": "supported", "assessment_event_id": 12,
            "independent_success_supported": False, "stable_mastery_supported": False,
            "current_priority": None, "time_budget_minutes": 20, "support_active": True,
            "return_anchor": None, "next_step": "reduce_help_then_check", "evidence_event_ids": [12], **changes}


class FakeClient:
    def __init__(self, payload=None, *, content=None, finish_reason="stop", usage=True, error=None, delay=0):
        self.calls = []
        self.error, self.delay = error, delay
        self.active = self.max_active = 0
        self.payload = payload or {"id": "observed-response", "model": "returned-reader-alias", "choices": [
            {"index": 0, "message": {"role": "assistant", "content": content if content is not None else json.dumps(answer())},
             "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": 31, "completion_tokens": 22, "total_tokens": 53} if usage else None}
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.error:
                raise self.error
            return SimpleNamespace(model_dump=lambda **_: self.payload)
        finally:
            self.active -= 1


def messages(content="Read these synthetic educational records and return JSON."):
    return [{"role": "user", "content": content}]


def jobs(count):
    return [{"job_id": f"job-{i}", "messages": messages(f"Synthetic case {i}; return JSON.")} for i in range(count)]


def test_actual_raw_response_and_usage_are_retained_without_coercion(config):
    client = FakeClient(content=json.dumps(answer(stable_mastery_supported=True)))
    result = asyncio.run(reader.read_prompt(messages(), config, client=client))
    assert result["status"] == "ok"
    assert result["parsed"]["stable_mastery_supported"] is True  # The verifier must score this false claim.
    assert result["raw_response"] == client.payload
    assert result["returned_model"] == "returned-reader-alias"
    assert result["requested_model"] == config.model
    assert result["usage"] == {"prompt_tokens": 31, "completion_tokens": 22, "total_tokens": 53}
    assert len(result["input_sha256"]) == 64
    assert result["latency_ms"] >= 0
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["temperature"] == 0 and call["max_tokens"] == 400
    assert call["response_format"] == {"type": "json_object"} and call["stream"] is False and call["n"] == 1


@pytest.mark.parametrize("content,reason,status", [
    ("", "stop", "parse_error"), ("not JSON", "stop", "parse_error"),
    (json.dumps(answer()), "length", "truncated"),
    (json.dumps(answer()), "tool_calls", "invalid_response"),
    (json.dumps(answer()), "content_filter", "refused"),
])
def test_empty_malformed_and_truncated_are_not_success(config, content, reason, status):
    result = asyncio.run(reader.read_prompt(messages(), config, client=FakeClient(content=content, finish_reason=reason)))
    assert result["status"] == status
    assert result["raw_response"] is not None
    assert result["finish_reason"] == reason


def test_missing_usage_stays_unknown(config):
    result = asyncio.run(reader.read_prompt(messages(), config, client=FakeClient(usage=False)))
    assert result["status"] == "ok" and result["usage"] is None


def test_schema_rejects_coercion_and_duplicate_keys_but_not_wrong_education_values():
    parsed, error = reader.parse_response(json.dumps(answer(assessment_event_id=True)))
    assert parsed is None and error == "schema_integer_mismatch"
    assert reader.parse_response('{"ok":true,"ok":false}', "smoke") == (None, "invalid_json")
    assert reader.parse_response('{"ok":true}', "smoke") == ({"ok": True}, None)
    parsed, error = reader.parse_response(json.dumps(answer(time_budget_minutes=-5, evidence_event_ids=[-10])))
    assert parsed["time_budget_minutes"] == -5 and error is None  # Observable mistakes belong to the scorer.


def test_errors_are_safe_and_do_not_retry(config):
    error = RuntimeError(f"Authorization {config.api_key} endpoint {config.base_url}")
    error.status_code = 401
    client = FakeClient(error=error)
    result = asyncio.run(reader.read_prompt(messages(), config, client=client))
    assert result["status"] == "provider_error"
    assert result["error"] == {"category": "reader_or_provider_error", "http_status": 401}
    assert result["raw_response"] is None and result["usage"] is None
    assert config.api_key not in json.dumps(result) and config.base_url not in json.dumps(result)
    assert len(client.calls) == 1


def test_timeout_is_one_attempt(config):
    client = FakeClient(delay=.02)
    result = asyncio.run(reader.read_prompt(messages(), replace(config, timeout_seconds=.001), client=client))
    assert result["status"] == "timeout" and len(client.calls) == 1


def test_response_secrets_are_redacted_and_marked(config):
    client = FakeClient(content=json.dumps(answer(current_priority=f"{config.api_key} {config.base_url}")))
    result = asyncio.run(reader.read_prompt(messages(), config, client=client))
    assert result["raw_response_redacted"] is True
    assert config.api_key not in json.dumps(result) and config.base_url not in json.dumps(result)
    assert "[REDACTED]" in result["parsed"]["current_priority"]


@pytest.mark.parametrize("content", ["unit-test-secret", "https://unit-test-endpoint.invalid/v1"])
def test_credential_bearing_prompt_is_rejected_before_call(config, content):
    client = FakeClient()
    with pytest.raises(reader.ReaderInputError, match="credential_or_endpoint_in_prompt"):
        asyncio.run(reader.read_prompt(messages(content), config, client=client))
    assert client.calls == []


def test_output_limit_and_input_limit_fail_before_call(config):
    with pytest.raises(reader.ReaderInputError, match="invalid_output_limit"):
        replace(config, max_tokens=0)
    client = FakeClient()
    with pytest.raises(reader.ReaderInputError, match="input_character_limit"):
        asyncio.run(reader.read_prompt(messages(), replace(config, max_input_chars=10), client=client))
    assert client.calls == []


def test_placeholder_config_never_calls_or_prints_secrets(config):
    client = FakeClient()
    with pytest.raises(reader.ReaderInputError, match="model_not_configured"):
        asyncio.run(reader.read_prompt(messages(), replace(config, api_key="test-offline"), client=client))
    assert client.calls == []
    assert config.api_key not in repr(config) and config.base_url not in repr(config)
    assert config.api_key not in json.dumps(config.metadata()) and config.base_url not in json.dumps(config.metadata())


def test_client_factory_disables_sdk_retries(config, monkeypatch):
    import openai
    captured = {}
    def factory(**kwargs):
        captured.update(kwargs)
        return object()
    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    reader._new_client(config)
    assert captured["max_retries"] == 0 and captured["timeout"] == 90


def test_run_budget_resume_failed_jobs_and_concurrency(config, tmp_path):
    output = tmp_path / "results.jsonl"
    client = FakeClient(delay=.001, error=RuntimeError("provider down"))
    result = asyncio.run(reader.run_jobs(jobs(5), output, config, max_calls=3, concurrency=2, client=client))
    assert result["new_calls"] == 3 and result["deferred_by_call_limit"] == 2
    assert result["statuses"] == {"provider_error": 3}
    assert client.max_active <= 2
    assert len(reader._read_jsonl(output.with_name(output.name + ".attempts.jsonl"))) == 3
    result = asyncio.run(reader.run_jobs(jobs(5), output, config, max_calls=3, concurrency=2, client=client))
    assert result["new_calls"] == 0 and result["skipped_existing"] == 3
    assert len(client.calls) == 3  # Failed calls are never silently retried.


def test_reservation_exists_before_request(config, tmp_path):
    output = tmp_path / "results.jsonl"
    class CheckingClient(FakeClient):
        async def create(self, **kwargs):
            attempts = reader._read_jsonl(output.with_name(output.name + ".attempts.jsonl"))
            assert len(attempts) == 1 and attempts[0]["status"] == "started"
            return await super().create(**kwargs)
    asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, client=CheckingClient()))


def test_ambiguous_crash_is_not_retried(config, tmp_path):
    output = tmp_path / "results.jsonl"
    asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, client=FakeClient()))
    output.unlink()  # A process died after reservation but before the result was fsynced.
    client = FakeClient()
    result = asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, client=client))
    assert result["new_calls"] == 0 and client.calls == []
    row = reader._read_jsonl(output)[0]
    assert row["status"] == "interrupted_previous_attempt" and row["retried"] is False


def test_duplicate_jobs_and_changed_resume_rejected_before_call(config, tmp_path):
    output = tmp_path / "results.jsonl"
    client = FakeClient()
    with pytest.raises(reader.ReaderInputError, match="duplicate_job_id"):
        asyncio.run(reader.run_jobs(jobs(1) * 2, output, config, max_calls=3, client=client))
    assert client.calls == []
    asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=3, client=client))
    changed = jobs(1)
    changed[0]["messages"] = messages("different evidence JSON")
    with pytest.raises(reader.ReaderInputError, match="resume_request_changed"):
        asyncio.run(reader.run_jobs(changed, output, config, max_calls=3, client=client))
    with pytest.raises(reader.ReaderInputError, match="resume_configuration_changed"):
        asyncio.run(reader.run_jobs(jobs(2), output, replace(config, model="different"), max_calls=3, client=client))
    assert len(client.calls) == 1


def test_input_jobs_cannot_carry_gold_metadata(config, tmp_path):
    rows = jobs(1)
    rows[0]["gold"] = "not for reader"
    with pytest.raises(reader.ReaderInputError, match="unexpected_job_fields"):
        asyncio.run(reader.run_jobs(rows, tmp_path / "out.jsonl", config, max_calls=1, client=FakeClient()))


def test_incomplete_output_fails_closed(config, tmp_path):
    output = tmp_path / "results.jsonl"
    output.write_text('{"job_id":')
    client = FakeClient()
    with pytest.raises(reader.ReaderInputError, match="unreadable_or_incomplete_jsonl"):
        asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, client=client))
    assert client.calls == []


def test_smoke_is_separate_32_token_single_call(config, tmp_path, monkeypatch, capsys):
    def load(*args, **kwargs):
        return replace(config, **kwargs)
    client = FakeClient(content='{"ok":true}')
    class ClientContext:
        async def __aenter__(self):
            return client
        async def __aexit__(self, *args):
            pass
    monkeypatch.setattr(reader, "load_web_config", load)
    monkeypatch.setattr(reader, "_new_client", lambda _: ClientContext())
    output = tmp_path / "smoke.jsonl"
    assert reader.main(["smoke", "--output", str(output)]) == 0
    assert len(client.calls) == 1 and client.calls[0]["max_tokens"] == 32
    assert reader._read_jsonl(output)[0]["schema"] == "smoke"
    assert reader.main(["smoke", "--output", str(output)]) == 0
    assert len(client.calls) == 1
    assert config.api_key not in capsys.readouterr().out


def test_empty_jobs_are_not_a_completed_experiment(config, tmp_path):
    with pytest.raises(reader.ReaderInputError, match="invalid_job_count"):
        asyncio.run(reader.run_jobs([], tmp_path / "out.jsonl", config, max_calls=1, client=FakeClient()))


def test_simultaneous_output_writer_fails_before_call(config, tmp_path):
    output = tmp_path / "results.jsonl"
    client = FakeClient()
    with output.with_name(output.name + ".lock").open("a") as lock:
        reader.fcntl.flock(lock, reader.fcntl.LOCK_EX | reader.fcntl.LOCK_NB)
        with pytest.raises(reader.ReaderInputError, match="output_already_running"):
            asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, client=client))
    assert client.calls == []


def test_resume_cannot_change_endpoint(config, tmp_path):
    output = tmp_path / "results.jsonl"
    client = FakeClient()
    asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=2, client=client))
    with pytest.raises(reader.ReaderInputError, match="resume_configuration_changed"):
        asyncio.run(reader.run_jobs(jobs(2), output, replace(config, base_url="https://different.invalid/v1"), max_calls=2, client=client))
    assert len(client.calls) == 1


def test_unknown_schema_cannot_reserve_a_call(config, tmp_path):
    output = tmp_path / "results.jsonl"
    with pytest.raises(reader.ReaderInputError, match="unknown_schema"):
        asyncio.run(reader.run_jobs(jobs(1), output, config, max_calls=1, schema="unregistered", client=FakeClient()))
    assert not output.with_name(output.name + ".attempts.jsonl").exists()


def test_config_numeric_defaults_hash_identically():
    from evals.education_memory_counterfactual.reader import ReaderConfig, _sha
    a=ReaderConfig(api_key='unit-key',base_url='https://unit.invalid',model='unit',timeout_seconds=90,temperature=0)
    b=ReaderConfig(api_key='unit-key',base_url='https://unit.invalid',model='unit',timeout_seconds=90.0,temperature=0.0)
    assert _sha(a.metadata())==_sha(b.metadata())
