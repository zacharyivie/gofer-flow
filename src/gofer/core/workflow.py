from __future__ import annotations

import re
import tomllib
import warnings
from pathlib import Path
from typing import Any, Literal

import tomli_w as _tomli_w
from pydantic import BaseModel, Field, TypeAdapter, field_validator

from gofer.core.agent import AgentConfig, agent_external_access_warnings, configured_extra_paths
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode, WorkflowGraph
from gofer.core.operations import (
    AgentOperation,
    CommonLlmTaskOperation,
    DirectoryFanSource,
    LocalVectorizeOperation,
    LoopOperation,
    Operation,
    TriggerEventsFanSource,
)
from gofer.core.resources import ResourceLimits
from gofer.core.usage import LlmUsageBudget


class ScheduleConfig(BaseModel):
    cron_expression: str
    timezone: str = "UTC"


class WatchConfig(BaseModel):
    path: Path
    glob: str = "*"
    recursive: bool = False
    debounce_seconds: float = 1.0
    mode: Literal["batch", "queue", "fanout"] = "batch"
    max_concurrency: int = 1


class WorkflowConfig(BaseModel):
    id: str
    name: str
    schedule: ScheduleConfig | None = None
    watch: WatchConfig | None = None
    resource_limits: ResourceLimits = Field(default_factory=ResourceLimits)
    llm_budget: LlmUsageBudget = Field(default_factory=LlmUsageBudget)
    run_continuously: bool = False
    max_total_node_runs: int = 1000

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_workflow_id(value)


WORKFLOW_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,127}")


def validate_workflow_id(value: str) -> str:
    if not WORKFLOW_ID_PATTERN.fullmatch(value):
        raise ValueError(
            "Workflow id must match [a-z0-9][a-z0-9-]{0,127}"
        )
    return value


_op_adapter: TypeAdapter[Operation] = TypeAdapter(Operation)

_GRAPH_NODE_FIELDS = {
    "allow_failure",
    "await_all_inputs",
    "inputs",
    "label",
    "pipe_output",
    "retry_count",
    "retry_delay_seconds",
    "timeout_seconds",
}


def _count_paths_until(paths: Any, limit: int) -> int:
    count = 0
    for path in paths:
        if Path(path).is_file():
            count += 1
            if count >= limit:
                break
    return count


def _resolve_config_path(path: Path, path_base: Path | None) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute() or path_base is None:
        return expanded
    return path_base / expanded


class AgenticWorkflow:
    def __init__(self, config: WorkflowConfig) -> None:
        self.config = config
        self.graph = WorkflowGraph()
        self.agents: dict[str, AgentConfig] = {}

    # ── fluent builder ──────────────────────────────────────────────────────

    def add_operation(self, node: GraphNode) -> AgenticWorkflow:
        self.graph.add_node(node)
        return self

    def then(self, from_id: str, to_id: str, config: EdgeConfig | None = None) -> AgenticWorkflow:
        self.graph.add_edge(from_id, to_id, config)
        return self

    def register_agent(self, config: AgentConfig) -> AgenticWorkflow:
        self.agents[config.agent_id] = config
        return self

    def validate(self, workflow_path: Path | None = None) -> None:
        path_base = workflow_path.parent if workflow_path is not None else None
        self.graph.validate()
        for agent in self.agents.values():
            configured_extra_paths(agent, path_base)
        for warning in self.resource_warnings(path_base):
            warnings.warn(warning, UserWarning, stacklevel=2)

    def resource_warnings(self, path_base: Path | None = None) -> list[str]:
        warnings_: list[str] = []
        limits = self.config.resource_limits
        warned_agents: set[str] = set()
        for graph_node in self.graph.nodes_in_order():
            op = graph_node.operation
            if not isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
                continue
            agent = self.agents.get(op.agent_id)
            if agent is None:
                continue
            warned_agents.add(op.agent_id)
            effective_agent = agent.model_copy(update={"working_dir": op.working_dir})
            warnings_.extend(agent_external_access_warnings(effective_agent, path_base))
        for agent_id, agent in sorted(self.agents.items()):
            if agent_id not in warned_agents:
                warnings_.extend(agent_external_access_warnings(agent, path_base))
        for graph_node in self.graph.nodes_in_order():
            op = graph_node.operation
            if isinstance(op, LoopOperation):
                source = op.source
                if isinstance(source, DirectoryFanSource):
                    source_path = _resolve_config_path(source.path, path_base)
                    if source.include_content:
                        warnings_.append(
                            f"Node '{graph_node.node_id}' directory fan-out includes file "
                            f"content; limits apply: max_fanout_items={limits.max_fanout_items}, "
                            f"max_file_read_bytes={limits.max_file_read_bytes}, "
                            f"max_aggregate_read_bytes={limits.max_aggregate_read_bytes}"
                        )
                    if source_path.exists() and source_path.is_dir():
                        scanned = _count_paths_until(
                            source_path.glob(source.glob),
                            limits.max_fanout_items + 1,
                        )
                        if scanned > limits.max_fanout_items:
                            warnings_.append(
                                f"Node '{graph_node.node_id}' directory fan-out may exceed "
                                f"max_fanout_items={limits.max_fanout_items}"
                            )
                elif isinstance(source, TriggerEventsFanSource) and source.include_content:
                    warnings_.append(
                        f"Node '{graph_node.node_id}' trigger-event fan-out includes changed "
                        f"file content; limits apply: max_fanout_items={limits.max_fanout_items}, "
                        f"max_file_read_bytes={limits.max_file_read_bytes}, "
                        f"max_aggregate_read_bytes={limits.max_aggregate_read_bytes}"
                    )
            elif isinstance(op, LocalVectorizeOperation):
                source_path = _resolve_config_path(op.source_path, path_base)
                warnings_.append(
                    f"Node '{graph_node.node_id}' local_vectorize scans local files; "
                    f"limits apply: max_files_scanned={limits.max_files_scanned}, "
                    f"max_file_read_bytes={limits.max_file_read_bytes}, "
                    f"max_aggregate_read_bytes={limits.max_aggregate_read_bytes}, "
                    f"max_vector_index_bytes={limits.max_vector_index_bytes}"
                )
                if source_path.exists() and source_path.is_dir():
                    iterator = (
                        source_path.rglob(op.glob)
                        if op.recursive
                        else source_path.glob(op.glob)
                    )
                    scanned = _count_paths_until(iterator, limits.max_files_scanned + 1)
                    if scanned > limits.max_files_scanned:
                        warnings_.append(
                            f"Node '{graph_node.node_id}' local_vectorize may exceed "
                            f"max_files_scanned={limits.max_files_scanned}"
                        )
        if self.config.watch is not None:
            warnings_.append(
                f"Workflow watch queue is bounded: "
                f"max_watcher_queue_depth={limits.max_watcher_queue_depth}; "
                "oldest queued event batches are dropped on overflow"
            )
            if self.config.watch.max_concurrency > limits.max_watcher_concurrency:
                warnings_.append(
                    f"Workflow watch max_concurrency={self.config.watch.max_concurrency} "
                    f"will be capped by global max_watcher_concurrency="
                    f"{limits.max_watcher_concurrency}"
                )
        return warnings_

    # ── TOML serde ──────────────────────────────────────────────────────────

    @classmethod
    def from_file(cls, path: Path) -> AgenticWorkflow:
        with open(path, "rb") as fh:
            data: dict[str, Any] = tomllib.load(fh)
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgenticWorkflow:
        wf_data = data["workflow"]
        schedule = None
        if "schedule" in wf_data:
            schedule = ScheduleConfig(**wf_data["schedule"])
        watch = None
        if "watch" in wf_data:
            watch = WatchConfig(**wf_data["watch"])
        config = WorkflowConfig(
            id=wf_data["id"],
            name=wf_data["name"],
            schedule=schedule,
            watch=watch,
            resource_limits=ResourceLimits(**wf_data.get("resource_limits", {})),
            llm_budget=LlmUsageBudget(**wf_data.get("llm_budget", {})),
            run_continuously=bool(wf_data.get("run_continuously", False)),
            max_total_node_runs=wf_data.get("max_total_node_runs", 1000),
        )
        workflow = cls(config)

        for agent_id, agent_data in data.get("agents", {}).items():
            workflow.register_agent(AgentConfig(agent_id=agent_id, **agent_data))

        # Track deprecated on_failure values keyed by node_id
        legacy_on_failure: dict[str, str] = {}

        for node_data in data.get("nodes", []):
            node_data = dict(node_data)
            node_id = node_data.pop("id")

            # Extract GraphNode-level fields before passing to operation adapter
            node_kwargs: dict[str, Any] = {}
            for f in _GRAPH_NODE_FIELDS:
                if f in node_data:
                    node_kwargs[f] = node_data.pop(f)

            # Backwards compat: on_failure → conditional edges (synthesized below)
            if "on_failure" in node_data:
                warnings.warn(
                    f"Node '{node_id}': 'on_failure' is deprecated; use conditional edges instead.",
                    DeprecationWarning,
                    stacklevel=2,
                )
                legacy_on_failure[node_id] = node_data.pop("on_failure")

            op = _op_adapter.validate_python(node_data)
            workflow.add_operation(GraphNode(node_id=node_id, operation=op, **node_kwargs))

        for edge in data.get("edges", []):
            condition_str = edge.get("condition", "always")
            condition = EdgeConditionType(condition_str)
            edge_config = EdgeConfig(
                from_node=edge["from"],
                to_node=edge["to"],
                condition=condition,
                output_pattern=edge.get("output_pattern"),
            )
            workflow.then(edge["from"], edge["to"], edge_config)

        # Synthesize edge conditions from legacy on_failure
        for node_id, on_failure in legacy_on_failure.items():
            for succ_id in workflow.graph._graph.successors(node_id):
                if on_failure == "halt":
                    # Only proceed on success; failure halts via executor default
                    synthesized = EdgeConfig(
                        from_node=node_id,
                        to_node=succ_id,
                        condition=EdgeConditionType.ON_SUCCESS,
                    )
                else:
                    # skip/continue → always traverse
                    synthesized = EdgeConfig(
                        from_node=node_id,
                        to_node=succ_id,
                        condition=EdgeConditionType.ALWAYS,
                    )
                workflow.graph._edges[(node_id, succ_id)] = synthesized

        return workflow

    def to_file(self, path: Path) -> None:
        data: dict[str, Any] = {
            "workflow": {
                "id": self.config.id,
                "name": self.config.name,
            }
        }
        def _paths_to_str(obj: Any) -> Any:
            if isinstance(obj, Path):
                return str(obj)
            if isinstance(obj, dict):
                return {k: _paths_to_str(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_paths_to_str(i) for i in obj]
            return obj

        if self.config.schedule:
            data["workflow"]["schedule"] = self.config.schedule.model_dump()
        if self.config.watch:
            data["workflow"]["watch"] = _paths_to_str(self.config.watch.model_dump())
        if self.config.resource_limits != ResourceLimits():
            data["workflow"]["resource_limits"] = self.config.resource_limits.model_dump()
        if self.config.llm_budget.enabled():
            data["workflow"]["llm_budget"] = self.config.llm_budget.model_dump(
                exclude_none=True
            )
        if self.config.run_continuously:
            data["workflow"]["run_continuously"] = True
        if self.config.max_total_node_runs != 1000:
            data["workflow"]["max_total_node_runs"] = self.config.max_total_node_runs

        if self.agents:
            data["agents"] = {
                aid: _paths_to_str(
                    ac.model_dump(
                        exclude={"agent_id"},
                        exclude_defaults=True,
                        exclude_none=True,
                    )
                )
                for aid, ac in self.agents.items()
            }

        nodes = []
        edges = []
        for node in self.graph.nodes_in_order():
            node_dict = _paths_to_str(
                node.operation.model_dump(
                    exclude_defaults=True,
                    exclude_none=True,
                    by_alias=True,
                )
            )
            node_dict["id"] = node.node_id
            # Serialize GraphNode-level fields (only non-defaults to keep TOML clean)
            if node.label:
                node_dict["label"] = node.label
            if node.inputs:
                node_dict["inputs"] = node.inputs
            if node.pipe_output:
                node_dict["pipe_output"] = True
            if node.allow_failure:
                node_dict["allow_failure"] = True
            if not node.await_all_inputs:
                node_dict["await_all_inputs"] = False
            if node.retry_count:
                node_dict["retry_count"] = node.retry_count
            if node.retry_delay_seconds != 1.0:
                node_dict["retry_delay_seconds"] = node.retry_delay_seconds
            if node.timeout_seconds is not None:
                node_dict["timeout_seconds"] = node.timeout_seconds
            nodes.append(node_dict)

        data["nodes"] = nodes

        for u, v in self.graph._graph.edges():
            edge_cfg = self.graph.get_edge_config(u, v)
            edge_dict: dict[str, Any] = {"from": u, "to": v}
            if edge_cfg.condition != EdgeConditionType.ALWAYS:
                edge_dict["condition"] = edge_cfg.condition.value
            if edge_cfg.output_pattern is not None:
                edge_dict["output_pattern"] = edge_cfg.output_pattern
            edges.append(edge_dict)

        if edges:
            data["edges"] = edges

        path.write_bytes(_tomli_w.dumps(data).encode())
