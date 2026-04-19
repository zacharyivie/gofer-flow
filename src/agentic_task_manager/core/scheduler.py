from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.utils.logging import get_logger

log = get_logger(__name__)


def _run_workflow(workflow_id: str, workflow_path: str, subscriptions: dict[str, Any]) -> None:
    wf = AgenticWorkflow.from_file(Path(workflow_path))
    from agentic_task_manager.core.executor import WorkflowExecutor

    async def _exec() -> None:
        executor = WorkflowExecutor(wf, subscriptions)
        result = await executor.run()
        log.info("Workflow %s finished: success=%s", workflow_id, result.success)

    asyncio.run(_exec())


class WorkflowScheduler:
    def __init__(self, db_path: Path | None = None) -> None:
        db_url = f"sqlite:///{db_path}" if db_path else "sqlite:///:memory:"
        jobstore = SQLAlchemyJobStore(url=db_url)
        self._scheduler = BackgroundScheduler(jobstores={"default": jobstore})
        self._workflow_paths: dict[str, str] = {}

    def add_workflow(self, workflow: AgenticWorkflow, workflow_path: Path) -> None:
        if workflow.config.schedule is None:
            raise ValueError(f"Workflow '{workflow.config.id}' has no schedule configured")

        sched = workflow.config.schedule
        trigger = CronTrigger.from_crontab(sched.cron_expression, timezone=sched.timezone)
        job_id = f"workflow:{workflow.config.id}"
        self._workflow_paths[workflow.config.id] = str(workflow_path)

        # Start transiently so jobs persist to the SQLAlchemy store immediately
        started_here = False
        if not self._scheduler.running:
            self._scheduler.start(paused=True)
            started_here = True

        # Remove first so replace works regardless of scheduler running state
        try:
            self._scheduler.remove_job(job_id)
        except Exception:
            pass

        self._scheduler.add_job(
            _run_workflow,
            trigger=trigger,
            id=job_id,
            name=workflow.config.name,
            args=[workflow.config.id, str(workflow_path), {}],
            coalesce=True,
            max_instances=1,
        )

        if started_here:
            self._scheduler.shutdown(wait=False)

        log.info("Scheduled workflow '%s' cron='%s'", workflow.config.id, sched.cron_expression)

    def remove_workflow(self, workflow_id: str) -> None:
        job_id = f"workflow:{workflow_id}"
        started_here = False
        if not self._scheduler.running:
            self._scheduler.start(paused=True)
            started_here = True
        try:
            self._scheduler.remove_job(job_id)
        finally:
            if started_here:
                self._scheduler.shutdown(wait=False)

    def list_workflows(self) -> list[dict[str, str]]:
        started_here = False
        if not self._scheduler.running:
            self._scheduler.start(paused=True)
            started_here = True
        try:
            jobs_raw = list(self._scheduler.get_jobs())
        finally:
            if started_here:
                self._scheduler.shutdown(wait=False)
        jobs = []
        for job in jobs_raw:
            jobs.append({
                "id": job.id.removeprefix("workflow:"),
                "name": job.name,
                "next_run": str(job.next_run_time) if getattr(job, "next_run_time", None)
                    else "paused",
            })
        return jobs

    def start(self) -> None:
        self._scheduler.start()

    def shutdown(self, wait: bool = True) -> None:
        self._scheduler.shutdown(wait=wait)

    def is_running(self) -> bool:
        return self._scheduler.running
