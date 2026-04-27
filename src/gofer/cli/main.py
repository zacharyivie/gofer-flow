from __future__ import annotations

import typer

from gofer.cli.commands import agent, prompts, schedule, workflow

app = typer.Typer(name="gof", help="Gofer Flow", no_args_is_help=True)
app.add_typer(workflow.app, name="workflow")
app.add_typer(agent.app, name="agent")
app.add_typer(schedule.app, name="schedule")
app.add_typer(prompts.app, name="prompt")


if __name__ == "__main__":
    app()
