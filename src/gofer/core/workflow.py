from __future__ import annotations

import re
import tomllib
import warnings
from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Literal

import tomli_w as _tomli_w
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

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
from gofer.core.provider_profiles import (
    resolve_provider_settings,
    unresolved_provider_secret_refs,
    validate_provider_settings,
)
from gofer.core.resources import ResourceLimits
from gofer.core.usage import LlmUsageBudget


class ScheduleConfig(BaseModel):
    cron_expression: str
    timezone: str = "UTC"
    params: dict[str, Any] = Field(default_factory=dict)


class WatchConfig(BaseModel):
    path: Path
    glob: str = "*"
    recursive: bool = False
    debounce_seconds: float = 1.0
    mode: Literal["batch", "queue", "fanout"] = "batch"
    max_concurrency: int = 1
    params: dict[str, Any] = Field(default_factory=dict)


ParameterType = Literal[
    "string",
    "text",
    "multiline",
    "number",
    "boolean",
    "date",
    "time",
    "datetime",
    "file",
    "folder",
    "enum",
    "secret",
]


PARAMETER_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class WorkflowParameterConfig(BaseModel):
    type: ParameterType = "string"
    label: str | None = None
    description: str | None = None
    required: bool = False
    default: Any = None
    choices: list[Any] = Field(default_factory=list)
    min: float | None = None
    max: float | None = None
    min_length: int | None = None
    max_length: int | None = None
    pattern: str | None = None

    @model_validator(mode="after")
    def _validate_schema(self) -> WorkflowParameterConfig:
        if self.type == "enum" and not self.choices:
            raise ValueError("enum parameters require choices")
        if self.pattern:
            re.compile(self.pattern)
        return self


class WebhookTriggerConfig(BaseModel):
    id: str
    enabled: bool = False
    token: str | None = None
    token_env: str | None = None
    allow_unauthenticated: bool = False
    payload_schema: dict[str, Any] = Field(default_factory=dict)
    fanout_path: str | None = None
    source: str = "webhook"
    concurrency_policy: Literal["allow", "reject_if_running"] = "allow"
    sensitive_payload_fields: list[str] = Field(default_factory=list)
    store_raw_payload: bool = False

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_workflow_id(value)

    @property
    def has_authentication(self) -> bool:
        return bool(self.token or self.token_env)

    @property
    def requires_unauthenticated_warning(self) -> bool:
        return self.enabled and self.allow_unauthenticated and not self.has_authentication

    @property
    def missing_authentication(self) -> bool:
        return self.enabled and not self.has_authentication and not self.allow_unauthenticated


class FilesystemAccessEntry(BaseModel):
    path: Path
    read: bool = True
    write: bool = True
    execute: bool = False


class WorkflowCanvasGroup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    label: str
    color: str = "#0f766e"
    node_ids: list[str] = Field(default_factory=list, alias="nodeIds")
    x: int = 0
    y: int = 0
    width: int = 360
    height: int = 240
    collapsed: bool = False

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
            raise ValueError("Canvas group id must contain only letters, numbers, ., :, _, or -")
        return value

    @field_validator("color")
    @classmethod
    def _validate_color(cls, value: str) -> str:
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            raise ValueError("Canvas group color must be a #RRGGBB value")
        return value

    @field_validator("width", "height")
    @classmethod
    def _validate_size(cls, value: int) -> int:
        if value < 80:
            raise ValueError("Canvas group width and height must be at least 80")
        return value


class WorkflowCanvasMetadata(BaseModel):
    groups: list[WorkflowCanvasGroup] = Field(default_factory=list)


class WorkflowMetadata(BaseModel):
    canvas: WorkflowCanvasMetadata = Field(default_factory=WorkflowCanvasMetadata)


class WorkflowConfig(BaseModel):
    id: str
    name: str
    schedule: ScheduleConfig | None = None
    watch: WatchConfig | None = None
    webhooks: dict[str, WebhookTriggerConfig] = Field(default_factory=dict)
    parameters: dict[str, WorkflowParameterConfig] = Field(default_factory=dict)
    resource_limits: ResourceLimits = Field(default_factory=ResourceLimits)
    llm_budget: LlmUsageBudget = Field(default_factory=LlmUsageBudget)
    run_continuously: bool = False
    max_total_node_runs: int = 1000
    filesystem_access: list[FilesystemAccessEntry] = Field(default_factory=list)
    metadata: WorkflowMetadata = Field(default_factory=WorkflowMetadata)

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_workflow_id(value)

    @field_validator("parameters")
    @classmethod
    def _validate_parameter_names(
        cls,
        value: dict[str, WorkflowParameterConfig],
    ) -> dict[str, WorkflowParameterConfig]:
        for name in value:
            if not PARAMETER_NAME_PATTERN.fullmatch(name):
                raise ValueError(
                    f"Parameter name {name!r} must match [A-Za-z_][A-Za-z0-9_]*"
                )
        return value


WORKFLOW_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,127}")


def validate_workflow_id(value: str) -> str:
    if not WORKFLOW_ID_PATTERN.fullmatch(value):
        raise ValueError(
            "Workflow id must match [a-z0-9][a-z0-9-]{0,127}"
        )
    return value


def resolve_workflow_parameters(
    config: WorkflowConfig,
    provided: dict[str, Any] | None = None,
    defaults: dict[str, Any] | None = None,
    *,
    allow_missing_required: bool = False,
) -> dict[str, Any]:
    values: dict[str, Any] = {}
    provided = provided or {}
    defaults = defaults or {}
    unknown = sorted(set(provided) - set(config.parameters))
    if unknown:
        raise ValueError(f"Unknown workflow parameter(s): {', '.join(unknown)}")
    for name, parameter in config.parameters.items():
        if name in provided:
            raw = provided[name]
        elif name in defaults:
            raw = defaults[name]
        else:
            raw = parameter.default
        if raw is None or raw == "":
            if parameter.required:
                if allow_missing_required:
                    continue
                raise ValueError(f"Missing required workflow parameter: {name}")
            if raw == "" and parameter.type in {"string", "text", "multiline"}:
                values[name] = ""
            continue
        values[name] = _coerce_parameter_value(name, parameter, raw)
    return values


def masked_workflow_parameters(
    config: WorkflowConfig,
    params: dict[str, Any],
) -> dict[str, Any]:
    return {
        name: "***"
        if config.parameters.get(name) and config.parameters[name].type == "secret"
        else value
        for name, value in params.items()
    }


def _coerce_parameter_value(
    name: str,
    parameter: WorkflowParameterConfig,
    value: Any,
) -> Any:
    try:
        match parameter.type:
            case "boolean":
                if isinstance(value, bool):
                    coerced: Any = value
                elif isinstance(value, str) and value.lower() in {"true", "1", "yes", "y", "on"}:
                    coerced = True
                elif isinstance(value, str) and value.lower() in {"false", "0", "no", "n", "off"}:
                    coerced = False
                else:
                    raise ValueError
            case "number":
                coerced = float(value)
                if isinstance(value, int) and not isinstance(value, bool):
                    coerced = value
            case "date":
                coerced = (
                    value.isoformat()
                    if isinstance(value, date)
                    else date.fromisoformat(str(value)).isoformat()
                )
            case "time":
                coerced = (
                    value.isoformat()
                    if isinstance(value, time)
                    else time.fromisoformat(str(value)).isoformat()
                )
            case "datetime":
                coerced = (
                    value.isoformat()
                    if isinstance(value, datetime)
                    else datetime.fromisoformat(str(value)).isoformat()
                )
            case "file" | "folder" | "string" | "text" | "multiline" | "secret":
                coerced = str(value)
            case "enum":
                coerced = value
            case _:
                coerced = value
    except ValueError as exc:
        raise ValueError(
            f"Workflow parameter '{name}' must be a valid {parameter.type}"
        ) from exc
    if parameter.type == "enum" and coerced not in parameter.choices:
        choices = ", ".join(str(choice) for choice in parameter.choices)
        raise ValueError(f"Workflow parameter '{name}' must be one of: {choices}")
    if parameter.type in {"string", "text", "multiline", "file", "folder", "secret"}:
        text = str(coerced)
        if parameter.min_length is not None and len(text) < parameter.min_length:
            raise ValueError(f"Workflow parameter '{name}' is shorter than {parameter.min_length}")
        if parameter.max_length is not None and len(text) > parameter.max_length:
            raise ValueError(f"Workflow parameter '{name}' is longer than {parameter.max_length}")
        if parameter.pattern and re.search(parameter.pattern, text) is None:
            raise ValueError(f"Workflow parameter '{name}' does not match required pattern")
    if parameter.type == "number":
        number = float(coerced)
        if parameter.min is not None and number < parameter.min:
            raise ValueError(f"Workflow parameter '{name}' must be >= {parameter.min}")
        if parameter.max is not None and number > parameter.max:
            raise ValueError(f"Workflow parameter '{name}' must be <= {parameter.max}")
    return coerced


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

    def validate(
        self,
        workflow_path: Path | None = None,
        data_dir: Path | None = None,
    ) -> None:
        path_base = workflow_path.parent if workflow_path is not None else None
        profile_data_dir = data_dir if data_dir is not None else path_base
        self.graph.validate()
        for agent in self.agents.values():
            configured_extra_paths(agent, path_base)
        for node in self.graph.nodes_in_order():
            op = node.operation
            if isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
                provider_agent = self.agents.get(op.agent_id)
                if provider_agent is not None:
                    settings = resolve_provider_settings(
                        agent_subscription=provider_agent.subscription,
                        profile_name=provider_agent.profile,
                        agent_model=provider_agent.model,
                        operation_profile=op.profile,
                        operation_model=op.model,
                        operation_timeout=op.timeout,
                        data_dir=profile_data_dir,
                    )
                    validate_provider_settings(settings)
                    missing_secrets = unresolved_provider_secret_refs(settings)
                    if missing_secrets:
                        names = ", ".join(missing_secrets)
                        profile = (
                            f" '{settings.profile_name}'"
                            if settings.profile_name
                            else ""
                        )
                        raise ValueError(
                            f"Provider profile{profile} has missing secret "
                            f"reference(s): {names}"
                        )
        node_ids = {node.node_id for node in self.graph.nodes_in_order()}
        for group in self.config.metadata.canvas.groups:
            unknown = sorted(set(group.node_ids) - node_ids)
            if unknown:
                raise ValueError(
                    f"Canvas group '{group.id}' references unknown node(s): "
                    f"{', '.join(unknown)}"
                )
        missing_auth_webhooks = [
            trigger_id
            for trigger_id, trigger in sorted(self.config.webhooks.items())
            if trigger.missing_authentication
        ]
        if missing_auth_webhooks:
            raise ValueError(
                "Enabled webhook trigger(s) missing authentication: "
                + ", ".join(missing_auth_webhooks)
                + ". Set token_env, token, or allow_unauthenticated = true."
            )
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
        webhooks = {
            str(trigger_id): WebhookTriggerConfig(id=str(trigger_id), **trigger_data)
            for trigger_id, trigger_data in wf_data.get("webhooks", {}).items()
            if isinstance(trigger_data, dict)
        }
        config = WorkflowConfig(
            id=wf_data["id"],
            name=wf_data["name"],
            schedule=schedule,
            watch=watch,
            webhooks=webhooks,
            parameters={
                str(name): WorkflowParameterConfig(**param_data)
                for name, param_data in wf_data.get("parameters", {}).items()
                if isinstance(param_data, dict)
            },
            resource_limits=ResourceLimits(**wf_data.get("resource_limits", {})),
            llm_budget=LlmUsageBudget(**wf_data.get("llm_budget", {})),
            run_continuously=bool(wf_data.get("run_continuously", False)),
            max_total_node_runs=wf_data.get("max_total_node_runs", 1000),
            filesystem_access=[
                FilesystemAccessEntry(**entry)
                for entry in wf_data.get("filesystem_access", [])
                if isinstance(entry, dict)
            ],
            metadata=WorkflowMetadata(**wf_data.get("metadata", {})),
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
        if self.config.webhooks:
            data["workflow"]["webhooks"] = {
                trigger_id: config.model_dump(
                    exclude={"id"},
                    exclude_defaults=True,
                    exclude_none=True,
                )
                for trigger_id, config in self.config.webhooks.items()
            }
        if self.config.parameters:
            data["workflow"]["parameters"] = {
                name: parameter.model_dump(exclude_defaults=True, exclude_none=True)
                for name, parameter in self.config.parameters.items()
            }
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
        if self.config.filesystem_access:
            data["workflow"]["filesystem_access"] = [
                _paths_to_str(entry.model_dump(exclude_defaults=True))
                for entry in self.config.filesystem_access
            ]
        if self.config.metadata != WorkflowMetadata():
            data["workflow"]["metadata"] = self.config.metadata.model_dump(
                exclude_defaults=True,
                exclude_none=True,
            )

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
