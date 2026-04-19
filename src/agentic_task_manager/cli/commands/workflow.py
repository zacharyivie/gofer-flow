from __future__ import annotations

import asyncio
from pathlib import Path

import typer
from rich.console import Console

from agentic_task_manager.core.executor import WorkflowExecutor
from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.subscriptions.claude_code import ClaudeCodeSubscription
from agentic_task_manager.subscriptions.codex import CodexSubscription

app = typer.Typer(help="Manage and run workflows")
console = Console()

_SUBSCRIPTIONS = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}


@app.command("run")
def run(
    file: Path = typer.Argument(..., help="Workflow TOML file"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Simulate without executing"),
) -> None:
    """Execute a workflow."""
    wf = AgenticWorkflow.from_file(file)
    wf.validate()

    result = asyncio.run(WorkflowExecutor(wf, _SUBSCRIPTIONS, dry_run=dry_run).run())

    if result.success:
        console.print(f"[green]✓[/green] Workflow '{result.workflow_id}' completed successfully "
                      f"in {result.duration_seconds:.2f}s")
    else:
        console.print(f"[red]✗[/red] Workflow '{result.workflow_id}' failed")
        raise typer.Exit(1)


@app.command("validate")
def validate(file: Path = typer.Argument(..., help="Workflow TOML file")) -> None:
    """Validate a workflow file."""
    try:
        wf = AgenticWorkflow.from_file(file)
        wf.validate()
        console.print(f"[green]✓[/green] {file} is valid")
    except Exception as exc:
        console.print(f"[red]✗[/red] Validation failed: {exc}")
        raise typer.Exit(1)


@app.command("create")
def create(
    name: str = typer.Option(..., "--name", help="Workflow name"),
    output: Path = typer.Option(Path("."), "--output", help="Output directory"),
) -> None:
    """Create a new workflow scaffold."""
    import re
    wf_id = re.sub(r"[^a-z0-9-]", "-", name.lower())
    path = output / f"{wf_id}.toml"
    content = f"""[workflow]
id = "{wf_id}"
name = "{name}"

# [workflow.schedule]
# cron_expression = "0 9 * * 1-5"
# timezone = "UTC"

# [[nodes]]
# id = "my-step"
# type = "bash_command"
# command = "echo hello"
"""
    path.write_text(content)
    console.print(f"Created [bold]{path}[/bold]")
