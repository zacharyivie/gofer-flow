from __future__ import annotations

import http.client
import socket
import ssl
import urllib.parse
from dataclasses import dataclass, field
from typing import Protocol

import anyio

from gofer.core.network_policy import resolve_http_request_target


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None
    timeout_seconds: float = 30.0
    network_allowlist: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class HttpClient(Protocol):
    async def send(self, request: HttpRequest) -> HttpResponse:
        """Send an HTTP request and return the response."""


class UrllibHttpClient:
    async def send(self, request: HttpRequest) -> HttpResponse:
        return await anyio.to_thread.run_sync(self._send_sync, request)

    def _send_sync(self, request: HttpRequest) -> HttpResponse:
        parsed = urllib.parse.urlsplit(request.url)
        target = resolve_http_request_target(
            request.url,
            allowlist=request.network_allowlist,
        )
        path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        headers = dict(request.headers)
        if parsed.scheme.lower() == "https":
            conn: _PolicyHttpConnection | _PolicyHttpsConnection = _PolicyHttpsConnection(
                target.host,
                target.connect_port,
                timeout=request.timeout_seconds,
            )
        else:
            conn = _PolicyHttpConnection(
                target.host,
                target.connect_port,
                timeout=request.timeout_seconds,
            )
        conn.set_policy_target(target.connect_host, target.connect_port)
        try:
            conn.request(
                request.method.upper(),
                path,
                body=request.body,
                headers=headers,
            )
            response = conn.getresponse()
            return HttpResponse(
                status=response.status,
                headers=dict(response.headers.items()),
                body=response.read(),
            )
        finally:
            conn.close()


class _PolicyHttpConnection(http.client.HTTPConnection):
    _gofer_connect_host: str
    _gofer_connect_port: int

    def set_policy_target(self, host: str, port: int) -> None:
        self._gofer_connect_host = host
        self._gofer_connect_port = port

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._gofer_connect_host, self._gofer_connect_port),
            self.timeout,
            getattr(self, "source_address", None),
        )


class _PolicyHttpsConnection(http.client.HTTPSConnection):
    _gofer_connect_host: str
    _gofer_connect_port: int

    def set_policy_target(self, host: str, port: int) -> None:
        self._gofer_connect_host = host
        self._gofer_connect_port = port

    def connect(self) -> None:
        sock = socket.create_connection(
            (self._gofer_connect_host, self._gofer_connect_port),
            self.timeout,
            getattr(self, "source_address", None),
        )
        context = getattr(self, "_context", None)
        if context is None:
            context = ssl.create_default_context()
        self.sock = context.wrap_socket(sock, server_hostname=self.host)


def append_query_params(url: str, params: dict[str, str]) -> str:
    if not params:
        return url
    parsed = urllib.parse.urlsplit(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_pairs.extend((key, value) for key, value in params.items())
    return urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(query_pairs))
    )
