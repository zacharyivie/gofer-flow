from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

import anyio


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None
    timeout_seconds: float = 30.0


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
        req = urllib.request.Request(
            request.url,
            data=request.body,
            headers=request.headers,
            method=request.method.upper(),
        )
        try:
            with urllib.request.urlopen(req, timeout=request.timeout_seconds) as response:
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers.items()),
                    body=response.read(),
                )
        except urllib.error.HTTPError as exc:
            return HttpResponse(
                status=exc.code,
                headers=dict(exc.headers.items()),
                body=exc.read(),
            )


def append_query_params(url: str, params: dict[str, str]) -> str:
    if not params:
        return url
    parsed = urllib.parse.urlsplit(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_pairs.extend((key, value) for key, value in params.items())
    return urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(query_pairs))
    )
