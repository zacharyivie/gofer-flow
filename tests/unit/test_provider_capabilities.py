from __future__ import annotations

import asyncio
import json
import threading
from typing import cast

import pytest

from gofer.core import provider_capabilities
from gofer.core.provider_capabilities import (
    ClaudeCodeCapabilityProbe,
    CodexCapabilityProbe,
    ProviderCapability,
    ProviderCapabilityError,
    ProviderCapabilityService,
    provider_capabilities_payload_async,
    resolve_provider_executable,
    validate_provider_selection,
)


@pytest.mark.asyncio
async def test_codex_probe_uses_cli_catalog_and_per_model_efforts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = {
        "models": [
            {
                "slug": "gpt-5.6-sol",
                "display_name": "GPT-5.6-Sol",
                "visibility": "list",
                "priority": 1,
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                    {"effort": "low", "description": "Fast"},
                    {"effort": "medium", "description": "Balanced"},
                    {"effort": "ultra", "description": "Delegated"},
                ],
            },
            {
                "slug": "hidden-model",
                "visibility": "hidden",
                "priority": 0,
                "supported_reasoning_levels": [{"effort": "high"}],
            },
        ]
    }

    async def fake_run(command: list[str], **_kwargs: object) -> tuple[int, str, str]:
        if command[-1] == "--version":
            return 0, "codex-cli 0.145.0\n", ""
        return 0, json.dumps(catalog), ""

    monkeypatch.setattr(provider_capabilities, "_run_probe", fake_run)

    capability = await CodexCapabilityProbe().discover("/tmp/codex")

    assert capability.discovery_status == "ready"
    assert capability.default_model == "gpt-5.6-sol"
    assert [model.id for model in capability.models] == ["gpt-5.6-sol"]
    assert [effort.id for effort in capability.models[0].efforts] == ["low", "medium", "ultra"]
    assert capability.models[0].default_effort == "medium"


@pytest.mark.asyncio
async def test_claude_probe_uses_slash_catalog_and_supported_efforts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[list[str]] = []
    model_response = "\n".join(
        [
            json.dumps(
                {
                    "type": "system",
                    "subtype": "init",
                    "model": "claude-sonnet-5",
                }
            ),
            json.dumps(
                {
                    "type": "result",
                    "result": (
                        "Current model: Sonnet 5 (default) (effort: high)\n"
                        "Usage: /model <name>. Available: sonnet, opus, haiku, or a full model ID."
                    ),
                }
            ),
        ]
    )
    effort_response = json.dumps(
        {"type": "result", "result": "Usage: /effort <low|medium|high|xhigh|max|auto>"}
    )

    async def fake_run(command: list[str], **_kwargs: object) -> tuple[int, str, str]:
        commands.append(command)
        if command[-1] == "--version":
            return 0, "2.1.0\n", ""
        if command[-1] == "/model":
            return 0, model_response, ""
        return 0, effort_response, ""

    monkeypatch.setattr(provider_capabilities, "_run_probe", fake_run)

    capability = await ClaudeCodeCapabilityProbe().discover("/tmp/claude")

    assert [command[-1] for command in commands] == ["--version", "/model", "/effort"]
    assert capability.default_model == "claude-sonnet-5"
    assert [model.id for model in capability.models] == [
        "claude-sonnet-5",
        "sonnet",
        "opus",
        "haiku",
    ]
    assert [effort.id for effort in capability.models[0].efforts] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "auto",
    ]


def test_capability_service_caches_probe_result(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ProviderCapabilityService()
    calls = 0

    async def discover(_executable: str | None = None) -> ProviderCapability:
        nonlocal calls
        calls += 1
        return ProviderCapability(
            id="codex",
            display_name="Codex",
            available=True,
            discovery_status="ready",
        )

    monkeypatch.setattr(provider_capabilities.shutil, "which", lambda _name: "/tmp/codex")
    monkeypatch.setattr(service._probes["codex"], "discover", discover)

    assert service.provider("codex").discovery_status == "ready"
    assert service.provider("codex").discovery_status == "ready"
    assert calls == 1


@pytest.mark.asyncio
async def test_capability_service_discovers_inside_running_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderCapabilityService()

    async def discover(_executable: str | None = None) -> ProviderCapability:
        return ProviderCapability(
            id="codex",
            display_name="Codex",
            available=True,
            discovery_status="ready",
        )

    monkeypatch.setattr(provider_capabilities.shutil, "which", lambda _name: "/tmp/codex")
    monkeypatch.setattr(service._probes["codex"], "discover", discover)

    capability = await service.provider_async("codex")

    assert capability.discovery_status == "ready"


@pytest.mark.asyncio
async def test_concurrent_async_discovery_shares_one_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderCapabilityService()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def discover(_executable: str | None = None) -> ProviderCapability:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return ProviderCapability(
            id="codex",
            display_name="Codex",
            available=True,
            discovery_status="ready",
        )

    monkeypatch.setattr(provider_capabilities.shutil, "which", lambda _name: "/tmp/codex")
    monkeypatch.setattr(service._probes["codex"], "discover", discover)

    tasks = [asyncio.create_task(service.provider_async("codex")) for _ in range(8)]
    await started.wait()
    await asyncio.sleep(0)
    release.set()
    capabilities = await asyncio.gather(*tasks)

    assert calls == 1
    assert all(capability is capabilities[0] for capability in capabilities)


@pytest.mark.asyncio
async def test_sync_and_async_discovery_share_one_inflight_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderCapabilityService()
    started = threading.Event()
    release = threading.Event()
    calls = 0
    sync_results: list[ProviderCapability] = []

    async def discover(_executable: str | None = None) -> ProviderCapability:
        nonlocal calls
        calls += 1
        started.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return ProviderCapability(
            id="codex",
            display_name="Codex",
            available=True,
            discovery_status="ready",
        )

    monkeypatch.setattr(provider_capabilities.shutil, "which", lambda _name: "/tmp/codex")
    monkeypatch.setattr(service._probes["codex"], "discover", discover)

    sync_thread = threading.Thread(
        target=lambda: sync_results.append(service.provider("codex")),
    )
    sync_thread.start()
    while not started.is_set():
        await asyncio.sleep(0.01)
    async_task = asyncio.create_task(service.provider_async("codex"))
    await asyncio.sleep(0)
    release.set()
    async_capability = await async_task
    sync_thread.join(timeout=2)

    assert calls == 1
    assert not sync_thread.is_alive()
    assert sync_results == [async_capability]


@pytest.mark.asyncio
async def test_sync_capability_apis_fail_fast_inside_running_loop() -> None:
    service = ProviderCapabilityService()

    with pytest.raises(RuntimeError, match=r"await provider_async\(\) instead"):
        service.provider("codex")
    with pytest.raises(RuntimeError, match=r"await payload_async\(\) instead"):
        service.payload()
    with pytest.raises(
        RuntimeError,
        match=r"await validate_provider_selection_async\(\) instead",
    ):
        validate_provider_selection("codex", None, None, service=service)


@pytest.mark.asyncio
async def test_async_provider_payload_uses_async_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class AsyncService:
        async def payload_async(
            self,
            *,
            refresh: bool = False,
        ) -> dict[str, list[dict[str, object]]]:
            return {"providers": [{"id": "codex", "refresh": refresh}]}

    service = cast(ProviderCapabilityService, AsyncService())
    monkeypatch.setattr(provider_capabilities, "provider_capability_service", lambda: service)

    assert await provider_capabilities_payload_async(refresh=True) == {
        "providers": [{"id": "codex", "refresh": True}]
    }


def test_resolve_claude_executable_uses_nvm_default_when_not_on_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    executable = tmp_path / "versions" / "node" / "v20.20.0" / "bin" / "claude"
    executable.parent.mkdir(parents=True)
    executable.touch()
    executable.chmod(0o755)
    default = tmp_path / "alias" / "default"
    default.parent.mkdir()
    default.write_text("v20.20.0\n", encoding="utf-8")
    monkeypatch.setenv("NVM_DIR", str(tmp_path))
    monkeypatch.setattr(provider_capabilities.shutil, "which", lambda _name: None)

    assert resolve_provider_executable("claude_code") == str(executable)


def test_selection_validation_rejects_model_effort_not_in_host_catalog() -> None:
    capability = ProviderCapability.model_validate(
        {
            "id": "codex",
            "display_name": "Codex",
            "available": True,
            "discovery_status": "ready",
            "default_model": "gpt-5.6-sol",
            "models": [
                {
                    "id": "gpt-5.6-sol",
                    "display_name": "GPT-5.6-Sol",
                    "efforts": [{"id": "high", "display_name": "High"}],
                }
            ],
        }
    )

    class StaticService:
        def provider(self, _provider_id: str) -> ProviderCapability:
            return capability

    service = cast(ProviderCapabilityService, StaticService())
    validate_provider_selection("codex", "gpt-5.6-sol", "high", service=service)
    with pytest.raises(ProviderCapabilityError, match="Effort 'low'"):
        validate_provider_selection("codex", "gpt-5.6-sol", "low", service=service)
    with pytest.raises(ProviderCapabilityError, match="Model 'unknown'"):
        validate_provider_selection("codex", "unknown", None, service=service)
