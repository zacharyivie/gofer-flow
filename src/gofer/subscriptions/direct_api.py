from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, cast

from gofer.core.agent import AgentResult
from gofer.core.http import HttpClient, HttpRequest, UrllibHttpClient
from gofer.core.provider_profiles import ResolvedProviderSettings
from gofer.subscriptions.base import Subscription


class DirectProviderError(RuntimeError):
    pass


class DirectApiSubscription(Subscription):
    subscription_name: str
    default_model: str

    def __init__(self, http_client: HttpClient | None = None) -> None:
        self._http_client = http_client or UrllibHttpClient()

    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event: Any | None = None,
        extra_paths: list[Path] | None = None,
        max_output_bytes: int | None = None,
        on_thought: Any | None = None,
        provider_settings: ResolvedProviderSettings | None = None,
    ) -> AgentResult:
        if provider_settings is None or provider_settings.subscription != self.subscription_name:
            raise ValueError(
                f"Direct API subscription requires '{self.subscription_name}' settings"
            )
        if tools or mcp_servers or extra_paths:
            raise ValueError(
                "Direct API subscriptions do not support tools, MCP servers, or extra paths"
            )
        api_key = env.get("GOFER_DIRECT_API_KEY")
        if not api_key:
            raise ValueError(
                f"Direct API provider '{self.subscription_name}' is missing an API key"
            )

        start = time.monotonic()
        try:
            request = self._request(prompt, api_key, provider_settings, timeout)
            response = await self._http_client.send(request)
            payload = _json_body(response.body)
            if response.status >= 400:
                raise DirectProviderError(_normalized_error(response.status, payload))
            message, metadata = self._parse_success(payload, provider_settings)
            metadata.setdefault("provider", self.subscription_name)
            metadata.setdefault("profile", provider_settings.profile_name)
            metadata.setdefault("model", provider_settings.model or self.default_model)
            metadata.setdefault("source", "provider_metadata")
            return AgentResult(
                agent_id="",
                success=True,
                output=message,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                thoughts=[],
                message=message,
                provider=self.subscription_name,
                profile=provider_settings.profile_name,
                model=provider_settings.model or self.default_model,
                usage_metadata=metadata,
            )
        except DirectProviderError as exc:
            return AgentResult(
                agent_id="",
                success=False,
                output=str(exc),
                exit_code=1,
                duration_seconds=time.monotonic() - start,
                thoughts=[],
                message=str(exc),
                provider=self.subscription_name,
                profile=provider_settings.profile_name,
                model=provider_settings.model or self.default_model,
            )
        except Exception as exc:  # noqa: BLE001
            message = f"Provider service is temporarily unavailable: {exc}"
            return AgentResult(
                agent_id="",
                success=False,
                output=message,
                exit_code=1,
                duration_seconds=time.monotonic() - start,
                thoughts=[],
                message=message,
                provider=self.subscription_name,
                profile=provider_settings.profile_name,
                model=provider_settings.model or self.default_model,
            )

    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
        provider_settings: ResolvedProviderSettings | None = None,
    ) -> list[str]:
        return [self.subscription_name, "<direct-api>"]

    def is_available(self) -> bool:
        return True

    def _request(
        self,
        prompt: str,
        api_key: str,
        settings: ResolvedProviderSettings,
        timeout: float | None,
    ) -> HttpRequest:
        raise NotImplementedError

    def _parse_success(
        self,
        payload: dict[str, Any],
        settings: ResolvedProviderSettings,
    ) -> tuple[str, dict[str, object]]:
        raise NotImplementedError


class OpenAiApiSubscription(DirectApiSubscription):
    subscription_name = "openai_api"
    default_model = "gpt-5-mini"

    def _request(
        self,
        prompt: str,
        api_key: str,
        settings: ResolvedProviderSettings,
        timeout: float | None,
    ) -> HttpRequest:
        base_url = (settings.api_base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = str(settings.provider_options.get("api") or "responses")
        path = "/chat/completions" if api_mode == "chat" else "/responses"
        body: dict[str, Any]
        if api_mode == "chat":
            body = {
                "model": settings.model or self.default_model,
                "messages": [{"role": "user", "content": prompt}],
            }
        else:
            body = {"model": settings.model or self.default_model, "input": prompt}
        body.update(_safe_provider_options(settings.provider_options))
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if settings.organization:
            headers["OpenAI-Organization"] = settings.organization
        return HttpRequest(
            method="POST",
            url=f"{base_url}{path}",
            headers=headers,
            body=json.dumps(body).encode("utf-8"),
            timeout_seconds=timeout or 120.0,
        )

    def _parse_success(
        self,
        payload: dict[str, Any],
        settings: ResolvedProviderSettings,
    ) -> tuple[str, dict[str, object]]:
        message = _openai_message(payload)
        raw_usage = payload.get("usage")
        usage = cast(dict[str, Any], raw_usage) if isinstance(raw_usage, dict) else {}
        metadata = _usage_metadata(usage)
        metadata["model"] = str(payload.get("model") or settings.model or self.default_model)
        return message, metadata


class AnthropicApiSubscription(DirectApiSubscription):
    subscription_name = "anthropic_api"
    default_model = "claude-3-5-sonnet-latest"

    def _request(
        self,
        prompt: str,
        api_key: str,
        settings: ResolvedProviderSettings,
        timeout: float | None,
    ) -> HttpRequest:
        base_url = (settings.api_base_url or "https://api.anthropic.com/v1").rstrip("/")
        body = {
            "model": settings.model or self.default_model,
            "max_tokens": int(settings.provider_options.get("max_tokens") or 1024),
            "messages": [{"role": "user", "content": prompt}],
        }
        body.update(_safe_provider_options(settings.provider_options))
        return HttpRequest(
            method="POST",
            url=f"{base_url}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": str(
                    settings.provider_options.get("anthropic_version") or "2023-06-01"
                ),
                "Content-Type": "application/json",
            },
            body=json.dumps(body).encode("utf-8"),
            timeout_seconds=timeout or 120.0,
        )

    def _parse_success(
        self,
        payload: dict[str, Any],
        settings: ResolvedProviderSettings,
    ) -> tuple[str, dict[str, object]]:
        message = _anthropic_message(payload)
        raw_usage = payload.get("usage")
        usage = cast(dict[str, Any], raw_usage) if isinstance(raw_usage, dict) else {}
        metadata = _usage_metadata(usage)
        metadata["model"] = str(payload.get("model") or settings.model or self.default_model)
        return message, metadata


def _json_body(body: bytes) -> dict[str, Any]:
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DirectProviderError("Provider returned a non-JSON response") from exc
    if not isinstance(decoded, dict):
        raise DirectProviderError("Provider returned an unexpected response shape")
    return decoded


def _safe_provider_options(options: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in options.items()
        if key not in {"api", "anthropic_version"}
    }


def _openai_message(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text:
        return output_text
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content
    output = payload.get("output")
    if isinstance(output, list):
        texts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            for part in item.get("content") or []:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    texts.append(part["text"])
        if texts:
            return "\n".join(texts)
    return ""


def _anthropic_message(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    texts = [
        part["text"]
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    return "\n".join(texts)


def _usage_metadata(usage: dict[str, Any]) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for source, target in (
        ("input_tokens", "input_tokens"),
        ("prompt_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("completion_tokens", "output_tokens"),
        ("total_tokens", "total_tokens"),
        ("cost_usd", "cost_usd"),
    ):
        if source in usage:
            metadata[target] = usage[source]
    if "input_tokens" in metadata and "output_tokens" in metadata:
        input_tokens = int(cast(int | float | str, metadata["input_tokens"]))
        output_tokens = int(cast(int | float | str, metadata["output_tokens"]))
        metadata.setdefault(
            "total_tokens",
            input_tokens + output_tokens,
        )
    return metadata


def _normalized_error(status: int, payload: dict[str, Any]) -> str:
    raw_error = payload.get("error")
    error = cast(dict[str, Any], raw_error) if isinstance(raw_error, dict) else {}
    code = str(error.get("code") or error.get("type") or "").lower()
    raw_message = str(error.get("message") or payload.get("message") or "Provider API error")
    if status in {401, 403} or "auth" in code or "permission" in code:
        return f"Authentication failed for direct provider: {raw_message}"
    if status == 429 or "rate" in code:
        return f"Provider rate limit exceeded: {raw_message}"
    if status == 404 or "model" in code and "not" in code:
        return f"Provider model is unavailable or missing: {raw_message}"
    if status == 400 and ("context" in code or "token" in code or "length" in code):
        return f"Provider context length limit exceeded: {raw_message}"
    if status >= 500:
        return f"Provider service is temporarily unavailable: {raw_message}"
    return f"Provider request failed ({status}): {raw_message}"
