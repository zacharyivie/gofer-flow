from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.templates import (
    create_workflow_from_template,
    list_workflow_templates,
    preview_workflow_template,
)
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.api import create_workflow_payload, list_workflow_templates_payload


def test_all_workflow_templates_generate_valid_workflows(tmp_path: Path) -> None:
    templates = list_workflow_templates()

    assert {item.name for item in templates} == {
        "code-review",
        "daily-report",
        "file-watcher",
        "local-vector-search",
        "markdown-folder-summary",
        "retry-review-loop",
    }

    for template in templates:
        result = create_workflow_from_template(template.name, tmp_path)
        loaded = AgenticWorkflow.from_file(result.path)

        loaded.validate(result.path, tmp_path)
        assert loaded.config.id == result.workflow.config.id
        assert result.path.exists()
        assert len(loaded.graph.nodes_in_order()) >= 1
        assert result.created_paths[0] == result.path
        assert all(path.exists() for path in result.created_paths)


def test_template_creation_uses_unique_workflow_ids_and_prompt_paths(tmp_path: Path) -> None:
    first = create_workflow_from_template("code-review", tmp_path, workflow_name="Review")
    second = create_workflow_from_template("code-review", tmp_path, workflow_name="Review")

    assert first.workflow.config.id == "review"
    assert second.workflow.config.id == "review-2"
    assert first.path.name == "review.toml"
    assert second.path.name == "review-2.toml"
    assert (tmp_path / "prompts" / "review" / "code-review.md").exists()
    assert (tmp_path / "prompts" / "review-2" / "code-review.md").exists()


def test_template_preview_reports_inputs_nodes_and_provider_assumptions() -> None:
    preview = preview_workflow_template("markdown-folder-summary")

    assert preview.name == "markdown-folder-summary"
    assert preview.required_inputs[0]["name"] == "folder"
    assert any(node["type"] == "loop" for node in preview.generated_nodes)
    assert preview.provider_assumptions == [
        {"agentId": "summarizer", "subscription": "codex"}
    ]


def test_ui_api_lists_and_creates_template_workflow(tmp_path: Path) -> None:
    listed = list_workflow_templates_payload()

    assert any(item["name"] == "file-watcher" for item in listed["templates"])

    payload = create_workflow_payload(
        "Incoming Files",
        tmp_path,
        template="file-watcher",
    )

    assert payload["id"] == "incoming-files"
    assert payload["watch"]["path"] == "inputs/watch"
    assert [node["id"] for node in payload["nodes"]] == ["changed-files", "process-file"]


def test_cli_lists_and_creates_template_workflow(tmp_path: Path) -> None:
    runner = CliRunner()

    listed = runner.invoke(app, ["workflow", "create", "--list-templates"])
    created = runner.invoke(
        app,
        [
            "workflow",
            "create",
            "--template",
            "local-vector-search",
            "--name",
            "Search Docs",
            "--output",
            str(tmp_path),
        ],
    )

    assert listed.exit_code == 0
    assert "local-vector-search" in listed.output
    assert created.exit_code == 0
    workflow = AgenticWorkflow.from_file(tmp_path / "search-docs.toml")
    assert workflow.config.id == "search-docs"
    assert (tmp_path / "prompts" / "search-docs" / "answer-from-search.md").exists()
