from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from gofer.core.provider_profiles import (
    ProviderProfile,
    load_provider_profiles,
    save_provider_profiles,
)
from gofer.utils.paths import get_data_dir

app = typer.Typer(help="Manage provider settings", no_args_is_help=True)
profile_app = typer.Typer(help="Manage named provider profiles", no_args_is_help=True)
app.add_typer(profile_app, name="profile")
console = Console()

_SUBSCRIPTIONS = ["codex", "claude_code"]


@profile_app.command("list")
def list_profiles(data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True)) -> None:
    profiles = load_provider_profiles(data_dir or get_data_dir())
    if not profiles:
        console.print("No provider profiles found.")
        return
    table = Table("Name", "Subscription", "Model", "Timeout", "Approval", "Sandbox")
    for profile in profiles.values():
        table.add_row(
            profile.name,
            profile.subscription,
            profile.model or "",
            str(profile.timeout or ""),
            profile.approval_mode or "",
            profile.sandbox_mode or "",
        )
    console.print(table)


@profile_app.command("create")
def create_profile(
    name: str = typer.Argument(..., help="Profile name"),
    subscription: str = typer.Option("codex", "--subscription", help="codex or claude_code"),
    model: str | None = typer.Option(None, "--model", help="Provider model"),
    timeout: float | None = typer.Option(None, "--timeout", help="Default timeout in seconds"),
    reasoning: str | None = typer.Option(None, "--reasoning", help="Reasoning/effort setting"),
    approval_mode: str | None = typer.Option(
        None,
        "--approval-mode",
        help="Provider approval mode",
    ),
    sandbox_mode: str | None = typer.Option(None, "--sandbox-mode", help="Provider sandbox mode"),
    extra_arg: list[str] | None = typer.Option(
        None,
        "--extra-arg",
        help="Additional provider CLI argument (repeatable)",
    ),
    tool: list[str] | None = typer.Option(None, "--tool", help="Default tool (repeatable)"),
    mcp_server: list[str] | None = typer.Option(
        None,
        "--mcp-server",
        help="Default MCP server (repeatable)",
    ),
    env: list[str] | None = typer.Option(None, "--env", help="KEY=VALUE env var (repeatable)"),
    secret_ref: list[str] | None = typer.Option(
        None,
        "--secret-ref",
        help="KEY=SECRET_NAME secret env reference (repeatable)",
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    if subscription not in _SUBSCRIPTIONS:
        console.print(f"[red]Invalid subscription '{subscription}'[/red]")
        raise typer.Exit(1)
    profiles = load_provider_profiles(data_dir or get_data_dir())
    if name in profiles:
        console.print(f"[red]Provider profile '{name}' already exists[/red]")
        raise typer.Exit(1)
    profile = _profile_from_options(
        name=name,
        subscription=subscription,
        model=model,
        timeout=timeout,
        reasoning=reasoning,
        approval_mode=approval_mode,
        sandbox_mode=sandbox_mode,
        extra_arg=extra_arg,
        tool=tool,
        mcp_server=mcp_server,
        env=env,
        secret_ref=secret_ref,
    )
    profiles[name] = profile
    save_provider_profiles(profiles, data_dir or get_data_dir())
    console.print(f"[green]Created provider profile[/green] [bold]{name}[/bold]")


@profile_app.command("edit")
def edit_profile(
    name: str = typer.Argument(..., help="Profile name"),
    model: str | None = typer.Option(None, "--model", help="Provider model"),
    timeout: float | None = typer.Option(None, "--timeout", help="Default timeout in seconds"),
    reasoning: str | None = typer.Option(None, "--reasoning", help="Reasoning/effort setting"),
    approval_mode: str | None = typer.Option(
        None,
        "--approval-mode",
        help="Provider approval mode",
    ),
    sandbox_mode: str | None = typer.Option(None, "--sandbox-mode", help="Provider sandbox mode"),
    extra_arg: list[str] | None = typer.Option(None, "--extra-arg", help="Replace extra args"),
    tool: list[str] | None = typer.Option(None, "--tool", help="Replace default tools"),
    mcp_server: list[str] | None = typer.Option(None, "--mcp-server", help="Replace MCP servers"),
    env: list[str] | None = typer.Option(None, "--env", help="Replace env vars"),
    secret_ref: list[str] | None = typer.Option(
        None,
        "--secret-ref",
        help="Replace secret env references",
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    profiles = load_provider_profiles(data_dir or get_data_dir())
    profile = profiles.get(name)
    if profile is None:
        console.print(f"[red]Provider profile '{name}' not found[/red]")
        raise typer.Exit(1)
    updates: dict[str, object] = {
        key: value
        for key, value in {
            "model": model,
            "timeout": timeout,
            "reasoning": reasoning,
            "approval_mode": approval_mode,
            "sandbox_mode": sandbox_mode,
        }.items()
        if value is not None
    }
    if extra_arg is not None:
        updates["extra_args"] = list(extra_arg)
    if tool is not None:
        updates["tools"] = list(tool)
    if mcp_server is not None:
        updates["mcp_servers"] = list(mcp_server)
    if env is not None:
        updates["env"] = _parse_key_value_options(env, "--env", "KEY=VALUE")
    if secret_ref is not None:
        updates["secret_refs"] = _parse_key_value_options(
            secret_ref,
            "--secret-ref",
            "KEY=SECRET_NAME",
        )
    profiles[name] = profile.model_copy(update=updates)
    save_provider_profiles(profiles, data_dir or get_data_dir())
    console.print(f"[green]Updated provider profile[/green] [bold]{name}[/bold]")


@profile_app.command("rm")
def rm_profile(
    name: str = typer.Argument(..., help="Profile name"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    profiles = load_provider_profiles(data_dir or get_data_dir())
    if name not in profiles:
        console.print(f"[red]Provider profile '{name}' not found[/red]")
        raise typer.Exit(1)
    if not yes:
        typer.confirm(f"Remove provider profile '{name}'?", abort=True)
    del profiles[name]
    save_provider_profiles(profiles, data_dir or get_data_dir())
    console.print(f"[green]Removed provider profile[/green] [bold]{name}[/bold]")


def _profile_from_options(
    *,
    name: str,
    subscription: str,
    model: str | None,
    timeout: float | None,
    reasoning: str | None,
    approval_mode: str | None,
    sandbox_mode: str | None,
    extra_arg: list[str] | None,
    tool: list[str] | None,
    mcp_server: list[str] | None,
    env: list[str] | None,
    secret_ref: list[str] | None,
) -> ProviderProfile:
    try:
        return ProviderProfile(
            name=name,
            subscription=subscription,  # type: ignore[arg-type]
            model=model,
            timeout=timeout,
            reasoning=reasoning,
            approval_mode=approval_mode,  # type: ignore[arg-type]
            sandbox_mode=sandbox_mode,  # type: ignore[arg-type]
            extra_args=list(extra_arg or []),
            tools=list(tool or []),
            mcp_servers=list(mcp_server or []),
            env=_parse_key_value_options(env or [], "--env", "KEY=VALUE"),
            secret_refs=_parse_key_value_options(
                secret_ref or [],
                "--secret-ref",
                "KEY=SECRET_NAME",
            ),
        )
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc


def _parse_key_value_options(
    values: list[str],
    option_name: str,
    expected: str,
) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for pair in values:
        if "=" not in pair:
            console.print(f"[red]Invalid {option_name} value '{pair}': expected {expected}[/red]")
            raise typer.Exit(1)
        key, _, value = pair.partition("=")
        parsed[key] = value
    return parsed
