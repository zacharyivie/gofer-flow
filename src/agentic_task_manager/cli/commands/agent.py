from __future__ import annotations

import asyncio
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from agentic_task_manager.core.agent import Agent
from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.subscriptions.claude_code import ClaudeCodeSubscription
from agentic_task_manager.subscriptions.codex import CodexSubscription

app = typer.Typer(help="Manage and run agents")
console = Console()

_SUBSCRIPTIONS = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}


@app.command("run")
def run(
    agent_id: str = typer.Option(..., "--agent-id"),
    workflow_file: Path = typer.Option(..., "--workflow"),
) -> None:
    """Run a single agent from a workflow."""
    wf = AgenticWorkflow.from_file(workflow_file)
    config = wf.agents.get(agent_id)
    if config is None:
        console.print(f"[red]Agent '{agent_id}' not found in workflow[/red]")
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
def list_agents(workflow_file: Path = typer.Option(..., "--workflow")) -> None:
    """List agents defined in a workflow."""
    wf = AgenticWorkflow.from_file(workflow_file)
    table = Table("ID", "Subscription", "Working Dir", "Prompt")
    for aid, cfg in wf.agents.items():
        table.add_row(aid, cfg.subscription, str(cfg.working_dir), str(cfg.prompt_path))
    console.print(table)
