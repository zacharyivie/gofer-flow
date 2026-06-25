from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

import anyio

from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess

ApprovalDecisionValue = Literal["approved", "rejected", "timeout"]


def _now() -> str:
    return datetime.now(UTC).astimezone().isoformat(timespec="seconds")


def _safe_part(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in "._-" else "-" for char in value)
    return safe.strip(".-") or "item"


@dataclass
class ApprovalDecision:
    decision: ApprovalDecisionValue
    decided_by: str = "unknown"
    notes: str = ""
    decided_at: str = field(default_factory=_now)

    def to_dict(self) -> dict[str, object]:
        return {
            "decision": self.decision,
            "decidedBy": self.decided_by,
            "notes": self.notes,
            "decidedAt": self.decided_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> ApprovalDecision:
        decision = str(data.get("decision", "rejected"))
        if decision not in {"approved", "rejected", "timeout"}:
            decision = "rejected"
        return cls(
            decision=decision,  # type: ignore[arg-type]
            decided_by=str(data.get("decidedBy") or data.get("decided_by") or "unknown"),
            notes=str(data.get("notes") or ""),
            decided_at=str(data.get("decidedAt") or data.get("decided_at") or _now()),
        )


@dataclass
class ApprovalRequest:
    workflow_id: str
    run_id: str
    node_id: str
    message: str
    status: Literal["pending", "decided"] = "pending"
    approvers: list[str] = field(default_factory=list)
    requested_at: str = field(default_factory=_now)
    timeout_seconds: float | None = None
    timeout_decision: Literal["reject", "timeout"] = "timeout"
    decision: ApprovalDecision | None = None
    workflow_path: str | None = None
    log_path: str | None = None
    checkpoint_path: str | None = None
    waiter_seen_at: str | None = None
    waiter_pid: int | None = None
    resume_claimed_at: str | None = None
    resume_claimed_by_pid: int | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "workflowId": self.workflow_id,
            "runId": self.run_id,
            "nodeId": self.node_id,
            "message": self.message,
            "status": self.status,
            "approvers": self.approvers,
            "requestedAt": self.requested_at,
            "timeoutSeconds": self.timeout_seconds,
            "timeoutDecision": self.timeout_decision,
            "decision": self.decision.to_dict() if self.decision is not None else None,
            "workflowPath": self.workflow_path,
            "logPath": self.log_path,
            "checkpointPath": self.checkpoint_path,
            "waiterSeenAt": self.waiter_seen_at,
            "waiterPid": self.waiter_pid,
            "resumeClaimedAt": self.resume_claimed_at,
            "resumeClaimedByPid": self.resume_claimed_by_pid,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> ApprovalRequest:
        decision_data = data.get("decision")
        decision = (
            ApprovalDecision.from_dict(decision_data)
            if isinstance(decision_data, dict)
            else None
        )
        approvers = data.get("approvers")
        timeout_value = data.get("timeoutSeconds")
        timeout_seconds = (
            float(timeout_value)
            if isinstance(timeout_value, (str, int, float))
            else None
        )
        timeout_decision = str(
            data.get("timeoutDecision") or data.get("timeout_decision") or "timeout"
        )
        if timeout_decision not in {"reject", "timeout"}:
            timeout_decision = "timeout"
        return cls(
            workflow_id=str(data.get("workflowId") or data.get("workflow_id") or ""),
            run_id=str(data.get("runId") or data.get("run_id") or ""),
            node_id=str(data.get("nodeId") or data.get("node_id") or ""),
            message=str(data.get("message") or ""),
            status="decided" if decision is not None else "pending",
            approvers=[str(item) for item in approvers] if isinstance(approvers, list) else [],
            requested_at=str(data.get("requestedAt") or data.get("requested_at") or _now()),
            timeout_seconds=timeout_seconds,
            timeout_decision=timeout_decision,  # type: ignore[arg-type]
            decision=decision,
            workflow_path=(
                str(data.get("workflowPath") or data.get("workflow_path") or "")
                or None
            ),
            log_path=str(data.get("logPath") or data.get("log_path") or "") or None,
            checkpoint_path=(
                str(data.get("checkpointPath") or data.get("checkpoint_path") or "")
                or None
            ),
            waiter_seen_at=(
                str(data.get("waiterSeenAt") or data.get("waiter_seen_at") or "")
                or None
            ),
            waiter_pid=(
                int(waiter_pid)
                if isinstance(
                    waiter_pid := (data.get("waiterPid") or data.get("waiter_pid")),
                    (str, int),
                )
                and str(waiter_pid).isdigit()
                else None
            ),
            resume_claimed_at=(
                str(data.get("resumeClaimedAt") or data.get("resume_claimed_at") or "")
                or None
            ),
            resume_claimed_by_pid=(
                int(resume_pid)
                if isinstance(
                    resume_pid := (
                        data.get("resumeClaimedByPid")
                        or data.get("resume_claimed_by_pid")
                    ),
                    (str, int),
                )
                and str(resume_pid).isdigit()
                else None
            ),
        )


class ApprovalStore:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.base_dir = data_dir or get_data_dir()

    def request_path(self, workflow_id: str, run_id: str, node_id: str) -> Path:
        return (
            self.base_dir
            / "approvals"
            / _safe_part(workflow_id)
            / _safe_part(run_id)
            / f"{_safe_part(node_id)}.json"
        )

    def create_or_update(self, request: ApprovalRequest) -> Path:
        path = self.request_path(request.workflow_id, request.run_id, request.node_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = self.get(request.workflow_id, request.run_id, request.node_id)
        if existing is not None and existing.decision is not None:
            request.decision = existing.decision
            request.status = "decided"
        path.write_text(json.dumps(request.to_dict(), indent=2), encoding="utf-8")
        return path

    def get(
        self,
        workflow_id: str,
        run_id: str,
        node_id: str,
    ) -> ApprovalRequest | None:
        path = self.request_path(workflow_id, run_id, node_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict):
            return None
        request = ApprovalRequest.from_dict(data)
        return self._expire_if_needed(request)

    def decide(
        self,
        workflow_id: str,
        run_id: str,
        node_id: str,
        decision: ApprovalDecisionValue,
        *,
        decided_by: str = "cli",
        notes: str = "",
    ) -> ApprovalRequest:
        request = self.get(workflow_id, run_id, node_id)
        if request is None:
            raise ValueError("Pending approval not found")
        if request.decision is not None:
            raise ValueError(
                f"Approval already decided as {request.decision.decision}"
            )
        if (
            request.approvers
            and decided_by != "gofer"
            and decided_by not in request.approvers
        ):
            allowed = ", ".join(request.approvers)
            raise ValueError(
                f"Approver {decided_by!r} is not allowed; expected one of: {allowed}"
            )
        request.status = "decided"
        request.decision = ApprovalDecision(
            decision=decision,
            decided_by=decided_by,
            notes=notes,
        )
        self.create_or_update(request)
        return request

    def mark_waiting(self, workflow_id: str, run_id: str, node_id: str) -> None:
        request = self.get(workflow_id, run_id, node_id)
        if request is None:
            return
        request.waiter_seen_at = _now()
        request.waiter_pid = os.getpid()
        self.create_or_update(request)

    def claim_resume(self, workflow_id: str, run_id: str, node_id: str) -> ApprovalRequest | None:
        request = self.get(workflow_id, run_id, node_id)
        if request is None or request.decision is None:
            return None
        if request.resume_claimed_at and _pid_is_live(request.resume_claimed_by_pid):
            return None
        request.resume_claimed_at = _now()
        request.resume_claimed_by_pid = os.getpid()
        self.create_or_update(request)
        return request

    def release_resume(self, workflow_id: str, run_id: str, node_id: str) -> None:
        request = self.get(workflow_id, run_id, node_id)
        if request is None:
            return
        request.resume_claimed_at = None
        request.resume_claimed_by_pid = None
        self.create_or_update(request)

    def list_pending(self, workflow_id: str | None = None) -> list[ApprovalRequest]:
        return [
            request
            for request in self.list_requests(workflow_id)
            if request.decision is None
        ]

    def list_requests(self, workflow_id: str | None = None) -> list[ApprovalRequest]:
        root = self.base_dir / "approvals"
        if workflow_id is not None:
            roots = [root / _safe_part(workflow_id)]
        else:
            roots = sorted(root.glob("*")) if root.exists() else []
        requests: list[ApprovalRequest] = []
        for request_root in roots:
            for path in sorted(request_root.glob("*/*.json")):
                if path.name.endswith(".checkpoint.json"):
                    continue
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(data, dict):
                    continue
                request = self._expire_if_needed(ApprovalRequest.from_dict(data))
                requests.append(request)
        return requests

    def _expire_if_needed(self, request: ApprovalRequest) -> ApprovalRequest:
        if request.decision is not None or request.timeout_seconds is None:
            return request
        try:
            requested_at = datetime.fromisoformat(request.requested_at)
        except ValueError:
            return request
        now = datetime.now(requested_at.tzinfo or UTC)
        if now < requested_at + timedelta(seconds=request.timeout_seconds):
            return request
        decision: ApprovalDecisionValue = (
            "timeout" if request.timeout_decision == "timeout" else "rejected"
        )
        request.status = "decided"
        request.decision = ApprovalDecision(
            decision=decision,
            decided_by="gofer",
            notes=f"Timed out after {request.timeout_seconds} seconds",
        )
        path = self.request_path(request.workflow_id, request.run_id, request.node_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(request.to_dict(), indent=2), encoding="utf-8")
        return request


def _pid_is_live(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


@dataclass
class Notification:
    title: str
    body: str
    channel: str = "desktop"
    urgency: str = "normal"


class NotificationAdapter(Protocol):
    async def send(self, notification: Notification) -> None:
        ...


class DesktopNotificationAdapter:
    async def send(self, notification: Notification) -> None:
        if notification.channel != "desktop":
            raise ValueError(f"Unsupported notification channel: {notification.channel}")
        if sys.platform == "darwin" and shutil.which("osascript"):
            script = (
                "display notification "
                f"{json.dumps(notification.body)} with title {json.dumps(notification.title)}"
            )
            returncode, stdout, stderr = await run_subprocess(
                ["osascript", "-e", script],
                timeout=5,
            )
            if returncode != 0:
                raise RuntimeError(
                    _notification_failure_message("osascript", returncode, stdout, stderr)
                )
            return
        if sys.platform == "darwin":
            raise RuntimeError("Desktop notifications require 'osascript' on macOS.")
        if sys.platform == "win32":
            raise RuntimeError("Desktop notifications are not implemented for Windows yet.")
        if not os.environ.get("DISPLAY"):
            raise RuntimeError("Desktop notifications require DISPLAY on Unix desktop sessions.")
        notify_send = shutil.which("notify-send")
        if notify_send is None:
            raise RuntimeError(
                "Desktop notifications require 'notify-send' on Unix desktop sessions."
            )
        returncode, stdout, stderr = await run_subprocess(
            [
                notify_send,
                "-u",
                notification.urgency,
                notification.title,
                notification.body,
            ],
            timeout=5,
        )
        if returncode != 0:
            raise RuntimeError(
                _notification_failure_message("notify-send", returncode, stdout, stderr)
            )


def _notification_failure_message(
    backend: str,
    returncode: int,
    stdout: str,
    stderr: str,
) -> str:
    details = [
        f"{backend} failed to send notification",
        f"exit_code={returncode}",
    ]
    if stderr.strip():
        details.append(f"stderr={stderr.strip()}")
    if stdout.strip():
        details.append(f"stdout={stdout.strip()}")
    details.append(
        "env="
        f"DISPLAY={os.environ.get('DISPLAY') or '<unset>'}, "
        f"DBUS_SESSION_BUS_ADDRESS={os.environ.get('DBUS_SESSION_BUS_ADDRESS') or '<unset>'}, "
        f"XDG_RUNTIME_DIR={os.environ.get('XDG_RUNTIME_DIR') or '<unset>'}"
    )
    return "; ".join(details)


class RecordingNotificationAdapter:
    def __init__(self) -> None:
        self.notifications: list[Notification] = []

    async def send(self, notification: Notification) -> None:
        self.notifications.append(notification)


async def wait_for_decision(
    store: ApprovalStore,
    workflow_id: str,
    run_id: str,
    node_id: str,
    *,
    timeout_seconds: float | None,
) -> ApprovalDecision | None:
    deadline = anyio.current_time() + timeout_seconds if timeout_seconds is not None else None
    while True:
        store.mark_waiting(workflow_id, run_id, node_id)
        request = store.get(workflow_id, run_id, node_id)
        if request is not None and request.decision is not None:
            return request.decision
        if deadline is not None and anyio.current_time() >= deadline:
            return None
        await anyio.sleep(0.1)
