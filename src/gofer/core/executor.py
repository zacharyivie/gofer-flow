from __future__ import annotations

import csv
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio

from legacy.gofer.core.agent import Agent, AgentResult
from legacy.gofer.core.graph import GraphNode, WorkflowGraph
from legacy.gofer.core.operations import (
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
from legacy.gofer.core.workflow import AgenticWorkflow
from legacy.gofer.subscriptions.base import Subscription
from legacy.gofer.utils.logging import get_logger
from legacy.gofer.utils.process import run_subprocess

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


class WorkflowExecutor:
    def __init__(
        self,
        workflow: AgenticWorkflow,
        subscriptions: dict[str, Subscription],
        dry_run: bool = False,
    ) -> None:
        self._workflow = workflow
        self._subscriptions = subscriptions
        self._dry_run = dry_run

    async def run(self) -> ExecutionResult:
        ctx = ExecutionContext()
        graph = self._workflow.graph
        start = time.monotonic()
        halted = False
        skipped_nodes: set[str] = set()

        for generation in graph.topological_generations():
            if halted:
                break
            gen_results: dict[str, NodeOutput] = {}
            halt_flag: list[bool] = [False]

            async with anyio.create_task_group() as tg:
                for node in generation:
                    if self._should_skip(node, ctx, skipped_nodes, graph):
                        skipped_nodes.add(node.node_id)
                        gen_results[node.node_id] = NodeOutput(
                            node_id=node.node_id,
                            success=True,
                            output="",
                            exit_code=0,
                            duration_seconds=0.0,
                            skipped=True,
                        )
                    else:
                        tg.start_soon(self._run_node, node, ctx, gen_results, halt_flag, graph)

            ctx.node_outputs.update(gen_results)
            if halt_flag[0]:
                halted = True

        total = time.monotonic() - start
        success = all(o.success for o in ctx.node_outputs.values() if not o.skipped)
        return ExecutionResult(
            workflow_id=self._workflow.config.id,
            success=success,
            node_outputs=ctx.node_outputs,
            duration_seconds=total,
        )

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
            results[node.node_id] = NodeOutput(
                node_id=node.node_id, success=True, output="", exit_code=0, duration_seconds=0.0
            )
            return

        attempt = 0
        output: NodeOutput | None = None
        while True:
            output = await self._execute_operation(node, ctx, graph)
            results[node.node_id] = output
            if output.success or attempt >= node.retry_count:
                break
            attempt += 1
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
            rc, stdout, stderr = await run_subprocess(
                ["bash", "-c", op.command],
                cwd=op.working_dir,
                env=op.env or None,
                timeout=node.timeout_seconds,
                stdin=stdin,
            )
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
            rc, stdout, stderr = await run_subprocess(
                cmd, env=op.env or None, timeout=node.timeout_seconds, stdin=stdin
            )
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
                outputs.append(result)
            else:
                limiter = anyio.CapacityLimiter(max_concurrency)
                results_list: list[AgentResult | None] = [None] * len(fan_items)

                async def _run_one(idx: int, item: dict[str, object]) -> None:
                    async with limiter:
                        try:
                            agent = Agent(agent_config, sub)
                            results_list[idx] = await agent.run({**input_ctx, **item})
                        except Exception as exc:  # noqa: BLE001
                            errors.append((idx, exc))
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
