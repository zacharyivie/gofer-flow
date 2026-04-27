from __future__ import annotations

from pathlib import Path

from gofer.core.scheduler import WorkflowScheduler
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig


def test_add_list_remove_lifecycle(tmp_path: Path) -> None:
    db = tmp_path / "sched.db"
    scheduler = WorkflowScheduler(db_path=db)

    wf = AgenticWorkflow(WorkflowConfig(
        id="lifecycle",
        name="Lifecycle Test",
        schedule=ScheduleConfig(cron_expression="*/5 * * * *"),
    ))
    wf_path = tmp_path / "lifecycle.toml"
    wf_path.write_text("")

    scheduler.add_workflow(wf, wf_path)
    jobs = scheduler.list_workflows()
    assert any(j["id"] == "lifecycle" for j in jobs)

    scheduler.remove_workflow("lifecycle")
    jobs = scheduler.list_workflows()
    assert not any(j["id"] == "lifecycle" for j in jobs)
