from __future__ import annotations

from collections.abc import AsyncIterator
import os
import threading
import time
from typing import Literal, TypedDict

import anyio
import anyio.abc


class ProcessStreamEvent(TypedDict):
    type: Literal["chunk", "exit"]
    stream: Literal["stdout", "stderr"] | None
    text: str
    returncode: int | None


class ProcessError(Exception):
    def __init__(self, returncode: int, stderr: str) -> None:
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"Process exited with code {returncode}: {stderr[:200]}")


async def run_subprocess(
    cmd: list[str],
    *,
    cancel_event: threading.Event | None = None,
    cwd: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    stdin: bytes | None = None,
) -> tuple[int, str, str]:
    """Run a subprocess and return (returncode, stdout, stderr)."""
    merged_env = {**os.environ, **(env or {})}

    async def _run() -> tuple[int, str, str]:
        if cancel_event is not None:
            return await _run_cancellable_process(
                cmd,
                cancel_event=cancel_event,
                cwd=cwd,
                env=merged_env,
                stdin=stdin,
            )

        result = await anyio.run_process(
            cmd,
            cwd=cwd,
            env=merged_env,
            check=False,
            input=stdin,
        )
        return (
            result.returncode,
            result.stdout.decode(errors="replace"),
            result.stderr.decode(errors="replace"),
        )

    if timeout is not None:
        with anyio.fail_after(timeout):
            return await _run()
    return await _run()


async def stream_subprocess(
    cmd: list[str],
    *,
    cancel_event: threading.Event | None = None,
    cwd: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
    stdin: bytes | None = None,
) -> AsyncIterator[ProcessStreamEvent]:
    """Run a subprocess and yield stdout/stderr chunks as they arrive."""
    merged_env = {**os.environ, **(env or {})}

    async def _stream() -> AsyncIterator[ProcessStreamEvent]:
        process = await anyio.open_process(cmd, cwd=cwd, env=merged_env)
        deadline = time.monotonic() + timeout if timeout is not None else None

        if process.stdin is not None:
            if stdin:
                await process.stdin.send(stdin)
            await process.stdin.aclose()

        send, receive = anyio.create_memory_object_stream[ProcessStreamEvent](100)
        stream_done_count = 0
        exited = False
        returncode: int | None = None

        async def read_stream(
            stream_name: Literal["stdout", "stderr"],
            stream: anyio.abc.ByteReceiveStream | None,
        ) -> None:
            if stream is None:
                await send.send({
                    "type": "exit",
                    "stream": stream_name,
                    "text": "",
                    "returncode": None,
                })
                return
            while True:
                try:
                    chunk = await stream.receive()
                except anyio.EndOfStream:
                    break
                if not chunk:
                    break
                await send.send({
                    "type": "chunk",
                    "stream": stream_name,
                    "text": chunk.decode(errors="replace"),
                    "returncode": None,
                })
            await send.send({
                "type": "exit",
                "stream": stream_name,
                "text": "",
                "returncode": None,
            })

        async def wait_for_process() -> None:
            nonlocal returncode
            stopped = False
            timed_out = False
            while process.returncode is None:
                if cancel_event is not None and cancel_event.is_set():
                    stopped = True
                    process.terminate()
                    with anyio.move_on_after(1):
                        await process.wait()
                    if process.returncode is None:
                        process.kill()
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    timed_out = True
                    process.terminate()
                    with anyio.move_on_after(1):
                        await process.wait()
                    if process.returncode is None:
                        process.kill()
                    break
                with anyio.move_on_after(0.1):
                    await process.wait()
            await process.wait()
            returncode = process.returncode if process.returncode is not None else 130
            if timed_out:
                returncode = 124
            if stopped:
                await send.send({
                    "type": "chunk",
                    "stream": "stderr",
                    "text": "Process stopped by user\n",
                    "returncode": None,
                })
            if timed_out:
                await send.send({
                    "type": "chunk",
                    "stream": "stderr",
                    "text": f"Process timed out after {timeout:g} seconds\n",
                    "returncode": None,
                })
            await send.send({
                "type": "exit",
                "stream": None,
                "text": "",
                "returncode": returncode,
            })

        async with anyio.create_task_group() as tg:
            tg.start_soon(read_stream, "stdout", process.stdout)
            tg.start_soon(read_stream, "stderr", process.stderr)
            tg.start_soon(wait_for_process)
            async with receive:
                async for event in receive:
                    if event["type"] == "exit" and event["stream"] in {"stdout", "stderr"}:
                        stream_done_count += 1
                    elif event["type"] == "exit" and event["stream"] is None:
                        exited = True
                    else:
                        yield event

                    if exited and stream_done_count >= 2:
                        break
            tg.cancel_scope.cancel()

        yield {
            "type": "exit",
            "stream": None,
            "text": "",
            "returncode": returncode if returncode is not None else 130,
        }

    async for event in _stream():
        yield event


async def _run_cancellable_process(
    cmd: list[str],
    *,
    cancel_event: threading.Event,
    cwd: str | os.PathLike[str] | None,
    env: dict[str, str],
    stdin: bytes | None,
) -> tuple[int, str, str]:
    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    process = await anyio.open_process(cmd, cwd=cwd, env=env)

    async def read_stream(
        stream: anyio.abc.ByteReceiveStream | None,
        chunks: list[bytes],
    ) -> None:
        if stream is None:
            return
        while True:
            try:
                chunk = await stream.receive()
            except anyio.EndOfStream:
                return
            if not chunk:
                return
            chunks.append(chunk)

    if process.stdin is not None:
        if stdin:
            await process.stdin.send(stdin)
        await process.stdin.aclose()

    async with anyio.create_task_group() as tg:
        tg.start_soon(read_stream, process.stdout, stdout_chunks)
        tg.start_soon(read_stream, process.stderr, stderr_chunks)

        stopped = False
        while process.returncode is None:
            if cancel_event.is_set():
                stopped = True
                process.terminate()
                with anyio.move_on_after(1):
                    await process.wait()
                if process.returncode is None:
                    process.kill()
                break
            with anyio.move_on_after(0.1):
                await process.wait()

        await process.wait()

    stdout = b"".join(stdout_chunks).decode(errors="replace")
    stderr = b"".join(stderr_chunks).decode(errors="replace")
    if stopped:
        stderr = f"{stderr.rstrip()}\nProcess stopped by user".strip()
    return process.returncode if process.returncode is not None else 130, stdout, stderr
