from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from gofer.core.dashboards import (
    DashboardComponentType,
    DashboardError,
    add_component,
    add_item,
    add_section,
    create_dashboard,
    delete_dashboard,
    delete_item,
    duplicate_dashboard,
    list_dashboards,
    list_items,
    move_item,
    rename_dashboard,
    set_component_schema,
    set_component_views,
    update_item,
)
from gofer.utils.paths import get_data_dir

app = typer.Typer(help="Manage custom workflow dashboards", no_args_is_help=True)
section_app = typer.Typer(help="Manage dashboard sections", no_args_is_help=True)
component_app = typer.Typer(help="Manage dashboard components", no_args_is_help=True)
schema_app = typer.Typer(help="Manage component schemas", no_args_is_help=True)
views_app = typer.Typer(help="Manage component views", no_args_is_help=True)
item_app = typer.Typer(help="Manage dashboard component items", no_args_is_help=True)
app.add_typer(section_app, name="section")
app.add_typer(component_app, name="component")
component_app.add_typer(schema_app, name="schema")
component_app.add_typer(views_app, name="views")
app.add_typer(item_app, name="item")
console = Console()


@app.command("list")
def list_command(data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True)) -> None:
    try:
        dashboards = list_dashboards(data_dir or get_data_dir())
    except DashboardError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    if not dashboards:
        console.print("No dashboards found.")
        return
    table = Table("ID", "Name", "Sections", "Updated")
    for dashboard in dashboards:
        table.add_row(
            dashboard.id,
            dashboard.name,
            str(len(dashboard.sections)),
            dashboard.updated_at,
        )
    console.print(table)


@app.command("create")
def create_command(
    name: str,
    dashboard_id: str | None = typer.Option(None, "--id", help="Dashboard ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(lambda: create_dashboard(name, data_dir or get_data_dir(), dashboard_id), "Created")


@app.command("rename")
def rename_command(
    dashboard: str,
    name: str,
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(lambda: rename_dashboard(dashboard, name, data_dir or get_data_dir()), "Renamed")


@app.command("duplicate")
def duplicate_command(
    dashboard: str,
    name: str | None = typer.Option(None, "--name", help="New dashboard name"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(lambda: duplicate_dashboard(dashboard, data_dir or get_data_dir(), name), "Duplicated")


@app.command("delete")
def delete_command(
    dashboard: str,
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    if not yes:
        typer.confirm(f"Delete dashboard '{dashboard}'?", abort=True)
    try:
        delete_dashboard(dashboard, data_dir or get_data_dir())
    except DashboardError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    console.print(f"[green]Deleted dashboard[/green] [bold]{dashboard}[/bold]")


@section_app.command("add")
def add_section_command(
    dashboard: str,
    title: str,
    section_id: str | None = typer.Option(None, "--id", help="Section ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(
        lambda: add_section(dashboard, title, data_dir or get_data_dir(), section_id),
        "Added section",
    )


@component_app.command("add")
def add_component_command(
    dashboard: str,
    section: str,
    title: str,
    component_type: DashboardComponentType = typer.Option("table", "--type", help="Component type"),
    component_id: str | None = typer.Option(None, "--id", help="Component ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(
        lambda: add_component(
            dashboard,
            section,
            title,
            component_type,
            data_dir or get_data_dir(),
            component_id,
        ),
        "Added component",
    )


@component_app.command("add-board")
def add_board_command(
    dashboard: str,
    section: str,
    title: str,
    component_id: str | None = typer.Option(None, "--id", help="Component ID"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle(
        lambda: add_component(
            dashboard,
            section,
            title,
            "board",
            data_dir or get_data_dir(),
            component_id,
        ),
        "Added board",
    )


@schema_app.command("set")
def schema_command(
    dashboard: str,
    component: str,
    schema_json: str = typer.Argument(..., help='Schema JSON, for example {"title":"string"}'),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    schema = _json_object(schema_json)
    _handle(
        lambda: set_component_schema(dashboard, component, schema, data_dir or get_data_dir()),
        "Updated schema",
    )


@views_app.command("set")
def views_command(
    dashboard: str,
    component: str,
    views_json: str = typer.Argument(..., help="Views JSON array"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    views = _json_array(views_json)
    _handle(
        lambda: set_component_views(dashboard, component, views, data_dir or get_data_dir()),
        "Updated views",
    )


@item_app.command("list")
def item_list_command(
    dashboard: str,
    component: str,
    filter_rule: str | None = typer.Option(None, "--filter", help="Filter as field=value"),
    json_output: bool = typer.Option(False, "--json", help="Print JSON"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    try:
        items = list_items(dashboard, component, data_dir or get_data_dir(), filter_rule)
    except DashboardError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    if json_output:
        console.print(json.dumps(items, indent=2, sort_keys=True))
        return
    table = Table("ID", "Fields")
    for item in items:
        table.add_row(
            str(item.get("id", "")),
            json.dumps({k: v for k, v in item.items() if k != "id"}, sort_keys=True),
        )
    console.print(table)


@item_app.command("add")
def item_add_command(
    dashboard: str,
    component: str,
    item_json: str = typer.Argument(..., help="Item JSON object"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    item = _json_object(item_json)
    _handle_item(
        lambda: add_item(dashboard, component, item, data_dir or get_data_dir()),
        "Added item",
    )


@item_app.command("update")
def item_update_command(
    dashboard: str,
    component: str,
    item_id: str,
    patch_json: str = typer.Argument(..., help="Patch JSON object"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    patch = _json_object(patch_json)
    _handle_item(
        lambda: update_item(dashboard, component, item_id, patch, data_dir or get_data_dir()),
        "Updated item",
    )


@item_app.command("move")
def item_move_command(
    dashboard: str,
    component: str,
    item_id: str,
    status: str,
    field: str = typer.Option("status", "--field", help="Field to update"),
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle_item(
        lambda: move_item(dashboard, component, item_id, field, status, data_dir or get_data_dir()),
        "Moved item",
    )


@item_app.command("delete")
def item_delete_command(
    dashboard: str,
    component: str,
    item_id: str,
    data_dir: Path | None = typer.Option(None, "--data-dir", hidden=True),
) -> None:
    _handle_item(
        lambda: delete_item(dashboard, component, item_id, data_dir or get_data_dir()),
        "Deleted item",
    )


def _handle(action: Any, label: str) -> None:
    try:
        dashboard = action()
    except (DashboardError, ValueError, json.JSONDecodeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    console.print(f"[green]{label}[/green] [bold]{dashboard.id}[/bold]")


def _handle_item(action: Any, label: str) -> None:
    try:
        item = action()
    except (DashboardError, ValueError, json.JSONDecodeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    console.print(f"[green]{label}[/green] [bold]{item.get('id', '')}[/bold]")
    console.print(json.dumps(item, indent=2, sort_keys=True))


def _json_object(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise DashboardError("Expected a JSON object")
    return parsed


def _json_array(value: str) -> list[dict[str, Any]]:
    parsed = json.loads(value)
    if not isinstance(parsed, list) or not all(isinstance(item, dict) for item in parsed):
        raise DashboardError("Expected a JSON array of objects")
    return parsed
