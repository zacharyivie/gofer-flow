from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from gofer.utils.paths import get_data_dir

ProfileSubscription = Literal["claude_code", "codex"]
ApprovalMode = Literal["default", "auto", "manual", "never", "on-request", "on-failure"]
SandboxMode = Literal["default", "read-only", "workspace-write", "danger-full-access"]

PROFILE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")


class ProviderProfile(BaseModel):
    name: str
    subscription: ProfileSubscription
    model: str | None = None
    timeout: float | None = None
    reasoning: str | None = None
    approval_mode: ApprovalMode | None = None
    sandbox_mode: SandboxMode | None = None
    extra_args: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    secret_refs: dict[str, str] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, value: str) -> str:
        if not PROFILE_NAME_PATTERN.fullmatch(value):
            raise ValueError("Profile name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
        return value

    @field_validator("timeout")
    @classmethod
    def _validate_timeout(cls, value: float | None) -> float | None:
        if value is not None and value <= 0:
            raise ValueError("Profile timeout must be greater than 0")
        return value


class ResolvedProviderSettings(BaseModel):
    profile_name: str | None = None
    subscription: ProfileSubscription
    model: str | None = None
    timeout: float | None = None
    reasoning: str | None = None
    approval_mode: ApprovalMode | None = None
    sandbox_mode: SandboxMode | None = None
    extra_args: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    secret_refs: dict[str, str] = Field(default_factory=dict)


def profile_store_path(data_dir: Path | None = None) -> Path:
    return (data_dir or get_data_dir()) / "provider-profiles.json"


def load_provider_profiles(data_dir: Path | None = None) -> dict[str, ProviderProfile]:
    path = profile_store_path(data_dir)
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_profiles = data.get("profiles", data)
    if not isinstance(raw_profiles, dict):
        raise ValueError("Provider profile store must contain an object")
    return {
        str(name): ProviderProfile(
            name=str(name),
            **{k: v for k, v in value.items() if k != "name"},
        )
        for name, value in raw_profiles.items()
        if isinstance(value, dict)
    }


def save_provider_profiles(
    profiles: dict[str, ProviderProfile],
    data_dir: Path | None = None,
) -> None:
    path = profile_store_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "profiles": {
            name: profile.model_dump(exclude_none=True)
            for name, profile in sorted(profiles.items())
        }
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def resolve_provider_settings(
    *,
    agent_subscription: ProfileSubscription,
    profile_name: str | None,
    agent_model: str | None = None,
    operation_model: str | None = None,
    operation_profile: str | None = None,
    operation_timeout: float | None = None,
    data_dir: Path | None = None,
) -> ResolvedProviderSettings:
    selected_profile_name = operation_profile or profile_name
    profiles = load_provider_profiles(data_dir)
    profile = profiles.get(selected_profile_name) if selected_profile_name else None
    if selected_profile_name and profile is None:
        raise ValueError(f"Provider profile '{selected_profile_name}' was not found")
    subscription = profile.subscription if profile else agent_subscription
    if profile and profile.subscription != agent_subscription:
        raise ValueError(
            f"Provider profile '{profile.name}' uses subscription '{profile.subscription}', "
            f"but agent is configured for '{agent_subscription}'"
        )
    return ResolvedProviderSettings(
        profile_name=profile.name if profile else selected_profile_name,
        subscription=subscription,
        model=operation_model or agent_model or (profile.model if profile else None),
        timeout=(
            operation_timeout
            if operation_timeout is not None
            else (profile.timeout if profile else None)
        ),
        reasoning=profile.reasoning if profile else None,
        approval_mode=profile.approval_mode if profile else None,
        sandbox_mode=profile.sandbox_mode if profile else None,
        extra_args=list(profile.extra_args) if profile else [],
        tools=list(profile.tools) if profile else [],
        mcp_servers=list(profile.mcp_servers) if profile else [],
        env=dict(profile.env) if profile else {},
        secret_refs=dict(profile.secret_refs) if profile else {},
    )


def validate_provider_settings(settings: ResolvedProviderSettings) -> None:
    if settings.subscription == "codex":
        if settings.tools:
            raise ValueError(
                "Codex provider profiles do not support default tools; "
                "configure tools on a Claude Code profile or on the agent"
            )
        if settings.mcp_servers:
            raise ValueError(
                "Codex provider profiles do not support MCP server flags; "
                "configure MCP servers on a Claude Code profile or on the agent"
            )
        if settings.reasoning:
            raise ValueError(
                "Codex provider profiles do not support reasoning/effort; "
                "remove reasoning from the profile"
            )
        if settings.approval_mode not in (None, "default"):
            raise ValueError(
                "Codex provider profiles do not support approval_mode; "
                "remove approval_mode from the profile"
            )
        return
    if settings.subscription == "claude_code":
        if settings.reasoning:
            raise ValueError(
                "Claude Code provider profiles do not support reasoning/effort; "
                "remove reasoning from the profile or use a Codex profile"
            )
        if settings.sandbox_mode not in (None, "default"):
            raise ValueError(
                "Claude Code provider profiles do not support sandbox_mode; "
                "remove sandbox_mode from the profile or use a Codex profile"
            )


def unresolved_provider_secret_refs(settings: ResolvedProviderSettings) -> list[str]:
    return sorted({
        secret_name
        for secret_name in settings.secret_refs.values()
        if not _secret_value(secret_name)
    })


def resolved_provider_env(settings: ResolvedProviderSettings) -> dict[str, str]:
    env = dict(settings.env)
    for env_name, secret_name in settings.secret_refs.items():
        secret = _secret_value(secret_name)
        if secret is None:
            profile = f" '{settings.profile_name}'" if settings.profile_name else ""
            raise ValueError(
                f"Provider profile{profile} requires secret '{secret_name}' for "
                f"environment variable '{env_name}'. Set GOFER_SECRET_{secret_name} "
                f"or {secret_name} before running."
            )
        env[env_name] = secret
    return env


def _secret_value(name: str) -> str | None:
    for env_name in (f"GOFER_SECRET_{name}", name):
        if env_name in os.environ:
            return os.environ[env_name]
    return None
