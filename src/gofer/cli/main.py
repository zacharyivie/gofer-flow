from __future__ import annotations

from legacy.gofer.cli.commands import agent, schedule
import typer

from legacy.gofer.cli.commands import workflow

app = typer.Typer(name="gof", help="Gofer Flow", no_args_is_help=True)
app.add_typer(workflow.app, name="workflow")
app.add_typer(agent.app, name="agent")
app.add_typer(schedule.app, name="schedule")


if __name__ == "__main__":
    app()
