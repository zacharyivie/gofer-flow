from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import anyio

from agentic_task_manager.core.agent import Agent, AgentResult
from agentic_task_manager.core.graph import GraphNode
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
        start = time.monotonic()
        halted = False

        for generation in self._workflow.graph.topological_generations():
            if halted:
                break
            gen_results: dict[str, NodeOutput] = {}
            halt_flag: list[bool] = [False]

            async with anyio.create_task_group() as tg:
                for node in generation:
                    tg.start_soon(self._run_node, node, ctx, gen_results, halt_flag)

            ctx.node_outputs.update(gen_results)
            if halt_flag[0]:
                halted = True

        total = time.monotonic() - start
        success = all(o.success for o in ctx.node_outputs.values())
        return ExecutionResult(
            workflow_id=self._workflow.config.id,
            success=success,
            node_outputs=ctx.node_outputs,
            duration_seconds=total,
        )

    async def _run_node(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        results: dict[str, NodeOutput],
        halt_flag: list[bool],
    ) -> None:
        if self._dry_run:
            log.info("[dry-run] would execute node %s", node.node_id)
            results[node.node_id] = NodeOutput(
                node_id=node.node_id, success=True, output="", exit_code=0, duration_seconds=0.0
            )
            return

        attempt = 0
        while True:
            output = await self._execute_operation(node, ctx)
            results[node.node_id] = output
            if output.success or attempt >= node.retry_count:
                break
            attempt += 1
            await anyio.sleep(node.retry_delay_seconds)

        if not output.success:
            if node.on_failure == "halt":
                halt_flag[0] = True
            elif node.on_failure == "skip":
                pass  # already recorded, continue
            # "continue" same as skip for now

    async def _execute_operation(self, node: GraphNode, ctx: ExecutionContext) -> NodeOutput:
        op = node.operation
        start = time.monotonic()

        if op.type == OperationType.BASH_COMMAND:
            assert isinstance(op, BashCommandOperation)
            rc, stdout, stderr = await run_subprocess(
                ["bash", "-c", op.command],
                cwd=op.working_dir,
                env=op.env or None,
                timeout=node.timeout_seconds,
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
            rc, stdout, stderr = await run_subprocess(
                cmd, env=op.env or None, timeout=node.timeout_seconds
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

            if count == 1:
                agent = Agent(agent_config, sub)
                result = await agent.run(
                    {k: str(ctx.node_outputs.get(v, "")) for k, v in op.input_mapping.items()}
                )
                outputs.append(result)
            else:
                async with anyio.create_task_group() as tg:
                    results_list: list[AgentResult | None] = [None] * count

                    async def _run_one(idx: int) -> None:
                        agent = Agent(agent_config, sub)
                        results_list[idx] = await agent.run({"index": str(idx)})

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
