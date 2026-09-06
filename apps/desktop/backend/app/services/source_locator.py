"""Fail-closed location boundary for remote and managed LearnFlow sources.

The locator deliberately separates syntax normalization from dereferencing.
Every network dereference resolves the hostname immediately before the request
and again after response headers arrive; redirects repeat the same checks for
their destination.  HTTPX still performs its own DNS lookup, so this module
does not claim to eliminate DNS rebinding: the verified address is not pinned
to the socket while preserving the original Host header and TLS SNI.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
import ipaddress
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx


MAX_SOURCE_URL_BYTES = 2_048
MAX_REDIRECT_LOCATION_BYTES = 2_048
MAX_WEB_RESPONSE_BYTES = 5 * 1024 * 1024
MAX_HTTP_REDIRECTS = 5
DNS_TIMEOUT_SECONDS = 6.0
HTTP_CONNECT_TIMEOUT_SECONDS = 15.0
HTTP_READ_TIMEOUT_SECONDS = 30.0
HTTP_TOTAL_TIMEOUT_SECONDS = 90.0
MAX_HTTP_TOTAL_TIMEOUT_SECONDS = 180.0
GIT_CLONE_TIMEOUT_SECONDS = 180.0
GIT_CLONE_MAX_BYTES = 150 * 1024 * 1024
GIT_CLONE_MAX_ENTRIES = 20_000
GIT_CLONE_POLL_SECONDS = 0.05

_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.IGNORECASE)
_GITHUB_COMPONENT = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})?")
_DISALLOWED_HOST_SUFFIXES = (
    ".internal",
    ".invalid",
    ".lan",
    ".local",
    ".localdomain",
    ".localhost",
    ".home",
)


class SourceLocationError(ValueError):
    """Stable, explainable rejection at the source location boundary."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class SourceReference:
    source_type: str
    location: str


@dataclass(frozen=True)
class ResolvedWebTarget:
    url: str
    host: str
    port: int
    addresses: tuple[str, ...]


@dataclass(frozen=True)
class DNSObservation:
    host: str
    phase: str
    addresses: tuple[str, ...]


@dataclass(frozen=True)
class FetchedSource:
    url: str
    status_code: int
    headers: Mapping[str, str]
    body: bytes
    encoding: str | None
    dns_observations: tuple[DNSObservation, ...]
    peer_ip_pinned: bool = False

    def text(self, *, max_characters: int | None = None) -> str:
        encoding = self.encoding or "utf-8"
        try:
            decoded = self.body.decode(encoding, errors="replace")
        except LookupError:
            decoded = self.body.decode("utf-8", errors="replace")
        return decoded if max_characters is None else decoded[:max_characters]


Resolver = Callable[[str, int], Any]


class SourceLocator:
    """Normalize and dereference only explicitly supported source locations."""

    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._resolver = resolver
        self._transport = transport

    # -- Pure normalization -------------------------------------------------

    @staticmethod
    def _bounded_text(raw: Any, *, code: str, maximum: int) -> str:
        value = str(raw or "").strip()
        if not value:
            raise SourceLocationError(code, "来源地址不能为空")
        if len(value.encode("utf-8")) > maximum:
            raise SourceLocationError(code, f"来源地址不能超过 {maximum} 字节")
        if "\\" in value or any(
            ord(character) <= 0x20 or ord(character) == 0x7F
            for character in value
        ):
            raise SourceLocationError(code, "来源地址包含不允许的空白、控制字符或反斜杠")
        return value

    @staticmethod
    def _global_address(raw: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
        try:
            address = ipaddress.ip_address(raw.split("%", 1)[0])
        except ValueError as exc:
            raise SourceLocationError("dns_invalid_address", f"DNS 返回了无效地址：{raw}") from exc
        comparable = address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) else None
        if comparable is not None:
            address = comparable
        if (
            not address.is_global
            or address.is_multicast
            or address.is_unspecified
            or address.is_loopback
            or address.is_link_local
            or getattr(address, "is_site_local", False)
            or address.is_private
            or address.is_reserved
        ):
            raise SourceLocationError(
                "non_global_address",
                f"来源解析到不可公开路由地址：{address.compressed}",
            )
        return address

    @classmethod
    def normalize_web_url(cls, raw: Any) -> str:
        value = cls._bounded_text(raw, code="invalid_source_url", maximum=MAX_SOURCE_URL_BYTES)
        try:
            parsed = urlsplit(value)
        except ValueError as exc:
            raise SourceLocationError("invalid_source_url", "来源 URL 无法解析") from exc

        scheme = parsed.scheme.casefold()
        if scheme not in {"http", "https"}:
            raise SourceLocationError("unsupported_web_scheme", "网页来源只支持 http 或 https")
        if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            raise SourceLocationError("url_credentials_forbidden", "来源 URL 不允许包含用户名或密码")
        if not parsed.hostname:
            raise SourceLocationError("invalid_source_url", "来源 URL 缺少主机名")

        host = parsed.hostname.casefold().rstrip(".")
        if not host or "%" in host:
            raise SourceLocationError("invalid_source_host", "来源主机名无效或包含 IPv6 zone id")
        try:
            port = parsed.port
        except ValueError as exc:
            raise SourceLocationError("invalid_source_port", "来源 URL 端口无效") from exc
        expected_port = 443 if scheme == "https" else 80
        if port is not None and port != expected_port:
            raise SourceLocationError(
                "non_standard_source_port",
                f"{scheme} 来源只允许规范端口 {expected_port}",
            )

        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            try:
                host = host.encode("idna").decode("ascii").casefold()
            except UnicodeError as exc:
                raise SourceLocationError("invalid_source_host", "来源主机名无法进行 IDNA 规范化") from exc
            if len(host) > 253 or "." not in host:
                raise SourceLocationError("invalid_source_host", "来源主机名必须是完整域名")
            if host in {"localhost", "localhost.localdomain"} or host.endswith(_DISALLOWED_HOST_SUFFIXES):
                raise SourceLocationError("non_global_host", "本机或局域网域名不能作为远程来源")
            if any(not _HOST_LABEL.fullmatch(label) for label in host.split(".")):
                raise SourceLocationError("invalid_source_host", "来源主机名标签无效")
            netloc = host
        else:
            cls._global_address(address.compressed)
            netloc = f"[{address.compressed}]" if isinstance(address, ipaddress.IPv6Address) else address.compressed

        path = parsed.path or "/"
        return urlunsplit((scheme, netloc, path, parsed.query, ""))

    @classmethod
    def normalize_github_url(cls, raw: Any) -> str:
        value = cls._bounded_text(raw, code="invalid_github_url", maximum=MAX_SOURCE_URL_BYTES)
        # Fail early with a Git-specific error for the common exfiltration forms.
        lowered = value.casefold()
        if (
            lowered.startswith(("file:", "ssh:", "git:", "ext:"))
            or re.match(r"^[^/\\\s@]+@[^:\s]+:", value)
            or value.startswith(("/", "./", "../", "~/", "\\\\"))
            or re.match(r"^[A-Za-z]:[\\/]", value)
        ):
            raise SourceLocationError(
                "unsafe_git_location",
                "Git 来源禁止 file/ssh/scp、本地路径和非 HTTPS 协议",
            )

        normalized = cls.normalize_web_url(value)
        original = urlsplit(value)
        parsed = urlsplit(normalized)
        if parsed.scheme != "https" or parsed.hostname != "github.com":
            raise SourceLocationError(
                "invalid_github_url",
                "Git 来源仅支持 https://github.com/{owner}/{repo}[.git]",
            )
        if original.query or original.fragment or "%" in original.path:
            raise SourceLocationError("invalid_github_url", "GitHub 仓库 URL 不允许查询、片段或编码路径")

        path = parsed.path.rstrip("/")
        parts = path.lstrip("/").split("/")
        if len(parts) != 2:
            raise SourceLocationError(
                "invalid_github_url",
                "Git 来源必须精确指向 GitHub owner/repo 仓库根路径",
            )
        owner, repo = parts
        if repo.casefold().endswith(".git"):
            repo = repo[:-4]
        if (
            owner in {".", ".."}
            or repo in {"", ".", ".."}
            or not _GITHUB_COMPONENT.fullmatch(owner)
            or not _GITHUB_COMPONENT.fullmatch(repo)
        ):
            raise SourceLocationError("invalid_github_url", "GitHub owner 或 repo 名称无效")
        return f"https://github.com/{owner}/{repo}"

    @classmethod
    def normalize_remote_source(cls, source_type: Any, raw: Any) -> SourceReference:
        kind = str(source_type or "").strip().casefold()
        if kind == "github":
            return SourceReference("github", cls.normalize_github_url(raw))
        if kind != "url":
            raise SourceLocationError("unsupported_source_type", "远程来源类型只支持 url 或 github")
        normalized = cls.normalize_web_url(raw)
        if urlsplit(normalized).hostname == "github.com":
            # Git validation must see the original query/fragment instead of
            # the fragment-free canonical web URL.
            return SourceReference("github", cls.normalize_github_url(raw))
        return SourceReference("url", normalized)

    @classmethod
    def classify_remote_source(cls, raw: Any) -> SourceReference:
        normalized = cls.normalize_web_url(raw)
        if urlsplit(normalized).hostname == "github.com":
            return SourceReference("github", cls.normalize_github_url(raw))
        return SourceReference("url", normalized)

    @classmethod
    def resolve_managed_file(cls, raw: Any, managed_root: str | os.PathLike[str] | None) -> Path:
        value = str(raw or "")
        if not value or len(value.encode("utf-8")) > 4_096:
            raise SourceLocationError("invalid_managed_source", "受管来源路径为空或超过长度预算")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise SourceLocationError("invalid_managed_source", "受管来源路径包含控制字符")
        if managed_root is None:
            raise SourceLocationError(
                "unmanaged_file_source",
                "本地文件来源必须来自服务端上传目录并携带受管根目录",
            )
        root = Path(managed_root).expanduser()
        target = Path(value).expanduser()
        if not root.is_absolute():
            root = Path.cwd() / root
        if not target.is_absolute():
            target = Path.cwd() / target
        try:
            resolved_root = root.resolve(strict=True)
            resolved_target = target.resolve(strict=True)
            resolved_target.relative_to(resolved_root)
        except (FileNotFoundError, OSError, ValueError) as exc:
            raise SourceLocationError(
                "unmanaged_file_source",
                "本地来源不存在或不在该来源的服务端上传目录内",
            ) from exc
        if not (resolved_target.is_file() or resolved_target.is_dir()):
            raise SourceLocationError("invalid_managed_source", "受管来源必须是普通文件或目录")
        return resolved_target

    @classmethod
    def github_coordinates(cls, raw: Any) -> tuple[str, str]:
        normalized = cls.normalize_github_url(raw)
        owner, repo = urlsplit(normalized).path.lstrip("/").split("/", 1)
        return owner, repo

    # -- DNS and HTTP dereferencing ----------------------------------------

    async def _system_resolve(self, host: str, port: int) -> Sequence[Any]:
        return await asyncio.wait_for(
            asyncio.to_thread(
                socket.getaddrinfo,
                host,
                port,
                socket.AF_UNSPEC,
                socket.SOCK_STREAM,
            ),
            timeout=DNS_TIMEOUT_SECONDS,
        )

    @staticmethod
    def _addresses_from_resolution(entries: Iterable[Any]) -> tuple[str, ...]:
        addresses: list[str] = []
        for entry in entries:
            if isinstance(entry, (str, ipaddress.IPv4Address, ipaddress.IPv6Address)):
                raw_address = str(entry)
            elif isinstance(entry, tuple) and len(entry) >= 5 and isinstance(entry[4], tuple):
                raw_address = str(entry[4][0])
            else:
                raise SourceLocationError("dns_invalid_address", "DNS resolver 返回了不支持的结果")
            address = SourceLocator._global_address(raw_address)
            compressed = address.compressed
            if compressed not in addresses:
                addresses.append(compressed)
        if not addresses:
            raise SourceLocationError("dns_resolution_failed", "来源主机名没有可用地址")
        return tuple(addresses)

    async def resolve_web_target(self, raw: Any) -> ResolvedWebTarget:
        normalized = self.normalize_web_url(raw)
        parsed = urlsplit(normalized)
        host = parsed.hostname or ""
        port = 443 if parsed.scheme == "https" else 80
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            resolver = self._resolver or self._system_resolve
            try:
                entries = resolver(host, port)
                if inspect.isawaitable(entries):
                    entries = await asyncio.wait_for(entries, timeout=DNS_TIMEOUT_SECONDS)
            except SourceLocationError:
                raise
            except (TimeoutError, socket.gaierror, OSError) as exc:
                raise SourceLocationError(
                    "dns_resolution_failed",
                    f"无法解析来源主机名：{host}",
                ) from exc
            addresses = self._addresses_from_resolution(entries)
        else:
            addresses = (self._global_address(literal.compressed).compressed,)
        return ResolvedWebTarget(normalized, host, port, addresses)

    @staticmethod
    def _safe_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
        allowed = {"accept", "accept-language", "user-agent"}
        safe = {
            str(key): str(value)
            for key, value in dict(headers or {}).items()
            if str(key).casefold() in allowed
        }
        safe.setdefault("User-Agent", "LearnFlow/1.0")
        return safe

    async def _fetch_with_redirects(
        self,
        raw: Any,
        *,
        headers: Mapping[str, str] | None,
        max_response_bytes: int,
        max_redirects: int,
        raise_for_status: bool,
    ) -> FetchedSource:
        current = self.normalize_web_url(raw)
        observations: list[DNSObservation] = []
        timeout = httpx.Timeout(
            connect=HTTP_CONNECT_TIMEOUT_SECONDS,
            read=HTTP_READ_TIMEOUT_SECONDS,
            write=HTTP_READ_TIMEOUT_SECONDS,
            pool=HTTP_CONNECT_TIMEOUT_SECONDS,
        )
        client_options: dict[str, Any] = {
            "follow_redirects": False,
            "timeout": timeout,
            "trust_env": False,
            "limits": httpx.Limits(max_connections=4, max_keepalive_connections=0),
        }
        if self._transport is not None:
            client_options["transport"] = self._transport
        async with httpx.AsyncClient(**client_options) as client:
            for redirect_count in range(max_redirects + 1):
                preflight = await self.resolve_web_target(current)
                observations.append(DNSObservation(preflight.host, "before_request", preflight.addresses))
                postflight_attempted = False
                try:
                    async with client.stream(
                        "GET",
                        preflight.url,
                        headers=self._safe_headers(headers),
                        follow_redirects=False,
                    ) as response:
                        postflight_attempted = True
                        postflight = await self.resolve_web_target(preflight.url)
                        observations.append(DNSObservation(postflight.host, "after_headers", postflight.addresses))

                        if response.status_code in _REDIRECT_STATUSES:
                            location = response.headers.get("location")
                            if not location:
                                raise SourceLocationError("invalid_redirect", "重定向响应缺少 Location")
                            if len(location.encode("utf-8")) > MAX_REDIRECT_LOCATION_BYTES:
                                raise SourceLocationError("redirect_location_too_long", "重定向地址超过长度预算")
                            if redirect_count >= max_redirects:
                                raise SourceLocationError("redirect_budget_exceeded", "来源重定向次数超过预算")
                            destination = self.normalize_web_url(urljoin(preflight.url, location))
                            if urlsplit(preflight.url).scheme == "https" and urlsplit(destination).scheme != "https":
                                raise SourceLocationError("https_downgrade_forbidden", "HTTPS 来源不能重定向到 HTTP")
                            current = destination
                            continue

                        if raise_for_status and not 200 <= response.status_code < 300:
                            raise SourceLocationError(
                                "remote_http_error",
                                f"远程来源返回 HTTP {response.status_code}",
                            )
                        content_length = response.headers.get("content-length")
                        if content_length:
                            try:
                                declared_length = int(content_length)
                            except ValueError:
                                declared_length = -1
                            if declared_length > max_response_bytes:
                                raise SourceLocationError("response_budget_exceeded", "来源响应体超过字节预算")

                        body = bytearray()
                        async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                            if len(body) + len(chunk) > max_response_bytes:
                                raise SourceLocationError("response_budget_exceeded", "来源响应体超过字节预算")
                            body.extend(chunk)
                        return FetchedSource(
                            url=str(response.url),
                            status_code=response.status_code,
                            headers=dict(response.headers),
                            body=bytes(body),
                            encoding=response.encoding,
                            dns_observations=tuple(observations),
                        )
                except SourceLocationError:
                    raise
                except httpx.TimeoutException as exc:
                    raise SourceLocationError("remote_timeout", "远程来源请求超时") from exc
                except httpx.HTTPError as exc:
                    raise SourceLocationError("remote_request_failed", "远程来源请求失败") from exc
                finally:
                    if not postflight_attempted:
                        # This detects some DNS changes but does not pin the
                        # verified address to HTTPX's connection.
                        postflight = await self.resolve_web_target(preflight.url)
                        observations.append(DNSObservation(
                            postflight.host,
                            "after_request_error",
                            postflight.addresses,
                        ))
        raise SourceLocationError("redirect_budget_exceeded", "来源重定向次数超过预算")

    async def fetch(
        self,
        raw: Any,
        *,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int = MAX_WEB_RESPONSE_BYTES,
        max_redirects: int = MAX_HTTP_REDIRECTS,
        total_timeout_seconds: float = HTTP_TOTAL_TIMEOUT_SECONDS,
        raise_for_status: bool = True,
    ) -> FetchedSource:
        if not 0 < max_response_bytes <= 100 * 1024 * 1024:
            raise SourceLocationError("invalid_response_budget", "响应体预算必须在 1 字节到 100 MiB 之间")
        if not 0 <= max_redirects <= MAX_HTTP_REDIRECTS:
            raise SourceLocationError("invalid_redirect_budget", f"重定向预算不能超过 {MAX_HTTP_REDIRECTS}")
        if not 0 < total_timeout_seconds <= MAX_HTTP_TOTAL_TIMEOUT_SECONDS:
            raise SourceLocationError(
                "invalid_timeout_budget",
                f"远程来源总超时预算不能超过 {MAX_HTTP_TOTAL_TIMEOUT_SECONDS:g} 秒",
            )
        try:
            return await asyncio.wait_for(
                self._fetch_with_redirects(
                    raw,
                    headers=headers,
                    max_response_bytes=max_response_bytes,
                    max_redirects=max_redirects,
                    raise_for_status=raise_for_status,
                ),
                timeout=total_timeout_seconds,
            )
        except SourceLocationError:
            raise
        except TimeoutError as exc:
            raise SourceLocationError("remote_total_timeout", "远程来源解引用超过总时间预算") from exc

    # -- GitHub clone boundary ---------------------------------------------

    @staticmethod
    def git_clone_command(normalized_url: str, destination: str | os.PathLike[str]) -> list[str]:
        return [
            "git",
            "-c", "protocol.allow=never",
            "-c", "protocol.https.allow=always",
            "-c", "protocol.file.allow=never",
            "-c", "protocol.ssh.allow=never",
            "-c", "protocol.git.allow=never",
            "-c", "protocol.ext.allow=never",
            "-c", "http.followRedirects=false",
            "-c", "credential.helper=",
            "-c", f"core.hooksPath={os.devnull}",
            "clone",
            "--quiet",
            "--depth", "1",
            "--single-branch",
            "--no-tags",
            "--no-local",
            "--filter=blob:limit=26214400",
            "--",
            normalized_url,
            str(destination),
        ]

    @staticmethod
    def git_environment() -> dict[str, str]:
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "LANG": "C",
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ALLOW_PROTOCOL": "https",
            "GIT_PROTOCOL_FROM_USER": "0",
            "GIT_LFS_SKIP_SMUDGE": "1",
        }
        return environment

    @staticmethod
    def _bounded_tree_size(root: Path, maximum: int) -> int:
        total = 0
        entries = 0
        for current_root, directories, files in os.walk(root, followlinks=False):
            current = Path(current_root)
            directories[:] = [name for name in directories if not (current / name).is_symlink()]
            entries += len(directories)
            if entries > GIT_CLONE_MAX_ENTRIES:
                return maximum + 1
            for name in files:
                entries += 1
                if entries > GIT_CLONE_MAX_ENTRIES:
                    return maximum + 1
                try:
                    total += (current / name).lstat().st_size
                except OSError:
                    continue
                if total > maximum:
                    return total
        return total

    @staticmethod
    def _stop_process(process: subprocess.Popen[bytes]) -> bytes:
        if process.poll() is None:
            process.kill()
        try:
            _, stderr = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            _, stderr = process.communicate()
        return stderr or b""

    def _run_git_clone(self, normalized_url: str, destination: Path) -> None:
        git_executable = shutil.which("git", path=self.git_environment().get("PATH"))
        if git_executable is None:
            raise SourceLocationError("git_unavailable", "运行环境中没有可用的 git")
        if destination.exists() and any(destination.iterdir()):
            raise SourceLocationError("clone_destination_not_empty", "Git 克隆目标目录必须为空")
        destination.parent.mkdir(parents=True, exist_ok=True)
        command = self.git_clone_command(normalized_url, destination)
        command[0] = git_executable
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=self.git_environment(),
        )
        deadline = time.monotonic() + GIT_CLONE_TIMEOUT_SECONDS
        while process.poll() is None:
            if time.monotonic() >= deadline:
                self._stop_process(process)
                raise SourceLocationError("git_clone_timeout", "Git 克隆超过时间预算")
            if destination.exists() and self._bounded_tree_size(destination, GIT_CLONE_MAX_BYTES) > GIT_CLONE_MAX_BYTES:
                self._stop_process(process)
                raise SourceLocationError("git_clone_budget_exceeded", "Git 克隆目录超过体积或条目预算")
            time.sleep(GIT_CLONE_POLL_SECONDS)

        stderr = self._stop_process(process)
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip()[:300]
            raise SourceLocationError("git_clone_failed", message or "Git clone failed")
        if self._bounded_tree_size(destination, GIT_CLONE_MAX_BYTES) > GIT_CLONE_MAX_BYTES:
            raise SourceLocationError("git_clone_budget_exceeded", "Git 克隆目录超过体积或条目预算")

    async def clone_github(self, raw: Any, destination: str | os.PathLike[str]) -> str:
        normalized = self.normalize_github_url(raw)
        await self.resolve_web_target(normalized)
        try:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(self._run_git_clone, normalized, Path(destination)),
                    timeout=GIT_CLONE_TIMEOUT_SECONDS + DNS_TIMEOUT_SECONDS + 2,
                )
            except SourceLocationError:
                raise
            except TimeoutError as exc:
                raise SourceLocationError("git_clone_timeout", "Git 克隆超过时间预算") from exc
        finally:
            # Post-clone resolution is a detection boundary, not socket pinning.
            await self.resolve_web_target(normalized)
        return normalized


SOURCE_LOCATOR = SourceLocator()
