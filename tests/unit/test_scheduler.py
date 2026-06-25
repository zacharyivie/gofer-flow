from __future__ import annotations

import json
from pathlib import Path

import pytest

from gofer.core.agent import AgentConfig
from gofer.core.scheduler import WorkflowScheduler, _run_workflow
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig
from tests.conftest import FakeSubscription


def _scheduled_workflow(wf_id: str = "daily") -> AgenticWorkflow:
    return AgenticWorkflow(WorkflowConfig(
        id=wf_id,
        name="Daily Job",
        schedule=ScheduleConfig(cron_expression="0 9 * * 1-5"),
    ))


def test_add_and_list(tmp_path: Path) -> None:
    scheduler = WorkflowScheduler(db_path=tmp_path / "jobs.db")
    wf = _scheduled_workflow()
    wf_path = tmp_path / "wf.toml"
    wf_path.write_text("")  # path just needs to exist for the scheduler record
    scheduler.add_workflow(wf, wf_path)
    listed = scheduler.list_workflows()
    assert any(j["id"] == "daily" for j in listed)


def test_remove(tmp_path: Path) -> None:
    scheduler = WorkflowScheduler(db_path=tmp_path / "jobs.db")
    wf = _scheduled_workflow()
    wf_path = tmp_path / "wf.toml"
    wf_path.write_text("")
    scheduler.add_workflow(wf, wf_path)
    scheduler.remove_workflow("daily")
    assert not any(j["id"] == "daily" for j in scheduler.list_workflows())


def test_add_without_schedule_raises(tmp_path: Path) -> None:
    scheduler = WorkflowScheduler()
    wf = AgenticWorkflow(WorkflowConfig(id="no-sched", name="No Schedule"))
    with pytest.raises(ValueError, match="no schedule"):
        scheduler.add_workflow(wf, tmp_path / "wf.toml")


def test_replace_existing(tmp_path: Path) -> None:
    scheduler = WorkflowScheduler(db_path=tmp_path / "jobs.db")
    wf = _scheduled_workflow()
    wf_path = tmp_path / "wf.toml"
    wf_path.write_text("")
    scheduler.add_workflow(wf, wf_path)
    scheduler.add_workflow(wf, wf_path)  # should not raise
    assert len(scheduler.list_workflows()) == 1


def test_scheduled_execution_logs_external_agent_access(
    caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    work_dir = tmp_path / "work"
    extra_dir = tmp_path / "shared"
    work_dir.mkdir()
    extra_dir.mkdir()
    wf = _scheduled_workflow()
    wf.register_agent(
        AgentConfig(
            agent_id="reviewer",
            subscription="codex",
            working_dir=work_dir,
            extra_paths=[extra_dir],
        )
    )
    wf_path = tmp_path / "wf.toml"
    wf.to_file(wf_path)

    _run_workflow(wf.config.id, str(wf_path), {})

    assert "grants provider filesystem access outside working_dir" in caplog.text
    assert str(extra_dir) in caplog.text


def test_scheduled_execution_persists_masked_usage_sidecar(tmp_path: Path) -> None:
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text("Token: {{secret}}", encoding="utf-8")
    wf_path = tmp_path / "wf.toml"
    wf_path.write_text(
        f"""
[workflow]
id = "scheduled-usage"
name = "Scheduled Usage"

[[nodes]]
id = "ask"
type = "agent"
agent_id = "assistant"
working_dir = "."
prompt_path = "{prompt_path}"

[agents.assistant]
subscription = "codex"
working_dir = "."
""".lstrip(),
        encoding="utf-8",
    )

    _run_workflow(
        "scheduled-usage",
        str(wf_path),
        {"codex": FakeSubscription(output="done")},
    )

    sidecars = list((tmp_path / "logs" / "scheduled-usage").glob("*.outputs.json"))
    assert len(sidecars) == 1
    payload = json.loads(sidecars[0].read_text(encoding="utf-8"))
    assert payload["usageSummary"]["totals"]["agent_calls"] == 1
    assert payload["nodeOutputs"]["ask"]["data"]["prompt"] == "***"
    assert "Token:" not in sidecars[0].read_text(encoding="utf-8")
