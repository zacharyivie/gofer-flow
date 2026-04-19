from __future__ import annotations

import asyncio
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from agentic_task_manager.core.agent import Agent, AgentConfig
from agentic_task_manager.core.workflow import AgenticWorkflow, WorkflowConfig
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
_SUBSCRIPTION_CHOICES = list(_SUBSCRIPTIONS)


@app.command("create")
def create(
    name: str | None = typer.Option(None, "--name", help="Human-readable agent name"),
    subscription: str | None = typer.Option(
        None, "--subscription", help=f"Subscription ({', '.join(_SUBSCRIPTION_CHOICES)})"
    ),
    working_dir: Path | None = typer.Option(None, "--working-dir", help="Agent working directory"),
    prompt: str | None = typer.Option(
        None, "--prompt", help="Prompt text or path to a prompt file"
    ),
    tools: str | None = typer.Option(None, "--tools", help="Comma-separated tool names"),
    mcp_servers: str | None = typer.Option(
        None, "--mcp-servers", help="Comma-separated MCP server names"
    ),
    env: list[str] | None = typer.Option(
        None, "--env", help="Environment variables as KEY=VALUE (repeatable)"
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Create a new agent and save it to the data directory."""
    base = data_dir or get_data_dir()
    base.mkdir(parents=True, exist_ok=True)

    # ── Collect required fields, prompting for any that are missing ──────────

    if not name:
        name = typer.prompt("Agent name")
    name = name.strip()

    agent_id = _unique_agent_id(name, base)
    dest_path = base / f"{agent_id}.toml"

    if not subscription:
        subscription = typer.prompt(
            f"Subscription ({', '.join(_SUBSCRIPTION_CHOICES)})",
            default="claude_code",
        )
    subscription = subscription.strip()
    if subscription not in _SUBSCRIPTION_CHOICES:
        console.print(f"[red]Invalid subscription '{subscription}'. "
                      f"Choose from: {', '.join(_SUBSCRIPTION_CHOICES)}[/red]")
        raise typer.Exit(1)

    if not working_dir:
        raw = typer.prompt("Working directory", default=str(Path.cwd()))
        working_dir = Path(raw).expanduser().resolve()

    if not prompt:
        prompt = typer.prompt(
            "Prompt (text or path to a .md file)",
            prompt_suffix="\n> ",
        )
    prompt = prompt.strip()

    prompt_path = _resolve_prompt(prompt, base, agent_id)

    # ── Optional fields ──────────────────────────────────────────────────────

    tools_list = [t.strip() for t in tools.split(",")] if tools else []
    mcp_list = [s.strip() for s in mcp_servers.split(",")] if mcp_servers else []
    env_dict: dict[str, str] = {}
    for pair in (env or []):
        if "=" not in pair:
            console.print(f"[red]Invalid --env value '{pair}': expected KEY=VALUE[/red]")
            raise typer.Exit(1)
        k, _, v = pair.partition("=")
        env_dict[k] = v

    # ── Write TOML ───────────────────────────────────────────────────────────

    config = AgentConfig(
        agent_id=agent_id,
        subscription=subscription,  # type: ignore[arg-type]
        working_dir=working_dir,
        prompt_path=prompt_path,
        tools=tools_list,
        mcp_servers=mcp_list,
        env=env_dict,
    )
    wf = AgenticWorkflow(WorkflowConfig(id=agent_id, name=name))
    wf.register_agent(config)
    wf.to_file(dest_path)

    console.print(f"[green]Created agent[/green] [bold]{agent_id}[/bold] → {dest_path}")


def _unique_agent_id(name: str, data_dir: Path) -> str:
    """Slugify name and append a numeric suffix if the ID is already taken."""
    import re
    base_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    candidate = base_id
    counter = 2
    while (data_dir / f"{candidate}.toml").exists():
        candidate = f"{base_id}-{counter}"
        counter += 1
    return candidate


def _resolve_prompt(prompt: str, data_dir: Path, agent_id: str) -> Path:
    """Return a path to the prompt file, writing inline text if needed."""
    candidate = Path(prompt).expanduser()
    if candidate.exists() and candidate.is_file():
        return candidate.resolve()

    # Treat prompt as inline text — save to data_dir/prompts/<agent_id>.md
    prompts_dir = data_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = prompts_dir / f"{agent_id}.md"
    prompt_file.write_text(prompt)
    return prompt_file


@app.command("run")
def run(
    agent_id: str = typer.Argument(..., help="Agent ID (e.g. TradeAgent)"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
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
    workflow: str | None = typer.Option(None, "--workflow", help="Filter by workflow ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
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
