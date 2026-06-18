from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
import webbrowser
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import anyio

from gofer.core.agent import Agent, AgentResult
from gofer.core.graph import EdgeConditionType, GraphNode, WorkflowGraph
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    CountFanSource,
    DeleteFileOperation,
    DirectoryFanSource,
    FanSource,
    FileOperation,
    FolderOperation,
    LocalSearchOperation,
    LocalVectorizeOperation,
    MoveFileOperation,
    OpenResourceOperation,
    OperationType,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    TabularFanSource,
    TriggerEventsFanSource,
    WriteFileOperation,
)
from gofer.core.workflow import AgenticWorkflow
from gofer.prompts.manager import PromptManager
from gofer.subscriptions.base import Subscription
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess
from gofer.utils.run_state import clear_workflow_stop, workflow_run_stop_path

log = get_logger(__name__)


def command_shell_args(command: str) -> list[str]:
    if sys.platform == "win32":
        return [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
    return ["bash", "-c", command]


def open_resource_args(target: str, resource_type: str = "auto", args: list[str] | None = None) -> list[str]:
    if resource_type == "app":
        return [target, *(args or [])]
    if sys.platform == "win32":
        return ["cmd", "/c", "start", "", target]
    if sys.platform == "darwin":
        return ["open", target]
    return ["xdg-open", target]


def _remove_path(path: Path, recursive: bool = False) -> None:
    if path.is_dir():
        if not recursive:
            raise IsADirectoryError(f"{path} is a directory; enable recursive delete")
        shutil.rmtree(path)
        return
    path.unlink()


def _prepare_destination(path: Path, create_dirs: bool, overwrite: bool) -> None:
    if create_dirs:
        path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise FileExistsError(f"{path} already exists")


def _copy_path(source: Path, destination: Path, create_dirs: bool, overwrite: bool) -> None:
    _prepare_destination(destination, create_dirs, overwrite)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=overwrite)
        return
    shutil.copy2(source, destination)


def _move_path(source: Path, destination: Path, create_dirs: bool, overwrite: bool) -> None:
    _prepare_destination(destination, create_dirs, overwrite)
    if destination.exists():
        _remove_path(destination, recursive=True)
    shutil.move(str(source), str(destination))


def _trash_path(path: Path) -> Path:
    trash_root = get_data_dir() / "trash"
    trash_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H-%M-%S%f%z")
    destination = trash_root / f"{timestamp}-{path.name}"
    shutil.move(str(path), str(destination))
    return destination


def _load_tabular(path: Path) -> list[dict[str, object]]:
    suffix = path.suffix.lower()
    def _with_row(row: dict[str, object]) -> dict[str, object]:
        return {**row, "_row": json.dumps(row)}

    if suffix == ".jsonl":
        rows: list[dict[str, object]] = []
        with path.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(_with_row(json.loads(line)))
        return rows
    if suffix == ".csv":
        with path.open(newline="") as f:
            return [_with_row(dict(row)) for row in csv.DictReader(f)]
    if suffix == ".xlsx":
        try:
            import openpyxl
        except ImportError as exc:
            raise ImportError(
                "openpyxl is required for .xlsx support: pip install 'gofer-flow[xlsx]'"
            ) from exc
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        headers = [str(h) for h in next(rows_iter)]
        return [_with_row(dict(zip(headers, row))) for row in rows_iter]
    raise ValueError(f"Unsupported tabular format: {suffix!r}. Use .jsonl, .csv, or .xlsx")


def _token_vector(text: str) -> dict[str, float]:
    tokens = re.findall(r"[A-Za-z0-9_]{2,}", text.lower())
    vector: dict[str, float] = {}
    for token in tokens:
        key = hashlib.blake2b(token.encode("utf-8"), digest_size=4).hexdigest()
        vector[key] = vector.get(key, 0.0) + 1.0
    norm = sum(value * value for value in vector.values()) ** 0.5
    if norm:
        vector = {key: value / norm for key, value in vector.items()}
    return vector


def _cosine_similarity(left: dict[str, float], right: dict[str, float]) -> float:
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(key, 0.0) for key, value in left.items())


def _chunk_text(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")
    overlap = max(0, min(chunk_overlap, chunk_size - 1))
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + chunk_size])
        start += chunk_size - overlap
    return chunks or [""]


def common_llm_task_prompt(task: str, target: str, instructions: str = "") -> str:
    task_prompts = {
        "review": "Review the provided content. Identify issues, risks, and concrete improvements.",
        "summarize": "Summarize the provided content clearly and concisely.",
        "explain": "Explain the provided content in practical terms for the intended user.",
        "extract": "Extract the requested facts, entities, decisions, or action items.",
        "rewrite": "Rewrite the provided content according to the user's instructions.",
        "classify": "Classify the provided content and explain the classification briefly.",
    }
    parts = [task_prompts.get(task, task_prompts["summarize"])]
    if instructions.strip():
        parts += ["", "Additional instructions:", instructions.strip()]
    if target.strip():
        parts += ["", "Target content or path:", target.strip()]
    parts += [
        "",
        "Context from workflow inputs, mapped variables, or piped predecessor output may follow.",
    ]
    return "\n".join(parts)


def _resolve_fan_items(
    source: FanSource, ctx: ExecutionContext
) -> list[dict[str, object]]:
    if isinstance(source, CountFanSource):
        count = ctx.resolve_dynamic_count(source.count)
        return [{"index": str(i)} for i in range(count)]
    if isinstance(source, TabularFanSource):
        return _load_tabular(source.path)
    if isinstance(source, DirectoryFanSource):
        items: list[dict[str, object]] = []
        for p in sorted(source.path.glob(source.glob)):
            if p.is_file():
                entry: dict[str, object] = {
                    "file_path": str(p),
                    "file_name": p.name,
                }
                if source.include_content:
                    entry["file_content"] = p.read_text()
                items.append(entry)
        return items
    if isinstance(source, TriggerEventsFanSource):
        events = ctx.trigger.get("events", [])
        if not isinstance(events, list):
            return []
        items = []
        for idx, event in enumerate(events):
            if not isinstance(event, dict):
                continue
            item = {
                **event,
                "index": str(idx),
                "event_json": json.dumps(event),
            }
            path = event.get("path")
            if source.include_content and path:
                file_path = Path(str(path))
                if file_path.exists() and file_path.is_file():
                    item["file_content"] = file_path.read_text(errors="replace")
            items.append(item)
        return items
    raise ValueError(f"Unknown fan source type: {source}")  # pragma: no cover


@dataclass
class NodeOutput:
    node_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float
    skipped: bool = False
    fan_outputs: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class ExecutionContext:
    node_outputs: dict[str, NodeOutput] = field(default_factory=dict)
    node_runs: dict[str, list[NodeOutput]] = field(default_factory=dict)
    trigger: dict[str, Any] = field(default_factory=dict)

    def record(self, output: NodeOutput) -> None:
        self.node_outputs[output.node_id] = output
        self.node_runs.setdefault(output.node_id, []).append(output)

    def resolve_dynamic_count(self, value: int | str) -> int:
        if isinstance(value, int):
            return value
        parts = value.strip("{}").split(".")
        obj: Any = {k: v.__dict__ for k, v in self.node_outputs.items()}
        for part in parts:
            if not isinstance(obj, dict):
                raise ValueError(f"Cannot resolve dynamic_count path: {value!r}")
            obj = obj.get(part)
        return int(obj)

    def resolve_path(self, value: str) -> object:
        if value in self.node_outputs:
            return self.node_outputs[value].output
        parts = value.strip("{}").split(".")
        if parts and parts[0] == "trigger":
            obj: Any = self.trigger
            parts = parts[1:]
        else:
            obj = {k: v.__dict__ for k, v in self.node_outputs.items()}
        for part in parts:
            if isinstance(obj, list):
                obj = obj[int(part)]
                continue
            if not isinstance(obj, dict):
                raise ValueError(f"Cannot resolve path: {value!r}")
            obj = obj.get(part)
        return "" if obj is None else obj

    def predecessor_outputs(self, node_id: str, graph: WorkflowGraph) -> list[NodeOutput]:
        return [
            self.node_outputs[pid]
            for pid in graph._graph.predecessors(node_id)
            if pid in self.node_outputs
        ]


@dataclass
class ExecutionResult:
    workflow_id: str
    success: bool
    node_outputs: dict[str, NodeOutput]
    duration_seconds: float
    node_runs: dict[str, list[NodeOutput]] = field(default_factory=dict)
    log_path: Path | None = None


class WorkflowRunLog:
    def __init__(self, workflow_id: str, base_dir: Path | None = None) -> None:
        self.workflow_id = workflow_id
        self.started_at = datetime.now().astimezone()
        timestamp = self.started_at.strftime("%Y-%m-%dT%H-%M-%S%f%z")
        root = base_dir or get_data_dir() / "logs"
        self.path = root / workflow_id / f"{timestamp}.log"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            f"{self._now()} - {self.workflow_id} started successfully\n",
            encoding="utf-8",
        )

    def info(self, message: str) -> None:
        self._write("INFO", message)

    def error(self, message: str) -> None:
        self._write("ERROR", message)

    def node(self, node_id: str, message: str) -> None:
        self._write("NODE", f"{node_id} - {message}")

    def node_output(self, node_id: str, label: str, value: str) -> None:
        if not value:
            return
        self._write("NODE", f"{node_id} - {label}:")
        with self.path.open("a", encoding="utf-8") as fh:
            for line in value.rstrip("\n").splitlines():
                fh.write(f"{line}\n")

    def complete(self, success: bool, reason: str | None = None) -> None:
        if success:
            self.info(f"{self.workflow_id} completed successfully")
        else:
            self.error(f"{self.workflow_id} failed due to {reason or 'unknown error'}")

    def _write(self, level: str, message: str) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(f"{self._now()} - {level} - {message}\n")

    def _now(self) -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")


class WorkflowExecutor:
    def __init__(
        self,
        workflow: AgenticWorkflow,
        subscriptions: dict[str, Subscription],
        dry_run: bool = False,
        log_base_dir: Path | None = None,
        max_total_node_runs: int | None = None,
        cancel_event: threading.Event | None = None,
        stop_file: Path | None = None,
    ) -> None:
        self._workflow = workflow
        self._subscriptions = subscriptions
        self._dry_run = dry_run
        self._log_base_dir = log_base_dir
        self._max_total_node_runs = max_total_node_runs or workflow.config.max_total_node_runs
        self._pass_cancel_event = cancel_event is not None or stop_file is not None
        self._cancel_event = cancel_event or threading.Event()
        self._stop_file = stop_file
        self._run_stop_file: Path | None = None
        self._stop_monitor_done = threading.Event()
        self._trigger_context: dict[str, Any] = {}
        self._run_log: WorkflowRunLog | None = None

    def with_trigger_context(self, trigger_context: dict[str, Any]) -> WorkflowExecutor:
        self._trigger_context = trigger_context
        return self

    def _log(self) -> WorkflowRunLog:
        if self._run_log is None:
            raise RuntimeError("Workflow run log has not been initialized")
        return self._run_log

    async def run(self) -> ExecutionResult:
        if self._stop_file is not None:
            self._stop_file.unlink(missing_ok=True)
        else:
            clear_workflow_stop(self._workflow.config.id)
        monitor = self._start_stop_monitor()
        self._run_log = WorkflowRunLog(self._workflow.config.id, self._log_base_dir)
        run_log = self._log()
        if self._stop_file is not None:
            data_dir = self._stop_file.parent.parent
            self._run_stop_file = workflow_run_stop_path(
                self._workflow.config.id,
                run_log.path.name,
                data_dir,
            )
            self._run_stop_file.unlink(missing_ok=True)
        ctx = ExecutionContext(trigger=self._trigger_context)
        graph = self._workflow.graph
        start = time.monotonic()
        halted = False
        halt_reason: str | None = None
        total_node_runs = 0
        run_counts: dict[str, int] = {}
        try:
            run_log.info(f"dry_run={self._dry_run}")
            run_log.info(f"max_total_node_runs={self._max_total_node_runs}")
            if ctx.trigger:
                run_log.info(f"trigger={json.dumps(ctx.trigger, default=str)}")

            queue: deque[str] = deque(self._initial_node_ids(graph))
            queued_node_ids = set(queue)
            run_log.info(f"start_nodes={list(queue)}")

            while queue and not halted:
                if self._stop_requested():
                    halted = True
                    halt_reason = "stopped by user"
                    run_log.error(halt_reason)
                    break

                node_id = queue.popleft()
                queued_node_ids.discard(node_id)
                node = graph._nodes[node_id]
                total_node_runs += 1
                if total_node_runs > self._max_total_node_runs:
                    halted = True
                    halt_reason = (
                        "maximum node run limit exceeded "
                        f"({self._max_total_node_runs}); check recursive edges"
                    )
                    run_log.error(halt_reason)
                    break

                run_counts[node_id] = run_counts.get(node_id, 0) + 1
                run_number = run_counts[node_id]
                results: dict[str, NodeOutput] = {}
                halt_flag: list[bool] = [False]
                await self._run_node(node, ctx, results, halt_flag, graph, run_number)

                output = results[node_id]
                ctx.record(output)
                if halt_flag[0]:
                    halted = True
                    break

                for successor_id in graph._graph.successors(node_id):
                    edge = graph.get_edge_config(node_id, successor_id)
                    if not edge.evaluate(output):
                        continue
                    if successor_id in queued_node_ids:
                        continue
                    queue.append(successor_id)
                    queued_node_ids.add(successor_id)

            for node_id in graph._nodes:
                if node_id not in ctx.node_runs:
                    run_log.node(node_id, "skipped")

            total = time.monotonic() - start
            success = not halted and all(
                o.success for o in ctx.node_outputs.values() if not o.skipped
            )
            reason = None if success else halt_reason or self._failure_reason(ctx.node_outputs)
            run_log.complete(success, reason)
            return ExecutionResult(
                workflow_id=self._workflow.config.id,
                success=success,
                node_outputs=ctx.node_outputs,
                node_runs=ctx.node_runs,
                duration_seconds=total,
                log_path=run_log.path,
            )
        except BaseException as exc:
            run_log.complete(False, str(exc))
            raise
        finally:
            self._stop_monitor_done.set()
            if monitor is not None:
                monitor.join(timeout=1)
            if self._stop_file is not None:
                if self._run_stop_file is not None:
                    self._run_stop_file.unlink(missing_ok=True)

    def _start_stop_monitor(self) -> threading.Thread | None:
        if self._stop_file is None:
            return None

        def monitor() -> None:
            while not self._stop_monitor_done.wait(0.1):
                if (
                    (self._stop_file and self._stop_file.exists())
                    or (self._run_stop_file and self._run_stop_file.exists())
                ):
                    self._cancel_event.set()
                    return

        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        return thread

    def _initial_node_ids(self, graph: WorkflowGraph) -> list[str]:
        roots = [
            node_id
            for node_id in graph._nodes
            if not [
                pred_id
                for pred_id in graph._graph.predecessors(node_id)
                if pred_id != node_id
            ]
        ]
        if roots:
            return roots
        return [next(iter(graph._nodes))] if graph._nodes else []

    async def _run_node(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        results: dict[str, NodeOutput],
        halt_flag: list[bool],
        graph: WorkflowGraph,
        run_number: int = 1,
    ) -> None:
        if self._dry_run:
            log.info("[dry-run] would execute node %s", node.node_id)
            self._log().node(
                node.node_id,
                self._run_log_message(run_number, "dry-run would execute"),
            )
            results[node.node_id] = NodeOutput(
                node_id=node.node_id, success=True, output="", exit_code=0, duration_seconds=0.0
            )
            return

        attempt = 0
        output: NodeOutput | None = None
        while True:
            self._log().node(
                node.node_id,
                self._run_log_message(run_number, f"attempt {attempt + 1} started"),
            )
            try:
                output = await self._execute_operation(node, ctx, graph)
            except Exception as exc:  # noqa: BLE001
                self._log().error(f"{node.node_id} raised exception: {exc}")
                output = NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=str(exc),
                    exit_code=1,
                    duration_seconds=0.0,
                )
            results[node.node_id] = output
            self._log().node_output(node.node_id, "node output", output.output)
            self._log().node(
                node.node_id,
                self._run_log_message(
                    run_number,
                    f"attempt {attempt + 1} finished success={output.success} "
                    f"exit_code={output.exit_code} duration={output.duration_seconds:.2f}s",
                ),
            )
            if output.success or attempt >= node.retry_count:
                break
            attempt += 1
            self._log().node(
                node.node_id,
                self._run_log_message(
                    run_number, f"retrying after {node.retry_delay_seconds:.2f}s"
                ),
            )
            if self._stop_requested():
                break
            await anyio.sleep(node.retry_delay_seconds)

        if output is not None and not output.success:
            if node.on_failure == "halt" and not self._has_failure_route(node, output, graph):
                halt_flag[0] = True

        if self._stop_requested():
            halt_flag[0] = True

    def _run_log_message(self, run_number: int, message: str) -> str:
        if run_number == 1:
            return message
        return f"run {run_number} {message}"

    def _has_failure_route(
        self, node: GraphNode, output: NodeOutput, graph: WorkflowGraph
    ) -> bool:
        for successor_id in graph._graph.successors(node.node_id):
            edge = graph.get_edge_config(node.node_id, successor_id)
            if edge.condition == EdgeConditionType.ON_FAILURE and edge.evaluate(output):
                return True
        return False

    def _resolve_pipe_stdin(
        self, node: GraphNode, ctx: ExecutionContext, graph: WorkflowGraph
    ) -> bytes | None:
        piped = [
            o.output
            for pred_id in graph._graph.predecessors(node.node_id)
            if (pred_node := graph._nodes.get(pred_id)) is not None
            and pred_node.pipe_output
            and (o := ctx.node_outputs.get(pred_id)) is not None
        ]
        if not piped:
            return None
        return "\n".join(piped).encode()

    async def _execute_operation(
        self, node: GraphNode, ctx: ExecutionContext, graph: WorkflowGraph
    ) -> NodeOutput:
        op = node.operation
        start = time.monotonic()

        if op.type == OperationType.BASH_COMMAND:
            assert isinstance(op, BashCommandOperation)
            stdin = self._resolve_pipe_stdin(node, ctx, graph)
            cmd = command_shell_args(op.command)
            self._log().node(node.node_id, f"command: {op.command}")
            self._log().node(node.node_id, f"command shell: {cmd[0]}")
            rc, stdout, stderr = await run_subprocess(
                cmd,
                cancel_event=self._cancel_event,
                cwd=op.working_dir,
                env=op.env or None,
                timeout=node.timeout_seconds,
                stdin=stdin,
            )
            self._log().node_output(node.node_id, "stdout", stdout)
            self._log().node_output(node.node_id, "stderr", stderr)
            return NodeOutput(
                node_id=node.node_id,
                success=rc == 0,
                output=stdout or stderr,
                exit_code=rc,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type in (OperationType.PYTHON_SCRIPT, OperationType.SHELL_SCRIPT):
            assert isinstance(op, (PythonScriptOperation, ShellScriptOperation))
            interpreter = "python" if op.type == OperationType.PYTHON_SCRIPT else "bash"
            cmd = [interpreter, str(op.script_path)] + list(op.args)
            stdin = self._resolve_pipe_stdin(node, ctx, graph)
            self._log().node(node.node_id, f"command: {' '.join(cmd)}")
            rc, stdout, stderr = await run_subprocess(
                cmd,
                cancel_event=self._cancel_event,
                env=op.env or None,
                timeout=node.timeout_seconds,
                stdin=stdin,
            )
            self._log().node_output(node.node_id, "stdout", stdout)
            self._log().node_output(node.node_id, "stderr", stderr)
            return NodeOutput(
                node_id=node.node_id,
                success=rc == 0,
                output=stdout or stderr,
                exit_code=rc,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.READ_FILE:
            assert isinstance(op, ReadFileOperation)
            self._log().node(node.node_id, f"read file: {op.path}")
            content = op.path.read_text(encoding=op.encoding, errors=op.errors)
            self._log().node_output(node.node_id, "file content", content)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=content,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.WRITE_FILE:
            assert isinstance(op, WriteFileOperation)
            stdin = self._resolve_pipe_stdin(node, ctx, graph)
            content = op.content
            if content == "" and stdin is not None:
                content = stdin.decode(op.encoding)
            _prepare_destination(op.path, op.create_dirs, op.overwrite or op.append)
            mode = "a" if op.append else "w"
            with op.path.open(mode, encoding=op.encoding) as fh:
                fh.write(content)
            action = "appended" if op.append else "wrote"
            output = f"{action} {len(content)} characters to {op.path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.COPY_FILE:
            assert isinstance(op, CopyFileOperation)
            _copy_path(op.source_path, op.destination_path, op.create_dirs, op.overwrite)
            output = f"copied {op.source_path} to {op.destination_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.MOVE_FILE:
            assert isinstance(op, MoveFileOperation)
            _move_path(op.source_path, op.destination_path, op.create_dirs, op.overwrite)
            output = f"moved {op.source_path} to {op.destination_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.DELETE_FILE:
            assert isinstance(op, DeleteFileOperation)
            if not op.path.exists():
                if op.missing_ok:
                    output = f"{op.path} did not exist"
                    self._log().node(node.node_id, output)
                    return NodeOutput(
                        node_id=node.node_id,
                        success=True,
                        output=output,
                        exit_code=0,
                        duration_seconds=time.monotonic() - start,
                    )
                raise FileNotFoundError(op.path)

            if op.use_trash:
                trash_path = _trash_path(op.path)
                output = f"moved {op.path} to trash at {trash_path}"
            else:
                _remove_path(op.path, recursive=op.recursive)
                output = f"deleted {op.path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.FILE:
            assert isinstance(op, FileOperation)
            output = str(op.path)
            self._log().node(node.node_id, f"file path: {output}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.FOLDER:
            assert isinstance(op, FolderOperation)
            output = str(op.path)
            self._log().node(node.node_id, f"folder path: {output}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.OPEN_RESOURCE:
            assert isinstance(op, OpenResourceOperation)
            target = op.target.strip()
            if not target:
                raise ValueError("Open target is required")
            resource_type = op.resource_type
            self._log().node(node.node_id, f"open {resource_type}: {target}")
            if resource_type in {"auto", "url"} and "://" in target:
                opened = webbrowser.open(target)
                if not opened:
                    raise RuntimeError(f"Could not open URL: {target}")
            elif sys.platform == "win32" and resource_type != "app":
                os.startfile(target)  # type: ignore[attr-defined]
            else:
                cmd = open_resource_args(target, resource_type, op.args)
                rc, stdout, stderr = await run_subprocess(
                    cmd,
                    cancel_event=self._cancel_event,
                    timeout=node.timeout_seconds,
                )
                self._log().node_output(node.node_id, "stdout", stdout)
                self._log().node_output(node.node_id, "stderr", stderr)
                if rc != 0:
                    return NodeOutput(
                        node_id=node.node_id,
                        success=False,
                        output=stderr or stdout,
                        exit_code=rc,
                        duration_seconds=time.monotonic() - start,
                    )
            output = f"opened {target}"
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.PROMPT_FILE:
            assert isinstance(op, PromptFileOperation)
            if op.template_path is not None:
                template = op.template_path.read_text(encoding=op.encoding)
            else:
                template = op.template
            variables = {}
            for key, value in op.variables.items():
                if "." not in value and value not in ctx.node_outputs and not value.startswith("trigger"):
                    variables[key] = value
                    continue
                try:
                    variables[key] = ctx.resolve_path(value)
                except Exception:
                    variables[key] = value
            stdin = self._resolve_pipe_stdin(node, ctx, graph)
            if stdin is not None:
                variables["_piped_input"] = stdin.decode(op.encoding)
            rendered = PromptManager._interpolate(template, variables)
            _prepare_destination(op.output_path, op.create_dirs, op.overwrite)
            op.output_path.write_text(rendered, encoding=op.encoding)
            output = f"wrote prompt file {op.output_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.COMMON_LLM_TASK:
            assert isinstance(op, CommonLlmTaskOperation)
            agent_config = self._workflow.agents.get(op.agent_id)
            if agent_config is None:
                raise ValueError(f"Agent '{op.agent_id}' not registered in workflow")
            sub = self._subscriptions.get(agent_config.subscription)
            if sub is None:
                raise ValueError(f"No subscription for '{agent_config.subscription}'")
            input_ctx = {key: ctx.resolve_path(value) for key, value in op.input_mapping.items()}
            piped_text = "\n".join(
                ctx.node_outputs[pred_id].output
                for pred_id in graph._graph.predecessors(node.node_id)
                if (pred_node := graph._nodes.get(pred_id)) is not None
                and pred_node.pipe_output
                and pred_id in ctx.node_outputs
            )
            if piped_text:
                input_ctx["_piped_input"] = piped_text
            prompt = common_llm_task_prompt(op.task, op.target, op.instructions)
            result = await Agent(agent_config, sub).run(
                input_ctx,
                cancel_event=self._cancel_event if self._pass_cancel_event else None,
                prompt_override=prompt,
            )
            self._log().node_output(node.node_id, "agent output", result.output)
            return NodeOutput(
                node_id=node.node_id,
                success=result.success,
                output=result.output,
                exit_code=result.exit_code,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.LOCAL_VECTORIZE:
            assert isinstance(op, LocalVectorizeOperation)
            target = op.source_path
            files = (
                sorted(target.rglob(op.glob) if op.recursive else target.glob(op.glob))
                if target.is_dir()
                else [target]
            )
            entries = []
            for file_path in files:
                if not file_path.is_file():
                    continue
                try:
                    text = file_path.read_text(encoding=op.encoding, errors="replace")
                except OSError as exc:
                    self._log().error(f"{node.node_id} could not read {file_path}: {exc}")
                    continue
                for index, chunk in enumerate(_chunk_text(text, op.chunk_size, op.chunk_overlap)):
                    entries.append({
                        "path": str(file_path),
                        "chunk": index,
                        "text": chunk,
                        "vector": _token_vector(chunk),
                    })
            op.index_path.parent.mkdir(parents=True, exist_ok=True)
            op.index_path.write_text(
                json.dumps({
                    "version": 1,
                    "source_path": str(op.source_path),
                    "glob": op.glob,
                    "entries": entries,
                }),
                encoding="utf-8",
            )
            output = f"indexed {len(entries)} chunks from {len(files)} files to {op.index_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.LOCAL_SEARCH:
            assert isinstance(op, LocalSearchOperation)
            index = json.loads(op.index_path.read_text(encoding="utf-8"))
            query_vector = _token_vector(op.query)
            ranked = []
            for entry in index.get("entries", []):
                score = _cosine_similarity(query_vector, entry.get("vector", {}))
                ranked.append((score, entry))
            ranked.sort(key=lambda item: item[0], reverse=True)
            results = [
                {
                    "score": round(score, 4),
                    "path": entry.get("path"),
                    "chunk": entry.get("chunk"),
                    "text": entry.get("text"),
                }
                for score, entry in ranked[: max(1, op.top_k)]
                if score > 0
            ]
            output = json.dumps(results, indent=2)
            self._log().node_output(node.node_id, "search results", output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
            )

        elif op.type == OperationType.AGENT:
            assert isinstance(op, AgentOperation)
            agent_config = self._workflow.agents.get(op.agent_id)
            if agent_config is None:
                raise ValueError(f"Agent '{op.agent_id}' not registered in workflow")
            sub = self._subscriptions.get(agent_config.subscription)
            if sub is None:
                raise ValueError(f"No subscription for '{agent_config.subscription}'")

            input_ctx: dict[str, object] = {
                k: ctx.resolve_path(v)
                for k, v in op.input_mapping.items()
            }
            piped_text = "\n".join(
                ctx.node_outputs[pred_id].output
                for pred_id in graph._graph.predecessors(node.node_id)
                if (pred_node := graph._nodes.get(pred_id)) is not None
                and pred_node.pipe_output
                and pred_id in ctx.node_outputs
            )
            if piped_text:
                input_ctx["_piped_input"] = piped_text

            if op.fan_source is not None:
                fan_items = _resolve_fan_items(op.fan_source, ctx)
                max_concurrency = op.fan_source.max_concurrency
                fail_fast = op.fan_source.fail_fast
            else:
                count = ctx.resolve_dynamic_count(op.dynamic_count)
                fan_items = [{**input_ctx, "index": str(i)} for i in range(count)]
                input_ctx = {}
                max_concurrency = 16
                fail_fast = False

            outputs: list[AgentResult] = []
            errors: list[tuple[int, BaseException]] = []
            prompt_override = f"/{op.skill_name.strip().lstrip('/')}" if op.skill_name else None
            if len(fan_items) == 1:
                agent = Agent(agent_config, sub)
                result = await agent.run(
                    {**input_ctx, **fan_items[0]},
                    cancel_event=self._cancel_event if self._pass_cancel_event else None,
                    prompt_override=prompt_override,
                )
                self._log().node_output(node.node_id, "agent output", result.output)
                outputs.append(result)
            else:
                limiter = anyio.CapacityLimiter(max_concurrency)
                results_list: list[AgentResult | None] = [None] * len(fan_items)

                async def _run_one(idx: int, item: dict[str, object]) -> None:
                    async with limiter:
                        try:
                            agent = Agent(agent_config, sub)
                            results_list[idx] = await agent.run(
                                {**input_ctx, **item},
                                cancel_event=(
                                    self._cancel_event if self._pass_cancel_event else None
                                ),
                                prompt_override=prompt_override,
                            )
                            result = results_list[idx]
                            if result is not None:
                                self._log().node_output(
                                    node.node_id,
                                    f"fan-out item {idx + 1} output",
                                    result.output,
                                )
                        except Exception as exc:  # noqa: BLE001
                            errors.append((idx, exc))
                            self._log().error(
                                f"{node.node_id} fan-out item {idx + 1} failed: {exc}"
                            )
                            if fail_fast:
                                tg.cancel_scope.cancel()

                async with anyio.create_task_group() as tg:
                    for i, item in enumerate(fan_items):
                        tg.start_soon(_run_one, i, item)

                if errors:
                    for idx, exc in errors:
                        log.warning("fan-out item %d failed: %s", idx, exc)
                outputs = [r for r in results_list if r is not None]

            combined_output = "\n".join(r.output for r in outputs)
            success = all(r.success for r in outputs) and not errors
            fan_outputs = (
                [(f"{node.node_id}-{i + 1}", r.output) for i, r in enumerate(outputs)]
                if len(outputs) > 1
                else []
            )
            return NodeOutput(
                node_id=node.node_id,
                success=success,
                output=combined_output,
                exit_code=0 if success else 1,
                duration_seconds=time.monotonic() - start,
                fan_outputs=fan_outputs,
            )

        raise ValueError(f"Unknown operation type: {op.type}")

    def _stop_requested(self) -> bool:
        return bool(
            (self._cancel_event and self._cancel_event.is_set())
            or (self._stop_file and self._stop_file.exists())
            or (self._run_stop_file and self._run_stop_file.exists())
        )

    def _failure_reason(self, outputs: dict[str, NodeOutput]) -> str:
        for node_id, output in outputs.items():
            if not output.success:
                detail = output.output.strip() or f"exit code {output.exit_code}"
                return f"node {node_id} failed: {detail}"
        return "workflow halted before all nodes completed"
