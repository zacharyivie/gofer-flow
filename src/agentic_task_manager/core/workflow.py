from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, TypeAdapter

from agentic_task_manager.core.agent import AgentConfig
from agentic_task_manager.core.graph import GraphNode, WorkflowGraph
from agentic_task_manager.core.operations import Operation

try:
    import tomli_w as _tomli_w  # optional write dependency
except ImportError:
    _tomli_w = None  # type: ignore[assignment]


class ScheduleConfig(BaseModel):
    cron_expression: str
    timezone: str = "UTC"


class WorkflowConfig(BaseModel):
    id: str
    name: str
    schedule: ScheduleConfig | None = None


_op_adapter: TypeAdapter[Operation] = TypeAdapter(Operation)


class AgenticWorkflow:
    def __init__(self, config: WorkflowConfig) -> None:
        self.config = config
        self.graph = WorkflowGraph()
        self.agents: dict[str, AgentConfig] = {}

    # ── fluent builder ──────────────────────────────────────────────────────

    def add_operation(self, node: GraphNode) -> AgenticWorkflow:
        self.graph.add_node(node)
        return self

    def then(self, from_id: str, to_id: str) -> AgenticWorkflow:
        self.graph.add_edge(from_id, to_id)
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
        config = WorkflowConfig(id=wf_data["id"], name=wf_data["name"], schedule=schedule)
        workflow = cls(config)

        for agent_id, agent_data in data.get("agents", {}).items():
            workflow.register_agent(
                AgentConfig(agent_id=agent_id, **agent_data)
            )

        for node_data in data.get("nodes", []):
            node_data = dict(node_data)
            node_id = node_data.pop("id")
            op = _op_adapter.validate_python(node_data)
            workflow.add_operation(GraphNode(node_id=node_id, operation=op))

        for edge in data.get("edges", []):
            workflow.then(edge["from"], edge["to"])

        return workflow

    def to_file(self, path: Path) -> None:
        if _tomli_w is None:
            raise RuntimeError("tomli-w is required for serialisation: pip install tomli-w")

        data: dict[str, Any] = {
            "workflow": {
                "id": self.config.id,
                "name": self.config.name,
            }
        }
        if self.config.schedule:
            data["workflow"]["schedule"] = self.config.schedule.model_dump()

        if self.agents:
            data["agents"] = {
                aid: {
                    k: str(v) if isinstance(v, Path) else v
                    for k, v in ac.model_dump(exclude={"agent_id"}).items()
                }
                for aid, ac in self.agents.items()
            }

        nodes = []
        edges = []
        for gen in self.graph.topological_generations():
            for node in gen:
                node_dict = node.operation.model_dump()
                node_dict["id"] = node.node_id
                nodes.append(node_dict)

        data["nodes"] = nodes

        # Rebuild edges from graph internals
        for u, v in self.graph._graph.edges():
            edges.append({"from": u, "to": v})
        if edges:
            data["edges"] = edges

        path.write_bytes(_tomli_w.dumps(data).encode())
