from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from gofer.core.bundles import (
    BundleError,
    export_workflow_bundle,
    import_workflow_bundle,
    preview_workflow_bundle,
)
from gofer.core.validation import validate_workflow_file


def _write_bundle_source(base: Path) -> Path:
    (base / "prompts").mkdir()
    (base / "scripts").mkdir()
    (base / "prompts" / "hello.md").write_text("Say {{secret.API_TOKEN}}\n")
    (base / "scripts" / "hello.sh").write_text("echo hello\n")
    workflow_path = base / "hello.toml"
    workflow_path.write_text(
        """
[workflow]
id = "hello"
name = "Hello"

[agents.bot]
subscription = "codex"
working_dir = "."
prompt_path = "prompts/hello.md"

[[nodes]]
id = "script"
type = "shell_script"
script_path = "scripts/hello.sh"

[[nodes]]
id = "agent"
type = "agent"
agent_id = "bot"
working_dir = "."
prompt_path = "prompts/hello.md"

[[edges]]
from = "script"
to = "agent"
""".strip()
        + "\n"
    )
    return workflow_path


def test_export_import_bundle_round_trips_and_validates(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    target_dir = tmp_path / "target"
    source_dir.mkdir()
    workflow_path = _write_bundle_source(source_dir)
    bundle_path = tmp_path / "hello.gof.zip"

    manifest = export_workflow_bundle(workflow_path, bundle_path)

    assert manifest.workflow_id == "hello"
    assert {item["path"] for item in manifest.included_paths} == {
        "prompts/hello.md",
        "scripts/hello.sh",
    }
    assert manifest.required_secrets == [
        {"name": "API_TOKEN", "description": "Required by bundled workflow"}
    ]

    plan = import_workflow_bundle(bundle_path, data_dir=target_dir)

    assert plan.workflow_id == "hello"
    assert (target_dir / "hello.toml").exists()
    assert (target_dir / "prompts" / "hello.md").read_text() == "Say {{secret.API_TOKEN}}\n"
    assert validate_workflow_file(target_dir / "hello.toml", data_dir=target_dir).ok


def test_import_bundle_conflicts_rename_workflow_and_asset_paths(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    target_dir = tmp_path / "target"
    source_dir.mkdir()
    target_dir.mkdir()
    workflow_path = _write_bundle_source(source_dir)
    bundle_path = tmp_path / "hello.gof.zip"
    export_workflow_bundle(workflow_path, bundle_path)
    (target_dir / "hello.toml").write_text(
        '[workflow]\nid = "hello"\nname = "Existing"\n',
        encoding="utf-8",
    )
    (target_dir / "prompts").mkdir()
    (target_dir / "prompts" / "hello.md").write_text("existing\n")

    plan = import_workflow_bundle(bundle_path, data_dir=target_dir)

    assert plan.workflow_id == "hello-2"
    assert plan.path_rewrites["prompts/hello.md"] == "bundle-assets/hello-2/prompts/hello.md"
    assert (target_dir / "hello-2.toml").exists()
    assert (target_dir / "bundle-assets" / "hello-2" / "prompts" / "hello.md").exists()
    imported_toml = (target_dir / "hello-2.toml").read_text()
    assert 'id = "hello-2"' in imported_toml
    assert 'prompt_path = "bundle-assets/hello-2/prompts/hello.md"' in imported_toml


def test_export_bundle_marks_missing_and_absolute_paths_external(tmp_path: Path) -> None:
    workflow_path = tmp_path / "external.toml"
    workflow_path.write_text(
        f"""
[workflow]
id = "external"
name = "External"

[[nodes]]
id = "missing"
type = "shell_script"
script_path = "missing.sh"

[[nodes]]
id = "absolute"
type = "python_script"
script_path = "{tmp_path / "outside.py"}"
""".strip()
        + "\n"
    )

    manifest = export_workflow_bundle(workflow_path, tmp_path / "external.zip")

    requirements = {item["path"]: item["reason"] for item in manifest.external_requirements}
    assert requirements["missing.sh"] == "referenced path was missing during export"
    assert requirements[str(tmp_path / "outside.py")] == (
        "absolute or user-relative path is machine-specific"
    )


def test_import_bundle_dry_run_reports_without_writing(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    target_dir = tmp_path / "target"
    source_dir.mkdir()
    workflow_path = _write_bundle_source(source_dir)
    bundle_path = tmp_path / "hello.gof.zip"
    export_workflow_bundle(workflow_path, bundle_path)

    plan = import_workflow_bundle(bundle_path, data_dir=target_dir, dry_run=True)

    assert "hello.toml" in plan.files_to_create
    assert not target_dir.exists()


def test_import_bundle_preview_reports_directory_files(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    target_dir = tmp_path / "target"
    source_dir.mkdir()
    (source_dir / "samples" / "nested").mkdir(parents=True)
    (source_dir / "samples" / "one.txt").write_text("one\n")
    (source_dir / "samples" / "nested" / "two.txt").write_text("two\n")
    workflow_path = source_dir / "copy.toml"
    workflow_path.write_text(
        """
[workflow]
id = "copy-samples"
name = "Copy Samples"

[[nodes]]
id = "copy"
type = "copy_file"
source_path = "samples"
destination_path = "out/samples"
""".strip()
        + "\n"
    )
    bundle_path = tmp_path / "copy-samples.zip"
    export_workflow_bundle(workflow_path, bundle_path)
    (target_dir / "samples").mkdir(parents=True)
    (target_dir / "samples" / "one.txt").write_text("existing\n")

    plan = preview_workflow_bundle(bundle_path, data_dir=target_dir)

    assert "copy-samples.toml" in plan.files_to_create
    assert "bundle-assets/copy-samples/samples/nested/two.txt" in plan.files_to_create
    assert "bundle-assets/copy-samples/samples/one.txt" in plan.files_to_create
    assert "samples" not in plan.files_to_create
    assert "samples" not in plan.files_to_overwrite


def test_export_bundle_includes_local_vector_index_sidecar(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    target_dir = tmp_path / "target"
    source_dir.mkdir()
    (source_dir / "indexes").mkdir()
    index_path = source_dir / "indexes" / "docs.json"
    entries_path = source_dir / "indexes" / "docs.json.entries.jsonl"
    index_path.write_text(
        json.dumps(
            {
                "version": 1,
                "entries_file": entries_path.name,
                "entries": [],
            }
        )
        + "\n"
    )
    entries_path.write_text('{"path":"docs/a.md","text":"hello"}\n')
    workflow_path = source_dir / "search.toml"
    workflow_path.write_text(
        """
[workflow]
id = "search"
name = "Search"

[[nodes]]
id = "search"
type = "local_search"
index_path = "indexes/docs.json"
query = "hello"
""".strip()
        + "\n"
    )
    bundle_path = tmp_path / "search.zip"

    manifest = export_workflow_bundle(workflow_path, bundle_path)

    assert {item["path"] for item in manifest.included_paths} == {
        "indexes/docs.json",
        "indexes/docs.json.entries.jsonl",
    }
    with zipfile.ZipFile(bundle_path) as archive:
        assert "assets/indexes/docs.json.entries.jsonl" in archive.namelist()

    import_workflow_bundle(bundle_path, data_dir=target_dir)

    assert (target_dir / "indexes" / "docs.json").exists()
    assert (target_dir / "indexes" / "docs.json.entries.jsonl").read_text() == (
        '{"path":"docs/a.md","text":"hello"}\n'
    )


def test_export_bundle_manifest_includes_trigger_preview_data(tmp_path: Path) -> None:
    workflow_path = tmp_path / "triggered.toml"
    workflow_path.write_text(
        """
[workflow]
id = "triggered"
name = "Triggered"

[workflow.schedule]
cron_expression = "0 9 * * *"
timezone = "America/New_York"

[workflow.watch]
path = "incoming"
glob = "*.md"
mode = "fanout"

[workflow.webhooks.github]
enabled = true
source = "github"
token_env = "GITHUB_WEBHOOK_TOKEN"
fanout_path = "payload.items"
""".strip()
        + "\n"
    )

    manifest = export_workflow_bundle(workflow_path, tmp_path / "triggered.zip")

    assert manifest.triggers == [
        {"type": "schedule", "cron": "0 9 * * *", "timezone": "America/New_York"},
        {"type": "watch", "path": "incoming", "glob": "*.md", "mode": "fanout"},
        {
            "type": "webhook",
            "id": "github",
            "source": "github",
            "enabled": "true",
            "concurrencyPolicy": "allow",
            "tokenEnv": "GITHUB_WEBHOOK_TOKEN",
            "fanoutPath": "payload.items",
        },
    ]


def test_export_bundle_sanitizes_http_secret_fields(tmp_path: Path) -> None:
    workflow_path = tmp_path / "http.toml"
    workflow_path.write_text(
        (
            """
[workflow]
id = "http"
name = "HTTP"

[[nodes]]
id = "call"
type = "http_request"
method = "POST"
url = "https://api.example.test/items?token=real-token"
headers = { Authorization = "Bearer real-token", Accept = "application/json" }
params = { api_key = "real-api-key", query = "public" }
body = "password=body-secret visible=ok"
secret_fields = ["headers.Authorization", "json.password", "url", "api_key", "password"]
"""
            + 'json = { password = "cleartext-secret", nested = { token = "nested-token" }, '
            + 'safe = "{{secret.API_TOKEN}}" }\n'
        ).strip()
        + "\n"
    )
    bundle_path = tmp_path / "http.zip"

    manifest = export_workflow_bundle(workflow_path, bundle_path)

    assert manifest.required_secrets == [
        {"name": "API_TOKEN", "description": "Required by bundled workflow"}
    ]
    with zipfile.ZipFile(bundle_path) as archive:
        bundled_workflow = archive.read("workflow.toml").decode("utf-8")

    assert "Bearer real-token" not in bundled_workflow
    assert "token=real-token" not in bundled_workflow
    assert "cleartext-secret" not in bundled_workflow
    assert "nested-token" not in bundled_workflow
    assert "real-api-key" not in bundled_workflow
    assert "body-secret" not in bundled_workflow
    assert "{{secret.API_TOKEN}}" in bundled_workflow


def test_export_bundle_sanitizes_default_http_secret_field_names(tmp_path: Path) -> None:
    workflow_path = tmp_path / "http-defaults.toml"
    workflow_path.write_text(
        """
[workflow]
id = "http-defaults"
name = "HTTP Defaults"

[[nodes]]
id = "call"
type = "http_request"
url = "https://api.example.test/items?token=query-secret&visible=ok"
headers = { Authorization = "Bearer header-secret", Accept = "application/json" }
params = { password = "param-secret", query = "public" }
json = { secret = "json-secret", safe = "public" }
""".strip()
        + "\n"
    )
    bundle_path = tmp_path / "http-defaults.zip"

    export_workflow_bundle(workflow_path, bundle_path)

    with zipfile.ZipFile(bundle_path) as archive:
        bundled_workflow = archive.read("workflow.toml").decode("utf-8")

    assert "query-secret" not in bundled_workflow
    assert "Bearer header-secret" not in bundled_workflow
    assert "param-secret" not in bundled_workflow
    assert "json-secret" not in bundled_workflow
    assert "visible=ok" in bundled_workflow
    assert "query = \"public\"" in bundled_workflow
    assert "safe = \"public\"" in bundled_workflow


def test_export_bundle_sanitizes_agent_and_node_env_secrets(tmp_path: Path) -> None:
    workflow_path = tmp_path / "env-secrets.toml"
    workflow_path.write_text(
        """
[workflow]
id = "env-secrets"
name = "Env Secrets"

[agents.bot]
subscription = "codex"
working_dir = "."
env = { OPENAI_API_KEY = "sk-real-secret", DEBUG = "true" }

[[nodes]]
id = "run"
type = "shell_script"
script_path = "run.sh"
env = { PASSWORD = "cleartext-password", LOG_LEVEL = "info" }
""".strip()
        + "\n"
    )
    (tmp_path / "run.sh").write_text("echo ok\n")
    bundle_path = tmp_path / "env-secrets.zip"

    manifest = export_workflow_bundle(workflow_path, bundle_path)

    assert manifest.required_secrets == [
        {"name": "OPENAI_API_KEY", "description": "Required by bundled workflow"},
        {"name": "PASSWORD", "description": "Required by bundled workflow"},
    ]
    with zipfile.ZipFile(bundle_path) as archive:
        bundled_workflow = archive.read("workflow.toml").decode("utf-8")

    assert "sk-real-secret" not in bundled_workflow
    assert "cleartext-password" not in bundled_workflow
    assert 'OPENAI_API_KEY = "***"' in bundled_workflow
    assert 'PASSWORD = "***"' in bundled_workflow
    assert 'DEBUG = "true"' in bundled_workflow
    assert 'LOG_LEVEL = "info"' in bundled_workflow


def test_import_bundle_rejects_unsafe_archive_entries(tmp_path: Path) -> None:
    bundle_path = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(bundle_path, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "formatVersion": 1,
                    "workflow": {"id": "unsafe", "name": "Unsafe"},
                    "includedPaths": [],
                    "requiredSecrets": [],
                    "providerAssumptions": [],
                    "externalRequirements": [],
                }
            ),
        )
        archive.writestr("workflow.toml", '[workflow]\nid = "unsafe"\nname = "Unsafe"\n')
        archive.writestr("../outside.txt", "nope")

    with pytest.raises(BundleError, match="Unsafe bundle path"):
        preview_workflow_bundle(bundle_path, data_dir=tmp_path / "target")

    assert not (tmp_path / "outside.txt").exists()
