from __future__ import annotations

import socket
from types import SimpleNamespace
from typing import Any

import pytest

from gofer.core import http as http_module
from gofer.core.http import HttpRequest, UrllibHttpClient, append_query_params


def _install_recording_connection(
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: int,
    headers: list[tuple[str, str]],
    body: bytes,
) -> dict[str, Any]:
    calls: dict[str, Any] = {}

    class RecordingConnection:
        def __init__(self, host: str, port: int, timeout: float) -> None:
            calls.update({"host": host, "port": port, "timeout": timeout})

        def set_policy_target(self, host: str, port: int) -> None:
            calls.update({"connect_host": host, "connect_port": port})

        def request(
            self,
            method: str,
            path: str,
            *,
            body: bytes | None,
            headers: dict[str, str],
        ) -> None:
            calls.update(
                {"method": method, "path": path, "body": body, "headers": headers}
            )

        def getresponse(self) -> SimpleNamespace:
            return SimpleNamespace(
                status=status,
                headers=SimpleNamespace(items=lambda: headers),
                read=lambda: body,
            )

        def close(self) -> None:
            calls["closed"] = True

    monkeypatch.setattr(http_module, "_PolicyHttpConnection", RecordingConnection)
    return calls


def test_append_query_params_returns_original_url_for_empty_params() -> None:
    url = "https://example.test/search?existing=1#results"

    assert append_query_params(url, {}) == url


def test_append_query_params_preserves_existing_repeated_and_blank_values() -> None:
    url = "https://example.test/search?tag=one&empty=&tag=two"

    assert (
        append_query_params(url, {"tag": "three", "q": ""})
        == "https://example.test/search?tag=one&empty=&tag=two&tag=three&q="
    )


def test_append_query_params_encodes_spaces_special_characters_and_keeps_fragment() -> None:
    url = "https://example.test/search?existing=value#section"

    assert (
        append_query_params(url, {"phrase": "hello world", "symbols": "a/b?&="})
        == "https://example.test/search?existing=value&phrase=hello+world&symbols=a%2Fb%3F%26%3D#section"
    )


def test_urllib_http_client_sends_request_and_maps_success_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_recording_connection(
        monkeypatch,
        status=201,
        headers=[("Content-Type", "application/json"), ("X-Gofer-Test", "success")],
        body=b'{"ok": true}',
    )

    response = UrllibHttpClient()._send_sync(
        HttpRequest(
            method="post",
            url="http://127.0.0.1:8080/ok?x=1",
            headers={"X-Request": "gofer"},
            body=b"payload",
            timeout_seconds=3.5,
            network_allowlist=["127.0.0.1"],
        )
    )

    assert response.status == 201
    assert response.headers["Content-Type"] == "application/json"
    assert response.headers["X-Gofer-Test"] == "success"
    assert response.body == b'{"ok": true}'
    assert calls == {
        "host": "127.0.0.1",
        "port": 8080,
        "timeout": 3.5,
        "connect_host": "127.0.0.1",
        "connect_port": 8080,
        "method": "POST",
        "path": "/ok?x=1",
        "body": b"payload",
        "headers": {"X-Request": "gofer"},
        "closed": True,
    }


def test_urllib_http_client_maps_non_2xx_response_without_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_recording_connection(
        monkeypatch,
        status=418,
        headers=[("X-Error", "teapot")],
        body=b"request failed",
    )

    response = UrllibHttpClient()._send_sync(
        HttpRequest(
            method="POST",
            url="http://127.0.0.1:8080/error",
            body=b"bad request",
            network_allowlist=["127.0.0.1"],
        )
    )

    assert response.status == 418
    assert response.headers["X-Error"] == "teapot"
    assert response.body == b"request failed"


def test_urllib_http_client_passes_timeout_to_http_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_recording_connection(
        monkeypatch,
        status=204,
        headers=[("X-Test", "ok")],
        body=b"",
    )

    response = UrllibHttpClient()._send_sync(
        HttpRequest(
            method="patch",
            url="http://127.0.0.1:8080/path?x=1",
            headers={"X-Request": "gofer"},
            body=b"body",
            timeout_seconds=1.25,
            network_allowlist=["127.0.0.1"],
        )
    )

    assert response.status == 204
    assert calls == {
        "host": "127.0.0.1",
        "port": 8080,
        "timeout": 1.25,
        "connect_host": "127.0.0.1",
        "connect_port": 8080,
        "method": "PATCH",
        "path": "/path?x=1",
        "body": b"body",
        "headers": {"X-Request": "gofer"},
        "closed": True,
    }


def test_urllib_http_client_propagates_lower_level_network_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raise_network_error(
        _address: tuple[str, int],
        _timeout: float | object = socket._GLOBAL_DEFAULT_TIMEOUT,
        _source_address: tuple[str, int] | None = None,
    ) -> socket.socket:
        raise OSError("connection refused")

    monkeypatch.setattr(http_module.socket, "create_connection", raise_network_error)

    with pytest.raises(OSError, match="connection refused"):
        UrllibHttpClient()._send_sync(
            HttpRequest(
                method="GET",
                url="http://127.0.0.1:9/status",
                network_allowlist=["127.0.0.1"],
            )
        )
