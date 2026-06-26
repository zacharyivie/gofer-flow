from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.agent import AgentConfig
from gofer.core.graph import GraphNode
from gofer.core.operations import AgentOperation, OperationType
from gofer.core.planner import build_execution_plan
from gofer.core.provider_profiles import (
    ProviderProfile,
    ResolvedProviderSettings,
    load_provider_profiles,
    resolved_provider_env,
    save_provider_profiles,
    validate_provider_settings,
)
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from gofer.subscriptions import claude_code, codex
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription
from gofer.ui.api import (
    delete_provider_profile_payload,
    provider_profiles_payload,
    upsert_provider_profile_payload,
)


def test_provider_profile_serialization_round_trips(tmp_path: Path) -> None:
    save_provider_profiles(
        {
            "fast": ProviderProfile(
                name="fast",
                subscription="codex",
                model="gpt-5-mini",
                timeout=45,
                reasoning="low",
                approval_mode="never",
                sandbox_mode="read-only",
                extra_args=["--flag"],
                env={"A": "B"},
            )
        },
        tmp_path,
    )

    loaded = load_provider_profiles(tmp_path)

    assert loaded["fast"].model == "gpt-5-mini"
    assert loaded["fast"].timeout == 45
    assert loaded["fast"].extra_args == ["--flag"]


def test_provider_profile_secret_refs_resolve_to_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GOFER_SECRET_CODEX_TOKEN", "secret-token")
    settings = ResolvedProviderSettings(
        profile_name="secure",
        subscription="codex",
        env={"PLAIN": "1"},
        secret_refs={"CODEX_API_KEY": "CODEX_TOKEN"},
    )

    assert resolved_provider_env(settings) == {
        "PLAIN": "1",
        "CODEX_API_KEY": "secret-token",
    }


def test_provider_profile_missing_secret_is_reported_in_plan_and_validation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GOFER_SECRET_CODEX_TOKEN", raising=False)
    monkeypatch.delenv("CODEX_TOKEN", raising=False)
    save_provider_profiles(
        {
            "secure": ProviderProfile(
                name="secure",
                subscription="codex",
                secret_refs={"CODEX_API_KEY": "CODEX_TOKEN"},
            )
        },
        tmp_path,
    )
    workflow = AgenticWorkflow(WorkflowConfig(id="profiles", name="Profiles"))
    workflow.register_agent(
        AgentConfig(
            agent_id="reviewer",
            subscription="codex",
            working_dir=tmp_path,
            profile="secure",
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="review",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="reviewer",
                working_dir=tmp_path,
            ),
        )
    )

    plan = build_execution_plan(workflow, workflow_path=tmp_path / "workflow.toml")

    assert plan["requiredSecrets"] == ["CODEX_TOKEN"]
    with pytest.raises(ValueError, match="missing secret reference"):
        workflow.validate(tmp_path / "workflow.toml")


def test_codex_profile_command_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(codex.shutil, "which", lambda _binary: None)
    settings = ResolvedProviderSettings(
        profile_name="quality",
        subscription="codex",
        model="gpt-5",
        sandbox_mode="read-only",
        extra_args=["--config", "x=y"],
    )

    cmd = CodexSubscription()._build_command(
        "prompt",
        [],
        [],
        [],
        settings,
    )

    assert ["--model", "gpt-5"] == cmd[cmd.index("--model") : cmd.index("--model") + 2]
    assert ["--sandbox", "read-only"] == cmd[
        cmd.index("--sandbox") : cmd.index("--sandbox") + 2
    ]
    assert "--config" in cmd


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("reasoning", "high", "do not support reasoning/effort"),
        ("approval_mode", "on-request", "do not support approval_mode"),
    ],
)
def test_codex_profile_rejects_unsupported_settings_before_launch(
    field: str,
    value: str,
    message: str,
) -> None:
    settings = ResolvedProviderSettings(
        profile_name="quality",
        subscription="codex",
        **{field: value},
    )

    with pytest.raises(ValueError, match=message):
        validate_provider_settings(settings)
    with pytest.raises(ValueError, match=message):
        CodexSubscription()._build_command("prompt", [], [], [], settings)


def test_claude_profile_command_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    settings = ResolvedProviderSettings(
        profile_name="review",
        subscription="claude_code",
        model="opus",
        approval_mode="manual",
        tools=["Read"],
        mcp_servers=["docs"],
    )

    cmd = ClaudeCodeSubscription()._build_command(
        "prompt",
        ["Bash"],
        [],
        [],
        settings,
    )

    assert ["--model", "opus"] == cmd[cmd.index("--model") : cmd.index("--model") + 2]
    assert ["--permission-mode", "manual"] == cmd[
        cmd.index("--permission-mode") : cmd.index("--permission-mode") + 2
    ]
    assert cmd.count("--allowedTools") == 2
    assert "--mcp-server" in cmd


def test_workflow_validation_rejects_missing_profile(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="profiles", name="Profiles"))
    workflow.register_agent(
        AgentConfig(
            agent_id="reviewer",
            subscription="codex",
            working_dir=tmp_path,
            profile="missing",
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="review",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="reviewer",
                working_dir=tmp_path,
            ),
        )
    )

    with pytest.raises(ValueError, match="Provider profile 'missing' was not found"):
        workflow.validate(tmp_path / "workflow.toml")


def test_workflow_validation_rejects_unsupported_profile_settings(
    tmp_path: Path,
) -> None:
    save_provider_profiles(
        {
            "unsupported": ProviderProfile(
                name="unsupported",
                subscription="codex",
                tools=["Read"],
            )
        },
        tmp_path,
    )
    workflow = AgenticWorkflow(WorkflowConfig(id="profiles", name="Profiles"))
    workflow.register_agent(
        AgentConfig(
            agent_id="reviewer",
            subscription="codex",
            working_dir=tmp_path,
            profile="unsupported",
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="review",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="reviewer",
                working_dir=tmp_path,
            ),
        )
    )

    plan = build_execution_plan(workflow, workflow_path=tmp_path / "workflow.toml")

    assert any("do not support default tools" in warning for warning in plan["warnings"])
    with pytest.raises(ValueError, match="do not support default tools"):
        workflow.validate(tmp_path / "workflow.toml")


def test_ui_provider_profile_api_round_trip(tmp_path: Path) -> None:
    created = upsert_provider_profile_payload(
        {"name": "fast", "subscription": "codex", "model": "gpt-5-mini"},
        tmp_path,
    )
    listed = provider_profiles_payload(tmp_path)
    deleted = delete_provider_profile_payload("fast", tmp_path)

    assert created["profile"]["name"] == "fast"
    assert listed["profiles"][0]["model"] == "gpt-5-mini"
    assert deleted == {"profile": "fast", "deleted": True}
