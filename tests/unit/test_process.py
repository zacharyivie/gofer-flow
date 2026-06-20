from __future__ import annotations

import sys

import pytest

from gofer.utils.process import stream_subprocess


@pytest.mark.asyncio
async def test_stream_subprocess_timeout_yields_nonzero_exit() -> None:
    events = [
        event
        async for event in stream_subprocess(
            [
                sys.executable,
                "-c",
                "import time; print('started', flush=True); time.sleep(5)",
            ],
            timeout=0.1,
        )
    ]

    assert any(event["text"] == "started\n" for event in events)
    assert any("Process timed out after" in event["text"] for event in events)
    assert events[-1]["type"] == "exit"
    assert events[-1]["returncode"] == 124
