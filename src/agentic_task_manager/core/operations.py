from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class OperationType(StrEnum):
    PYTHON_SCRIPT = "python_script"
    SHELL_SCRIPT = "shell_script"
    BASH_COMMAND = "bash_command"
    AGENT = "agent"


class CountFanSource(BaseModel):
    type: Literal["count"]
    count: int | str = 1
    max_concurrency: int = 16
    fail_fast: bool = False


class TabularFanSource(BaseModel):
    type: Literal["tabular"]
    path: Path
    max_concurrency: int = 16
    fail_fast: bool = False


class DirectoryFanSource(BaseModel):
    type: Literal["directory"]
    path: Path
    glob: str = "*"
    include_content: bool = False
    max_concurrency: int = 16
    fail_fast: bool = False


FanSource = Annotated[
    CountFanSource | TabularFanSource | DirectoryFanSource,
    Field(discriminator="type"),
]


class PythonScriptOperation(BaseModel):
    type: Literal[OperationType.PYTHON_SCRIPT]
    script_path: Path
    args: list[str] = []
    env: dict[str, str] = {}


class ShellScriptOperation(BaseModel):
    type: Literal[OperationType.SHELL_SCRIPT]
    script_path: Path
    args: list[str] = []
    env: dict[str, str] = {}


class BashCommandOperation(BaseModel):
    type: Literal[OperationType.BASH_COMMAND]
    command: str
    working_dir: Path | None = None
    env: dict[str, str] = {}


class AgentOperation(BaseModel):
    type: Literal[OperationType.AGENT]
    agent_id: str
    prompt_path: Path
    working_dir: Path
    dynamic_count: int | str = 1
    input_mapping: dict[str, str] = {}
    fan_source: FanSource | None = None


Operation = Annotated[
    PythonScriptOperation | ShellScriptOperation | BashCommandOperation | AgentOperation,
    Field(discriminator="type"),
]
