from __future__ import annotations

from pathlib import Path

import typer

from gofer.cli.commands import agent, schedule, watch, workflow

app = typer.Typer(name="gof", help="Gofer Flow", no_args_is_help=True)
app.add_typer(workflow.app, name="workflow")
app.add_typer(agent.app, name="agent")
app.add_typer(schedule.app, name="schedule")
app.add_typer(watch.app, name="watch")

ui_app = typer.Typer(help="Run the workflow studio API", no_args_is_help=True)
app.add_typer(ui_app, name="ui")


@ui_app.command("serve")
def serve_ui(
    host: str = typer.Option("127.0.0.1", "--host", help="API bind host"),
    port: int = typer.Option(
        8765,
        "--port",
        help="API bind port. Use 0 to let the OS choose a free port.",
    ),
    data_dir: Path | None = typer.Option(
        None,
        "--data-dir",
        help="Gofer Flow app data directory for workflows, logs, schedules, and chat state.",
    ),
) -> None:
    """Serve JSON endpoints used by the React workflow studio."""
    from gofer.ui.server import serve

    serve(host=host, port=port, data_dir=data_dir)


if __name__ == "__main__":
    app()
