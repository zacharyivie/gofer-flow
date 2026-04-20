from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import anyio

from agentic_task_manager.core.agent import Agent, AgentResult
from agentic_task_manager.core.graph import GraphNode, WorkflowGraph
from agentic_task_manager.core.operations import (
    AgentOperation,
    BashCommandOperation,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)
from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.subscriptions.base import Subscription
from agentic_task_manager.utils.logging import get_logger
from agentic_task_manager.utils.process import run_subprocess

log = get_logger(__name__)


@dataclass
class NodeOutput:
    node_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float
    skipped: bool = False


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

            count = ctx.resolve_dynamic_count(op.dynamic_count)
            outputs: list[AgentResult] = []

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

            if count == 1:
                agent = Agent(agent_config, sub)
                result = await agent.run(input_ctx)
                outputs.append(result)
            else:
                async with anyio.create_task_group() as tg:
                    results_list: list[AgentResult | None] = [None] * count

                    async def _run_one(idx: int) -> None:
                        agent = Agent(agent_config, sub)
                        results_list[idx] = await agent.run({**input_ctx, "index": str(idx)})

                    for i in range(count):
                        tg.start_soon(_run_one, i)
                outputs = [r for r in results_list if r is not None]

            combined_output = "\n".join(r.output for r in outputs)
            success = all(r.success for r in outputs)
            return NodeOutput(
                node_id=node.node_id,
                success=success,
                output=combined_output,
                exit_code=0 if success else 1,
                duration_seconds=time.monotonic() - start,
            )

        raise ValueError(f"Unknown operation type: {op.type}")
