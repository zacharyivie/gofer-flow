from __future__ import annotations

import csv
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import anyio

from gofer.core.agent import Agent, AgentResult
from gofer.core.graph import GraphNode, WorkflowGraph
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CountFanSource,
    DirectoryFanSource,
    FanSource,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
    TabularFanSource,
)
from gofer.core.workflow import AgenticWorkflow
from gofer.subscriptions.base import Subscription
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess

log = get_logger(__name__)


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
    log_path: Path | None = None


class WorkflowRunLog:
    def __init__(self, workflow_id: str, base_dir: Path | None = None) -> None:
        self.workflow_id = workflow_id
        self.started_at = datetime.now().astimezone()
        timestamp = self.started_at.strftime("%Y-%m-%dT%H-%M-%S%z")
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
    ) -> None:
        self._workflow = workflow
        self._subscriptions = subscriptions
        self._dry_run = dry_run
        self._log_base_dir = log_base_dir
        self._run_log: WorkflowRunLog | None = None

    def _log(self) -> WorkflowRunLog:
        if self._run_log is None:
            raise RuntimeError("Workflow run log has not been initialized")
        return self._run_log

    async def run(self) -> ExecutionResult:
        self._run_log = WorkflowRunLog(self._workflow.config.id, self._log_base_dir)
        run_log = self._log()
        ctx = ExecutionContext()
        graph = self._workflow.graph
        start = time.monotonic()
        halted = False
        skipped_nodes: set[str] = set()
        try:
            run_log.info(f"dry_run={self._dry_run}")

            for generation in graph.topological_generations():
                if halted:
                    break
                gen_results: dict[str, NodeOutput] = {}
                halt_flag: list[bool] = [False]

                async with anyio.create_task_group() as tg:
                    for node in generation:
                        if self._should_skip(node, ctx, skipped_nodes, graph):
                            skipped_nodes.add(node.node_id)
                            run_log.node(node.node_id, "skipped")
                            gen_results[node.node_id] = NodeOutput(
                                node_id=node.node_id,
                                success=True,
                                output="",
                                exit_code=0,
                                duration_seconds=0.0,
                                skipped=True,
                            )
                        else:
                            tg.start_soon(
                                self._run_node, node, ctx, gen_results, halt_flag, graph
                            )

                ctx.node_outputs.update(gen_results)
                if halt_flag[0]:
                    halted = True

            total = time.monotonic() - start
            success = all(o.success for o in ctx.node_outputs.values() if not o.skipped)
            reason = None if success else self._failure_reason(ctx.node_outputs)
            run_log.complete(success, reason)
            return ExecutionResult(
                workflow_id=self._workflow.config.id,
                success=success,
                node_outputs=ctx.node_outputs,
                duration_seconds=total,
                log_path=run_log.path,
            )
        except BaseException as exc:
            run_log.complete(False, str(exc))
            raise

    def _should_skip(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        skipped_nodes: set[str],
        graph: WorkflowGraph,
    ) -> bool:
        for pred_id in graph._graph.predecessors(node.node_id):
            if pred_id in skipped_nodes:
                return True
            pred_output = ctx.node_outputs.get(pred_id)
            if pred_output is None:
                continue
            edge = graph.get_edge_config(pred_id, node.node_id)
            if not edge.evaluate(pred_output):
                return True
        return False

    async def _run_node(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        results: dict[str, NodeOutput],
        halt_flag: list[bool],
        graph: WorkflowGraph,
    ) -> None:
        if self._dry_run:
            log.info("[dry-run] would execute node %s", node.node_id)
            self._log().node(node.node_id, "dry-run would execute")
            results[node.node_id] = NodeOutput(
                node_id=node.node_id, success=True, output="", exit_code=0, duration_seconds=0.0
            )
            return

        attempt = 0
        output: NodeOutput | None = None
        while True:
            self._log().node(node.node_id, f"attempt {attempt + 1} started")
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
                f"attempt {attempt + 1} finished success={output.success} "
                f"exit_code={output.exit_code} duration={output.duration_seconds:.2f}s",
            )
            if output.success or attempt >= node.retry_count:
                break
            attempt += 1
            self._log().node(
                node.node_id, f"retrying after {node.retry_delay_seconds:.2f}s"
            )
            await anyio.sleep(node.retry_delay_seconds)

        if output is not None and not output.success:
            if node.on_failure == "halt":
                halt_flag[0] = True

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
            self._log().node(node.node_id, f"command: {op.command}")
            rc, stdout, stderr = await run_subprocess(
                ["bash", "-c", op.command],
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
                cmd, env=op.env or None, timeout=node.timeout_seconds, stdin=stdin
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

        elif op.type == OperationType.AGENT:
            assert isinstance(op, AgentOperation)
            agent_config = self._workflow.agents.get(op.agent_id)
            if agent_config is None:
                raise ValueError(f"Agent '{op.agent_id}' not registered in workflow")
            sub = self._subscriptions.get(agent_config.subscription)
            if sub is None:
                raise ValueError(f"No subscription for '{agent_config.subscription}'")

            input_ctx: dict[str, object] = {
                k: (ctx.node_outputs[v].output if v in ctx.node_outputs else "")
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
            if len(fan_items) == 1:
                agent = Agent(agent_config, sub)
                result = await agent.run({**input_ctx, **fan_items[0]})
                self._log().node_output(node.node_id, "agent output", result.output)
                outputs.append(result)
            else:
                limiter = anyio.CapacityLimiter(max_concurrency)
                results_list: list[AgentResult | None] = [None] * len(fan_items)

                async def _run_one(idx: int, item: dict[str, object]) -> None:
                    async with limiter:
                        try:
                            agent = Agent(agent_config, sub)
                            results_list[idx] = await agent.run({**input_ctx, **item})
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

    def _failure_reason(self, outputs: dict[str, NodeOutput]) -> str:
        for node_id, output in outputs.items():
            if not output.success:
                detail = output.output.strip() or f"exit code {output.exit_code}"
                return f"node {node_id} failed: {detail}"
        return "workflow halted before all nodes completed"
