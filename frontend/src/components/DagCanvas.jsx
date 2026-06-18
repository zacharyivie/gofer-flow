import { useEffect, useMemo, useRef, useState } from "react";
import {
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
  FilePenLine,
  Files,
  FileText,
  FileX,
  FolderOpen,
  LocateFixed,
  Loader2,
  MoveRight,
  Play,
  Plus,
  Route,
  Search,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";

const nodeStyles = {
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
};

const defaultSettings = {
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
const isWindows =
  typeof navigator !== "undefined" &&
  /win/i.test(`${navigator.userAgent} ${navigator.platform}`);
const commandNodeLabel = isWindows ? "PowerShell command" : "Bash command";
const defaultCommand = isWindows ? 'Write-Output "hello"' : "echo hello";

function defaultOperation(type, nodeNumber = 1) {
  switch (type) {
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
      };
    case "local_search":
      return {
        type,
        index_path: "indexes/docs.json",
        query: "",
        top_k: 5,
      };
    case "agent":
    default:
      return {
        type: "agent",
        agent_id: `agent-${nodeNumber}`,
        prompt_path: `prompts/agent-${nodeNumber}.md`,
        working_dir: ".",
        skill_name: "",
        dynamic_count: 1,
        input_mapping: {},
        fan_source: null,
      };
  }
}

function defaultAgentConfig(agentId) {
  return {
    agent_id: agentId,
    subscription: "codex",
    working_dir: ".",
    prompt_path: `prompts/${agentId}.md`,
    tools: [],
    mcp_servers: [],
    env: {},
  };
}

function nodeMetaFromOperation(operation = {}) {
  switch (operation.type) {
    case "bash_command":
      return operation.command || commandNodeLabel.toLowerCase();
    case "python_script":
    case "shell_script":
      return operation.script_path || "script";
    case "read_file":
      return `read ${operation.path || "file"}`;
    case "write_file":
      return `write ${operation.path || "file"}`;
    case "copy_file":
      return `copy ${operation.source_path || "source"} to ${operation.destination_path || "destination"}`;
    case "move_file":
      return `move ${operation.source_path || "source"} to ${operation.destination_path || "destination"}`;
    case "delete_file":
      return `delete ${operation.path || "file"}`;
    case "file":
      return operation.path || "file";
    case "folder":
      return operation.path || "folder";
    case "open_resource":
      return `open ${operation.target || "target"}`;
    case "prompt_file":
      return `prompt ${operation.output_path || "file"}`;
    case "common_llm_task":
      return `${operation.task || "summarize"} with ${operation.agent_id || "agent"}`;
    case "local_vectorize":
      return `index ${operation.source_path || "files"}`;
    case "local_search":
      return `search ${operation.index_path || "index"}`;
    case "agent":
      if (operation.skill_name) return `${operation.agent_id || "agent"} · /${operation.skill_name}`;
      return operation.prompt_path
        ? `${operation.agent_id || "agent"} · ${operation.prompt_path}`
        : operation.agent_id || "agent";
    default:
      return "operation";
  }
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function nextAvailableAgentNumber(nodes, agents) {
  const usedNumbers = new Set([
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

export default function DagCanvas({
  logState,
  notice,
  runState,
  workflow,
  onImportWorkflow,
  onLoadLatestLog,
  onRunWorkflow,
  onSelectRunLog,
  onStopRunLog,
  onStopWorkflow,
  onValidateWorkflow,
  onWorkflowChange,
}) {
  const canvasRef = useRef(null);
  const importInputRef = useRef(null);
  const nodeDragMovedRef = useRef(false);
  const [selectedNodeId, setSelectedNodeId] = useState();
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [panningPointerId, setPanningPointerId] = useState(null);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [logHeight, setLogHeight] = useState(240);
  const [expandedFolderNodes, setExpandedFolderNodes] = useState({});
  const [folderNodeEntries, setFolderNodeEntries] = useState({});
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [draftEdge, setDraftEdge] = useState(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const invalidWorkflow = Boolean(workflow.invalid);
  const workflowNodes = workflow.nodes ?? [];
  const workflowEdges = workflow.edges ?? [];

  const selectedNode = workflowNodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = workflowEdges.find((edge) => edge.id === selectedEdgeId);
  const runResult = runState?.result?.workflowId === workflow.id ? runState.result : null;
  const selectedNodeOutput = selectedNodeId ? runResult?.nodeOutputs?.[selectedNodeId] : null;
  const workflowLogText =
    logState?.text || runResult?.logText || formatWorkflowRunLog(runResult);
  const displayedLog = selectedNodeId
    ? extractNodeLog(workflowLogText, selectedNodeId) || selectedNodeOutput?.output || ""
    : workflowLogText;
  const logTitle = selectedNodeId ? `${selectedNodeId} last run` : "Workflow log";
  const nodeStatuses = useMemo(() => {
    return getNodeStatuses(workflowNodes, runResult, workflowLogText);
  }, [runResult, workflowNodes, workflowLogText]);
  const currentWorkflowRunning =
    runState?.running && runState.workflowId === workflow.id;
  const workflowHasRunningRuns = currentWorkflowRunning || logState?.runs?.some(
    (run) => run.status === "running",
  );
  const nodesById = useMemo(() => {
    return Object.fromEntries(workflowNodes.map((node) => [node.id, node]));
  }, [workflowNodes]);

  useEffect(() => {
    setSelectedNodeId(undefined);
    setSelectedEdgeId(null);
    setDraftEdge(null);
    setDraggingNodeId(null);
    setPanningPointerId(null);
    setViewport({ x: 0, y: 0, scale: 1 });
  }, [workflow.id]);

  useEffect(() => {
    if (selectedNodeId && !nodesById[selectedNodeId]) {
      setSelectedNodeId(undefined);
    }
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
    if (!panningPointerId) return undefined;

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [panningPointerId]);

  function updateNode(nodeId, patch) {
    onWorkflowChange({
      ...workflow,
      nodes: workflowNodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
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

    if (
      (operation.type === "agent" || operation.type === "common_llm_task") &&
      patch.agent_id &&
      !workflow.agents?.[patch.agent_id]
    ) {
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [patch.agent_id]: defaultAgentConfig(patch.agent_id),
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
    const nextOperation = defaultOperation(type, workflowNodes.length + 1);
    const nextNode = {
      type,
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
          [nextOperation.agent_id]: defaultAgentConfig(nextOperation.agent_id),
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

  function addNode() {
    const nextNumber = nextAvailableNodeNumber(workflowNodes);
    const nextAgentNumber = nextAvailableAgentNumber(workflowNodes, workflow.agents);
    const nextOperation = defaultOperation("agent", nextAgentNumber);
    const newNode = {
      id: `node-${nextNumber}`,
      label: `New Step ${nextNumber}`,
      type: "agent",
      operation: nextOperation,
      settings: defaultSettings,
      meta: nodeMetaFromOperation(nextOperation),
      x: 180 + nextNumber * 34,
      y: 180 + nextNumber * 24,
    };
    onWorkflowChange({
      ...workflow,
      agents: {
        ...(workflow.agents ?? {}),
        [newNode.operation.agent_id]: defaultAgentConfig(newNode.operation.agent_id),
      },
      nodes: [...workflowNodes, newNode],
    });
    setSelectedNodeId(newNode.id);
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
    let nextNumber = nextAvailableNodeNumber(workflowNodes);
    const usedNodeIds = new Set(workflowNodes.map((node) => node.id));

    for (const [index, file] of droppedFiles.entries()) {
      const droppedPath =
        window.goferDesktop?.getDroppedFilePath?.(file) ||
        file.path ||
        file.webkitRelativePath;
      if (!droppedPath) continue;

      let info = null;
      try {
        info = await window.goferDesktop?.getPathInfo?.(droppedPath);
      } catch (error) {
        console.error("Failed to inspect dropped path", error);
      }

      const path = info?.path ?? droppedPath;
      const kind = info?.isDirectory ? "folder" : "file";
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
      onWorkflowChange({
        ...workflow,
        nodes: [...workflowNodes, ...newNodes],
      });
      setSelectedNodeId(newNodes.at(-1).id);
    }
  }

  function deleteSelectedNode() {
    if (!selectedNode) return;
    deleteNode(selectedNode.id);
  }

  function deleteNode(nodeId) {
    onWorkflowChange({
      ...workflow,
      nodes: workflowNodes.filter((node) => node.id !== nodeId),
      edges: workflowEdges.filter(
        (edge) => edge.from !== nodeId && edge.to !== nodeId,
      ),
    });
    setSelectedNodeId((currentId) =>
      currentId === nodeId ? workflowNodes.find((node) => node.id !== nodeId)?.id : currentId,
    );
  }

  function handleNodePointerDown(event, nodeId) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    nodeDragMovedRef.current = false;
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setDraggingNodeId(nodeId);
  }

  function handleNodePointerMove(event, nodeId) {
    if (draggingNodeId !== nodeId) return;
    if (Math.abs(event.movementX) > 1 || Math.abs(event.movementY) > 1) {
      nodeDragMovedRef.current = true;
    }
    updateNode(nodeId, {
      x: nodesById[nodeId].x + event.movementX / viewport.scale,
      y: nodesById[nodeId].y + event.movementY / viewport.scale,
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
  }

  async function handleNodeDoubleClick(node) {
    if (nodeDragMovedRef.current) {
      nodeDragMovedRef.current = false;
      return;
    }

    if (node.type === "file") {
      const path = node.operation?.path;
      if (path) {
        try {
          await window.goferDesktop?.revealPath?.(path);
        } catch (error) {
          console.error("Failed to reveal file node path", error);
        }
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
          const listing = await window.goferDesktop?.listDirectory?.({
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
    if (event.button === 0) {
      setSelectedNodeId(undefined);
      setSelectedEdgeId(null);
    }

    if (event.button === 0 || event.button === 2) {
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-start border-b border-line bg-white px-6">
          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              accept=".toml"
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
              disabled={invalidWorkflow}
              title={
                workflowHasRunningRuns
                  ? "Start another workflow run"
                  : "Run workflow now"
              }
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
              onStopRun={onStopRunLog}
            />
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={invalidWorkflow}
              title="Add node"
              type="button"
              onClick={addNode}
            >
              <Plus size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="reset view"
              type="button"
              onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}
            >
              <LocateFixed size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={invalidWorkflow || !selectedNode}
              title="Delete selected node"
              type="button"
              onClick={deleteSelectedNode}
            >
              <Trash2 size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="Import workflow TOML"
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted opacity-50"
              disabled
              title="Export workflow"
              type="button"
            >
              <Download size={17} />
            </button>
            <div className="relative">
              <button
                className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                disabled={invalidWorkflow}
                title="Validate workflow"
                type="button"
                onClick={onValidateWorkflow}
              >
                <Check size={17} />
              </button>
              {notice?.message ? (
                <div
                  className={`validation-pop absolute left-2 top-11 z-40 min-w-[190px] rounded-lg border px-3 py-2 text-sm font-medium shadow-panel ${
                    notice.type === "error"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {notice.message}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div
          ref={canvasRef}
          className={`relative min-h-0 flex-1 overflow-hidden bg-[#f9fbfd] bg-[radial-gradient(circle_at_1px_1px,#d5dee8_1px,transparent_0)] [touch-action:none] ${
            panningPointerId ? "cursor-grabbing" : "cursor-default"
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
          <WorkflowTriggerStrip schedule={workflow.schedule} watch={workflow.watch} />
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
                  {workflowEdges.map((edge) => {
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
                            setSelectedEdgeId(edge.id);
                          }}
                        />
                        <path
                          d={geometry.path}
                          fill="none"
                          markerEnd="url(#arrowhead)"
                          stroke={selectedEdgeId === edge.id ? "#0f766e" : "#718096"}
                          strokeLinecap="round"
                          strokeWidth={selectedEdgeId === edge.id ? "4" : "2.5"}
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

              {workflowNodes.map((node) => (
                <WorkflowNode
                  key={node.id}
                  node={node}
                  selected={selectedNodeId === node.id}
                  status={nodeStatuses[node.id]}
                  expanded={Boolean(expandedFolderNodes[node.id])}
                  folderEntries={folderNodeEntries[node.id]}
                  onDelete={deleteNode}
                  onDoubleClick={handleNodeDoubleClick}
                  onConnectorPointerDown={handleConnectorPointerDown}
                  onConnectorPointerUp={handleConnectorPointerUp}
                  onPointerDown={handleNodePointerDown}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                />
              ))}
            </div>
          )}
        </div>
      </div>

        {!invalidWorkflow ? (
          <Inspector
            agents={workflow.agents ?? {}}
            edges={workflowEdges}
            collapsed={inspectorCollapsed}
            edge={selectedEdge}
            node={selectedNode}
            nodes={workflowNodes}
            workflow={workflow}
            width={inspectorWidth}
            onAddEdge={addEdge}
            onDeleteEdge={deleteEdge}
            onAgentChange={updateAgentConfig}
            onEdgeChange={updateEdge}
            onResizeStart={startInspectorResize}
            onNodeChange={(patch) => updateNode(selectedNode.id, patch)}
            onOperationChange={(patch) => updateNodeOperation(selectedNode.id, patch)}
            onSettingsChange={(patch) => updateNodeSettings(selectedNode.id, patch)}
            onToggleCollapsed={() => setInspectorCollapsed((current) => !current)}
            onTypeChange={(type) => updateNodeType(selectedNode.id, type)}
            onWorkflowChange={(patch) => onWorkflowChange({ ...workflow, ...patch })}
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
        selectedRunId={logState?.selectedRunId}
        text={displayedLog}
        title={logTitle}
        onResizeStart={startLogResize}
        onSelectRun={onSelectRunLog}
        onShowLatest={onLoadLatestLog}
        onStopRun={onStopRunLog}
        onToggle={() => setLogCollapsed((current) => !current)}
      />
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

  return (
    <div className="absolute inset-0 z-10 grid place-items-center p-6">
      <section className="flex max-h-[72%] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-red-200 bg-red-50/95 shadow-panel backdrop-blur dark:border-red-950 dark:bg-[#241b1b]/95">
        <div className="flex items-start justify-between gap-4 border-b border-red-200 px-4 py-3 dark:border-red-950">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">
              Invalid workflow TOML
            </h3>
            <p className="mt-1 truncate text-xs text-red-700/80 dark:text-red-200/70">
              {sourcePath}
            </p>
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

function WorkflowTriggerStrip({ schedule, watch }) {
  if (!schedule && !watch) return null;

  return (
    <div className="pointer-events-none absolute left-5 top-5 z-20 flex max-w-[calc(100%-40px)] flex-wrap gap-2">
      {schedule ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-white/90 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur dark:bg-[#252526]/95">
          <CalendarDays size={14} className="text-teal-600" />
          <span className="truncate">
            Starts on schedule: {schedule.cron_expression}
          </span>
        </div>
      ) : null}
      {watch ? (
        <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-white/90 px-3 py-2 text-xs font-medium text-ink shadow-sm backdrop-blur dark:bg-[#252526]/95">
          <FolderOpen size={14} className="text-teal-600" />
          <span className="truncate">
            Starts when files change: {watch.path}{watch.glob ? `/${watch.glob}` : ""}
            {watch.mode ? ` (${watch.mode})` : ""}
          </span>
        </div>
      ) : null}
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

function getNodeStatuses(nodes, runResult, logText) {
  const statuses = {};

  if (runResult?.nodeOutputs) {
    for (const [nodeId, output] of Object.entries(runResult.nodeOutputs)) {
      if (output.skipped) {
        statuses[nodeId] = "skipped";
      } else {
        statuses[nodeId] = output.success ? "success" : "error";
      }
    }
  }

  for (const node of nodes) {
    const logStatus = getNodeStatusFromLog(logText, node.id);
    if (logStatus) {
      statuses[node.id] = logStatus;
    }
  }

  return statuses;
}

function getNodeStatusFromLog(logText, nodeId) {
  if (!logText || !nodeId) return null;
  const nodeLines = extractNodeLog(logText, nodeId);
  if (!nodeLines) return null;

  if (nodeLines.includes("skipped")) return "skipped";
  const events = [
    ...nodeLines.matchAll(/(?:run \d+ )?attempt \d+ started/gi),
    ...nodeLines.matchAll(/(?:run \d+ )?attempt \d+ finished success=(true|false)/gi),
  ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const latestEvent = events.at(-1);
  if (!latestEvent) return null;
  if (latestEvent[0].includes("started")) {
    return "running";
  }
  return latestEvent[1].toLowerCase() === "true" ? "success" : "error";
}

function ToolbarRunSelector({
  onOpenChange,
  onSelectRun,
  onShowLatest,
  onStopRun,
  open,
  runs,
  selectedRunId,
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
    <div ref={menuRef} className="relative">
      <button
        className={`flex h-8 items-center gap-2 rounded-lg border px-2 text-xs font-medium transition ${
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
        <ChevronDown size={14} />
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
  runs = [],
  selectedRunId,
  onResizeStart,
  onSelectRun,
  onShowLatest,
  onStopRun,
  onToggle,
  text,
  title,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef(null);
  const displayText = error
    ? error
    : loading
      ? "Loading log..."
      : text?.trim()
        ? text.trim()
        : "No run log available.";

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
            <h2 className="truncate text-sm font-semibold">{title}</h2>
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
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="px-3 py-4 text-xs text-muted">No previous runs.</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="grid h-8 w-8 place-items-center rounded-md text-muted">
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </div>
      <pre
        className="workflow-scrollbar overflow-auto whitespace-pre-wrap bg-white px-4 py-3 font-mono text-xs leading-5 text-slate-700"
        style={{ height: Math.max(0, height - 44) }}
      >
        {displayText}
      </pre>
    </section>
  );
}

function RunStatusDot({ status }) {
  if (status === "running") {
    return <Loader2 className="shrink-0 animate-spin text-blue-500" size={13} />;
  }
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-red-500"
        : "bg-slate-400";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
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

function WorkflowNode({
  expanded,
  folderEntries,
  node,
  onConnectorPointerDown,
  onConnectorPointerUp,
  onDoubleClick,
  onDelete,
  selected,
  status,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}) {
  const style = nodeStyles[node.type] ?? nodeStyles.agent;
  const Icon = style.icon;
  const isFileNode = node.type === "file";
  const isFolderNode = node.type === "folder";
  const extension = isFileNode ? fileExtension(node.operation?.path) : "";
  const title = isFileNode
    ? "Double click to open"
    : isFolderNode
      ? "Double click to expand"
      : undefined;

  return (
    <article
      className={`absolute w-[220px] cursor-grab rounded-lg border bg-white p-3 shadow-node transition active:cursor-grabbing ${
        selected ? "border-teal-500 ring-4 ring-teal-100" : style.border
      }`}
      style={{ left: node.x, top: node.y }}
      title={title}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.(node);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        onPointerDown(event, node.id);
      }}
      onPointerMove={(event) => onPointerMove(event, node.id)}
      onPointerUp={(event) => onPointerUp(event, node.id)}
    >
      <button
        className="absolute -right-2 top-1/2 z-10 h-4 w-4 -translate-y-1/2 rounded-full border border-teal-300 bg-white shadow-sm transition hover:scale-110 hover:border-teal-500 hover:bg-teal-50"
        title="Drag to connect"
        type="button"
        onPointerDown={(event) => onConnectorPointerDown?.(event, node.id)}
        onPointerUp={(event) => onConnectorPointerUp?.(event, node.id)}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white ${style.accent}`}>
            <Icon size={18} />
            {extension ? (
              <span className="absolute -bottom-1 -right-1 rounded bg-white px-1 text-[8px] font-bold leading-3 text-slate-700 shadow-sm">
                {extension.slice(0, 4)}
              </span>
            ) : null}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{node.label}</h3>
            <p className="mt-1 truncate text-xs text-muted">{node.meta}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NodeStatusBadge status={status} />
          <button
            className="grid h-6 w-6 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
            title="Delete node"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(node.id);
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${style.chip}`}>
          {node.type}
        </span>
      </div>
      {isFolderNode && expanded ? (
        <FolderNodePreview state={folderEntries} />
      ) : null}
    </article>
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

  if (status === "running") {
    return <Loader2 size={13} className="animate-spin text-muted" />;
  }

  const className = {
    success: "bg-emerald-500",
    error: "bg-red-500",
    skipped: "border border-slate-400 bg-transparent",
  }[status];

  return <span className={`h-2.5 w-2.5 rounded-full ${className}`} />;
}

const edgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "On success"],
  ["on_failure", "On failure"],
  ["output_matches", "Output matches"],
];

const compactEdgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "Success"],
  ["on_failure", "Failure"],
  ["output_matches", "Matches"],
];

function Inspector({
  agents,
  collapsed,
  edge,
  edges,
  node,
  nodes,
  workflow,
  onAddEdge,
  onAgentChange,
  onDeleteEdge,
  onEdgeChange,
  onNodeChange,
  onOperationChange,
  onResizeStart,
  onSettingsChange,
  onToggleCollapsed,
  onTypeChange,
  onWorkflowChange,
  width,
}) {
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(!node && !edge);
  const [edgeInspectorOpen, setEdgeInspectorOpen] = useState(Boolean(edge));
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(Boolean(node));
  const [cronPickerOpen, setCronPickerOpen] = useState(false);
  const [draftEdge, setDraftEdge] = useState(null);
  const operation = node?.operation ?? defaultOperation(node?.type ?? "agent");
  const settings = { ...defaultSettings, ...(node?.settings ?? {}) };
  const agentConfig =
    operation.type === "agent" || operation.type === "common_llm_task"
      ? agents[operation.agent_id] ?? defaultAgentConfig(operation.agent_id || "agent")
      : null;
  const schedule = workflow.schedule ?? null;
  const watch = workflow.watch ?? null;
  const connectedEdges = node
    ? edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    : [];

  useEffect(() => {
    setWorkflowSettingsOpen(!node && !edge);
    setEdgeInspectorOpen(Boolean(edge));
    setNodeInspectorOpen(Boolean(node));
    setDraftEdge(null);
  }, [edge?.id, node?.id]);

  function updateWorkflowSchedule(patch) {
    const currentSchedule = schedule ?? { cron_expression: "0 9 * * *", timezone: "UTC" };
    const nextSchedule = { ...currentSchedule, ...patch };
    onWorkflowChange({ schedule: nextSchedule });
  }

  function updateWorkflowWatch(patch) {
    const currentWatch = watch ?? {
      path: ".",
      glob: "*",
      recursive: false,
      debounce_seconds: 1,
      mode: "batch",
      max_concurrency: 1,
    };
    onWorkflowChange({ watch: { ...currentWatch, ...patch } });
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
                <TextField label="Source path" value={workflow.sourcePath} readOnly />
              ) : null}
              <NumberField
                label="Max total node runs"
                min="1"
                value={workflow.maxTotalNodeRuns ?? 1000}
                onChange={(value) => onWorkflowChange({ maxTotalNodeRuns: value || 1000 })}
              />
            </InspectorSection>

            <InspectorSection title="Schedule">
              <ToggleField
                checked={Boolean(schedule)}
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
                    label="Cron expression"
                    value={schedule.cron_expression ?? ""}
                    onChange={(value) => updateWorkflowSchedule({ cron_expression: value })}
                    placeholder="0 9 * * *"
                    pickerOpen={cronPickerOpen}
                    onPickerOpenChange={setCronPickerOpen}
                  />
                  <TextField
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

            <InspectorSection title="File watcher">
              <ToggleField
                checked={Boolean(watch)}
                label="Watch files"
                onChange={(checked) =>
                  onWorkflowChange({
                    watch: checked
                      ? watch ?? {
                          path: ".",
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
                    label="Path"
                    value={watch.path ?? ""}
                    onChange={(value) => updateWorkflowWatch({ path: value })}
                    pathPicker
                    placeholder="."
                  />
                  <TextField
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
          </div>
        </InspectorPanel>

        {edge ? (
          <InspectorPanel
            open={edgeInspectorOpen}
            subtitle={`${edge.from} -> ${edge.to}`}
            title="Edge inspector"
            onToggle={() => setEdgeInspectorOpen((current) => !current)}
          >
            <div className="space-y-4 p-4">
              <InspectorSection title="Relationship">
                <SelectField
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
                    value={edge.outputPattern ?? ""}
                    onChange={(value) => onEdgeChange(edge.id, { outputPattern: value })}
                    placeholder="Regex pattern"
                  />
                ) : null}
              </InspectorSection>

              <InspectorSection title="Endpoints">
                <SelectField
                  label="Source"
                  value={edge.from}
                  options={nodes.map((candidate) => [
                    candidate.id,
                    candidate.label || candidate.id,
                  ])}
                  onChange={(value) => onEdgeChange(edge.id, { from: value })}
                />
                <SelectField
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
            title="Node inspector"
            onToggle={() => setNodeInspectorOpen((current) => !current)}
          >
            <div className="space-y-4 p-4">
          <InspectorSection title="Node">
            <TextField label="ID" value={node.id} readOnly />
            <TextField
              label="Label"
              value={node.label}
              onChange={(value) => onNodeChange({ label: value })}
            />
            <SelectField
              label="Type"
              value={node.type}
              options={[
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
              ]}
              onChange={onTypeChange}
            />
          </InspectorSection>

          <InspectorSection title="Execution">
            <ToggleField
              checked={Boolean(settings.pipeOutput)}
              label="Pipe output"
              onChange={(checked) => onSettingsChange({ pipeOutput: checked })}
            />
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

          {operation.type === "bash_command" ? (
            <InspectorSection title={commandNodeLabel}>
              <TextareaField
                label="Command"
                rows={4}
                value={operation.command ?? ""}
                onChange={(value) => onOperationChange({ command: value })}
              />
              <TextField
                label="Working directory"
                value={operation.working_dir ?? ""}
                onChange={(value) => onOperationChange({ working_dir: value })}
                pathPicker
                placeholder="."
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
                label="Script path"
                value={operation.script_path ?? ""}
                onChange={(value) => onOperationChange({ script_path: value })}
                pathPicker
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
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
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
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
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
                label="Source path"
                value={operation.source_path ?? ""}
                onChange={(value) => onOperationChange({ source_path: value })}
                pathPicker
              />
              <TextField
                label="Destination path"
                value={operation.destination_path ?? ""}
                onChange={(value) => onOperationChange({ destination_path: value })}
                pathPicker
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
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
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
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                placeholder="/absolute/path/to/file"
              />
            </InspectorSection>
          ) : null}

          {operation.type === "folder" ? (
            <InspectorSection title="Folder path">
              <TextField
                label="Path"
                value={operation.path ?? ""}
                onChange={(value) => onOperationChange({ path: value })}
                pathPicker
                placeholder="/absolute/path/to/folder"
              />
            </InspectorSection>
          ) : null}

          {operation.type === "open_resource" ? (
            <InspectorSection title="Open app / URL / file">
              <TextField
                label="Target"
                value={operation.target ?? ""}
                onChange={(value) => onOperationChange({ target: value })}
                pathPicker
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
                label="Output path"
                value={operation.output_path ?? ""}
                onChange={(value) => onOperationChange({ output_path: value })}
                pathPicker
              />
              <TextField
                label="Template path"
                value={operation.template_path ?? ""}
                onChange={(value) => onOperationChange({ template_path: value })}
                pathPicker
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
                  label="Working directory"
                  value={operation.working_dir ?? ""}
                  onChange={(value) => onOperationChange({ working_dir: value })}
                  pathPicker
                />
                <KeyValueField
                  label="Input mapping"
                  value={operation.input_mapping ?? {}}
                  onChange={(value) => onOperationChange({ input_mapping: value })}
                />
              </InspectorSection>
              <AgentConfigSection
                agentConfig={agentConfig}
                agentId={operation.agent_id}
                onAgentChange={onAgentChange}
              />
            </>
          ) : null}

          {operation.type === "local_vectorize" ? (
            <InspectorSection title="Local vector index">
              <TextField
                label="Source path"
                value={operation.source_path ?? ""}
                onChange={(value) => onOperationChange({ source_path: value })}
                pathPicker
              />
              <TextField
                label="Index path"
                value={operation.index_path ?? ""}
                onChange={(value) => onOperationChange({ index_path: value })}
                pathPicker
              />
              <TextField
                label="Glob"
                value={operation.glob ?? "**/*"}
                onChange={(value) => onOperationChange({ glob: value })}
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
          ) : null}

          {operation.type === "local_search" ? (
            <InspectorSection title="Local search">
              <TextField
                label="Index path"
                value={operation.index_path ?? ""}
                onChange={(value) => onOperationChange({ index_path: value })}
                pathPicker
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
            </InspectorSection>
          ) : null}

          {operation.type === "agent" ? (
            <>
              <InspectorSection title="Agent node">
                <TextField
                  label="Agent ID"
                  value={operation.agent_id ?? ""}
                  onChange={(value) => onOperationChange({ agent_id: value })}
                />
                <TextField
                  label="Prompt path"
                  value={operation.prompt_path ?? ""}
                  onChange={(value) => onOperationChange({ prompt_path: value })}
                  pathPicker
                  placeholder="Optional when using a skill"
                />
                <TextField
                  label="Skill name"
                  value={operation.skill_name ?? ""}
                  onChange={(value) => onOperationChange({ skill_name: value })}
                  placeholder="gofer-flow-workflow-builder"
                />
                <TextField
                  label="Working directory"
                  value={operation.working_dir ?? ""}
                  onChange={(value) => onOperationChange({ working_dir: value })}
                  pathPicker
                />
                <TextField
                  label="Dynamic count"
                  value={String(operation.dynamic_count ?? 1)}
                  onChange={(value) => onOperationChange({ dynamic_count: value })}
                />
                <KeyValueField
                  label="Input mapping"
                  value={operation.input_mapping ?? {}}
                  onChange={(value) => onOperationChange({ input_mapping: value })}
                />
              </InspectorSection>

              <InspectorSection title="Fan-out">
                <SelectField
                  label="Source"
                  value={operation.fan_source?.type ?? "none"}
                  options={[
                    ["none", "None"],
                    ["count", "Count"],
                    ["tabular", "Tabular file"],
                    ["directory", "Directory"],
                    ["trigger_events", "Trigger events"],
                  ]}
                  onChange={(value) =>
                    onOperationChange({
                      fan_source: value === "none" ? null : defaultFanSource(value),
                    })
                  }
                />
                {operation.fan_source?.type === "count" ? (
                  <TextField
                    label="Count"
                    value={String(operation.fan_source.count ?? 1)}
                    onChange={(value) =>
                      onOperationChange({
                        fan_source: { ...operation.fan_source, count: value },
                      })
                    }
                  />
                ) : null}
                {operation.fan_source?.type === "tabular" ? (
                  <TextField
                    label="Path"
                    value={operation.fan_source.path ?? ""}
                    onChange={(value) =>
                      onOperationChange({
                        fan_source: { ...operation.fan_source, path: value },
                      })
                    }
                    pathPicker
                  />
                ) : null}
                {operation.fan_source?.type === "directory" ? (
                  <>
                    <TextField
                      label="Path"
                      value={operation.fan_source.path ?? ""}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, path: value },
                        })
                      }
                      pathPicker
                    />
                    <TextField
                      label="Glob"
                      value={operation.fan_source.glob ?? "*"}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, glob: value },
                        })
                      }
                    />
                    <ToggleField
                      checked={Boolean(operation.fan_source.include_content)}
                      label="Include content"
                      onChange={(checked) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, include_content: checked },
                        })
                      }
                    />
                  </>
                ) : null}
                {operation.fan_source?.type === "trigger_events" ? (
                  <ToggleField
                    checked={Boolean(operation.fan_source.include_content)}
                    label="Include file content"
                    onChange={(checked) =>
                      onOperationChange({
                        fan_source: { ...operation.fan_source, include_content: checked },
                      })
                    }
                  />
                ) : null}
                {operation.fan_source ? (
                  <>
                    <NumberField
                      label="Max concurrency"
                      min="1"
                      value={operation.fan_source.max_concurrency ?? 16}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, max_concurrency: value },
                        })
                      }
                    />
                    <ToggleField
                      checked={Boolean(operation.fan_source.fail_fast)}
                      label="Fail fast"
                      onChange={(checked) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, fail_fast: checked },
                        })
                      }
                    />
                  </>
                ) : null}
              </InspectorSection>

              <InspectorSection title="Agent config">
                <AgentConfigFields
                  agentConfig={agentConfig}
                  agentId={operation.agent_id}
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
            </div>
          </InspectorPanel>
        ) : null}
      </div>
    </aside>
  );
}

function defaultFanSource(type) {
  switch (type) {
    case "count":
      return { type, count: 1, max_concurrency: 16, fail_fast: false };
    case "tabular":
      return { type, path: "data/input.csv", max_concurrency: 16, fail_fast: false };
    case "directory":
      return {
        type,
        path: "data",
        glob: "*",
        include_content: false,
        max_concurrency: 16,
        fail_fast: false,
      };
    case "trigger_events":
      return { type, include_content: false, max_concurrency: 16, fail_fast: false };
    default:
      return null;
  }
}

function ConnectedEdgeEditor({
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
          value={typeValue}
          options={draft ? [["", "Select"], ...compactEdgeConditionOptions] : compactEdgeConditionOptions}
          onChange={handleTypeChange}
        />
        <EdgeSelect
          value={edge.to}
          options={
            draft ? [...blankOption, ...nodesForTo(nodes)] : endpointOptions(nodes)
          }
          onChange={handleToChange}
        />
        <EdgeSelect
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

function AgentConfigSection({ agentConfig, agentId, onAgentChange }) {
  if (!agentConfig) return null;
  return (
    <InspectorSection title="Agent config">
      <AgentConfigFields
        agentConfig={agentConfig}
        agentId={agentId}
        onAgentChange={onAgentChange}
      />
    </InspectorSection>
  );
}

function AgentConfigFields({ agentConfig, agentId, onAgentChange }) {
  return (
    <>
      <SelectField
        label="Subscription"
        value={agentConfig.subscription}
        options={[
          ["codex", "Codex"],
          ["claude_code", "Claude Code"],
        ]}
        onChange={(value) => onAgentChange(agentId, { subscription: value })}
      />
      <TextField
        label="Prompt path"
        value={agentConfig.prompt_path ?? ""}
        onChange={(value) => onAgentChange(agentId, { prompt_path: value })}
        pathPicker
      />
      <TextField
        label="Working directory"
        value={agentConfig.working_dir ?? ""}
        onChange={(value) => onAgentChange(agentId, { working_dir: value })}
        pathPicker
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

function uniqueEdgeId(edges, fromNodeId, toNodeId) {
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

function edgeLabel(condition = "always", outputPattern = "") {
  if (condition === "always") return "always";
  if (condition === "output_matches" && outputPattern) return `matches ${outputPattern}`;
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

function InspectorSection({ children, title }) {
  return (
    <section className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function TextField({ label, onChange, pathPicker = false, placeholder, readOnly = false, value }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const canPickPath = pathPicker && !readOnly && typeof onChange === "function";

  async function handlePathPick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (window.goferDesktop?.listDirectory) {
      setPickerOpen(true);
      return;
    }

    try {
      const selectedPath = await window.goferDesktop?.selectPath?.({
        currentPath: value ?? "",
      });
      if (selectedPath) {
        onChange(selectedPath);
      }
    } catch (error) {
      console.error("Failed to select path", error);
    }
  }

  return (
    <>
      <label className="block">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="relative mt-1 block">
          <input
            className={`h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500 read-only:bg-slate-50 ${
              canPickPath ? "pr-10" : ""
            }`}
            placeholder={placeholder}
            readOnly={readOnly}
            value={value ?? ""}
            onChange={(event) => onChange?.(event.target.value)}
          />
          {canPickPath ? (
            <button
              aria-label={`Choose ${label.toLowerCase()}`}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-strong dark:hover:bg-[#2a2a2a]"
              title={`Choose ${label.toLowerCase()}`}
              type="button"
              onClick={handlePathPick}
            >
              <FolderOpen size={17} strokeWidth={1.9} />
            </button>
          ) : null}
        </span>
      </label>
      {pickerOpen ? (
        <PathPickerDialog
          currentPath={value ?? ""}
          label={label}
          onClose={() => setPickerOpen(false)}
          onSelect={(selectedPath) => {
            onChange(selectedPath);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function PathPickerDialog({ currentPath, label, onClose, onSelect }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [parent, setParent] = useState(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [selectedPath, setSelectedPath] = useState(currentPath ?? "");

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  async function loadDirectory(nextPath) {
    setLoading(true);
    setError("");
    try {
      const payload = await window.goferDesktop.listDirectory({
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
      await window.goferDesktop?.openPath?.(directory);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open path");
    }
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/35 px-4">
      <div className="flex max-h-[78vh] w-full max-w-[680px] flex-col rounded-lg border border-line bg-white shadow-panel">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-strong">Choose {label.toLowerCase()}</h2>
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
            disabled={!directory}
            type="button"
            onClick={() => onSelect(directory)}
          >
            Choose current folder
          </button>
        </div>

        <div className="min-h-[260px] flex-1 overflow-y-auto p-2">
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
                  onClick={() =>
                    entry.isDirectory ? loadDirectory(entry.path) : setSelectedPath(entry.path)
                  }
                >
                  <FolderOpen
                    className={entry.isDirectory ? "text-teal-600" : "text-muted"}
                    size={16}
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.hidden ? <span className="text-[11px] text-muted">hidden</span> : null}
                </button>
              ))
            : null}
        </div>

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

function InlineTextField({ onChange, placeholder, value }) {
  return (
    <input
      className="h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-teal-500"
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function CronExpressionField({
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

  return (
    <div className="relative">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="mt-1 flex h-10 overflow-hidden rounded-lg border border-line bg-white transition focus-within:border-teal-500">
        <input
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

function NumberField({ label, min, onChange, placeholder, step = "1", value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
        min={min}
        placeholder={placeholder}
        step={step}
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({ label, onChange, options, value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
    </label>
  );
}

function EdgeSelect({ onChange, options, value }) {
  const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? "";

  return (
    <select
      className="h-9 min-w-0 rounded-lg border border-line bg-white px-1.5 text-xs outline-none transition focus:border-teal-500"
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
  );
}

function TextareaField({ label, onChange, placeholder, rows = 3, value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <textarea
        className="mt-1 w-full resize-none rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-teal-500"
        placeholder={placeholder}
        rows={rows}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ToggleField({ checked, label, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        checked={checked}
        className="h-4 w-4 accent-teal-700"
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ListField({ label, onChange, placeholder, value }) {
  return (
    <TextareaField
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

function KeyValueField({ label, onChange, value }) {
  return (
    <TextareaField
      label={label}
      rows={3}
      value={objectToKeyValueText(value)}
      onChange={(text) => onChange(keyValueTextToObject(text))}
    />
  );
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
