from __future__ import annotations

import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.agent import AgentConfig, AgentResult
from gofer.core.dashboards import load_dashboard
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import (
    AgentOperation,
    DashboardItemOperation,
    DashboardItemsFanSource,
    DashboardUpdateInstruction,
    LoopOperation,
    OperationType,
)
from gofer.core.provider_profiles import ResolvedProviderSettings
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from gofer.subscriptions.base import Subscription
from gofer.ui.api import (
    DashboardUiError,
    dashboard_payload,
    delete_dashboard_component_payload,
    delete_dashboard_section_payload,
    mutate_dashboard_item_payload,
    update_dashboard_component_payload,
    update_dashboard_section_payload,
)

runner = CliRunner()


class DashboardFakeSubscription(Subscription):
    def __init__(self, output: str) -> None:
        self.output = output

    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
        provider_settings: ResolvedProviderSettings | None = None,
    ) -> list[str]:
        return ["fake"]

    def is_available(self) -> bool:
        return True

    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
        extra_paths: list[Path] | None = None,
        max_output_bytes: int | None = None,
        on_thought: Callable[[str], None] | None = None,
        provider_settings: ResolvedProviderSettings | None = None,
    ) -> AgentResult:
        return AgentResult(
            agent_id="",
            success=True,
            output=self.output,
            exit_code=0,
            duration_seconds=0.0,
        )


def test_dashboard_cli_create_board_schema_and_items(tmp_path: Path) -> None:
    create = runner.invoke(
        app,
        ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)],
    )
    section = runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    component = runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    schema = runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "schema",
            "set",
            "Dev Dashboard",
            "tickets",
            json.dumps(
                {
                    "title": "string",
                    "status": {
                        "type": "enum",
                        "values": ["backlog", "todo", "in_progress", "completed"],
                    },
                }
            ),
            "--data-dir",
            str(tmp_path),
        ],
    )
    item = runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "add",
            "Dev Dashboard",
            "tickets",
            json.dumps({"title": "Review ticket", "status": "backlog"}),
            "--data-dir",
            str(tmp_path),
        ],
    )
    listed = runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "list",
            "Dev Dashboard",
            "tickets",
            "--filter",
            "status=backlog",
            "--json",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert create.exit_code == 0, create.output
    assert section.exit_code == 0, section.output
    assert component.exit_code == 0, component.output
    assert schema.exit_code == 0, schema.output
    assert item.exit_code == 0, item.output
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)[0]["title"] == "Review ticket"

    dashboard = load_dashboard("dev-dashboard", tmp_path)
    assert dashboard.sections[0].components[0].views[0].title == "Backlog"


def test_dashboard_board_components_start_with_usable_schema(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    added = runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert added.exit_code == 0, added.output
    component = load_dashboard("Dev Dashboard", tmp_path).sections[0].components[0]
    assert set(component.schema_) >= {"title", "status", "description"}
    assert component.schema_["title"].required
    assert component.schema_["status"].values == ["backlog", "todo", "in_progress", "completed"]
    assert component.display["cardFields"][0] == {"field": "title", "style": "heading"}
    assert {"field": "status", "style": "dropdown"} in component.display["detailFields"]
    assert {"field": "description", "style": "textarea"} in component.display["detailFields"]


def test_dashboard_component_display_updates_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )

    payload = update_dashboard_component_payload(
        "Dev Dashboard",
        "tickets",
        tmp_path,
        display={
            "cardFields": [{"field": "slug", "style": "text"}],
            "detailFields": [
                {"field": "title", "style": "heading"},
                {"field": "description", "style": "textarea"},
            ],
        },
    )

    display = payload["dashboard"]["sections"][0]["components"][0]["display"]
    assert display["cardFields"] == [{"field": "slug", "style": "text"}]
    assert display["detailFields"][1] == {"field": "description", "style": "textarea"}


def test_dashboard_component_display_preserves_hide_title(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )

    payload = update_dashboard_component_payload(
        "Dev Dashboard",
        "tickets",
        tmp_path,
        display={"hideTitle": True, "cardFields": [{"field": "title", "style": "heading"}]},
    )

    assert payload["dashboard"]["sections"][0]["components"][0]["display"]["hideTitle"] is True


def test_workflow_cli_adds_dashboard_item_node(tmp_path: Path) -> None:
    workflow_path = tmp_path / "dash.toml"
    workflow = AgenticWorkflow(WorkflowConfig(id="dash", name="Dashboard"))
    workflow.to_file(workflow_path)

    added = runner.invoke(
        app,
        [
            "workflow",
            "add-node",
            str(workflow_path),
            "--id",
            "read_backlog",
            "--type",
            "dashboard_item",
            "--dashboard",
            "Dev Dashboard",
            "--component",
            "tickets",
            "--dashboard-action",
            "read",
            "--filter",
            "status=backlog",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert added.exit_code == 0, added.output
    loaded = AgenticWorkflow.from_file(workflow_path)
    operation = loaded.graph._nodes["read_backlog"].operation
    assert isinstance(operation, DashboardItemOperation)
    assert operation.dashboard == "Dev Dashboard"
    assert operation.component == "tickets"
    assert operation.filter == "status=backlog"


def test_workflow_cli_adds_dashboard_items_loop_node(tmp_path: Path) -> None:
    workflow_path = tmp_path / "dash-loop.toml"
    workflow = AgenticWorkflow(WorkflowConfig(id="dash-loop", name="Dashboard Loop"))
    workflow.to_file(workflow_path)

    added = runner.invoke(
        app,
        [
            "workflow",
            "add-node",
            str(workflow_path),
            "--id",
            "loop-todos",
            "--type",
            "loop",
            "--fan-source",
            "dashboard-items",
            "--dashboard",
            "Development Dashboard",
            "--component",
            "tickets",
            "--filter",
            "status=todo",
            "--fan-max-concurrency",
            "2",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert added.exit_code == 0, added.output
    operation = AgenticWorkflow.from_file(workflow_path).graph._nodes["loop-todos"].operation
    assert isinstance(operation, LoopOperation)
    assert isinstance(operation.source, DashboardItemsFanSource)
    assert operation.source.dashboard == "Development Dashboard"
    assert operation.source.component == "tickets"
    assert operation.source.filter == "status=todo"
    assert operation.source.max_concurrency == 2


def test_invalid_dashboard_data_returns_recoverable_errors(tmp_path: Path) -> None:
    dashboards_dir = tmp_path / "dashboards"
    dashboards_dir.mkdir()
    (dashboards_dir / "broken.json").write_text(
        '{"id": "broken", "sections": []}',
        encoding="utf-8",
    )

    listed = runner.invoke(
        app,
        ["dashboard", "list", "--data-dir", str(tmp_path)],
    )

    assert listed.exit_code == 1
    assert "failed validation" in listed.output
    with pytest.raises(DashboardUiError, match="failed validation"):
        dashboard_payload(tmp_path)


def test_component_ids_are_unique_across_dashboard_sections(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Review Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    first = runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--id",
            "tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    duplicate = runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add",
            "Dev Dashboard",
            "Review Board",
            "Tickets",
            "--id",
            "tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert first.exit_code == 0, first.output
    assert duplicate.exit_code == 1
    assert "Component 'tickets' already exists" in duplicate.output


def test_dashboard_component_content_updates_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Notes",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add",
            "Dev Dashboard",
            "Notes",
            "Summary",
            "--type",
            "markdown",
            "--id",
            "summary",
            "--data-dir",
            str(tmp_path),
        ],
    )

    payload = update_dashboard_component_payload(
        "Dev Dashboard",
        "summary",
        tmp_path,
        content="# Current status\n\nReady for review.",
    )

    assert payload["dashboard"]["sections"][0]["components"][0]["content"].startswith(
        "# Current status"
    )
    dashboard = load_dashboard("Dev Dashboard", tmp_path)
    assert dashboard.sections[0].components[0].content == "# Current status\n\nReady for review."


def test_dashboard_component_deletes_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Notes",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add",
            "Dev Dashboard",
            "Notes",
            "Summary",
            "--type",
            "markdown",
            "--id",
            "summary",
            "--data-dir",
            str(tmp_path),
        ],
    )

    deleted = delete_dashboard_component_payload("Dev Dashboard", "summary", tmp_path)

    assert deleted["dashboard"]["sections"][0]["components"] == []
    assert load_dashboard("Dev Dashboard", tmp_path).sections[0].components == []


def test_dashboard_json_list_component_deletes_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Data",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add",
            "Dev Dashboard",
            "Data",
            "JSON List",
            "--type",
            "json_list",
            "--id",
            "json-list",
            "--data-dir",
            str(tmp_path),
        ],
    )

    deleted = delete_dashboard_component_payload("Dev Dashboard", "json-list", tmp_path)

    assert deleted["dashboard"]["sections"][0]["components"] == []


def test_dashboard_component_title_updates_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )

    payload = update_dashboard_component_payload(
        "Dev Dashboard",
        "tickets",
        tmp_path,
        title="Sprint Board",
    )

    assert payload["dashboard"]["sections"][0]["components"][0]["title"] == "Sprint Board"
    assert (
        load_dashboard("Dev Dashboard", tmp_path).sections[0].components[0].title
        == "Sprint Board"
    )


def test_dashboard_item_mutations_return_updated_dashboard_payload(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    added = mutate_dashboard_item_payload(
        "Dev Dashboard",
        "tickets",
        "add",
        {"item": {"title": "New card", "status": "backlog"}},
        tmp_path,
    )
    item_id = added["item"]["id"]

    moved = mutate_dashboard_item_payload(
        "Dev Dashboard",
        "tickets",
        "move",
        {"itemId": item_id, "field": "status", "value": "completed"},
        tmp_path,
    )

    item = moved["dashboard"]["sections"][0]["components"][0]["items"][0]
    assert item["title"] == "New card"
    assert item["status"] == "completed"


def test_dashboard_section_layout_updates_and_deletes_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Notes",
            "--data-dir",
            str(tmp_path),
        ],
    )

    resized = update_dashboard_section_payload(
        "Dev Dashboard",
        "notes",
        tmp_path,
        layout={"columns": 6},
    )

    assert resized["dashboard"]["sections"][0]["layout"]["columns"] == 6
    assert load_dashboard("Dev Dashboard", tmp_path).sections[0].layout["columns"] == 6

    deleted = delete_dashboard_section_payload("Dev Dashboard", "notes", tmp_path)

    assert deleted["dashboard"]["sections"] == []
    assert load_dashboard("Dev Dashboard", tmp_path).sections == []


def test_dashboard_section_title_updates_through_api(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Notes",
            "--data-dir",
            str(tmp_path),
        ],
    )

    renamed = update_dashboard_section_payload(
        "Dev Dashboard",
        "notes",
        tmp_path,
        title="Project Notes",
    )

    assert renamed["dashboard"]["sections"][0]["title"] == "Project Notes"
    assert load_dashboard("Dev Dashboard", tmp_path).sections[0].title == "Project Notes"


def test_dashboard_section_layout_preserves_hide_title(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Notes",
            "--data-dir",
            str(tmp_path),
        ],
    )

    updated = update_dashboard_section_payload(
        "Dev Dashboard",
        "notes",
        tmp_path,
        layout={"hideTitle": True},
    )

    assert updated["dashboard"]["sections"][0]["layout"]["hideTitle"] is True
    assert load_dashboard("Dev Dashboard", tmp_path).sections[0].layout["hideTitle"] is True


@pytest.mark.anyio
async def test_dashboard_item_workflow_read_and_update(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    added = runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "add",
            "Dev Dashboard",
            "tickets",
            json.dumps({"title": "Review ticket", "status": "backlog"}),
            "--data-dir",
            str(tmp_path),
        ],
    )
    item_id = json.loads(added.output.split("\n", 1)[1])["id"]

    workflow = AgenticWorkflow(WorkflowConfig(id="dash", name="Dashboard"))
    workflow.add_operation(
        GraphNode(
            node_id="read",
            operation=DashboardItemOperation(
                type=OperationType.DASHBOARD_ITEM,
                action="read",
                dashboard="Dev Dashboard",
                component="tickets",
                filter="status=backlog",
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="move",
            operation=DashboardItemOperation(
                type=OperationType.DASHBOARD_ITEM,
                action="move",
                dashboard="Dev Dashboard",
                component="tickets",
                item_id=item_id,
                value="completed",
            ),
        )
    )
    workflow.then("read", "move")

    result = await WorkflowExecutor(
        workflow,
        {},
        log_base_dir=tmp_path / "logs",
        data_dir=tmp_path,
    ).run()

    assert result.success
    read_item = cast(dict[str, Any], result.node_outputs["read"].items[0])
    moved_item = cast(dict[str, Any], result.node_outputs["move"].data["item"])
    assert read_item["status"] == "backlog"
    assert (
        result.node_outputs["read"].data["message"]
        == "dashboard read: Dev Dashboard/tickets 1 item(s)"
    )
    assert result.node_outputs["read"].data["selected"] == read_item
    assert moved_item["status"] == "completed"
    assert result.node_outputs["move"].data["message"] == "dashboard move: Dev Dashboard/tickets"
    assert result.node_outputs["move"].data["selected"] == moved_item


@pytest.mark.anyio
async def test_loop_can_iterate_dashboard_items_with_filter(tmp_path: Path) -> None:
    runner.invoke(
        app,
        ["dashboard", "create", "Development Dashboard", "--data-dir", str(tmp_path)],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Development Dashboard",
            "Kanban",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Development Dashboard",
            "Kanban",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "add",
            "Development Dashboard",
            "tickets",
            json.dumps({"title": "Build dashboard loops", "status": "todo"}),
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "add",
            "Development Dashboard",
            "tickets",
            json.dumps({"title": "Done ticket", "status": "completed"}),
            "--data-dir",
            str(tmp_path),
        ],
    )

    workflow = AgenticWorkflow(WorkflowConfig(id="dash-loop", name="Dashboard Loop"))
    workflow.add_operation(
        GraphNode(
            node_id="loop-todos",
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=DashboardItemsFanSource(
                    type="dashboard_items",
                    dashboard="Development Dashboard",
                    component="tickets",
                    filter="status=todo",
                ),
            ),
        )
    )

    result = await WorkflowExecutor(
        workflow,
        {},
        log_base_dir=tmp_path / "logs",
        data_dir=tmp_path,
    ).run()

    assert result.success
    output = result.node_outputs["loop-todos"]
    assert output.data["source_type"] == "dashboard_items"
    assert output.data["dashboard"] == "Development Dashboard"
    assert output.data["component"] == "tickets"
    assert output.data["count"] == 1
    loop_item = cast(dict[str, Any], output.items[0])
    assert loop_item["item_id"]
    assert loop_item["dashboard"] == "Development Dashboard"
    assert loop_item["component"] == "tickets"
    assert loop_item["item"]["title"] == "Build dashboard loops"
    assert loop_item["item"]["status"] == "todo"
    assert json.loads(cast(str, loop_item["item_json"]))["status"] == "todo"


@pytest.mark.anyio
async def test_dashboard_item_loop_child_can_update_current_item(tmp_path: Path) -> None:
    runner.invoke(
        app,
        ["dashboard", "create", "Development Dashboard", "--data-dir", str(tmp_path)],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Development Dashboard",
            "Kanban",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Development Dashboard",
            "Kanban",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "item",
            "add",
            "Development Dashboard",
            "tickets",
            json.dumps({"title": "Move me", "status": "todo"}),
            "--data-dir",
            str(tmp_path),
        ],
    )

    workflow = AgenticWorkflow(WorkflowConfig(id="dash-loop-update", name="Dashboard Loop Update"))
    workflow.add_operation(
        GraphNode(
            node_id="loop-todos",
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=DashboardItemsFanSource(
                    type="dashboard_items",
                    dashboard="Development Dashboard",
                    component="tickets",
                    filter="status=todo",
                ),
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="move-current",
            operation=DashboardItemOperation(
                type=OperationType.DASHBOARD_ITEM,
                action="move",
                dashboard="Development Dashboard",
                component="tickets",
                item_id="{{loop.current.item_id}}",
                field="status",
                value="in_progress",
            ),
        )
    )
    workflow.then("loop-todos", "move-current")

    result = await WorkflowExecutor(
        workflow,
        {},
        log_base_dir=tmp_path / "logs",
        data_dir=tmp_path,
    ).run()

    assert result.success
    moved_item = cast(dict[str, Any], result.node_outputs["move-current"].data["item"])
    assert moved_item["title"] == "Move me"
    assert moved_item["status"] == "in_progress"
    dashboard = load_dashboard("Development Dashboard", tmp_path)
    ticket = dashboard.sections[0].components[0].items[0]
    assert ticket["status"] == "in_progress"


@pytest.mark.anyio
async def test_agent_dashboard_update_writes_structured_output(tmp_path: Path) -> None:
    runner.invoke(app, ["dashboard", "create", "Dev Dashboard", "--data-dir", str(tmp_path)])
    runner.invoke(
        app,
        [
            "dashboard",
            "section",
            "add",
            "Dev Dashboard",
            "Ticket Board",
            "--data-dir",
            str(tmp_path),
        ],
    )
    runner.invoke(
        app,
        [
            "dashboard",
            "component",
            "add-board",
            "Dev Dashboard",
            "Ticket Board",
            "Tickets",
            "--data-dir",
            str(tmp_path),
        ],
    )
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text("Review the selected ticket.", encoding="utf-8")
    workflow = AgenticWorkflow(WorkflowConfig(id="agent-dash", name="Agent Dashboard"))
    workflow.register_agent(
            AgentConfig(
                agent_id="reviewer",
                subscription="codex",
                working_dir=tmp_path,
                prompt_path=prompt_path,
            )
    )
    workflow.add_operation(
        GraphNode(
            node_id="review",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="reviewer",
                working_dir=tmp_path,
                prompt_path=prompt_path,
                dashboard_updates=[
                    DashboardUpdateInstruction(
                        action="add",
                        dashboard="Dev Dashboard",
                        component="tickets",
                        source="data.dashboard_update",
                    )
                ],
            ),
        )
    )
    subscription = DashboardFakeSubscription(
        output=json.dumps(
            {
                "dashboard_update": {
                    "item": {"title": "Reviewed ticket", "status": "completed"}
                }
            }
        )
    )

    result = await WorkflowExecutor(
        workflow,
        {"codex": subscription},
        log_base_dir=tmp_path / "logs",
        data_dir=tmp_path,
    ).run()

    assert result.success
    items = load_dashboard("Dev Dashboard", tmp_path).sections[0].components[0].items
    assert items[0]["title"] == "Reviewed ticket"
    assert items[0]["status"] == "completed"
    updates = cast(list[dict[str, object]], result.node_outputs["review"].data["dashboard_updates"])
    assert updates[0]["action"] == "add"
