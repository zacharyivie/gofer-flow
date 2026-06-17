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
    READ_FILE = "read_file"
    WRITE_FILE = "write_file"
    COPY_FILE = "copy_file"
    MOVE_FILE = "move_file"
    DELETE_FILE = "delete_file"
    OPEN_RESOURCE = "open_resource"
    PROMPT_FILE = "prompt_file"
    COMMON_LLM_TASK = "common_llm_task"
    LOCAL_VECTORIZE = "local_vectorize"
    LOCAL_SEARCH = "local_search"


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


class TriggerEventsFanSource(BaseModel):
    type: Literal["trigger_events"]
    include_content: bool = False
    max_concurrency: int = 16
    fail_fast: bool = False


FanSource = Annotated[
    CountFanSource | TabularFanSource | DirectoryFanSource | TriggerEventsFanSource,
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


class ReadFileOperation(BaseModel):
    type: Literal[OperationType.READ_FILE]
    path: Path
    encoding: str = "utf-8"
    errors: str = "strict"


class WriteFileOperation(BaseModel):
    type: Literal[OperationType.WRITE_FILE]
    path: Path
    content: str = ""
    encoding: str = "utf-8"
    create_dirs: bool = True
    overwrite: bool = True
    append: bool = False


class CopyFileOperation(BaseModel):
    type: Literal[OperationType.COPY_FILE]
    source_path: Path
    destination_path: Path
    create_dirs: bool = True
    overwrite: bool = False


class MoveFileOperation(BaseModel):
    type: Literal[OperationType.MOVE_FILE]
    source_path: Path
    destination_path: Path
    create_dirs: bool = True
    overwrite: bool = False


class DeleteFileOperation(BaseModel):
    type: Literal[OperationType.DELETE_FILE]
    path: Path
    use_trash: bool = True
    recursive: bool = False
    missing_ok: bool = False


class OpenResourceOperation(BaseModel):
    type: Literal[OperationType.OPEN_RESOURCE]
    target: str
    resource_type: Literal["auto", "file", "folder", "url", "app"] = "auto"
    args: list[str] = []


class PromptFileOperation(BaseModel):
    type: Literal[OperationType.PROMPT_FILE]
    output_path: Path
    template: str = ""
    template_path: Path | None = None
    variables: dict[str, str] = {}
    encoding: str = "utf-8"
    create_dirs: bool = True
    overwrite: bool = True


class CommonLlmTaskOperation(BaseModel):
    type: Literal[OperationType.COMMON_LLM_TASK]
    agent_id: str
    task: Literal["review", "summarize", "explain", "extract", "rewrite", "classify"] = "summarize"
    target: str = ""
    instructions: str = ""
    working_dir: Path
    input_mapping: dict[str, str] = {}


class LocalVectorizeOperation(BaseModel):
    type: Literal[OperationType.LOCAL_VECTORIZE]
    source_path: Path
    index_path: Path
    glob: str = "**/*"
    recursive: bool = True
    chunk_size: int = 1200
    chunk_overlap: int = 120
    encoding: str = "utf-8"


class LocalSearchOperation(BaseModel):
    type: Literal[OperationType.LOCAL_SEARCH]
    index_path: Path
    query: str
    top_k: int = 5


class AgentOperation(BaseModel):
    type: Literal[OperationType.AGENT]
    agent_id: str
    prompt_path: Path | None = None
    working_dir: Path
    skill_name: str | None = None
    dynamic_count: int | str = 1
    input_mapping: dict[str, str] = {}
    fan_source: FanSource | None = None


Operation = Annotated[
    PythonScriptOperation
    | ShellScriptOperation
    | BashCommandOperation
    | ReadFileOperation
    | WriteFileOperation
    | CopyFileOperation
    | MoveFileOperation
    | DeleteFileOperation
    | OpenResourceOperation
    | PromptFileOperation
    | CommonLlmTaskOperation
    | LocalVectorizeOperation
    | LocalSearchOperation
    | AgentOperation,
    Field(discriminator="type"),
]
