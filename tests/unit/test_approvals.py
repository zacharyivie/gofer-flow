from __future__ import annotations

import pytest

from gofer.core.approvals import DesktopNotificationAdapter, Notification


@pytest.mark.asyncio
async def test_desktop_notification_adapter_fails_without_display(monkeypatch) -> None:
    monkeypatch.setattr("gofer.core.approvals.sys.platform", "linux")
    monkeypatch.delenv("DISPLAY", raising=False)

    with pytest.raises(RuntimeError, match="DISPLAY"):
        await DesktopNotificationAdapter().send(Notification(title="Done", body="Complete"))


@pytest.mark.asyncio
async def test_desktop_notification_adapter_fails_without_notify_send(monkeypatch) -> None:
    monkeypatch.setattr("gofer.core.approvals.sys.platform", "linux")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setattr("gofer.core.approvals.shutil.which", lambda _binary: None)

    with pytest.raises(RuntimeError, match="notify-send"):
        await DesktopNotificationAdapter().send(Notification(title="Done", body="Complete"))


@pytest.mark.asyncio
async def test_desktop_notification_adapter_fails_when_notify_send_fails(monkeypatch) -> None:
    async def fake_run_subprocess(*_args, **_kwargs):
        return 1, "", "cannot connect to notification daemon"

    monkeypatch.setattr("gofer.core.approvals.sys.platform", "linux")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setattr("gofer.core.approvals.shutil.which", lambda _binary: "/bin/notify-send")
    monkeypatch.setattr("gofer.core.approvals.run_subprocess", fake_run_subprocess)

    with pytest.raises(RuntimeError, match="cannot connect"):
        await DesktopNotificationAdapter().send(Notification(title="Done", body="Complete"))


@pytest.mark.asyncio
async def test_desktop_notification_failure_includes_env_when_stderr_is_empty(
    monkeypatch,
) -> None:
    async def fake_run_subprocess(*_args, **_kwargs):
        return 1, "", ""

    monkeypatch.setattr("gofer.core.approvals.sys.platform", "linux")
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
    monkeypatch.setattr("gofer.core.approvals.shutil.which", lambda _binary: "/bin/notify-send")
    monkeypatch.setattr("gofer.core.approvals.run_subprocess", fake_run_subprocess)

    with pytest.raises(RuntimeError) as exc_info:
        await DesktopNotificationAdapter().send(Notification(title="Done", body="Complete"))

    message = str(exc_info.value)
    assert "exit_code=1" in message
    assert "DISPLAY=:0" in message
    assert "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus" in message
    assert "XDG_RUNTIME_DIR=/run/user/1000" in message
