from __future__ import annotations

import copy
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from gofer.utils.paths import get_data_dir

DashboardComponentType = Literal["markdown", "table", "board", "stats", "json_list", "chart"]
DashboardFieldType = Literal[
    "string",
    "text",
    "number",
    "boolean",
    "date",
    "datetime",
    "enum",
    "json",
]
DashboardFilterOperator = Literal["equals", "not_equals", "contains", "exists"]
DashboardItemAction = Literal["read", "add", "update", "delete", "move"]

ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,127}")


class DashboardError(ValueError):
    pass


class DashboardFieldSchema(BaseModel):
    type: DashboardFieldType = "string"
    values: list[Any] = Field(default_factory=list)
    required: bool = False

    @model_validator(mode="after")
    def _validate_enum(self) -> DashboardFieldSchema:
        if self.type == "enum" and not self.values:
            raise ValueError("enum fields require values")
        return self


class DashboardFilterRule(BaseModel):
    field: str
    operator: DashboardFilterOperator = "equals"
    value: Any = None


class DashboardView(BaseModel):
    id: str | None = None
    title: str
    filter: DashboardFilterRule | None = None


class DashboardComponent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    type: DashboardComponentType
    title: str
    schema_: dict[str, DashboardFieldSchema] = Field(
        default_factory=dict,
        alias="schema",
        serialization_alias="schema",
    )
    views: list[DashboardView] = Field(default_factory=list)
    items: list[dict[str, Any]] = Field(default_factory=list)
    content: str = ""
    display: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_dashboard_id(value)


class DashboardSection(BaseModel):
    id: str
    title: str
    layout: dict[str, Any] = Field(default_factory=lambda: {"columns": 12})
    components: list[DashboardComponent] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_dashboard_id(value)


class Dashboard(BaseModel):
    id: str
    name: str
    sections: list[DashboardSection] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: _now_iso())
    updated_at: str = Field(default_factory=lambda: _now_iso())

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return validate_dashboard_id(value)

    @model_validator(mode="after")
    def _validate_component_ids(self) -> Dashboard:
        seen: set[str] = set()
        for section in self.sections:
            for component in section.components:
                if component.id in seen:
                    raise DashboardError(
                        f"Component '{component.id}' already exists in dashboard '{self.id}'"
                    )
                seen.add(component.id)
        return self


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:128] or "dashboard"


def validate_dashboard_id(value: str) -> str:
    if not ID_PATTERN.fullmatch(value):
        raise DashboardError("Dashboard IDs must match [a-z0-9][a-z0-9-]{0,127}")
    return value


def dashboards_dir(data_dir: Path | None = None) -> Path:
    return (data_dir or get_data_dir()) / "dashboards"


def dashboard_path(dashboard_id: str, data_dir: Path | None = None) -> Path:
    return dashboards_dir(data_dir) / f"{validate_dashboard_id(dashboard_id)}.json"


def list_dashboards(data_dir: Path | None = None) -> list[Dashboard]:
    folder = dashboards_dir(data_dir)
    if not folder.exists():
        return []
    dashboards: list[Dashboard] = []
    for path in sorted(folder.glob("*.json")):
        dashboards.append(load_dashboard(path.stem, data_dir))
    return dashboards


def load_dashboard(dashboard_id_or_name: str, data_dir: Path | None = None) -> Dashboard:
    dashboard_id = resolve_dashboard_id(dashboard_id_or_name, data_dir)
    path = dashboard_path(dashboard_id, data_dir)
    if not path.exists():
        raise DashboardError(f"Dashboard '{dashboard_id_or_name}' not found")
    try:
        return Dashboard.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        raise DashboardError(f"Dashboard '{dashboard_id_or_name}' contains invalid JSON") from exc
    except ValidationError as exc:
        message = f"Dashboard '{dashboard_id_or_name}' failed validation: {exc}"
        raise DashboardError(message) from exc


def save_dashboard(dashboard: Dashboard, data_dir: Path | None = None) -> Dashboard:
    dashboard.updated_at = _now_iso()
    folder = dashboards_dir(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    dashboard_path(dashboard.id, data_dir).write_text(
        json.dumps(dashboard.model_dump(mode="json", by_alias=True), indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    return dashboard


def resolve_dashboard_id(dashboard_id_or_name: str, data_dir: Path | None = None) -> str:
    raw = dashboard_id_or_name.strip()
    if ID_PATTERN.fullmatch(raw) and dashboard_path(raw, data_dir).exists():
        return raw
    normalized = raw.casefold()
    for dashboard in list_dashboards(data_dir):
        if dashboard.id == raw or dashboard.name.casefold() == normalized:
            return dashboard.id
    if ID_PATTERN.fullmatch(raw):
        return raw
    return slugify(raw)


def create_dashboard(
    name: str,
    data_dir: Path | None = None,
    dashboard_id: str | None = None,
) -> Dashboard:
    if not name.strip():
        raise DashboardError("Dashboard name is required")
    base_id = dashboard_id or slugify(name)
    validate_dashboard_id(base_id)
    next_id = base_id
    index = 2
    while dashboard_path(next_id, data_dir).exists():
        next_id = f"{base_id}-{index}"
        index += 1
    dashboard = Dashboard(id=next_id, name=name.strip())
    return save_dashboard(dashboard, data_dir)


def rename_dashboard(
    dashboard_id_or_name: str,
    name: str,
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    if not name.strip():
        raise DashboardError("Dashboard name is required")
    dashboard.name = name.strip()
    return save_dashboard(dashboard, data_dir)


def duplicate_dashboard(
    dashboard_id_or_name: str,
    data_dir: Path | None = None,
    name: str | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    duplicate = dashboard.model_copy(deep=True)
    duplicate.id = _unique_dashboard_id(slugify(name or f"{dashboard.name} Copy"), data_dir)
    duplicate.name = name or f"{dashboard.name} Copy"
    duplicate.created_at = _now_iso()
    return save_dashboard(duplicate, data_dir)


def delete_dashboard(dashboard_id_or_name: str, data_dir: Path | None = None) -> None:
    dashboard_id = resolve_dashboard_id(dashboard_id_or_name, data_dir)
    path = dashboard_path(dashboard_id, data_dir)
    if not path.exists():
        raise DashboardError(f"Dashboard '{dashboard_id_or_name}' not found")
    path.unlink()


def add_section(
    dashboard_id_or_name: str,
    title: str,
    data_dir: Path | None = None,
    section_id: str | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    base_id = section_id or slugify(title)
    _ensure_unique(base_id, [section.id for section in dashboard.sections], "section")
    dashboard.sections.append(DashboardSection(id=base_id, title=title.strip() or base_id))
    return save_dashboard(dashboard, data_dir)


def update_section(
    dashboard_id_or_name: str,
    section_id_or_title: str,
    data_dir: Path | None = None,
    *,
    title: str | None = None,
    layout: dict[str, Any] | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    section = find_section(dashboard, section_id_or_title)
    if title is not None:
        section.title = title.strip() or section.id
    if layout is not None:
        section.layout.update(layout)
    return save_dashboard(dashboard, data_dir)


def delete_section(
    dashboard_id_or_name: str,
    section_id_or_title: str,
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    section = find_section(dashboard, section_id_or_title)
    dashboard.sections = [item for item in dashboard.sections if item.id != section.id]
    return save_dashboard(dashboard, data_dir)


def add_component(
    dashboard_id_or_name: str,
    section_id_or_title: str,
    title: str,
    component_type: DashboardComponentType,
    data_dir: Path | None = None,
    component_id: str | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    section = find_section(dashboard, section_id_or_title)
    base_id = component_id or slugify(title)
    _ensure_unique(base_id, _component_ids(dashboard), "component")
    views = default_views(component_type)
    section.components.append(
        DashboardComponent(
            id=base_id,
            type=component_type,
            title=title.strip() or base_id,
            schema=default_schema(component_type),
            display=default_display(component_type),
            views=views,
        )
    )
    return save_dashboard(dashboard, data_dir)


def delete_component(
    dashboard_id_or_name: str,
    component_id: str,
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    for section in dashboard.sections:
        section.components = [item for item in section.components if item.id != component.id]
    return save_dashboard(dashboard, data_dir)


def set_component_title(
    dashboard_id_or_name: str,
    component_id: str,
    title: str,
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    component.title = title.strip() or component.id
    return save_dashboard(dashboard, data_dir)


def set_component_content(
    dashboard_id_or_name: str,
    component_id: str,
    content: str,
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    component.content = content
    return save_dashboard(dashboard, data_dir)


def set_component_schema(
    dashboard_id_or_name: str,
    component_id: str,
    schema: dict[str, Any],
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    component.schema_ = normalize_schema(schema)
    return save_dashboard(dashboard, data_dir)


def set_component_views(
    dashboard_id_or_name: str,
    component_id: str,
    views: list[dict[str, Any]],
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    component.views = [DashboardView.model_validate(view) for view in views]
    return save_dashboard(dashboard, data_dir)


def set_component_display(
    dashboard_id_or_name: str,
    component_id: str,
    display: dict[str, Any],
    data_dir: Path | None = None,
) -> Dashboard:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    component.display = normalize_display(display)
    return save_dashboard(dashboard, data_dir)


def list_items(
    dashboard_id_or_name: str,
    component_id: str,
    data_dir: Path | None = None,
    filter_rule: DashboardFilterRule | str | dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    rule = parse_filter(filter_rule)
    return [copy.deepcopy(item) for item in component.items if matches_filter(item, rule)]


def add_item(
    dashboard_id_or_name: str,
    component_id: str,
    item: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    next_item = coerce_item(item, component.schema_)
    now = _now_iso()
    next_item.setdefault("id", uuid.uuid4().hex)
    next_item.setdefault("created_at", now)
    next_item["updated_at"] = now
    component.items.append(next_item)
    save_dashboard(dashboard, data_dir)
    return copy.deepcopy(next_item)


def update_item(
    dashboard_id_or_name: str,
    component_id: str,
    item_id: str,
    patch: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    item = find_item(component, item_id)
    merged = {**item, **coerce_item(patch, component.schema_, partial=True)}
    merged["id"] = item["id"]
    merged["updated_at"] = _now_iso()
    item.clear()
    item.update(merged)
    save_dashboard(dashboard, data_dir)
    return copy.deepcopy(item)


def delete_item(
    dashboard_id_or_name: str,
    component_id: str,
    item_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    dashboard = load_dashboard(dashboard_id_or_name, data_dir)
    component = find_component(dashboard, component_id)
    for index, item in enumerate(component.items):
        if str(item.get("id")) == item_id:
            removed = component.items.pop(index)
            save_dashboard(dashboard, data_dir)
            return copy.deepcopy(removed)
    raise DashboardError(f"Item '{item_id}' not found")


def move_item(
    dashboard_id_or_name: str,
    component_id: str,
    item_id: str,
    field: str,
    value: Any,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    return update_item(dashboard_id_or_name, component_id, item_id, {field: value}, data_dir)


def find_section(dashboard: Dashboard, section_id_or_title: str) -> DashboardSection:
    normalized = section_id_or_title.casefold()
    for section in dashboard.sections:
        if section.id == section_id_or_title or section.title.casefold() == normalized:
            return section
    raise DashboardError(f"Section '{section_id_or_title}' not found")


def find_component(dashboard: Dashboard, component_id: str) -> DashboardComponent:
    for section in dashboard.sections:
        for component in section.components:
            if component.id == component_id:
                return component
    raise DashboardError(f"Component '{component_id}' not found")


def find_item(component: DashboardComponent, item_id: str) -> dict[str, Any]:
    for item in component.items:
        if str(item.get("id")) == item_id:
            return item
    raise DashboardError(f"Item '{item_id}' not found")


def normalize_schema(schema: dict[str, Any]) -> dict[str, DashboardFieldSchema]:
    normalized: dict[str, DashboardFieldSchema] = {}
    for field_name, raw in schema.items():
        if not field_name:
            raise DashboardError("Schema field names cannot be empty")
        if isinstance(raw, str):
            raw = {"type": raw}
        if not isinstance(raw, dict):
            raise DashboardError(f"Invalid schema for field '{field_name}'")
        normalized[field_name] = DashboardFieldSchema.model_validate(raw)
    return normalized


def coerce_item(
    item: dict[str, Any],
    schema: dict[str, DashboardFieldSchema],
    *,
    partial: bool = False,
) -> dict[str, Any]:
    output = dict(item)
    for field_name, field_schema in schema.items():
        if field_schema.required and not partial and field_name not in output:
            raise DashboardError(f"Missing required field '{field_name}'")
        if field_name not in output:
            continue
        output[field_name] = coerce_value(field_name, output[field_name], field_schema)
    return output


def coerce_value(field_name: str, value: Any, field_schema: DashboardFieldSchema) -> Any:
    if value is None:
        return None
    if field_schema.type in {"string", "text", "date", "datetime"}:
        return str(value)
    if field_schema.type == "number":
        return (
            value
            if isinstance(value, int | float) and not isinstance(value, bool)
            else float(value)
        )
    if field_schema.type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "1", "yes", "on"}:
            return True
        if isinstance(value, str) and value.lower() in {"false", "0", "no", "off"}:
            return False
        raise DashboardError(f"Field '{field_name}' must be boolean")
    if field_schema.type == "enum":
        if value not in field_schema.values:
            raise DashboardError(f"Field '{field_name}' must be one of {field_schema.values}")
        return value
    return value


def parse_filter(
    filter_rule: DashboardFilterRule | str | dict[str, Any] | None,
) -> DashboardFilterRule | None:
    if filter_rule is None or filter_rule == "":
        return None
    if isinstance(filter_rule, DashboardFilterRule):
        return filter_rule
    if isinstance(filter_rule, dict):
        return DashboardFilterRule.model_validate(filter_rule)
    if "=" in filter_rule:
        field, value = filter_rule.split("=", 1)
        return DashboardFilterRule(field=field.strip(), operator="equals", value=value.strip())
    raise DashboardError("Filters must use field=value or a structured filter object")


def matches_filter(item: dict[str, Any], rule: DashboardFilterRule | None) -> bool:
    if rule is None:
        return True
    current = item.get(rule.field)
    if rule.operator == "equals":
        return current == rule.value or str(current) == str(rule.value)
    if rule.operator == "not_equals":
        return not (current == rule.value or str(current) == str(rule.value))
    if rule.operator == "contains":
        return str(rule.value).casefold() in str(current or "").casefold()
    if rule.operator == "exists":
        return rule.field in item and item[rule.field] not in {None, ""}
    return False


def default_views(component_type: DashboardComponentType) -> list[DashboardView]:
    if component_type != "board":
        return []
    return [
        DashboardView(
            title=title,
            filter=DashboardFilterRule(field="status", operator="equals", value=value),
        )
        for title, value in (
            ("Backlog", "backlog"),
            ("Todo", "todo"),
            ("In Progress", "in_progress"),
            ("Completed", "completed"),
        )
    ]


def default_schema(component_type: DashboardComponentType) -> dict[str, DashboardFieldSchema]:
    if component_type == "board":
        return {
            "title": DashboardFieldSchema(type="string", required=True),
            "status": DashboardFieldSchema(
                type="enum",
                values=["backlog", "todo", "in_progress", "completed"],
            ),
            "description": DashboardFieldSchema(type="text"),
        }
    if component_type in {"table", "stats", "chart"}:
        return {
            "title": DashboardFieldSchema(type="string"),
            "value": DashboardFieldSchema(type="string"),
        }
    if component_type == "json_list":
        return {"value": DashboardFieldSchema(type="json")}
    return {}


def default_display(component_type: DashboardComponentType) -> dict[str, Any]:
    if component_type == "board":
        return {
            "cardFields": [
                {"field": "title", "style": "heading"},
                {"field": "description", "style": "muted"},
            ],
            "detailFields": [
                {"field": "title", "style": "heading"},
                {"field": "status", "style": "dropdown"},
                {"field": "description", "style": "textarea"},
            ],
        }
    return {}


def normalize_display(display: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    if "hideTitle" in display:
        normalized["hideTitle"] = bool(display.get("hideTitle"))
    for key in ("cardFields", "detailFields"):
        rows = display.get(key)
        if not isinstance(rows, list):
            continue
        normalized[key] = [
            {
                "field": str(row.get("field") or "").strip(),
                "style": str(row.get("style") or "text").strip() or "text",
            }
            for row in rows
            if isinstance(row, dict) and str(row.get("field") or "").strip()
        ]
    return normalized


def _unique_dashboard_id(base_id: str, data_dir: Path | None = None) -> str:
    validate_dashboard_id(base_id)
    next_id = base_id
    index = 2
    while dashboard_path(next_id, data_dir).exists():
        next_id = f"{base_id}-{index}"
        index += 1
    return next_id


def _ensure_unique(value: str, existing: list[str], kind: str) -> None:
    validate_dashboard_id(value)
    if value in existing:
        raise DashboardError(f"{kind.title()} '{value}' already exists")


def _component_ids(dashboard: Dashboard) -> list[str]:
    return [
        component.id
        for section in dashboard.sections
        for component in section.components
    ]
