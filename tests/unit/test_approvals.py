from __future__ import annotations

import pytest

from gofer.core.approvals import DesktopNotificationAdapter, Notification


@pytest.mark.asyncio
async def test_desktop_notification_adapter_sends_windows_notification(monkeypatch) -> None:
    calls = []

    async def fake_run_subprocess(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return 0, "", ""

    def fake_which(binary):
        if binary == "powershell.exe":
            return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        return None

    monkeypatch.setattr("gofer.core.approvals.sys.platform", "win32")
    monkeypatch.setattr("gofer.core.approvals.shutil.which", fake_which)
    monkeypatch.setattr("gofer.core.approvals.run_subprocess", fake_run_subprocess)

    await DesktopNotificationAdapter().send(
        Notification(title="Done", body="Complete", urgency="critical")
    )

    cmd, kwargs = calls[0]
    assert cmd[0].endswith("powershell.exe")
    assert "-STA" in cmd
    assert "-NoProfile" in cmd
    script = cmd[cmd.index("-Command") + 1]
    assert "$displayMilliseconds = 5000" in script
    assert "ShowBalloonTip($displayMilliseconds)" in script
    assert "Start-Sleep -Milliseconds $displayMilliseconds" in script
    assert kwargs["env"] == {
        "GOFER_NOTIFICATION_TITLE": "Done",
        "GOFER_NOTIFICATION_BODY": "Complete",
        "GOFER_NOTIFICATION_URGENCY": "critical",
    }


@pytest.mark.asyncio
async def test_desktop_notification_adapter_requires_powershell_on_windows(monkeypatch) -> None:
    monkeypatch.setattr("gofer.core.approvals.sys.platform", "win32")
    monkeypatch.setattr("gofer.core.approvals.shutil.which", lambda _binary: None)

    with pytest.raises(RuntimeError, match="PowerShell"):
        await DesktopNotificationAdapter().send(Notification(title="Done", body="Complete"))


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
