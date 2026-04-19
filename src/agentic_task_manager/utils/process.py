from __future__ import annotations

import os

import anyio
import anyio.abc


class ProcessError(Exception):
    def __init__(self, returncode: int, stderr: str) -> None:
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"Process exited with code {returncode}: {stderr[:200]}")


async def run_subprocess(
    cmd: list[str],
    *,
    cwd: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> tuple[int, str, str]:
    """Run a subprocess and return (returncode, stdout, stderr)."""
    merged_env = {**os.environ, **(env or {})}

    async def _run() -> tuple[int, str, str]:
        result = await anyio.run_process(
            cmd,
            cwd=cwd,
            env=merged_env,
            check=False,
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
