from __future__ import annotations

import typer

from agentic_task_manager.cli.commands import agent, prompts, schedule, workflow

app = typer.Typer(name="atm", help="Agentic Task Manager", no_args_is_help=True)
app.add_typer(workflow.app, name="workflow")
app.add_typer(workflow.app, name="workflows")
app.add_typer(agent.app, name="agent")
app.add_typer(agent.app, name="agents")
app.add_typer(schedule.app, name="schedule")
app.add_typer(prompts.app, name="prompt")
app.add_typer(prompts.app, name="prompts")


if __name__ == "__main__":
    app()
