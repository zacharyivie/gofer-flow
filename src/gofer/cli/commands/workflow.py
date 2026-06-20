from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    CountFanSource,
    DeleteFileOperation,
    DirectoryFanSource,
    FileOperation,
    FolderOperation,
    LocalSearchOperation,
    LocalVectorizeOperation,
    MoveFileOperation,
    OpenResourceOperation,
    Operation,
    OperationType,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    TabularFanSource,
    TriggerEventsFanSource,
    WriteFileOperation,
)
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WatchConfig, WorkflowConfig
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription
from gofer.ui.api import (
    WorkflowAlreadyExistsError,
    WorkflowCreateError,
    WorkflowLogError,
    import_workflow_payload,
    latest_workflow_log_payload,
    list_workflow_run_logs_payload,
    duplicate_workflow_payload,
    rename_workflow_payload,
    workflow_run_log_payload,
)
from gofer.ui.chat import delete_workflow_chat_prompt
from gofer.utils.paths import get_data_dir
from gofer.utils.registry import find_workflow
from gofer.utils.run_state import request_workflow_stop, workflow_stop_path

app = typer.Typer(help="Manage and run workflows", no_args_is_help=True)
recipe_app = typer.Typer(help="Create common workflow patterns", no_args_is_help=True)
app.add_typer(recipe_app, name="recipe")
logs_app = typer.Typer(help="Inspect workflow run logs", no_args_is_help=True)
app.add_typer(logs_app, name="logs")
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


def _resolve_workflow_with_path(
    name: str, data_dir: Path | None
) -> tuple[AgenticWorkflow, Path]:
    """Resolve a workflow and the TOML path that should be updated."""
    path = Path(name)
    if path.suffix == ".toml":
        if not path.exists():
            raise KeyError(f"Workflow file '{path}' not found")
        return AgenticWorkflow.from_file(path), path

    base = data_dir or get_data_dir()
    candidate = base / f"{name}.toml"
    if candidate.exists():
        return AgenticWorkflow.from_file(candidate), candidate

    for candidate in sorted(base.glob("*.toml")) if base.exists() else []:
        try:
            wf = AgenticWorkflow.from_file(candidate)
        except Exception:
            continue
        if wf.config.id == name:
            return wf, candidate

    raise KeyError(f"Workflow '{name}' not found in {base}")


def _log_base_dir(data_dir: Path | None) -> Path:
    return (data_dir or get_data_dir()) / "logs"


def _workflow_log_context(workflow: str, data_dir: Path | None) -> tuple[str, Path]:
    wf, path = _resolve_workflow_with_path(workflow, data_dir)
    return wf.config.id, data_dir or path.parent


def _slugify(value: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9-]", "-", value.lower())) or "workflow"


def _parse_key_values(values: list[str] | None, option_name: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values or []:
        if "=" not in value:
            raise typer.BadParameter(f"{option_name} values must be KEY=VALUE")
        key, item = value.split("=", 1)
        key = key.strip()
        if not key:
            raise typer.BadParameter(f"{option_name} keys cannot be empty")
        parsed[key] = item
    return parsed


def _parse_json_object(value: str | None, option_name: str) -> dict[str, str]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{option_name} must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise typer.BadParameter(f"{option_name} must be a JSON object")
    return {str(k): str(v) for k, v in parsed.items()}


def _save_workflow(wf: AgenticWorkflow, path: Path) -> None:
    wf.validate()
    path.parent.mkdir(parents=True, exist_ok=True)
    wf.to_file(path)
    console.print(f"[green]Saved[/green] {path}")


def _fan_source_from_options(
    fan_source: str | None,
    fan_count: str,
    fan_path: Path | None,
    fan_glob: str,
    fan_include_content: bool,
    fan_max_concurrency: int,
    fan_fail_fast: bool,
):
    if fan_source is None:
        return None
    normalized = fan_source.replace("_", "-")
    if normalized == "count":
        count: int | str
        count = int(fan_count) if fan_count.isdigit() else fan_count
        return CountFanSource(
            type="count",
            count=count,
            max_concurrency=fan_max_concurrency,
            fail_fast=fan_fail_fast,
        )
    if normalized == "tabular":
        if fan_path is None:
            raise typer.BadParameter("--fan-path is required for tabular fan-out")
        return TabularFanSource(
            type="tabular",
            path=fan_path,
            max_concurrency=fan_max_concurrency,
            fail_fast=fan_fail_fast,
        )
    if normalized == "directory":
        if fan_path is None:
            raise typer.BadParameter("--fan-path is required for directory fan-out")
        return DirectoryFanSource(
            type="directory",
            path=fan_path,
            glob=fan_glob,
            include_content=fan_include_content,
            max_concurrency=fan_max_concurrency,
            fail_fast=fan_fail_fast,
        )
    if normalized in {"trigger-events", "trigger_events"}:
        return TriggerEventsFanSource(
            type="trigger_events",
            include_content=fan_include_content,
            max_concurrency=fan_max_concurrency,
            fail_fast=fan_fail_fast,
        )
    raise typer.BadParameter(
        "--fan-source must be one of count, tabular, directory, trigger-events"
    )


def _operation_from_options(
    node_type: str,
    *,
    command: str | None,
    script_path: Path | None,
    path: Path | None,
    source_path: Path | None,
    destination_path: Path | None,
    target: str | None,
    resource_type: str,
    content: str,
    template: str,
    template_path: Path | None,
    output_path: Path | None,
    variable_mapping: dict[str, str],
    working_dir: Path | None,
    agent_id: str | None,
    prompt_path: Path | None,
    skill_name: str | None,
    task: str,
    target_text: str,
    instructions: str,
    index_path: Path | None,
    dynamic_count: str,
    memory: str,
    input_mapping: dict[str, str],
    env: dict[str, str],
    args: list[str],
    create_dirs: bool,
    overwrite: bool | None,
    append: bool,
    use_trash: bool,
    recursive: bool,
    missing_ok: bool,
    encoding: str,
    errors: str,
    fan_source: Any,
) -> Operation:
    normalized = node_type.replace("-", "_")
    match normalized:
        case OperationType.BASH_COMMAND:
            if command is None:
                raise typer.BadParameter("--command is required for bash_command nodes")
            return BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command=command,
                working_dir=working_dir,
                env=env,
            )
        case OperationType.PYTHON_SCRIPT:
            if script_path is None:
                raise typer.BadParameter("--script-path is required for python_script nodes")
            return PythonScriptOperation(
                type=OperationType.PYTHON_SCRIPT,
                script_path=script_path,
                args=args,
                env=env,
            )
        case OperationType.SHELL_SCRIPT:
            if script_path is None:
                raise typer.BadParameter("--script-path is required for shell_script nodes")
            return ShellScriptOperation(
                type=OperationType.SHELL_SCRIPT,
                script_path=script_path,
                args=args,
                env=env,
            )
        case OperationType.READ_FILE:
            if path is None:
                raise typer.BadParameter("--path is required for read_file nodes")
            return ReadFileOperation(
                type=OperationType.READ_FILE,
                path=path,
                encoding=encoding,
                errors=errors,
            )
        case OperationType.WRITE_FILE:
            if path is None:
                raise typer.BadParameter("--path is required for write_file nodes")
            return WriteFileOperation(
                type=OperationType.WRITE_FILE,
                path=path,
                content=content,
                encoding=encoding,
                create_dirs=create_dirs,
                overwrite=True if overwrite is None else overwrite,
                append=append,
            )
        case OperationType.COPY_FILE:
            if source_path is None or destination_path is None:
                raise typer.BadParameter(
                    "--source-path and --destination-path are required for copy_file nodes"
                )
            return CopyFileOperation(
                type=OperationType.COPY_FILE,
                source_path=source_path,
                destination_path=destination_path,
                create_dirs=create_dirs,
                overwrite=False if overwrite is None else overwrite,
            )
        case OperationType.MOVE_FILE:
            if source_path is None or destination_path is None:
                raise typer.BadParameter(
                    "--source-path and --destination-path are required for move_file nodes"
                )
            return MoveFileOperation(
                type=OperationType.MOVE_FILE,
                source_path=source_path,
                destination_path=destination_path,
                create_dirs=create_dirs,
                overwrite=False if overwrite is None else overwrite,
            )
        case OperationType.DELETE_FILE:
            if path is None:
                raise typer.BadParameter("--path is required for delete_file nodes")
            return DeleteFileOperation(
                type=OperationType.DELETE_FILE,
                path=path,
                use_trash=use_trash,
                recursive=recursive,
                missing_ok=missing_ok,
            )
        case OperationType.FILE:
            if path is None:
                raise typer.BadParameter("--path is required for file nodes")
            return FileOperation(type=OperationType.FILE, path=path)
        case OperationType.FOLDER:
            if path is None:
                raise typer.BadParameter("--path is required for folder nodes")
            return FolderOperation(type=OperationType.FOLDER, path=path)
        case OperationType.OPEN_RESOURCE:
            if target is None:
                raise typer.BadParameter("--target is required for open_resource nodes")
            return OpenResourceOperation(
                type=OperationType.OPEN_RESOURCE,
                target=target,
                resource_type=resource_type,  # type: ignore[arg-type]
                args=args,
            )
        case OperationType.PROMPT_FILE:
            if output_path is None:
                raise typer.BadParameter("--output-path is required for prompt_file nodes")
            return PromptFileOperation(
                type=OperationType.PROMPT_FILE,
                output_path=output_path,
                template=template,
                template_path=template_path,
                variables=variable_mapping,
                encoding=encoding,
                create_dirs=create_dirs,
                overwrite=True if overwrite is None else overwrite,
            )
        case OperationType.COMMON_LLM_TASK:
            if agent_id is None or working_dir is None:
                raise typer.BadParameter(
                    "--agent-id and --working-dir are required for common_llm_task nodes"
                )
            if memory not in {"none", "run", "all"}:
                raise typer.BadParameter("--memory must be one of none, run, all")
            return CommonLlmTaskOperation(
                type=OperationType.COMMON_LLM_TASK,
                agent_id=agent_id,
                task=task,  # type: ignore[arg-type]
                target=target_text,
                instructions=instructions,
                working_dir=working_dir,
                memory=memory,  # type: ignore[arg-type]
                input_mapping=input_mapping,
            )
        case OperationType.LOCAL_VECTORIZE:
            if source_path is None or index_path is None:
                raise typer.BadParameter(
                    "--source-path and --index-path are required for local_vectorize nodes"
                )
            return LocalVectorizeOperation(
                type=OperationType.LOCAL_VECTORIZE,
                source_path=source_path,
                index_path=index_path,
                glob=fan_glob,
                recursive=recursive,
            )
        case OperationType.LOCAL_SEARCH:
            if index_path is None:
                raise typer.BadParameter("--index-path is required for local_search nodes")
            return LocalSearchOperation(
                type=OperationType.LOCAL_SEARCH,
                index_path=index_path,
                query=target_text or command or "",
            )
        case OperationType.AGENT:
            if agent_id is None or working_dir is None:
                raise typer.BadParameter(
                    "--agent-id and --working-dir are required for agent nodes"
                )
            if prompt_path is None and not skill_name:
                raise typer.BadParameter(
                    "agent nodes require --prompt-path unless --skill-name is provided"
                )
            if memory not in {"none", "run", "all"}:
                raise typer.BadParameter("--memory must be one of none, run, all")
            count: int | str = int(dynamic_count) if dynamic_count.isdigit() else dynamic_count
            return AgentOperation(
                type=OperationType.AGENT,
                agent_id=agent_id,
                prompt_path=prompt_path,
                working_dir=working_dir,
                skill_name=skill_name,
                dynamic_count=count,
                memory=memory,  # type: ignore[arg-type]
                input_mapping=input_mapping,
                fan_source=fan_source,
            )
    raise typer.BadParameter(
        "node type must be one of "
        "bash_command, python_script, shell_script, agent, read_file, write_file, "
        "copy_file, move_file, delete_file, file, folder, open_resource, prompt_file, "
        "common_llm_task, local_vectorize, local_search"
    )


@app.command("run")
def run(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Simulate without executing"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show each node's output"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Execute a workflow by name or file path."""
    try:
        wf, workflow_path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.validate()
    base = data_dir or workflow_path.parent
    if wf.config.run_continuously:
        runs = list_workflow_run_logs_payload(wf.config.id, base).get("runs") or []
        if any(run_log.get("status") == "running" for run_log in runs):
            console.print(
                f"[yellow]Workflow '{wf.config.id}' is configured to run continuously "
                "and already has an active run.[/yellow]"
            )
            raise typer.Exit(1)

    result = asyncio.run(
        WorkflowExecutor(
            wf,
            _SUBSCRIPTIONS,
            dry_run=dry_run,
            log_base_dir=base / "logs",
            stop_file=workflow_stop_path(wf.config.id, base),
        ).run()
    )

    if verbose:
        for node_id, node_out in result.node_outputs.items():
            status = "[green]✓[/green]" if node_out.success else "[red]✗[/red]"
            if node_out.fan_outputs:
                for label, output in node_out.fan_outputs:
                    console.print(f"\n{status} [bold]{label}[/bold]")
                    if output:
                        console.print(output)
            else:
                console.print(f"\n{status} [bold]{node_id}[/bold]")
                if node_out.output:
                    console.print(node_out.output)

    if result.success:
        console.print(f"[green]✓[/green] Workflow '{result.workflow_id}' completed successfully "
                      f"in {result.duration_seconds:.2f}s")
    else:
        console.print(f"[red]✗[/red] Workflow '{result.workflow_id}' failed")
        raise typer.Exit(1)


@app.command("stop")
def stop(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Request that a running workflow stop."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    base = data_dir or path.parent
    stop_path = request_workflow_stop(wf.config.id, base)
    console.print(f"[green]Stop requested[/green] for '{wf.config.id}' via {stop_path}")


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


@app.command("import")
def import_workflow(
    source: Path = typer.Argument(..., help="Workflow TOML file to import"),
    replace: bool = typer.Option(False, "--replace", help="Replace an existing workflow"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Import a workflow TOML file into the Gofer data directory."""
    base = data_dir or get_data_dir()
    if not source.exists():
        console.print(f"[red]{source} not found[/red]")
        raise typer.Exit(1)

    try:
        if replace:
            workflow = AgenticWorkflow.from_file(source)
            workflow.validate()
            base.mkdir(parents=True, exist_ok=True)
            destination = base / f"{workflow.config.id}.toml"
            workflow.to_file(destination)
            console.print(f"[green]Imported[/green] {workflow.config.id} → {destination}")
            return

        payload = import_workflow_payload(source.read_text(encoding="utf-8"), base)
    except WorkflowAlreadyExistsError as exc:
        console.print(f"[red]{exc}. Use --replace to overwrite.[/red]")
        raise typer.Exit(1)
    except (WorkflowCreateError, OSError, Exception) as exc:
        console.print(f"[red]Import failed: {exc}[/red]")
        raise typer.Exit(1)

    workflow_id = str(payload["id"])
    console.print(f"[green]Imported[/green] {workflow_id} → {base / f'{workflow_id}.toml'}")


@logs_app.command("latest")
def logs_latest(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    path_only: bool = typer.Option(False, "--path-only", help="Print only the log path"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Print the latest run log for a workflow."""
    try:
        workflow_id, base = _workflow_log_context(workflow, data_dir)
        payload = latest_workflow_log_payload(workflow_id, base)
    except (KeyError, WorkflowLogError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    log_path = payload.get("logPath")
    if not log_path:
        console.print(f"No run logs found for [bold]{workflow_id}[/bold].")
        return
    if path_only:
        console.print(str(log_path))
        return
    console.print(payload.get("logText") or "")


@logs_app.command("list")
def logs_list(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """List run logs for a workflow."""
    try:
        workflow_id, base = _workflow_log_context(workflow, data_dir)
        payload = list_workflow_run_logs_payload(workflow_id, base)
    except (KeyError, WorkflowLogError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    runs = payload.get("runs") or []
    if not runs:
        console.print(f"No run logs found for [bold]{workflow_id}[/bold].")
        return

    for run_log in runs:
        console.print(
            "\t".join((
                str(run_log["id"]),
                str(run_log.get("startedAt") or "unknown"),
                str(run_log.get("status") or "unknown"),
                str(base / "logs" / workflow_id / str(run_log["id"])),
            ))
        )


@logs_app.command("show")
def logs_show(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    run_id: str = typer.Argument(..., help="Run log file name from workflow logs list"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Print a specific workflow run log."""
    try:
        workflow_id, base = _workflow_log_context(workflow, data_dir)
        payload = workflow_run_log_payload(workflow_id, run_id, base)
    except (KeyError, WorkflowLogError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    console.print(payload.get("logText") or "")


@app.command("show")
def show(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Display the graph structure of a workflow."""
    from gofer.cli.dag_renderer import render_workflow

    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    render_workflow(wf, console)


@app.command("set-info")
def set_info(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    name: str | None = typer.Option(None, "--name", help="Workflow display name"),
    max_total_node_runs: int | None = typer.Option(
        None,
        "--max-total-node-runs",
        min=1,
        help="Maximum node executions allowed in one workflow run",
    ),
    run_continuously: bool | None = typer.Option(
        None,
        "--run-continuously/--no-run-continuously",
        help="Keep one workflow run active and ignore schedule/watch starts",
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Update top-level workflow settings without opening an editor."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.config = WorkflowConfig(
        id=wf.config.id,
        name=name if name is not None else wf.config.name,
        schedule=wf.config.schedule,
        watch=wf.config.watch,
        run_continuously=(
            run_continuously
            if run_continuously is not None
            else wf.config.run_continuously
        ),
        max_total_node_runs=(
            max_total_node_runs
            if max_total_node_runs is not None
            else wf.config.max_total_node_runs
        ),
    )
    _save_workflow(wf, path)


@app.command("set-schedule")
def set_schedule(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    cron: str = typer.Option(..., "--cron", help="Cron expression"),
    timezone: str = typer.Option("UTC", "--timezone", help="Schedule timezone"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Add or replace a workflow cron schedule."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.config.schedule = ScheduleConfig(cron_expression=cron, timezone=timezone)
    _save_workflow(wf, path)


@app.command("clear-schedule")
def clear_schedule(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Remove a workflow cron schedule."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.config.schedule = None
    _save_workflow(wf, path)


@app.command("set-watch")
def set_watch(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    path_value: Path = typer.Option(..., "--path", help="File or folder to watch"),
    glob: str = typer.Option("*", "--glob", help="Glob pattern for watched paths"),
    recursive: bool = typer.Option(False, "--recursive", help="Watch subdirectories"),
    debounce_seconds: float = typer.Option(
        1.0, "--debounce-seconds", min=0.0, help="Seconds to debounce filesystem events"
    ),
    mode: str = typer.Option("batch", "--mode", help="batch, queue, or fanout"),
    max_concurrency: int = typer.Option(
        1, "--max-concurrency", min=1, help="Maximum concurrent queued watcher runs"
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Add or replace workflow file/folder watcher settings."""
    try:
        wf, workflow_path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    try:
        wf.config.watch = WatchConfig(
            path=path_value,
            glob=glob,
            recursive=recursive,
            debounce_seconds=debounce_seconds,
            mode=mode,  # type: ignore[arg-type]
            max_concurrency=max_concurrency,
        )
    except Exception as exc:
        console.print(f"[red]Invalid watch config: {exc}[/red]")
        raise typer.Exit(1)
    _save_workflow(wf, workflow_path)


@app.command("clear-watch")
def clear_watch(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Remove workflow file/folder watcher settings."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    wf.config.watch = None
    _save_workflow(wf, path)


@app.command("add-agent")
def add_agent(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    agent_id: str = typer.Option(..., "--id", help="Agent ID"),
    subscription: str = typer.Option(..., "--subscription", help="codex or claude_code"),
    working_dir: Path = typer.Option(..., "--working-dir", help="Agent working directory"),
    prompt_path: Path = typer.Option(..., "--prompt-path", help="Prompt markdown path"),
    tool: list[str] | None = typer.Option(None, "--tool", help="Allowed tool name"),
    mcp_server: list[str] | None = typer.Option(
        None, "--mcp-server", help="MCP server name"
    ),
    env: list[str] | None = typer.Option(None, "--env", help="Environment KEY=VALUE"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Add or replace an agent config in a workflow."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    try:
        wf.register_agent(
            AgentConfig(
                agent_id=agent_id,
                subscription=subscription,  # type: ignore[arg-type]
                working_dir=working_dir,
                prompt_path=prompt_path,
                tools=tool or [],
                mcp_servers=mcp_server or [],
                env=_parse_key_values(env, "--env"),
            )
        )
    except Exception as exc:
        console.print(f"[red]Invalid agent config: {exc}[/red]")
        raise typer.Exit(1)
    _save_workflow(wf, path)


@app.command("add-node")
def add_node(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    node_id: str = typer.Option(..., "--id", help="Node ID"),
    node_type: str = typer.Option(..., "--type", help="Node operation type"),
    command: str | None = typer.Option(None, "--command", help="Command for command nodes"),
    script_path: Path | None = typer.Option(
        None, "--script-path", help="Script path for script nodes"
    ),
    path_value: Path | None = typer.Option(
        None, "--path", help="Path for read/write/delete/file/folder nodes"
    ),
    source_path: Path | None = typer.Option(
        None, "--source-path", help="Source path for copy/move nodes"
    ),
    destination_path: Path | None = typer.Option(
        None, "--destination-path", help="Destination path for copy/move nodes"
    ),
    target: str | None = typer.Option(None, "--target", help="Target for open_resource"),
    resource_type: str = typer.Option(
        "auto", "--resource-type", help="auto, file, folder, url, or app"
    ),
    content: str = typer.Option("", "--content", help="Content for write_file nodes"),
    template: str = typer.Option("", "--template", help="Inline prompt template"),
    template_path: Path | None = typer.Option(
        None, "--template-path", help="Prompt template file path"
    ),
    output_path: Path | None = typer.Option(
        None, "--output-path", help="Output path for prompt/index nodes"
    ),
    working_dir: Path | None = typer.Option(
        None, "--working-dir", help="Working directory for command/agent nodes"
    ),
    agent_id: str | None = typer.Option(None, "--agent-id", help="Agent ID for agent nodes"),
    prompt_path: Path | None = typer.Option(
        None, "--prompt-path", help="Prompt path for agent nodes"
    ),
    skill_name: str | None = typer.Option(
        None, "--skill-name", help="Skill name for agent skill invocation"
    ),
    task: str = typer.Option("summarize", "--task", help="Common LLM task preset"),
    target_text: str = typer.Option(
        "", "--task-target", "--query", help="Task target text or search query"
    ),
    instructions: str = typer.Option("", "--instructions", help="Task instructions"),
    index_path: Path | None = typer.Option(None, "--index-path", help="Local vector index path"),
    dynamic_count: str = typer.Option("1", "--dynamic-count", help="Agent dynamic count"),
    memory: str = typer.Option(
        "none",
        "--memory",
        help="Agent memory mode: none, run, or all",
    ),
    input_map: list[str] | None = typer.Option(
        None, "--input-map", help="Agent input mapping KEY=CTX_PATH"
    ),
    input_mapping_json: str | None = typer.Option(
        None, "--input-mapping-json", help="Agent input mapping JSON object"
    ),
    variable: list[str] | None = typer.Option(
        None, "--variable", help="Prompt template variable KEY=CTX_PATH_OR_VALUE"
    ),
    env: list[str] | None = typer.Option(None, "--env", help="Environment KEY=VALUE"),
    arg: list[str] | None = typer.Option(None, "--arg", help="Script/open-resource arg"),
    create_dirs: bool = typer.Option(True, "--create-dirs/--no-create-dirs"),
    overwrite: bool | None = typer.Option(
        None,
        "--overwrite/--no-overwrite",
        help="Override file overwrite behavior for write/copy/move nodes",
    ),
    append: bool = typer.Option(False, "--append", help="Append in write_file nodes"),
    use_trash: bool = typer.Option(True, "--trash/--no-trash"),
    recursive: bool = typer.Option(False, "--recursive"),
    missing_ok: bool = typer.Option(False, "--missing-ok"),
    encoding: str = typer.Option("utf-8", "--encoding"),
    errors: str = typer.Option("strict", "--errors"),
    pipe_output: bool = typer.Option(False, "--pipe-output"),
    allow_failure: bool = typer.Option(
        False,
        "--allow-failure",
        help="Allow this node to fail without failing the overall workflow",
    ),
    retry_count: int = typer.Option(0, "--retry-count", min=0),
    retry_delay_seconds: float = typer.Option(1.0, "--retry-delay-seconds", min=0.0),
    timeout_seconds: float | None = typer.Option(None, "--timeout-seconds", min=0.0),
    fan_source: str | None = typer.Option(
        None, "--fan-source", help="count, tabular, directory, or trigger-events"
    ),
    fan_count: str = typer.Option("1", "--fan-count"),
    fan_path: Path | None = typer.Option(None, "--fan-path"),
    fan_glob: str = typer.Option("*", "--fan-glob"),
    fan_include_content: bool = typer.Option(False, "--fan-include-content"),
    fan_max_concurrency: int = typer.Option(16, "--fan-max-concurrency", min=1),
    fan_fail_fast: bool = typer.Option(False, "--fan-fail-fast"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Add or replace a workflow node."""
    try:
        wf, workflow_path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    mapping = _parse_key_values(input_map, "--input-map")
    mapping.update(_parse_json_object(input_mapping_json, "--input-mapping-json"))
    try:
        operation = _operation_from_options(
            node_type,
            command=command,
            script_path=script_path,
            path=path_value,
            source_path=source_path,
            destination_path=destination_path,
            target=target,
            resource_type=resource_type,
            content=content,
            template=template,
            template_path=template_path,
            output_path=output_path,
            variable_mapping=_parse_key_values(variable, "--variable"),
            working_dir=working_dir,
            agent_id=agent_id,
            prompt_path=prompt_path,
            skill_name=skill_name,
            task=task,
            target_text=target_text,
            instructions=instructions,
            index_path=index_path,
            dynamic_count=dynamic_count,
            memory=memory,
            input_mapping=mapping,
            env=_parse_key_values(env, "--env"),
            args=arg or [],
            create_dirs=create_dirs,
            overwrite=overwrite,
            append=append,
            use_trash=use_trash,
            recursive=recursive,
            missing_ok=missing_ok,
            encoding=encoding,
            errors=errors,
            fan_source=_fan_source_from_options(
                fan_source,
                fan_count,
                fan_path,
                fan_glob,
                fan_include_content,
                fan_max_concurrency,
                fan_fail_fast,
            ),
        )
        wf.add_operation(
            GraphNode(
                node_id=node_id,
                operation=operation,
                pipe_output=pipe_output,
                allow_failure=allow_failure,
                retry_count=retry_count,
                retry_delay_seconds=retry_delay_seconds,
                timeout_seconds=timeout_seconds,
            )
        )
    except Exception as exc:
        console.print(f"[red]Invalid node config: {exc}[/red]")
        raise typer.Exit(1)
    _save_workflow(wf, workflow_path)


@app.command("rm-node")
def rm_node(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    node_id: str = typer.Option(..., "--id", help="Node ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Remove a workflow node and its edges."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if node_id not in wf.graph._nodes:
        console.print(f"[red]Node '{node_id}' not found[/red]")
        raise typer.Exit(1)
    wf.graph._graph.remove_node(node_id)
    wf.graph._nodes.pop(node_id, None)
    wf.graph._edges = {
        edge: cfg for edge, cfg in wf.graph._edges.items() if node_id not in edge
    }
    _save_workflow(wf, path)


@app.command("add-edge")
def add_edge(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    from_node: str = typer.Option(..., "--from", help="Source node ID"),
    to_node: str = typer.Option(..., "--to", help="Target node ID"),
    condition: str = typer.Option("always", "--condition", help="Edge condition"),
    output_pattern: str | None = typer.Option(
        None, "--output-pattern", help="Regex for output_matches condition"
    ),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Add or replace a workflow edge."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
        edge_condition = EdgeConditionType(condition)
        wf.then(
            from_node,
            to_node,
            EdgeConfig(
                from_node=from_node,
                to_node=to_node,
                condition=edge_condition,
                output_pattern=output_pattern,
            ),
        )
    except Exception as exc:
        console.print(f"[red]Invalid edge config: {exc}[/red]")
        raise typer.Exit(1)
    _save_workflow(wf, path)


@app.command("rm-edge")
def rm_edge(
    workflow: str = typer.Argument(..., help="Workflow ID or path to TOML file"),
    from_node: str = typer.Option(..., "--from", help="Source node ID"),
    to_node: str = typer.Option(..., "--to", help="Target node ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Remove a workflow edge."""
    try:
        wf, path = _resolve_workflow_with_path(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if wf.graph._graph.has_edge(from_node, to_node):
        wf.graph._graph.remove_edge(from_node, to_node)
    wf.graph._edges.pop((from_node, to_node), None)
    _save_workflow(wf, path)


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
    """Interactively edit a workflow's fields in the terminal."""
    from gofer.cli.tui_editor import (
        FieldEditorApp,
        sections_to_workflow,
        workflow_to_sections,
    )

    try:
        wf = _resolve_workflow(workflow, data_dir)
    except KeyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    base = data_dir or get_data_dir()
    path = base / f"{wf.config.id}.toml"
    sections = workflow_to_sections(wf)

    if FieldEditorApp(sections, title=f"Edit Workflow: {wf.config.id}").run():
        sections_to_workflow(sections, wf)
        try:
            wf.validate()
        except Exception as exc:
            console.print(f"[red]Validation failed: {exc}[/red]")
            raise typer.Exit(1)
        wf.to_file(path)
        console.print(f"[green]Saved[/green] {path}")
    else:
        console.print("[yellow]Edit cancelled.[/yellow]")


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
    resolved_path = Path(workflow)
    path = resolved_path if resolved_path.suffix == ".toml" and resolved_path.exists() else base / f"{wf.config.id}.toml"
    cleanup_base = data_dir or path.parent

    if not yes:
        typer.confirm(f"Delete workflow '{wf.config.id}' ({path})?", abort=True)

    path.unlink()
    shutil.rmtree(cleanup_base / "logs" / wf.config.id, ignore_errors=True)
    shutil.rmtree(cleanup_base / "agent-memory" / wf.config.id, ignore_errors=True)
    workflow_stop_path(wf.config.id, cleanup_base).unlink(missing_ok=True)
    delete_workflow_chat_prompt(cleanup_base, wf.config.id)
    console.print(f"[green]Deleted[/green] {path}")


@app.command("rename")
def rename(
    workflow: str = typer.Argument(..., help="Workflow ID"),
    name: str = typer.Option(..., "--name", help="New workflow name"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Rename a workflow and update its ID to match the new name."""
    try:
        saved = rename_workflow_payload(workflow, name, data_dir)
    except (WorkflowAlreadyExistsError, WorkflowUpdateError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    console.print(
        f"[green]Renamed[/green] workflow to {saved['name']} ({saved['id']})"
    )


@app.command("duplicate")
def duplicate(
    workflow: str = typer.Argument(..., help="Workflow ID"),
    name: str | None = typer.Option(None, "--name", help="Name for duplicate"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Duplicate a workflow TOML file with a new ID/name."""
    try:
        saved = duplicate_workflow_payload(workflow, name, data_dir)
    except (WorkflowAlreadyExistsError, WorkflowCreateError, WorkflowUpdateError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)

    console.print(
        f"[green]Duplicated[/green] workflow to {saved['name']} ({saved['id']})"
    )


@app.command("build")
def build(
    output: Path | None = typer.Option(None, "--output", help="Output path for workflow TOML"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Interactively build a workflow via a guided wizard."""
    from gofer.cli.commands.builder import WorkflowBuilder

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

# [workflow.watch]
# path = "inputs"
# glob = "*.txt"
# recursive = false
# debounce_seconds = 1.0
# mode = "batch" # batch, queue, or fanout
# max_concurrency = 1

# [[nodes]]
# id = "my-step"
# type = "bash_command"
# command = "echo hello"

# First-class file I/O node examples:
# type = "read_file"   path = "data/input.txt"
# type = "write_file"  path = "data/output.txt"  content = ""
# type = "copy_file"   source_path = "data/input.txt"  destination_path = "archive/input.txt"
# type = "move_file"   source_path = "data/input.txt"  destination_path = "archive/input.txt"
# type = "delete_file" path = "tmp/file.txt" use_trash = true
# type = "open_resource" target = "data/output.txt" resource_type = "auto"
"""
    path.write_text(content)
    console.print(f"Created [bold]{path}[/bold]")


@recipe_app.command("watch-folder-summarize")
def recipe_watch_folder_summarize(
    name: str = typer.Option(..., "--name", help="Workflow name"),
    watch_path: Path = typer.Option(..., "--watch-path", help="Folder to watch"),
    glob: str = typer.Option("*", "--glob", help="Changed file glob"),
    recursive: bool = typer.Option(False, "--recursive", help="Watch subdirectories"),
    provider: str = typer.Option("codex", "--provider", help="codex or claude_code"),
    working_dir: Path = typer.Option(Path("."), "--working-dir", help="Agent working dir"),
    max_concurrency: int = typer.Option(
        4, "--max-concurrency", min=1, help="Agent fan-out concurrency"
    ),
    debounce_seconds: float = typer.Option(
        1.0, "--debounce-seconds", min=0.0, help="Watcher debounce seconds"
    ),
    output: Path | None = typer.Option(None, "--output", help="Workflow TOML output path"),
    prompt_path: Path | None = typer.Option(
        None, "--prompt-path", help="Prompt markdown path to create or reuse"
    ),
    overwrite: bool = typer.Option(False, "--overwrite", help="Overwrite existing files"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    """Create a folder watcher workflow that fans changed files into an agent summarizer."""
    workflow_id = _slugify(name)
    base = data_dir or get_data_dir()
    workflow_path = output or base / f"{workflow_id}.toml"
    prompt_file = prompt_path or base / "prompts" / f"{workflow_id}-summarizer.md"

    if workflow_path.exists() and not overwrite:
        console.print(f"[red]{workflow_path} already exists. Use --overwrite to replace it.[/red]")
        raise typer.Exit(1)
    if prompt_file.exists() and not overwrite:
        console.print(f"[red]{prompt_file} already exists. Use --overwrite to replace it.[/red]")
        raise typer.Exit(1)

    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    prompt_file.write_text(
        """Summarize this changed file for a Gofer Flow user.

Event kind: {{kind}}
File path: {{path}}
File name: {{name}}

Content:

{{file_content}}

Return a concise summary with:
- what the file contains or demonstrates
- notable commands, configuration, or workflow details
- any assumptions needed to use it
""",
        encoding="utf-8",
    )

    wf = AgenticWorkflow(
        WorkflowConfig(
            id=workflow_id,
            name=name,
            watch=WatchConfig(
                path=watch_path,
                glob=glob,
                recursive=recursive,
                debounce_seconds=debounce_seconds,
                mode="fanout",
                max_concurrency=1,
            ),
        )
    )
    wf.register_agent(
        AgentConfig(
            agent_id="summarizer",
            subscription=provider,  # type: ignore[arg-type]
            working_dir=working_dir,
            prompt_path=prompt_file,
            tools=[],
            mcp_servers=[],
            env={},
        )
    )
    wf.add_operation(
        GraphNode(
            node_id="summarize-added-files",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="summarizer",
                prompt_path=prompt_file,
                working_dir=working_dir,
                fan_source=TriggerEventsFanSource(
                    type="trigger_events",
                    include_content=True,
                    max_concurrency=max_concurrency,
                    fail_fast=False,
                ),
            ),
        )
    )
    _save_workflow(wf, workflow_path)
    console.print("[green]Created folder watcher summarizer workflow[/green]")
