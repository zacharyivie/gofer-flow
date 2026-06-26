from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from gofer.core.usage import LlmUsageBudget


class OperationType(StrEnum):
    START = "start"
    PASS = "pass"
    FAIL = "fail"
    BREAK = "break"
    LOOP = "loop"
    PYTHON_SCRIPT = "python_script"
    SHELL_SCRIPT = "shell_script"
    BASH_COMMAND = "bash_command"
    AGENT = "agent"
    READ_FILE = "read_file"
    WRITE_FILE = "write_file"
    COPY_FILE = "copy_file"
    MOVE_FILE = "move_file"
    DELETE_FILE = "delete_file"
    FILE = "file"
    FOLDER = "folder"
    OPEN_RESOURCE = "open_resource"
    PROMPT_FILE = "prompt_file"
    COMMON_LLM_TASK = "common_llm_task"
    LOCAL_VECTORIZE = "local_vectorize"
    LOCAL_SEARCH = "local_search"
    HTTP_REQUEST = "http_request"
    APPROVAL_GATE = "approval_gate"
    NOTIFICATION = "notification"


class CountFanSource(BaseModel):
    type: Literal["count"]
    count: int | str | None = 1
    max_concurrency: int = 1
    fail_fast: bool = False


class TabularFanSource(BaseModel):
    type: Literal["tabular"]
    path: Path
    max_concurrency: int = 1
    fail_fast: bool = False


class DirectoryFanSource(BaseModel):
    type: Literal["directory"]
    path: Path
    glob: str = "*"
    include_content: bool = False
    max_concurrency: int = 1
    fail_fast: bool = False


class TriggerEventsFanSource(BaseModel):
    type: Literal["trigger_events"]
    include_content: bool = False
    max_concurrency: int = 1
    fail_fast: bool = False


class InfiniteFanSource(BaseModel):
    type: Literal["infinite"]
    max_concurrency: int = 1
    fail_fast: bool = False


FanSource = Annotated[
    CountFanSource
    | TabularFanSource
    | DirectoryFanSource
    | TriggerEventsFanSource
    | InfiniteFanSource,
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


class StartOperation(BaseModel):
    type: Literal[OperationType.START]


class PassOperation(BaseModel):
    type: Literal[OperationType.PASS]
    message: str = ""


class FailOperation(BaseModel):
    type: Literal[OperationType.FAIL]
    message: str = ""


class BreakOperation(BaseModel):
    type: Literal[OperationType.BREAK]
    message: str = ""


class LoopOperation(BaseModel):
    type: Literal[OperationType.LOOP]
    source: FanSource


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


class FileOperation(BaseModel):
    type: Literal[OperationType.FILE]
    path: Path


class FolderOperation(BaseModel):
    type: Literal[OperationType.FOLDER]
    path: Path


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
    profile: str | None = None
    model: str | None = None
    timeout: float | None = None
    memory: Literal["none", "run", "all"] = "none"
    input_mapping: dict[str, str] = {}
    llm_budget: LlmUsageBudget = Field(default_factory=LlmUsageBudget)


class LocalVectorizeOperation(BaseModel):
    type: Literal[OperationType.LOCAL_VECTORIZE]
    source_path: Path
    index_path: Path
    glob: str = "**/*"
    recursive: bool = True
    chunk_size: int = 1200
    chunk_overlap: int = 120
    encoding: str = "utf-8"
    mode: Literal["incremental", "full", "validate", "compact"] = "incremental"
    embedding_strategy: str = "hash_token_v1"
    search_strategy: str = "cosine_v1"


class LocalSearchOperation(BaseModel):
    type: Literal[OperationType.LOCAL_SEARCH]
    index_path: Path
    query: str
    top_k: int = 5
    score_threshold: float = 0.0
    include_snippets: bool = True
    include_file_metadata: bool = True
    embedding_strategy: str = "hash_token_v1"
    search_strategy: str = "cosine_v1"


class HttpRetryPolicy(BaseModel):
    attempts: int = 1
    backoff_seconds: float = 0.0
    retry_on_statuses: list[int] = []


class HttpRequestOperation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal[OperationType.HTTP_REQUEST]
    method: str = "GET"
    url: str
    headers: dict[str, str] = {}
    params: dict[str, str] = {}
    json_payload: object | None = Field(default=None, alias="json", serialization_alias="json")
    body: str | None = None
    timeout_seconds: float = 30.0
    retry: HttpRetryPolicy = Field(default_factory=HttpRetryPolicy)
    expected_statuses: list[int] = [200]
    response_mode: Literal["auto", "json", "text", "none"] = "auto"
    output_mapping: dict[str, str] = {}
    secret_fields: list[str] = []


class ApprovalGateOperation(BaseModel):
    type: Literal[OperationType.APPROVAL_GATE]
    message: str
    timeout_seconds: float | None = None
    timeout_decision: Literal["reject", "timeout"] = "timeout"
    approvers: list[str] = []
    notify: bool = False
    notification_title: str = "Gofer Flow approval needed"


class NotificationOperation(BaseModel):
    type: Literal[OperationType.NOTIFICATION]
    title: str = "Gofer Flow notification"
    body: str = ""
    channel: Literal["desktop"] = "desktop"
    urgency: Literal["low", "normal", "critical"] = "normal"


class AgentOperation(BaseModel):
    type: Literal[OperationType.AGENT]
    agent_id: str
    prompt_path: Path | None = None
    working_dir: Path
    profile: str | None = None
    model: str | None = None
    timeout: float | None = None
    skill_name: str | None = None
    dynamic_count: int | str = 1
    memory: Literal["none", "run", "all"] = "none"
    input_mapping: dict[str, str] = {}
    llm_budget: LlmUsageBudget = Field(default_factory=LlmUsageBudget)
    # Deprecated: fan-out belongs on LoopOperation. Kept for old TOML compatibility.
    fan_source: FanSource | None = None


Operation = Annotated[
    StartOperation
    | PassOperation
    | FailOperation
    | BreakOperation
    | LoopOperation
    | PythonScriptOperation
    | ShellScriptOperation
    | BashCommandOperation
    | ReadFileOperation
    | WriteFileOperation
    | CopyFileOperation
    | MoveFileOperation
    | DeleteFileOperation
    | FileOperation
    | FolderOperation
    | OpenResourceOperation
    | PromptFileOperation
    | CommonLlmTaskOperation
    | LocalVectorizeOperation
    | LocalSearchOperation
    | HttpRequestOperation
    | ApprovalGateOperation
    | NotificationOperation
    | AgentOperation,
    Field(discriminator="type"),
]
