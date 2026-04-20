from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.syntax import Syntax

from agentic_task_manager.prompts.manager import PromptManager
from agentic_task_manager.utils.paths import get_data_dir

app = typer.Typer(help="Manage prompt library", no_args_is_help=True)
console = Console()

_DEFAULT_PROMPTS_DIR = get_data_dir() / "prompts"


@app.command("list")
def list_prompts(
    dir: Path = typer.Option(_DEFAULT_PROMPTS_DIR, "--dir", help="Prompts directory"),
) -> None:
    """List available prompts."""
    mgr = PromptManager(search_dirs=[dir])
    paths = mgr.list_prompts()
    if not paths:
        console.print("No prompts found.")
        return
    for p in paths:
        console.print(f"  {p.relative_to(dir)}")


@app.command("show")
def show(
    name: str = typer.Argument(...),
    dir: Path = typer.Option(_DEFAULT_PROMPTS_DIR, "--dir"),
) -> None:
    """Display a prompt file."""
    mgr = PromptManager(search_dirs=[dir])
    try:
        text = mgr.load(Path(name), {})
        console.print(Syntax(text, "markdown", theme="monokai"))
    except FileNotFoundError:
        console.print(f"[red]Prompt '{name}' not found[/red]")
        raise typer.Exit(1)


@app.command("new")
def new(
    name: str = typer.Option(..., "--name"),
    dir: Path = typer.Option(_DEFAULT_PROMPTS_DIR, "--dir"),
) -> None:
    """Create a new prompt file."""
    dir.mkdir(parents=True, exist_ok=True)
    path = dir / f"{name}.md"
    if path.exists():
        console.print(f"[yellow]Prompt '{name}' already exists at {path}[/yellow]")
        raise typer.Exit(1)
    path.write_text(f"# {name}\n\nDescribe your task here.\n")
    console.print(f"Created [bold]{path}[/bold]")
