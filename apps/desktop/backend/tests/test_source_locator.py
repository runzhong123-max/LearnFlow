from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from pydantic import ValidationError
import pytest

import app.services.source_locator as source_locator_module
from app.schemas.project import SourceCreate
from app.services.chunker import SourceProcessor
from app.services.source_locator import SourceLocationError, SourceLocator


GLOBAL_V4 = "93.184.216.34"


def _error_code(exc_info: pytest.ExceptionInfo[SourceLocationError]) -> str:
    return exc_info.value.code


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://10.0.0.8/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.0.2.1/",
        "http://224.0.0.1/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[fec0::1]/",
        "http://[ff02::1]/",
    ],
)
def test_web_url_rejects_literal_non_global_addresses(url: str):
    with pytest.raises(SourceLocationError) as exc_info:
        SourceLocator.normalize_web_url(url)

    assert _error_code(exc_info) == "non_global_address"


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/lesson",
        "https://user:secret@example.com/lesson",
        "https://example.com:8443/lesson",
        "http://localhost/lesson",
        "http://metadata.internal/latest",
    ],
)
def test_web_url_rejects_unsupported_schemes_credentials_ports_and_local_names(url: str):
    with pytest.raises(SourceLocationError):
        SourceLocator.normalize_web_url(url)


def test_web_url_normalizes_public_hosts_default_ports_and_fragments():
    assert SourceLocator.normalize_web_url(
        "HTTPS://Example.COM:443/docs/start?lang=zh#section",
    ) == "https://example.com/docs/start?lang=zh"
    assert SourceLocator.normalize_web_url(
        "http://8.8.8.8:80/resolve",
    ) == "http://8.8.8.8/resolve"
    assert SourceLocator.normalize_web_url(
        "https://[2606:4700:4700::1111]:443/dns-query",
    ) == "https://[2606:4700:4700::1111]/dns-query"


def test_web_url_length_budget_fails_closed():
    with pytest.raises(SourceLocationError) as exc_info:
        SourceLocator.normalize_web_url("https://example.com/" + ("a" * 2_048))

    assert _error_code(exc_info) == "invalid_source_url"


def test_dns_resolution_rejects_any_non_global_answer():
    async def resolver(host: str, port: int) -> list[str]:
        assert (host, port) == ("source.example", 443)
        return [GLOBAL_V4, "10.0.0.2"]

    locator = SourceLocator(resolver=resolver)
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(locator.resolve_web_target("https://source.example/notes"))

    assert _error_code(exc_info) == "non_global_address"


def test_dns_resolution_accepts_only_global_ipv4_and_ipv6_answers():
    async def resolver(_host: str, _port: int) -> list[str]:
        return [GLOBAL_V4, "2606:4700:4700::1111"]

    target = asyncio.run(
        SourceLocator(resolver=resolver).resolve_web_target("https://source.example/notes"),
    )

    assert target.addresses == (GLOBAL_V4, "2606:4700:4700::1111")


def test_redirect_target_is_resolved_before_the_next_http_request():
    requests: list[str] = []

    async def resolver(host: str, _port: int) -> list[str]:
        return ["169.254.169.254"] if host == "metadata.example" else [GLOBAL_V4]

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(
            302,
            headers={"Location": "https://metadata.example/latest/meta-data"},
            request=request,
        )

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(locator.fetch("https://start.example/lesson"))

    assert _error_code(exc_info) == "non_global_address"
    assert requests == ["https://start.example/lesson"]


def test_each_public_redirect_hop_gets_pre_and_post_dns_checks():
    resolver_calls: list[str] = []

    async def resolver(host: str, _port: int) -> list[str]:
        resolver_calls.append(host)
        return [GLOBAL_V4]

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "start.example":
            return httpx.Response(
                302,
                headers={"Location": "https://final.example/lesson"},
                request=request,
            )
        return httpx.Response(200, text="public lesson", request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(handler))
    response = asyncio.run(locator.fetch("https://start.example/lesson"))

    assert response.body == b"public lesson"
    assert resolver_calls == [
        "start.example", "start.example", "final.example", "final.example",
    ]
    assert [item.phase for item in response.dns_observations] == [
        "before_request", "after_headers", "before_request", "after_headers",
    ]
    assert response.peer_ip_pinned is False


def test_web_fetch_does_not_forward_credentials_or_unapproved_headers():
    observed_headers: httpx.Headers | None = None

    async def resolver(_host: str, _port: int) -> list[str]:
        return [GLOBAL_V4]

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal observed_headers
        observed_headers = request.headers
        return httpx.Response(200, text="public lesson", request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(handler))
    asyncio.run(
        locator.fetch(
            "https://source.example/lesson",
            headers={
                "Accept": "text/plain",
                "Authorization": "Bearer secret",
                "Cookie": "session=secret",
                "X-Api-Key": "secret",
            },
        ),
    )

    assert observed_headers is not None
    assert observed_headers["accept"] == "text/plain"
    assert "authorization" not in observed_headers
    assert "cookie" not in observed_headers
    assert "x-api-key" not in observed_headers


def test_post_header_dns_check_fails_closed_before_reading_response_body():
    resolver_answers = iter(([GLOBAL_V4], ["127.0.0.1"]))

    async def resolver(_host: str, _port: int) -> list[str]:
        return next(resolver_answers)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"must not be trusted", request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(locator.fetch("https://changing.example/lesson"))

    assert _error_code(exc_info) == "non_global_address"


def test_failed_http_attempt_still_gets_a_post_dns_check():
    resolver_calls: list[str] = []

    async def resolver(host: str, _port: int) -> list[str]:
        resolver_calls.append(host)
        return [GLOBAL_V4]

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(locator.fetch("https://source.example/lesson"))

    assert _error_code(exc_info) == "remote_request_failed"
    assert resolver_calls == ["source.example", "source.example"]


def test_response_body_and_redirect_budgets_fail_closed():
    async def resolver(_host: str, _port: int) -> list[str]:
        return [GLOBAL_V4]

    async def oversized(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"0123456789", request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(oversized))
    with pytest.raises(SourceLocationError) as body_error:
        asyncio.run(locator.fetch("https://source.example/large", max_response_bytes=5))
    assert _error_code(body_error) == "response_budget_exceeded"

    async def redirecting(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "/again"}, request=request)

    locator = SourceLocator(resolver=resolver, transport=httpx.MockTransport(redirecting))
    with pytest.raises(SourceLocationError) as redirect_error:
        asyncio.run(locator.fetch("https://source.example/start", max_redirects=1))
    assert _error_code(redirect_error) == "redirect_budget_exceeded"


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/private-repo",
        "ssh://git@github.com/owner/repo.git",
        "git://github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
        "/tmp/private-repo",
        "../private-repo",
        r"C:\\private-repo",
        "http://github.com/owner/repo",
        "https://gitlab.com/owner/repo",
        "https://github.com/owner/repo/issues",
        "https://user@github.com/owner/repo",
        "https://github.com/owner/repo?ref=main",
        "https://github.com/owner/repo#readme",
        "https://github.com/owner/%72epo",
    ],
)
def test_git_rejects_file_ssh_scp_local_and_noncanonical_locations(url: str):
    with pytest.raises(SourceLocationError):
        SourceLocator.normalize_github_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/OpenAI/openai-python",
        "https://github.com/OpenAI/openai-python.git",
        "https://github.com:443/OpenAI/openai-python/",
    ],
)
def test_git_normalizes_only_canonical_github_https_repositories(url: str):
    assert SourceLocator.normalize_github_url(url) == "https://github.com/OpenAI/openai-python"


def test_git_clone_command_and_environment_explicitly_restrict_protocols(tmp_path: Path):
    command = SourceLocator.git_clone_command(
        "https://github.com/OpenAI/openai-python",
        tmp_path / "clone",
    )
    command_text = " ".join(command)
    environment = SourceLocator.git_environment()

    assert "protocol.allow=never" in command_text
    assert "protocol.https.allow=always" in command_text
    assert "protocol.file.allow=never" in command_text
    assert "protocol.ssh.allow=never" in command_text
    assert "http.followRedirects=false" in command_text
    separator = command.index("--")
    assert command[separator + 1] == "https://github.com/OpenAI/openai-python"
    assert environment["GIT_ALLOW_PROTOCOL"] == "https"
    assert environment["GIT_CONFIG_NOSYSTEM"] == "1"
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert "HOME" not in environment
    assert "HTTPS_PROXY" not in environment


class _FakeCloneProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.returncode = -9

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        return b"", b""


def test_git_clone_timeout_and_directory_budget_are_enforced(tmp_path: Path, monkeypatch):
    locator = SourceLocator()
    monkeypatch.setattr(source_locator_module.shutil, "which", lambda *_args, **_kwargs: "/usr/bin/git")
    monkeypatch.setattr(
        source_locator_module.subprocess,
        "Popen",
        lambda *_args, **_kwargs: _FakeCloneProcess(),
    )
    monkeypatch.setattr(source_locator_module, "GIT_CLONE_TIMEOUT_SECONDS", 0.0)
    with pytest.raises(SourceLocationError) as timeout_error:
        locator._run_git_clone(
            "https://github.com/OpenAI/openai-python",
            tmp_path / "timeout-clone",
        )
    assert _error_code(timeout_error) == "git_clone_timeout"

    monkeypatch.setattr(source_locator_module, "GIT_CLONE_TIMEOUT_SECONDS", 60.0)
    monkeypatch.setattr(
        locator,
        "_bounded_tree_size",
        lambda _root, maximum: maximum + 1,
    )
    budget_destination = tmp_path / "budget-clone"
    budget_destination.mkdir()
    with pytest.raises(SourceLocationError) as budget_error:
        locator._run_git_clone(
            "https://github.com/OpenAI/openai-python",
            budget_destination,
        )
    assert _error_code(budget_error) == "git_clone_budget_exceeded"


def test_git_clone_rechecks_dns_after_the_clone(tmp_path: Path, monkeypatch):
    resolver_calls: list[tuple[str, int]] = []

    async def resolver(host: str, port: int) -> list[str]:
        resolver_calls.append((host, port))
        return [GLOBAL_V4]

    locator = SourceLocator(resolver=resolver)
    monkeypatch.setattr(locator, "_run_git_clone", lambda _url, _destination: None)
    normalized = asyncio.run(
        locator.clone_github(
            "https://github.com/OpenAI/openai-python.git",
            tmp_path / "clone",
        ),
    )

    assert normalized == "https://github.com/OpenAI/openai-python"
    assert resolver_calls == [("github.com", 443), ("github.com", 443)]


def test_git_clone_rechecks_dns_after_a_failed_clone(tmp_path: Path, monkeypatch):
    resolver_calls: list[tuple[str, int]] = []

    async def resolver(host: str, port: int) -> list[str]:
        resolver_calls.append((host, port))
        return [GLOBAL_V4]

    def failed_clone(_url: str, _destination: Path) -> None:
        raise SourceLocationError("git_clone_failed", "clone failed")

    locator = SourceLocator(resolver=resolver)
    monkeypatch.setattr(locator, "_run_git_clone", failed_clone)
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(
            locator.clone_github(
                "https://github.com/OpenAI/openai-python",
                tmp_path / "clone",
            ),
        )

    assert _error_code(exc_info) == "git_clone_failed"
    assert resolver_calls == [("github.com", 443), ("github.com", 443)]


def test_source_processor_fails_closed_for_legacy_dangerous_git_and_local_file(tmp_path: Path):
    processor = SourceProcessor()
    with pytest.raises(SourceLocationError):
        asyncio.run(processor.process_source("github", "file:///tmp/private-repo"))

    local_file = tmp_path / "private.md"
    local_file.write_text("# private", encoding="utf-8")
    with pytest.raises(SourceLocationError) as file_error:
        asyncio.run(processor.process_source("file", str(local_file)))
    assert _error_code(file_error) == "unmanaged_file_source"


def test_git_boundary_rejection_is_not_hidden_by_ingestion_fallback(tmp_path: Path, monkeypatch):
    class RejectingLocator(SourceLocator):
        async def clone_github(self, raw, destination):
            raise SourceLocationError(
                "non_global_address",
                "来源解析到不可公开路由地址：127.0.0.1",
            )

    processor = SourceProcessor(source_locator=RejectingLocator())
    fallback_called = False

    async def unexpected_fallback(_url: str):
        nonlocal fallback_called
        fallback_called = True
        raise AssertionError("security boundary rejection must not fall back")

    monkeypatch.setattr(processor, "_fetch_github_via_api", unexpected_fallback)
    with pytest.raises(SourceLocationError) as exc_info:
        asyncio.run(
            processor.process_source(
                "github",
                "https://github.com/OpenAI/openai-python",
                persist_dir=str(tmp_path / "cache"),
            ),
        )

    assert _error_code(exc_info) == "non_global_address"
    assert fallback_called is False


def test_managed_file_locator_allows_safe_filenames_with_spaces(tmp_path: Path):
    managed_root = tmp_path / "managed uploads"
    managed_root.mkdir()
    uploaded = managed_root / "course notes.md"
    uploaded.write_text("# Notes", encoding="utf-8")

    assert SourceLocator.resolve_managed_file(uploaded, managed_root) == uploaded.resolve()


def test_project_source_schema_uses_the_shared_normalizer():
    source = SourceCreate(
        type="url",
        url="https://github.com/OpenAI/openai-python.git",
    )
    assert source.type == "github"
    assert source.url == "https://github.com/OpenAI/openai-python"

    with pytest.raises(ValidationError):
        SourceCreate(type="url", url="http://169.254.169.254/latest/meta-data")

    with pytest.raises(ValidationError):
        SourceCreate(type="url", url="https://github.com/OpenAI/openai-python#readme")
