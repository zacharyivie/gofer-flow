import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  Braces,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Check,
  ChevronDown,
  ChevronUp,
  Command,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  FilePenLine,
  Files,
  FileText,
  FileX,
  FolderOpen,
  Globe2,
  Group,
  LocateFixed,
  Loader2,
  Maximize2,
  MoreVertical,
  MoveRight,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  Webhook,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { apiUrl } from "../lib/api.js";

const DEFAULT_RETENTION_SETTINGS = {
  keepDays: 14,
  keepFailedDays: 30,
  keepLast: 100,
};
const EMPTY_ARRAY = Object.freeze([]);
const TOOLBAR_ACTION_GAP = 8;

export function visibleToolbarActionCount(availableWidth, actionWidths, menuWidth, gap = TOOLBAR_ACTION_GAP) {
  const widths = actionWidths.map((width) => Number(width) || 0);
  const available = Number(availableWidth) || 0;
  const overflowWidth = Number(menuWidth) || 0;
  if (!widths.length) return 0;
  if (widths.every((width) => width <= 0)) return widths.length;
  if (available <= 0) return 0;

  for (let count = widths.length; count >= 0; count -= 1) {
    const visibleWidth = widths
      .slice(0, count)
      .reduce((total, width, index) => total + width + (index > 0 ? gap : 0), 0);
    const needsOverflow = count < widths.length;
    const totalWidth = visibleWidth + (needsOverflow ? overflowWidth + (count > 0 ? gap : 0) : 0);
    if (totalWidth <= available) return count;
  }
  return 0;
}

const nodeStyles = {
  start: {
    icon: Play,
    accent: "bg-blue-700",
    border: "border-blue-200",
    chip: "bg-blue-50 text-blue-700 border-blue-100",
  },
  pass: {
    icon: Check,
    accent: "bg-emerald-700",
    border: "border-emerald-200",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-100",
  },
  fail: {
    icon: X,
    accent: "bg-red-700",
    border: "border-red-200",
    chip: "bg-red-50 text-red-700 border-red-100",
  },
  break: {
    icon: Square,
    accent: "bg-orange-700",
    border: "border-orange-200",
    chip: "bg-orange-50 text-orange-700 border-orange-100",
  },
  loop: {
    icon: Repeat2,
    accent: "bg-indigo-700",
    border: "border-indigo-200",
    chip: "bg-indigo-50 text-indigo-700 border-indigo-100",
  },
  agent: {
    icon: Braces,
    accent: "bg-teal-600",
    border: "border-teal-200",
    chip: "bg-teal-50 text-teal-700 border-teal-100",
  },
  bash_command: {
    icon: Command,
    accent: "bg-slate-900",
    border: "border-slate-200",
    chip: "bg-slate-100 text-slate-700 border-slate-200",
  },
  python_script: {
    icon: Route,
    accent: "bg-amber-600",
    border: "border-amber-200",
    chip: "bg-amber-50 text-amber-700 border-amber-100",
  },
  shell_script: {
    icon: Command,
    accent: "bg-sky-700",
    border: "border-sky-200",
    chip: "bg-sky-50 text-sky-700 border-sky-100",
  },
  read_file: {
    icon: FileText,
    accent: "bg-cyan-700",
    border: "border-cyan-200",
    chip: "bg-cyan-50 text-cyan-700 border-cyan-100",
  },
  write_file: {
    icon: FilePenLine,
    accent: "bg-emerald-700",
    border: "border-emerald-200",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-100",
  },
  copy_file: {
    icon: Files,
    accent: "bg-indigo-700",
    border: "border-indigo-200",
    chip: "bg-indigo-50 text-indigo-700 border-indigo-100",
  },
  move_file: {
    icon: MoveRight,
    accent: "bg-violet-700",
    border: "border-violet-200",
    chip: "bg-violet-50 text-violet-700 border-violet-100",
  },
  delete_file: {
    icon: FileX,
    accent: "bg-rose-700",
    border: "border-rose-200",
    chip: "bg-rose-50 text-rose-700 border-rose-100",
  },
  file: {
    icon: FileText,
    accent: "bg-slate-700",
    border: "border-slate-200",
    chip: "bg-slate-100 text-slate-700 border-slate-200",
  },
  folder: {
    icon: FolderOpen,
    accent: "bg-amber-700",
    border: "border-amber-200",
    chip: "bg-amber-50 text-amber-700 border-amber-100",
  },
  open_resource: {
    icon: ExternalLink,
    accent: "bg-blue-700",
    border: "border-blue-200",
    chip: "bg-blue-50 text-blue-700 border-blue-100",
  },
  prompt_file: {
    icon: FilePenLine,
    accent: "bg-fuchsia-700",
    border: "border-fuchsia-200",
    chip: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-100",
  },
  common_llm_task: {
    icon: Sparkles,
    accent: "bg-orange-700",
    border: "border-orange-200",
    chip: "bg-orange-50 text-orange-700 border-orange-100",
  },
  local_vectorize: {
    icon: Database,
    accent: "bg-lime-700",
    border: "border-lime-200",
    chip: "bg-lime-50 text-lime-700 border-lime-100",
  },
  local_search: {
    icon: Search,
    accent: "bg-purple-700",
    border: "border-purple-200",
    chip: "bg-purple-50 text-purple-700 border-purple-100",
  },
  http_request: {
    icon: Globe2,
    accent: "bg-blue-700",
    border: "border-blue-200",
    chip: "bg-blue-50 text-blue-700 border-blue-100",
  },
  approval_gate: {
    icon: ShieldCheck,
    accent: "bg-amber-700",
    border: "border-amber-200",
    chip: "bg-amber-50 text-amber-700 border-amber-100",
  },
  notification: {
    icon: Bell,
    accent: "bg-cyan-700",
    border: "border-cyan-200",
    chip: "bg-cyan-50 text-cyan-700 border-cyan-100",
  },
  workflow: {
    icon: Route,
    accent: "bg-teal-700",
    border: "border-teal-200",
    chip: "bg-teal-50 text-teal-700 border-teal-100",
  },
};

const defaultSettings = {
  allowFailure: false,
  awaitAllInputs: true,
  pipeOutput: false,
  retryCount: 0,
  retryDelaySeconds: 1,
  timeoutSeconds: "",
};
const minZoom = 0.45;
const maxZoom = 1.8;
const graphWorldSize = 20000;
const graphWorldOffset = graphWorldSize / 2;
const nodeWidth = 220;
const nodeHeight = 96;
const groupMinWidth = 260;
const groupMinHeight = 160;
const collapsedGroupHeight = 76;
const layoutColumnGap = 330;
const layoutRowGap = 154;
const minimapWidth = 124;
const minimapHeight = 86;
const defaultCanvasGroupOpacity = 0.08;
const canvasGroupColors = ["#475569", "#2563eb", "#0f766e", "#7c3aed", "#b45309", "#be123c"];
const PathTrustContext = createContext(null);
const nodeStack = {
  base: 10,
  selected: 30,
  activeSelected: 40,
  dragging: 50,
};
const isWindows =
  typeof navigator !== "undefined" &&
  /win/i.test(`${navigator.userAgent} ${navigator.platform}`);
const commandNodeLabel = isWindows ? "PowerShell command" : "Bash command";
const defaultCommand = isWindows ? 'Write-Output "hello"' : "echo hello";
const specialNodeLabels = {
  start: "START",
  pass: "PASS",
  fail: "FAIL",
};

function isSpecialNodeType(type) {
  return Object.hasOwn(specialNodeLabels, type);
}

export function nodeStackIndex(
  nodeId,
  { draggingNodeId = null, selectedNodeId = null, selectedNodeIds = [] } = {},
) {
  if (draggingNodeId === nodeId) return nodeStack.dragging;
  if (selectedNodeId === nodeId) return nodeStack.activeSelected;
  if (selectedNodeIds.includes(nodeId)) return nodeStack.selected;
  return nodeStack.base;
}

function specialNodeLabel(type) {
  return specialNodeLabels[type] ?? null;
}

export function defaultOperation(type, nodeNumber = 1) {
  switch (type) {
    case "start":
      return { type };
    case "pass":
      return { type, message: "Workflow completed successfully" };
    case "fail":
      return { type, message: "Workflow failed" };
    case "break":
      return { type, message: "Stop this loop" };
    case "loop":
      return {
        type,
        source: defaultFanSource("count"),
      };
    case "workflow":
      return {
        type,
        workflow_id: "",
      };
    case "bash_command":
      return {
        type,
        command: defaultCommand,
        working_dir: "",
        env: {},
      };
    case "python_script":
      return {
        type,
        script_path: `scripts/step_${nodeNumber}.py`,
        args: [],
        env: {},
      };
    case "shell_script":
      return {
        type,
        script_path: `scripts/step_${nodeNumber}.sh`,
        args: [],
        env: {},
      };
    case "read_file":
      return {
        type,
        path: "data/input.txt",
        encoding: "utf-8",
        errors: "strict",
      };
    case "write_file":
      return {
        type,
        path: "data/output.txt",
        content: "",
        encoding: "utf-8",
        create_dirs: true,
        overwrite: true,
        append: false,
      };
    case "copy_file":
      return {
        type,
        source_path: "data/input.txt",
        destination_path: "data/output.txt",
        create_dirs: true,
        overwrite: false,
      };
    case "move_file":
      return {
        type,
        source_path: "data/input.txt",
        destination_path: "data/archive/input.txt",
        create_dirs: true,
        overwrite: false,
      };
    case "delete_file":
      return {
        type,
        path: "data/old.txt",
        use_trash: true,
        recursive: false,
        missing_ok: false,
      };
    case "file":
      return {
        type,
        path: "",
      };
    case "folder":
      return {
        type,
        path: "",
      };
    case "open_resource":
      return {
        type,
        target: "https://example.com",
        resource_type: "auto",
        args: [],
      };
    case "prompt_file":
      return {
        type,
        output_path: `prompts/generated-${nodeNumber}.md`,
        template: "Use this context:\n\n{{_piped_input}}",
        template_path: "",
        variables: {},
        encoding: "utf-8",
        create_dirs: true,
        overwrite: true,
      };
    case "common_llm_task":
      return {
        type,
        agent_id: `agent-${nodeNumber}`,
        task: "summarize",
        target: "",
        instructions: "",
        working_dir: ".",
        input_mapping: {},
      };
    case "local_vectorize":
      return {
        type,
        source_path: "docs",
        index_path: "indexes/docs.json",
        glob: "**/*",
        recursive: true,
        chunk_size: 1200,
        chunk_overlap: 120,
        encoding: "utf-8",
        mode: "incremental",
      };
    case "local_search":
      return {
        type,
        index_path: "indexes/docs.json",
        query: "",
        top_k: 5,
        score_threshold: 0,
        include_snippets: true,
        include_file_metadata: true,
      };
    case "http_request":
      return {
        type,
        method: "GET",
        url: "https://api.example.com/resource",
        headers: {},
        params: {},
        json: null,
        body: "",
        timeout_seconds: 30,
        retry: { attempts: 1, backoff_seconds: 0, retry_on_statuses: [] },
        expected_statuses: [200],
        response_mode: "auto",
        output_mapping: {},
        secret_fields: [],
      };
    case "approval_gate":
      return {
        type,
        message: "Approve continuing this workflow?",
        timeout_seconds: null,
        timeout_decision: "timeout",
        approvers: [],
        notify: false,
        notification_title: "Gofer Flow approval needed",
      };
    case "notification":
      return {
        type,
        title: "Gofer Flow notification",
        body: "",
        channel: "desktop",
        urgency: "normal",
        webhook_url: "",
        headers: {},
        payload: null,
        email_from: "",
        email_to: [],
        smtp_host: "",
        smtp_port: 587,
        smtp_username: "",
        smtp_password: "",
        smtp_starttls: true,
        timeout_seconds: 30,
        retry: { attempts: 1, backoff_seconds: 0, retry_on_statuses: [] },
        expected_statuses: [200, 201, 202, 204],
        network_allowlist: [],
      };
    case "dashboard_item":
      return {
        type,
        action: "move",
        dashboard: "",
        component: "",
        item_id: "{{loop.current.item_id}}",
        item: {},
        patch: {},
        filter: "",
        field: "status",
        value: "",
      };
    case "agent":
    default:
      return {
        type: "agent",
        agent_id: `agent-${nodeNumber}`,
        prompt_path: "",
        working_dir: ".",
        skill_name: "",
        memory: "none",
        input_mapping: {},
      };
  }
}

export function defaultAgentConfig(agentId, overrides = {}) {
  return {
    agent_id: agentId,
    subscription: "codex",
    profile: "",
    model: "",
    working_dir: ".",
    prompt_path: "",
    tools: [],
    mcp_servers: [],
    env: {},
    ...overrides,
  };
}

function nodeMetaFromOperation(operation = {}, pathBasePath = "") {
  switch (operation.type) {
    case "start":
      return "starting point";
    case "pass":
      return operation.message || "stop with success";
    case "fail":
      return operation.message || "stop with error";
    case "break":
      return operation.message || "stop loop";
    case "loop":
      if (operation.source?.type === "dashboard_items") {
        return `loop dashboard ${operation.source.dashboard || "dashboard"}/${operation.source.component || "component"}`;
      }
      return `loop ${operation.source?.type || "items"}`;
    case "workflow":
      return `run workflow ${operation.workflow_id || "workflow"}`;
    case "bash_command":
      return operation.command || commandNodeLabel.toLowerCase();
    case "python_script":
    case "shell_script":
      return operation.script_path
        ? resolveDisplayPath(operation.script_path, pathBasePath)
        : "script";
    case "read_file":
      return `read ${operation.path ? resolveDisplayPath(operation.path, pathBasePath) : "file"}`;
    case "write_file":
      return `write ${operation.path ? resolveDisplayPath(operation.path, pathBasePath) : "file"}`;
    case "copy_file":
      return `copy ${
        operation.source_path ? resolveDisplayPath(operation.source_path, pathBasePath) : "source"
      } to ${
        operation.destination_path
          ? resolveDisplayPath(operation.destination_path, pathBasePath)
          : "destination"
      }`;
    case "move_file":
      return `move ${
        operation.source_path ? resolveDisplayPath(operation.source_path, pathBasePath) : "source"
      } to ${
        operation.destination_path
          ? resolveDisplayPath(operation.destination_path, pathBasePath)
          : "destination"
      }`;
    case "delete_file":
      return `delete ${operation.path ? resolveDisplayPath(operation.path, pathBasePath) : "file"}`;
    case "file":
      return operation.path ? resolveDisplayPath(operation.path, pathBasePath) : "file";
    case "folder":
      return operation.path ? resolveDisplayPath(operation.path, pathBasePath) : "folder";
    case "open_resource":
      return `open ${operation.target ? resolveDisplayPath(operation.target, pathBasePath) : "target"}`;
    case "prompt_file":
      return `prompt ${
        operation.output_path ? resolveDisplayPath(operation.output_path, pathBasePath) : "file"
      }`;
    case "common_llm_task":
      return `${operation.task || "summarize"} with ${operation.agent_id || "agent"}`;
    case "local_vectorize":
      return `index ${
        operation.source_path ? resolveDisplayPath(operation.source_path, pathBasePath) : "files"
      }`;
    case "local_search":
      return `search ${
        operation.index_path ? resolveDisplayPath(operation.index_path, pathBasePath) : "index"
      }`;
    case "http_request":
      return `${operation.method || "GET"} ${operation.url || "url"}`;
    case "approval_gate":
      return operation.timeout_seconds
        ? `approval timeout ${operation.timeout_seconds}s`
        : "approval required";
    case "notification":
      return `${operation.channel || "desktop"} · ${operation.title || "notification"}`;
    case "dashboard_item":
      return `${operation.action || "read"} ${operation.dashboard || "dashboard"}/${operation.component || "component"}`;
    case "agent":
      if (operation.skill_name) return `${operation.agent_id || "agent"} · /${operation.skill_name}`;
      return operation.prompt_path
        ? `${operation.agent_id || "agent"} · ${resolveDisplayPath(operation.prompt_path, pathBasePath)}`
        : operation.agent_id || "agent";
    default:
      return "operation";
  }
}

export function buildInputSourceOptions(node, nodes, edges, dashboards = []) {
  return flattenInputSourceGroups(buildInputSourceGroups(node, nodes, edges, dashboards));
}

export function buildInputSourceGroups(node, nodes, edges, dashboards = []) {
  const nodesById = Object.fromEntries(nodes.map((candidate) => [candidate.id, candidate]));
  const ancestorNodes = findInputAncestorNodes(node, nodesById, edges);
  const loopInputAncestorIds = new Set(
    findLoopInputAncestors(node, nodesById, edges).map((ancestor) => ancestor.id),
  );
  const groups = [
    {
      id: "previous",
      label: "Previous node",
      options: [
        ["previous.text", "text"],
        ["previous.data.message", "message"],
        ["previous.data.stdout", "stdout"],
        ["previous.data.stderr", "stderr"],
      ],
    },
  ];

  ancestorNodes.forEach((ancestor) => {
    const label = ancestor.label || ancestor.id;
    const options = [];
    if (ancestor.operation?.type === "loop" && loopInputAncestorIds.has(ancestor.id)) {
      loopSourceInputOptions(ancestor.operation?.source, dashboards).forEach(([path, fieldLabel]) => {
        options.push([path, stripInputSourcePrefix(fieldLabel, "Loop current ")]);
      });
    }
    nodeOutputFields(ancestor, dashboards).forEach(([path, fieldLabel]) => {
      options.push([`${ancestor.id}.${path}`, fieldLabel]);
    });
    const dedupedOptions = dedupeOptions(options);
    if (dedupedOptions.length) {
      groups.push({
        id: ancestor.id,
        label,
        options: dedupedOptions,
      });
    }
  });

  return groups.filter((group) => group.options.length);
}

function flattenInputSourceGroups(groups = []) {
  const options = [];
  groups.forEach((group) => {
    group.options.forEach(([value, label]) => {
      options.push([value, group.id === "previous" ? label : `${group.label} ${label}`]);
    });
  });
  return dedupeOptions(options);
}

function stripInputSourcePrefix(label = "", prefix = "") {
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

function findInputAncestorNodes(node, nodesById, edges) {
  const ancestors = [];
  const visitedNodeIds = new Set();
  const stack = [node.id];

  while (stack.length > 0) {
    const currentNodeId = stack.pop();
    if (visitedNodeIds.has(currentNodeId)) continue;
    visitedNodeIds.add(currentNodeId);

    edges
      .filter((edge) => edge.to === currentNodeId)
      .forEach((edge) => {
        const upstream = nodesById[edge.from];
        if (!upstream) return;
        if (!ancestors.some((ancestor) => ancestor.id === upstream.id)) {
          ancestors.push(upstream);
        }
        stack.push(upstream.id);
      });
  }

  return ancestors;
}

function findLoopInputAncestors(node, nodesById, edges) {
  const loopAncestors = [];
  const seenLoopIds = new Set();
  const visitedNodeIds = new Set();
  const stack = [node.id];
  const incomingIterationEdges = edges.filter((edge) => edge.condition !== "after_loop");

  while (stack.length > 0) {
    const currentNodeId = stack.pop();
    if (visitedNodeIds.has(currentNodeId)) continue;
    visitedNodeIds.add(currentNodeId);

    incomingIterationEdges
      .filter((edge) => edge.to === currentNodeId)
      .forEach((edge) => {
        const upstream = nodesById[edge.from];
        if (!upstream) return;
        if (upstream.operation?.type === "loop" && !seenLoopIds.has(upstream.id)) {
          seenLoopIds.add(upstream.id);
          loopAncestors.push(upstream);
        }
        stack.push(upstream.id);
      });
  }

  return loopAncestors;
}

function loopSourceInputOptions(source = {}, dashboards = []) {
  switch (source?.type) {
    case "count":
    case "infinite":
      return [["loop.current.index", "Loop current index"]];
    case "directory": {
      const options = [
        ["loop.current.file_path", "Loop current file path"],
        ["loop.current.file_name", "Loop current file name"],
        ["loop.current.file_stem", "Loop current file stem"],
        ["loop.current.file_extension", "Loop current file extension"],
        ["loop.current.directory", "Loop current directory"],
        ["loop.current.parent_path", "Loop current parent path"],
        ["loop.current.size", "Loop current file size"],
        ["loop.current.mtime_ns", "Loop current modified time"],
      ];
      if (source.include_content) {
        options.push(["loop.current.file_content", "Loop current file content"]);
      }
      return options;
    }
    case "tabular":
      return [
        ["loop.current.index", "Loop current index"],
        ["loop.current._row", "Loop current row JSON"],
      ];
    case "trigger_events": {
      const options = [
        ["loop.current.index", "Loop current index"],
        ["loop.current.event_json", "Loop current event JSON"],
        ["loop.current.kind", "Loop current event kind"],
        ["loop.current.path", "Loop current event path"],
        ["loop.current.file_path", "Loop current file path"],
        ["loop.current.file_name", "Loop current file name"],
        ["loop.current.directory", "Loop current directory"],
      ];
      if (source.include_content) {
        options.push(["loop.current.file_content", "Loop current file content"]);
      }
      return options;
    }
    case "dashboard_items":
      return [
        ["loop.current.index", "Loop current index"],
        ["loop.current.dashboard", "Loop current dashboard"],
        ["loop.current.component", "Loop current component"],
        ["loop.current.item_id", "Loop current dashboard item ID"],
        ["loop.current.item_json", "Loop current dashboard item JSON"],
        ...dashboardLoopItemFieldOptions(source, dashboards),
      ];
    default:
      return [];
  }
}

function dashboardLoopItemFieldOptions(source = {}, dashboards = []) {
  const dashboard = dashboards.find(
    (candidate) => candidate.id === source.dashboard || candidate.name === source.dashboard,
  );
  const component = dashboardComponentById(dashboard, source.component);
  const fields = new Set([
    ...Object.keys(component?.schema ?? {}),
    ...(component?.items ?? []).flatMap((item) => Object.keys(item ?? {})),
  ]);
  return [...fields].sort().map((field) => [
    `loop.current.item.${field}`,
    `Loop current dashboard item ${field}`,
  ]);
}

function loopOutputFields(source = {}, common = [], dashboards = []) {
  const base = [
    ...common,
    ["items", "all items"],
    ["data.count", "item count"],
    ["data.source_type", "source type"],
    ["data.max_concurrency", "max concurrency"],
    ["data.fail_fast", "fail fast"],
  ];
  switch (source?.type) {
    case "directory":
      return [
        ...base,
        ["data.source_path", "source path"],
        ["data.glob", "glob"],
        ["data.include_content", "include file content"],
      ];
    case "tabular":
      return [...base, ["data.source_path", "source path"]];
    case "trigger_events":
      return [...base, ["data.include_content", "include file content"]];
    case "dashboard_items":
      return [
        ...base,
        ["data.dashboard", "dashboard"],
        ["data.component", "component"],
        ["data.filter", "filter"],
      ];
    case "count":
    case "infinite":
    default:
      return base;
  }
}

export function nodeOutputFields(node, dashboards = []) {
  const type = node?.type || node?.operation?.type;
  const common = [
    ["text", "text"],
    ["success", "success"],
  ];
  switch (type) {
    case "bash_command":
    case "python_script":
    case "shell_script":
      return [
        ...common,
        ["data.stdout", "stdout"],
        ["data.stderr", "stderr"],
        ["data.command", "command"],
        ["data.script_path", "script path"],
      ];
    case "read_file":
    case "prompt_file":
    case "write_file":
      return [
        ...common,
        ["data.file_path", "file path"],
        ["data.file_name", "file name"],
        ["data.file_stem", "file stem"],
        ["data.file_extension", "file extension"],
        ["data.parent_path", "parent folder"],
        ["data.directory", "directory"],
        ["data.content", "content"],
        ["data.characters_written", "characters written"],
        ["data.bytes_written", "bytes written"],
      ];
    case "copy_file":
    case "move_file":
      return [
        ...common,
        ["data.source_path", "source path"],
        ["data.source_name", "source name"],
        ["data.destination_path", "destination path"],
        ["data.destination_name", "destination name"],
        ["data.destination_directory", "destination directory"],
      ];
    case "delete_file":
      return [
        ...common,
        ["data.path", "path"],
        ["data.file_path", "file path"],
        ["data.folder_path", "folder path"],
        ["data.trash_path", "trash path"],
        ["data.deleted", "deleted"],
      ];
    case "file":
      return [
        ...common,
        ["data.file_path", "file path"],
        ["data.file_name", "file name"],
        ["data.file_stem", "file stem"],
        ["data.file_extension", "file extension"],
        ["data.parent_path", "parent folder"],
        ["data.directory", "directory"],
      ];
    case "folder":
      return [
        ...common,
        ["data.folder_path", "folder path"],
        ["data.folder_name", "folder name"],
        ["data.parent_path", "parent folder"],
        ["data.directory", "directory"],
      ];
    case "loop":
      return loopOutputFields(node?.operation?.source, common, dashboards);
    case "workflow":
      return [
        ...common,
        ["data.workflow_id", "workflow ID"],
        ["data.workflow_name", "workflow name"],
        ["data.log_path", "run log"],
        ["data.duration_seconds", "duration seconds"],
      ];
    case "agent":
    case "common_llm_task":
      return [
        ...common,
        ["data.message", "agent message"],
        ["data.agent_id", "agent ID"],
        ["data.thoughts", "agent thoughts"],
      ];
    case "local_vectorize":
      return [
        ...common,
        ["data.source_path", "source path"],
        ["data.index_path", "index path"],
        ["data.file_count", "file count"],
        ["data.indexed_file_count", "indexed files"],
        ["data.chunk_count", "chunk count"],
        ["data.current", "index current"],
        ["data.status", "index status"],
        ["data.added_files", "added files"],
        ["data.updated_files", "updated files"],
        ["data.deleted_files", "deleted files"],
        ["data.stale_files", "stale files"],
        ["data.strategy", "embedding strategy"],
      ];
    case "local_search":
      return [
        ...common,
        ["items", "results"],
        ["data.results", "results"],
        ["data.index_path", "index path"],
        ["data.query", "query"],
        ["data.score_threshold", "score threshold"],
        ["data.strategy", "search strategy"],
      ];
    case "http_request":
      return [
        ...common,
        ["data.status", "status"],
        ["data.headers", "headers"],
        ["data.body", "body"],
        ["data.json", "JSON"],
        ["data.selected", "selected outputs"],
      ];
    case "dashboard_item":
      return [
        ...common,
        ["items", "items"],
        ["data.message", "message"],
        ["data.dashboard", "dashboard"],
        ["data.component", "component"],
        ["data.count", "item count"],
        ["data.items", "items"],
        ["data.item", "item"],
        ["data.selected", "selected item"],
      ];
    case "approval_gate":
      return [
        ...common,
        ["data.decision", "decision"],
        ["data.approved", "approved"],
        ["data.decidedBy", "decided by"],
        ["data.notes", "notes"],
        ["data.message", "message"],
        ["data.runId", "run ID"],
      ];
    case "notification":
      return [
        ...common,
        ["data.title", "title"],
        ["data.body", "body"],
        ["data.channel", "channel"],
        ["data.urgency", "urgency"],
      ];
    case "open_resource":
      return [...common, ["data.target", "target"], ["data.resource_type", "resource type"]];
    case "pass":
    case "fail":
    case "break":
      return [...common, ["data.message", "message"]];
    default:
      return common;
  }
}

function dedupeOptions(options) {
  const seen = new Set();
  return options.filter(([value]) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function pathBasename(pathValue = "") {
  const normalized = String(pathValue).replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || "path";
}

function fileExtension(pathValue = "") {
  const name = pathBasename(pathValue);
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toUpperCase();
}

function isUrlPath(pathValue = "") {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(pathValue));
}

function isAbsolutePath(pathValue = "") {
  const value = String(pathValue);
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function joinPath(basePath = "", pathValue = "") {
  const base = String(basePath);
  const value = String(pathValue);
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  if (!base) return value;
  if (value === ".") return base;
  return `${base.replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
}

function normalizeDisplayPath(pathValue = "") {
  const value = String(pathValue);
  if (!value) return "";
  return value.replace(/\/\.(?=\/|$)/g, "").replace(/\\/g, "\\");
}

function resolveDisplayPath(pathValue = "", basePath = "") {
  const value = String(pathValue ?? "").trim();
  if (!value || isUrlPath(value) || isAbsolutePath(value)) {
    return value;
  }
  return normalizeDisplayPath(joinPath(basePath, value));
}

function canonicalPath(pathValue = "") {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function pathParent(pathValue = "") {
  const value = canonicalPath(pathValue);
  if (!value) return "";
  const index = value.lastIndexOf("/");
  if (index <= 0) return value.startsWith("/") ? "/" : "";
  return value.slice(0, index);
}

function isPathInsideRoot(pathValue = "", rootValue = "") {
  const path = canonicalPath(pathValue);
  const root = canonicalPath(rootValue);
  if (!path || !root) return false;
  return path === root || path.startsWith(`${root}/`);
}

function workflowAccessCoversPath(workflow, pathValue, dataDir = "") {
  if (dataDir && isPathInsideRoot(pathValue, dataDir)) return true;
  return (workflow.filesystemAccess ?? []).some((entry) =>
    entry?.path ? isPathInsideRoot(pathValue, entry.path) : false,
  );
}

function pathsMatch(pathValue = "", otherPathValue = "") {
  const path = canonicalPath(pathValue);
  const otherPath = canonicalPath(otherPathValue);
  return Boolean(path && otherPath && path === otherPath);
}

function uniqueAccessEntries(entries = []) {
  const seen = new Set();
  return entries
    .map((entry) => ({
      path: String(entry?.path ?? "").trim(),
      read: true,
      write: true,
      execute: false,
    }))
    .filter((entry) => {
    const path = canonicalPath(entry?.path ?? "");
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
    });
}

function mergeWorkflowFilesystemAccess(workflow, entries) {
  return uniqueAccessEntries([...(workflow.filesystemAccess ?? []), ...entries]);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizedSelectionBox(selectionBox) {
  const left = Math.min(selectionBox.start.x, selectionBox.current.x);
  const top = Math.min(selectionBox.start.y, selectionBox.current.y);
  const right = Math.max(selectionBox.start.x, selectionBox.current.x);
  const bottom = Math.max(selectionBox.start.y, selectionBox.current.y);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function selectionBoxArea(box) {
  return box.width * box.height;
}

function nodeIntersectsBox(node, box) {
  const nodeLeft = node.x ?? 0;
  const nodeTop = node.y ?? 0;
  const nodeRight = nodeLeft + nodeWidth;
  const nodeBottom = nodeTop + nodeHeight;
  const boxRight = box.left + box.width;
  const boxBottom = box.top + box.height;

  return (
    nodeLeft < boxRight &&
    nodeRight > box.left &&
    nodeTop < boxBottom &&
    nodeBottom > box.top
  );
}

function nextAvailableNodeNumber(nodes) {
  const usedNumbers = new Set(
    nodes
      .map((node) => String(node.id).match(/^node-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }
  return nextNumber;
}

function nextAvailableAgentNumber(nodes, agents, usedAgentIds = []) {
  const usedNumbers = new Set([
    ...usedAgentIds
      .map((agentId) => String(agentId).match(/^agent-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
    ...Object.keys(agents ?? {})
      .map((agentId) => String(agentId).match(/^agent-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
    ...nodes
      .map((node) => String(node.operation?.agent_id ?? "").match(/^agent-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  ]);
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }
  return nextNumber;
}

function structuredCloneCompatible(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hexToRgba(hex, opacity = 1) {
  const normalized = String(hex ?? "").replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(normalized)) {
    return `rgba(71, 85, 105, ${clamp(opacity, 0, 1)})`;
  }
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${clamp(opacity, 0, 1)})`;
}

function nextAvailableGroupNumber(groups) {
  const usedNumbers = new Set(
    groups
      .map((group) => String(group.id).match(/^group-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }
  return nextNumber;
}

export default function DagCanvas({
  approvalState,
  dashboards = EMPTY_ARRAY,
  dataDir = "",
  logState,
  notice,
  retentionSettings = DEFAULT_RETENTION_SETTINGS,
  runState,
  workflow,
  workflows = EMPTY_ARRAY,
  onExportWorkflow,
  onImportWorkflow,
  onLoadLatestLog,
  onDecideApproval,
  onPruneRunLogs,
  onRetentionSettingsChange,
  onRunWorkflow,
  onReplayRunLog,
  onResumeRunLog,
  onSelectRunLog,
  onStopRunLog,
  onStopWorkflow,
  onValidateWorkflow,
  onWorkflowChange,
  onNavigateWorkflow,
  onRenameWorkflow,
  usedAgentIds = EMPTY_ARRAY,
}) {
  const canvasRef = useRef(null);
  const importInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const toolbarActionGroupRef = useRef(null);
  const toolbarMeasureRef = useRef(null);
  const toolbarMenuRef = useRef(null);
  const nodeDragMovedRef = useRef(false);
  const nodeDragSelectionRef = useRef([]);
  const groupDragRef = useRef(null);
  const [selectedNodeId, setSelectedNodeId] = useState();
  const [selectedNodeIds, setSelectedNodeIds] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [panningPointerId, setPanningPointerId] = useState(null);
  const [selectionBox, setSelectionBox] = useState(null);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [logHeight, setLogHeight] = useState(240);
  const [expandedFolderNodes, setExpandedFolderNodes] = useState({});
  const [providerProfiles, setProviderProfiles] = useState([]);

  useEffect(() => {
    async function loadProviderProfiles() {
      try {
        const response = await fetch(apiUrl("/provider/profiles"));
        if (!response.ok) return;
        const payload = await response.json();
        setProviderProfiles(payload.profiles ?? []);
      } catch {
        setProviderProfiles([]);
      }
    }
    loadProviderProfiles();
  }, []);
  const [folderNodeEntries, setFolderNodeEntries] = useState({});
  const [filePreviewPath, setFilePreviewPath] = useState(null);
  const [pendingTrustPrompt, setPendingTrustPrompt] = useState(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [draftEdge, setDraftEdge] = useState(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [minimapDragging, setMinimapDragging] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState(null);
  const [nodeRenameDialog, setNodeRenameDialog] = useState(null);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [visibleToolbarActions, setVisibleToolbarActions] = useState(null);
  const invalidWorkflow = Boolean(workflow.invalid);
  const validationDiagnostics = workflowValidationDiagnostics(workflow);
  const blockingValidationErrors = validationDiagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const runDisabled = invalidWorkflow || blockingValidationErrors.length > 0;
  const workflowNodes = useMemo(
    () =>
      (workflow.nodes ?? []).map((node) => {
        const forcedLabel = specialNodeLabel(node.type);
        if (forcedLabel && node.label !== forcedLabel) {
          return { ...node, label: forcedLabel };
        }
        if (node.type === "workflow") {
          const targetWorkflow = workflows.find(
            (candidate) => candidate.id === node.operation?.workflow_id,
          );
          const targetLabel = targetWorkflow?.name || node.label || "Workflow";
          return targetLabel !== node.label ? { ...node, label: targetLabel } : node;
        }
        return node;
      }),
    [workflow.nodes, workflows],
  );
  const workflowEdges = workflow.edges ?? [];
  const canvasGroups = useMemo(() => normalizeCanvasGroups(workflow), [workflow]);
  const visibleWorkflowNodes = useMemo(
    () => visibleNodesForGroups(workflowNodes, canvasGroups),
    [canvasGroups, workflowNodes],
  );
  const visibleWorkflowEdges = useMemo(
    () => visibleEdgesForGroups(workflowEdges, visibleWorkflowNodes),
    [visibleWorkflowNodes, workflowEdges],
  );
  const edgeDiagnostics = useMemo(
    () => diagnosticsByTarget(validationDiagnostics, "edge"),
    [validationDiagnostics],
  );
  const nodeDiagnostics = useMemo(
    () => diagnosticsByTarget(validationDiagnostics, "node"),
    [validationDiagnostics],
  );
  const searchMatches = useMemo(
    () => matchingNodeIds(workflowNodes, searchQuery),
    [searchQuery, workflowNodes],
  );
  const selectedNode = workflowNodes.find((node) => node.id === selectedNodeId);
  const selectedGroup = canvasGroups.find((group) => group.id === selectedGroupId);
  const selectedEdge = workflowEdges.find((edge) => edge.id === selectedEdgeId);
  const runResult = runState?.result?.workflowId === workflow.id ? runState.result : null;
  const historicalNodeOutputs = logState?.nodeOutputs ?? null;
  const runEvents = useMemo(
    () => (logState?.runEvents?.length ? logState.runEvents : runResult?.runEvents ?? []),
    [logState?.runEvents, runResult?.runEvents],
  );
  const runNodes = useMemo(
    () =>
      logState?.runNodes && Object.keys(logState.runNodes).length
        ? logState.runNodes
        : runResult?.runNodes ?? {},
    [logState?.runNodes, runResult?.runNodes],
  );
  const selectedRunId =
    logState?.selectedRunId ??
    (logState?.path ? logState.path.split(/[\\/]/).pop() : null) ??
    (runResult?.logPath ? runResult.logPath.split(/[\\/]/).pop() : null);
  const usageSummary = logState?.usageSummary ?? runResult?.usageSummary ?? null;
  const selectedNodeOutput = selectedNodeId
    ? runResult?.nodeOutputs?.[selectedNodeId] ?? historicalNodeOutputs?.[selectedNodeId] ?? null
    : null;
  const selectedRunNode = selectedNodeId ? runNodes?.[selectedNodeId] ?? null : null;
  const nodesById = useMemo(() => {
    return Object.fromEntries(workflowNodes.map((node) => [node.id, node]));
  }, [workflowNodes]);
  const selectedApproval = selectedNodeId
    ? approvalState?.approvals?.find(
        (approval) =>
          approval.nodeId === selectedNodeId &&
          selectedRunId &&
          approval.runId === selectedRunId,
      ) ?? null
    : null;
  const pendingApproval = useMemo(() => {
    const pendingApprovals = approvalState?.approvals?.filter(
      (approval) => approval.status === "pending" && nodesById[approval.nodeId],
    ) ?? [];
    if (!pendingApprovals.length) return null;
    return pendingApprovals
      .slice()
      .sort((first, second) =>
        String(first.requestedAt || "").localeCompare(String(second.requestedAt || "")),
      )[0];
  }, [approvalState?.approvals, nodesById]);
  const pendingApprovalNode = pendingApproval ? nodesById[pendingApproval.nodeId] : null;
  const workflowLogText =
    logState?.text || runResult?.logText || formatWorkflowRunLog(runResult);
  const displayedLog = selectedNodeId
    ? extractNodeLog(workflowLogText, selectedNodeId) || selectedNodeOutput?.output || ""
    : workflowLogText;
  const logTitle = selectedNodeId ? `${selectedNodeId} last run` : "Workflow log";
  const nodeStatuses = useMemo(() => {
    return getNodeStatuses(workflowNodes, runResult, workflowLogText, runNodes, runEvents);
  }, [runEvents, runNodes, runResult, workflowNodes, workflowLogText]);
  const currentWorkflowRunning =
    runState?.running && runState.workflowId === workflow.id;
  const workflowHasRunningRuns = currentWorkflowRunning || logState?.runs?.some(
    (run) => run.status === "running",
  );
  const runTitle = blockingValidationErrors.length
    ? blockingValidationErrors[0].message
    : workflowHasRunningRuns
      ? "Start another workflow run"
      : "Run workflow now";

  useEffect(() => {
    setSelectedNodeId(undefined);
    setSelectedNodeIds([]);
    setSelectedGroupId(null);
    setSelectedEdgeId(null);
    setDraftEdge(null);
    setDraggingNodeId(null);
    setPanningPointerId(null);
    setSelectionBox(null);
    setSearchQuery("");
    setSearchMatchIndex(0);
    const schedule = window.requestAnimationFrame ?? ((callback) => callback());
    schedule(() => fitGraph());
  }, [workflow.id]);

  useEffect(() => {
    setSearchMatchIndex((currentIndex) =>
      searchMatches.length ? Math.min(currentIndex, searchMatches.length - 1) : 0,
    );
  }, [searchMatches.length]);

  useEffect(() => {
    if (selectedGroupId && !canvasGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(null);
    }
  }, [canvasGroups, selectedGroupId]);

  useEffect(() => {
    if (selectedNodeId && !nodesById[selectedNodeId]) {
      setSelectedNodeId(undefined);
    }
    setSelectedNodeIds((currentIds) => {
      const nextIds = currentIds.filter((nodeId) => Boolean(nodesById[nodeId]));
      if (
        nextIds.length === currentIds.length &&
        nextIds.every((nodeId, index) => nodeId === currentIds[index])
      ) {
        return currentIds;
      }
      return nextIds;
    });
  }, [nodesById, selectedNodeId]);

  useEffect(() => {
    if (selectedEdgeId && !workflowEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId, workflowEdges]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!selectedEdgeId || event.defaultPrevented) return;
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase?.();
      if (
        target?.isContentEditable ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select"
      ) {
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteEdge(selectedEdgeId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedEdgeId, workflowEdges]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented) return;
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase?.();
      const editingText =
        target?.isContentEditable ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select";

      if (event.key === "Escape") {
        setNodeRenameDialog(null);
        setNodeContextMenu(null);
        setToolbarMenuOpen(false);
        setDraftEdge(null);
        setSelectedEdgeId(null);
        setSelectedNodeId(undefined);
        setSelectedNodeIds([]);
        setSelectedGroupId(null);
        setSelectionBox(null);
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
        return;
      }

      if (editingText) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select?.();
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select?.();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedEdgeId(null);
        setSelectedGroupId(null);
        setSelectedNodeIds(workflowNodes.map((node) => node.id));
        setSelectedNodeId(workflowNodes.at(-1)?.id);
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedNodeIds.length) {
        event.preventDefault();
        deleteSelectedNodesWithConfirmation();
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setViewport((current) => {
          const rect = canvasRef.current?.getBoundingClientRect();
          const centerX = (rect?.width || 960) / 2;
          const centerY = (rect?.height || 640) / 2;
          const nextScale = clamp(current.scale * 1.14, minZoom, maxZoom);
          const contentX = (centerX - current.x) / current.scale;
          const contentY = (centerY - current.y) / current.scale;
          return {
            scale: nextScale,
            x: centerX - contentX * nextScale,
            y: centerY - contentY * nextScale,
          };
        });
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setViewport((current) => {
          const rect = canvasRef.current?.getBoundingClientRect();
          const centerX = (rect?.width || 960) / 2;
          const centerY = (rect?.height || 640) / 2;
          const nextScale = clamp(current.scale * 0.88, minZoom, maxZoom);
          const contentX = (centerX - current.x) / current.scale;
          const contentY = (centerY - current.y) / current.scale;
          return {
            scale: nextScale,
            x: centerX - contentX * nextScale,
            y: centerY - contentY * nextScale,
          };
        });
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        setViewport(
          fitViewportToNodes(workflowNodes, {
            width: rect?.width || 960,
            height: rect?.height || 640,
          }),
        );
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [workflowNodes, selectedNodeIds]);

  useEffect(() => {
    if (panningPointerId === null) return undefined;

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [panningPointerId]);

  function updateNode(nodeId, patch) {
    onWorkflowChange({
      ...workflow,
      nodes: workflowNodes.map((node) => {
        if (node.id !== nodeId) return node;
        const nextNode = { ...node, ...patch };
        const forcedLabel = specialNodeLabel(nextNode.type);
        return forcedLabel ? { ...nextNode, label: forcedLabel } : nextNode;
      }),
    });
  }

  function updateNodeOperation(nodeId, patch) {
    const node = nodesById[nodeId];
    const operation = { ...(node.operation ?? defaultOperation(node.type)), ...patch };
    const nextNodePatch = {
      operation,
      type: operation.type,
      meta: nodeMetaFromOperation(operation),
    };
    const forcedLabel = specialNodeLabel(operation.type);
    if (forcedLabel) {
      nextNodePatch.label = forcedLabel;
    }
    if (
      operation.type === "workflow" &&
      Object.hasOwn(patch, "workflow_id") &&
      operation.workflow_id
    ) {
      const targetWorkflow = workflows.find((candidate) => candidate.id === operation.workflow_id);
      if (targetWorkflow?.name) {
        nextNodePatch.label = targetWorkflow.name;
      }
    }
    if (
      (operation.type === "file" || operation.type === "folder") &&
      Object.hasOwn(patch, "path") &&
      operation.path
    ) {
      nextNodePatch.label = pathBasename(operation.path);
    }
    const syncAgentPatch = {};
    if (operation.type === "agent" || operation.type === "common_llm_task") {
      if (Object.hasOwn(patch, "prompt_path")) {
        syncAgentPatch.prompt_path = operation.prompt_path;
      }
      if (Object.hasOwn(patch, "working_dir")) {
        syncAgentPatch.working_dir = operation.working_dir;
      }
    }
    const shouldSyncAgent =
      (operation.type === "agent" || operation.type === "common_llm_task") &&
      operation.agent_id &&
      (patch.agent_id || Object.keys(syncAgentPatch).length);

    if (shouldSyncAgent) {
      const currentAgent =
        workflow.agents?.[operation.agent_id] ??
        defaultAgentConfig(operation.agent_id, {
          prompt_path: operation.prompt_path,
          working_dir: operation.working_dir,
        });
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [operation.agent_id]: {
            ...currentAgent,
            ...syncAgentPatch,
          },
        },
        nodes: workflowNodes.map((currentNode) =>
          currentNode.id === nodeId ? { ...currentNode, ...nextNodePatch } : currentNode,
        ),
      });
      return;
    }

    updateNode(nodeId, nextNodePatch);
  }

  function updateNodeSettings(nodeId, patch) {
    const node = nodesById[nodeId];
    updateNode(nodeId, {
      settings: {
        ...defaultSettings,
        ...(node.settings ?? {}),
        ...patch,
      },
    });
  }

  function updateNodeType(nodeId, type) {
    if (
      isSpecialNodeType(type) &&
      workflowNodes.some((node) => node.id !== nodeId && node.type === type)
    ) {
      return;
    }
    const nextAgentNumber = nextAvailableAgentNumber(workflowNodes, workflow.agents, usedAgentIds);
    const nextOperation = defaultOperation(
      type,
      type === "agent" || type === "common_llm_task"
        ? nextAgentNumber
        : workflowNodes.length + 1,
    );
    if (type === "workflow") {
      const targetWorkflow = workflows.find((candidate) => candidate.id !== workflow.id);
      if (targetWorkflow) {
        nextOperation.workflow_id = targetWorkflow.id;
      }
    }
    const nextNode = {
      type,
      label:
        specialNodeLabel(type) ??
        (type === "workflow"
          ? workflows.find((candidate) => candidate.id === nextOperation.workflow_id)?.name ||
            "Workflow"
          : nodesById[nodeId].label),
      operation: nextOperation,
      settings: {
        ...defaultSettings,
        ...(nodesById[nodeId].settings ?? {}),
      },
      meta: nodeMetaFromOperation(nextOperation),
    };
    if (
      (type === "agent" || type === "common_llm_task") &&
      !workflow.agents?.[nextOperation.agent_id]
    ) {
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [nextOperation.agent_id]: defaultAgentConfig(nextOperation.agent_id, {
            prompt_path: nextOperation.prompt_path,
            working_dir: nextOperation.working_dir,
          }),
        },
        nodes: workflowNodes.map((node) => (node.id === nodeId ? { ...node, ...nextNode } : node)),
      });
      return;
    }
    updateNode(nodeId, nextNode);
  }

  function updateAgentConfig(agentId, patch) {
    const currentAgent = workflow.agents?.[agentId] ?? defaultAgentConfig(agentId);
    onWorkflowChange({
      ...workflow,
      agents: {
        ...(workflow.agents ?? {}),
        [agentId]: {
          ...currentAgent,
          ...patch,
        },
      },
    });
  }

  function canvasViewportSize() {
    const rect = canvasRef.current?.getBoundingClientRect();
    return {
      width: rect?.width || 960,
      height: rect?.height || 640,
    };
  }

  function viewportCenterNodePosition() {
    const size = canvasViewportSize();
    return {
      x: (size.width / 2 - viewport.x) / viewport.scale - nodeWidth / 2,
      y: (size.height / 2 - viewport.y) / viewport.scale - nodeHeight / 2,
    };
  }

  function fitNodes(nodes) {
    if (!nodes.length) return;
    setViewport(fitViewportToNodes(nodes, canvasViewportSize()));
  }

  function currentFitItems() {
    const collapsedGroups = canvasGroups
      .filter((group) => group.collapsed)
      .map(groupRectForViewport);
    return [...visibleWorkflowNodes, ...collapsedGroups];
  }

  function fitGraph() {
    fitNodes(currentFitItems());
  }

  function focusSearchMatch(matchIndex = searchMatchIndex) {
    if (!searchMatches.length) return;
    const boundedIndex = ((matchIndex % searchMatches.length) + searchMatches.length) % searchMatches.length;
    const nodeId = searchMatches[boundedIndex];
    const node = workflowNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const collapsedGroup = canvasGroups.find(
      (group) => group.collapsed && group.nodeIds.includes(nodeId),
    );
    if (collapsedGroup) {
      onWorkflowChange(updateCanvasGroup(workflow, collapsedGroup.id, { collapsed: false }));
      setSelectedGroupId(collapsedGroup.id);
    } else {
      setSelectedGroupId(null);
    }
    setSearchMatchIndex(boundedIndex);
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
    setSelectedNodeIds([nodeId]);
    fitNodes([node]);
  }

  function handleSearchSubmit(event) {
    event.preventDefault();
    focusSearchMatch(searchMatchIndex);
  }

  function moveSearchMatch(delta) {
    if (!searchMatches.length) return;
    focusSearchMatch(searchMatchIndex + delta);
  }

  function fitSelection() {
    const selectedNodes = workflowNodes.filter((node) => selectedNodeIds.includes(node.id));
    if (selectedGroup) {
      fitNodes([groupRectForViewport(selectedGroup)]);
      return;
    }
    fitNodes(selectedNodes.length ? selectedNodes : currentFitItems());
  }

  function zoomViewport(multiplier) {
    const size = canvasViewportSize();
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    setViewport((current) => {
      const nextScale = clamp(current.scale * multiplier, minZoom, maxZoom);
      const contentX = (centerX - current.x) / current.scale;
      const contentY = (centerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: centerX - contentX * nextScale,
        y: centerY - contentY * nextScale,
      };
    });
  }

  function applyAutoLayout() {
    const nextWorkflow = autoLayoutWorkflow(workflow);
    onWorkflowChange(nextWorkflow);
    const schedule = window.requestAnimationFrame ?? ((callback) => callback());
    schedule(() => {
      const nextGroups = normalizeCanvasGroups(nextWorkflow);
      fitNodes([
        ...visibleNodesForGroups(nextWorkflow.nodes ?? [], nextGroups),
        ...nextGroups.filter((group) => group.collapsed).map(groupRectForViewport),
      ]);
    });
  }

  function addNode() {
    const position = viewportCenterNodePosition();
    const nextWorkflow = addDefaultNodeToWorkflow(workflow, {
      usedAgentIds,
      x: Math.round(position.x),
      y: Math.round(position.y),
    });
    const newNode = nextWorkflow.nodes.at(-1);
    onWorkflowChange(nextWorkflow);
    setSelectedNodeId(newNode.id);
    setSelectedNodeIds([newNode.id]);
    setSelectedGroupId(null);
  }

  function addGroup() {
    if (!selectedNodeIds.length) return;
    const nextWorkflow = createCanvasGroup(workflow, selectedNodeIds);
    if (nextWorkflow === workflow) return;
    const group = normalizeCanvasGroups(nextWorkflow).at(-1);
    onWorkflowChange(nextWorkflow);
    if (group) {
      setSelectedGroupId(group.id);
      setSelectedNodeId(undefined);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    }
  }

  function updateGroup(groupId, patch) {
    onWorkflowChange(updateCanvasGroup(workflow, groupId, patch));
  }

  function deleteGroup(groupId) {
    onWorkflowChange(deleteCanvasGroup(workflow, groupId));
    setSelectedGroupId((current) => (current === groupId ? null : current));
  }

  function duplicateGroup(groupId) {
    const nextWorkflow = duplicateCanvasGroup(workflow, groupId);
    const group = normalizeCanvasGroups(nextWorkflow).at(-1);
    onWorkflowChange(nextWorkflow);
    if (group) {
      setSelectedGroupId(group.id);
      setSelectedNodeId(undefined);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
    }
  }

  function handleGroupPointerDown(event, groupId, mode = "move") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const group = canvasGroups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    groupDragRef.current = {
      groupId,
      mode,
      pointerId: event.pointerId,
      group,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedGroupId(groupId);
    setSelectedNodeId(undefined);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
  }

  function handleGroupPointerMove(event) {
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.movementX / viewport.scale;
    const dy = event.movementY / viewport.scale;
    if (drag.mode === "resize") {
      onWorkflowChange(
        updateCanvasGroup(workflow, drag.groupId, {
          width: drag.group.width + dx,
          height: drag.group.height + dy,
        }),
      );
      drag.group = { ...drag.group, width: drag.group.width + dx, height: drag.group.height + dy };
      return;
    }
    onWorkflowChange(moveCanvasGroup(workflow, drag.groupId, { x: dx, y: dy }));
  }

  function handleGroupPointerUp(event) {
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    groupDragRef.current = null;
  }

  async function applyValidationFix(fix) {
    const action = fix?.action;
    const payload = fix?.payload ?? {};
    if (!action) return;

    if (action === "remove_edge") {
      const edgeId = payload.edgeId;
      onWorkflowChange({
        ...workflow,
        edges: (workflow.edges ?? []).filter(
          (edge) =>
            edge.id !== edgeId &&
            !(edge.from === payload.from && edge.to === payload.to),
        ),
      });
      return;
    }

    if (action === "replace_edge_pattern") {
      const edgeId = payload.edgeId;
      onWorkflowChange({
        ...workflow,
        edges: (workflow.edges ?? []).map((edge) => {
          const matches =
            edge.id === edgeId || (edge.from === payload.from && edge.to === payload.to);
          if (!matches) return edge;
          const outputPattern = payload.outputPattern ?? "";
          return {
            ...edge,
            condition: "output_matches",
            outputPattern,
            label: edgeLabel("output_matches", outputPattern),
          };
        }),
      });
      return;
    }

    if (action === "create_agent") {
      const agentId = payload.agentId;
      if (!agentId || workflow.agents?.[agentId]) return;
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [agentId]: defaultAgentConfig(agentId),
        },
      });
      return;
    }

    if (action === "create_prompt_file") {
      const response = await fetch(apiUrl(`/workflows/${workflow.id}/validate/fix`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fix),
      });
      if (response.ok) {
        onValidateWorkflow?.();
      }
      return;
    }

    if (action === "disable_schedule") {
      onWorkflowChange({ ...workflow, schedule: null });
      return;
    }

    if (action === "set_schedule_timezone") {
      onWorkflowChange({
        ...workflow,
        schedule: {
          ...(workflow.schedule ?? { cron_expression: "0 9 * * *" }),
          timezone: payload.timezone ?? "UTC",
        },
      });
      return;
    }

    if (action === "disable_conflicting_triggers") {
      onWorkflowChange({ ...workflow, schedule: null, watch: null });
      return;
    }

    if (action === "disable_continuous") {
      onWorkflowChange({ ...workflow, runContinuously: false });
    }
  }

  async function handleCanvasDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    if (invalidWorkflow) return;

    const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
    if (!droppedFiles.length) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const newNodes = [];
    const untrustedDrops = [];
    let nextNumber = nextAvailableNodeNumber(workflowNodes);
    const usedNodeIds = new Set(workflowNodes.map((node) => node.id));

    for (const [index, file] of droppedFiles.entries()) {
      let droppedPath =
        window.goferDesktop?.getDroppedFilePath?.(file) ||
        file.path ||
        file.webkitRelativePath;
      if (!droppedPath) continue;
      try {
        droppedPath = await window.goferDesktop?.grantDroppedPath?.(file) ?? droppedPath;
      } catch (error) {
        console.error("Failed to grant dropped path", error);
      }

      let info = null;
      try {
        info = await window.goferDesktop?.workspace?.getPathInfo?.(droppedPath);
      } catch (error) {
        console.error("Failed to inspect dropped path", error);
      }

      const path = info?.path ?? droppedPath;
      const kind = info?.isDirectory ? "folder" : "file";
      if (!workflowAccessCoversPath(workflow, path, dataDir)) {
        untrustedDrops.push({ path, parent: pathParent(path), kind });
      }
      const operation = { type: kind, path };
      const worldX = (event.clientX - rect.left - viewport.x) / viewport.scale;
      const worldY = (event.clientY - rect.top - viewport.y) / viewport.scale;
      while (usedNodeIds.has(`node-${nextNumber}`)) {
        nextNumber += 1;
      }
      const nodeId = `node-${nextNumber}`;
      usedNodeIds.add(nodeId);
      newNodes.push({
        id: nodeId,
        label: info?.basename ?? pathBasename(path),
        type: kind,
        operation,
        settings: defaultSettings,
        meta: nodeMetaFromOperation(operation),
        x: worldX + index * 28,
        y: worldY + index * 28,
      });
      nextNumber += 1;
    }

    if (newNodes.length) {
      if (untrustedDrops.length) {
        setPendingTrustPrompt({
          nodes: newNodes,
          drops: untrustedDrops,
          parentPath: untrustedDrops[0].parent || untrustedDrops[0].path,
        });
        return;
      }
      addDroppedNodes(newNodes);
    }
  }

  function addDroppedNodes(newNodes, accessEntries = []) {
    if (!newNodes.length) return;
    onWorkflowChange({
      ...workflow,
      filesystemAccess: mergeWorkflowFilesystemAccess(workflow, accessEntries),
      nodes: [...workflowNodes, ...newNodes],
    });
    setSelectedNodeId(newNodes.at(-1).id);
    setSelectedNodeIds(newNodes.map((node) => node.id));
    setSelectedGroupId(null);
  }

  function trustPendingDroppedNodes(trustParents) {
    if (!pendingTrustPrompt) return;
    const accessEntries = uniqueAccessEntries(
      pendingTrustPrompt.drops.map((drop) => ({
        path: trustParents ? drop.parent || drop.path : drop.path,
        read: true,
        write: true,
        execute: false,
      })),
    );
    addDroppedNodes(pendingTrustPrompt.nodes, accessEntries);
    setPendingTrustPrompt(null);
  }

  function cancelPendingDroppedNodes() {
    setPendingTrustPrompt(null);
  }

  function deleteSelectedItem() {
    if (selectedGroup) {
      deleteGroup(selectedGroup.id);
      return;
    }
    if (!selectedNode) return;
    deleteNode(selectedNode.id);
  }

  function deleteSelectedNodesWithConfirmation() {
    const nodeIds = selectedNodeIds.filter((nodeId) => Boolean(nodesById[nodeId]));
    if (!nodeIds.length) return;
    const message =
      nodeIds.length === 1
        ? `Delete selected node "${nodesById[nodeIds[0]]?.label ?? nodeIds[0]}"?`
        : `Delete ${nodeIds.length} selected nodes?`;
    if (!window.confirm(message)) return;

    const nodesToDelete = new Set(nodeIds);
    const nextWorkflow = nodeIds.reduce(
      (currentWorkflow, nodeId) => removeWorkflowNode(currentWorkflow, nodeId),
      workflow,
    );
    const remainingNodes = nextWorkflow.nodes ?? [];
    const nextSelectedId = remainingNodes.find((node) => !nodesToDelete.has(node.id))?.id;

    onWorkflowChange(nextWorkflow);
    setSelectedNodeId(nextSelectedId);
    setSelectedNodeIds(nextSelectedId ? [nextSelectedId] : []);
    setSelectedEdgeId(null);
    setSelectedGroupId(null);
    setNodeContextMenu((current) =>
      current && nodesToDelete.has(current.nodeId) ? null : current,
    );
  }

  function deleteNode(nodeId) {
    const nextWorkflow = removeWorkflowNode(workflow, nodeId);
    const remainingNodes = nextWorkflow.nodes ?? [];
    const nextSelectedId = remainingNodes[0]?.id;

    onWorkflowChange(nextWorkflow);
    setSelectedNodeId((currentId) =>
      currentId === nodeId ? nextSelectedId : currentId,
    );
    setSelectedNodeIds((currentIds) =>
      currentIds.includes(nodeId)
        ? nextSelectedId
          ? [nextSelectedId]
          : []
        : currentIds,
    );
    setNodeContextMenu((current) => (current?.nodeId === nodeId ? null : current));
  }

  function duplicateNode(nodeId) {
    const nextWorkflow = duplicateWorkflowNode(workflow, nodeId, { usedAgentIds });
    const duplicatedNode = nextWorkflow.nodes.at(-1);
    if (!duplicatedNode || nextWorkflow === workflow) return;
    onWorkflowChange(nextWorkflow);
    setSelectedNodeId(duplicatedNode.id);
    setSelectedNodeIds([duplicatedNode.id]);
    setSelectedGroupId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  }

  function renameNode(nodeId) {
    const node = workflowNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    setNodeContextMenu(null);
    setNodeRenameDialog({
      nodeId,
      label: node.label ?? node.id,
    });
  }

  function confirmRenameNode(nodeId, nextLabel) {
    const trimmedLabel = nextLabel.trim();
    if (!trimmedLabel) {
      setNodeRenameDialog(null);
      return;
    }
    const node = nodesById[nodeId];
    if (node?.type === "workflow" && node.operation?.workflow_id) {
      Promise.resolve(onRenameWorkflow?.(node.operation.workflow_id, trimmedLabel)).then(
        (renamedWorkflow) => {
          if (renamedWorkflow?.id) {
            updateNodeOperation(nodeId, { workflow_id: renamedWorkflow.id });
          }
        },
      );
    }
    updateNode(nodeId, { label: trimmedLabel });
    setSelectedNodeId(nodeId);
    setSelectedNodeIds([nodeId]);
    setSelectedGroupId(null);
    setSelectedEdgeId(null);
    setNodeRenameDialog(null);
  }

  function showNodeContextMenu(event, nodeId) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId(nodeId);
    setSelectedNodeIds([nodeId]);
    setSelectedGroupId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu({
      nodeId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handleNodePointerDown(event, nodeId) {
    if (event.button !== 0) return;
    setNodeContextMenu(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragMovedRef.current = false;
    const nextSelection = selectedNodeIds.includes(nodeId) ? selectedNodeIds : [nodeId];
    nodeDragSelectionRef.current = nextSelection;
    setSelectedNodeId(nodeId);
    setSelectedNodeIds(nextSelection);
    setSelectedGroupId(null);
    setSelectedEdgeId(null);
    setDraggingNodeId(nodeId);
  }

  function handleNodePointerMove(event, nodeId) {
    if (draggingNodeId !== nodeId) return;
    if (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1) {
      nodeDragMovedRef.current = true;
    }
    const movingNodeIds = nodeDragSelectionRef.current.length
      ? nodeDragSelectionRef.current
      : [nodeId];
    const movingSet = new Set(movingNodeIds);
    const dx = event.movementX / viewport.scale;
    const dy = event.movementY / viewport.scale;

    onWorkflowChange({
      ...workflow,
      nodes: workflowNodes.map((node) =>
        movingSet.has(node.id)
          ? {
              ...node,
              x: (node.x ?? 0) + dx,
              y: (node.y ?? 0) + dy,
            }
          : node,
      ),
    });
  }

  function handleNodePointerUp(event, nodeId) {
    if (draftEdge && nodeId) {
      event.preventDefault();
      event.stopPropagation();
      addEdge(draftEdge.from, nodeId, "always");
      setDraftEdge(null);
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingNodeId(null);
    nodeDragSelectionRef.current = [];
  }

  async function handleNodeDoubleClick(node) {
    if (nodeDragMovedRef.current) {
      nodeDragMovedRef.current = false;
      return;
    }

    if (node.type === "file") {
      const path = node.operation?.path;
      if (path) {
        setFilePreviewPath(resolveDisplayPath(path, dataDir));
      }
      return;
    }

    if (node.type === "workflow") {
      if (node.operation?.workflow_id) {
        onNavigateWorkflow?.(node.operation.workflow_id);
      }
      return;
    }

    if (node.type === "folder") {
      const folderPath = node.operation?.path;
      if (!folderPath) {
        setFolderNodeEntries((current) => ({
          ...current,
          [node.id]: {
            loaded: true,
            error: "Choose an absolute folder path.",
            entries: [],
          },
        }));
        setExpandedFolderNodes((current) => ({
          ...current,
          [node.id]: true,
        }));
        return;
      }
      const nextExpanded = !expandedFolderNodes[node.id];
      setExpandedFolderNodes((current) => ({
        ...current,
        [node.id]: nextExpanded,
      }));
      if (nextExpanded && !folderNodeEntries[node.id]?.loaded) {
        try {
          const listing = await window.goferDesktop?.workspace?.listDirectory?.({
            currentPath: folderPath,
            create: false,
          });
          setFolderNodeEntries((current) => ({
            ...current,
            [node.id]: {
              loaded: true,
              entries: listing?.entries ?? [],
            },
          }));
        } catch (error) {
          setFolderNodeEntries((current) => ({
            ...current,
            [node.id]: {
              loaded: true,
              error: error instanceof Error ? error.message : "Unable to read folder",
              entries: [],
            },
          }));
        }
      }
    }
  }

  function handleCanvasPointerDown(event) {
    if (draftEdge) return;
    setNodeContextMenu(null);
    if (event.button === 0) {
      event.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const start = {
        x: (event.clientX - rect.left - viewport.x) / viewport.scale,
        y: (event.clientY - rect.top - viewport.y) / viewport.scale,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectedNodeId(undefined);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      setSelectionBox({
        pointerId: event.pointerId,
        start,
        current: start,
      });
      return;
    }

    if (event.button === 2) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanningPointerId(event.pointerId);
    }
  }

  function handleCanvasPointerMove(event) {
    if (draftEdge) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDraftEdge((current) =>
        current
          ? {
              ...current,
              to: {
                x: (event.clientX - rect.left - viewport.x) / viewport.scale,
                y: (event.clientY - rect.top - viewport.y) / viewport.scale,
              },
            }
          : current,
      );
      return;
    }
    if (selectionBox?.pointerId === event.pointerId) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      setSelectionBox((current) =>
        current
          ? {
              ...current,
              current: {
                x: (event.clientX - rect.left - viewport.x) / viewport.scale,
                y: (event.clientY - rect.top - viewport.y) / viewport.scale,
              },
            }
          : current,
      );
      return;
    }
    if (panningPointerId !== event.pointerId) return;
    event.preventDefault();
    setViewport((current) => ({
      ...current,
      x: current.x + event.movementX,
      y: current.y + event.movementY,
    }));
  }

  function handleCanvasPointerUp(event) {
    if (draftEdge) {
      setDraftEdge(null);
      return;
    }
    if (selectionBox?.pointerId === event.pointerId) {
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const box = normalizedSelectionBox(selectionBox);
      const selectedIds = selectionBoxArea(box) > 9
        ? workflowNodes
            .filter((node) => nodeIntersectsBox(node, box))
            .map((node) => node.id)
        : [];
      setSelectedNodeIds(selectedIds);
      setSelectedNodeId(selectedIds.at(-1));
      setSelectedEdgeId(null);
      setSelectionBox(null);
      return;
    }
    if (panningPointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanningPointerId(null);
  }

  function handleConnectorPointerDown(event, nodeId) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fromNode = nodesById[nodeId];
    const start = {
      x: fromNode.x + nodeWidth,
      y: fromNode.y + nodeHeight / 2,
    };
    setSelectedNodeId(undefined);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    setDraftEdge({
      from: nodeId,
      start,
      to: {
        x: (event.clientX - rect.left - viewport.x) / viewport.scale,
        y: (event.clientY - rect.top - viewport.y) / viewport.scale,
      },
    });
  }

  function handleConnectorPointerUp(event, nodeId) {
    if (!draftEdge || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (draftEdge.from && nodeId) {
      addEdge(draftEdge.from, nodeId, "always");
    }
    setDraftEdge(null);
  }

  function handleCanvasWheel(event) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const zoomMultiplier = event.deltaY < 0 ? 1.08 : 0.92;
    zoomViewportAtPoint(pointerX, pointerY, zoomMultiplier);
  }

  function zoomViewportAtPoint(pointerX, pointerY, zoomMultiplier) {
    setViewport((current) => {
      const nextScale = clamp(current.scale * zoomMultiplier, minZoom, maxZoom);
      const contentX = (pointerX - current.x) / current.scale;
      const contentY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - contentX * nextScale,
        y: pointerY - contentY * nextScale,
      };
    });
  }

  function viewportFromMinimapPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const bounds = graphBounds(workflowNodes, 160);
    const minimapScale = Math.min(
      minimapWidth / Math.max(1, bounds.width),
      minimapHeight / Math.max(1, bounds.height),
    );
    const worldX = bounds.left + (event.clientX - rect.left) / minimapScale;
    const worldY = bounds.top + (event.clientY - rect.top) / minimapScale;
    const size = canvasViewportSize();
    setViewport((current) => ({
      ...current,
      x: size.width / 2 - worldX * current.scale,
      y: size.height / 2 - worldY * current.scale,
    }));
  }

  function handleMinimapPointerDown(event) {
    if (event.button !== 0 || !workflowNodes.length) return;
    event.preventDefault();
    event.stopPropagation();
    setMinimapDragging(true);
    viewportFromMinimapPointer(event);
  }

  function handleMinimapPointerMove(event) {
    if (!minimapDragging) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const withinMinimap =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!withinMinimap) {
      setMinimapDragging(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    viewportFromMinimapPointer(event);
  }

  function handleMinimapPointerUp(event) {
    event.stopPropagation();
    setMinimapDragging(false);
  }

  function handleMinimapWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const size = canvasViewportSize();
    const zoomMultiplier = event.deltaY < 0 ? 1.08 : 0.92;
    zoomViewportAtPoint(size.width / 2, size.height / 2, zoomMultiplier);
  }

  function deleteEdge(edgeId) {
    onWorkflowChange({
      ...workflow,
      edges: workflowEdges.filter((edge) => edge.id !== edgeId),
    });
    setSelectedEdgeId((currentId) => (currentId === edgeId ? null : currentId));
  }

  function addEdge(fromNodeId, toNodeId, condition, outputPattern = null) {
    if (!fromNodeId || !toNodeId) return;

    const nextCondition = condition || "always";
    const nextOutputPattern = nextCondition === "output_matches" ? outputPattern || "" : null;
    const nextEdgeId = uniqueEdgeId(workflowEdges, fromNodeId, toNodeId);
    onWorkflowChange({
      ...workflow,
      edges: [
        ...workflowEdges,
        {
          id: nextEdgeId,
          from: fromNodeId,
          to: toNodeId,
          label: edgeLabel(nextCondition, nextOutputPattern),
          condition: nextCondition,
          outputPattern: nextOutputPattern,
        },
      ],
    });
    setSelectedNodeId(undefined);
    setSelectedNodeIds([]);
    setSelectedEdgeId(nextEdgeId);
  }

  function updateEdge(edgeId, patch) {
    onWorkflowChange({
      ...workflow,
      edges: workflowEdges.map((edge) => {
        if (edge.id !== edgeId) return edge;
        const nextEdge = { ...edge, ...patch };
        return {
          ...nextEdge,
          label: edgeLabel(nextEdge.condition, nextEdge.outputPattern),
        };
      }),
    });
  }

  function startInspectorResize(event) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent) {
      setInspectorWidth(clamp(startWidth - (moveEvent.clientX - startX), 280, 520));
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function startLogResize(event) {
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = logHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent) {
      setLogHeight(clamp(startHeight + startY - moveEvent.clientY, 140, 420));
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  const toolbarActions = [
    {
      disabled: invalidWorkflow,
      icon: Plus,
      label: "Add node",
      onClick: addNode,
    },
    {
      disabled: invalidWorkflow || !selectedNodeIds.length,
      icon: Group,
      label: selectedNodeIds.length ? "Create canvas group" : "Select nodes to group",
      menuLabel: "Create canvas group",
      onClick: addGroup,
    },
    {
      icon: Route,
      label: "Auto-layout graph",
      onClick: applyAutoLayout,
    },
    {
      icon: Maximize2,
      label: "Fit graph",
      onClick: fitGraph,
    },
    {
      disabled: !selectedNodeIds.length,
      icon: LocateFixed,
      label: "Fit selection",
      onClick: fitSelection,
    },
    {
      icon: ZoomOut,
      label: "Zoom out",
      onClick: () => zoomViewport(0.88),
    },
    {
      icon: ZoomIn,
      label: "Zoom in",
      onClick: () => zoomViewport(1.14),
    },
    {
      icon: LocateFixed,
      label: "Reset view",
      onClick: () => setViewport({ x: 0, y: 0, scale: 1 }),
    },
    {
      disabled: invalidWorkflow || (!selectedNode && !selectedGroup),
      icon: Trash2,
      label: "Delete selected item",
      onClick: deleteSelectedItem,
    },
    {
      icon: Upload,
      label: "Import workflow TOML or bundle",
      menuLabel: "Import workflow",
      onClick: () => importInputRef.current?.click(),
    },
    {
      disabled: invalidWorkflow,
      icon: Download,
      label: "Export workflow bundle",
      onClick: onExportWorkflow,
    },
    {
      disabled: invalidWorkflow,
      icon: Check,
      label: "Validate workflow",
      onClick: onValidateWorkflow,
    },
  ];
  const visibleToolbarActionCountValue = Math.min(
    visibleToolbarActions ?? toolbarActions.length,
    toolbarActions.length,
  );
  const visibleToolbarActionItems = toolbarActions.slice(0, visibleToolbarActionCountValue);
  const overflowToolbarActionItems = toolbarActions.slice(visibleToolbarActionCountValue);

  useEffect(() => {
    let frameId = 0;

    function updateToolbarOverflow() {
      window.cancelAnimationFrame?.(frameId);
      frameId = window.requestAnimationFrame?.(() => {
        const actionGroup = toolbarActionGroupRef.current;
        const measureRoot = toolbarMeasureRef.current;
        if (!actionGroup || !measureRoot) {
          setVisibleToolbarActions(toolbarActions.length);
          return;
        }
        if (typeof actionGroup.clientWidth !== "number") {
          setVisibleToolbarActions(toolbarActions.length);
          return;
        }
        const measuredElements = Array.from(measureRoot.childNodes ?? []).filter(
          (node) => node.nodeType === 1,
        );
        const actionWidths = measuredElements
          .filter((element) => element.getAttribute?.("data-toolbar-measure-action") !== null)
          .map((element) => element.getBoundingClientRect().width);
        const menuWidth =
          measuredElements
            .find((element) => element.getAttribute?.("data-toolbar-measure-menu") !== null)
            ?.getBoundingClientRect().width ?? 0;
        const nextCount = visibleToolbarActionCount(
          actionGroup.clientWidth,
          actionWidths,
          menuWidth,
          TOOLBAR_ACTION_GAP,
        );
        setVisibleToolbarActions((current) => (current === nextCount ? current : nextCount));
        if (nextCount >= toolbarActions.length) {
          setToolbarMenuOpen(false);
        }
      }) ?? window.setTimeout(() => {
        setVisibleToolbarActions(toolbarActions.length);
      }, 0);
    }

    updateToolbarOverflow();
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(updateToolbarOverflow) : null;
    if (resizeObserver && toolbarActionGroupRef.current) {
      resizeObserver.observe(toolbarActionGroupRef.current);
    }
    window.addEventListener("resize", updateToolbarOverflow);

    return () => {
      window.cancelAnimationFrame?.(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateToolbarOverflow);
    };
  }, [toolbarActions.length]);

  useEffect(() => {
    if (!toolbarMenuOpen) return undefined;

    function handlePointerDown(event) {
      if (toolbarMenuRef.current?.contains(event.target)) return;
      setToolbarMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [toolbarMenuOpen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="relative z-20 flex shrink-0 items-center gap-2 overflow-visible border-b border-line bg-white px-6 py-2"
          data-toolbar="graph-editor"
          data-toolbar-row="primary"
        >
            <input
              ref={importInputRef}
              accept=".toml,.zip,.gof"
              className="hidden"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onImportWorkflow(file);
                }
                event.target.value = "";
              }}
            />
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              disabled={runDisabled}
              title={runTitle}
              type="button"
              onClick={() => onRunWorkflow(workflow)}
            >
              <Play size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={invalidWorkflow || !workflowHasRunningRuns || Boolean(runState?.stopping)}
              title="Stop all runs"
              type="button"
              onClick={() => onStopWorkflow(workflow)}
            >
              <Square size={15} fill="currentColor" strokeWidth={1.7} />
            </button>
            <ToolbarRunSelector
              open={runMenuOpen}
              runs={logState?.runs ?? []}
              selectedRunId={logState?.selectedRunId}
              onOpenChange={setRunMenuOpen}
              onSelectRun={onSelectRunLog}
              onShowLatest={onLoadLatestLog}
              onReplayRun={onReplayRunLog}
              onResumeRun={onResumeRunLog}
              onStopRun={onStopRunLog}
              selectedNodeId={selectedNodeId}
            />
            <div
              ref={toolbarActionGroupRef}
              className="relative flex min-w-0 flex-1 items-center justify-start gap-2"
            >
              {visibleToolbarActionItems.map((action) => (
                <ToolbarActionButton key={action.label} action={action} />
              ))}
              {overflowToolbarActionItems.length ? (
                <div ref={toolbarMenuRef} className="relative shrink-0">
                  <button
                    className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                    title="More graph actions"
                    type="button"
                    onClick={() => setToolbarMenuOpen((current) => !current)}
                  >
                    <MoreVertical size={17} />
                  </button>
                  {toolbarMenuOpen ? (
                    <ToolbarOverflowMenu
                      actions={overflowToolbarActionItems.map((action) => ({
                        ...action,
                        label: action.menuLabel ?? action.label,
                      }))}
                      onClose={() => setToolbarMenuOpen(false)}
                    />
                  ) : null}
                </div>
              ) : null}
              <div
                ref={toolbarMeasureRef}
                aria-hidden="true"
                className="pointer-events-none invisible absolute right-0 top-0 flex gap-2"
              >
                {toolbarActions.map((action) => (
                  <ToolbarActionButton key={action.label} action={action} measure />
                ))}
                <button
                  className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted"
                  data-toolbar-measure-menu
                  tabIndex={-1}
                  type="button"
                >
                  <MoreVertical size={17} />
                </button>
              </div>
            </div>
            <form
              className="flex h-8 min-w-[8.5rem] max-w-[13rem] shrink items-center gap-1 rounded-lg border border-line bg-white px-2 text-xs focus-within:border-teal-500"
              onSubmit={handleSearchSubmit}
            >
              <Search size={14} className="shrink-0 text-muted" />
              <input
                ref={searchInputRef}
                aria-label="Search nodes"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                placeholder="Search nodes"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {searchQuery ? (
                <span className="shrink-0 text-[11px] text-muted">
                  {searchMatches.length ? searchMatchIndex + 1 : 0}/{searchMatches.length}
                </span>
              ) : null}
              <button
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-slate-100 hover:text-ink disabled:opacity-30"
                disabled={!searchMatches.length}
                title="Previous search match"
                type="button"
                onClick={() => moveSearchMatch(-1)}
              >
                <ChevronUp size={13} />
              </button>
              <button
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-slate-100 hover:text-ink disabled:opacity-30"
                disabled={!searchMatches.length}
                title="Next search match"
                type="button"
                onClick={() => moveSearchMatch(1)}
              >
                <ChevronDown size={13} />
              </button>
            </form>
            {notice?.message ? (
              <div
                className={`validation-pop absolute right-6 top-12 z-40 w-64 max-w-[calc(100vw-2rem)] rounded-lg border px-3 py-2 text-sm font-medium shadow-panel ${
                  notice.type === "error"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {notice.message}
              </div>
            ) : null}
        </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={canvasRef}
          data-testid="dag-canvas"
          className={`relative min-h-0 flex-1 overflow-hidden bg-[#f9fbfd] bg-[radial-gradient(circle_at_1px_1px,#d5dee8_1px,transparent_0)] [touch-action:none] ${
            panningPointerId !== null ? "cursor-grabbing" : "cursor-default"
          }`}
          style={{
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            backgroundSize: "22px 22px",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          onDragOver={(event) => {
            if (!invalidWorkflow) {
              event.preventDefault();
            }
          }}
          onDrop={handleCanvasDrop}
          onWheel={handleCanvasWheel}
        >
          <WorkflowTriggerStrip
            dataDir={dataDir}
            runContinuously={workflow.runContinuously}
            schedule={workflow.schedule}
            webhooks={workflow.webhooks}
            watch={workflow.watch}
          />
          {invalidWorkflow ? (
            <InvalidWorkflowCanvas workflow={workflow} />
          ) : (
            <div
              className="absolute left-0 top-0 h-0 w-0 origin-top-left overflow-visible"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
            >
              <svg
                className="absolute overflow-visible"
                aria-hidden="true"
                style={{
                  left: -graphWorldOffset,
                  top: -graphWorldOffset,
                  width: graphWorldSize,
                  height: graphWorldSize,
                  zIndex: 6,
                  pointerEvents: "none",
                }}
                viewBox={`0 0 ${graphWorldSize} ${graphWorldSize}`}
              >
                <defs>
                  <marker
                    id="arrowhead"
                    markerHeight="10"
                    markerWidth="10"
                    orient="auto"
                    refX="8"
                    refY="3"
                  >
                    <path d="M0,0 L0,6 L9,3 z" fill="#718096" />
                  </marker>
                </defs>
                <g transform={`translate(${graphWorldOffset} ${graphWorldOffset})`}>
                  {visibleWorkflowEdges.map((edge) => {
                    const from = nodesById[edge.from];
                    const to = nodesById[edge.to];
                    if (!from || !to) return null;

                    const reciprocal = workflowEdges.some(
                      (candidate) =>
                        candidate.id !== edge.id &&
                        candidate.from === edge.to &&
                        candidate.to === edge.from,
                    );
                    const laneOffset = reciprocal
                      ? stableEdgeDirection(edge.from, edge.to) * 44
                      : 0;
                    const geometry = edgeGeometry(from, to, edge.from === edge.to, laneOffset);

                    return (
                      <g key={edge.id}>
                        <path
                          d={geometry.path}
                          fill="none"
                          stroke="transparent"
                          strokeLinecap="round"
                          strokeWidth="16"
                          style={{ pointerEvents: "stroke" }}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedNodeId(undefined);
                            setSelectedNodeIds([]);
                            setSelectedGroupId(null);
                            setSelectedEdgeId(edge.id);
                          }}
                        />
                        <path
                          d={geometry.path}
                          fill="none"
                          markerEnd="url(#arrowhead)"
                          stroke={
                            edgeDiagnostics[edge.id]?.some(
                              (diagnostic) => diagnostic.severity === "error",
                            )
                              ? "#dc2626"
                              : selectedEdgeId === edge.id
                                ? "#0f766e"
                                : "#718096"
                          }
                          strokeLinecap="round"
                          strokeWidth={
                            edgeDiagnostics[edge.id]?.length || selectedEdgeId === edge.id
                              ? "4"
                              : "2.5"
                          }
                          style={{ pointerEvents: "none" }}
                        />
                        <text
                          x={geometry.label.x}
                          y={geometry.label.y}
                          className={`text-[12px] font-medium ${
                            selectedEdgeId === edge.id ? "fill-teal-700" : "fill-slate-500"
                          }`}
                          style={{ pointerEvents: "none" }}
                          textAnchor="middle"
                        >
                          {edge.label}
                        </text>
                      </g>
                    );
                  })}
                  {draftEdge ? (
                    <path
                      d={draftEdgePath(draftEdge)}
                      fill="none"
                      markerEnd="url(#arrowhead)"
                      stroke="#0f766e"
                      strokeDasharray="6 6"
                      strokeLinecap="round"
                      strokeWidth="3"
                      style={{ pointerEvents: "none" }}
                    />
                  ) : null}
                </g>
              </svg>

              {selectionBox ? (
                <SelectionRectangle box={normalizedSelectionBox(selectionBox)} />
              ) : null}

              {canvasGroups.map((group) => (
                <WorkflowGroup
                  key={group.id}
                  group={group}
                  selected={selectedGroupId === group.id}
                  onChange={updateGroup}
                  onSelect={(groupId) => {
                    setSelectedGroupId(groupId);
                    setSelectedNodeId(undefined);
                    setSelectedNodeIds([]);
                    setSelectedEdgeId(null);
                  }}
                  onPointerDown={handleGroupPointerDown}
                  onPointerMove={handleGroupPointerMove}
                  onPointerUp={handleGroupPointerUp}
                />
              ))}

              {visibleWorkflowNodes.map((node) => (
                <WorkflowNode
                  key={node.id}
                  node={{
                    ...node,
                    meta: nodeMetaFromOperation(node.operation ?? defaultOperation(node.type), dataDir),
                  }}
                  selected={selectedNodeIds.includes(node.id)}
                  status={nodeStatuses[node.id]}
                  zIndex={nodeStackIndex(node.id, {
                    draggingNodeId,
                    selectedNodeId,
                    selectedNodeIds,
                  })}
                  expanded={Boolean(expandedFolderNodes[node.id])}
                  folderEntries={folderNodeEntries[node.id]}
                  diagnostics={nodeDiagnostics[node.id] ?? []}
                  onDelete={deleteNode}
                  onDoubleClick={handleNodeDoubleClick}
                  onConnectorPointerDown={handleConnectorPointerDown}
                  onConnectorPointerUp={handleConnectorPointerUp}
                  onContextMenu={showNodeContextMenu}
                  onPointerDown={handleNodePointerDown}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                />
              ))}
            </div>
          )}
          {nodeContextMenu ? (
            <NodeContextMenu
              x={nodeContextMenu.x}
              y={nodeContextMenu.y}
              onDelete={() => deleteNode(nodeContextMenu.nodeId)}
              onDuplicate={() => duplicateNode(nodeContextMenu.nodeId)}
              onRename={() => renameNode(nodeContextMenu.nodeId)}
            />
          ) : null}
          {nodeRenameDialog ? (
            <NodeRenameDialog
              initialLabel={nodeRenameDialog.label}
              onCancel={() => setNodeRenameDialog(null)}
              onRename={(nextLabel) =>
                confirmRenameNode(nodeRenameDialog.nodeId, nextLabel)
              }
            />
          ) : null}
          {pendingTrustPrompt ? (
            <FilesystemTrustPrompt
              parentPath={pendingTrustPrompt.parentPath}
              onCancel={cancelPendingDroppedNodes}
              onConfirm={trustPendingDroppedNodes}
            />
          ) : null}
          {!invalidWorkflow && pendingApproval ? (
            <ApprovalDecisionOverlay
              approval={pendingApproval}
              node={pendingApprovalNode}
              onDecideApproval={onDecideApproval}
            />
          ) : null}
          {!invalidWorkflow ? (
            <GraphMinimap
              nodes={[
                ...visibleWorkflowNodes,
                ...canvasGroups.filter((group) => group.collapsed).map(groupRectForViewport),
              ]}
              selectedNodeIds={selectedNodeIds}
              viewport={viewport}
              viewportSize={canvasViewportSize()}
              onPointerDown={handleMinimapPointerDown}
              onPointerLeave={handleMinimapPointerUp}
              onPointerMove={handleMinimapPointerMove}
              onPointerUp={handleMinimapPointerUp}
              onWheel={handleMinimapWheel}
            />
          ) : null}
        </div>
      </div>

        {!invalidWorkflow ? (
          <Inspector
            agents={workflow.agents ?? {}}
            approval={selectedApproval}
            dashboards={dashboards}
            edges={workflowEdges}
            collapsed={inspectorCollapsed}
            edge={selectedEdge}
            group={selectedGroup}
            node={selectedNode}
            nodeRun={selectedRunNode}
            nodeOutput={selectedNodeOutput}
            nodes={workflowNodes}
            providerProfiles={providerProfiles}
            workflows={workflows}
            workflow={workflow}
            dataDir={dataDir}
            width={inspectorWidth}
            onAddEdge={addEdge}
            onDeleteEdge={deleteEdge}
            onDeleteGroup={deleteGroup}
            onDuplicateGroup={duplicateGroup}
            onAgentChange={updateAgentConfig}
            onDecideApproval={onDecideApproval}
            onEdgeChange={updateEdge}
            onGroupChange={updateGroup}
            onResizeStart={startInspectorResize}
            onNodeChange={(patch) => updateNode(selectedNode.id, patch)}
            onOperationChange={(patch) => updateNodeOperation(selectedNode.id, patch)}
            onProviderProfilesChange={setProviderProfiles}
            onSettingsChange={(patch) => updateNodeSettings(selectedNode.id, patch)}
            onToggleCollapsed={() => setInspectorCollapsed((current) => !current)}
            onTypeChange={(type) => updateNodeType(selectedNode.id, type)}
            onNavigateWorkflow={onNavigateWorkflow}
            onRenameWorkflow={onRenameWorkflow}
            onWorkflowChange={(patch) => onWorkflowChange({ ...workflow, ...patch })}
            onApplyFix={applyValidationFix}
          />
        ) : null}
      </div>
      <LogOverlay
        collapsed={logCollapsed}
        error={logState?.error}
        height={logHeight}
        loading={logState?.loading}
        logPath={logState?.path}
        runs={logState?.runs ?? []}
        runEvents={runEvents}
        selectedRunId={logState?.selectedRunId}
        retentionSettings={retentionSettings}
        text={displayedLog}
        title={logTitle}
        usageSummary={usageSummary}
        onResizeStart={startLogResize}
        onSelectRun={onSelectRunLog}
        onShowLatest={onLoadLatestLog}
        onResumeRun={onResumeRunLog}
        onReplayRun={onReplayRunLog}
        onPruneRuns={onPruneRunLogs}
        onRetentionSettingsChange={onRetentionSettingsChange}
        onStopRun={onStopRunLog}
        onToggle={() => setLogCollapsed((current) => !current)}
        selectedNodeId={selectedNodeId}
      />
      {filePreviewPath ? (
        <TextFileDialog
          mode="preview"
          path={filePreviewPath}
          onClose={() => setFilePreviewPath(null)}
        />
      ) : null}
    </div>
  );
}

function InvalidWorkflowCanvas({ workflow }) {
  const [copied, setCopied] = useState(false);
  const sourcePath = workflow.sourcePath || `${workflow.id}.toml`;
  const message =
    workflow.validationError ||
    workflow.description ||
    "The workflow TOML could not be parsed or validated.";
  const markdown = [
    "# Gofer Flow workflow TOML validation error",
    "",
    `Workflow file: \`${sourcePath}\``,
    "",
    "```text",
    message,
    "```",
    "",
  ].join("\n");

  async function copyMarkdown() {
    try {
      await navigator.clipboard?.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  async function openSourcePath() {
    if (!sourcePath) return;
    try {
      await window.goferDesktop?.workspace?.revealPath?.(sourcePath);
    } catch (error) {
      console.error("Failed to reveal workflow source path", error);
    }
  }

  return (
    <div className="absolute inset-0 z-10 grid place-items-center p-6">
      <section className="flex max-h-[72%] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-red-200 bg-red-50/95 shadow-panel backdrop-blur dark:border-red-950 dark:bg-[#241b1b]/95">
        <div className="flex items-start justify-between gap-4 border-b border-red-200 px-4 py-3 dark:border-red-950">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
              Invalid workflow TOML
            </h3>
            <button
              className="mt-1 block max-w-full truncate text-left text-xs text-red-700/80 underline-offset-2 transition hover:text-red-800 hover:underline dark:text-red-200/70 dark:hover:text-red-100"
              title={sourcePath}
              type="button"
              onClick={openSourcePath}
            >
              {sourcePath}
            </button>
          </div>
          <button
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 dark:border-red-900 dark:bg-[#2b2222] dark:text-red-200 dark:hover:bg-[#362828]"
            type="button"
            onClick={copyMarkdown}
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy markdown"}
          </button>
        </div>
        <div className="workflow-scrollbar min-h-0 overflow-y-auto px-4 py-3">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-red-900 dark:text-red-100">
            {message}
          </pre>
        </div>
      </section>
    </div>
  );
}

function WorkflowTriggerStrip({ dataDir, runContinuously, schedule, webhooks, watch }) {
  const enabledWebhooks = Object.entries(webhooks ?? {}).filter(([, config]) => config?.enabled);
  if (!runContinuously && !schedule && !watch && !enabledWebhooks.length) return null;
  const watchPath = watch?.path ? resolveDisplayPath(watch.path, dataDir) : "";

  return (
    <div className="pointer-events-none absolute left-5 top-5 z-20 flex max-w-[calc(100%-40px)] flex-wrap gap-2">
      {runContinuously ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-white/90 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur dark:bg-[#252526]/95">
          <RefreshCw size={14} className="text-teal-600" />
          <span className="truncate">Runs continuously</span>
        </div>
      ) : null}
      {!runContinuously && schedule ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-white/90 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur dark:bg-[#252526]/95">
          <CalendarDays size={14} className="text-teal-600" />
          <span className="truncate">
            Starts on schedule: {schedule.cron_expression}
          </span>
        </div>
      ) : null}
      {!runContinuously && watch ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-white/90 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur dark:bg-[#252526]/95">
          <FolderOpen size={14} className="text-teal-600" />
          <span className="truncate">
            Starts when files change: {watchPath}{watch.glob ? `/${watch.glob}` : ""}
            {watch.mode ? ` (${watch.mode})` : ""}
          </span>
        </div>
      ) : null}
      {enabledWebhooks.map(([triggerId, config]) => {
        const riskReasons = webhookRiskReasons(config);
        const highRisk = webhookIsHighRisk(config);
        return (
          <div
            key={triggerId}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium shadow-sm backdrop-blur ${
              highRisk
                ? "border-red-200 bg-red-50/95 text-red-900 dark:border-red-500/40 dark:bg-red-950/80 dark:text-red-100"
                : "border-line bg-white/90 text-ink dark:bg-[#252526]/95"
            }`}
            title={riskReasons.length ? webhookRiskSummary(riskReasons) : undefined}
          >
            {highRisk ? (
              <AlertCircle size={14} className="text-red-600" />
            ) : (
              <Webhook size={14} className="text-teal-600" />
            )}
            <span className="truncate">
              API trigger: {triggerId}
              {config.source ? ` (${config.source})` : ""}
              {highRisk ? " - high risk" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function webhookRiskReasons(config = {}) {
  const rawReasons = Array.isArray(config.riskReasons)
    ? config.riskReasons
    : String(config.riskReasons ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const reasons = new Set(rawReasons);
  const tokenConfigured = Boolean(config.tokenConfigured || config.token_env);
  if (config.enabled && !tokenConfigured && !config.allow_unauthenticated) {
    reasons.add("missing_authentication");
  }
  if (config.enabled && !tokenConfigured && config.allow_unauthenticated) {
    reasons.add("unauthenticated_allowed");
  }
  return [...reasons];
}

function webhookIsHighRisk(config = {}) {
  return config.risk === "high" || webhookRiskReasons(config).length > 0;
}

function webhookRiskSummary(reasons = []) {
  const labels = {
    missing_authentication: "Missing authentication",
    unauthenticated_allowed: "Unauthenticated requests allowed",
    raw_payload_retention: "Raw replay payload retention",
  };
  return reasons.map((reason) => labels[reason] ?? reason).join(", ");
}

function webhookAuthSummary(config = {}) {
  if (config.tokenConfigured || config.token_env) return "Token required";
  if (config.allow_unauthenticated) return "Unauthenticated requests allowed";
  return "No token configured";
}

function WorkflowGroup({
  group,
  onChange,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  selected,
}) {
  const height = group.collapsed ? collapsedGroupHeight : group.height;
  const generatedLabel = /^Group \d+$/.test(group.label);
  const [editingGeneratedLabel, setEditingGeneratedLabel] = useState(false);
  const displayedLabel = editingGeneratedLabel ? "" : group.label;
  const backgroundOpacity = clamp(
    group.collapsed ? Math.max(group.opacity, 0.12) : group.opacity,
    0,
    1,
  );

  return (
    <section
      className={`absolute rounded-lg border-2 shadow-sm ${
        selected ? "ring-2 ring-teal-500 ring-offset-2 dark:ring-offset-[#1e1e1e]" : ""
      }`}
      data-testid={`canvas-group-${group.id}`}
      style={{
        left: group.x,
        top: group.y,
        width: group.width,
        height,
        borderColor: group.color,
        backgroundColor: hexToRgba(group.color, backgroundOpacity),
        zIndex: group.collapsed ? 28 : 1,
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button === 0) {
          onPointerDown(event, group.id, "move");
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="flex h-11 cursor-grab items-center gap-1.5 border-b bg-white/90 px-2.5 shadow-sm active:cursor-grabbing dark:bg-[#111113]"
        style={{ borderColor: `${group.color}55` }}
        title="Move canvas group"
        onPointerDown={(event) => onPointerDown(event, group.id, "move")}
      >
        <input
          aria-label={`Rename ${group.label}`}
          className={`min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-sm font-semibold outline-none transition placeholder:text-muted focus:border-line focus:bg-white dark:placeholder:text-[#a1a1aa] dark:focus:bg-[#1e1e1e] ${
            generatedLabel
              ? "text-slate-600 dark:text-[#f8fafc]"
              : "text-ink dark:text-[#f4f4f5]"
          }`}
          placeholder={generatedLabel ? group.label : "Group name"}
          value={displayedLabel}
          onBlur={() => setEditingGeneratedLabel(false)}
          onChange={(event) => {
            setEditingGeneratedLabel(false);
            onChange(group.id, { label: event.target.value });
          }}
          onFocus={() => {
            onSelect(group.id);
            if (generatedLabel) {
              setEditingGeneratedLabel(true);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </div>
      {!group.collapsed ? (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl-md border-l border-t border-white/70 bg-white/80"
          title="Resize canvas group"
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDown(event, group.id, "resize");
          }}
        />
      ) : null}
    </section>
  );
}

function groupRectForViewport(group) {
  return {
    id: group.id,
    x: group.x,
    y: group.y,
    width: group.width,
    height: group.collapsed ? collapsedGroupHeight : group.height,
  };
}

function groupStatusLabel(status) {
  if (status === "approval") return "approval";
  if (status === "running" || status === "queued") return status;
  if (status === "error") return "failed";
  if (status === "success") return "done";
  return "idle";
}

function groupStatusClass(status) {
  if (status === "approval") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "running" || status === "queued") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "error") return "border-red-200 bg-red-50 text-red-700";
  if (status === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function GraphMinimap({
  nodes,
  onPointerDown,
  onPointerLeave,
  onPointerMove,
  onPointerUp,
  onWheel,
  selectedNodeIds,
  viewport,
  viewportSize,
}) {
  if (!nodes.length) return null;
  const bounds = graphBounds(nodes, 160);
  const scale = Math.min(
    minimapWidth / Math.max(1, bounds.width),
    minimapHeight / Math.max(1, bounds.height),
  );
  const viewportWorld = {
    left: -viewport.x / viewport.scale,
    top: -viewport.y / viewport.scale,
    width: viewportSize.width / viewport.scale,
    height: viewportSize.height / viewport.scale,
  };
  const selectedSet = new Set(selectedNodeIds);
  const toMinimapRect = (rect) => ({
    left: (rect.left - bounds.left) * scale,
    top: (rect.top - bounds.top) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  });
  const viewportRect = toMinimapRect(viewportWorld);

  return (
    <div
      className="absolute left-4 top-4 z-20 rounded-lg border border-line bg-white/70 p-2 opacity-80 shadow-panel backdrop-blur transition-opacity hover:opacity-100 dark:border-[#3a3a3d] dark:bg-[#252526]/70"
      data-testid="graph-minimap"
      title="Minimap"
      onWheel={onWheel}
    >
      <div
        className="relative cursor-crosshair overflow-hidden rounded-md bg-[#edf3f8]/80 dark:bg-[#1b1f22]/80"
        style={{ width: minimapWidth, height: minimapHeight }}
        onPointerDown={onPointerDown}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {nodes.map((node) => {
          const rect = toMinimapRect({
            left: node.x ?? 0,
            top: node.y ?? 0,
            width: node.width ?? nodeWidth,
            height: node.height ?? nodeHeight,
          });
          return (
            <div
              key={node.id}
              className={`absolute rounded-sm ${
                selectedSet.has(node.id) ? "bg-teal-600 dark:bg-teal-400" : "bg-slate-500 dark:bg-slate-500"
              }`}
              style={{
                left: rect.left,
                top: rect.top,
                width: Math.max(3, rect.width),
                height: Math.max(3, rect.height),
              }}
            />
          );
        })}
        <div
          className="absolute rounded-sm border-2 border-teal-700 bg-teal-500/10 dark:border-teal-300 dark:bg-teal-300/15"
          style={{
            left: viewportRect.left,
            top: viewportRect.top,
            width: Math.max(8, viewportRect.width),
            height: Math.max(8, viewportRect.height),
          }}
        />
      </div>
    </div>
  );
}

function extractNodeLog(logText, nodeId) {
  if (!logText || !nodeId) return "";
  const lines = logText.split("\n");
  const nodePrefix = ` - NODE - ${nodeId} - `;
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T/;
  const selectedLines = [];
  let includeContinuation = false;

  for (const line of lines) {
    if (line.includes(nodePrefix)) {
      selectedLines.push(line);
      includeContinuation = true;
      continue;
    }

    if (timestampPattern.test(line)) {
      includeContinuation = false;
      continue;
    }

    if (includeContinuation) {
      selectedLines.push(line);
    }
  }

  return selectedLines.join("\n").trim();
}

function formatWorkflowRunLog(result) {
  if (!result) return "";

  const lines = [
    `Workflow ${result.workflowId} ${result.success ? "completed successfully" : "failed"}`,
    `Duration: ${Number(result.durationSeconds ?? 0).toFixed(2)}s`,
  ];

  for (const [nodeId, output] of Object.entries(result.nodeOutputs ?? {})) {
    const status = output.success ? "success" : "failed";
    lines.push("");
    lines.push(`${nodeId} - ${status} - exit ${output.exitCode ?? 0}`);
    if (output.output) {
      lines.push(output.output);
    }
    for (const fanOutput of output.fanOutputs ?? []) {
      lines.push("");
      lines.push(`${fanOutput.label}:`);
      lines.push(fanOutput.output);
    }
  }

  return lines.join("\n").trim();
}

function getNodeStatuses(nodes, runResult, logText, runNodes = {}, runEvents = []) {
  const statuses = {};

  for (const [nodeId, nodeRun] of Object.entries(runNodes ?? {})) {
    const status = normalizeRunStatus(nodeRun?.status);
    if (status) {
      statuses[nodeId] = status;
    }
  }

  for (const event of runEvents ?? []) {
    const status = normalizeRunStatus(event?.status);
    if (event?.nodeId && event.nodeId !== "workflow" && status) {
      statuses[event.nodeId] = status;
    }
  }

  if (runResult?.nodeOutputs) {
    for (const [nodeId, output] of Object.entries(runResult.nodeOutputs)) {
      if (statuses[nodeId]) continue;
      if (output.skipped) {
        statuses[nodeId] = "skipped";
      } else {
        statuses[nodeId] = output.success ? "success" : "error";
      }
    }
  }

  for (const node of nodes) {
    if (statuses[node.id]) continue;
    const logStatus = getNodeStatusFromLog(logText, node.id);
    if (logStatus) {
      statuses[node.id] = logStatus;
    }
  }

  return statuses;
}

function normalizeRunStatus(status) {
  if (["queued", "started", "retried"].includes(status)) return status;
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "stopped") return "stopped";
  if (status === "skipped") return "skipped";
  if (status === "reused") return "reused";
  return null;
}

function getNodeStatusFromLog(logText, nodeId) {
  if (!logText || !nodeId) return null;
  const nodePrefix = ` - NODE - ${nodeId} - `;
  const events = [];

  for (const [lineIndex, line] of logText.split("\n").entries()) {
    const prefixIndex = line.indexOf(nodePrefix);
    if (prefixIndex === -1) continue;

    const message = line.slice(prefixIndex + nodePrefix.length).trim();
    if (message === "skipped") {
      events.push({ index: lineIndex, status: "skipped" });
      continue;
    }

    if (/(?:run \d+ )?attempt \d+ started/i.test(message)) {
      events.push({ index: lineIndex, status: "running" });
      continue;
    }

    const finishedMatch = message.match(
      /(?:run \d+ )?attempt \d+ finished success=(true|false)/i,
    );
    if (finishedMatch) {
      events.push({
        index: lineIndex,
        status: finishedMatch[1].toLowerCase() === "true" ? "success" : "error",
      });
    }
  }

  return events.at(-1)?.status ?? null;
}

function ToolbarRunSelector({
  onOpenChange,
  onReplayRun,
  onResumeRun,
  onSelectRun,
  onShowLatest,
  onStopRun,
  open,
  runs,
  selectedRunId,
  selectedNodeId,
}) {
  const menuRef = useRef(null);
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const activeRun = selectedRun ?? runs[0];
  const label = selectedRun ? formatRunLabel(selectedRun) : "Latest run";
  const status = activeRun?.status ?? "idle";

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target)) {
        onOpenChange(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [onOpenChange, open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        className={`flex h-8 max-w-[10rem] items-center gap-2 rounded-lg border px-2 text-xs font-medium transition ${
          open
            ? "border-slate-300 bg-white text-ink"
            : "border-line bg-white text-muted hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
        }`}
        title="Select workflow run"
        type="button"
        onClick={() => onOpenChange(!open)}
      >
        <RunStatusDot status={status} />
        <span className="max-w-[112px] truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0" />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-50 w-[300px] overflow-hidden rounded-lg border border-line bg-white shadow-panel">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="truncate text-xs font-semibold text-ink">
              {selectedRun ? formatRunLabel(selectedRun) : "Latest run"}
            </span>
            {selectedRun?.status === "running" ? (
              <button
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-white text-red-600 transition hover:border-red-200 hover:bg-red-50"
                title="Stop this run"
                type="button"
                onClick={() => onStopRun?.(selectedRun.id)}
              >
                <Square size={12} fill="currentColor" strokeWidth={1.7} />
              </button>
            ) : null}
          </div>
          {selectedRun ? (
            <RunHistoryActions
              run={selectedRun}
              selectedNodeId={selectedNodeId}
              onReplayRun={onReplayRun}
              onResumeRun={onResumeRun}
            />
          ) : null}
          <div className="workflow-scrollbar max-h-60 overflow-y-auto py-1">
            <button
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-slate-50 ${
                selectedRunId ? "" : "bg-teal-50"
              }`}
              type="button"
              onClick={() => {
                onOpenChange(false);
                onShowLatest?.();
              }}
            >
              <RunStatusDot status={runs[0]?.status ?? "idle"} />
              <span className="truncate font-medium text-ink">Latest run</span>
            </button>
            {runs.length ? (
              runs.map((run) => (
                <div
                  key={run.id}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-slate-50 ${
                    selectedRunId === run.id ? "bg-teal-50" : ""
                  }`}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onSelectRun?.(run.id);
                    }}
                  >
                    <RunStatusDot status={run.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-ink">
                        {formatRunLabel(run)}
                      </div>
                      <div className="truncate text-[11px] text-muted">{run.id}</div>
                    </div>
                  </button>
                  {run.status === "running" ? (
                    <button
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-white text-red-600 transition hover:border-red-200 hover:bg-red-50"
                      title="Stop this run"
                      type="button"
                      onClick={() => onStopRun?.(run.id)}
                    >
                      <Square size={12} fill="currentColor" strokeWidth={1.7} />
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-xs text-muted">No workflow runs yet.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LogOverlay({
  collapsed,
  error,
  height,
  loading,
  logPath,
  runEvents = [],
  runs = [],
  selectedRunId,
  onReplayRun,
  onResumeRun,
  onPruneRuns,
  onRetentionSettingsChange,
  onResizeStart,
  onSelectRun,
  onShowLatest,
  onStopRun,
  onToggle,
  selectedNodeId,
  retentionSettings = DEFAULT_RETENTION_SETTINGS,
  text,
  title,
  usageSummary,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [expandedRowIds, setExpandedRowIds] = useState({});
  const [filters, setFilters] = useState({
    attempt: "",
    datetime: "",
    fanOut: "",
    message: "",
    node: "",
    status: "",
  });
  const historyRef = useRef(null);
  const displayText = error
    ? error
    : loading
      ? "Loading log..."
      : text?.trim()
        ? text.trim()
        : "No run log available.";
  const timelineRows = useMemo(() => parseTimelineRows(runEvents), [runEvents]);
  const logRows = useMemo(
    () => (timelineRows.length ? timelineRows : parseLogRows(displayText)),
    [displayText, timelineRows],
  );
  const resolvedRetentionSettings = {
    ...DEFAULT_RETENTION_SETTINGS,
    ...(retentionSettings ?? {}),
  };
  const updateRetentionSetting = (key, value) => {
    const parsed = Number.parseInt(value, 10);
    onRetentionSettingsChange?.({
      ...resolvedRetentionSettings,
      [key]: Number.isNaN(parsed) ? 0 : Math.max(0, parsed),
    });
  };
  const pruneWithRetention = (dryRun) => {
    setRetentionOpen(false);
    onPruneRuns?.({
      dryRun,
      keepDays: resolvedRetentionSettings.keepDays,
      keepFailedDays: resolvedRetentionSettings.keepFailedDays,
      keepLast: resolvedRetentionSettings.keepLast,
    });
  };
  const usingTimeline = timelineRows.length > 0;
  const filteredRows = useMemo(() => {
    return logRows.filter((row) => {
      const attempt = filters.attempt.trim().toLowerCase();
      const datetime = filters.datetime.trim().toLowerCase();
      const fanOut = filters.fanOut.trim().toLowerCase();
      const node = filters.node.trim().toLowerCase();
      const message = filters.message.trim().toLowerCase();
      const status = filters.status.trim().toLowerCase();
      return (
        (!attempt || row.attempt.toLowerCase().includes(attempt)) &&
        (!datetime || row.datetime.toLowerCase().includes(datetime)) &&
        (!fanOut || row.fanOut.toLowerCase().includes(fanOut)) &&
        (!node || row.node.toLowerCase().includes(node)) &&
        (!message || row.message.toLowerCase().includes(message)) &&
        (!status || row.status.toLowerCase().includes(status))
      );
    });
  }, [filters, logRows]);

  useEffect(() => {
    setExpandedRowIds({});
  }, [displayText]);

  useEffect(() => {
    if (!historyOpen) return undefined;

    function handlePointerDown(event) {
      if (historyRef.current?.contains(event.target)) return;
      setHistoryOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [historyOpen]);

  return (
    <section
      className="relative z-30 shrink-0 overflow-hidden border-t border-line bg-white text-ink shadow-[0_-12px_30px_rgba(15,23,42,0.08)] transition-[height]"
      style={{ height: collapsed ? 44 : height }}
    >
      {!collapsed ? (
        <div
          className="absolute left-0 top-[-3px] z-20 h-1.5 w-full cursor-row-resize transition hover:bg-brand/40"
          role="separator"
          title="Resize workflow log"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <div
        className="flex h-11 w-full items-center justify-between border-b border-line bg-[#f9fbfd] px-4 text-left transition hover:bg-slate-50"
        role="button"
        tabIndex={0}
        title={collapsed ? "Expand log" : "Collapse log"}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-teal-100 bg-teal-50 text-teal-700">
            <Terminal size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{usingTimeline ? "Run timeline" : title}</h2>
            {logPath ? <p className="truncate text-[11px] text-muted">{logPath}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!collapsed ? (
            <div
              ref={historyRef}
              className="relative flex items-center gap-1"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className={`h-7 rounded-md border px-2 text-[11px] font-medium transition ${
                  selectedRunId
                    ? "border-line bg-white text-muted hover:bg-slate-50"
                    : "border-teal-200 bg-teal-50 text-teal-700"
                }`}
                type="button"
                onClick={() => {
                  setHistoryOpen(false);
                  onShowLatest?.();
                }}
              >
                Latest run
              </button>
              <button
                className={`h-7 rounded-md border px-2 text-[11px] font-medium transition ${
                  historyOpen
                    ? "border-slate-300 bg-white text-ink"
                    : "border-line bg-white text-muted hover:bg-slate-50"
                }`}
                type="button"
                onClick={() => setHistoryOpen((current) => !current)}
              >
                All runs
              </button>
              {historyOpen ? (
                <div className="absolute right-0 top-9 z-50 max-h-72 w-[310px] overflow-hidden rounded-lg border border-line bg-white shadow-panel">
                  <div className="border-b border-line px-3 py-2 text-xs font-semibold text-muted">
                    Previous runs
                  </div>
                  <div className="workflow-scrollbar max-h-60 overflow-y-auto">
                    {runs.length ? (
                      runs.map((run) => (
                        <div
                          key={run.id}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-slate-50 ${
                            selectedRunId === run.id ? "bg-teal-50" : ""
                          }`}
                        >
                          <button
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            type="button"
                            onClick={() => {
                              setHistoryOpen(false);
                              onSelectRun?.(run.id);
                            }}
                          >
                            <RunStatusDot status={run.status} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-ink">
                                {formatRunLabel(run)}
                              </div>
                              <div className="truncate text-[11px] text-muted">{run.id}</div>
                            </div>
                          </button>
                          {run.status === "running" ? (
                            <button
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-white text-red-600 transition hover:border-red-200 hover:bg-red-50"
                              title="Stop this run"
                              type="button"
                              onClick={() => onStopRun?.(run.id)}
                            >
                              <Square size={12} fill="currentColor" strokeWidth={1.7} />
                            </button>
                          ) : (
                            <button
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-white text-teal-700 transition hover:border-teal-200 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
                              title="Resume this run"
                              type="button"
                              onClick={() => onResumeRun?.(run.id, {})}
                            >
                              <Repeat2 size={13} />
                            </button>
                          )}
                          {run.hasTriggerReplay ? (
                            <button
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-white text-blue-700 transition hover:border-blue-200 hover:bg-blue-50"
                              title="Replay saved webhook payload"
                              type="button"
                              onClick={() => onReplayRun?.(run.id, run.triggerId)}
                            >
                              <Webhook size={13} />
                            </button>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="px-3 py-4 text-xs text-muted">No previous runs.</div>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="relative">
                <button
                  className={`grid h-7 w-7 place-items-center rounded-md border text-muted transition ${
                    retentionOpen
                      ? "border-slate-300 bg-white text-ink"
                      : "border-line bg-white hover:bg-slate-50"
                  }`}
                  title="Run retention settings"
                  type="button"
                  onClick={() => setRetentionOpen((current) => !current)}
                >
                  <Trash2 size={13} />
                </button>
                {retentionOpen ? (
                  <div className="absolute right-0 top-9 z-50 w-[280px] rounded-lg border border-line bg-white p-3 text-xs shadow-panel">
                    <div className="font-semibold text-ink">Retention</div>
                    <div className="mt-1 text-muted">Preview cleanup before pruning logs.</div>
                    <div className="mt-3 grid gap-2">
                      <label className="grid gap-1">
                        <span className="font-medium text-muted">Keep latest runs</span>
                        <input
                          className="h-8 rounded-md border border-line px-2 text-ink outline-none focus:border-teal-300"
                          min="0"
                          type="number"
                          value={resolvedRetentionSettings.keepLast}
                          onChange={(event) =>
                            updateRetentionSetting("keepLast", event.target.value)
                          }
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="font-medium text-muted">Keep runs for days</span>
                        <input
                          className="h-8 rounded-md border border-line px-2 text-ink outline-none focus:border-teal-300"
                          min="0"
                          type="number"
                          value={resolvedRetentionSettings.keepDays}
                          onChange={(event) =>
                            updateRetentionSetting("keepDays", event.target.value)
                          }
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="font-medium text-muted">Keep failed runs for days</span>
                        <input
                          className="h-8 rounded-md border border-line px-2 text-ink outline-none focus:border-teal-300"
                          min="0"
                          type="number"
                          value={resolvedRetentionSettings.keepFailedDays}
                          onChange={(event) =>
                            updateRetentionSetting("keepFailedDays", event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        className="h-7 rounded-md border border-line px-2 font-medium text-muted transition hover:bg-slate-50"
                        type="button"
                        onClick={() => pruneWithRetention(true)}
                      >
                        Preview
                      </button>
                      <button
                        className="h-7 rounded-md border border-red-200 bg-red-50 px-2 font-medium text-red-700 transition hover:bg-red-100"
                        type="button"
                        onClick={() => pruneWithRetention(false)}
                      >
                        Prune
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <span className="grid h-8 w-8 place-items-center rounded-md text-muted">
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </div>
      <div
        className="workflow-scrollbar overflow-auto bg-white dark:bg-[#1e1e1e]"
        style={{ height: Math.max(0, height - 44) }}
      >
        <UsageSummaryStrip summary={usageSummary} />
        <table className="w-full table-fixed border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-line bg-[#f9fbfd] dark:bg-[#252526]">
            <tr className="text-[11px] uppercase tracking-wide text-muted">
              <th className="w-[180px] px-3 pb-1 pt-2 font-semibold">Datetime</th>
              <th className="w-[140px] px-3 pb-1 pt-2 font-semibold">Node</th>
              {usingTimeline ? (
                <>
                  <th className="w-[105px] px-3 pb-1 pt-2 font-semibold">Status</th>
                  <th className="w-[90px] px-3 pb-1 pt-2 font-semibold">Attempt</th>
                  <th className="w-[110px] px-3 pb-1 pt-2 font-semibold">Fan-out</th>
                </>
              ) : null}
              <th className="px-3 pb-1 pt-2 font-semibold">Message</th>
            </tr>
            <tr className="border-t border-line/70">
              <th className="px-3 pb-2 pt-1">
                <LogFilterInput
                  label="Filter datetime"
                  value={filters.datetime}
                  onChange={(value) =>
                    setFilters((current) => ({ ...current, datetime: value }))
                  }
                />
              </th>
              <th className="px-3 pb-2 pt-1">
                <LogFilterInput
                  label="Filter node"
                  value={filters.node}
                  onChange={(value) =>
                    setFilters((current) => ({ ...current, node: value }))
                  }
                />
              </th>
              {usingTimeline ? (
                <>
                  <th className="px-3 pb-2 pt-1">
                    <LogFilterInput
                      label="Filter status"
                      value={filters.status}
                      onChange={(value) =>
                        setFilters((current) => ({ ...current, status: value }))
                      }
                    />
                  </th>
                  <th className="px-3 pb-2 pt-1">
                    <LogFilterInput
                      label="Filter attempt"
                      value={filters.attempt}
                      onChange={(value) =>
                        setFilters((current) => ({ ...current, attempt: value }))
                      }
                    />
                  </th>
                  <th className="px-3 pb-2 pt-1">
                    <LogFilterInput
                      label="Filter item"
                      value={filters.fanOut}
                      onChange={(value) =>
                        setFilters((current) => ({ ...current, fanOut: value }))
                      }
                    />
                  </th>
                </>
              ) : null}
              <th className="px-3 pb-2 pt-1">
                <LogFilterInput
                  label="Filter message"
                  value={filters.message}
                  onChange={(value) =>
                    setFilters((current) => ({ ...current, message: value }))
                  }
                />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {filteredRows.map((row) => {
              const expanded = Boolean(expandedRowIds[row.id]);
              return (
                <tr
                  key={row.id}
                  className="h-10 cursor-pointer align-top text-slate-700 transition hover:bg-slate-50 dark:text-[#cccccc] dark:hover:bg-[#2a2d2e]"
                  title={expanded ? "Collapse log row" : "Expand log row"}
                  onClick={() =>
                    setExpandedRowIds((current) => ({
                      ...current,
                      [row.id]: !current[row.id],
                    }))
                  }
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-muted">
                    <div className={expanded ? "whitespace-pre-wrap" : "truncate"}>
                      {row.datetime || "-"}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted">
                    <div className={expanded ? "whitespace-pre-wrap" : "truncate"}>
                      {row.node || "-"}
                    </div>
                  </td>
                  {usingTimeline ? (
                    <>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">
                        <div className={expanded ? "whitespace-pre-wrap" : "truncate"}>
                          {row.status || "-"}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">
                        <div className={expanded ? "whitespace-pre-wrap" : "truncate"}>
                          {row.attempt || "-"}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">
                        <div className={expanded ? "whitespace-pre-wrap" : "truncate"}>
                          {row.fanOut || "-"}
                        </div>
                      </td>
                    </>
                  ) : null}
                  <td className="px-3 py-2 font-mono text-[11px] leading-5">
                    <div
                      className={
                        expanded
                          ? "whitespace-pre-wrap break-words"
                          : "truncate whitespace-nowrap"
                      }
                    >
                      {row.message || "-"}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filteredRows.length ? (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-muted" colSpan={usingTimeline ? 6 : 3}>
                  {logRows.length ? "No log rows match the current filters." : displayText}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RunHistoryActions({ onReplayRun, onResumeRun, run, selectedNodeId }) {
  const canResume = run?.id && run.status !== "running";
  const canReplay = canResume && run?.hasTriggerReplay;
  return (
    <div className="grid gap-1 border-b border-line bg-slate-50 px-2 py-2">
      <button
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canResume}
        title="Resume this run"
        type="button"
        onClick={() => onResumeRun?.(run.id, {})}
      >
        <Repeat2 size={13} />
        <span className="truncate">Resume</span>
      </button>
      <button
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canResume}
        title="Rerun failed nodes"
        type="button"
        onClick={() => onResumeRun?.(run.id, { skipCache: true })}
      >
        <RefreshCw size={13} />
        <span className="truncate">Rerun failed nodes</span>
      </button>
      <button
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canResume || !selectedNodeId}
        title={selectedNodeId ? "Rerun from selected node" : "Select a node to rerun from it"}
        type="button"
        onClick={() => onResumeRun?.(run.id, { fromNode: selectedNodeId })}
      >
        <Route size={13} />
        <span className="truncate">Rerun from selected node</span>
      </button>
      <button
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canReplay}
        title={canReplay ? "Replay saved webhook payload" : "This run has no saved webhook payload"}
        type="button"
        onClick={() => onReplayRun?.(run.id, run.triggerId)}
      >
        <Webhook size={13} />
        <span className="truncate">Replay webhook payload</span>
      </button>
    </div>
  );
}

export function UsageSummaryStrip({ summary }) {
  const totals = summary?.totals;
  const calls = Number(totals?.agent_calls ?? 0);
  if (!summary || !totals || !calls) return null;

  const mostExpensive = firstUsageNode(summary.most_expensive_nodes);
  const slowest = firstUsageNode(summary.slowest_nodes);
  const budgetFailures = Array.isArray(summary.budget_failures)
    ? summary.budget_failures
    : [];

  return (
    <div className="border-b border-line bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:bg-[#252526] dark:text-[#cccccc]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-ink dark:text-white">LLM usage</span>
        <span>{calls} calls</span>
        <span>{formatInteger(totals.total_tokens)} tokens</span>
        <span>cost~{formatCurrency(totals.estimated_cost)}</span>
        <span>{formatUsageSeconds(totals.agent_time_seconds)} agent time</span>
        {mostExpensive ? (
          <span>
            Most expensive: {mostExpensive.node_id} ({formatCurrency(mostExpensive.estimated_cost)})
          </span>
        ) : null}
        {slowest ? (
          <span>
            Slowest: {slowest.node_id} ({formatUsageSeconds(slowest.duration_seconds)})
          </span>
        ) : null}
        {budgetFailures.length ? (
          <span className="font-semibold text-red-700">
            Budget failures: {budgetFailures.map((node) => node.node_id).join(", ")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function firstUsageNode(nodes) {
  return Array.isArray(nodes) && nodes.length ? nodes[0] : null;
}

function formatCurrency(value) {
  const number = Number(value ?? 0);
  return `$${number.toFixed(number >= 1 ? 2 : 6)}`;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

function formatUsageSeconds(value) {
  return `${Number(value ?? 0).toFixed(2)}s`;
}

function LogFilterInput({ label, onChange, value }) {
  return (
    <input
      aria-label={label}
      className="h-7 w-full rounded-md border border-line bg-white px-2 text-[11px] font-normal text-ink outline-none transition placeholder:text-muted/70 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10 dark:bg-[#1e1e1e]"
      placeholder={label}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function parseLogRows(logText) {
  if (!logText?.trim()) return [];
  const rows = [];
  const timestampPattern =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+-\s+(.*)$/;

  function pushRow(row) {
    if (!row) return;
    rows.push({
      attempt: "",
      fanOut: "",
      ...row,
      message: row.message.trimEnd(),
      status: "",
    });
  }

  let current = null;
  logText.split("\n").forEach((line, index) => {
    const match = line.match(timestampPattern);
    if (match) {
      pushRow(current);
      const parsed = parseLogPayload(match[2]);
      current = {
        id: `log-row-${index}`,
        datetime: match[1],
        node: parsed.node,
        message: parsed.message,
      };
      return;
    }

    if (current) {
      current.message = current.message ? `${current.message}\n${line}` : line;
    } else if (line.trim()) {
      current = {
        id: `log-row-${index}`,
        datetime: "",
        node: "",
        message: line,
      };
    }
  });

  pushRow(current);
  return rows;
}

function parseTimelineRows(events = []) {
  if (!Array.isArray(events) || !events.length) return [];
  return events.map((event, index) => {
    const fanOut = event?.fanOutItem?.index ?? event?.fanOutItem?.file_name ?? "";
    return {
      id: `timeline-row-${index}`,
      attempt: event?.attempt == null ? "" : String(event.attempt),
      datetime: event?.occurredAt ?? "",
      fanOut: fanOut === "" ? "" : String(fanOut),
      message: event?.message ?? "",
      node: event?.nodeId ?? "",
      status: event?.status ?? "",
    };
  });
}

function parseLogPayload(payload) {
  const nodeMatch = payload.match(/^NODE\s+-\s+(.+?)\s+-\s+(.*)$/);
  if (nodeMatch) {
    return {
      node: nodeMatch[1],
      message: nodeMatch[2],
    };
  }

  const levelMatch = payload.match(/^(INFO|ERROR|WARN|WARNING|DEBUG)\s+-\s+(.*)$/);
  if (levelMatch) {
    return {
      node: levelMatch[1],
      message: levelMatch[2],
    };
  }

  return {
    node: "workflow",
    message: payload,
  };
}

function RunStatusDot({ status }) {
  if (["running", "started", "retried"].includes(status)) {
    return <Loader2 className="shrink-0 animate-spin text-blue-500" size={13} />;
  }
  if (status === "queued") {
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-blue-400 bg-blue-50" />;
  }
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "reused"
        ? "bg-teal-500"
      : status === "error"
        ? "bg-red-500"
        : status === "stopped"
          ? "bg-amber-500"
          : "bg-slate-400";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}

function RunNodeInspector({ nodeRun }) {
  const attempts = Array.isArray(nodeRun?.attempts) ? nodeRun.attempts : [];
  const data = nodeRun?.data ?? {};
  const edgeDecisions = Array.isArray(data.edgeDecisions) ? data.edgeDecisions : [];
  const fanOut = data.fanOut ?? null;
  const fanOutItems = Array.isArray(fanOut?.items) ? fanOut.items : [];
  const [selectedFanOutIndex, setSelectedFanOutIndex] = useState(null);
  const [attemptPage, setAttemptPage] = useState(0);
  const [selectedTextFieldId, setSelectedTextFieldId] = useState("output");
  const attemptsPerPage = 1;

  useEffect(() => {
    setSelectedFanOutIndex(null);
    setAttemptPage(0);
    setSelectedTextFieldId("output");
  }, [nodeRun?.nodeId]);

  const selectedFanOutItem =
    selectedFanOutIndex === null
      ? null
      : fanOutItems.find((item) => Number(item.index) === Number(selectedFanOutIndex));
  const visibleAttempts =
    selectedFanOutIndex === null
      ? attempts
      : attempts.filter((attempt) => Number(attempt.fanOutItem?.index) === Number(selectedFanOutIndex));
  const attemptPageCount = Math.max(1, Math.ceil(visibleAttempts.length / attemptsPerPage));
  const clampedAttemptPage = Math.min(attemptPage, attemptPageCount - 1);
  const selectedAttempt = visibleAttempts[clampedAttemptPage] ?? null;

  useEffect(() => {
    setAttemptPage(0);
  }, [selectedFanOutIndex]);

  useEffect(() => {
    if (attemptPage !== clampedAttemptPage) {
      setAttemptPage(clampedAttemptPage);
    }
  }, [attemptPage, clampedAttemptPage]);

  return (
    <InspectorSection title="Last run">
      <KeyValueRows
        rows={[
          ["Status", nodeRun.status ?? ""],
          ["Duration", formatSeconds(nodeRun.durationSeconds)],
          ["Exit code", nodeRun.exitCode ?? ""],
          ["Attempts", attempts.length || ""],
          ["Reused", data.reused ? "Yes" : ""],
          ["Message", data.message ?? nodeRun.message ?? ""],
        ]}
      />
      {fanOut ? (
        <KeyValueRows
          rows={[
            ["Fan-out items", fanOut.itemCount ?? ""],
            ["Succeeded", fanOut.successCount ?? ""],
            ["Failed", fanOut.failureCount ?? ""],
          ]}
        />
      ) : null}
      {fanOutItems.length ? (
        <div className="space-y-2">
          <div className="workflow-scrollbar flex max-h-28 flex-wrap gap-1 overflow-auto rounded-md border border-line bg-slate-50 p-2">
            <button
              className={`rounded border px-2 py-1 text-[11px] ${selectedFanOutIndex === null ? "border-teal-400 bg-teal-50 text-teal-700" : "border-line bg-white text-slate-600"}`}
              type="button"
              onClick={() => setSelectedFanOutIndex(null)}
            >
              All
            </button>
            {fanOutItems.map((item) => (
              <button
                key={item.index}
                className={`rounded border px-2 py-1 text-[11px] ${Number(selectedFanOutIndex) === Number(item.index) ? "border-teal-400 bg-teal-50 text-teal-700" : "border-line bg-white text-slate-600"}`}
                type="button"
                onClick={() => setSelectedFanOutIndex(item.index)}
              >
                {item.index}: {item.status}
              </button>
            ))}
          </div>
          {selectedFanOutItem ? (
            <div className="rounded-md border border-line bg-slate-50 p-2 text-xs">
              <KeyValueRows
                rows={[
                  ["Item", selectedFanOutItem.index],
                  ["Status", selectedFanOutItem.status ?? ""],
                  ["Node", selectedFanOutItem.nodeId ?? ""],
                  ["Duration", formatSeconds(selectedFanOutItem.durationSeconds)],
                  ["Exit code", selectedFanOutItem.exitCode ?? ""],
                ]}
              />
              <ScrollableFieldViewer
                fields={fanOutItemTextFields(selectedFanOutItem)}
                selectedFieldId={selectedTextFieldId}
                onSelectField={setSelectedTextFieldId}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {attempts.length ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              Attempt {visibleAttempts.length ? clampedAttemptPage + 1 : 0} of {visibleAttempts.length}
            </span>
            {attemptPageCount > 1 ? (
              <div className="flex items-center gap-1">
                <button
                  className="rounded border border-line bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={clampedAttemptPage <= 0}
                  type="button"
                  onClick={() => setAttemptPage((current) => Math.max(0, current - 1))}
                >
                  Previous
                </button>
                <span className="px-1 text-[11px]">
                  {clampedAttemptPage + 1}/{attemptPageCount}
                </span>
                <button
                  className="rounded border border-line bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={clampedAttemptPage >= attemptPageCount - 1}
                  type="button"
                  onClick={() =>
                    setAttemptPage((current) => Math.min(attemptPageCount - 1, current + 1))
                  }
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
          {selectedAttempt ? (
            <div
              key={`${selectedAttempt.runNumber}-${selectedAttempt.attempt}-${clampedAttemptPage}`}
              className="rounded-md border border-line bg-slate-50 p-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2 font-medium text-ink">
                <span>{attemptRunLabel(selectedAttempt, clampedAttemptPage)}</span>
                <span>{formatSeconds(selectedAttempt.durationSeconds)}</span>
              </div>
              <ScrollableFieldViewer
                fields={attemptTextFields(selectedAttempt)}
                selectedFieldId={selectedTextFieldId}
                onSelectField={setSelectedTextFieldId}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {edgeDecisions.length ? (
        <div className="space-y-1">
          {edgeDecisions.map((decision, index) => (
            <div key={`${decision.to}-${index}`} className="flex items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-xs">
              <span className="truncate">
                {decision.from} {"->"} {decision.to}
              </span>
              <span className={decision.matched ? "text-emerald-700" : "text-muted"}>
                {decision.matched ? "matched" : "skipped"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </InspectorSection>
  );
}

function attemptRunLabel(attempt, fallbackIndex) {
  const attemptNumber = attempt.attempt ?? fallbackIndex + 1;
  const iteration = attemptIterationNumber(attempt);
  return iteration === null
    ? `Attempt ${attemptNumber}`
    : `Iteration ${iteration} - Attempt ${attemptNumber}`;
}

function attemptIterationNumber(attempt) {
  const rawIndex = attempt?.fanOutItem?.index ?? attempt?.loopItem?.index ?? attempt?.loop?.index;
  if (rawIndex === null || rawIndex === undefined || rawIndex === "") return null;
  const number = Number(rawIndex);
  if (!Number.isFinite(number)) return String(rawIndex);
  return number + 1;
}

function attemptTextFields(attempt) {
  return [
    attempt.inputs && Object.keys(attempt.inputs).length
      ? { id: "inputs", label: "Inputs", text: JSON.stringify(attempt.inputs, null, 2) }
      : null,
    attempt.output ? { id: "output", label: "Output", text: attempt.output } : null,
    attempt.stdout ? { id: "stdout", label: "Stdout", text: attempt.stdout } : null,
    attempt.stderr ? { id: "stderr", label: "Stderr", text: attempt.stderr, tone: "error" } : null,
    attempt.error && attempt.error !== attempt.stderr
      ? { id: "error", label: "Error", text: attempt.error, tone: "error" }
      : null,
    attempt.prompt ? { id: "prompt", label: "Prompt", text: attempt.prompt } : null,
  ].filter(Boolean);
}

function fanOutItemTextFields(item) {
  return [
    item.item ? { id: "item", label: "Iteration item", text: JSON.stringify(item.item, null, 2) } : null,
    item.output ? { id: "output", label: "Output", text: item.output } : null,
    item.error ? { id: "error", label: "Error", text: item.error, tone: "error" } : null,
  ].filter(Boolean);
}

function ScrollableFieldViewer({ fields, selectedFieldId, onSelectField }) {
  if (!fields.length) return null;
  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? fields[0];
  const errorTone = selectedField.tone === "error";
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-line bg-white">
      <div className="flex flex-wrap gap-1 border-b border-line bg-slate-50 p-1">
        {fields.map((field) => {
          const selected = field.id === selectedField.id;
          return (
            <button
              key={field.id}
              className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
                selected
                  ? "bg-white text-ink shadow-sm"
                  : "text-muted hover:bg-white/70 hover:text-ink"
              }`}
              title={`Show ${field.label}`}
              type="button"
              onClick={() => onSelectField(field.id)}
            >
              {field.label}
            </button>
          );
        })}
      </div>
      <pre
        className={`workflow-scrollbar max-h-[min(48vh,520px)] min-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-5 ${
          errorTone ? "bg-red-50 text-red-700" : "bg-white text-slate-700"
        }`}
      >
        {selectedField.text}
      </pre>
    </div>
  );
}

function formatSeconds(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${number.toFixed(2)}s`;
}

function KeyValueRows({ rows }) {
  const visibleRows = rows.filter(([, value]) => value !== "" && value !== null && value !== undefined);
  if (!visibleRows.length) return null;
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {visibleRows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate font-medium text-slate-700">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatRunLabel(run) {
  if (!run?.startedAt) return "Run";
  const date = new Date(run.startedAt);
  if (Number.isNaN(date.getTime())) return run.startedAt;
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function SelectionRectangle({ box }) {
  return (
    <div
      className="pointer-events-none absolute z-20 border border-teal-500 bg-teal-500/10"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }}
    />
  );
}

function WorkflowNode({
  expanded,
  folderEntries,
  diagnostics = [],
  node,
  onConnectorPointerDown,
  onConnectorPointerUp,
  onContextMenu,
  onDoubleClick,
  selected,
  status,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  zIndex,
}) {
  const style = nodeStyles[node.type] ?? nodeStyles.agent;
  const Icon = style.icon;
  const isFileNode = node.type === "file";
  const isFolderNode = node.type === "folder";
  const extension = isFileNode ? fileExtension(node.operation?.path) : "";
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const hasWarning = diagnostics.some((diagnostic) => diagnostic.severity === "warning");
  const title = isFileNode
    ? "Double click to preview"
    : isFolderNode
      ? "Double click to expand"
      : diagnostics[0]?.message;
  const borderClass = hasError
    ? "border-red-500 ring-4 ring-red-100"
    : hasWarning
      ? "border-amber-400 ring-4 ring-amber-100"
      : selected
        ? "border-teal-500 ring-4 ring-teal-100"
        : style.border;

  return (
    <article
      className={`absolute w-[220px] cursor-grab rounded-lg border bg-white p-3 shadow-node transition active:cursor-grabbing ${borderClass}`}
      data-node-id={node.id}
      data-testid="workflow-node"
      style={{ left: node.x, top: node.y, zIndex }}
      title={title}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.(node);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) {
          if (event.button === 2) {
            event.preventDefault();
          }
          return;
        }
        onPointerDown(event, node.id);
      }}
      onPointerMove={(event) => onPointerMove(event, node.id)}
      onPointerUp={(event) => onPointerUp(event, node.id)}
      onContextMenu={(event) => onContextMenu?.(event, node.id)}
    >
      <button
        className="absolute -right-2 top-1/2 z-10 h-4 w-4 -translate-y-1/2 rounded-full border border-teal-300 bg-white shadow-sm transition hover:scale-110 hover:border-teal-500 hover:bg-teal-50"
        data-testid="node-connector"
        title="Drag to connect"
        type="button"
        onPointerDown={(event) => onConnectorPointerDown?.(event, node.id)}
        onPointerUp={(event) => onConnectorPointerUp?.(event, node.id)}
      />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold leading-5">{node.label}</h3>
        <p className="mt-1 truncate text-xs leading-5 text-muted">{node.meta}</p>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <span className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white ${style.accent}`}>
          <Icon size={16} />
          {extension ? (
            <span className="absolute -bottom-1 -right-1 rounded bg-white px-1 text-[8px] font-bold leading-3 text-slate-700 shadow-sm">
              {extension.slice(0, 4)}
            </span>
          ) : null}
        </span>
        <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${style.chip}`}>
          {node.type}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {hasError || hasWarning ? (
            <AlertCircle
              className={hasError ? "text-red-600" : "text-amber-600"}
              size={15}
            />
          ) : null}
          <NodeStatusBadge status={status} />
        </div>
      </div>
      {isFolderNode && expanded ? (
        <FolderNodePreview state={folderEntries} />
      ) : null}
    </article>
  );
}

function NodeContextMenu({ onDelete, onDuplicate, onRename, x, y }) {
  return (
    <div
      className="fixed z-[90] w-48 rounded-lg border border-line bg-white p-1 text-sm shadow-panel"
      data-testid="node-context-menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50 hover:text-ink"
        type="button"
        onClick={onDuplicate}
      >
        <Copy size={15} />
        Duplicate node
      </button>
      <button
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50 hover:text-ink"
        type="button"
        onClick={onRename}
      >
        <PencilLine size={15} />
        Rename node
      </button>
      <div className="my-1 border-t border-line" />
      <button
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50"
        type="button"
        onClick={onDelete}
      >
        <Trash2 size={15} />
        Delete node
      </button>
    </div>
  );
}

function ToolbarActionButton({ action, measure = false }) {
  const Icon = action.icon;
  return (
    <button
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      data-toolbar-measure-action={measure ? "" : undefined}
      disabled={Boolean(action.disabled)}
      tabIndex={measure ? -1 : undefined}
      title={measure ? undefined : action.label}
      type="button"
      onClick={measure ? undefined : action.onClick}
    >
      <Icon size={17} />
    </button>
  );
}

function ToolbarOverflowMenu({ actions, onClose }) {
  return (
    <div
      className="absolute right-0 top-10 z-50 w-56 rounded-lg border border-line bg-white p-1 text-sm shadow-panel"
      data-testid="toolbar-overflow-menu"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.label}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 ${action.hiddenClassName ?? ""}`}
            disabled={Boolean(action.disabled)}
            type="button"
            onClick={() => {
              action.onClick?.();
              onClose?.();
            }}
          >
            <Icon size={15} />
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function NodeRenameDialog({ initialLabel, onCancel, onRename }) {
  const [label, setLabel] = useState(initialLabel || "");

  function submitRename() {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    onRename(trimmedLabel);
  }

  function handleSubmit(event) {
    event.preventDefault();
    submitRename();
  }

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-slate-950/25 px-4"
      onClick={onCancel}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form
        className="w-full max-w-sm rounded-lg border border-line bg-white shadow-panel"
        onSubmit={handleSubmit}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Rename node</h2>
            <p className="text-xs text-muted">Update the label shown on the graph.</p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="Close"
            type="button"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-4">
          <label className="block">
            <span className="text-xs font-medium text-muted">Node label</span>
            <input
              autoFocus
              className="mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm outline-none transition focus:border-teal-500"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!label.trim()}
            onClick={submitRename}
            title="Confirm node rename"
            type="button"
          >
            <PencilLine size={15} />
            Rename
          </button>
        </div>
      </form>
    </div>
  );
}

function FilesystemTrustPrompt({ parentPath, onCancel, onConfirm }) {
  const [trustParent, setTrustParent] = useState(true);
  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-slate-950/20 px-4 backdrop-blur-sm"
      role="presentation"
      onClick={onCancel}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <section
        className="w-full max-w-lg rounded-lg border border-line bg-white p-5 shadow-panel"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Trust the files in</h2>
            <p className="mt-1 break-all text-sm text-muted">{parentPath}</p>
          </div>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:bg-slate-50 hover:text-ink"
            title="Cancel"
            type="button"
            onClick={onCancel}
          >
            <X size={15} />
          </button>
        </div>
        <label className="mt-4 flex items-start gap-3 rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-ink">
          <input
            checked={trustParent}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
            type="checkbox"
            onChange={(event) => setTrustParent(event.target.checked)}
          />
          <span>Trust this parent folder and all files and subfolders inside it.</span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="inline-flex h-9 items-center justify-center rounded-md border border-line bg-white px-3 text-sm font-medium text-ink transition hover:bg-slate-50"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark"
            type="button"
            onClick={() => onConfirm(trustParent)}
          >
            <Check size={15} />
            Add access
          </button>
        </div>
      </section>
    </div>
  );
}

function PathSelectionTrustPrompt({ parentPath, path, onCancel, onConfirm }) {
  const [trustParent, setTrustParent] = useState(false);
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/30 px-4 backdrop-blur-sm">
      <section className="w-full max-w-lg rounded-lg border border-line bg-white p-5 shadow-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Trust selected path?</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              This path is outside the project folder and current trusted directories.
            </p>
            <p className="mt-2 break-all rounded-md border border-line bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {path}
            </p>
          </div>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:bg-slate-50 hover:text-ink"
            title="Cancel"
            type="button"
            onClick={onCancel}
          >
            <X size={15} />
          </button>
        </div>
        <label className="mt-4 flex items-start gap-3 rounded-md border border-line bg-slate-50 px-3 py-2 text-sm text-ink">
          <input
            checked={trustParent}
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
            type="checkbox"
            onChange={(event) => setTrustParent(event.target.checked)}
          />
          <span>
            Trust parent folder instead
            {parentPath ? (
              <span className="mt-1 block break-all text-xs text-muted">{parentPath}</span>
            ) : null}
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="inline-flex h-9 items-center justify-center rounded-md border border-line bg-white px-3 text-sm font-medium text-ink transition hover:bg-slate-50"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-brand px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark"
            type="button"
            onClick={() => onConfirm(trustParent)}
          >
            <Check size={15} />
            Trust and use path
          </button>
        </div>
      </section>
    </div>
  );
}

function FolderNodePreview({ state }) {
  if (!state?.loaded) {
    return <div className="mt-3 text-[11px] text-muted">Loading folder...</div>;
  }

  if (state.error) {
    return <div className="mt-3 text-[11px] text-red-600">{state.error}</div>;
  }

  const entries = state.entries ?? [];

  return (
    <div className="workflow-scrollbar mt-3 max-h-36 overflow-auto rounded-md border border-line bg-slate-50 p-2">
      {entries.length ? (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div key={entry.path} className="flex min-w-0 items-center gap-2 text-[11px] text-slate-700">
              {entry.isDirectory ? (
                <FolderOpen size={12} className="shrink-0 text-amber-600" />
              ) : (
                <FileText size={12} className="shrink-0 text-slate-500" />
              )}
              <span className="truncate">{entry.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted">No visible children.</div>
      )}
    </div>
  );
}

function NodeStatusBadge({ status }) {
  if (!status) return null;

  if (["running", "started", "retried"].includes(status)) {
    return (
      <span
        className="flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-blue-700 dark:border-sky-700/70 dark:bg-sky-950/70 dark:text-sky-200"
        title={status}
      >
        <Loader2 size={10} className="animate-spin text-blue-600 dark:text-sky-300" />
        {status === "running" ? "run" : status}
      </span>
    );
  }

  if (status === "queued") {
    return (
      <span
        className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-blue-700 dark:border-sky-700/70 dark:bg-sky-950/70 dark:text-sky-200"
        title="queued"
      >
        queued
      </span>
    );
  }

  const className = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    error: "border-red-200 bg-red-50 text-red-700",
    stopped: "border-amber-200 bg-amber-50 text-amber-700",
    skipped: "border-slate-200 bg-slate-50 text-slate-500",
    reused: "border-teal-200 bg-teal-50 text-teal-700",
  }[status];

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${className}`} title={status}>
      {status}
    </span>
  );
}

const edgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "On success"],
  ["on_failure", "On failure"],
  ["output_matches", "Output matches"],
  ["after_loop", "After loop finishes"],
];

const compactEdgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "Success"],
  ["on_failure", "Failure"],
  ["output_matches", "Matches"],
  ["after_loop", "After loop"],
];

function Inspector({
  agents,
  approval,
  dashboards = [],
  collapsed,
  dataDir,
  edge,
  edges,
  group,
  node,
  nodeRun,
  nodeOutput,
  nodes,
  providerProfiles = [],
  workflows = [],
  workflow,
  onAddEdge,
  onAgentChange,
  onDecideApproval,
  onDeleteEdge,
  onDeleteGroup,
  onDuplicateGroup,
  onEdgeChange,
  onGroupChange,
  onNodeChange,
  onOperationChange,
  onApplyFix,
  onProviderProfilesChange,
  onResizeStart,
  onSettingsChange,
  onToggleCollapsed,
  onTypeChange,
  onNavigateWorkflow,
  onRenameWorkflow,
  onWorkflowChange,
  width,
}) {
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(!node && !edge && !group);
  const [edgeInspectorOpen, setEdgeInspectorOpen] = useState(Boolean(edge));
  const [groupInspectorOpen, setGroupInspectorOpen] = useState(Boolean(group));
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(Boolean(node));
  const [cronPickerOpen, setCronPickerOpen] = useState(false);
  const [draftEdge, setDraftEdge] = useState(null);
  const [addingFilesystemPath, setAddingFilesystemPath] = useState(false);
  const [filesystemPathDraft, setFilesystemPathDraft] = useState("");
  const latestWorkflowRef = useRef(workflow);
  const operation = node?.operation ?? defaultOperation(node?.type ?? "agent");
  const settings = { ...defaultSettings, ...(node?.settings ?? {}) };
  const existingSpecialTypes = new Set(
    nodes
      .filter((candidate) => candidate.id !== node?.id && isSpecialNodeType(candidate.type))
      .map((candidate) => candidate.type),
  );
  const nodeTypeOptions = [
    ["start", "START"],
    ["pass", "PASS"],
    ["fail", "FAIL"],
    ["break", "BREAK"],
    ["loop", "Loop"],
    ["workflow", "Workflow"],
    ["agent", "Agent"],
    ["bash_command", commandNodeLabel],
    ["python_script", "Python script"],
    ["shell_script", "Shell script"],
    ["read_file", "Read file"],
    ["write_file", "Write file"],
    ["copy_file", "Copy file"],
    ["move_file", "Move file"],
    ["delete_file", "Delete file"],
    ["file", "File path"],
    ["folder", "Folder path"],
    ["open_resource", "Open app / URL / file"],
    ["prompt_file", "Prompt file"],
    ["common_llm_task", "Common LLM task"],
    ["local_vectorize", "Local vector index"],
    ["local_search", "Local search"],
    ["http_request", "HTTP request"],
    ["approval_gate", "Approval gate"],
    ["notification", "Notification"],
    ["dashboard_item", "Dashboard item"],
  ].filter(([type]) => type === node?.type || !existingSpecialTypes.has(type));
  const workflowTargetOptions = [
    ["", "Choose workflow"],
    ...workflows
      .filter(
        (candidate) =>
          candidate.id !== workflow.id || candidate.id === operation.workflow_id,
      )
      .map((candidate) => [candidate.id, candidate.name || candidate.id]),
  ];
  const agentConfig =
    operation.type === "agent" || operation.type === "common_llm_task"
      ? agents[operation.agent_id] ?? defaultAgentConfig(operation.agent_id || "agent")
      : null;
  const schedule = workflow.schedule ?? null;
  const watch = workflow.watch ?? null;
  const webhooks = workflow.webhooks ?? {};
  const filesystemAccess = workflow.filesystemAccess ?? [];
  const manualFilesystemAccess = filesystemAccess
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !dataDir || !pathsMatch(entry.path, dataDir));
  const connectedEdges = node
    ? edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    : [];
  const inputSourceGroups = node ? buildInputSourceGroups(node, nodes, edges, dashboards) : [];
  const inputSourceOptions = flattenInputSourceGroups(inputSourceGroups);
  const workflowDiagnostics = workflowDiagnosticsForDisplay(workflow);
  const nodeDiagnostics = node
    ? diagnosticsForNode(workflowDiagnostics, node, agentConfig)
    : [];
  const agentDiagnostics = agentConfig
    ? diagnosticsForAgent(workflowDiagnostics, operation.agent_id, agentConfig)
    : [];
  const edgeDiagnostics = edge ? diagnosticsForEdge(workflowDiagnostics, edge) : [];
  const workflowFieldDiagnostics = (...fields) =>
    diagnosticsForField(workflowDiagnostics, ...fields);
  const nodeFieldDiagnostics = (...fields) => diagnosticsForField(nodeDiagnostics, ...fields);
  const edgeFieldDiagnostics = (...fields) => diagnosticsForField(edgeDiagnostics, ...fields);

  useEffect(() => {
    latestWorkflowRef.current = workflow;
  }, [workflow]);

  useEffect(() => {
    setWorkflowSettingsOpen(!node && !edge && !group);
    setEdgeInspectorOpen(Boolean(edge));
    setGroupInspectorOpen(Boolean(group));
    setNodeInspectorOpen(Boolean(node));
    setDraftEdge(null);
  }, [edge?.id, group?.id, node?.id]);

  function updateWorkflowSchedule(patch) {
    const currentSchedule = schedule ?? { cron_expression: "0 9 * * *", timezone: "UTC" };
    const nextSchedule = { ...currentSchedule, ...patch };
    onWorkflowChange({ schedule: nextSchedule });
  }

  function updateWorkflowWatch(patch) {
    const currentWatch = watch ?? {
      path: dataDir || "",
      glob: "*",
      recursive: false,
      debounce_seconds: 1,
      mode: "batch",
      max_concurrency: 1,
    };
    onWorkflowChange({ watch: { ...currentWatch, ...patch } });
  }

  function updateWorkflowWebhook(triggerId, patch) {
    const currentWebhook = webhooks[triggerId] ?? {
      id: triggerId,
      enabled: true,
      source: "webhook",
      concurrency_policy: "allow",
    };
    onWorkflowChange({
      webhooks: {
        ...webhooks,
        [triggerId]: { ...currentWebhook, ...patch, id: triggerId },
      },
    });
  }

  function addWorkflowWebhook() {
    let index = 1;
    let triggerId = "default";
    while (webhooks[triggerId]) {
      index += 1;
      triggerId = `webhook-${index}`;
    }
    updateWorkflowWebhook(triggerId, {});
  }

  function removeWorkflowWebhook(triggerId) {
    const nextWebhooks = { ...webhooks };
    delete nextWebhooks[triggerId];
    onWorkflowChange({ webhooks: nextWebhooks });
  }

  function updateFilesystemAccess(index, patch) {
    const current = workflow.filesystemAccess ?? [];
    onWorkflowChange({
      filesystemAccess: uniqueAccessEntries(
        current.map((entry, currentIndex) =>
          currentIndex === index ? { ...entry, ...patch } : entry,
        ),
      ),
    });
  }

  function addTrustedPath(pathValue) {
    const path = String(pathValue ?? "").trim();
    if (!path) return;
    const currentWorkflow = latestWorkflowRef.current ?? workflow;
    onWorkflowChange({
      ...currentWorkflow,
      filesystemAccess: uniqueAccessEntries([
        ...(currentWorkflow.filesystemAccess ?? []),
        { path },
      ]),
    });
  }

  function addFilesystemAccess(pathValue = filesystemPathDraft) {
    const path = String(pathValue ?? "").trim();
    if (!path) return;
    addTrustedPath(path);
    setFilesystemPathDraft("");
    setAddingFilesystemPath(false);
  }

  function removeFilesystemAccess(index) {
    onWorkflowChange({
      filesystemAccess: (workflow.filesystemAccess ?? []).filter(
        (_entry, currentIndex) => currentIndex !== index,
      ),
    });
  }

  return (
    <aside
      className="relative shrink-0 overflow-visible border-l border-line bg-white transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ width: collapsed ? 0 : width }}
    >
      {!collapsed ? (
        <div
          className="absolute left-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
          role="separator"
          title="Resize workflow settings and node inspector"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <button
        className="absolute left-[-15px] top-1/2 z-40 grid h-12 w-7 -translate-y-1/2 place-items-center rounded-full border border-line bg-white text-muted shadow-panel transition hover:-translate-y-1/2 hover:scale-105 hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
        title={
          collapsed
            ? "Show workflow settings and node inspector"
            : "Hide workflow settings and node inspector"
        }
        type="button"
        onClick={onToggleCollapsed}
      >
        {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>

      <div
        className={`workflow-scrollbar h-full overflow-y-auto transition-opacity duration-200 ${
          collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100"
        }`}
      >
        <PathTrustContext.Provider
          value={{
            isTrustedPath: (targetPath) => workflowAccessCoversPath(workflow, targetPath, dataDir),
            trustPath: addTrustedPath,
          }}
        >
        <InspectorPanel
          open={workflowSettingsOpen}
          subtitle={workflow.id}
          title="Workflow settings"
          onToggle={() => setWorkflowSettingsOpen((current) => !current)}
        >
          <div className="space-y-4 p-4">
            <InspectorSection title="Workflow">
              <TextField label="ID" value={workflow.id} readOnly />
              <TextField
                label="Label"
                value={workflow.name}
                onChange={(value) => onWorkflowChange({ name: value })}
              />
              {workflow.sourcePath ? (
                <TextField label="Source path" value={workflow.sourcePath} readOnly pathLink />
              ) : null}
              <HealthDiagnosticList diagnostics={workflowDiagnostics} onApplyFix={onApplyFix} />
              <NumberField
                label="Max total node runs"
                min="1"
                value={workflow.maxTotalNodeRuns ?? 1000}
                onChange={(value) => onWorkflowChange({ maxTotalNodeRuns: value || 1000 })}
              />
              <ToggleField
                checked={Boolean(workflow.runContinuously)}
                diagnostics={workflowFieldDiagnostics("runContinuously")}
                label="Run continuously"
                onChange={(checked) => onWorkflowChange({ runContinuously: checked })}
              />
              {workflow.runContinuously ? (
                <p className="text-sm leading-6 text-muted">
                  Continuous mode keeps one run active and overrides schedule and file watcher starts.
                  Stop all runs to turn it off.
                </p>
              ) : null}
            </InspectorSection>

            <InspectorSection title="Filesystem access">
              <div className="grid gap-3">
                {dataDir ? (
                  <div className="rounded-lg border border-line bg-slate-50 p-3">
                    <TextField label="Project folder" value={dataDir} readOnly pathLink />
                    <p className="mt-2 text-xs leading-5 text-muted">
                      The project folder is trusted automatically.
                    </p>
                  </div>
                ) : null}
                {manualFilesystemAccess.map(({ entry, index }) => (
                  <div
                    key={`${entry.path}-${index}`}
                    className="rounded-lg border border-line bg-slate-50 p-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <TextField
                          label="Trusted directory"
                          value={entry.path ?? ""}
                          onChange={(value) => updateFilesystemAccess(index, { path: value })}
                          pathPicker
                          pathBasePath={dataDir}
                          pathLink
                          placeholder="/absolute/path"
                          promptForTrust={false}
                        />
                      </div>
                      <button
                        className="mt-6 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                        title="Remove trusted directory"
                        type="button"
                        onClick={() => removeFilesystemAccess(index)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {addingFilesystemPath ? (
                  <div className="rounded-lg border border-brand/30 bg-white p-3 shadow-sm">
                    <TextField
                      label="Trusted directory"
                      value={filesystemPathDraft}
                      onChange={setFilesystemPathDraft}
                      pathPicker
                      pathBasePath={dataDir}
                      placeholder="/absolute/path"
                      promptForTrust={false}
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        className="h-8 rounded-md border border-line bg-white px-3 text-xs font-medium text-muted transition hover:bg-slate-50 hover:text-ink"
                        type="button"
                        onClick={() => {
                          setFilesystemPathDraft("");
                          setAddingFilesystemPath(false);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="h-8 rounded-md bg-brand px-3 text-xs font-semibold text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
                        type="button"
                        disabled={!filesystemPathDraft.trim()}
                        onClick={() => addFilesystemAccess()}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-xs font-medium text-ink transition hover:bg-slate-50"
                    type="button"
                    onClick={() => setAddingFilesystemPath(true)}
                  >
                    <Plus size={14} />
                    Add trusted directory
                  </button>
                )}
                <p className="text-xs leading-5 text-muted">
                  Trusted directories are saved with the workflow. Gofer can read and write files
                  in them, and Codex or Claude agent nodes receive them as sandbox paths.
                </p>
              </div>
            </InspectorSection>

            <InspectorSection
              title="Schedule"
              className={workflow.runContinuously ? "opacity-50" : ""}
            >
              <ToggleField
                checked={Boolean(schedule)}
                disabled={Boolean(workflow.runContinuously)}
                label="Scheduled"
                onChange={(checked) =>
                  onWorkflowChange({
                    schedule: checked
                      ? schedule ?? { cron_expression: "0 9 * * *", timezone: "UTC" }
                      : null,
                  })
                }
              />
              {schedule ? (
                <>
                  <CronExpressionField
                    diagnostics={workflowFieldDiagnostics("cron_expression")}
                    label="Cron expression"
                    value={schedule.cron_expression ?? ""}
                    onChange={(value) => updateWorkflowSchedule({ cron_expression: value })}
                    placeholder="0 9 * * *"
                    pickerOpen={cronPickerOpen}
                    onPickerOpenChange={setCronPickerOpen}
                  />
                  <TextField
                    diagnostics={workflowFieldDiagnostics("timezone")}
                    label="Timezone"
                    value={schedule.timezone ?? "UTC"}
                    onChange={(value) => updateWorkflowSchedule({ timezone: value })}
                    placeholder="UTC"
                  />
                </>
              ) : (
                <p className="text-sm leading-6 text-muted">
                  Turn scheduling on to persist a cron expression and timezone in the workflow TOML.
                </p>
              )}
            </InspectorSection>

            <InspectorSection
              title="File watcher"
              className={workflow.runContinuously ? "opacity-50" : ""}
            >
              <ToggleField
                checked={Boolean(watch)}
                disabled={Boolean(workflow.runContinuously)}
                label="Watch files"
                onChange={(checked) =>
                  onWorkflowChange({
                    watch: checked
                      ? watch ?? {
                          path: dataDir || "",
                          glob: "*",
                          recursive: false,
                          debounce_seconds: 1,
                          mode: "batch",
                          max_concurrency: 1,
                        }
                      : null,
                  })
                }
              />
              {watch ? (
                <>
                  <TextField
                    diagnostics={workflowFieldDiagnostics("path")}
                    label="Path"
                    value={watch.path ?? ""}
                    onChange={(value) => updateWorkflowWatch({ path: value })}
                    pathPicker
                    pathBasePath={dataDir}
                    placeholder="Absolute folder path"
                  />
                  <TextField
                    diagnostics={workflowFieldDiagnostics("glob")}
                    label="Glob"
                    value={watch.glob ?? "*"}
                    onChange={(value) => updateWorkflowWatch({ glob: value })}
                    placeholder="*"
                  />
                  <ToggleField
                    checked={Boolean(watch.recursive)}
                    label="Recursive"
                    onChange={(checked) => updateWorkflowWatch({ recursive: checked })}
                  />
                  <SelectField
                    label="Mode"
                    value={watch.mode ?? "batch"}
                    options={[
                      ["batch", "Batch changes into one run"],
                      ["queue", "Queue one run per file"],
                      ["fanout", "Fan-out changed files"],
                    ]}
                    onChange={(value) => updateWorkflowWatch({ mode: value })}
                  />
                  <NumberField
                    label="Max concurrency"
                    min="1"
                    value={watch.max_concurrency ?? 1}
                    onChange={(value) => updateWorkflowWatch({ max_concurrency: value || 1 })}
                  />
                  <NumberField
                    label="Debounce seconds"
                    min="0"
                    step="0.1"
                    value={watch.debounce_seconds ?? 1}
                    onChange={(value) => updateWorkflowWatch({ debounce_seconds: value || 0 })}
                  />
                </>
              ) : (
                <p className="text-sm leading-6 text-muted">
                  Turn file watching on to run this workflow when a watched file changes.
                </p>
              )}
            </InspectorSection>

            <InspectorSection title="Webhook/API triggers">
              <div className="grid gap-3">
                {Object.entries(webhooks).map(([triggerId, config]) => {
                  const riskReasons = webhookRiskReasons(config);
                  const highRisk = webhookIsHighRisk(config);
                  return (
                    <div
                      key={triggerId}
                      className={`rounded-lg border p-3 ${
                        highRisk
                          ? "border-red-200 bg-red-50"
                          : "border-line bg-slate-50"
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <div className="truncate text-sm font-semibold text-ink">{triggerId}</div>
                            {highRisk ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-xs font-semibold text-red-700">
                                <AlertCircle size={12} />
                                High risk
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-muted">
                            {webhookAuthSummary(config)}
                          </div>
                        </div>
                        <button
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                          title="Remove webhook trigger"
                          type="button"
                          onClick={() => removeWorkflowWebhook(triggerId)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {riskReasons.length ? (
                        <div className="mb-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-800">
                          {webhookRiskSummary(riskReasons)}
                        </div>
                      ) : null}
                      <ToggleField
                        checked={Boolean(config.enabled)}
                        label="Enabled"
                        onChange={(checked) => updateWorkflowWebhook(triggerId, { enabled: checked })}
                      />
                      <ToggleField
                        checked={Boolean(config.allow_unauthenticated)}
                        label="Allow unauthenticated local testing"
                        onChange={(checked) =>
                          updateWorkflowWebhook(triggerId, { allow_unauthenticated: checked })
                        }
                      />
                      <TextField
                        label="Source"
                        value={config.source ?? "webhook"}
                        onChange={(value) => updateWorkflowWebhook(triggerId, { source: value })}
                        placeholder="github"
                      />
                      <TextField
                        label="Fan-out path"
                        value={config.fanout_path ?? ""}
                        onChange={(value) =>
                          updateWorkflowWebhook(triggerId, { fanout_path: value || null })
                        }
                        placeholder="payload.items"
                      />
                      <TextField
                        label="Token environment variable"
                        value={config.token_env ?? ""}
                        onChange={(value) =>
                          updateWorkflowWebhook(triggerId, { token_env: value || null })
                        }
                        placeholder="GOFER_GITHUB_WEBHOOK_TOKEN"
                      />
                      <SelectField
                        label="Concurrency"
                        value={config.concurrency_policy ?? "allow"}
                        options={[
                          ["allow", "Allow concurrent runs"],
                          ["reject_if_running", "Reject while running"],
                        ]}
                        onChange={(value) =>
                          updateWorkflowWebhook(triggerId, { concurrency_policy: value })
                        }
                      />
                    </div>
                  );
                })}
                <button
                  className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-xs font-medium text-ink transition hover:bg-slate-50"
                  type="button"
                  onClick={addWorkflowWebhook}
                >
                  <Plus size={14} />
                  Add webhook trigger
                </button>
              </div>
            </InspectorSection>
          </div>
        </InspectorPanel>

        {group ? (
          <InspectorPanel
            open={groupInspectorOpen}
            subtitle={`${group.nodeIds.length} node${group.nodeIds.length === 1 ? "" : "s"}`}
            title="Group settings"
            onToggle={() => setGroupInspectorOpen((current) => !current)}
          >
            <div className="space-y-4 p-4">
              <InspectorSection title="Group">
                <TextField
                  label="Label"
                  value={group.label}
                  onChange={(value) => onGroupChange(group.id, { label: value })}
                  placeholder="Group name"
                />
                <label className="block">
                  <span className="text-xs font-medium text-muted">Color</span>
                  <input
                    aria-label={`Color ${group.label}`}
                    className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-2 py-1"
                    type="color"
                    value={group.color}
                    onChange={(event) => onGroupChange(group.id, { color: event.target.value })}
                  />
                </label>
                <GroupOpacityField
                  value={Math.round(group.opacity * 100)}
                  onCommit={(value) => onGroupChange(group.id, { opacity: value / 100 })}
                />
                <ToggleField
                  checked={Boolean(group.collapsed)}
                  label="Collapsed"
                  onChange={(checked) => onGroupChange(group.id, { collapsed: checked })}
                />
              </InspectorSection>

              <InspectorSection title="Layout">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="X"
                    value={Math.round(group.x)}
                    onChange={(value) => onGroupChange(group.id, { x: value || 0 })}
                  />
                  <NumberField
                    label="Y"
                    value={Math.round(group.y)}
                    onChange={(value) => onGroupChange(group.id, { y: value || 0 })}
                  />
                  <NumberField
                    label="Width"
                    min={groupMinWidth}
                    value={Math.round(group.width)}
                    onChange={(value) => onGroupChange(group.id, { width: value || groupMinWidth })}
                  />
                  <NumberField
                    label="Height"
                    min={groupMinHeight}
                    value={Math.round(group.height)}
                    onChange={(value) =>
                      onGroupChange(group.id, { height: value || groupMinHeight })
                    }
                  />
                </div>
              </InspectorSection>

              <InspectorSection title="Members">
                <div className="space-y-2">
                  {group.nodeIds.map((nodeId) => {
                    const member = nodes.find((candidate) => candidate.id === nodeId);
                    return (
                      <div
                        key={nodeId}
                        className="rounded-md border border-line bg-slate-50 px-3 py-2 text-sm"
                      >
                        <div className="font-medium text-ink">{member?.label || nodeId}</div>
                        <div className="text-xs text-muted">{nodeId}</div>
                      </div>
                    );
                  })}
                </div>
              </InspectorSection>

              <div className="grid grid-cols-2 gap-2">
                <button
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-xs font-medium text-ink transition hover:bg-slate-50"
                  type="button"
                  onClick={() => onDuplicateGroup(group.id)}
                >
                  <Copy size={14} />
                  Duplicate
                </button>
                <button
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-xs font-medium text-ink transition hover:bg-slate-50"
                  type="button"
                  onClick={() => onDeleteGroup(group.id)}
                >
                  <Trash2 size={14} />
                  Ungroup
                </button>
              </div>
            </div>
          </InspectorPanel>
        ) : null}

        {edge ? (
          <InspectorPanel
            open={edgeInspectorOpen}
            subtitle={`${edge.from} -> ${edge.to}`}
            title="Edge settings"
            onToggle={() => setEdgeInspectorOpen((current) => !current)}
          >
            <div className="space-y-4 p-4">
              <InspectorSection title="Relationship">
                <HealthDiagnosticList diagnostics={edgeDiagnostics} onApplyFix={onApplyFix} />
                <SelectField
                  diagnostics={edgeFieldDiagnostics("condition")}
                  label="Type"
                  value={edge.condition ?? "always"}
                  options={edgeConditionOptions}
                  onChange={(value) =>
                    onEdgeChange(edge.id, {
                      condition: value,
                      outputPattern:
                        value === "output_matches" ? edge.outputPattern ?? "" : null,
                    })
                  }
                />
                {edge.condition === "output_matches" ? (
                  <TextField
                    diagnostics={edgeFieldDiagnostics("outputPattern")}
                    label="Output pattern"
                    value={edge.outputPattern ?? ""}
                    onChange={(value) => onEdgeChange(edge.id, { outputPattern: value })}
                    placeholder="Regex pattern"
                  />
                ) : null}
              </InspectorSection>

              <InspectorSection title="Endpoints">
                <SelectField
                  diagnostics={edgeFieldDiagnostics("from")}
                  label="Source"
                  value={edge.from}
                  options={nodes.map((candidate) => [
                    candidate.id,
                    candidate.label || candidate.id,
                  ])}
                  onChange={(value) => onEdgeChange(edge.id, { from: value })}
                />
                <SelectField
                  diagnostics={edgeFieldDiagnostics("to")}
                  label="Target"
                  value={edge.to}
                  options={nodes.map((candidate) => [
                    candidate.id,
                    candidate.label || candidate.id,
                  ])}
                  onChange={(value) => onEdgeChange(edge.id, { to: value })}
                />
              </InspectorSection>
            </div>
          </InspectorPanel>
        ) : null}

        {node ? (
          <InspectorPanel
            open={nodeInspectorOpen}
            subtitle={node.id}
            title="Node settings"
            onToggle={() => setNodeInspectorOpen((current) => !current)}
          >
            <div className="space-y-4 p-4">
          <InspectorSection title="Node">
            <TextField label="ID" value={node.id} readOnly />
            {node.type === "workflow" ? (
              <WorkflowNodeLabelField
                node={node}
                workflows={workflows}
                onChange={(value) => onNodeChange({ label: value })}
                onRenameWorkflow={onRenameWorkflow}
                onTargetWorkflowRenamed={(renamedWorkflow) => {
                  if (renamedWorkflow?.id) {
                    onOperationChange({ workflow_id: renamedWorkflow.id });
                  }
                }}
              />
            ) : (
              <TextField
                label="Label"
                value={specialNodeLabel(node.type) ?? node.label}
                onChange={(value) => onNodeChange({ label: value })}
                readOnly={isSpecialNodeType(node.type)}
              />
            )}
            <SelectField
              label="Type"
              value={node.type}
              options={nodeTypeOptions}
              onChange={onTypeChange}
            />
            <HealthDiagnosticList diagnostics={nodeDiagnostics} onApplyFix={onApplyFix} />
          </InspectorSection>

          <InspectorSection title="Execution">
            <ToggleField
              checked={Boolean(settings.pipeOutput)}
              label="Pipe output"
              onChange={(checked) => onSettingsChange({ pipeOutput: checked })}
            />
            <ToggleField
              checked={settings.awaitAllInputs !== false}
              label="Await all inputs"
              onChange={(checked) => onSettingsChange({ awaitAllInputs: checked })}
            />
            {!settings.awaitAllInputs ? (
              <p className="text-sm leading-6 text-muted">
                This node can run as soon as any incoming edge is ready. Use this for loop entry points.
              </p>
            ) : null}
            <ToggleField
              checked={Boolean(settings.allowFailure)}
              label="Allow failure"
              onChange={(checked) => onSettingsChange({ allowFailure: checked })}
            />
            {settings.allowFailure ? (
              <p className="text-sm leading-6 text-muted">
                Failed output can still trigger on-failure edges, but it will not fail the whole workflow.
              </p>
            ) : null}
            <NumberField
              label="Retry count"
              min="0"
              value={settings.retryCount}
              onChange={(value) => onSettingsChange({ retryCount: value })}
            />
            <NumberField
              label="Retry delay seconds"
              min="0"
              step="0.1"
              value={settings.retryDelaySeconds}
              onChange={(value) => onSettingsChange({ retryDelaySeconds: value })}
            />
            <NumberField
              label="Timeout seconds"
              min="0"
              value={settings.timeoutSeconds ?? ""}
              onChange={(value) => onSettingsChange({ timeoutSeconds: value })}
              placeholder="None"
            />
          </InspectorSection>

          <InspectorSection title="Inputs">
            <InputMappingField
              sourceGroups={inputSourceGroups}
              sourceOptions={inputSourceOptions}
              value={node.inputs ?? {}}
              onChange={(value) => onNodeChange({ inputs: value })}
            />
          </InspectorSection>

          {operation.type === "start" ? (
            <InspectorSection title="START">
              <p className="text-sm leading-6 text-muted">
                This node does no work. It completes successfully and routes to the next matching edge.
              </p>
            </InspectorSection>
          ) : null}

          {operation.type === "pass" ? (
            <InspectorSection title="PASS">
              <TextareaField
                label="Success message"
                rows={3}
                value={operation.message ?? ""}
                onChange={(value) => onOperationChange({ message: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "fail" ? (
            <InspectorSection title="FAIL">
              <TextareaField
                label="Failure message"
                rows={3}
                value={operation.message ?? ""}
                onChange={(value) => onOperationChange({ message: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "break" ? (
            <InspectorSection title="BREAK">
              <TextareaField
                label="Break message"
                rows={3}
                value={operation.message ?? ""}
                onChange={(value) => onOperationChange({ message: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "workflow" ? (
            <InspectorSection title="Workflow">
              <SelectField
                label="Target workflow"
                value={operation.workflow_id ?? ""}
                options={workflowTargetOptions}
                onChange={(value) => onOperationChange({ workflow_id: value })}
              />
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-primary transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!operation.workflow_id}
                onClick={() => operation.workflow_id && onNavigateWorkflow?.(operation.workflow_id)}
              >
                <ExternalLink className="h-4 w-4" />
                Open workflow
              </button>
              <p className="text-sm leading-6 text-muted">
                Runs the selected workflow when this node fires. The target workflow name is used as
                this node label.
              </p>
            </InspectorSection>
          ) : null}

          {operation.type === "loop" ? (
            <InspectorSection title="Loop">
              <SelectField
                label="Source"
                value={operation.source?.type ?? "count"}
                options={[
                  ["count", "Count"],
                  ["tabular", "JSONL or CSV rows"],
                  ["directory", "Directory files"],
                  ["trigger_events", "Trigger events"],
                  ["dashboard_items", "Dashboard items"],
                  ["infinite", "Until BREAK"],
                ]}
                onChange={(value) => onOperationChange({ source: defaultFanSource(value) })}
              />
              {operation.source?.type === "count" ? (
                <NumberField
                  label="Count"
                  min="1"
                  value={String(operation.source.count ?? 1)}
                  onChange={(value) =>
                    onOperationChange({ source: { ...operation.source, count: value || 1 } })
                  }
                />
              ) : null}
              {operation.source?.type === "tabular" ? (
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.source.path")}
                  label="Path"
                  value={operation.source.path ?? ""}
                  onChange={(value) =>
                    onOperationChange({ source: { ...operation.source, path: value } })
                  }
                  pathPicker
                  pathBasePath={dataDir}
                />
              ) : null}
              {operation.source?.type === "directory" ? (
                <>
                  <TextField
                    diagnostics={nodeFieldDiagnostics("operation.source.path")}
                    label="Path"
                    value={operation.source.path ?? ""}
                    onChange={(value) =>
                      onOperationChange({ source: { ...operation.source, path: value } })
                    }
                    pathPicker
                    pathBasePath={dataDir}
                  />
                  <TextField
                    label="Glob"
                    value={operation.source.glob ?? "*"}
                    onChange={(value) =>
                      onOperationChange({ source: { ...operation.source, glob: value } })
                    }
                  />
                  <ToggleField
                    checked={Boolean(operation.source.include_content)}
                    label="Include content"
                    onChange={(checked) =>
                      onOperationChange({
                        source: { ...operation.source, include_content: checked },
                      })
                    }
                  />
                </>
              ) : null}
              {operation.source?.type === "trigger_events" ? (
                <ToggleField
                  checked={Boolean(operation.source.include_content)}
                  label="Include file content"
                  onChange={(checked) =>
                    onOperationChange({
                      source: { ...operation.source, include_content: checked },
                    })
                  }
                />
              ) : null}
              {operation.source?.type === "dashboard_items" ? (
                <>
                  <SelectField
                    diagnostics={nodeFieldDiagnostics("operation.source.dashboard")}
                    label="Dashboard"
                    value={operation.source.dashboard ?? ""}
                    options={dashboardSelectOptions(dashboards)}
                    onChange={(value) => {
                      const component = firstDashboardComponent(dashboards, value);
                      onOperationChange({
                        source: {
                          ...operation.source,
                          dashboard: value,
                          component: component?.id ?? "",
                        },
                      });
                    }}
                  />
                  <SelectField
                    diagnostics={nodeFieldDiagnostics("operation.source.component")}
                    label="Component"
                    value={operation.source.component ?? ""}
                    options={dashboardComponentSelectOptions(dashboards, operation.source.dashboard)}
                    onChange={(value) =>
                      onOperationChange({ source: { ...operation.source, component: value } })
                    }
                  />
                  <TextField
                    label="Filter"
                    value={operation.source.filter ?? ""}
                    onChange={(value) =>
                      onOperationChange({ source: { ...operation.source, filter: value } })
                    }
                    placeholder="status=todo"
                  />
                  <p className="text-xs leading-5 text-muted">
                    Each matching dashboard item becomes one loop iteration. Child nodes can use
                    loop.current.item_id, loop.current.item_json, or item fields like loop.current.item.title and loop.current.item.status.
                  </p>
                </>
              ) : null}
              <NumberField
                diagnostics={nodeFieldDiagnostics("operation.source.max_concurrency")}
                label="Max concurrency"
                min="1"
                value={operation.source?.max_concurrency ?? 1}
                onChange={(value) =>
                  onOperationChange({
                    source: { ...operation.source, max_concurrency: value || 1 },
                  })
                }
              />
              <p className="text-xs leading-5 text-muted">
                Use 1 for sequential loop iterations. Increase this only when child nodes are safe to run in parallel.
              </p>
              <ToggleField
                checked={Boolean(operation.source?.fail_fast)}
                label="Fail fast"
                onChange={(checked) =>
                  onOperationChange({
                    source: { ...operation.source, fail_fast: checked },
                  })
                }
              />
              <p className="text-sm leading-6 text-muted">
                The loop runs its full child chain for one item, then starts the next item. Downstream nodes can use loop variables like loop.index, loop.file_path, loop.file_name, and loop.file_content.
              </p>
            </InspectorSection>
          ) : null}

          {operation.type === "bash_command" ? (
            <InspectorSection title={commandNodeLabel}>
              <TextareaField
                label="Command"
                rows={4}
                value={operation.command ?? ""}
                onChange={(value) => onOperationChange({ command: value })}
              />
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.working_dir")}
                label="Working directory"
                value={operation.working_dir ?? ""}
                onChange={(value) => onOperationChange({ working_dir: value })}
                pathPicker
                pathBasePath={dataDir}
                placeholder="Absolute working directory"
              />
              <KeyValueField
                label="Environment"
                value={operation.env ?? {}}
                onChange={(value) => onOperationChange({ env: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "python_script" || operation.type === "shell_script" ? (
            <InspectorSection
              title={operation.type === "python_script" ? "Python script" : "Shell script"}
            >
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.script_path")}
                label="Script path"
                value={operation.script_path ?? ""}
                onChange={(value) => onOperationChange({ script_path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <ListField
                label="Arguments"
                value={operation.args ?? []}
                onChange={(value) => onOperationChange({ args: value })}
                placeholder="--flag, value"
              />
              <KeyValueField
                label="Environment"
                value={operation.env ?? {}}
                onChange={(value) => onOperationChange({ env: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "read_file" ? (
            <InspectorSection title="Read file">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.path")}
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <TextField
                label="Encoding"
                value={operation.encoding ?? "utf-8"}
                onChange={(value) => onOperationChange({ encoding: value })}
              />
              <SelectField
                label="Decode errors"
                value={operation.errors ?? "strict"}
                options={[
                  ["strict", "Fail on invalid text"],
                  ["replace", "Replace invalid text"],
                  ["ignore", "Ignore invalid text"],
                ]}
                onChange={(value) => onOperationChange({ errors: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "write_file" ? (
            <InspectorSection title="Write file">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.path")}
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <TextareaField
                label="Content"
                rows={5}
                value={operation.content ?? ""}
                onChange={(value) => onOperationChange({ content: value })}
                placeholder="Leave empty to write piped input"
              />
              <TextField
                label="Encoding"
                value={operation.encoding ?? "utf-8"}
                onChange={(value) => onOperationChange({ encoding: value })}
              />
              <ToggleField
                checked={operation.create_dirs !== false}
                label="Create parent folders"
                onChange={(checked) => onOperationChange({ create_dirs: checked })}
              />
              <ToggleField
                checked={operation.overwrite !== false}
                label="Overwrite existing file"
                onChange={(checked) => onOperationChange({ overwrite: checked })}
              />
              <ToggleField
                checked={Boolean(operation.append)}
                label="Append instead of replace"
                onChange={(checked) => onOperationChange({ append: checked })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "copy_file" || operation.type === "move_file" ? (
            <InspectorSection title={operation.type === "copy_file" ? "Copy file" : "Move file"}>
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.source_path")}
                label="Source path"
                value={operation.source_path ?? ""}
                onChange={(value) => onOperationChange({ source_path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.destination_path")}
                label="Destination path"
                value={operation.destination_path ?? ""}
                onChange={(value) => onOperationChange({ destination_path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <ToggleField
                checked={operation.create_dirs !== false}
                label="Create parent folders"
                onChange={(checked) => onOperationChange({ create_dirs: checked })}
              />
              <ToggleField
                checked={Boolean(operation.overwrite)}
                label="Overwrite existing destination"
                onChange={(checked) => onOperationChange({ overwrite: checked })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "delete_file" ? (
            <InspectorSection title="Delete file">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.path")}
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <ToggleField
                checked={operation.use_trash !== false}
                label="Move to Gofer trash"
                onChange={(checked) => onOperationChange({ use_trash: checked })}
              />
              <ToggleField
                checked={Boolean(operation.recursive)}
                label="Allow recursive folder delete"
                onChange={(checked) => onOperationChange({ recursive: checked })}
              />
              <ToggleField
                checked={Boolean(operation.missing_ok)}
                label="Succeed if missing"
                onChange={(checked) => onOperationChange({ missing_ok: checked })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "file" ? (
            <InspectorSection title="File path">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.path")}
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                pathBasePath={dataDir}
                placeholder="/absolute/path/to/file"
              />
            </InspectorSection>
          ) : null}

          {operation.type === "folder" ? (
            <InspectorSection title="Folder path">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.path")}
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                pathBasePath={dataDir}
                placeholder="/absolute/path/to/folder"
              />
            </InspectorSection>
          ) : null}

          {operation.type === "open_resource" ? (
            <InspectorSection title="Open app / URL / file">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.target")}
                label="Target"
                value={operation.target ?? ""}
                onChange={(value) => onOperationChange({ target: value })}
                pathPicker
                pathBasePath={dataDir}
                placeholder="File, folder, URL, or app path"
              />
              <SelectField
                label="Type"
                value={operation.resource_type ?? "auto"}
                options={[
                  ["auto", "Auto"],
                  ["file", "File"],
                  ["folder", "Folder"],
                  ["url", "URL"],
                  ["app", "App"],
                ]}
                onChange={(value) => onOperationChange({ resource_type: value })}
              />
              <ListField
                label="App arguments"
                value={operation.args ?? []}
                onChange={(value) => onOperationChange({ args: value })}
                placeholder="--flag, value"
              />
            </InspectorSection>
          ) : null}

          {operation.type === "prompt_file" ? (
            <InspectorSection title="Prompt file">
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.output_path")}
                label="Output path"
                value={operation.output_path ?? ""}
                onChange={(value) => onOperationChange({ output_path: value })}
                pathPicker
                pathBasePath={dataDir}
              />
              <TextField
                diagnostics={nodeFieldDiagnostics("operation.template_path")}
                label="Template path"
                value={operation.template_path ?? ""}
                onChange={(value) => onOperationChange({ template_path: value })}
                pathPicker
                pathBasePath={dataDir}
                placeholder="Optional"
              />
              <TextareaField
                label="Inline template"
                rows={5}
                value={operation.template ?? ""}
                onChange={(value) => onOperationChange({ template: value })}
                placeholder="Use {{variables}} and {{_piped_input}}"
              />
              <KeyValueField
                label="Variables"
                value={operation.variables ?? {}}
                onChange={(value) => onOperationChange({ variables: value })}
              />
              <TextField
                label="Encoding"
                value={operation.encoding ?? "utf-8"}
                onChange={(value) => onOperationChange({ encoding: value })}
              />
              <ToggleField
                checked={operation.create_dirs !== false}
                label="Create parent folders"
                onChange={(checked) => onOperationChange({ create_dirs: checked })}
              />
              <ToggleField
                checked={operation.overwrite !== false}
                label="Overwrite existing file"
                onChange={(checked) => onOperationChange({ overwrite: checked })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "common_llm_task" ? (
            <>
              <InspectorSection title="Common LLM task">
                <TextField
                  diagnostics={nodeFieldDiagnostics("agent_id", "operation.agent_id")}
                  label="Agent ID"
                  value={operation.agent_id ?? ""}
                  onChange={(value) => onOperationChange({ agent_id: value })}
                />
                <SelectField
                  label="Task"
                  value={operation.task ?? "summarize"}
                  options={[
                    ["summarize", "Summarize"],
                    ["review", "Review"],
                    ["explain", "Explain"],
                    ["extract", "Extract"],
                    ["rewrite", "Rewrite"],
                    ["classify", "Classify"],
                  ]}
                  onChange={(value) => onOperationChange({ task: value })}
                />
                <TextareaField
                  label="Target"
                  rows={3}
                  value={operation.target ?? ""}
                  onChange={(value) => onOperationChange({ target: value })}
                  placeholder="Text, file path, URL, or leave blank for piped input"
                />
                <TextareaField
                  label="Instructions"
                  rows={4}
                  value={operation.instructions ?? ""}
                  onChange={(value) => onOperationChange({ instructions: value })}
                />
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.working_dir")}
                  label="Working directory"
                  value={operation.working_dir ?? ""}
                  onChange={(value) => onOperationChange({ working_dir: value })}
                  pathPicker
                  pathBasePath={dataDir}
                />
                <SelectField
                  label="Provider profile"
                  value={operation.profile ?? ""}
                  options={profileSelectOptions(providerProfiles, agentConfig?.subscription)}
                  onChange={(value) => onOperationChange({ profile: value })}
                />
                <TextField
                  label="Model override"
                  value={operation.model ?? ""}
                  onChange={(value) => onOperationChange({ model: value })}
                  placeholder="Optional"
                />
                <NumberField
                  label="Timeout override"
                  min="0"
                  step="1"
                  value={operation.timeout ?? ""}
                  onChange={(value) => onOperationChange({ timeout: value || "" })}
                  placeholder="Seconds"
                />
                <InputMappingField
                  label="Input mapping"
                  sourceGroups={inputSourceGroups}
                  sourceOptions={inputSourceOptions}
                  value={operation.input_mapping ?? {}}
                  onChange={(value) => onOperationChange({ input_mapping: value })}
                />
              </InspectorSection>
              <AgentConfigSection
                agentConfig={agentConfig}
                diagnostics={agentDiagnostics}
                agentId={operation.agent_id}
                pathBasePath={dataDir}
                providerProfiles={providerProfiles}
                onProviderProfilesChange={onProviderProfilesChange}
                onAgentChange={onAgentChange}
              />
            </>
          ) : null}

          {operation.type === "local_vectorize" ? (
            <>
              <InspectorSection title="Local vector index">
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.source_path")}
                  label="Source path"
                  value={operation.source_path ?? ""}
                  onChange={(value) => onOperationChange({ source_path: value })}
                  pathPicker
                  pathBasePath={dataDir}
                />
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.index_path")}
                  label="Index path"
                  value={operation.index_path ?? ""}
                  onChange={(value) => onOperationChange({ index_path: value })}
                  pathPicker
                  pathBasePath={dataDir}
                />
                <TextField
                  label="Glob"
                  value={operation.glob ?? "**/*"}
                  onChange={(value) => onOperationChange({ glob: value })}
                />
                <SelectField
                  label="Mode"
                  value={operation.mode ?? "incremental"}
                  options={[
                    ["incremental", "Incremental"],
                    ["full", "Full rebuild"],
                    ["validate", "Validate only"],
                    ["compact", "Compact deleted"],
                  ]}
                  onChange={(value) => onOperationChange({ mode: value })}
                />
                <ToggleField
                  checked={operation.recursive !== false}
                  label="Recursive"
                  onChange={(checked) => onOperationChange({ recursive: checked })}
                />
                <NumberField
                  label="Chunk size"
                  min="100"
                  value={operation.chunk_size ?? 1200}
                  onChange={(value) => onOperationChange({ chunk_size: value || 1200 })}
                />
                <NumberField
                  label="Chunk overlap"
                  min="0"
                  value={operation.chunk_overlap ?? 120}
                  onChange={(value) => onOperationChange({ chunk_overlap: value || 0 })}
                />
              </InspectorSection>
              <VectorIndexStats output={nodeOutput} />
            </>
          ) : null}

          {operation.type === "local_search" ? (
            <>
              <InspectorSection title="Local search">
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.index_path")}
                  label="Index path"
                  value={operation.index_path ?? ""}
                  onChange={(value) => onOperationChange({ index_path: value })}
                  pathPicker
                  pathBasePath={dataDir}
                />
                <TextareaField
                  label="Query"
                  rows={3}
                  value={operation.query ?? ""}
                  onChange={(value) => onOperationChange({ query: value })}
                />
                <NumberField
                  label="Top K"
                  min="1"
                  value={operation.top_k ?? 5}
                  onChange={(value) => onOperationChange({ top_k: value || 5 })}
                />
                <NumberField
                  label="Score threshold"
                  min="0"
                  step="0.01"
                  value={operation.score_threshold ?? 0}
                  onChange={(value) => onOperationChange({ score_threshold: value || 0 })}
                />
                <ToggleField
                  checked={operation.include_snippets !== false}
                  label="Include snippets"
                  onChange={(checked) => onOperationChange({ include_snippets: checked })}
                />
                <ToggleField
                  checked={operation.include_file_metadata !== false}
                  label="Include file metadata"
                  onChange={(checked) => onOperationChange({ include_file_metadata: checked })}
                />
              </InspectorSection>
              <VectorSearchStats output={nodeOutput} />
            </>
          ) : null}

          {operation.type === "http_request" ? (
            <>
              <InspectorSection title="HTTP request">
                <SelectField
                  label="Method"
                  value={operation.method ?? "GET"}
                  options={[
                    ["GET", "GET"],
                    ["POST", "POST"],
                    ["PUT", "PUT"],
                    ["PATCH", "PATCH"],
                    ["DELETE", "DELETE"],
                    ["HEAD", "HEAD"],
                  ]}
                  onChange={(value) => onOperationChange({ method: value })}
                />
                <TextField
                  label="URL"
                  value={operation.url ?? ""}
                  onChange={(value) => onOperationChange({ url: value })}
                  placeholder="https://api.example.com/resource"
                />
                <KeyValueField
                  label="Headers"
                  value={operation.headers ?? {}}
                  onChange={(value) => onOperationChange({ headers: value })}
                />
                <KeyValueField
                  label="Query params"
                  value={operation.params ?? {}}
                  onChange={(value) => onOperationChange({ params: value })}
                />
                <JsonBodyField
                  label="JSON body"
                  value={operation.json}
                  onChange={(value) => onOperationChange({ json: value })}
                />
                <TextareaField
                  label="Raw body"
                  rows={4}
                  value={operation.body ?? ""}
                  onChange={(value) => onOperationChange({ body: value })}
                />
                <ListField
                  label="Expected statuses"
                  value={(operation.expected_statuses ?? [200]).map((status) => String(status))}
                  onChange={(value) =>
                    onOperationChange({ expected_statuses: value.map((status) => Number(status)) })
                  }
                  placeholder="200, 201"
                />
                <SelectField
                  label="Response mode"
                  value={operation.response_mode ?? "auto"}
                  options={[
                    ["auto", "Auto"],
                    ["json", "JSON"],
                    ["text", "Text"],
                    ["none", "None"],
                  ]}
                  onChange={(value) => onOperationChange({ response_mode: value })}
                />
                <NumberField
                  label="Timeout seconds"
                  min="0.1"
                  step="0.1"
                  value={operation.timeout_seconds ?? 30}
                  onChange={(value) => onOperationChange({ timeout_seconds: value || 30 })}
                />
                <NumberField
                  label="Retry attempts"
                  min="1"
                  value={operation.retry?.attempts ?? 1}
                  onChange={(value) =>
                    onOperationChange({
                      retry: { ...(operation.retry ?? {}), attempts: value || 1 },
                    })
                  }
                />
                <NumberField
                  label="Retry backoff seconds"
                  min="0"
                  step="0.1"
                  value={operation.retry?.backoff_seconds ?? 0}
                  onChange={(value) =>
                    onOperationChange({
                      retry: { ...(operation.retry ?? {}), backoff_seconds: value || 0 },
                    })
                  }
                />
                <ListField
                  label="Retry statuses"
                  value={(operation.retry?.retry_on_statuses ?? []).map((status) => String(status))}
                  onChange={(value) =>
                    onOperationChange({
                      retry: {
                        ...(operation.retry ?? {}),
                        retry_on_statuses: value.map((status) => Number(status)),
                      },
                    })
                  }
                  placeholder="429, 503"
                />
                <KeyValueField
                  label="Output mapping"
                  value={operation.output_mapping ?? {}}
                  onChange={(value) => onOperationChange({ output_mapping: value })}
                />
                <ListField
                  label="Secret fields"
                  value={operation.secret_fields ?? []}
                  onChange={(value) => onOperationChange({ secret_fields: value })}
                  placeholder="Authorization, api_key"
                />
              </InspectorSection>
              <HttpResponsePreview output={nodeOutput} />
            </>
          ) : null}

          {operation.type === "approval_gate" ? (
            <>
              <InspectorSection title="Approval gate">
                <TextareaField
                  label="Message"
                  rows={4}
                  value={operation.message ?? ""}
                  onChange={(value) => onOperationChange({ message: value })}
                />
                <NumberField
                  label="Timeout seconds"
                  min="0"
                  step="1"
                  value={operation.timeout_seconds ?? ""}
                  onChange={(value) =>
                    onOperationChange({ timeout_seconds: value === "" ? null : value })
                  }
                  placeholder="None"
                />
                <SelectField
                  label="Timeout decision"
                  value={operation.timeout_decision ?? "timeout"}
                  options={[
                    ["timeout", "Timeout"],
                    ["reject", "Reject"],
                  ]}
                  onChange={(value) => onOperationChange({ timeout_decision: value })}
                />
                <ListField
                  label="Approvers"
                  value={operation.approvers ?? []}
                  onChange={(value) => onOperationChange({ approvers: value })}
                  placeholder="alice, ops-team"
                />
                <ToggleField
                  checked={Boolean(operation.notify)}
                  label="Desktop notification"
                  onChange={(checked) => onOperationChange({ notify: checked })}
                />
                <TextField
                  label="Notification title"
                  value={operation.notification_title ?? "Gofer Flow approval needed"}
                  onChange={(value) => onOperationChange({ notification_title: value })}
                />
              </InspectorSection>
              <ApprovalRuntimePanel approval={approval} onDecideApproval={onDecideApproval} />
            </>
          ) : null}

          {operation.type === "notification" ? (
            <InspectorSection title="Notification">
              <TextField
                label="Title"
                value={operation.title ?? ""}
                onChange={(value) => onOperationChange({ title: value })}
              />
              <TextareaField
                label="Body"
                rows={5}
                value={operation.body ?? ""}
                onChange={(value) => onOperationChange({ body: value })}
              />
              <SelectField
                label="Channel"
                value={operation.channel ?? "desktop"}
                options={[
                  ["desktop", "Desktop"],
                  ["slack", "Slack webhook"],
                  ["teams", "Teams webhook"],
                  ["webhook", "Webhook"],
                  ["email", "Email"],
                ]}
                onChange={(value) => onOperationChange({ channel: value })}
              />
              {["slack", "teams", "webhook"].includes(operation.channel) ? (
                <>
                  <TextField
                    diagnostics={nodeFieldDiagnostics("operation.webhook_url")}
                    label="Webhook URL"
                    value={operation.webhook_url ?? ""}
                    onChange={(value) => onOperationChange({ webhook_url: value })}
                  />
                  <JsonBodyField
                    label="Headers"
                    value={operation.headers ?? {}}
                    onChange={(value) => onOperationChange({ headers: value })}
                  />
                  <JsonBodyField
                    label="Payload"
                    value={operation.payload ?? null}
                    onChange={(value) => onOperationChange({ payload: value })}
                  />
                  <NumberField
                    label="Timeout seconds"
                    min="0"
                    step="0.5"
                    value={operation.timeout_seconds ?? 30}
                    onChange={(value) => onOperationChange({ timeout_seconds: value })}
                  />
                  <ListField
                    label="Expected statuses"
                    value={operation.expected_statuses ?? [200, 201, 202, 204]}
                    onChange={(value) =>
                      onOperationChange({ expected_statuses: value.map((item) => Number(item)) })
                    }
                    placeholder="200, 202"
                  />
                  <ListField
                    label="Network allowlist"
                    value={operation.network_allowlist ?? []}
                    onChange={(value) => onOperationChange({ network_allowlist: value })}
                    placeholder="hooks.slack.com, 203.0.113.0/24"
                  />
                </>
              ) : null}
              {operation.channel === "email" ? (
                <>
                  <TextField
                    diagnostics={nodeFieldDiagnostics("operation.email_from")}
                    label="From"
                    value={operation.email_from ?? ""}
                    onChange={(value) => onOperationChange({ email_from: value })}
                  />
                  <ListField
                    diagnostics={nodeFieldDiagnostics("operation.email_to")}
                    label="To"
                    value={operation.email_to ?? []}
                    onChange={(value) => onOperationChange({ email_to: value })}
                    placeholder="ops@example.com, oncall@example.com"
                  />
                  <TextField
                    diagnostics={nodeFieldDiagnostics("operation.smtp_host")}
                    label="SMTP host"
                    value={operation.smtp_host ?? ""}
                    onChange={(value) => onOperationChange({ smtp_host: value })}
                  />
                  <NumberField
                    label="SMTP port"
                    min="1"
                    value={operation.smtp_port ?? 587}
                    onChange={(value) => onOperationChange({ smtp_port: value })}
                  />
                  <TextField
                    label="SMTP username"
                    value={operation.smtp_username ?? ""}
                    onChange={(value) => onOperationChange({ smtp_username: value })}
                  />
                  <TextField
                    label="SMTP password"
                    value={operation.smtp_password ?? ""}
                    onChange={(value) => onOperationChange({ smtp_password: value })}
                  />
                  <ToggleField
                    checked={operation.smtp_starttls !== false}
                    label="STARTTLS"
                    onChange={(checked) => onOperationChange({ smtp_starttls: checked })}
                  />
                  <NumberField
                    label="Timeout seconds"
                    min="0"
                    step="0.5"
                    value={operation.timeout_seconds ?? 30}
                    onChange={(value) => onOperationChange({ timeout_seconds: value })}
                  />
                </>
              ) : null}
              {["slack", "teams", "webhook", "email"].includes(operation.channel) ? (
                <>
                  <NumberField
                    label="Retry attempts"
                    min="1"
                    value={operation.retry?.attempts ?? 1}
                    onChange={(value) =>
                      onOperationChange({
                        retry: { ...(operation.retry ?? {}), attempts: value || 1 },
                      })
                    }
                  />
                  <NumberField
                    label="Retry backoff seconds"
                    min="0"
                    step="0.1"
                    value={operation.retry?.backoff_seconds ?? 0}
                    onChange={(value) =>
                      onOperationChange({
                        retry: { ...(operation.retry ?? {}), backoff_seconds: value || 0 },
                      })
                    }
                  />
                  <ListField
                    label="Retry statuses"
                    value={(operation.retry?.retry_on_statuses ?? []).map((status) =>
                      String(status),
                    )}
                    onChange={(value) =>
                      onOperationChange({
                        retry: {
                          ...(operation.retry ?? {}),
                          retry_on_statuses: value.map((status) => Number(status)),
                        },
                      })
                    }
                    placeholder="429, 503"
                  />
                </>
              ) : null}
              <SelectField
                label="Urgency"
                value={operation.urgency ?? "normal"}
                options={[
                  ["low", "Low"],
                  ["normal", "Normal"],
                  ["critical", "Critical"],
                ]}
                onChange={(value) => onOperationChange({ urgency: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "dashboard_item" ? (
            <InspectorSection title="Dashboard item">
              <SelectField
                label="Action"
                value={operation.action ?? "read"}
                options={[
                  ["read", "Read matching items"],
                  ["add", "Add item"],
                  ["update", "Update item"],
                  ["move", "Move item"],
                  ["delete", "Delete item"],
                ]}
                onChange={(value) => onOperationChange({ action: value })}
              />
              <SelectField
                diagnostics={nodeFieldDiagnostics("operation.dashboard")}
                label="Dashboard"
                value={operation.dashboard ?? ""}
                options={dashboardSelectOptions(dashboards)}
                onChange={(value) => {
                  const component = firstDashboardComponent(dashboards, value);
                  onOperationChange({
                    dashboard: value,
                    component: component?.id ?? "",
                  });
                }}
              />
              <SelectField
                diagnostics={nodeFieldDiagnostics("operation.component")}
                label="Component"
                value={operation.component ?? ""}
                options={dashboardComponentSelectOptions(dashboards, operation.dashboard)}
                onChange={(value) => onOperationChange({ component: value })}
              />
              {operation.action === "read" ? (
                <TextField
                  label="Filter"
                  value={operation.filter ?? ""}
                  onChange={(value) => onOperationChange({ filter: value })}
                  placeholder="status=todo"
                />
              ) : null}
              {["update", "move", "delete"].includes(operation.action ?? "read") ? (
                <TextField
                  label="Item ID"
                  value={operation.item_id ?? ""}
                  onChange={(value) => onOperationChange({ item_id: value })}
                  placeholder="{{loop.current.item_id}}"
                />
              ) : null}
              {operation.action === "add" ? (
                <KeyValueField
                  label="Item fields"
                  value={operation.item ?? {}}
                  onChange={(value) => onOperationChange({ item: value })}
                />
              ) : null}
              {operation.action === "update" ? (
                <KeyValueField
                  label="Patch fields"
                  value={operation.patch ?? {}}
                  onChange={(value) => onOperationChange({ patch: value })}
                />
              ) : null}
              {operation.action === "move" ? (
                <>
                  <SelectField
                    label="Field"
                    value={operation.field ?? "status"}
                    options={dashboardFieldSelectOptions(
                      dashboards,
                      operation.dashboard,
                      operation.component,
                    )}
                    onChange={(value) => onOperationChange({ field: value })}
                  />
                  <DashboardValueField
                    dashboards={dashboards}
                    dashboardIdOrName={operation.dashboard}
                    componentId={operation.component}
                    field={operation.field ?? "status"}
                    value={operation.value ?? ""}
                    onChange={(value) => onOperationChange({ value })}
                  />
                </>
              ) : null}
              <p className="text-xs leading-5 text-muted">
                Use this after a dashboard item loop to deterministically update the current item.
                Item ID can use templates such as {"{{loop.current.item_id}}"}.
              </p>
            </InspectorSection>
          ) : null}

          {operation.type === "agent" ? (
            <>
              <InspectorSection title="Agent node">
                <TextField
                  diagnostics={nodeFieldDiagnostics("agent_id", "operation.agent_id")}
                  label="Agent ID"
                  value={operation.agent_id ?? ""}
                  onChange={(value) => onOperationChange({ agent_id: value })}
                />
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.prompt_path")}
                  label="Prompt path"
                  value={operation.prompt_path ?? ""}
                  onChange={(value) => onOperationChange({ prompt_path: value })}
                  pathPicker
                  pathBasePath={dataDir}
                  placeholder="Optional when using a skill"
                />
                <TextField
                  label="Skill name"
                  value={operation.skill_name ?? ""}
                  onChange={(value) => onOperationChange({ skill_name: value })}
                  placeholder="gofer-flow-workflow-builder"
                />
                <TextField
                  diagnostics={nodeFieldDiagnostics("operation.working_dir")}
                  label="Working directory"
                  value={operation.working_dir ?? ""}
                  onChange={(value) => onOperationChange({ working_dir: value })}
                  pathPicker
                  pathBasePath={dataDir}
                />
                <SelectField
                  label="Provider profile"
                  value={operation.profile ?? ""}
                  options={profileSelectOptions(providerProfiles, agentConfig?.subscription)}
                  onChange={(value) => onOperationChange({ profile: value })}
                />
                <TextField
                  label="Model override"
                  value={operation.model ?? ""}
                  onChange={(value) => onOperationChange({ model: value })}
                  placeholder="Optional"
                />
                <NumberField
                  label="Timeout override"
                  min="0"
                  step="1"
                  value={operation.timeout ?? ""}
                  onChange={(value) => onOperationChange({ timeout: value || "" })}
                  placeholder="Seconds"
                />
                <SelectField
                  label="Memory"
                  value={operation.memory ?? "none"}
                  options={[
                    ["none", "None"],
                    ["run", "This run only"],
                    ["all", "All runs"],
                  ]}
                  onChange={(value) => onOperationChange({ memory: value })}
                />
                <InputMappingField
                  label="Input mapping"
                  sourceGroups={inputSourceGroups}
                  sourceOptions={inputSourceOptions}
                  value={operation.input_mapping ?? {}}
                  onChange={(value) => onOperationChange({ input_mapping: value })}
                />
              </InspectorSection>

              <InspectorSection title="Agent config">
                <AgentConfigFields
                  agentConfig={agentConfig}
                  diagnostics={agentDiagnostics}
                  agentId={operation.agent_id}
                  pathBasePath={dataDir}
                  providerProfiles={providerProfiles}
                  onProviderProfilesChange={onProviderProfilesChange}
                  onAgentChange={onAgentChange}
                />
              </InspectorSection>
            </>
          ) : null}

          <InspectorSection title="Edges">
            <div className="space-y-3">
              <div className="grid grid-cols-[1.1fr_1fr_1fr] gap-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                <span>Type</span>
                <span>To</span>
                <span>From</span>
              </div>

              {connectedEdges.length || draftEdge ? (
                <div className="space-y-2">
                  {connectedEdges.map((edge) => (
                    <ConnectedEdgeEditor
                      key={edge.id}
                      diagnostics={diagnosticsForEdge(workflowDiagnostics, edge)}
                      edge={edge}
                      node={node}
                      nodes={nodes}
                      onDelete={() => onDeleteEdge(edge.id)}
                      onUpdate={(patch) => onEdgeChange(edge.id, patch)}
                    />
                  ))}
                  {draftEdge ? (
                    <ConnectedEdgeEditor
                      draft
                      edge={draftEdge}
                      node={node}
                      nodes={nodes}
                      onCancel={() => setDraftEdge(null)}
                      onCreate={(nextEdge) => {
                        onAddEdge(
                          nextEdge.from,
                          nextEdge.to,
                          nextEdge.condition,
                          nextEdge.outputPattern,
                        );
                        setDraftEdge(null);
                      }}
                      onUpdate={setDraftEdge}
                    />
                  ) : null}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-line bg-slate-50 px-3 py-4 text-sm text-muted">
                  This node has no connected edges.
                </p>
              )}
              {!draftEdge ? (
                <button
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line text-sm font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                  type="button"
                  onClick={() =>
                    setDraftEdge({
                      id: "draft-edge",
                      from: "",
                      to: "",
                      condition: "",
                      outputPattern: null,
                    })
                  }
                >
                  <Plus size={15} />
                  Add edge
                </button>
              ) : null}
            </div>
          </InspectorSection>

          {nodeRun ? (
            <RunNodeInspector nodeRun={nodeRun} />
          ) : null}
            </div>
          </InspectorPanel>
        ) : null}
        </PathTrustContext.Provider>
      </div>
    </aside>
  );
}

export function defaultFanSource(type) {
  switch (type) {
    case "count":
      return { type, count: 1, max_concurrency: 1, fail_fast: false };
    case "tabular":
      return { type, path: "data/input.csv", max_concurrency: 1, fail_fast: false };
    case "directory":
      return {
        type,
        path: "data",
        glob: "*",
        include_content: false,
        max_concurrency: 1,
        fail_fast: false,
      };
    case "trigger_events":
      return { type, include_content: false, max_concurrency: 1, fail_fast: false };
    case "dashboard_items":
      return {
        type,
        dashboard: "",
        component: "",
        filter: "",
        max_concurrency: 1,
        fail_fast: false,
      };
    case "infinite":
      return { type, max_concurrency: 1, fail_fast: false };
    default:
      return null;
  }
}

function dashboardSelectOptions(dashboards = []) {
  return [
    ["", "Select dashboard"],
    ...dashboards.map((dashboard) => [
      dashboard.id,
      dashboard.name ? `${dashboard.name} (${dashboard.id})` : dashboard.id,
    ]),
  ];
}

function dashboardComponentSelectOptions(dashboards = [], dashboardIdOrName = "") {
  const dashboard = dashboards.find(
    (candidate) => candidate.id === dashboardIdOrName || candidate.name === dashboardIdOrName,
  );
  const components = (dashboard?.sections ?? []).flatMap((section) =>
    (section.components ?? []).map((component) => ({
      ...component,
      sectionTitle: section.title,
    })),
  );
  return [
    ["", "Select component"],
    ...components.map((component) => [
      component.id,
      component.sectionTitle
        ? `${component.title} (${component.id}) · ${component.sectionTitle}`
        : `${component.title} (${component.id})`,
    ]),
  ];
}

function firstDashboardComponent(dashboards = [], dashboardIdOrName = "") {
  const dashboard = dashboards.find(
    (candidate) => candidate.id === dashboardIdOrName || candidate.name === dashboardIdOrName,
  );
  return (dashboard?.sections ?? []).flatMap((section) => section.components ?? [])[0] ?? null;
}

function dashboardComponentById(dashboard, componentId = "") {
  return (
    (dashboard?.sections ?? [])
      .flatMap((section) => section.components ?? [])
      .find((component) => component.id === componentId) ?? null
  );
}

function dashboardFieldSelectOptions(dashboards = [], dashboardIdOrName = "", componentId = "") {
  const dashboard = dashboards.find(
    (candidate) => candidate.id === dashboardIdOrName || candidate.name === dashboardIdOrName,
  );
  const component = dashboardComponentById(dashboard, componentId);
  const fields = new Set([
    ...Object.keys(component?.schema ?? {}),
    ...(component?.items ?? []).flatMap((item) => Object.keys(item ?? {})),
  ]);
  if (!fields.size) {
    fields.add("status");
  }
  return [...fields].sort().map((field) => [field, field]);
}

function dashboardFieldSchema(dashboards = [], dashboardIdOrName = "", componentId = "", field = "") {
  const dashboard = dashboards.find(
    (candidate) => candidate.id === dashboardIdOrName || candidate.name === dashboardIdOrName,
  );
  const component = dashboardComponentById(dashboard, componentId);
  return component?.schema?.[field] ?? null;
}

function DashboardValueField({
  dashboards,
  dashboardIdOrName,
  componentId,
  field,
  onChange,
  value,
}) {
  const schema = dashboardFieldSchema(dashboards, dashboardIdOrName, componentId, field);
  if (schema?.type === "enum" && Array.isArray(schema.values) && schema.values.length) {
    return (
      <SelectField
        label="Value"
        value={value ?? ""}
        options={[["", "Select value"], ...schema.values.map((item) => [String(item), String(item)])]}
        onChange={onChange}
      />
    );
  }
  return (
    <TextField
      label="Value"
      value={value ?? ""}
      onChange={onChange}
      placeholder="completed"
    />
  );
}

function ConnectedEdgeEditor({
  diagnostics = [],
  draft = false,
  edge,
  node,
  nodes,
  onCancel,
  onCreate,
  onDelete,
  onUpdate,
}) {
  const blankOption = [["", "Select"]];
  const typeValue = edge.condition || (draft ? "" : "always");
  const edgeFieldDiagnostics = (...fields) => diagnosticsForField(diagnostics, ...fields);

  function updateDraft(patch) {
    onUpdate({ ...edge, ...patch });
  }

  function handleTypeChange(value) {
    const patch = {
      condition: value,
      outputPattern: value === "output_matches" ? edge.outputPattern || "" : null,
    };
    if (draft) {
      updateDraft(patch);
      return;
    }
    onUpdate(patch);
  }

  function handleToChange(value) {
    if (!value) {
      if (draft) updateDraft({ to: "", from: "" });
      return;
    }

    if (draft) {
      onCreate({
        ...edge,
        from: node.id,
        to: value,
        condition: edge.condition || "always",
      });
      return;
    }

    onUpdate({ from: node.id, to: value });
  }

  function handleFromChange(value) {
    if (!value) {
      if (draft) updateDraft({ from: "", to: "" });
      return;
    }

    if (draft) {
      onCreate({
        ...edge,
        from: value,
        to: node.id,
        condition: edge.condition || "always",
      });
      return;
    }

    onUpdate({ from: value, to: node.id });
  }

  function handleBlur(event) {
    if (!draft || edge.from || edge.to) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    onCancel?.();
  }

  return (
    <div
      className="space-y-2"
      onBlur={handleBlur}
    >
      <div className="grid grid-cols-[1.1fr_1fr_1fr_auto] gap-2">
        <EdgeSelect
          diagnostics={edgeFieldDiagnostics("condition")}
          value={typeValue}
          options={draft ? [["", "Select"], ...compactEdgeConditionOptions] : compactEdgeConditionOptions}
          onChange={handleTypeChange}
        />
        <EdgeSelect
          diagnostics={edgeFieldDiagnostics("to")}
          value={edge.to}
          options={
            draft ? [...blankOption, ...nodesForTo(nodes)] : endpointOptions(nodes)
          }
          onChange={handleToChange}
        />
        <EdgeSelect
          diagnostics={edgeFieldDiagnostics("from")}
          value={edge.from}
          options={
            draft
              ? [...blankOption, ...nodesForFrom(nodes)]
              : endpointOptions(nodes)
          }
          onChange={handleFromChange}
        />
        {!draft ? (
          <button
            className="grid h-9 w-8 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
            title="Delete edge"
            type="button"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        ) : (
          <span aria-hidden="true" className="h-9 w-8" />
        )}
      </div>
      {typeValue === "output_matches" ? (
        <InlineTextField
          diagnostics={edgeFieldDiagnostics("outputPattern")}
          value={edge.outputPattern ?? ""}
          onChange={(value) =>
            draft ? updateDraft({ outputPattern: value }) : onUpdate({ outputPattern: value })
          }
          placeholder="regex pattern"
        />
      ) : null}
    </div>
  );
}

function endpointOptions(nodes) {
  return nodes.map((candidate) => [candidate.id, candidate.label || candidate.id]);
}

function nodesForTo(nodes) {
  return nodes.map((candidate) => [candidate.id, candidate.label || candidate.id]);
}

function nodesForFrom(nodes) {
  return nodes.map((candidate) => [candidate.id, candidate.label || candidate.id]);
}

function AgentConfigSection({
  agentConfig,
  diagnostics = [],
  agentId,
  onAgentChange,
  onProviderProfilesChange,
  pathBasePath,
  providerProfiles = [],
}) {
  if (!agentConfig) return null;
  return (
    <InspectorSection title="Agent config">
      <AgentConfigFields
        agentConfig={agentConfig}
        diagnostics={diagnostics}
        agentId={agentId}
        onAgentChange={onAgentChange}
        onProviderProfilesChange={onProviderProfilesChange}
        pathBasePath={pathBasePath}
        providerProfiles={providerProfiles}
      />
    </InspectorSection>
  );
}

function AgentConfigFields({
  agentConfig,
  diagnostics = [],
  agentId,
  onAgentChange,
  onProviderProfilesChange,
  pathBasePath,
  providerProfiles = [],
}) {
  const agentFieldDiagnostics = (...fields) => diagnosticsForField(diagnostics, ...fields);
  return (
    <>
      <SelectField
        label="Subscription"
        value={agentConfig.subscription}
        options={[
          ["codex", "Codex"],
          ["claude_code", "Claude Code"],
          ["openai_api", "OpenAI API"],
          ["anthropic_api", "Anthropic API"],
        ]}
        onChange={(value) => onAgentChange(agentId, { subscription: value })}
      />
      <SelectField
        label="Provider profile"
        value={agentConfig.profile ?? ""}
        options={profileSelectOptions(providerProfiles, agentConfig.subscription)}
        onChange={(value) => onAgentChange(agentId, { profile: value })}
      />
      <ProviderProfileEditor
        agentSubscription={agentConfig.subscription}
        providerProfiles={providerProfiles}
        selectedProfileName={agentConfig.profile ?? ""}
        onAgentChange={(patch) => onAgentChange(agentId, patch)}
        onProviderProfilesChange={onProviderProfilesChange}
      />
      <TextField
        label="Model override"
        value={agentConfig.model ?? ""}
        onChange={(value) => onAgentChange(agentId, { model: value })}
        placeholder="Optional"
      />
      <HealthDiagnosticList diagnostics={diagnostics} />
      <TextField
        diagnostics={agentFieldDiagnostics("prompt_path")}
        label="Prompt path"
        value={agentConfig.prompt_path ?? ""}
        onChange={(value) => onAgentChange(agentId, { prompt_path: value })}
        pathPicker
        pathBasePath={pathBasePath}
      />
      <TextField
        diagnostics={agentFieldDiagnostics("working_dir")}
        label="Working directory"
        value={agentConfig.working_dir ?? ""}
        onChange={(value) => onAgentChange(agentId, { working_dir: value })}
        pathPicker
        pathBasePath={pathBasePath}
      />
      <ListField
        label="Tools"
        value={agentConfig.tools ?? []}
        onChange={(value) => onAgentChange(agentId, { tools: value })}
        placeholder="Read, Write, Bash"
      />
      <ListField
        label="MCP servers"
        value={agentConfig.mcp_servers ?? []}
        onChange={(value) => onAgentChange(agentId, { mcp_servers: value })}
        placeholder="server-a, server-b"
      />
      <KeyValueField
        label="Environment"
        value={agentConfig.env ?? {}}
        onChange={(value) => onAgentChange(agentId, { env: value })}
      />
    </>
  );
}

function ProviderProfileEditor({
  agentSubscription,
  providerProfiles = [],
  selectedProfileName = "",
  onAgentChange,
  onProviderProfilesChange,
}) {
  const selectedProfile =
    providerProfiles.find((profile) => profile.name === selectedProfileName) ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() =>
    profileEditorDraft(selectedProfile, agentSubscription),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setDraft(profileEditorDraft(selectedProfile, agentSubscription));
      setError("");
    }
  }, [agentSubscription, open, selectedProfile]);

  async function saveProfile() {
    setSaving(true);
    setError("");
    try {
      const payload = profilePayloadFromDraft(draft);
      const response = await fetch(apiUrl("/provider/profiles"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Could not save provider profile");
      }
      const profile = body.profile ?? payload;
      onProviderProfilesChange?.([
        ...providerProfiles.filter((candidate) => candidate.name !== profile.name),
        profile,
      ].sort((left, right) => left.name.localeCompare(right.name)));
      onAgentChange({ profile: profile.name });
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save provider profile");
    } finally {
      setSaving(false);
    }
  }

  async function removeProfile() {
    if (!selectedProfile) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        apiUrl(`/provider/profiles/${encodeURIComponent(selectedProfile.name)}`),
        { method: "DELETE" },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Could not remove provider profile");
      }
      onProviderProfilesChange?.(
        providerProfiles.filter((candidate) => candidate.name !== selectedProfile.name),
      );
      onAgentChange({ profile: "" });
      setOpen(false);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove provider profile");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">
          {selectedProfile ? `Editing ${selectedProfile.name}` : "Provider profile editor"}
        </span>
        <button
          className="btn-ghost h-8 px-2 text-xs"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close" : selectedProfile ? "Edit" : "Create"}
        </button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          <TextField
            label="Profile name"
            value={draft.name}
            onChange={(value) => setDraft({ ...draft, name: value })}
            placeholder="fast-review"
          />
          <SelectField
            label="Subscription"
            value={draft.subscription}
            options={[
              ["codex", "Codex"],
              ["claude_code", "Claude Code"],
              ["openai_api", "OpenAI API"],
              ["anthropic_api", "Anthropic API"],
            ]}
            onChange={(value) => setDraft({ ...draft, subscription: value })}
          />
          <TextField
            label="Model"
            value={draft.model}
            onChange={(value) => setDraft({ ...draft, model: value })}
            placeholder="Optional"
          />
          <NumberField
            label="Timeout"
            min="0"
            step="1"
            value={draft.timeout}
            onChange={(value) => setDraft({ ...draft, timeout: value })}
            placeholder="Seconds"
          />
          <TextField
            label="Reasoning"
            value={draft.reasoning}
            onChange={(value) => setDraft({ ...draft, reasoning: value })}
            placeholder="Codex only"
          />
          <SelectField
            label="Approval mode"
            value={draft.approval_mode}
            options={[
              ["", "Default"],
              ["auto", "Auto"],
              ["manual", "Manual"],
              ["never", "Never"],
              ["on-request", "On request"],
              ["on-failure", "On failure"],
            ]}
            onChange={(value) => setDraft({ ...draft, approval_mode: value })}
          />
          <SelectField
            label="Sandbox mode"
            value={draft.sandbox_mode}
            options={[
              ["", "Default"],
              ["read-only", "Read only"],
              ["workspace-write", "Workspace write"],
              ["danger-full-access", "Danger full access"],
            ]}
            onChange={(value) => setDraft({ ...draft, sandbox_mode: value })}
          />
          <ListField
            label="Extra args"
            value={draft.extra_args}
            onChange={(value) => setDraft({ ...draft, extra_args: value })}
            placeholder="--flag, value"
          />
          <ListField
            label="Default tools"
            value={draft.tools}
            onChange={(value) => setDraft({ ...draft, tools: value })}
            placeholder="Read, Write"
          />
          <ListField
            label="MCP servers"
            value={draft.mcp_servers}
            onChange={(value) => setDraft({ ...draft, mcp_servers: value })}
            placeholder="docs, repo"
          />
          <KeyValueField
            label="Environment"
            value={draft.env}
            onChange={(value) => {
              const split = splitProviderProfileEnv(value, draft.secret_refs);
              setDraft({ ...draft, env: split.env, secret_refs: split.secret_refs });
            }}
          />
          <KeyValueField
            label="Secret refs"
            value={draft.secret_refs}
            onChange={(value) => setDraft({ ...draft, secret_refs: value })}
          />
          {["openai_api", "anthropic_api"].includes(draft.subscription) ? (
            <>
              <TextField
                label="API base URL"
                value={draft.api_base_url}
                onChange={(value) => setDraft({ ...draft, api_base_url: value })}
                placeholder="Provider default"
              />
              <TextField
                label="API key env"
                value={draft.api_key_env}
                onChange={(value) => setDraft({ ...draft, api_key_env: value })}
                placeholder={
                  draft.subscription === "anthropic_api"
                    ? "ANTHROPIC_API_KEY"
                    : "OPENAI_API_KEY"
                }
              />
              <TextField
                label="API key secret"
                value={draft.api_key_secret}
                onChange={(value) => setDraft({ ...draft, api_key_secret: value })}
                placeholder="GOFER secret name"
              />
              <TextField
                label="Organization"
                value={draft.organization}
                onChange={(value) => setDraft({ ...draft, organization: value })}
                placeholder="Optional"
              />
              <KeyValueField
                label="Provider options"
                value={draft.provider_options}
                onChange={(value) => setDraft({ ...draft, provider_options: value })}
              />
            </>
          ) : null}
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
          <div className="flex gap-2">
            <button
              className="btn-primary h-9 flex-1 justify-center text-xs"
              disabled={saving}
              type="button"
              onClick={saveProfile}
            >
              {saving ? "Saving" : "Save"}
            </button>
            {selectedProfile ? (
              <button
                className="btn-ghost h-9 px-3 text-xs text-red-700"
                disabled={saving}
                type="button"
                onClick={removeProfile}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function profileEditorDraft(profile, subscription) {
  return {
    name: profile?.name ?? "",
    subscription: profile?.subscription ?? subscription ?? "codex",
    model: profile?.model ?? "",
    timeout: profile?.timeout ?? "",
    reasoning: profile?.reasoning ?? "",
    approval_mode: profile?.approval_mode ?? "",
    sandbox_mode: profile?.sandbox_mode ?? "",
    extra_args: profile?.extra_args ?? [],
    tools: profile?.tools ?? [],
    mcp_servers: profile?.mcp_servers ?? [],
    env: profile?.env ?? {},
    secret_refs: profile?.secret_refs ?? {},
    api_base_url: profile?.api_base_url ?? "",
    api_key_env: profile?.api_key_env ?? "",
    api_key_secret: profile?.api_key_secret ?? "",
    organization: profile?.organization ?? "",
    provider_options: profile?.provider_options ?? {},
  };
}

function profilePayloadFromDraft(draft) {
  const payload = {
    name: draft.name.trim(),
    subscription: draft.subscription,
  };
  for (const key of [
    "model",
    "reasoning",
    "approval_mode",
    "sandbox_mode",
    "api_base_url",
    "api_key_env",
    "api_key_secret",
    "organization",
  ]) {
    if (draft[key]) payload[key] = draft[key];
  }
  if (draft.timeout) payload.timeout = Number(draft.timeout);
  for (const key of ["extra_args", "tools", "mcp_servers"]) {
    if (draft[key]?.length) payload[key] = draft[key];
  }
  for (const key of ["env", "secret_refs", "provider_options"]) {
    if (Object.keys(draft[key] ?? {}).length) payload[key] = draft[key];
  }
  return payload;
}

const MASKED_PROVIDER_SECRET_VALUE = "********";
const SENSITIVE_PROVIDER_ENV_NAME_PATTERN =
  /(^|_)(API_?KEY|AUTHORIZATION|AUTH|BEARER|CREDENTIALS?|KEY|PASSWORD|PASS|SECRET|TOKEN)(_|$)/i;

function isSensitiveProviderEnvName(name) {
  return SENSITIVE_PROVIDER_ENV_NAME_PATTERN.test(String(name ?? "").trim().replaceAll("-", "_"));
}

function splitProviderProfileEnv(env, existingSecretRefs = {}) {
  const nextEnv = {};
  const nextSecretRefs = { ...(existingSecretRefs ?? {}) };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isSensitiveProviderEnvName(key) || value === MASKED_PROVIDER_SECRET_VALUE) {
      nextEnv[key] = value;
      continue;
    }
    nextSecretRefs[key] = nextSecretRefs[key] || key;
  }
  return { env: nextEnv, secret_refs: nextSecretRefs };
}

function profileSelectOptions(providerProfiles = [], subscription) {
  const options = [["", "None"]];
  providerProfiles
    .filter((profile) => !subscription || profile.subscription === subscription)
    .forEach((profile) => {
      const suffix = profile.model ? ` (${profile.model})` : "";
      options.push([profile.name, `${profile.name}${suffix}`]);
    });
  return options;
}

function workflowDiagnosticsForDisplay(workflow) {
  return [
    ...(workflow?.validationDiagnostics ?? []),
    ...(workflow?.validationErrors ?? []),
    ...(workflow?.validationWarnings ?? []),
    ...(workflow?.healthErrors ?? []),
    ...(workflow?.healthWarnings ?? []),
  ].filter(
    (diagnostic, index, all) =>
      index ===
      all.findIndex(
        (candidate) =>
          candidate.id === diagnostic.id &&
          candidate.subject === diagnostic.subject &&
          candidate.field === diagnostic.field &&
          candidate.message === diagnostic.message,
      ),
  );
}

function workflowValidationDiagnostics(workflow) {
  return [
    ...(workflow?.validationDiagnostics ?? []),
    ...(workflow?.validationErrors ?? []),
    ...(workflow?.validationWarnings ?? []),
  ].filter(
    (diagnostic, index, all) =>
      index ===
      all.findIndex(
        (candidate) =>
          candidate.id === diagnostic.id &&
          candidate.subject === diagnostic.subject &&
          candidate.field === diagnostic.field &&
          candidate.message === diagnostic.message,
      ),
  );
}

function diagnosticsByTarget(diagnostics, targetType) {
  return diagnostics.reduce((grouped, diagnostic) => {
    if (diagnostic.targetType !== targetType || !diagnostic.targetId) return grouped;
    return {
      ...grouped,
      [diagnostic.targetId]: [...(grouped[diagnostic.targetId] ?? []), diagnostic],
    };
  }, {});
}

function diagnosticsForNode(diagnostics, node, agentConfig) {
  if (!node) return [];
  const subjects = new Set([`node:${node.id}`]);
  const agentId = node.operation?.agent_id;
  if (agentId) {
    subjects.add(`agent:${agentId}`);
  }
  return diagnostics.filter((diagnostic) => {
    if (subjects.has(diagnostic.subject)) return true;
    return isProviderDiagnosticForAgent(diagnostic, agentConfig);
  });
}

function diagnosticsForAgent(diagnostics, agentId, agentConfig) {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.subject === `agent:${agentId}`) return true;
    return isProviderDiagnosticForAgent(diagnostic, agentConfig);
  });
}

function diagnosticsForEdge(diagnostics, edge) {
  if (!edge) return [];
  const subjects = new Set([`edge:${edge.id}`]);
  return diagnostics.filter((diagnostic) => {
    if (subjects.has(diagnostic.subject)) return true;
    if (diagnostic.targetType !== "edge") return false;
    const detail = diagnostic.detail ?? {};
    return (
      diagnostic.targetId === edge.id ||
      (detail.from === edge.from && detail.to === edge.to)
    );
  });
}

function diagnosticsForField(diagnostics, ...fields) {
  const fieldSet = new Set(fields.filter(Boolean));
  return diagnostics.filter((diagnostic) => fieldSet.has(diagnostic.field));
}

function fieldDiagnosticState(diagnostics = []) {
  const visibleDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic?.severity === "error" || diagnostic?.severity === "warning",
  );
  if (!visibleDiagnostics.length) {
    return { diagnostics: [], severity: null };
  }
  return {
    diagnostics: visibleDiagnostics,
    severity: visibleDiagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "error"
      : "warning",
  };
}

function fieldBorderClass(diagnostics = [], base = "border-line focus:border-teal-500") {
  const { severity } = fieldDiagnosticState(diagnostics);
  if (severity === "error") return "border-red-300 focus:border-red-500 focus:ring-red-100";
  if (severity === "warning") return "border-amber-300 focus:border-amber-500 focus:ring-amber-100";
  return base;
}

function FieldDiagnosticMessage({ diagnostics = [], id }) {
  const { diagnostics: visibleDiagnostics, severity } = fieldDiagnosticState(diagnostics);
  if (!visibleDiagnostics.length) return null;
  return (
    <p
      id={id}
      className={`mt-1 text-xs leading-5 ${
        severity === "error" ? "text-red-700" : "text-amber-800"
      }`}
    >
      {visibleDiagnostics[0].message}
    </p>
  );
}

function isProviderDiagnosticForAgent(diagnostic, agentConfig) {
  if (!agentConfig?.subscription) return false;
  return (
    (diagnostic.id === "workflow.provider_cli" || diagnostic.id === "provider.cli") &&
    diagnostic.subject === agentConfig.subscription
  );
}

function HealthDiagnosticList({ diagnostics = [], onApplyFix }) {
  const visibleDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic?.severity === "error" || diagnostic?.severity === "warning",
  );
  if (!visibleDiagnostics.length) return null;
  return (
    <div className="space-y-2">
      {visibleDiagnostics.map((diagnostic, index) => {
        const error = diagnostic.severity === "error";
        return (
          <div
            key={`${diagnostic.id}-${diagnostic.subject ?? "workflow"}-${index}`}
            className={`rounded-md border px-3 py-2 text-xs leading-5 ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 shrink-0" size={14} />
              <span>{diagnostic.message}</span>
            </div>
            {diagnostic.fixes?.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {diagnostic.fixes.map((fix) => (
                  <button
                    key={`${fix.action}-${fix.label}`}
                    className="rounded border border-current/20 bg-white/70 px-2 py-1 text-[11px] font-semibold transition hover:bg-white"
                    type="button"
                    onClick={() => onApplyFix?.(fix)}
                  >
                    {fix.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function createDefaultWorkflowNode(
  workflow,
  { type = "agent", usedAgentIds = [], x = 214, y = 204 } = {},
) {
  const workflowNodes = workflow.nodes ?? [];
  const nextNumber = nextAvailableNodeNumber(workflowNodes);
  const nextAgentNumber = nextAvailableAgentNumber(
    workflowNodes,
    workflow.agents,
    usedAgentIds,
  );
  const operation = defaultOperation(
    type,
    type === "agent" || type === "common_llm_task" ? nextAgentNumber : nextNumber,
  );
  return {
    id: `node-${nextNumber}`,
    label: specialNodeLabel(type) ?? `New Step ${nextNumber}`,
    type,
    operation,
    settings: defaultSettings,
    meta: nodeMetaFromOperation(operation),
    x,
    y,
  };
}

export function addDefaultNodeToWorkflow(workflow, options = {}) {
  const node = createDefaultWorkflowNode(workflow, options);
  const agents =
    node.operation?.agent_id && !workflow.agents?.[node.operation.agent_id]
      ? {
          ...(workflow.agents ?? {}),
          [node.operation.agent_id]: defaultAgentConfig(node.operation.agent_id, {
            prompt_path: node.operation.prompt_path,
            working_dir: node.operation.working_dir,
          }),
        }
      : workflow.agents ?? {};

  return {
    ...workflow,
    agents,
    nodes: [...(workflow.nodes ?? []), node],
  };
}

export function duplicateWorkflowNode(workflow, nodeId, { usedAgentIds = [], offset = 28 } = {}) {
  const nodes = workflow.nodes ?? [];
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return workflow;

  const nextNumber = nextAvailableNodeNumber(nodes);
  let operation = structuredCloneCompatible(node.operation ?? defaultOperation(node.type));
  let agents = workflow.agents ?? {};

  if (operation.agent_id) {
    const nextAgentNumber = nextAvailableAgentNumber(nodes, agents, usedAgentIds);
    const nextAgentId = `agent-${nextAgentNumber}`;
    agents = {
      ...agents,
      [nextAgentId]: {
        ...defaultAgentConfig(nextAgentId),
        ...(agents[operation.agent_id] ?? {}),
      },
    };
    operation = {
      ...operation,
      agent_id: nextAgentId,
    };
  }

  const duplicatedNode = {
    ...structuredCloneCompatible(node),
    id: `node-${nextNumber}`,
    label: `${specialNodeLabel(node.type) ?? node.label ?? "Node"} copy`,
    operation,
    meta: nodeMetaFromOperation(operation),
    x: (node.x ?? 0) + offset,
    y: (node.y ?? 0) + offset,
  };

  return {
    ...workflow,
    agents,
    nodes: [...nodes, duplicatedNode],
  };
}

export function updateWorkflowNodeOperation(workflow, nodeId, patch) {
  return {
    ...workflow,
    nodes: (workflow.nodes ?? []).map((node) => {
      if (node.id !== nodeId) return node;
      const operation = {
        ...defaultOperation(node.type),
        ...(node.operation ?? {}),
        ...patch,
      };
      return {
        ...node,
        operation,
        meta: nodeMetaFromOperation(operation),
      };
    }),
  };
}

export function moveWorkflowNode(workflow, nodeId, delta) {
  return {
    ...workflow,
    nodes: (workflow.nodes ?? []).map((node) =>
      node.id === nodeId
        ? {
            ...node,
            x: (node.x ?? 0) + (delta.x ?? 0),
            y: (node.y ?? 0) + (delta.y ?? 0),
          }
        : node,
    ),
  };
}

export function normalizeCanvasGroups(workflow) {
  const nodeIds = new Set((workflow.nodes ?? []).map((node) => node.id));
  const groups = workflow.metadata?.canvas?.groups;
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((group) => group && typeof group === "object")
    .map((group, index) => {
      const color = /^#[0-9A-Fa-f]{6}$/.test(String(group.color ?? ""))
        ? group.color
        : canvasGroupColors[index % canvasGroupColors.length];
      return {
        id: String(group.id || `group-${index + 1}`),
        label: group.label == null ? `Group ${index + 1}` : String(group.label),
        color,
        nodeIds: [...new Set(group.nodeIds ?? group.node_ids ?? [])]
          .map(String)
          .filter((nodeId) => nodeIds.has(nodeId)),
        x: finiteNumber(group.x, 80),
        y: finiteNumber(group.y, 80),
        width: Math.max(groupMinWidth, finiteNumber(group.width, 360)),
        height: Math.max(groupMinHeight, finiteNumber(group.height, 240)),
        opacity: clamp(finiteNumber(group.opacity, defaultCanvasGroupOpacity), 0, 1),
        collapsed: Boolean(group.collapsed),
      };
    });
}

function setWorkflowGroups(workflow, groups) {
  return {
    ...workflow,
    metadata: {
      ...(workflow.metadata ?? {}),
      canvas: {
        ...(workflow.metadata?.canvas ?? {}),
        groups: groups.map((group) => ({
          id: group.id,
          label: group.label,
          color: group.color,
          nodeIds: group.nodeIds,
          x: Math.round(group.x),
          y: Math.round(group.y),
          width: Math.round(group.width),
          height: Math.round(group.height),
          opacity: clamp(finiteNumber(group.opacity, defaultCanvasGroupOpacity), 0, 1),
          collapsed: Boolean(group.collapsed),
        })),
      },
    },
  };
}

export function createCanvasGroup(workflow, nodeIds = []) {
  const nodes = workflow.nodes ?? [];
  const selected = nodes.filter((node) => nodeIds.includes(node.id));
  const members = selected;
  if (!members.length) return workflow;
  const existing = normalizeCanvasGroups(workflow);
  const nextNumber = nextAvailableGroupNumber(existing);
  const bounds = graphBounds(members, 48);
  const fallbackX = 120 + nextNumber * 28;
  const fallbackY = 120 + nextNumber * 24;
  const group = {
    id: `group-${nextNumber}`,
    label: `Group ${nextNumber}`,
    color: canvasGroupColors[(nextNumber - 1) % canvasGroupColors.length],
    nodeIds: members.map((node) => node.id),
    x: members.length ? bounds.left : fallbackX,
    y: members.length ? bounds.top : fallbackY,
    width: Math.max(groupMinWidth, members.length ? bounds.width : 360),
    height: Math.max(groupMinHeight, members.length ? bounds.height : 240),
    opacity: defaultCanvasGroupOpacity,
    collapsed: false,
  };
  return setWorkflowGroups(workflow, [...existing, group]);
}

export function updateCanvasGroup(workflow, groupId, patch) {
  return setWorkflowGroups(
    workflow,
    normalizeCanvasGroups(workflow).map((group) =>
      group.id === groupId
        ? {
            ...group,
            ...patch,
            width: Math.max(groupMinWidth, finiteNumber(patch.width, group.width)),
            height: Math.max(groupMinHeight, finiteNumber(patch.height, group.height)),
          }
        : group,
    ),
  );
}

export function moveCanvasGroup(workflow, groupId, delta) {
  const dx = delta.x ?? 0;
  const dy = delta.y ?? 0;
  const group = normalizeCanvasGroups(workflow).find((candidate) => candidate.id === groupId);
  if (!group) return workflow;
  const memberIds = new Set(group.nodeIds);
  return updateCanvasGroup(
    {
      ...workflow,
      nodes: (workflow.nodes ?? []).map((node) =>
        memberIds.has(node.id)
          ? { ...node, x: (node.x ?? 0) + dx, y: (node.y ?? 0) + dy }
          : node,
      ),
    },
    groupId,
    { x: group.x + dx, y: group.y + dy },
  );
}

export function duplicateCanvasGroup(workflow, groupId) {
  const groups = normalizeCanvasGroups(workflow);
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return workflow;
  const nextNumber = nextAvailableGroupNumber(groups);
  return setWorkflowGroups(workflow, [
    ...groups,
    {
      ...group,
      id: `group-${nextNumber}`,
      label: `${group.label} copy`,
      x: group.x + 32,
      y: group.y + 32,
    },
  ]);
}

export function deleteCanvasGroup(workflow, groupId) {
  return setWorkflowGroups(
    workflow,
    normalizeCanvasGroups(workflow).filter((group) => group.id !== groupId),
  );
}

export function collapsedGroupNodeIds(groups) {
  const nodeIds = new Set();
  for (const group of groups) {
    if (!group.collapsed) continue;
    for (const nodeId of group.nodeIds) nodeIds.add(nodeId);
  }
  return nodeIds;
}

export function visibleNodesForGroups(nodes, groups) {
  const hidden = collapsedGroupNodeIds(groups);
  return nodes.filter((node) => !hidden.has(node.id));
}

export function visibleEdgesForGroups(edges, visibleNodes) {
  const visible = new Set(visibleNodes.map((node) => node.id));
  return edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
}

export function canvasGroupStatus(group, nodeStatuses = {}, pendingApprovals = []) {
  const statuses = group.nodeIds.map((nodeId) => nodeStatuses[nodeId]).filter(Boolean);
  const approvalIds = new Set(
    pendingApprovals
      .filter((approval) => approval.status === "pending")
      .map((approval) => approval.nodeId),
  );
  if (group.nodeIds.some((nodeId) => approvalIds.has(nodeId))) return "approval";
  if (statuses.some((status) => status === "running" || status === "started")) return "running";
  if (statuses.some((status) => status === "error" || status === "failed")) return "error";
  if (statuses.length && statuses.every((status) => status === "success" || status === "reused")) {
    return "success";
  }
  return statuses.some((status) => status === "queued") ? "queued" : "idle";
}

export function autoLayoutWorkflow(workflow, options = {}) {
  const nodes = [...(workflow.nodes ?? [])];
  const edges = workflow.edges ?? [];
  if (!nodes.length) return { ...workflow, nodes };

  const columnGap = options.columnGap ?? layoutColumnGap;
  const rowGap = options.rowGap ?? layoutRowGap;
  const startX = options.startX ?? 80;
  const startY = options.startY ?? 80;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const layers = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .sort(compareNodesForLayout);
  const visited = new Set();

  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    const targets = [...outgoing.get(node.id)].sort((left, right) =>
      compareNodesForLayout(nodesById.get(left), nodesById.get(right)),
    );
    for (const targetId of targets) {
      layers.set(targetId, Math.max(layers.get(targetId), layers.get(node.id) + 1));
      indegree.set(targetId, indegree.get(targetId) - 1);
      if (indegree.get(targetId) === 0) {
        queue.push(nodesById.get(targetId));
        queue.sort(compareNodesForLayout);
      }
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const connectedLayer = edges
        .filter((edge) => edge.to === node.id && layers.has(edge.from))
        .map((edge) => layers.get(edge.from) + 1);
      layers.set(node.id, connectedLayer.length ? Math.max(...connectedLayer) : 0);
    }
  }

  const grouped = new Map();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    if (!grouped.has(layer)) grouped.set(layer, []);
    grouped.get(layer).push(node);
  }

  const groupByNodeId = new Map();
  const canvasGroups = normalizeCanvasGroups(workflow);
  canvasGroups.forEach((group) => {
    group.nodeIds.forEach((nodeId) => groupByNodeId.set(nodeId, group.id));
  });
  const groupLayerSlots = new Map();
  const positioned = new Map();
  for (const layer of [...grouped.keys()].sort((left, right) => left - right)) {
    const layerNodes = grouped.get(layer).sort(compareNodesForLayout);
    const rowSlots = new Map();
    let rowCursor = 0;
    layerNodes.forEach((node, row) => {
      const groupId = groupByNodeId.get(node.id);
      const slotKey = groupId || node.id;
      if (!rowSlots.has(slotKey)) {
        rowSlots.set(slotKey, rowCursor);
        rowCursor += groupId ? Math.max(1, canvasGroups.find((group) => group.id === groupId)?.nodeIds.length ?? 1) : 1;
      }
      const groupOffset = groupId
        ? (groupLayerSlots.get(`${layer}:${groupId}`) ?? 0)
        : 0;
      groupLayerSlots.set(`${layer}:${groupId}`, groupOffset + 1);
      positioned.set(node.id, {
        ...node,
        x: startX + layer * columnGap,
        y: startY + rowSlots.get(slotKey) * rowGap + groupOffset * rowGap,
      });
    });
  }

  const positionedNodes = nodes.map((node) => positioned.get(node.id) ?? node);
  const positionedById = Object.fromEntries(positionedNodes.map((node) => [node.id, node]));
  const nextGroups = canvasGroups.map((group) => {
    const members = group.nodeIds.map((nodeId) => positionedById[nodeId]).filter(Boolean);
    if (!members.length) return group;
    const bounds = graphBounds(members, 48);
    return {
      ...group,
      x: bounds.left,
      y: bounds.top,
      width: Math.max(groupMinWidth, bounds.width),
      height: Math.max(groupMinHeight, bounds.height),
    };
  });

  return {
    ...workflow,
    nodes: positionedNodes,
    metadata: setWorkflowGroups(workflow, nextGroups).metadata,
  };
}

function compareNodesForLayout(left, right) {
  const leftY = Number.isFinite(left?.y) ? left.y : 0;
  const rightY = Number.isFinite(right?.y) ? right.y : 0;
  if (leftY !== rightY) return leftY - rightY;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

export function graphBounds(nodes, padding = 0) {
  if (!nodes.length) {
    return { left: -padding, top: -padding, right: padding, bottom: padding, width: padding * 2, height: padding * 2 };
  }
  const left = Math.min(...nodes.map((node) => node.x ?? 0)) - padding;
  const top = Math.min(...nodes.map((node) => node.y ?? 0)) - padding;
  const right = Math.max(...nodes.map((node) => (node.x ?? 0) + (node.width ?? nodeWidth))) + padding;
  const bottom = Math.max(...nodes.map((node) => (node.y ?? 0) + (node.height ?? nodeHeight))) + padding;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function fitViewportToNodes(nodes, viewportSize, options = {}) {
  const bounds = graphBounds(nodes, options.padding ?? 80);
  const width = Math.max(1, viewportSize.width ?? 1);
  const height = Math.max(1, viewportSize.height ?? 1);
  const scale = clamp(
    Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height)),
    options.minZoom ?? minZoom,
    options.maxZoom ?? maxZoom,
  );
  return {
    scale,
    x: (width - bounds.width * scale) / 2 - bounds.left * scale,
    y: (height - bounds.height * scale) / 2 - bounds.top * scale,
  };
}

export function matchingNodeIds(nodes, query) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (!normalizedQuery) return [];
  return nodes
    .filter((node) => nodeSearchText(node).includes(normalizedQuery))
    .map((node) => node.id);
}

function nodeSearchText(node) {
  const operation = node.operation ?? {};
  return [
    node.id,
    node.label,
    node.type,
    operation.type,
    operation.agent_id,
    operation.path,
    operation.source_path,
    operation.destination_path,
    operation.output_path,
    operation.prompt_path,
    operation.script_path,
    operation.working_dir,
    operation.target,
    operation.url,
    operation.method,
    operation.index_path,
    operation.query,
    operation.command,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function removeWorkflowNode(workflow, nodeId) {
  return {
    ...workflow,
    nodes: (workflow.nodes ?? []).filter((node) => node.id !== nodeId),
    edges: (workflow.edges ?? []).filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    metadata: setWorkflowGroups(
      workflow,
      normalizeCanvasGroups(workflow).map((group) => ({
        ...group,
        nodeIds: group.nodeIds.filter((candidate) => candidate !== nodeId),
      })),
    ).metadata,
  };
}

export function addWorkflowEdge(workflow, fromNodeId, toNodeId, condition = "always", outputPattern = null) {
  const nextCondition = condition || "always";
  const nextOutputPattern = nextCondition === "output_matches" ? outputPattern || "" : null;
  return {
    ...workflow,
    edges: [
      ...(workflow.edges ?? []),
      {
        id: uniqueEdgeId(workflow.edges ?? [], fromNodeId, toNodeId),
        from: fromNodeId,
        to: toNodeId,
        label: edgeLabel(nextCondition, nextOutputPattern),
        condition: nextCondition,
        outputPattern: nextOutputPattern,
      },
    ],
  };
}

export function uniqueEdgeId(edges, fromNodeId, toNodeId) {
  const baseId = `${fromNodeId}-${toNodeId}`;
  if (!edges.some((edge) => edge.id === baseId)) {
    return baseId;
  }

  let index = 2;
  while (edges.some((edge) => edge.id === `${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

export function edgeLabel(condition = "always", outputPattern = "") {
  if (condition === "always") return "always";
  if (condition === "output_matches" && outputPattern) return `matches ${outputPattern}`;
  if (condition === "after_loop") return "after loop";
  return condition.replaceAll("_", " ");
}

function stableEdgeDirection(fromNodeId, toNodeId) {
  return String(fromNodeId).localeCompare(String(toNodeId)) <= 0 ? -1 : 1;
}

function edgeGeometry(fromNode, toNode, selfLoop, laneOffset = 0) {
  if (selfLoop) {
    const start = { x: fromNode.x + nodeWidth - 52, y: fromNode.y + 8 };
    const end = { x: fromNode.x + 52, y: fromNode.y + 8 };
    return {
      path: `M ${start.x} ${start.y} C ${start.x + 76} ${start.y - 84}, ${end.x - 76} ${end.y - 84}, ${end.x} ${end.y}`,
      label: { x: fromNode.x + nodeWidth / 2, y: fromNode.y - 58 },
    };
  }

  const fromCenter = {
    x: fromNode.x + nodeWidth / 2,
    y: fromNode.y + nodeHeight / 2,
  };
  const toCenter = {
    x: toNode.x + nodeWidth / 2,
    y: toNode.y + nodeHeight / 2,
  };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  const start = horizontal
    ? {
        x: dx >= 0 ? fromNode.x + nodeWidth : fromNode.x,
        y: fromCenter.y,
      }
    : {
        x: fromCenter.x,
        y: dy >= 0 ? fromNode.y + nodeHeight : fromNode.y,
      };
  const end = horizontal
    ? {
        x: dx >= 0 ? toNode.x : toNode.x + nodeWidth,
        y: toCenter.y,
      }
    : {
        x: toCenter.x,
        y: dy >= 0 ? toNode.y : toNode.y + nodeHeight,
      };

  const controlDistance = Math.max(80, (horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
  const direction = horizontal ? Math.sign(end.x - start.x) || 1 : Math.sign(end.y - start.y) || 1;
  const c1 = horizontal
    ? { x: start.x + direction * controlDistance, y: start.y + laneOffset }
    : { x: start.x + laneOffset, y: start.y + direction * controlDistance };
  const c2 = horizontal
    ? { x: end.x - direction * controlDistance, y: end.y + laneOffset }
    : { x: end.x + laneOffset, y: end.y - direction * controlDistance };

  return {
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    label: horizontal
      ? {
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2 + laneOffset - 12,
        }
      : {
          x: (start.x + end.x) / 2 + laneOffset,
          y: (start.y + end.y) / 2 - 12,
        },
  };
}

function draftEdgePath(draftEdge) {
  const start = draftEdge.start;
  const end = draftEdge.to;
  const dx = end.x - start.x;
  const controlDistance = Math.max(80, Math.abs(dx) / 2);
  const direction = Math.sign(dx) || 1;
  return `M ${start.x} ${start.y} C ${start.x + direction * controlDistance} ${start.y}, ${end.x - direction * controlDistance} ${end.y}, ${end.x} ${end.y}`;
}

function InspectorPanel({ children, open, subtitle, title, onToggle }) {
  return (
    <section className="border-b border-line">
      <button
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
        type="button"
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>
        </span>
        {open ? (
          <ChevronUp className="shrink-0 text-muted" size={16} />
        ) : (
          <ChevronDown className="shrink-0 text-muted" size={16} />
        )}
      </button>
      {open ? children : null}
    </section>
  );
}

function InspectorSection({ children, className = "", title }) {
  return (
    <section className={`space-y-3 rounded-lg border border-line p-3 ${className}`}>
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function ApprovalDecisionOverlay({ approval, node, onDecideApproval }) {
  const [notes, setNotes] = useState("");
  const [approver, setApprover] = useState(approval?.approvers?.[0] || "ui");
  useEffect(() => {
    setNotes("");
    setApprover(approval?.approvers?.[0] || "ui");
  }, [approval?.runId, approval?.nodeId, approval?.approvers]);
  if (!approval) return null;
  const nodeLabel = node?.label || node?.id || approval.nodeId;
  return (
    <div className="pointer-events-none absolute inset-0 z-[90] flex items-center justify-center px-4">
      <section
        className="pointer-events-auto w-full max-w-[560px] rounded-lg border border-amber-300 bg-white shadow-2xl"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-600 text-white">
              <ShieldCheck size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-ink">Approval Required</h2>
              <p className="truncate text-sm text-slate-600">{nodeLabel}</p>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-800">
            {approval.message}
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_1fr]">
            <label className="space-y-1 text-xs font-medium text-slate-600">
              <span>Approver</span>
              <input
                className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm text-ink outline-none transition placeholder:text-muted/70 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10"
                placeholder="Approver identity"
                value={approver}
                onChange={(event) => setApprover(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-slate-600">
              <span>Notes</span>
              <textarea
                className="min-h-[82px] w-full resize-y rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-muted/70 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10"
                placeholder="Decision notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              className="flex h-14 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-700"
              title="Approve pending approval"
              type="button"
              onClick={() => onDecideApproval?.(approval, "approved", notes, approver)}
            >
              <Check size={22} />
              Approve
            </button>
            <button
              className="flex h-14 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-50 px-4 text-base font-semibold text-red-700 shadow-sm transition hover:bg-red-100"
              title="Reject pending approval"
              type="button"
              onClick={() => onDecideApproval?.(approval, "rejected", notes, approver)}
            >
              <X size={22} />
              Reject
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ApprovalRuntimePanel({ approval, onDecideApproval }) {
  const [notes, setNotes] = useState("");
  const [approver, setApprover] = useState(approval?.approvers?.[0] || "ui");
  useEffect(() => {
    setApprover(approval?.approvers?.[0] || "ui");
  }, [approval?.runId, approval?.nodeId, approval?.approvers]);
  if (!approval) return null;
  const decision = approval.decision;
  const pending = approval.status === "pending";
  return (
    <InspectorSection title="Approval status">
      <div className="space-y-2 text-xs text-slate-700">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-ink">{pending ? "Pending" : "Decided"}</span>
          <span className="font-mono text-[11px] text-muted">{approval.runId}</span>
        </div>
        <div className="whitespace-pre-wrap break-words leading-5">{approval.message}</div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-muted">
          <span>Requested</span>
          <span className="truncate text-right">{approval.requestedAt || "-"}</span>
          <span>Timeout</span>
          <span className="truncate text-right">
            {approval.timeoutSeconds ? `${approval.timeoutSeconds}s` : "None"}
          </span>
          {approval.timeoutSeconds ? (
            <>
              <span>Timeout action</span>
              <span className="truncate text-right">
                {approval.timeoutDecision === "reject" ? "Reject" : "Timeout"}
              </span>
            </>
          ) : null}
          <span>Approvers</span>
          <span className="truncate text-right">
            {approval.approvers?.length ? approval.approvers.join(", ") : "Any"}
          </span>
          {decision ? (
            <>
              <span>Decision</span>
              <span className="truncate text-right">{decision.decision}</span>
              <span>By</span>
              <span className="truncate text-right">{decision.decidedBy || "-"}</span>
              <span>Notes</span>
              <span className="truncate text-right">{decision.notes || "-"}</span>
            </>
          ) : null}
        </div>
        {pending ? (
          <div className="space-y-2 pt-1">
            <input
              className="h-8 w-full rounded-md border border-line bg-white px-2 text-xs text-ink outline-none transition placeholder:text-muted/70 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10"
              placeholder="Approver identity"
              value={approver}
              onChange={(event) => setApprover(event.target.value)}
            />
            <textarea
              className="min-h-[72px] w-full resize-y rounded-md border border-line bg-white px-2 py-1.5 text-xs text-ink outline-none transition placeholder:text-muted/70 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10"
              placeholder="Decision notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="btn-primary h-8 flex-1 justify-center text-xs"
                type="button"
                onClick={() => onDecideApproval?.(approval, "approved", notes, approver)}
              >
                <Check size={14} />
                Approve
              </button>
              <button
                className="h-8 flex-1 rounded-md border border-red-200 bg-red-50 px-2 text-xs font-medium text-red-700 transition hover:bg-red-100"
                type="button"
                onClick={() => onDecideApproval?.(approval, "rejected", notes, approver)}
              >
                Reject
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}

function VectorIndexStats({ output }) {
  const data = output?.data ?? null;
  if (!data || data.index_path == null || data.chunk_count == null) {
    return null;
  }
  const stats = [
    ["Status", data.status ?? (data.current ? "current" : "updated")],
    ["Files", data.indexed_file_count ?? data.file_count ?? "-"],
    ["Chunks", data.chunk_count ?? "-"],
    ["Added", data.added_files ?? 0],
    ["Updated", data.updated_files ?? 0],
    ["Deleted", data.deleted_files ?? 0],
    ["Stale", data.stale_files ?? 0],
    ["Size", data.index_size_bytes ? `${data.index_size_bytes} B` : "-"],
  ];
  return (
    <InspectorSection title="Index stats">
      <div className="grid grid-cols-2 gap-2 text-xs">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-md border border-line px-2 py-1.5">
            <span className="block text-muted">{label}</span>
            <span className="font-semibold text-slate-700 dark:text-slate-200">{value}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1 text-xs">
        <div>
          <span className="font-medium text-muted">Strategy</span>
          <span className="ml-2 text-slate-700 dark:text-slate-200">
            {data.strategy ?? "hash_token_v1"}
          </span>
        </div>
        <div className="break-all">
          <span className="font-medium text-muted">Index</span>
          <span className="ml-2 text-slate-700 dark:text-slate-200">{data.index_path}</span>
        </div>
        {data.last_update_time ? (
          <div>
            <span className="font-medium text-muted">Updated</span>
            <span className="ml-2 text-slate-700 dark:text-slate-200">
              {data.last_update_time}
            </span>
          </div>
        ) : null}
      </div>
    </InspectorSection>
  );
}

function VectorSearchStats({ output }) {
  const data = output?.data ?? null;
  if (!data || data.index_path == null || !Array.isArray(data.results)) {
    return null;
  }
  return (
    <InspectorSection title="Search stats">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-line px-2 py-1.5">
          <span className="block text-muted">Results</span>
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {data.results.length}
          </span>
        </div>
        <div className="rounded-md border border-line px-2 py-1.5">
          <span className="block text-muted">Threshold</span>
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {data.score_threshold ?? 0}
          </span>
        </div>
      </div>
      <div className="space-y-1 text-xs">
        <div>
          <span className="font-medium text-muted">Strategy</span>
          <span className="ml-2 text-slate-700 dark:text-slate-200">
            {data.strategy ?? "cosine_v1"}
          </span>
        </div>
        <div className="break-all">
          <span className="font-medium text-muted">Index</span>
          <span className="ml-2 text-slate-700 dark:text-slate-200">{data.index_path}</span>
        </div>
      </div>
    </InspectorSection>
  );
}

function HttpResponsePreview({ output }) {
  const data = output?.data ?? null;
  if (!data || data.status == null) {
    return null;
  }
  const body = typeof data.body === "string" ? data.body : "";
  const headers = data.headers && typeof data.headers === "object" ? data.headers : {};
  const selected = data.selected && typeof data.selected === "object" ? data.selected : {};
  return (
    <InspectorSection title="Response preview">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-line px-3 py-2">
          <span className="block text-muted">Status</span>
          <span className="font-semibold text-slate-700">{data.status}</span>
        </div>
        <div className="rounded-lg border border-line px-3 py-2">
          <span className="block text-muted">Method</span>
          <span className="font-semibold text-slate-700">{data.method ?? "HTTP"}</span>
        </div>
      </div>
      {data.url ? (
        <div>
          <span className="text-xs font-medium text-muted">URL</span>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {data.url}
          </pre>
        </div>
      ) : null}
      {Object.keys(selected).length ? (
        <div>
          <span className="text-xs font-medium text-muted">Output mapping</span>
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {JSON.stringify(selected, null, 2)}
          </pre>
        </div>
      ) : null}
      {Object.keys(headers).length ? (
        <div>
          <span className="text-xs font-medium text-muted">Headers</span>
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {JSON.stringify(headers, null, 2)}
          </pre>
        </div>
      ) : null}
      {body ? (
        <div>
          <span className="text-xs font-medium text-muted">Body</span>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {body}
          </pre>
        </div>
      ) : null}
    </InspectorSection>
  );
}

function WorkflowNodeLabelField({
  node,
  workflows = [],
  onChange,
  onRenameWorkflow,
  onTargetWorkflowRenamed,
}) {
  const targetWorkflow = workflows.find(
    (candidate) => candidate.id === node.operation?.workflow_id,
  );
  const currentLabel = targetWorkflow?.name || node.label || "";
  const [draft, setDraft] = useState(currentLabel);

  useEffect(() => {
    setDraft(currentLabel);
  }, [currentLabel, node.operation?.workflow_id]);

  function commit() {
    const nextLabel = draft.trim();
    if (!nextLabel) {
      setDraft(currentLabel);
      return;
    }
    if (targetWorkflow && nextLabel !== targetWorkflow.name) {
      Promise.resolve(onRenameWorkflow?.(targetWorkflow.id, nextLabel))
        .then((renamedWorkflow) => {
          if (renamedWorkflow?.id) {
            onTargetWorkflowRenamed?.(renamedWorkflow);
          }
        })
        .catch(() => {
          setDraft(currentLabel);
        });
    } else if (!targetWorkflow) {
      onChange?.(nextLabel);
    }
  }

  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">Label</span>
      <input
        className="mt-1 h-10 w-full rounded-lg border border-subtle bg-white px-3 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(currentLabel);
            event.currentTarget.blur();
          }
        }}
      />
      <p className="mt-1 text-xs leading-5 text-muted">Renames the target workflow.</p>
    </label>
  );
}

function TextField({
  diagnostics = [],
  label,
  onChange,
  pathBasePath = "",
  pathLink = false,
  pathPicker = false,
  placeholder,
  promptForTrust = true,
  readOnly = false,
  value,
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingTrustSelection, setPendingTrustSelection] = useState(null);
  const [pathInfo, setPathInfo] = useState(null);
  const [textFileDialog, setTextFileDialog] = useState(null);
  const pathTrust = useContext(PathTrustContext);
  const isPathField = pathPicker || pathLink;
  const canPickPath = pathPicker && !readOnly && typeof onChange === "function";
  const displayValue = isPathField ? resolveDisplayPath(value ?? "", pathBasePath) : value ?? "";
  const canOpenPath = isPathField && displayValue && !isUrlPath(displayValue);
  const canEditTextPath = canOpenPath && pathInfo?.isFile;
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;

  useEffect(() => {
    let cancelled = false;

    async function loadPathInfo() {
      if (!canOpenPath) {
        setPathInfo(null);
        return;
      }
      try {
        const info = await window.goferDesktop?.workspace?.getPathInfo?.(displayValue);
        if (!cancelled) {
          setPathInfo(info ?? null);
        }
      } catch {
        if (!cancelled) {
          setPathInfo(null);
        }
      }
    }

    loadPathInfo();
    return () => {
      cancelled = true;
    };
  }, [canOpenPath, displayValue]);

  function applySelectedPath(selectedPath) {
    if (!selectedPath) return;
    if (
      promptForTrust &&
      pathTrust?.isTrustedPath &&
      pathTrust?.trustPath &&
      !pathTrust.isTrustedPath(selectedPath)
    ) {
      setPendingTrustSelection({
        parentPath: pathParent(selectedPath) || selectedPath,
        path: selectedPath,
      });
      return;
    }
    onChange(selectedPath);
  }

  async function handlePathPick(event) {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (window.goferDesktop?.workspace?.selectPath) {
        const selectedPath = await window.goferDesktop.workspace.selectPath({
          currentPath: displayValue,
        });
        applySelectedPath(selectedPath);
        return;
      }
      if (window.goferDesktop?.workspace?.listDirectory) {
        setPickerOpen(true);
      }
    } catch (error) {
      console.error("Failed to select path", error);
    }
  }

  async function handlePathOpen(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!displayValue) return;

    try {
      const info = await window.goferDesktop?.workspace?.getPathInfo?.(displayValue);
      if (info?.isDirectory) {
        await window.goferDesktop?.workspace?.openPath?.(displayValue);
      } else {
        await window.goferDesktop?.workspace?.revealPath?.(displayValue);
      }
    } catch (error) {
      console.error("Failed to reveal path", error);
    }
  }

  return (
    <>
      <label className="block">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="relative mt-1 block">
          <input
            aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
            aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
            className={`h-10 w-full rounded-lg border bg-white px-3 text-sm outline-none transition read-only:bg-slate-50 ${fieldBorderClass(diagnostics)} ${
              canPickPath && canOpenPath ? "pr-[4.5rem]" : canPickPath || canOpenPath ? "pr-10" : ""
            }`}
            placeholder={placeholder}
            readOnly={readOnly}
            title={displayValue}
            value={displayValue}
            onChange={(event) => onChange?.(event.target.value)}
          />
          {canOpenPath ? (
            <button
              aria-label={`Open ${label?.toLowerCase?.() ?? "path"}`}
              className={`absolute top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-strong dark:hover:bg-[#2a2a2a] ${
                canPickPath ? "right-9" : "right-2"
              }`}
              title={`Open ${label?.toLowerCase?.() ?? "path"} in file browser`}
              type="button"
              onClick={handlePathOpen}
            >
              <ExternalLink size={16} strokeWidth={1.9} />
            </button>
          ) : null}
          {canPickPath ? (
            <button
              aria-label={`Choose ${label?.toLowerCase?.() ?? "path"}`}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-strong dark:hover:bg-[#2a2a2a]"
              title={`Choose ${label?.toLowerCase?.() ?? "path"}`}
              type="button"
              onClick={handlePathPick}
            >
              <FolderOpen size={17} strokeWidth={1.9} />
            </button>
          ) : null}
        </span>
        <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
      </label>
      {canEditTextPath ? (
        <div className="mt-1 flex justify-end gap-2">
          <button
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted underline-offset-2 transition hover:text-ink hover:underline"
            type="button"
            onClick={() => setTextFileDialog({ mode: "edit", path: displayValue })}
          >
            <FilePenLine size={12} />
            edit
          </button>
          <button
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted underline-offset-2 transition hover:text-ink hover:underline"
            type="button"
            onClick={() => setTextFileDialog({ mode: "preview", path: displayValue })}
          >
            <Eye size={12} />
            preview
          </button>
        </div>
      ) : null}
      {pickerOpen ? (
        <PathPickerDialog
          currentPath={displayValue}
          label={label}
          onClose={() => setPickerOpen(false)}
          onSelect={(selectedPath) => {
            applySelectedPath(selectedPath);
            setPickerOpen(false);
          }}
        />
      ) : null}
      {pendingTrustSelection ? (
        <PathSelectionTrustPrompt
          parentPath={pendingTrustSelection.parentPath}
          path={pendingTrustSelection.path}
          onCancel={() => setPendingTrustSelection(null)}
          onConfirm={(trustParent) => {
            const trustedPath = trustParent
              ? pendingTrustSelection.parentPath
              : pendingTrustSelection.path;
            onChange(pendingTrustSelection.path);
            setPendingTrustSelection(null);
            window.setTimeout(() => pathTrust?.trustPath?.(trustedPath), 0);
          }}
        />
      ) : null}
      {textFileDialog ? (
        <TextFileDialog
          mode={textFileDialog.mode}
          path={textFileDialog.path}
          onClose={() => setTextFileDialog(null)}
        />
      ) : null}
    </>
  );
}

function TextFileDialog({ mode, path, onClose }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const readOnly = mode === "preview";

  useEffect(() => {
    let cancelled = false;

    async function loadFile() {
      setLoading(true);
      setError("");
      try {
        const payload = await window.goferDesktop?.textFiles?.read?.(path);
        if (!cancelled) {
          setContent(payload?.content ?? "");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFile();
    return () => {
      cancelled = true;
    };
  }, [path]);

  async function saveFile() {
    setSaving(true);
    setError("");
    try {
      await window.goferDesktop?.textFiles?.write?.({ targetPath: path, content });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save file");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/35 px-4">
      <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-white shadow-panel">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-strong">
              {readOnly ? "Preview file" : "Edit file"}
            </h2>
            <p className="mt-1 truncate text-xs text-muted" title={path}>
              {path}
            </p>
          </div>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink dark:hover:bg-[#2a2a2a]"
            title="Close"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-[340px] flex-1 p-4">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted">
              <Loader2 size={16} className="mr-2 animate-spin" />
              Loading file
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : (
            <textarea
              className="h-[52vh] min-h-[320px] w-full resize-none rounded-lg border border-line bg-slate-50 p-3 font-mono text-xs leading-5 text-ink outline-none transition focus:border-teal-500 read-only:bg-slate-50"
              readOnly={readOnly}
              spellCheck={false}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          {!readOnly ? (
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading || saving || Boolean(error)}
              type="button"
              onClick={saveFile}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <FilePenLine size={15} />}
              Save
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PathPickerDialog({ currentPath, label, onClose, onSelect }) {
  const [contextMenu, setContextMenu] = useState(null);
  const [copiedEntry, setCopiedEntry] = useState(null);
  const [nameRequest, setNameRequest] = useState(null);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [parent, setParent] = useState(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [selectedPath, setSelectedPath] = useState(currentPath ?? "");
  const titleLabel = typeof label === "string" && label.trim() ? label : "path";

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  async function loadDirectory(nextPath) {
    setContextMenu(null);
    setLoading(true);
    setError("");
    try {
      const payload = await window.goferDesktop.workspace.listDirectory({
        currentPath: nextPath ?? "",
      });
      setDirectory(payload.directory);
      setParent(payload.parent);
      setEntries(payload.entries ?? []);
      setSelectedPath(payload.directory);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function copyCurrentPath() {
    if (!directory) return;

    try {
      await navigator.clipboard.writeText(directory);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1400);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to copy path");
    }
  }

  async function openCurrentPath() {
    if (!directory) return;

    try {
      await window.goferDesktop?.workspace?.openPath?.(directory);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open path");
    }
  }

  function showContextMenu(event, entry = null) {
    event.preventDefault();
    event.stopPropagation();
    if (!directory) return;
    setContextMenu({
      entry,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function requestCreateChild(kind) {
    setContextMenu(null);
    setNameRequest({ kind, mode: "create" });
  }

  function requestRenameEntry(entry) {
    setContextMenu(null);
    if (!entry) return;
    setNameRequest({
      entry,
      initialName: entry.name,
      kind: entry.isDirectory ? "folder" : "file",
      mode: "rename",
    });
  }

  async function createChild(kind, name) {
    if (!name) return;

    try {
      let result;
      if (kind === "file") {
        result = await window.goferDesktop?.workspace?.createFile?.({ directory, name });
      } else {
        result = await window.goferDesktop?.workspace?.createFolder?.({ directory, name });
      }
      await loadDirectory(directory);
      if (result?.path) {
        setSelectedPath(result.path);
      }
      setNameRequest(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : `Unable to create ${kind}`);
    }
  }

  async function renameEntry(entry, name) {
    if (!entry || !name) return;

    try {
      const result = await window.goferDesktop?.workspace?.renamePath?.({
        sourcePath: entry.path,
        name,
      });
      await loadDirectory(directory);
      if (result?.path) {
        setSelectedPath(result.path);
      }
      setNameRequest(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Unable to rename path");
    }
  }

  async function copyEntry(entry) {
    setContextMenu(null);
    if (!entry) return;
    setCopiedEntry(entry);
  }

  async function pasteEntry() {
    setContextMenu(null);
    if (!copiedEntry) return;

    const existingNames = new Set(entries.map((entry) => entry.name));
    const nextName = nextCopyName(copiedEntry.name, existingNames);
    try {
      await window.goferDesktop?.workspace?.copyPath?.({
        sourcePath: copiedEntry.path,
        destinationPath: joinPath(directory, nextName),
      });
      await loadDirectory(directory);
      setSelectedPath(joinPath(directory, nextName));
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to copy path");
    }
  }

  async function deleteEntry(entry) {
    setContextMenu(null);
    if (!entry) return;
    if (!window.confirm(`Delete ${entry.name}?`)) return;

    try {
      await window.goferDesktop?.workspace?.deletePath?.(entry.path);
      if (selectedPath === entry.path) {
        setSelectedPath(directory);
      }
      await loadDirectory(directory);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete path");
    }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/35 px-4">
      <div className="flex max-h-[78vh] w-full max-w-[680px] flex-col rounded-lg border border-line bg-white shadow-panel">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-strong">
              Choose {titleLabel.toLowerCase()}
            </h2>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <button
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-[#2a2a2a]"
                disabled={!directory}
                title={pathCopied ? "Copied" : "Copy path"}
                type="button"
                onClick={copyCurrentPath}
              >
                {pathCopied ? <Check size={13} /> : <Copy size={13} />}
              </button>
              <button
                className="min-w-0 truncate text-left text-xs text-teal-700 underline-offset-2 transition hover:text-teal-800 hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                disabled={!directory}
                title={directory}
                type="button"
                onClick={openCurrentPath}
              >
                {directory || "Loading..."}
              </button>
            </div>
          </div>
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink dark:hover:bg-[#2a2a2a]"
            title="Close"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <button
            className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!parent || loading}
            type="button"
            onClick={() => loadDirectory(parent)}
          >
            Up
          </button>
          <button
            className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={async () => {
              const dataDir = await window.goferDesktop.getDataDir();
              loadDirectory(dataDir);
            }}
          >
            Gofer data
          </button>
          <button
            className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!directory || loading}
            type="button"
            onClick={() => requestCreateChild("file")}
          >
            New file
          </button>
          <button
            className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!directory || loading}
            type="button"
            onClick={() => requestCreateChild("folder")}
          >
            New folder
          </button>
          <button
            className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!directory}
            type="button"
            onClick={() => onSelect(directory)}
          >
            Choose current folder
          </button>
        </div>

        <div
          className="min-h-[260px] flex-1 overflow-y-auto p-2"
          onContextMenu={(event) => showContextMenu(event)}
        >
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted">
              <Loader2 size={16} className="mr-2 animate-spin" />
              Loading folder
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {!loading && !error && entries.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted">
              This folder is empty.
            </div>
          ) : null}
          {!loading && !error
            ? entries.map((entry) => (
                <button
                  key={entry.path}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition hover:bg-slate-50 ${
                    selectedPath === entry.path ? "bg-slate-100 text-strong" : "text-slate-700"
                  }`}
                  type="button"
                  onContextMenu={(event) => showContextMenu(event, entry)}
                  onClick={() =>
                    entry.isDirectory ? loadDirectory(entry.path) : setSelectedPath(entry.path)
                  }
                >
                  {entry.isDirectory ? (
                    <FolderOpen className="text-teal-600" size={16} />
                  ) : (
                    <FileText className="text-muted" size={16} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.hidden ? <span className="text-[11px] text-muted">hidden</span> : null}
                </button>
              ))
            : null}
        </div>
        {contextMenu ? (
          <PathContextMenu
            canPaste={Boolean(copiedEntry)}
            copiedName={copiedEntry?.name}
            entry={contextMenu.entry}
            x={contextMenu.x}
            y={contextMenu.y}
            onCopy={() => copyEntry(contextMenu.entry)}
            onCreateFile={() => requestCreateChild("file")}
            onCreateFolder={() => requestCreateChild("folder")}
            onDelete={() => deleteEntry(contextMenu.entry)}
            onPaste={pasteEntry}
            onRename={() => requestRenameEntry(contextMenu.entry)}
          />
        ) : null}
        {nameRequest ? (
          <PathNameDialog
            directory={directory}
            initialName={nameRequest.initialName}
            kind={nameRequest.kind}
            mode={nameRequest.mode}
            onClose={() => setNameRequest(null)}
            onSubmit={(name) =>
              nameRequest.mode === "rename"
                ? renameEntry(nameRequest.entry, name)
                : createChild(nameRequest.kind, name)
            }
          />
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="min-w-0 truncate text-xs text-muted">{selectedPath || directory}</p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!selectedPath}
              type="button"
              onClick={() => onSelect(selectedPath)}
            >
              <Check size={15} />
              Choose
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PathNameDialog({ directory, initialName = "", kind, mode, onClose, onSubmit }) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const title =
    mode === "rename"
      ? `Rename ${kind}`
      : kind === "file"
        ? "Create file"
        : "Create folder";
  const action = mode === "rename" ? "Rename" : "Create";

  async function submit(event) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmedName);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-slate-950/25 px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-line bg-white p-4 shadow-panel"
        onSubmit={submit}
      >
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-strong">{title}</h3>
          <p className="mt-1 truncate text-xs text-muted" title={directory}>
            {directory}
          </p>
        </div>
        <input
          autoFocus
          className="h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
          placeholder={kind === "file" ? "new-file.txt" : "new-folder"}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            disabled={submitting}
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting || !name.trim()}
            type="submit"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {action}
          </button>
        </div>
      </form>
    </div>
  );
}

function PathContextMenu({
  canPaste,
  copiedName,
  entry,
  onCopy,
  onCreateFile,
  onCreateFolder,
  onDelete,
  onPaste,
  onRename,
  x,
  y,
}) {
  return (
    <div
      className="fixed z-[90] min-w-44 overflow-hidden rounded-lg border border-line bg-white py-1 text-sm shadow-panel"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {entry ? (
        <>
          <button
            className="block w-full px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50"
            type="button"
            onClick={onRename}
          >
            Rename
          </button>
          <button
            className="block w-full px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50"
            type="button"
            onClick={onCopy}
          >
            Copy
          </button>
          <button
            className="block w-full px-3 py-2 text-left text-red-600 transition hover:bg-red-50"
            type="button"
            onClick={onDelete}
          >
            Delete
          </button>
          <div className="my-1 border-t border-line" />
        </>
      ) : null}
      <button
        className="block w-full px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
        disabled={!canPaste}
        title={canPaste ? `Paste ${copiedName}` : "Copy a file or folder first"}
        type="button"
        onClick={onPaste}
      >
        Paste
      </button>
      <div className="my-1 border-t border-line" />
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
        Create new
      </div>
      <button
        className="block w-full px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50"
        type="button"
        onClick={onCreateFile}
      >
        File
      </button>
      <button
        className="block w-full px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50"
        type="button"
        onClick={onCreateFolder}
      >
        Folder
      </button>
    </div>
  );
}

function nextCopyName(name = "", existingNames = new Set()) {
  let candidate = defaultCopyName(name);
  let index = 2;
  while (existingNames.has(candidate)) {
    candidate = defaultCopyName(name, index);
    index += 1;
  }
  return candidate;
}

function defaultCopyName(name = "", index = null) {
  const value = String(name || "copy");
  const dotIndex = value.lastIndexOf(".");
  const suffix = index ? ` copy ${index}` : " copy";
  if (dotIndex > 0) {
    return `${value.slice(0, dotIndex)}${suffix}${value.slice(dotIndex)}`;
  }
  return `${value}${suffix}`;
}

function InlineTextField({ diagnostics = [], onChange, placeholder, value }) {
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;
  return (
    <div>
      <input
        aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
        aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
        className={`h-9 w-full rounded-lg border bg-white px-2 text-sm outline-none transition placeholder:text-slate-400 ${fieldBorderClass(diagnostics)}`}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </div>
  );
}

function CronExpressionField({
  diagnostics = [],
  label,
  onChange,
  onPickerOpenChange,
  pickerOpen,
  placeholder,
  value,
}) {
  const today = new Date();
  const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(today.getDate()).padStart(2, "0")}`;
  const defaultTime = `${String(today.getHours()).padStart(2, "0")}:00`;
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const [recurrence, setRecurrence] = useState("weekly");
  const generatedCron = cronFromPicker({ date, recurrence, time });
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;

  return (
    <div className="relative">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className={`mt-1 flex h-10 overflow-hidden rounded-lg border bg-white transition focus-within:border-teal-500 ${fieldBorderClass(diagnostics, "border-line")}`}>
        <input
          aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
          aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
          className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="grid w-10 shrink-0 place-items-center border-l border-line text-muted transition hover:bg-slate-50 hover:text-ink"
          title="Pick schedule"
          type="button"
          onClick={() => onPickerOpenChange(!pickerOpen)}
        >
          <CalendarDays size={17} />
        </button>
      </div>
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />

      {pickerOpen ? (
        <div className="absolute right-0 top-[68px] z-40 w-[270px] rounded-lg border border-line bg-white p-3 shadow-panel">
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-muted">Recurrence</span>
              <select
                className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                value={recurrence}
                onChange={(event) => setRecurrence(event.target.value)}
              >
                <option value="daily">Daily at this time</option>
                <option value="weekly">Weekly on this weekday</option>
                <option value="monthly">Monthly on this day</option>
                <option value="yearly">Yearly on this date</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-muted">Date</span>
                <input
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-teal-500"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted">Time</span>
                <input
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-teal-500"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
            </div>
            <div className="rounded-lg border border-line bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                Cron
              </p>
              <p className="mt-1 font-mono text-sm text-ink">{generatedCron}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="h-8 rounded-lg border border-line px-3 text-sm text-muted transition hover:bg-slate-50 hover:text-ink"
                type="button"
                onClick={() => onPickerOpenChange(false)}
              >
                Cancel
              </button>
              <button
                className="h-8 rounded-lg border border-teal-700 bg-teal-700 px-3 text-sm font-medium text-white transition hover:bg-teal-800"
                type="button"
                onClick={() => {
                  onChange(generatedCron);
                  onPickerOpenChange(false);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function cronFromPicker({ date, recurrence, time }) {
  const [hour = "0", minute = "0"] = String(time || "00:00").split(":");
  const [, month = "1", day = "1"] = String(date || "").split("-");
  const weekday = date ? new Date(`${date}T00:00:00`).getDay() : "*";
  const cronMinute = Number(minute);
  const cronHour = Number(hour);
  const cronDay = Number(day);
  const cronMonth = Number(month);

  switch (recurrence) {
    case "daily":
      return `${cronMinute} ${cronHour} * * *`;
    case "monthly":
      return `${cronMinute} ${cronHour} ${cronDay} * *`;
    case "yearly":
      return `${cronMinute} ${cronHour} ${cronDay} ${cronMonth} *`;
    case "weekly":
    default:
      return `${cronMinute} ${cronHour} * * ${weekday}`;
  }
}

function NumberField({ diagnostics = [], label, min, onChange, placeholder, step = "1", value }) {
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
        aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
        className={`mt-1 h-10 w-full rounded-lg border bg-white px-3 text-sm outline-none transition ${fieldBorderClass(diagnostics)}`}
        min={min}
        placeholder={placeholder}
        step={step}
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </label>
  );
}

function GroupOpacityField({ onCommit, value }) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(String(value ?? ""));
  const skipCommitOnBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraftValue(String(value ?? ""));
    }
  }, [editing, value]);

  function restoreValue() {
    setDraftValue(String(value ?? ""));
  }

  function commitValue(rawValue = draftValue, { restoreEmpty = true } = {}) {
    const trimmed = rawValue.trim();
    if (trimmed === "") {
      if (restoreEmpty) {
        restoreValue();
      }
      return;
    }
    const parsedValue = Number(trimmed);
    if (!Number.isFinite(parsedValue)) {
      restoreValue();
      return;
    }
    const nextValue = clamp(Math.round(parsedValue), 0, 100);
    setDraftValue(String(nextValue));
    onCommit(nextValue);
  }

  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">Background opacity (%)</span>
      <input
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition"
        max="100"
        min="0"
        step="1"
        type="number"
        value={draftValue}
        onBlur={() => {
          if (skipCommitOnBlurRef.current) {
            skipCommitOnBlurRef.current = false;
            restoreValue();
            setEditing(false);
            return;
          }
          commitValue();
          setEditing(false);
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraftValue(nextValue);
          commitValue(nextValue, { restoreEmpty: false });
        }}
        onFocus={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            skipCommitOnBlurRef.current = true;
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function SelectField({ diagnostics = [], label, onChange, options, value }) {
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
        aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
        className={`mt-1 h-10 w-full rounded-lg border bg-white px-3 text-sm outline-none transition ${fieldBorderClass(diagnostics)}`}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </label>
  );
}

function EdgeSelect({ diagnostics = [], onChange, options, value }) {
  const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? "";
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;

  return (
    <div>
      <select
        aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
        aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
        className={`h-9 min-w-0 rounded-lg border bg-white px-1.5 text-xs outline-none transition ${fieldBorderClass(diagnostics)}`}
        title={selectedLabel}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </div>
  );
}

function TextareaField({ diagnostics = [], label, onChange, placeholder, rows = 3, value }) {
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <textarea
        aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
        aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
        className={`mt-1 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition ${fieldBorderClass(diagnostics)}`}
        placeholder={placeholder}
        rows={rows}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </label>
  );
}

function ToggleField({ checked, diagnostics = [], disabled = false, label, onChange }) {
  const diagnosticId = useId();
  const hasFieldDiagnostics = fieldDiagnosticState(diagnostics).diagnostics.length > 0;
  return (
    <div>
      <label
        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${fieldBorderClass(diagnostics, "border-line")} ${
          disabled ? "cursor-not-allowed bg-slate-50 text-muted dark:bg-[#252526]" : ""
        }`}
      >
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <input
          aria-describedby={hasFieldDiagnostics ? diagnosticId : undefined}
          aria-invalid={fieldDiagnosticState(diagnostics).severity === "error" || undefined}
          checked={checked}
          className="h-4 w-4 accent-teal-700"
          disabled={disabled}
          type="checkbox"
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
      <FieldDiagnosticMessage diagnostics={diagnostics} id={diagnosticId} />
    </div>
  );
}

function ListField({ diagnostics = [], label, onChange, placeholder, value }) {
  return (
    <TextareaField
      diagnostics={diagnostics}
      label={label}
      placeholder={placeholder}
      rows={2}
      value={(value ?? []).join(", ")}
      onChange={(text) =>
        onChange(
          text
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

function KeyValueField({ diagnostics = [], label, onChange, value }) {
  return (
    <TextareaField
      diagnostics={diagnostics}
      label={label}
      rows={3}
      value={objectToKeyValueText(value)}
      onChange={(text) => onChange(keyValueTextToObject(text))}
    />
  );
}

export function formatJsonBodyEditorValue(value) {
  if (value === null || value === undefined || value === "") return "";
  return JSON.stringify(value, null, 2);
}

export function parseJsonBodyEditorValue(text) {
  if (!text.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

function JsonBodyField({ label, onChange, value }) {
  const [text, setText] = useState(() => formatJsonBodyEditorValue(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setText(formatJsonBodyEditorValue(value));
    setError("");
  }, [value]);

  function update(nextText) {
    setText(nextText);
    const parsed = parseJsonBodyEditorValue(nextText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError("");
    onChange(parsed.value);
  }

  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <textarea
        className={`min-h-[8rem] rounded-lg border bg-white px-2 py-1.5 font-mono text-xs text-slate-900 outline-none transition focus:ring-2 focus:ring-brand/20 ${
          error ? "border-red-300 focus:border-red-400" : "border-line focus:border-brand"
        }`}
        rows={6}
        value={text}
        onChange={(event) => update(event.target.value)}
      />
      {error ? <span className="text-[11px] font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

const inputTargetOptions = [
  ["stdin", "stdin"],
];

function InputMappingField({ onChange, sourceGroups = [], sourceOptions, value }) {
  const targetListId = useId();
  const entries = Object.entries(value ?? {});
  const [openSourcePicker, setOpenSourcePicker] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const targetOptions = useMemo(() => {
    const usedTargets = new Set(inputTargetOptions.map(([optionValue]) => optionValue));
    const customTargets = Object.keys(value ?? {})
      .filter((target) => target && !usedTargets.has(target))
      .map((target) => [target, target]);
    return [...inputTargetOptions, ...customTargets];
  }, [value]);
  const sourceOptionsWithCustom = useMemo(() => {
    const usedSources = new Set(sourceOptions.map(([optionValue]) => optionValue));
    const customSources = Object.values(value ?? {})
      .filter((source) => source && !usedSources.has(source))
      .map((source) => [source, source]);
    return [...sourceOptions, ...customSources];
  }, [sourceOptions, value]);
  const sourceGroupsWithCustom = useMemo(() => {
    const usedSources = new Set(sourceGroups.flatMap((group) => group.options.map(([optionValue]) => optionValue)));
    const customSources = Object.values(value ?? {})
      .filter((source) => source && !usedSources.has(source))
      .map((source) => [source, source]);
    return customSources.length
      ? [...sourceGroups, { id: "custom", label: "Custom paths", options: customSources }]
      : sourceGroups;
  }, [sourceGroups, value]);
  const sourceGroupIds = useMemo(
    () => sourceGroupsWithCustom.map((group) => group.id).join("\n"),
    [sourceGroupsWithCustom],
  );

  useEffect(() => {
    setExpandedGroups(new Set(sourceGroupIds ? sourceGroupIds.split("\n") : []));
  }, [sourceGroupIds]);

  function toggleSourceGroup(groupId) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function selectSource(index, key, nextSource) {
    updateEntry(index, key, nextSource);
    setOpenSourcePicker(null);
  }

  function updateEntry(index, nextKey, nextValue) {
    const next = {};
    entries.forEach(([key, item], entryIndex) => {
      if (entryIndex === index) {
        next[nextKey.trim() || defaultBlankInputKey(value ?? {}, key)] = nextValue;
      } else {
        next[key] = item;
      }
    });
    onChange(next);
  }

  function removeEntry(index) {
    onChange(Object.fromEntries(entries.filter((_, entryIndex) => entryIndex !== index)));
    setOpenSourcePicker(null);
  }

  function addEntry() {
    const key = nextInputKey(value ?? {});
    onChange({ ...(value ?? {}), [key]: "previous.text" });
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_32px] gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        <span>Input</span>
        <span>Source output</span>
        <span />
      </div>
      {entries.length ? (
        entries.map(([key, source], index) => (
          <div
            key={`input-mapping-${index}`}
            className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_32px] gap-2"
          >
            <input
              className="h-9 min-w-0 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-teal-500"
              list={targetListId}
              placeholder="stdin"
              value={isStdinInputKey(key) ? "" : key}
              onChange={(event) => updateEntry(index, event.target.value, source)}
            />
            <datalist id={targetListId}>
              {targetOptions.map(([optionValue, label]) => (
                <option key={optionValue} label={label} value={optionValue} />
              ))}
            </datalist>
            <InputSourcePicker
              expandedGroups={expandedGroups}
              groups={sourceGroupsWithCustom}
              open={openSourcePicker === index}
              source={source}
              sourceOptions={sourceOptionsWithCustom}
              onOpenChange={(open) => setOpenSourcePicker(open ? index : null)}
              onSelect={(nextSource) => selectSource(index, key, nextSource)}
              onToggleGroup={toggleSourceGroup}
            />
            <button
              className="grid h-9 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-red-600 dark:hover:bg-[#2a2a2a]"
              title="Remove input"
              type="button"
              onClick={() => removeEntry(index)}
            >
              <X size={14} />
            </button>
          </div>
        ))
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs leading-5 text-muted">
          Map parent outputs into stdin or named variables.
        </p>
      )}
      <p className="text-xs leading-5 text-muted">
        Leave inputs blank to pass values as positional args like <code>$1</code> and{" "}
        <code>$2</code>. Type a name like <code>ticket_description</code> to expose it as{" "}
        <code>{"{{ticket_description}}"}</code> in prompts/templates,{" "}
        <code>$ticket_description</code> in shell commands, and{" "}
        <code>os.environ["ticket_description"]</code> in Python scripts.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          type="button"
          onClick={addEntry}
        >
          <Plus size={13} />
          Add input
        </button>
      </div>
    </div>
  );
}

function InputSourcePicker({
  expandedGroups,
  groups,
  onOpenChange,
  onSelect,
  onToggleGroup,
  open,
  source,
  sourceOptions,
}) {
  const sourceLabel = sourceOptions.find(([optionValue]) => optionValue === source)?.[1] ?? source;
  return (
    <div className="relative min-w-0">
      <button
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-white px-2 text-left text-xs text-slate-700 outline-none transition hover:bg-slate-50 focus:border-teal-500 dark:bg-[#1f1f1f] dark:text-slate-100 dark:hover:bg-[#272727]"
        title={sourceLabel || "Choose source output"}
        type="button"
        onClick={() => onOpenChange(!open)}
      >
        <span className="min-w-0 truncate">{sourceLabel || "Choose source output"}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-10 z-50 max-h-72 overflow-auto rounded-xl border border-line bg-white p-1.5 shadow-xl dark:bg-[#181818]">
          {groups.length ? (
            groups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              return (
                <div key={group.id} className="rounded-lg">
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#262626]"
                    title={group.label}
                    type="button"
                    onClick={() => onToggleGroup(group.id)}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className="min-w-0 truncate">{group.label}</span>
                  </button>
                  {expanded ? (
                    <div className="ml-3 border-l border-line py-1 pl-2">
                      {group.options.map(([optionValue, label]) => (
                        <button
                          key={`${group.id}-${optionValue}`}
                          className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                            optionValue === source
                              ? "bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200"
                              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#262626]"
                          }`}
                          title={`${group.id === "previous" ? label : `${group.label} ${label}`} (${optionValue})`}
                          type="button"
                          onClick={() => onSelect(optionValue)}
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          {optionValue === source ? <Check size={13} className="shrink-0" /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="px-2 py-2 text-xs text-muted">No ancestor outputs available.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function nextInputKey(value = {}) {
  if (!Object.hasOwn(value, "stdin")) return "stdin";
  let index = 2;
  while (Object.hasOwn(value, `stdin${index}`)) {
    index += 1;
  }
  return `stdin${index}`;
}

function defaultBlankInputKey(value = {}, currentKey = "") {
  if (isStdinInputKey(currentKey)) return currentKey;
  return nextInputKey(value);
}

function isStdinInputKey(key = "") {
  return key === "stdin" || /^stdin\d+$/.test(key);
}

function objectToKeyValueText(value = {}) {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

function keyValueTextToObject(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        if (index === -1) {
          return [line, ""];
        }
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}
