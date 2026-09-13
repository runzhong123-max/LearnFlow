"""Bounded hosted-model reader; never imports formation or writes learner state.

An fsynced reservation precedes every request. A crashed/ambiguous request consumes
its call allowance and is never retried on resume. Responses are SDK JSON bodies,
not reconstructed answers; configured credentials/endpoints are always redacted.
"""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass, field
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any


VERSION = "education-counterfactual-reader.v1"
MAX_JOBS = 10_000
SMOKE_MESSAGES = [{"role": "user", "content": 'Return exactly this JSON object: {"ok":true}'}]
PLACEHOLDERS = {"", "***", "sk-your-key-here", "test-offline", "test_offline", "test-key", "dummy", "offline"}


class ReaderInputError(ValueError):
    """Only fixed, nonsecret reason codes are passed to this exception."""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ReaderConfig:
    api_key: str = field(repr=False)
    base_url: str = field(repr=False)
    model: str
    max_tokens: int = 400
    timeout_seconds: float = 90.0
    temperature: float = 0.0
    max_input_chars: int = 200_000
    extra_body: dict = field(default_factory=dict, repr=False)

    def __post_init__(self):
        if type(self.max_tokens) is not int or not 1 <= self.max_tokens <= 4000:
            raise ReaderInputError("invalid_output_limit")
        if not math.isfinite(self.timeout_seconds) or not 0 < self.timeout_seconds <= 300:
            raise ReaderInputError("invalid_timeout")
        if self.temperature != 0 or type(self.max_input_chars) is not int or not 1 <= self.max_input_chars <= 1_000_000:
            raise ReaderInputError("invalid_reader_limits")
        if not isinstance(self.extra_body, dict) or set(self.extra_body) - {"thinking", "reasoning_effort"}:
            raise ReaderInputError("unsupported_provider_option")

    def metadata(self) -> dict:
        return {
            "reader_version": VERSION,
            "credentials_present": bool(self.api_key.strip() and self.api_key.strip().casefold() not in PLACEHOLDERS),
            "endpoint_present": bool(self.base_url.strip()),
            "endpoint_config_sha256": _sha(self.base_url),
            "model_alias": _redact(self.model, self)[0],
            "hosted_alias_is_immutable_weights": False,
            "temperature": float(self.temperature), "max_tokens": self.max_tokens,
            "timeout_seconds": float(self.timeout_seconds), "max_retries": 0,
            "max_input_chars": self.max_input_chars, "response_format": "json_object",
            "provider_option_keys": sorted(self.extra_body),
            "provider_options_sha256": _sha(self.extra_body),
        }

    def require_ready(self):
        meta = self.metadata()
        if not meta["credentials_present"] or not meta["endpoint_present"] or not self.model.strip():
            raise ReaderInputError("model_not_configured")


def load_web_config(repo: Path = Path("/Users/a1-6/LearnFlow"), **overrides) -> ReaderConfig:
    """Read only Web Settings, without app startup, formation, or DB imports."""
    path = Path(repo).resolve() / "backend/app/core/config.py"
    spec = importlib.util.spec_from_file_location("learnflow_counterfactual_reader_settings", path)
    if spec is None or spec.loader is None:
        raise ReaderInputError("settings_module_unavailable")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        raise ReaderInputError("settings_load_failed") from None
    settings = module.settings
    provider = module.openai_chat_provider_kwargs(settings.llm_base_url, settings.llm_model, thinking_enabled=False)
    if settings.llm_model.startswith("deepseek-v4-"):
        provider["extra_body"]={**provider.get("extra_body",{}),"thinking":{"type":"disabled"}}
    return ReaderConfig(api_key=settings.llm_api_key, base_url=settings.llm_base_url,
                        model=settings.llm_model, extra_body=provider.get("extra_body", {}), **overrides)


def _redact(value: Any, config: ReaderConfig) -> tuple[Any, bool]:
    changed = False
    secrets = [part for part in (config.api_key, config.api_key.strip(), config.base_url,
                                config.base_url.rstrip("/")) if part]
    def walk(item):
        nonlocal changed
        if isinstance(item, str):
            for secret in secrets:
                if secret in item:
                    item = item.replace(secret, "[REDACTED]")
                    changed = True
            return item
        if isinstance(item, list):
            return [walk(v) for v in item]
        if isinstance(item, dict):
            return {walk(k): walk(v) for k, v in item.items()}
        return item
    return walk(value), changed


def validate_messages(messages: Any, config: ReaderConfig) -> list[dict]:
    if not isinstance(messages, list) or not messages or len(messages) > 64:
        raise ReaderInputError("invalid_messages")
    for row in messages:
        if (not isinstance(row, dict) or set(row) != {"role", "content"}
                or row["role"] not in {"system", "user", "assistant"}
                or not isinstance(row["content"], str)):
            raise ReaderInputError("invalid_message_shape")
    encoded = _json(messages)
    if len(encoded) > config.max_input_chars:
        raise ReaderInputError("input_character_limit")
    if _redact(messages, config)[1]:
        raise ReaderInputError("credential_or_endpoint_in_prompt")
    return messages


def parse_response(content: Any, schema: str = "education") -> tuple[dict | None, str | None]:
    """Validate shape only; false educational claims remain scoreable values."""
    if not isinstance(content, str) or not content.strip():
        return None, "empty_content"
    def unique_object(pairs):
        if len({key for key, _ in pairs}) != len(pairs):
            raise ValueError()
        return dict(pairs)
    try:
        data = json.loads(content, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        return None, "invalid_json"
    if not isinstance(data, dict):
        return None, "not_json_object"
    if schema == "smoke":
        return (data, None) if set(data) == {"ok"} and data["ok"] is True else (None, "smoke_schema_mismatch")
    if schema != "education":
        raise ReaderInputError("unknown_schema")
    enums = {
        "latest_result": {"correct", "incorrect", "none"},
        "latest_assistance": {"independent", "supported", "unknown"},
        "next_step": {"diagnose_error", "reduce_help_then_check", "independent_check", "clarify_help", "collect_evidence"},
    }
    booleans = {"independent_success_supported", "stable_mastery_supported", "support_active"}
    strings = {"current_priority", "return_anchor"}
    integers = {"assessment_event_id", "time_budget_minutes"}
    expected = set(enums) | booleans | strings | integers | {"evidence_event_ids"}
    if set(data) != expected:
        return None, "schema_fields_mismatch"
    if any(not isinstance(data[k], str) or data[k] not in choices for k, choices in enums.items()):
        return None, "schema_enum_mismatch"
    if any(type(data[k]) is not bool for k in booleans):
        return None, "schema_boolean_mismatch"
    if any(data[k] is not None and not isinstance(data[k], str) for k in strings):
        return None, "schema_string_mismatch"
    if any(data[k] is not None and type(data[k]) is not int for k in integers):
        return None, "schema_integer_mismatch"
    if not isinstance(data["evidence_event_ids"], list) or any(type(v) is not int for v in data["evidence_event_ids"]):
        return None, "schema_citation_mismatch"
    return data, None


def _safe_error(error: Exception) -> dict:
    # Exception messages, repr, request objects and headers may contain secrets.
    name = type(error).__name__
    allowed = {"AuthenticationError", "PermissionDeniedError", "RateLimitError", "BadRequestError",
               "NotFoundError", "UnprocessableEntityError", "InternalServerError", "APIStatusError",
               "APIConnectionError", "APITimeoutError", "TimeoutError"}
    status = getattr(error, "status_code", None)
    return {"category": name if name in allowed else "reader_or_provider_error",
            "http_status": status if type(status) is int and 100 <= status <= 599 else None}


def _new_client(config: ReaderConfig):
    from openai import AsyncOpenAI
    return AsyncOpenAI(api_key=config.api_key, base_url=config.base_url,
                       timeout=config.timeout_seconds, max_retries=0)


async def read_prompt(messages: list[dict], config: ReaderConfig, *, client=None, schema: str = "education") -> dict:
    config.require_ready()
    validate_messages(messages, config)
    if schema not in {"education", "smoke"}:
        raise ReaderInputError("unknown_schema")
    if client is None:
        async with _new_client(config) as owned:
            return await read_prompt(messages, config, client=owned, schema=schema)
    result = {"reader_version": VERSION, "status": "provider_error", "schema": schema,
              "input_sha256": _sha(messages), "requested_model": config.metadata()["model_alias"],
              "returned_model": None, "usage": None, "finish_reason": None,
              "raw_response": None, "raw_response_redacted": False, "parsed": None,
              "parse_error": None, "error": None, "call_attempted": True}
    start = time.perf_counter()
    try:
        kwargs = {"model": config.model, "messages": messages, "temperature": 0,
                  "max_tokens": config.max_tokens, "n": 1, "stream": False,
                  "response_format": {"type": "json_object"}}
        if config.extra_body:
            kwargs["extra_body"] = config.extra_body
        response = await asyncio.wait_for(client.chat.completions.create(**kwargs), config.timeout_seconds)
        raw = response.model_dump(mode="json")
        raw, redacted = _redact(raw, config)
        result.update(raw_response=raw, raw_response_redacted=redacted,
                      returned_model=raw.get("model"), usage=raw.get("usage"))
        choices = raw.get("choices") or []
        if len(choices) != 1:
            result.update(status="invalid_response", parse_error="choice_count_mismatch")
        else:
            choice = choices[0]
            message = choice.get("message") or {}
            reason = choice.get("finish_reason")
            parsed, error = parse_response(message.get("content"), schema)
            result.update(finish_reason=reason, parsed=parsed, parse_error=error)
            result["status"] = ("refused" if message.get("refusal") or reason == "content_filter" else
                                "truncated" if reason == "length" else
                                "invalid_response" if reason != "stop" else
                                "parse_error" if error else "ok")
    except Exception as error:
        result["error"] = _safe_error(error)
        if result["error"]["category"] in {"APITimeoutError", "TimeoutError"}:
            result["status"] = "timeout"
    result["latency_ms"] = round((time.perf_counter() - start) * 1000, 3)
    return result


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except (ValueError, OSError):
        raise ReaderInputError("unreadable_or_incomplete_jsonl") from None
    if any(not isinstance(row, dict) for row in rows):
        raise ReaderInputError("invalid_jsonl_row")
    return rows


def _append(path: Path, row: dict):
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
        stream.write(_json(row) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _job_map(rows: list[dict]) -> dict[str, dict]:
    result = {}
    for row in rows:
        identifier = row.get("job_id")
        if not isinstance(identifier, str) or not identifier or len(identifier) > 240:
            raise ReaderInputError("invalid_job_id")
        if identifier in result:
            raise ReaderInputError("duplicate_job_id")
        result[identifier] = row
    return result


async def run_jobs(jobs: list[dict], output: Path, config: ReaderConfig, *, max_calls: int,
                   concurrency: int = 4, client=None, schema: str = "education") -> dict:
    """Cumulative per-output call cap. Started jobs are never retried, even on crash."""
    if type(max_calls) is not int or not 1 <= max_calls <= MAX_JOBS:
        raise ReaderInputError("invalid_call_limit")
    if type(concurrency) is not int or not 1 <= concurrency <= 4:
        raise ReaderInputError("invalid_concurrency")
    if not isinstance(jobs, list) or not jobs or len(jobs) > MAX_JOBS:
        raise ReaderInputError("invalid_job_count")
    if schema not in {"education", "smoke"}:
        raise ReaderInputError("unknown_schema")
    config.require_ready()
    mapped = _job_map(jobs)
    for row in jobs:
        if set(row) != {"job_id", "messages"}:
            raise ReaderInputError("unexpected_job_fields")
        validate_messages(row["messages"], config)
        if _redact(row["job_id"], config)[1]:
            raise ReaderInputError("credential_or_endpoint_in_job_id")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    ledger = output.with_name(output.name + ".attempts.jsonl")
    lock_path = output.with_name(output.name + ".lock")
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReaderInputError("output_already_running") from None
        previous, attempts = _job_map(_read_jsonl(output)), _job_map(_read_jsonl(ledger))
        if set(previous) - set(attempts):
            raise ReaderInputError("results_missing_attempt_ledger")
        if len(attempts) > max_calls:
            raise ReaderInputError("existing_calls_exceed_limit")
        config_hash = _sha(config.metadata())
        if any(row.get("config_sha256") != config_hash or row.get("schema") != schema for row in attempts.values()):
            raise ReaderInputError("resume_configuration_changed")
        if any(row.get("request_sha256") != attempts[identifier].get("request_sha256") for identifier, row in previous.items()):
            raise ReaderInputError("result_ledger_mismatch")
        requests = {identifier: _sha({"messages": row["messages"], "config": config.metadata(), "schema": schema})
                    for identifier, row in mapped.items()}
        for identifier in mapped.keys() & attempts.keys():
            if attempts[identifier].get("request_sha256") != requests[identifier]:
                raise ReaderInputError("resume_request_changed")
        for identifier, attempt in attempts.items():
            if identifier not in previous:
                row = {"job_id": identifier, "reader_version": VERSION, "status": "interrupted_previous_attempt",
                       "request_sha256": attempt["request_sha256"], "input_sha256": attempt["input_sha256"],
                       "schema": attempt["schema"], "requested_model": attempt.get("model"),
                       "returned_model": None, "finish_reason": None, "latency_ms": None,
                       "parse_error": None, "raw_response_redacted": False,
                       "parsed": None, "raw_response": None, "usage": None, "error": {"category": "ambiguous_prior_call"},
                       "call_attempted": True, "retried": False, "config": config.metadata()}
                _append(output, row)
                previous[identifier] = row
        pending = [row for identifier, row in mapped.items() if identifier not in attempts]
        selected = pending[:max(0, max_calls - len(attempts))]
        async def execute(active_client):
            semaphore = asyncio.Semaphore(concurrency)
            async def one(job):
                async with semaphore:
                    identifier = job["job_id"]
                    reservation = {"job_id": identifier, "request_sha256": requests[identifier],
                                   "input_sha256": _sha(job["messages"]), "model": config.metadata()["model_alias"],
                                   "config_sha256": config_hash,
                                   "schema": schema, "reader_version": VERSION, "status": "started"}
                    _append(ledger, reservation)
                    response = await read_prompt(job["messages"], config, client=active_client, schema=schema)
                    response.update(job_id=identifier, request_sha256=requests[identifier], config=config.metadata())
                    _append(output, response)
                    return response["status"]
            return await asyncio.gather(*(one(job) for job in selected))
        if selected and client is None:
            async with _new_client(config) as active:
                statuses = await execute(active)
        else:
            statuses = await execute(client) if selected else []
        return {"reader_version": VERSION, "jobs": len(jobs), "skipped_existing": len(mapped.keys() & attempts.keys()),
                "new_calls": len(selected), "cumulative_calls": len(attempts) + len(selected),
                "max_calls": max_calls, "deferred_by_call_limit": len(pending) - len(selected),
                "statuses": {status: statuses.count(status) for status in sorted(set(statuses))},
                "config": config.metadata()}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("presence", "smoke", "run"))
    parser.add_argument("--repo", type=Path, default=Path("/Users/a1-6/LearnFlow"))
    parser.add_argument("--jobs", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-calls", type=int)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=400)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args(argv)
    try:
        config = load_web_config(args.repo, max_tokens=32 if args.command == "smoke" else args.max_tokens,
                                 timeout_seconds=args.timeout)
        if args.command == "presence":
            print(_json(config.metadata()))
            return 0
        if args.output is None or (args.command == "run" and (args.jobs is None or args.max_calls is None)):
            raise ReaderInputError("output_jobs_and_call_limit_required")
        if args.command == "run" and not args.jobs.is_file():
            raise ReaderInputError("jobs_file_unavailable")
        jobs = [{"job_id": "non_scored_smoke_v1", "messages": SMOKE_MESSAGES}] if args.command == "smoke" else _read_jsonl(args.jobs)
        summary = asyncio.run(run_jobs(jobs, args.output, config,
            max_calls=1 if args.command == "smoke" else args.max_calls,
            concurrency=1 if args.command == "smoke" else args.concurrency,
            schema="smoke" if args.command == "smoke" else "education"))
        print(_json(summary))
        # Existing failures also remain failures on resume; never report a failed smoke as successful.
        results = _job_map(_read_jsonl(args.output))
        return 0 if not summary["deferred_by_call_limit"] and all(results.get(row["job_id"], {}).get("status") == "ok" for row in jobs) else 2
    except ReaderInputError as error:
        print(_json({"status": "configuration_or_input_error", "error": str(error)}), file=sys.stderr)
        return 2
    except Exception:
        print(_json({"status": "reader_error", "error": "unexpected_reader_failure"}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
