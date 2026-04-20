from __future__ import annotations

import asyncio
import re
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from agentic_task_manager.core.executor import WorkflowExecutor
from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.subscriptions.claude_code import ClaudeCodeSubscription
from agentic_task_manager.subscriptions.codex import CodexSubscription
from agentic_task_manager.utils.paths import get_data_dir
from agentic_task_manager.utils.registry import find_workflow

app = typer.Typer(help="Manage and run workflows", no_args_is_help=True)
console = Console()

_SUBSCRIPTIONS = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}


def _resolve_workflow(name: str, data_dir: Path | None) -> AgenticWorkflow:
    """Resolve a workflow name/ID or file path."""
    path = Path(name)
    if path.suffix == ".toml" and path.exists():
        return AgenticWorkflow.from_file(path)
    return find_workflow(name, data_dir)


@app.command("run")
def run(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Simulate without executing"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show each node's output"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Execute a workflow by name or file path."""
    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.validate()
    result = asyncio.run(WorkflowExecutor(wf, _SUBSCRIPTIONS, dry_run=dry_run).run())

    if verbose:
        for node_id, node_out in result.node_outputs.items():
            status = "[green]✓[/green]" if node_out.success else "[red]✗[/red]"
            console.print(f"\n{status} [bold]{node_id}[/bold]")
            if node_out.output:
                console.print(node_out.output)

    if result.success:
        console.print(f"[green]✓[/green] Workflow '{result.workflow_id}' completed successfully "
                      f"in {result.duration_seconds:.2f}s")
    else:
        console.print(f"[red]✗[/red] Workflow '{result.workflow_id}' failed")
        raise typer.Exit(1)


@app.command("validate")
def validate(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Validate a workflow by name or file path."""
    try:
        wf = _resolve_workflow(workflow, data_dir)
        wf.validate()
        console.print(f"[green]✓[/green] '{wf.config.id}' is valid")
    except Exception as exc:
        console.print(f"[red]✗[/red] Validation failed: {exc}")
        raise typer.Exit(1)


@app.command("show")
def show(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Display the DAG structure of a workflow."""
    from agentic_task_manager.cli.dag_renderer import render_workflow

    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    render_workflow(wf, console)


@app.command("list")
def list_workflows(data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True)) -> None:
    """List all workflows in the data directory."""
    base = data_dir or get_data_dir()
    if not base.exists():
        console.print(f"No workflows found in [bold]{base}[/bold].")
        return

    toml_files = sorted(base.glob("*.toml"))
    if not toml_files:
        console.print(f"No workflows found in [bold]{base}[/bold].")
        return

    rows = []
    for path in toml_files:
        try:
            wf = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        if wf.agents and not list(wf.graph._graph.nodes()):
            continue
        schedule = wf.config.schedule.cron_expression if wf.config.schedule else "—"
        rows.append((
            wf.config.id,
            wf.config.name,
            schedule,
            str(len(wf.agents)),
            str(len(list(wf.graph._graph.nodes()))),
        ))

    if not rows:
        console.print(f"No workflows found in [bold]{base}[/bold].")
        return

    table = Table("ID", "Name", "Schedule", "Agents", "Nodes")
    for row in rows:
        table.add_row(*row)
    console.print(table)


@app.command("edit")
def edit(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Open a workflow TOML file in $EDITOR."""
    import os
    import subprocess

    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    base = data_dir or get_data_dir()
    path = base / f"{wf.config.id}.toml"
    editor = os.environ.get("EDITOR", "vi")
    subprocess.run([editor, str(path)])


@app.command("rm")
def rm(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Delete a workflow TOML file."""
    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    base = data_dir or get_data_dir()
    path = base / f"{wf.config.id}.toml"

    if not yes:
        typer.confirm(f"Delete workflow '{wf.config.id}' ({path})?", abort=True)

    path.unlink()
    console.print(f"[green]Deleted[/green] {path}")


@app.command("build")
def build(
    output: Path | None = typer.Option(None, "--output", help="Output path for workflow TOML"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Interactively build a workflow via a guided wizard."""
    from agentic_task_manager.cli.commands.builder import WorkflowBuilder

    wf = WorkflowBuilder().run()
    if wf is None:
        raise typer.Abort()
    dest_dir = data_dir or get_data_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = output or dest_dir / f"{wf.config.id}.toml"
    wf.to_file(dest)
    console.print(f"[green]Saved[/green] {dest}")


@app.command("create")
def create(
    name: str = typer.Option(..., "--name", help="Workflow name"),
    output: Path | None = typer.Option(
        None, "--output", help="Output directory (default: data dir)"
    ),
) -> None:
    """Create a new workflow scaffold in the data directory."""
    wf_id = re.sub(r"[^a-z0-9-]", "-", name.lower())
    dest = output or get_data_dir()
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / f"{wf_id}.toml"
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
