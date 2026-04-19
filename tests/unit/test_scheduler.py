from __future__ import annotations

from pathlib import Path

import pytest

from agentic_task_manager.core.scheduler import WorkflowScheduler
from agentic_task_manager.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig


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
