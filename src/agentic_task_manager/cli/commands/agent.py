from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from agentic_task_manager.core.agent import Agent
from agentic_task_manager.subscriptions.claude_code import ClaudeCodeSubscription
from agentic_task_manager.subscriptions.codex import CodexSubscription
from agentic_task_manager.utils.paths import get_data_dir
from agentic_task_manager.utils.registry import find_agent, find_workflow, list_all_agents

app = typer.Typer(help="Manage and run agents")
console = Console()

_SUBSCRIPTIONS = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}


@app.command("run")
def run(
    agent_id: str = typer.Argument(..., help="Agent ID (e.g. TradeAgent)"),
    data_dir: Optional[Path] = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Run a named agent."""
    try:
        _, config = find_agent(agent_id, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    sub = _SUBSCRIPTIONS.get(config.subscription)
    if sub is None:
        console.print(f"[red]Unknown subscription '{config.subscription}'[/red]")
        raise typer.Exit(1)

    result = asyncio.run(Agent(config, sub).run())
    if result.success:
        console.print(result.output)
    else:
        console.print(f"[red]Agent failed (exit {result.exit_code}):[/red]\n{result.output}")
        raise typer.Exit(1)


@app.command("list")
def list_agents(
    workflow: Optional[str] = typer.Option(None, "--workflow", help="Filter by workflow ID"),
    data_dir: Optional[Path] = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """List agents. Without --workflow, lists all agents in the data directory."""
    base = data_dir or get_data_dir()

    if workflow:
        try:
            wf = find_workflow(workflow, base)
            pairs = [(wf, cfg) for cfg in wf.agents.values()]
        except KeyError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(1)
    else:
        pairs = list_all_agents(base)

    if not pairs:
        console.print(f"No agents found in [bold]{base}[/bold].")
        return

    table = Table("Agent ID", "Workflow", "Subscription", "Working Dir", "Prompt")
    for wf, cfg in pairs:
        table.add_row(
            cfg.agent_id,
            wf.config.id,
            cfg.subscription,
            str(cfg.working_dir),
            str(cfg.prompt_path),
        )
    console.print(table)
