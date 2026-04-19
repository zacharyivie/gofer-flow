from __future__ import annotations

import time
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from agentic_task_manager.core.scheduler import WorkflowScheduler
from agentic_task_manager.core.workflow import AgenticWorkflow

app = typer.Typer(help="Manage workflow schedules")
console = Console()

_DEFAULT_DB = Path.home() / ".local" / "share" / "atm" / "schedules.db"


def _get_scheduler(db: Path = _DEFAULT_DB) -> WorkflowScheduler:
    db.parent.mkdir(parents=True, exist_ok=True)
    return WorkflowScheduler(db_path=db)


@app.command("add")
def add(
    workflow_file: Path = typer.Argument(..., help="Workflow TOML file"),
    db: Path = typer.Option(_DEFAULT_DB, "--db"),
) -> None:
    """Add a workflow to the schedule."""
    wf = AgenticWorkflow.from_file(workflow_file)
    scheduler = _get_scheduler(db)
    scheduler.add_workflow(wf, workflow_file)
    console.print(f"[green]Scheduled[/green] '{wf.config.id}'")


@app.command("remove")
def remove(
    workflow_id: str = typer.Argument(...),
    db: Path = typer.Option(_DEFAULT_DB, "--db"),
) -> None:
    """Remove a workflow from the schedule."""
    scheduler = _get_scheduler(db)
    scheduler.remove_workflow(workflow_id)
    console.print(f"Removed '{workflow_id}'")


@app.command("list")
def list_schedules(db: Path = typer.Option(_DEFAULT_DB, "--db")) -> None:
    """List all scheduled workflows."""
    scheduler = _get_scheduler(db)
    jobs = scheduler.list_workflows()
    if not jobs:
        console.print("No scheduled workflows.")
        return
    table = Table("ID", "Name", "Next Run")
    for j in jobs:
        table.add_row(j["id"], j["name"], j["next_run"])
    console.print(table)


@app.command("start")
def start(
    daemon: bool = typer.Option(False, "--daemon", help="Run in background"),
    db: Path = typer.Option(_DEFAULT_DB, "--db"),
) -> None:
    """Start the scheduler."""
    scheduler = _get_scheduler(db)
    scheduler.start()
    console.print("[green]Scheduler started[/green]. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        scheduler.shutdown()
        console.print("Scheduler stopped.")
