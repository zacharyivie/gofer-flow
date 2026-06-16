from __future__ import annotations

import tomllib
import warnings
from pathlib import Path
from typing import Any

import tomli_w as _tomli_w
from pydantic import BaseModel, TypeAdapter

from gofer.core.agent import AgentConfig
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode, WorkflowGraph
from gofer.core.operations import Operation


class ScheduleConfig(BaseModel):
    cron_expression: str
    timezone: str = "UTC"


class WorkflowConfig(BaseModel):
    id: str
    name: str
    schedule: ScheduleConfig | None = None
    max_total_node_runs: int = 1000


_op_adapter: TypeAdapter[Operation] = TypeAdapter(Operation)

_GRAPH_NODE_FIELDS = {"pipe_output", "retry_count", "retry_delay_seconds", "timeout_seconds"}


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

    def validate(self) -> None:
        self.graph.validate()

    # ── TOML serde ──────────────────────────────────────────────────────────

    @classmethod
    def from_file(cls, path: Path) -> AgenticWorkflow:
        with open(path, "rb") as fh:
            data: dict[str, Any] = tomllib.load(fh)

        wf_data = data["workflow"]
        schedule = None
        if "schedule" in wf_data:
            schedule = ScheduleConfig(**wf_data["schedule"])
        config = WorkflowConfig(
            id=wf_data["id"],
            name=wf_data["name"],
            schedule=schedule,
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
        if self.config.schedule:
            data["workflow"]["schedule"] = self.config.schedule.model_dump()
        if self.config.max_total_node_runs != 1000:
            data["workflow"]["max_total_node_runs"] = self.config.max_total_node_runs

        def _paths_to_str(obj: Any) -> Any:
            if isinstance(obj, Path):
                return str(obj)
            if isinstance(obj, dict):
                return {k: _paths_to_str(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_paths_to_str(i) for i in obj]
            return obj

        if self.agents:
            data["agents"] = {
                aid: _paths_to_str(ac.model_dump(exclude={"agent_id"}))
                for aid, ac in self.agents.items()
            }

        nodes = []
        edges = []
        for node in self.graph.nodes_in_order():
            node_dict = _paths_to_str(node.operation.model_dump(exclude_none=True))
            node_dict["id"] = node.node_id
            # Serialize GraphNode-level fields (only non-defaults to keep TOML clean)
            if node.pipe_output:
                node_dict["pipe_output"] = True
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
