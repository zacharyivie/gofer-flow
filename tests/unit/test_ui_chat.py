from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.resources import ResourceLimits
from gofer.ui import chat
from gofer.ui.chat import (
    ChatProviderError,
    _build_chat_command,
    build_chat_prompt,
    ensure_local_gofer_cli,
    local_gofer_cli_path,
    provider_payload,
    run_workflow_chat,
    stream_workflow_chat,
    trusted_gofer_cli_dir,
)


def test_chat_prompt_includes_gofer_flow_skill_and_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Add a review node"}],
        workflow={
            "id": "daily",
            "name": "Daily",
            "sourcePath": "/tmp/daily.toml",
            "description": "1 nodes, 0 edges, 0 agents.",
            "nodes": [{"id": "collect", "type": "bash_command", "meta": "git status"}],
            "edges": [],
            "agents": {},
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Gofer Flow Workflow Builder" in prompt
    assert "use this exact executable path" in prompt
    assert "/tmp/gofer/bin/gof" in prompt
    assert "gof workflow validate" in prompt
    assert "Workflow: daily / Daily" in prompt
    assert "- collect (bash_command): git status" in prompt
    assert "USER: Add a review node" in prompt


def test_chat_prompt_includes_all_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Which workflow is broken?"}],
        workflow={
            "id": "workflow-assistant",
            "selectedWorkflowId": "daily",
            "workflows": [
                {
                    "id": "daily",
                    "name": "Daily",
                    "sourcePath": "/tmp/daily.toml",
                    "status": "Ready",
                    "description": "1 nodes, 0 edges, 0 agents.",
                    "nodes": [{"id": "collect", "type": "bash_command", "meta": "git status"}],
                    "edges": [],
                    "agents": {},
                },
                {
                    "id": "broken",
                    "name": "Broken",
                    "sourcePath": "/tmp/broken.toml",
                    "status": "Error",
                    "description": "Invalid workflow TOML",
                    "invalid": True,
                    "validationError": "expected table",
                },
            ],
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Selected workflow: daily" in prompt
    assert "Existing workflows: 2" in prompt
    assert "Workflow: daily / Daily [selected]" in prompt
    assert "Workflow: broken / Broken" in prompt
    assert "Validation error: expected table" in prompt


def test_chat_prompt_handles_empty_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Create my first workflow"}],
        workflow={
            "id": "workflow-assistant",
            "selectedWorkflowId": None,
            "workflows": [],
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Selected workflow: none" in prompt
    assert "Existing workflows: none" in prompt
    assert "create new Gofer Flow workflows" in prompt


def test_provider_payload_lists_codex_and_claude_code() -> None:
    providers = provider_payload()["providers"]

    assert {provider["id"] for provider in providers} == {"codex", "claude_code"}
    assert all("available" in provider for provider in providers)
    assert all(provider["models"] for provider in providers)


def test_ensure_local_gofer_cli_copies_source_binary(monkeypatch, tmp_path) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho gof\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)
    data_dir = tmp_path / "gofer-data"

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is not None
    assert copied == tmp_path / ".gofer-trusted-bin" / "gof"
    assert copied.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")
    assert copied.stat().st_mode & 0o111
    assert not copied.is_relative_to(data_dir)


def test_ensure_local_gofer_cli_preserves_windows_command_shim(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "gof.cmd"
    source.write_text("@echo off\r\necho gof\r\n", encoding="utf-8")
    monkeypatch.setattr(chat.sys, "platform", "win32")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(tmp_path / "gofer-data")

    assert copied is not None
    assert copied == tmp_path / ".gofer-trusted-bin" / "gof.cmd"
    assert copied.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")


def test_ensure_local_gofer_cli_does_not_reuse_existing_helper_without_source(
    monkeypatch,
    tmp_path,
) -> None:
    data_dir = tmp_path / "gofer-data"
    old_data_dir_helper = data_dir / "bin" / "gof"
    old_data_dir_helper.parent.mkdir(parents=True)
    old_data_dir_helper.write_text("#!/bin/sh\necho planted\n", encoding="utf-8")
    planted_trusted_helper = local_gofer_cli_path(data_dir)
    planted_trusted_helper.parent.mkdir(parents=True)
    planted_trusted_helper.write_text("#!/bin/sh\necho trusted-planted\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: tmp_path / "missing-gof")

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is None
    assert old_data_dir_helper.read_text(encoding="utf-8") == "#!/bin/sh\necho planted\n"
    assert (
        planted_trusted_helper.read_text(encoding="utf-8")
        == "#!/bin/sh\necho trusted-planted\n"
    )


def test_ensure_local_gofer_cli_does_not_reuse_helper_when_source_is_unknown(
    monkeypatch,
    tmp_path,
) -> None:
    data_dir = tmp_path / "gofer-data"
    planted = local_gofer_cli_path(data_dir)
    planted.parent.mkdir(parents=True)
    planted.write_text("#!/bin/sh\necho planted\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: None)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is None
    assert planted.read_text(encoding="utf-8") == "#!/bin/sh\necho planted\n"


def test_ensure_local_gofer_cli_rejects_source_inside_data_dir(
    monkeypatch,
    tmp_path,
) -> None:
    data_dir = tmp_path / "gofer-data"
    planted_source = data_dir / "bin" / "gof"
    planted_source.parent.mkdir(parents=True)
    planted_source.write_text("#!/bin/sh\necho planted\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: planted_source)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is None
    assert not local_gofer_cli_path(data_dir, planted_source).exists()


def test_ensure_local_gofer_cli_replaces_tampered_helper_by_hash(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    tampered = local_gofer_cli_path(data_dir, source)
    tampered.parent.mkdir(parents=True)
    tampered.write_text("#!/bin/sh\necho planted\n", encoding="utf-8")
    source_stat = source.stat()
    tampered.chmod(source_stat.st_mode)
    chat.os.utime(tampered, (source_stat.st_atime, source_stat.st_mtime))
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is not None
    assert copied == tampered
    assert copied.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")


def test_ensure_local_gofer_cli_keeps_matching_helper_by_hash(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    existing = local_gofer_cli_path(data_dir, source)
    existing.parent.mkdir(parents=True)
    existing.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    old_mtime = 1_700_000_000
    chat.os.utime(existing, (old_mtime, old_mtime))
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is not None
    assert copied == existing
    assert int(copied.stat().st_mtime) == old_mtime


def test_ensure_local_gofer_cli_sets_owner_only_permissions(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(tmp_path / "gofer-data")

    assert copied is not None
    if chat.sys.platform != "win32":
        assert copied.parent.stat().st_mode & 0o777 == 0o700
        assert copied.stat().st_mode & 0o777 == 0o700


def test_ensure_local_gofer_cli_fails_closed_when_permissions_cannot_be_hardened(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)
    monkeypatch.setattr(chat, "_ensure_owner_only_dir", lambda _path: False)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is None
    assert not local_gofer_cli_path(data_dir, source).exists()


def test_ensure_local_gofer_cli_fails_closed_when_directory_chmod_fails(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    helper_dir = trusted_gofer_cli_dir(data_dir)
    original_chmod = chat.Path.chmod

    def chmod(path: Path, mode: int) -> None:
        if path == helper_dir:
            raise OSError("chmod denied")
        original_chmod(path, mode)

    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)
    monkeypatch.setattr(chat.Path, "chmod", chmod)

    copied = ensure_local_gofer_cli(data_dir)
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Validate the workflow"}],
        workflow=None,
        gofer_cli_path=copied,
    )

    assert copied is None
    assert not local_gofer_cli_path(data_dir, source).exists()
    assert "CLI automation is unavailable" in prompt


def test_ensure_local_gofer_cli_fails_closed_when_file_permissions_cannot_be_hardened(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)
    monkeypatch.setattr(chat, "_make_owner_executable", lambda _path: False)

    copied = ensure_local_gofer_cli(data_dir)

    assert copied is None
    assert not local_gofer_cli_path(data_dir, source).exists()


def test_ensure_local_gofer_cli_fails_closed_when_file_chmod_fails(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho trusted\n", encoding="utf-8")
    data_dir = tmp_path / "gofer-data"
    helper = local_gofer_cli_path(data_dir, source)
    original_chmod = chat.Path.chmod

    def chmod(path: Path, mode: int) -> None:
        if path == helper or path.name == f".{helper.name}.tmp":
            raise OSError("chmod denied")
        original_chmod(path, mode)

    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)
    monkeypatch.setattr(chat.Path, "chmod", chmod)

    copied = ensure_local_gofer_cli(data_dir)
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Validate the workflow"}],
        workflow=None,
        gofer_cli_path=copied,
    )

    assert copied is None
    assert not helper.exists()
    assert "CLI automation is unavailable" in prompt


def test_gofer_cli_source_path_uses_packaged_executable(monkeypatch, tmp_path) -> None:
    packaged = tmp_path / "Gofer"
    packaged.write_text("binary", encoding="utf-8")
    monkeypatch.delenv("GOFER_CLI_SOURCE_PATH", raising=False)
    monkeypatch.setattr(chat.sys, "frozen", True, raising=False)
    monkeypatch.setattr(chat.sys, "executable", str(packaged))

    assert chat._gofer_cli_source_path() == packaged


def test_build_chat_prompt_reports_cli_unavailable_when_helper_is_unverified() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Validate the workflow"}],
        workflow=None,
        gofer_cli_path=None,
    )

    assert "CLI automation is unavailable" in prompt
    assert "Do not run a stale helper" in prompt


def test_build_chat_command_passes_model_flags() -> None:
    codex = _build_chat_command(
        "codex",
        "gpt-5",
        "hello",
        data_dir=Path("/tmp/gofer-data"),
        working_dir=Path("/tmp/project"),
    )
    claude = _build_chat_command(
        "claude_code",
        "sonnet",
        "hello",
        data_dir=Path("/tmp/gofer-data"),
    )

    assert codex[:2] == ["codex", "exec"]
    assert "--ask-for-approval" not in codex
    assert "--skip-git-repo-check" in codex
    assert option_value(codex, "--sandbox") == "workspace-write"
    assert option_value(codex, "--cd") == "/tmp/project"
    assert option_value(codex, "--add-dir") == "/tmp/gofer-data"
    assert str(trusted_gofer_cli_dir(Path("/tmp/gofer-data"))) not in codex
    assert ["--model", "gpt-5"] == codex[-3:-1]
    assert codex[-1] == "hello"
    assert claude == [
        "claude",
        "--print",
        "--add-dir",
        "/tmp/gofer-data",
        "-p",
        "hello",
        "--model",
        "sonnet",
    ]


def test_build_chat_command_uses_resolved_binary_paths() -> None:
    codex = _build_chat_command(
        "codex",
        "cli-default",
        "hello",
        binary_path=r"C:\Users\me\AppData\Roaming\npm\codex.cmd",
        data_dir=Path(r"C:\Users\me\AppData\Roaming\gofer"),
        working_dir=Path(r"C:\project"),
    )
    claude = _build_chat_command(
        "claude_code",
        "cli-default",
        "hello",
        binary_path=r"C:\Users\me\AppData\Roaming\npm\claude.cmd",
        data_dir=Path(r"C:\Users\me\AppData\Roaming\gofer"),
    )

    assert codex[0] == r"C:\Users\me\AppData\Roaming\npm\codex.cmd"
    assert claude[0] == r"C:\Users\me\AppData\Roaming\npm\claude.cmd"
    assert option_value(claude, "--add-dir") == r"C:\Users\me\AppData\Roaming\gofer"


@pytest.mark.asyncio
async def test_run_workflow_chat_adds_trusted_workflow_paths_to_provider_sandbox(
    monkeypatch,
    tmp_path,
) -> None:
    captured_command = None
    data_dir = tmp_path / "gofer-data"
    trusted_dir = tmp_path / "trusted"
    trusted_dir.mkdir()
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def capture_subprocess(command, **_kwargs):
        nonlocal captured_command
        captured_command = command
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "hello"}],
        workflow={
            "id": "trusted",
            "filesystemAccess": [
                {"path": str(trusted_dir), "read": True, "write": True},
                {"path": str(tmp_path / "read-only"), "read": True, "write": False},
            ],
        },
        working_dir=tmp_path,
        data_dir=data_dir,
    )

    assert captured_command is not None
    assert str(data_dir.resolve()) in option_values(captured_command, "--add-dir")
    assert str(trusted_dir.resolve()) in option_values(captured_command, "--add-dir")
    assert str((tmp_path / "read-only").resolve()) not in option_values(
        captured_command,
        "--add-dir",
    )


@pytest.mark.asyncio
async def test_run_workflow_chat_reports_process_launch_errors(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: r"C:\missing\codex.cmd")

    async def fail_to_spawn(*_args, **_kwargs):
        raise FileNotFoundError("missing codex")

    monkeypatch.setattr(chat, "run_subprocess", fail_to_spawn)

    with pytest.raises(ChatProviderError, match="Could not start 'codex' CLI"):
        await run_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )


@pytest.mark.asyncio
async def test_run_workflow_chat_defaults_working_dir_to_data_dir(monkeypatch, tmp_path) -> None:
    captured_command = None
    captured_cwd = None
    data_dir = tmp_path / "gofer-data"
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")
    monkeypatch.setattr(chat.Path, "cwd", lambda: Path("/tmp/.mount_Gofer-read-only"))

    async def capture_subprocess(command, **kwargs):
        nonlocal captured_command, captured_cwd
        captured_command = command
        captured_cwd = kwargs.get("cwd")
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "hello"}],
        workflow=None,
        data_dir=data_dir,
    )

    assert captured_command is not None
    assert option_value(captured_command, "--cd") == str(data_dir)
    assert captured_cwd == data_dir
    assert data_dir.exists()


@pytest.mark.asyncio
async def test_run_workflow_chat_uses_workflow_resource_limits(
    monkeypatch,
    tmp_path,
) -> None:
    captured_max_output_bytes = None
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def capture_subprocess(_command, **kwargs):
        nonlocal captured_max_output_bytes
        captured_max_output_bytes = kwargs.get("max_output_bytes")
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "hello"}],
        workflow={
            "id": "limited",
            "resourceLimits": {
                "max_subprocess_output_bytes": 7,
                "max_chat_prompt_bytes": 1_000_000,
            },
        },
        working_dir=tmp_path,
        data_dir=tmp_path,
        resource_limits=ResourceLimits(max_subprocess_output_bytes=99),
    )

    assert captured_max_output_bytes == 7


@pytest.mark.asyncio
async def test_run_workflow_chat_rejects_oversized_prompt_before_provider(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fail_if_called(*_args, **_kwargs):
        raise AssertionError("provider subprocess should not be invoked")

    monkeypatch.setattr(chat, "run_subprocess", fail_if_called)

    with pytest.raises(ChatProviderError, match="Chat prompt exceeds limit 8 bytes"):
        await run_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow={"id": "limited", "resourceLimits": {"max_chat_prompt_bytes": 8}},
            working_dir=tmp_path,
            data_dir=tmp_path,
            resource_limits=ResourceLimits(max_chat_prompt_bytes=1_000_000),
        )


@pytest.mark.asyncio
async def test_run_workflow_chat_uses_prompt_file_for_windows_codex_shim(
    monkeypatch,
    tmp_path,
) -> None:
    captured_command = None
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: r"C:\Users\me\AppData\npm\codex.cmd")

    async def capture_subprocess(command, **_kwargs):
        nonlocal captured_command
        captured_command = command
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Create workflow\nwith two nodes"}],
        workflow={"id": "demo-flow", "name": "Demo Flow"},
        working_dir=tmp_path,
        data_dir=tmp_path,
    )

    assert captured_command is not None
    prompt_arg = captured_command[-1]
    assert "Read the complete Gofer Flow assistant prompt" in prompt_arg
    assert "Create workflow with two nodes" in prompt_arg
    assert "\n" not in prompt_arg

    prompt_files = list((tmp_path / ".gofer-chat-prompts").glob("*.md"))
    assert len(prompt_files) == 1
    prompt_text = prompt_files[0].read_text(encoding="utf-8")
    assert "You are the Gofer Flow workflow assistant." in prompt_text
    assert "USER: Create workflow\nwith two nodes" in prompt_text

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Now add review"}],
        workflow={"id": "demo-flow", "name": "Demo Flow"},
        working_dir=tmp_path,
        data_dir=tmp_path,
    )

    prompt_files = list((tmp_path / ".gofer-chat-prompts").glob("*.md"))
    assert len(prompt_files) == 1
    prompt_text = prompt_files[0].read_text(encoding="utf-8")
    assert "USER: Now add review" in prompt_text
    assert "USER: Create workflow\nwith two nodes" not in prompt_text


@pytest.mark.asyncio
async def test_stream_workflow_chat_yields_thoughts_and_final(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stdout", "text": "working\n", "returncode": None}
        yield {"type": "chunk", "stream": "stderr", "text": "checking files\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert [event["type"] for event in events] == ["thought", "thought", "final"]
    assert events[0]["text"] == "working\n"
    assert events[1]["stream"] == "stderr"
    assert events[2]["message"]["body"] == "working\n"


@pytest.mark.asyncio
async def test_stream_workflow_chat_rejects_oversized_prompt_before_provider(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fail_if_called(*_args, **_kwargs):
        raise AssertionError("provider subprocess should not be invoked")
        yield {}

    monkeypatch.setattr(chat, "stream_subprocess", fail_if_called)

    with pytest.raises(ChatProviderError, match="Chat prompt exceeds limit 8 bytes"):
        async for _event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow={"id": "limited", "resourceLimits": {"max_chat_prompt_bytes": 8}},
            working_dir=tmp_path,
            data_dir=tmp_path,
            resource_limits=ResourceLimits(max_chat_prompt_bytes=1_000_000),
        ):
            pass


@pytest.mark.asyncio
async def test_stream_workflow_chat_compacts_long_context(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")
    monkeypatch.setattr(chat, "CHAT_COMPACT_CHAR_LIMIT", 20)

    async def fake_run_subprocess(*_args, **_kwargs):
        return 0, "short workflow assistant summary", ""

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stdout", "text": "final\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(chat, "run_subprocess", fake_run_subprocess)
    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[
                {"role": "user", "body": "older " * 20},
                {"role": "assistant", "body": "older answer " * 20},
                {"role": "user", "body": "latest"},
            ],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert [event["type"] for event in events] == ["compaction", "thought", "final"]
    assert events[0]["message"] == "Compacting workflow assistant context"
    compacted_messages = events[0]["messages"]
    assert compacted_messages[0]["kind"] == "system"
    assert compacted_messages[0]["body"] == "Compacting workflow assistant context"
    assert compacted_messages[1]["kind"] == "memory"
    assert "short workflow assistant summary" in compacted_messages[1]["body"]
    assert compacted_messages[-1]["body"] == "latest"


@pytest.mark.asyncio
async def test_stream_workflow_chat_passes_cancel_event(monkeypatch, tmp_path) -> None:
    captured_cancel_event = None
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **kwargs):
        nonlocal captured_cancel_event
        captured_cancel_event = kwargs.get("cancel_event")
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            cancel_event=object(),
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert captured_cancel_event is not None
    assert events[-1]["type"] == "final"


@pytest.mark.asyncio
async def test_stream_workflow_chat_yields_error_on_nonzero_exit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stderr", "text": "nope\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 2}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert [event["type"] for event in events] == ["thought", "error"]
    assert events[-1]["error"] == "nope\n"


def option_value(command: list[str], option: str) -> str:
    return command[command.index(option) + 1]


def option_values(command: list[str], option: str) -> list[str]:
    return [command[index + 1] for index, value in enumerate(command[:-1]) if value == option]
