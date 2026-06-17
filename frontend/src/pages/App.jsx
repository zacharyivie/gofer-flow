import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  GitBranch,
  ListFilter,
  Loader2,
  MessageSquare,
  Moon,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sun,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import DagCanvas, { PathPickerDialog } from "../components/DagCanvas.jsx";
import { apiUrl } from "../lib/api.js";

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState();
  const [query, setQuery] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [loadState, setLoadState] = useState({ loading: true, error: "" });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createState, setCreateState] = useState({ saving: false, error: "" });
  const [dataDirPickerOpen, setDataDirPickerOpen] = useState(false);
  const [dirtyWorkflow, setDirtyWorkflow] = useState();
  const [saveState, setSaveState] = useState({ saving: false, error: "" });
  const [topBarNotice, setTopBarNotice] = useState({ type: "", message: "" });
  const [runState, setRunState] = useState({ running: false, error: "", result: null });
  const [logState, setLogState] = useState({
    loading: false,
    error: "",
    text: "",
    path: null,
    runs: [],
    selectedRunId: null,
  });
  const [theme, setTheme] = useState(getInitialTheme);
  const [workflowPaneWidth, setWorkflowPaneWidth] = useState(292);
  const [chatPaneWidth, setChatPaneWidth] = useState(356);
  const saveRevisionRef = useRef(0);
  const dirtyWorkflowRef = useRef();
  const deletedWorkflowIdsRef = useRef(new Set());
  const logRequestRef = useRef(0);
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];

  const loadWorkflows = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoadState({ loading: true, error: "" });
    }
    try {
      const response = await fetch(apiUrl("/workflows"));
      if (!response.ok) {
        throw new Error(`Workflow API returned ${response.status}`);
      }
      const payload = await response.json();
      const nextWorkflows = (payload.workflows ?? [])
        .filter((workflow) => !deletedWorkflowIdsRef.current.has(workflow.id))
        .map(summarizeWorkflow);
      setWorkflows((current) => {
        const refreshedWorkflows = nextWorkflows.map((workflow) => {
          const localWorkflow = current.find((candidate) => candidate.id === workflow.id);
          return localWorkflow
            ? summarizeWorkflow(mergeSavedWorkflow(localWorkflow, workflow))
            : workflow;
        });
        const dirtyWorkflowId = dirtyWorkflowRef.current?.id;
        const localDirtyWorkflow = dirtyWorkflowId && !deletedWorkflowIdsRef.current.has(dirtyWorkflowId)
          ? current.find((workflow) => workflow.id === dirtyWorkflowId)
          : null;
        const mergedWorkflows =
          silent && localDirtyWorkflow
            ? preserveLocalWorkflow(refreshedWorkflows, localDirtyWorkflow)
            : refreshedWorkflows;

        return silent && JSON.stringify(current) === JSON.stringify(mergedWorkflows)
          ? current
          : mergedWorkflows;
      });
      setDataDir(payload.dataDir ?? "");
      setActiveWorkflowId((currentId) => {
        if (nextWorkflows.some((workflow) => workflow.id === currentId)) {
          return currentId;
        }
        return nextWorkflows[0]?.id;
      });
      setLoadState({ loading: false, error: "" });
    } catch (error) {
      if (!silent) {
        setLoadState({
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflows",
        });
      }
    }
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadWorkflows({ silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [loadWorkflows]);

  useEffect(() => {
    window.localStorage.setItem("gofer-ui-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!topBarNotice.message) return undefined;

    const timeoutId = window.setTimeout(() => {
      setTopBarNotice({ type: "", message: "" });
    }, 3500);

    return () => window.clearTimeout(timeoutId);
  }, [topBarNotice.message]);

  const loadLatestLog = useCallback(async (workflowId, { silent = false } = {}) => {
    const requestId = logRequestRef.current + 1;
    logRequestRef.current = requestId;
    if (!silent) {
      setLogState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs/latest`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (requestId !== logRequestRef.current) return;
      const nextText = payload.log?.logText ?? "";
      const nextPath = payload.log?.logPath ?? null;
      setLogState((current) => {
        if (
          current.text === nextText &&
          current.path === nextPath &&
          current.error === "" &&
          current.loading === false
        ) {
          return current;
        }
        return {
          loading: false,
          error: "",
          text: nextText,
          path: nextPath,
          runs: current.runs,
          selectedRunId: null,
        };
      });
    } catch (error) {
      if (requestId !== logRequestRef.current) return;
      if (!silent) {
        setLogState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflow log",
        }));
      }
    }
  }, []);

  const loadRunLogs = useCallback(async (workflowId, { silent = false } = {}) => {
    try {
      const response = await fetch(apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs`));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setLogState((current) => {
        const nextRuns = payload.runs ?? [];
        if (silent && JSON.stringify(current.runs) === JSON.stringify(nextRuns)) {
          return current;
        }
        return { ...current, runs: nextRuns };
      });
    } catch (error) {
      if (!silent) {
        setLogState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load workflow runs",
        }));
      }
    }
  }, []);

  const loadRunLog = useCallback(async (workflowId, runId) => {
    const requestId = logRequestRef.current + 1;
    logRequestRef.current = requestId;
    setLogState((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedRunId: runId,
    }));
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs/${encodeURIComponent(runId)}`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (requestId !== logRequestRef.current) return;
      setLogState((current) => ({
        ...current,
        loading: false,
        error: "",
        text: payload.log?.logText ?? "",
        path: payload.log?.logPath ?? null,
        selectedRunId: runId,
      }));
    } catch (error) {
      if (requestId !== logRequestRef.current) return;
      setLogState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Unable to load workflow run",
      }));
    }
  }, []);

  useEffect(() => {
    if (!activeWorkflow?.id) {
      setLogState({
        loading: false,
        error: "",
        text: "",
        path: null,
        runs: [],
        selectedRunId: null,
      });
      return;
    }

    loadLatestLog(activeWorkflow.id);
    loadRunLogs(activeWorkflow.id);
  }, [activeWorkflow?.id, loadLatestLog, loadRunLogs]);

  useEffect(() => {
    if (!activeWorkflow?.id) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      if (!logState.selectedRunId) {
        loadLatestLog(activeWorkflow.id, { silent: true });
      }
      loadRunLogs(activeWorkflow.id, { silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [activeWorkflow?.id, loadLatestLog, loadRunLogs, logState.selectedRunId]);

  useEffect(() => {
    if (!dirtyWorkflow) return undefined;

    const workflow = workflows.find((candidate) => candidate.id === dirtyWorkflow.id);
    if (!workflow) return undefined;

    const timeoutId = window.setTimeout(() => {
      saveWorkflow(workflow, dirtyWorkflow.revision);
    }, 650);

    return () => window.clearTimeout(timeoutId);
  }, [dirtyWorkflow, workflows]);

  const filteredWorkflows = useMemo(() => {
    return workflows.filter((workflow) => {
      const text = `${workflow.name} ${workflow.description} ${workflow.tags.join(" ")}`;
      return text.toLowerCase().includes(query.toLowerCase());
    });
  }, [query, workflows]);

  function updateActiveWorkflow(nextWorkflow) {
    const summarizedWorkflow = summarizeWorkflow(nextWorkflow);
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === summarizedWorkflow.id ? summarizedWorkflow : workflow,
      ),
    );
    saveRevisionRef.current += 1;
    const nextDirtyWorkflow = { id: summarizedWorkflow.id, revision: saveRevisionRef.current };
    dirtyWorkflowRef.current = nextDirtyWorkflow;
    setDirtyWorkflow(nextDirtyWorkflow);
  }

  async function saveWorkflow(workflow, revision) {
    setSaveState({ saving: true, error: "" });
    try {
      const savedWorkflow = await persistWorkflow(workflow);

      if (saveRevisionRef.current === revision) {
        setWorkflows((current) =>
          current.map((candidate) =>
            candidate.id === savedWorkflow.id
              ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow))
              : candidate,
          ),
        );
        if (dirtyWorkflowRef.current?.id === workflow.id) {
          dirtyWorkflowRef.current = undefined;
        }
        setDirtyWorkflow((current) => (current?.id === workflow.id ? undefined : current));
        setSaveState({ saving: false, error: "" });
      }
    } catch (error) {
      if (saveRevisionRef.current === revision) {
        setSaveState({
          saving: false,
          error: error instanceof Error ? error.message : "Unable to save workflow",
        });
      }
    }
  }

  async function persistWorkflow(workflow) {
    const response = await fetch(
      apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(workflow),
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Workflow API returned ${response.status}`);
    }
    return payload.workflow;
  }

  async function runWorkflowNow(workflow) {
    const workflowToRun = summarizeWorkflow(workflow);
    saveRevisionRef.current += 1;
    dirtyWorkflowRef.current = undefined;
    setDirtyWorkflow(undefined);
    setRunState({ running: true, workflowId: workflowToRun.id, error: "", result: null });
    setLogState((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedRunId: null,
    }));
    setSaveState({ saving: true, error: "" });

    try {
      const savedWorkflow = await persistWorkflow(workflowToRun);
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === savedWorkflow.id
            ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow))
            : candidate,
        ),
      );
      setSaveState({ saving: false, error: "" });

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(savedWorkflow.id)}/run`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ dryRun: false }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, workflowId: savedWorkflow.id, error: "", result: payload.run });
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === savedWorkflow.id
            ? {
                ...candidate,
                status: payload.run?.success ? "Success" : "Error",
                tags: [
                  payload.run?.success ? "success" : "error",
                  ...(candidate.tags ?? []).slice(1),
                ],
              }
            : candidate,
        ),
      );
      setLogState({
        loading: false,
        error: "",
        text: payload.run?.logText ?? "",
        path: payload.run?.logPath ?? null,
        runs: logState.runs,
        selectedRunId: null,
      });
      loadRunLogs(savedWorkflow.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, workflowId: workflowToRun.id, error: message, result: null });
      setSaveState((current) => ({ ...current, saving: false }));
      loadLatestLog(workflowToRun.id, { silent: true });
      loadRunLogs(workflowToRun.id, { silent: true });
    }
  }

  async function stopWorkflowRun(workflow) {
    if (!workflow?.id || !runState.running || runState.workflowId !== workflow.id) return;

    setRunState((current) => ({ ...current, stopping: true }));
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/stop`),
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setTopBarNotice({
        type: payload.stopped ? "success" : "error",
        message: payload.stopped ? "Stopping workflow run..." : payload.message || "No active run",
      });
    } catch (error) {
      setRunState((current) => ({ ...current, stopping: false }));
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to stop workflow run",
      });
    }
  }

  async function createWorkflow(name) {
    setCreateState({ saving: true, error: "" });
    try {
      const response = await fetch(apiUrl("/workflows"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const nextWorkflow = summarizeWorkflow(payload.workflow);
      deletedWorkflowIdsRef.current.delete(nextWorkflow.id);
      setWorkflows((current) => [...current, nextWorkflow]);
      setActiveWorkflowId(nextWorkflow.id);
      setQuery("");
      setCreateDialogOpen(false);
      setCreateState({ saving: false, error: "" });
    } catch (error) {
      setCreateState({
        saving: false,
        error: error instanceof Error ? error.message : "Unable to create workflow",
      });
    }
  }

  async function validateWorkflow(workflow) {
    try {
      await persistWorkflow(summarizeWorkflow(workflow));
      setTopBarNotice({ type: "success", message: "Workflow is valid" });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Workflow validation failed",
      });
    }
  }

  async function importWorkflow(file) {
    if (!file) return;
    try {
      const content = await file.text();
      const response = await fetch(apiUrl("/workflows/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, filename: file.name }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const nextWorkflow = summarizeWorkflow(payload.workflow);
      deletedWorkflowIdsRef.current.delete(nextWorkflow.id);
      setWorkflows((current) => [...current, nextWorkflow]);
      setActiveWorkflowId(nextWorkflow.id);
      setTopBarNotice({ type: "success", message: `Imported ${nextWorkflow.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to import workflow",
      });
    }
  }

  async function deleteWorkflow(workflow) {
    if (!workflow) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;

    try {
      deletedWorkflowIdsRef.current.add(workflow.id);
      saveRevisionRef.current += 1;
      if (dirtyWorkflowRef.current?.id === workflow.id) {
        dirtyWorkflowRef.current = undefined;
      }
      setDirtyWorkflow((current) => (current?.id === workflow.id ? undefined : current));
      setSaveState((current) => ({ ...current, saving: false }));
      window.localStorage.removeItem(`gofer-flow-chat:${workflow.id}`);
      setRunState((current) =>
        current.workflowId === workflow.id
          ? { running: false, error: "", result: null }
          : current,
      );
      setLogState((current) =>
        activeWorkflow?.id === workflow.id
          ? {
              loading: false,
              error: "",
              text: "",
              path: null,
              runs: [],
              selectedRunId: null,
            }
          : current,
      );

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`),
        {
          method: "DELETE",
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const remainingWorkflows = workflows.filter((candidate) => candidate.id !== workflow.id);
      setWorkflows((current) => current.filter((candidate) => candidate.id !== workflow.id));
      setActiveWorkflowId((currentId) =>
        currentId === workflow.id ? remainingWorkflows[0]?.id : currentId,
      );
      setTopBarNotice({ type: "success", message: `Deleted ${workflow.name}` });
    } catch (error) {
      deletedWorkflowIdsRef.current.delete(workflow.id);
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to delete workflow",
      });
    }
  }

  async function changeDataDir(nextDataDir) {
    if (!window.goferDesktop?.setDataDir) {
      setTopBarNotice({
        type: "error",
        message: "Changing the app data folder is only available in the desktop app",
      });
      return;
    }

    try {
      setDataDirPickerOpen(false);
      setTopBarNotice({ type: "success", message: "Switching app data folder..." });
      await window.goferDesktop.setDataDir(nextDataDir);
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to change app data folder",
      });
    }
  }

  return (
    <main className={`flex h-screen min-h-[720px] min-w-[1180px] bg-canvas text-ink ${theme}`}>
      <WorkflowSidebar
        activeWorkflowId={activeWorkflow?.id}
        dataDir={dataDir}
        loading={loadState.loading}
        query={query}
        runState={runState}
        workflows={filteredWorkflows}
        width={workflowPaneWidth}
        onQueryChange={setQuery}
        onCreate={() => setCreateDialogOpen(true)}
        onDataDirPick={() => setDataDirPickerOpen(true)}
        onDeleteWorkflow={deleteWorkflow}
        onRefresh={loadWorkflows}
        onResizeStart={(event) =>
          startPaneResize(event, {
            max: 420,
            min: 240,
            side: "right",
            width: workflowPaneWidth,
            onResize: setWorkflowPaneWidth,
          })
        }
        onSelect={setActiveWorkflowId}
      />

      <section className="flex min-w-0 flex-1 flex-col border-x border-line bg-[#f9fbfd]">
        {activeWorkflow ? (
          <>
            <TopBar
              theme={theme}
              workflow={activeWorkflow}
              onToggleTheme={() =>
                setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))
              }
            />
            <DagCanvas
              logState={logState}
              notice={topBarNotice}
              runState={runState}
              workflow={activeWorkflow}
              onLoadLatestLog={() => loadLatestLog(activeWorkflow.id)}
              onSelectRunLog={(runId) => loadRunLog(activeWorkflow.id, runId)}
              onImportWorkflow={importWorkflow}
              onRunWorkflow={runWorkflowNow}
              onValidateWorkflow={() => validateWorkflow(activeWorkflow)}
              onStopWorkflow={stopWorkflowRun}
              onWorkflowChange={updateActiveWorkflow}
            />
          </>
        ) : (
          <EmptyWorkspace error={loadState.error} loading={loadState.loading} onRefresh={loadWorkflows} />
        )}
      </section>

      <ChatPane
        width={chatPaneWidth}
        workflow={activeWorkflow}
        onResizeStart={(event) =>
          startPaneResize(event, {
            max: 520,
            min: 300,
            side: "left",
            width: chatPaneWidth,
            onResize: setChatPaneWidth,
          })
        }
      />
      <CreateWorkflowDialog
        error={createState.error}
        open={createDialogOpen}
        saving={createState.saving}
        onClose={() => {
          if (!createState.saving) {
            setCreateDialogOpen(false);
            setCreateState({ saving: false, error: "" });
          }
        }}
        onCreate={createWorkflow}
      />
      {dataDirPickerOpen ? (
        <PathPickerDialog
          currentPath={dataDir}
          label="app data folder"
          onClose={() => setDataDirPickerOpen(false)}
          onSelect={changeDataDir}
        />
      ) : null}
    </main>
  );
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function startPaneResize(event, { max, min, onResize, side, width }) {
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function handlePointerMove(moveEvent) {
    const delta = moveEvent.clientX - startX;
    const nextWidth = side === "left" ? startWidth - delta : startWidth + delta;
    onResize(clampNumber(nextWidth, min, max));
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

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const savedTheme = window.localStorage.getItem("gofer-ui-theme");
  if (savedTheme === "dark" || savedTheme === "light") {
    return savedTheme;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function summarizeWorkflow(workflow) {
  const agentCount = agentIdsForWorkflow(workflow).length;
  const operationTypes = [...new Set((workflow.nodes ?? []).map((node) => node.type))].sort();
  const status = workflow.status ?? "Ready";
  return {
    ...workflow,
    description: `${workflow.nodes.length} nodes, ${workflow.edges.length} edges, ${agentCount} agents.${
      workflow.schedule ? ` Scheduled with ${workflow.schedule.cron_expression}.` : ""
    }${workflow.watch ? ` Watching ${workflow.watch.path}.` : ""
    }`,
    status,
    tags: [status.toLowerCase(), ...operationTypes.slice(0, 2)],
  };
}

function agentIdsForWorkflow(workflow) {
  return [
    ...new Set(
      (workflow.nodes ?? [])
        .filter((node) => node.type === "agent")
        .map((node) => node.operation?.agent_id)
        .filter(Boolean),
    ),
  ];
}

function mergeSavedWorkflow(localWorkflow, savedWorkflow) {
  const localNodesById = Object.fromEntries(
    (localWorkflow.nodes ?? []).map((node) => [node.id, node]),
  );
  return {
    ...localWorkflow,
    ...savedWorkflow,
    nodes: (savedWorkflow.nodes ?? []).map((node) => ({
      ...node,
      x: localNodesById[node.id]?.x ?? node.x,
      y: localNodesById[node.id]?.y ?? node.y,
      label: localNodesById[node.id]?.label ?? node.label,
    })),
  };
}

function preserveLocalWorkflow(remoteWorkflows, localWorkflow) {
  const foundWorkflow = remoteWorkflows.some((workflow) => workflow.id === localWorkflow.id);
  if (!foundWorkflow) {
    return [...remoteWorkflows, localWorkflow];
  }
  return remoteWorkflows.map((workflow) =>
    workflow.id === localWorkflow.id
      ? summarizeWorkflow({
          ...localWorkflow,
          sourcePath: workflow.sourcePath ?? localWorkflow.sourcePath,
          status: workflow.status ?? localWorkflow.status,
          updatedAt: workflow.updatedAt ?? localWorkflow.updatedAt,
        })
      : workflow,
  );
}

function WorkflowSidebar({
  activeWorkflowId,
  dataDir,
  loading,
  query,
  runState,
  workflows,
  onCreate,
  onDataDirPick,
  onDeleteWorkflow,
  onQueryChange,
  onRefresh,
  onResizeStart,
  onSelect,
  width,
}) {
  const [dataDirCopied, setDataDirCopied] = useState(false);

  async function copyDataDir() {
    if (!dataDir) return;

    try {
      await navigator.clipboard.writeText(dataDir);
      setDataDirCopied(true);
      window.setTimeout(() => setDataDirCopied(false), 1400);
    } catch {
      // Clipboard failures are non-critical; the path remains visible for manual copy.
    }
  }

  async function openDataDir() {
    if (!dataDir) return;
    await window.goferDesktop?.openPath?.(dataDir);
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-white"
      style={{ width }}
    >
      <div
        className="absolute right-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
        role="separator"
        title="Resize workflows pane"
        onPointerDown={onResizeStart}
      />
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white">
              <Waypoints size={20} />
            </span>
            <div>
              <h1 className="text-base font-semibold leading-tight">Gofer Flow</h1>
              <p className="text-xs text-muted">Workflow studio</p>
            </div>
          </div>
          <button
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:border-slate-300 hover:text-ink"
            title="Refresh workflows"
            type="button"
            onClick={onRefresh}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </button>
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2">
          <Search size={16} className="text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            placeholder="Search workflows"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListFilter size={16} className="text-muted" />
          Workflows
        </div>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
          title="Create workflow"
          type="button"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="workflow-scrollbar flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {workflows.length ? (
          workflows.map((workflow) => (
            <WorkflowListItem
              key={workflow.id}
              active={workflow.id === activeWorkflowId}
              status={
                runState?.running && runState.workflowId === workflow.id
                  ? "Running"
                  : workflow.status
              }
              workflow={workflow}
              onDelete={() => onDeleteWorkflow(workflow)}
              onSelect={() => onSelect(workflow.id)}
            />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-line bg-slate-50 p-4 text-sm leading-6 text-muted">
            {loading ? "Loading workflows..." : "No workflows found."}
          </div>
        )}
      </div>

      {dataDir ? (
        <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs leading-5 text-muted">
          <button
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-ink dark:hover:bg-[#2a2a2a]"
            title={dataDirCopied ? "Copied" : "Copy app data folder path"}
            type="button"
            onClick={copyDataDir}
          >
            {dataDirCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            className="min-w-0 flex-1 truncate text-left text-teal-700 underline-offset-2 transition hover:text-teal-800 hover:underline"
            title={dataDir}
            type="button"
            onClick={openDataDir}
          >
            {dataDir}
          </button>
          <button
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-ink dark:hover:bg-[#2a2a2a]"
            title="Change app data folder"
            type="button"
            onClick={onDataDirPick}
          >
            <FolderOpen size={15} />
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function WorkflowListItem({ active, onDelete, onSelect, status, workflow }) {
  const menuRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event) {
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  return (
    <div
      className={`group relative w-full rounded-lg border text-left transition ${
        active
          ? "border-teal-200 bg-teal-50 shadow-sm"
          : "border-transparent bg-white hover:border-line hover:bg-slate-50"
      }`}
    >
      <button
        className="w-full rounded-lg p-3 pr-10 text-left"
        type="button"
        onClick={onSelect}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{workflow.name}</p>
            <p className="text-clamp-2 mt-1 text-xs leading-5 text-muted">
              {workflow.description}
            </p>
          </div>
          <StatusDot status={status} />
        </div>
      </button>
      <div ref={menuRef} className="absolute right-2 top-2">
        <button
          className="grid h-7 w-7 place-items-center rounded-md text-muted opacity-70 transition hover:bg-slate-100 hover:text-ink group-hover:opacity-100 dark:hover:bg-[#2a2a2a]"
          title="Workflow actions"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((current) => !current);
          }}
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-8 z-40 w-44 rounded-lg border border-line bg-white p-1 shadow-panel">
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50 dark:hover:bg-[#3a2424]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2 size={15} />
              Delete workflow
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TopBar({
  theme,
  workflow,
  onToggleTheme,
}) {
  return (
    <header className="flex h-[62px] shrink-0 items-center justify-between bg-white px-6 pt-1">
      <div className="min-w-0 pt-1">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
          <GitBranch size={14} />
          Visual workflow editor
        </div>
        <div className="mt-0.5 flex items-center gap-3">
          <h2 className="truncate text-[19px] font-semibold">{workflow.name}</h2>
          <span className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted">
            {workflow.nodes.length} nodes
          </span>
          <span className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted">
            {workflow.edges.length} edges
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          type="button"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}

function ChatPane({ onResizeStart, width, workflow }) {
  const chatScrollRef = useRef(null);
  const conversationMenuRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState("codex");
  const [model, setModel] = useState("cli-default");
  const [chatStateByWorkflow, setChatStateByWorkflow] = useState({});
  const [showTypingByWorkflow, setShowTypingByWorkflow] = useState({});
  const [typingDelayByWorkflow, setTypingDelayByWorkflow] = useState({});
  const [expandedThoughtGroups, setExpandedThoughtGroups] = useState({});
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const workflowName = workflow?.name ?? "No workflow selected";
  const workflowId = workflow?.id ?? "no-workflow";
  const chatStorageKey = chatStorageKeyFor(workflowId);
  const [messagesByWorkflow, setMessagesByWorkflow] = useState({});
  const messages = messagesByWorkflow[workflowId] ?? loadChatMessages(chatStorageKey);
  const chatState = chatStateByWorkflow[workflowId] ?? { sending: false, error: "" };
  const showTypingIndicator = Boolean(showTypingByWorkflow[workflowId]);
  const typingDelayKey = typingDelayByWorkflow[workflowId] ?? 0;
  const chatItems = useMemo(() => buildChatItems(messages), [messages]);

  useEffect(() => {
    async function loadProviders() {
      try {
        const response = await fetch(apiUrl("/chat/providers"));
        if (!response.ok) return;
        const payload = await response.json();
        const nextProviders = payload.providers ?? [];
        setProviders(nextProviders);
        const availableProvider = nextProviders.find((provider) => provider.available);
        if (availableProvider) {
          setProviderId(availableProvider.id);
          setModel(availableProvider.models?.[0] ?? "cli-default");
        }
      } catch {
        setProviders([]);
      }
    }
    loadProviders();
  }, []);

  useEffect(() => {
    setMessagesByWorkflow((current) =>
      current[workflowId]
        ? current
        : { ...current, [workflowId]: loadChatMessages(chatStorageKey) },
    );
    setDraft("");
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);
  }, [chatStorageKey, workflowId]);

  useEffect(() => {
    if (!chatState.sending) {
      setShowTypingByWorkflow((current) => ({ ...current, [workflowId]: false }));
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setShowTypingByWorkflow((current) => ({ ...current, [workflowId]: true }));
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [chatState.sending, typingDelayKey, workflowId]);

  useEffect(() => {
    if (!conversationMenuOpen) return undefined;

    function handlePointerDown(event) {
      if (conversationMenuRef.current?.contains(event.target)) return;
      setConversationMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [conversationMenuOpen]);

  useEffect(() => {
    if (!showTypingIndicator) return;

    window.requestAnimationFrame(() => {
      scrollElementIntoView("typing-indicator");
    });
  }, [showTypingIndicator]);

  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ??
    providers[0] ?? {
      id: "codex",
      name: "Codex",
      available: true,
      models: ["cli-default"],
    };

  async function sendMessage() {
    const text = draft.trim();
    if (!text || chatState.sending) return;
    const targetWorkflow = workflow;
    const targetWorkflowId = workflowId;
    const targetStorageKey = chatStorageKeyFor(targetWorkflowId);
    const targetMessages = messagesByWorkflow[targetWorkflowId] ?? loadChatMessages(targetStorageKey);

    const userMessage = {
      id: uniqueClientId(),
      role: "user",
      body: text,
    };
    const nextMessages = [...targetMessages, userMessage];
    updateWorkflowMessages(targetWorkflowId, nextMessages);
    setDraft("");
    setChatStateByWorkflow((current) => ({
      ...current,
      [targetWorkflowId]: { sending: true, error: "" },
    }));
    const thoughtGroupId = uniqueClientId();
    window.requestAnimationFrame(() => {
      scrollMessageNearTop(userMessage.id);
    });

    function appendAssistantMessage(body, kind = "final", extra = {}) {
      const assistantMessageId = uniqueClientId();
      updateWorkflowMessages(targetWorkflowId, (current) => [
        ...current,
        {
          id: assistantMessageId,
          role: "assistant",
          kind,
          body,
          ...extra,
        },
      ]);
      window.requestAnimationFrame(() => {
        scrollElementIntoView(
          kind === "thought" && extra.groupId
            ? `thought-group-${extra.groupId}`
            : assistantMessageId,
        );
      });
    }

    function restartTypingDelay() {
      setShowTypingByWorkflow((current) => ({ ...current, [targetWorkflowId]: false }));
      setTypingDelayByWorkflow((current) => ({
        ...current,
        [targetWorkflowId]: (current[targetWorkflowId] ?? 0) + 1,
      }));
    }

    try {
      const response = await fetch(apiUrl("/chat/stream"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: providerId,
          model,
          messages: nextMessages.map(({ role, body }) => ({ role, body })),
          workflow: targetWorkflow,
        }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Chat API did not provide a response stream");
      }

      let finalReceived = false;
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseChatStreamEvent(line);
            if (!event) continue;

            if (event.type === "thought") {
              const thought = String(event.text ?? "").trim();
              if (!thought) continue;
              appendAssistantMessage(thought, "thought", { groupId: thoughtGroupId });
              restartTypingDelay();
            } else if (event.type === "final") {
              finalReceived = true;
              const body = event.message?.body ?? "";
              if (body.trim()) {
                appendAssistantMessage(body, "final");
              }
            } else if (event.type === "error") {
              throw new Error(event.error || "Workflow assistant failed");
            }
          }
        }
        if (done) break;
      }

      if (buffer.trim()) {
        const event = parseChatStreamEvent(buffer);
        if (event?.type === "final") {
          finalReceived = true;
          const body = event.message?.body ?? "";
          if (body.trim()) appendAssistantMessage(body, "final");
        } else if (event?.type === "error") {
          throw new Error(event.error || "Workflow assistant failed");
        }
      }

      if (!finalReceived) {
        throw new Error("Workflow assistant stream ended without a final response");
      }
      setChatStateByWorkflow((current) => ({
        ...current,
        [targetWorkflowId]: { sending: false, error: "" },
      }));
    } catch (error) {
      setChatStateByWorkflow((current) => ({
        ...current,
        [targetWorkflowId]: {
          sending: false,
          error: error instanceof Error ? error.message : "Unable to send message",
        },
      }));
    }
  }

  function updateWorkflowMessages(targetWorkflowId, nextValue) {
    setMessagesByWorkflow((current) => {
      const currentMessages =
        current[targetWorkflowId] ?? loadChatMessages(chatStorageKeyFor(targetWorkflowId));
      const nextMessages =
        typeof nextValue === "function" ? nextValue(currentMessages) : nextValue;
      window.localStorage.setItem(
        chatStorageKeyFor(targetWorkflowId),
        JSON.stringify(nextMessages),
      );
      return { ...current, [targetWorkflowId]: nextMessages };
    });
  }

  async function deleteConversation() {
    const defaultMessages = defaultChatMessages();
    window.localStorage.setItem(chatStorageKeyFor(workflowId), JSON.stringify(defaultMessages));
    setMessagesByWorkflow((current) => ({ ...current, [workflowId]: defaultMessages }));
    setDraft("");
    setChatStateByWorkflow((current) => ({
      ...current,
      [workflowId]: { sending: false, error: "" },
    }));
    setShowTypingByWorkflow((current) => ({ ...current, [workflowId]: false }));
    setTypingDelayByWorkflow((current) => ({ ...current, [workflowId]: 0 }));
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);

    if (!workflow?.id) return;

    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/chat`),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
    } catch (error) {
      setChatStateByWorkflow((current) => ({
        ...current,
        [workflowId]: {
          sending: false,
          error: error instanceof Error ? error.message : "Unable to delete chat handoff file",
        },
      }));
    }
  }

  function scrollMessageNearTop(messageId) {
    const scrollContainer = chatScrollRef.current;
    const messageElement = scrollContainer?.querySelector(`[data-message-id="${messageId}"]`);
    if (!scrollContainer || !messageElement) return;

    scrollContainer.scrollTo({
      top: messageElement.offsetTop - 12,
      behavior: "smooth",
    });
  }

  function scrollElementIntoView(elementId) {
    const scrollContainer = chatScrollRef.current;
    const element = scrollContainer?.querySelector(`[data-message-id="${elementId}"]`);
    if (!scrollContainer || !element) return;

    element.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-line bg-white"
      style={{ width }}
    >
      <div
        className="absolute left-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
        role="separator"
        title="Resize chat pane"
        onPointerDown={onResizeStart}
      />
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-lg bg-slate-900 text-white">
            {chatState.sending ? <Loader2 size={19} className="animate-spin" /> : <Bot size={19} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">Workflow assistant</h2>
                <p className="truncate text-xs text-muted">{workflowName}</p>
              </div>
              <div ref={conversationMenuRef} className="relative flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                    selectedProvider.available
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-red-200 bg-red-50 text-red-700"
                  }`}
                >
                  {selectedProvider.available ? "Ready" : "Missing CLI"}
                </span>
                <button
                  className="grid h-8 w-8 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                  title="Conversation options"
                  type="button"
                  onClick={() => setConversationMenuOpen((current) => !current)}
                >
                  <MoreVertical size={15} />
                </button>
                {conversationMenuOpen ? (
                  <div className="absolute right-0 top-10 z-40 w-44 rounded-lg border border-line bg-white p-1 shadow-panel">
                    <button
                      className="w-full rounded-md px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50"
                      type="button"
                      onClick={deleteConversation}
                    >
                      Delete conversation
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <select
                className="h-9 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-teal-500"
                value={providerId}
                onChange={(event) => {
                  const nextProvider = providers.find(
                    (provider) => provider.id === event.target.value,
                  );
                  setProviderId(event.target.value);
                  setModel(nextProvider?.models?.[0] ?? "cli-default");
                }}
              >
                {(providers.length ? providers : [selectedProvider]).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <select
                className="h-9 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-teal-500"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {(selectedProvider.models ?? ["cli-default"]).map((modelName) => (
                  <option key={modelName} value={modelName}>
                    {modelName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={chatScrollRef}
        className="workflow-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-5"
      >
        <div className="rounded-lg border border-line bg-slate-50 p-3">
          <p className="text-sm leading-6 text-slate-700">
            The workflow assistant understands Gofer workflows and can answer questions
            about the current workflow, modify its nodes and edges, or create new
            workflows from your request.
          </p>
        </div>

        {chatItems.map((item) =>
          item.type === "thought-group" ? (
            <ThoughtGroup
              key={item.id}
              expanded={Boolean(expandedThoughtGroups[item.id])}
              thoughts={item.thoughts}
              onToggle={() =>
                setExpandedThoughtGroups((current) => ({
                  ...current,
                  [item.id]: !current[item.id],
                }))
              }
            />
          ) : (
            <ChatMessageBubble key={item.message.id} message={item.message} />
          ),
        )}
        {showTypingIndicator ? <TypingIndicator /> : null}
        {chatState.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">
            {chatState.error}
          </div>
        ) : null}
      </div>

      <div className="border-t border-line p-4">
        <div className="rounded-lg border border-line bg-slate-50 p-2">
          <textarea
            className="h-20 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-slate-400"
            placeholder="Ask about this workflow"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 text-xs text-muted">
              <MessageSquare size={14} />
              {selectedProvider.name} · {model}
            </div>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border dark:border-[#3a3a3d] dark:bg-[#2d2d30] dark:text-[#f2f2f2] dark:hover:border-[#4a4a4f] dark:hover:bg-[#37373d] dark:disabled:border-[#2a2a2a] dark:disabled:bg-[#242426] dark:disabled:text-[#777]"
              disabled={chatState.sending || !draft.trim()}
              title="Send message"
              type="button"
              onClick={sendMessage}
            >
              {chatState.sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" data-message-id="typing-indicator">
      <div className="max-w-[86%] rounded-lg border border-line bg-white px-3 py-2 text-sm leading-6 text-slate-700 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Workflow assistant is typing</span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatMessageBubble({ message }) {
  return (
    <div
      data-message-id={message.id}
      className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[86%] rounded-lg px-3 py-2 text-sm leading-6 ${
          message.role === "user"
            ? "bg-brand text-white"
            : "border border-line bg-white text-slate-700 shadow-sm"
        }`}
      >
        <pre className="whitespace-pre-wrap font-sans">{message.body}</pre>
      </div>
    </div>
  );
}

function ThoughtGroup({ expanded, onToggle, thoughts }) {
  const count = thoughts.length;
  const showBottomToggle = expanded && count >= 3;
  const tokenSummary = extractThoughtTokenSummary(thoughts);

  return (
    <div className="flex justify-start" data-message-id={thoughts[0]?.groupAnchorId}>
      <div className="max-w-[86%] rounded-lg border border-line bg-slate-50 text-sm text-slate-700 shadow-sm dark:bg-[#252526] dark:text-[#d4d4d4]">
        <button
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-[#2d2d30]"
          type="button"
          onClick={onToggle}
        >
          <span className="min-w-0">
            <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              {expanded ? "Hide thoughts" : "Show thoughts"} ({count})
            </span>
            {tokenSummary ? (
              <span className="mt-0.5 block text-[11px] font-normal normal-case tracking-normal text-muted/80">
                {tokenSummary}
              </span>
            ) : null}
          </span>
          <span className="grid h-6 w-6 place-items-center rounded-md text-muted transition">
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>
        <div
          className={`grid transition-all duration-200 ease-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="space-y-2 border-t border-line px-3 py-3">
              {thoughts.map((thought, index) => (
                <div
                  key={thought.id}
                  className="rounded-md bg-white px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-[#1e1e1e] dark:text-[#c8c8c8]"
                >
                  <div className="mb-1 font-semibold text-muted">Thought {index + 1}</div>
                  <pre className="whitespace-pre-wrap font-sans">{thought.body}</pre>
                </div>
              ))}
              {showBottomToggle ? (
                <button
                  className="mt-2 flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-[#2d2d30]"
                  type="button"
                  onClick={onToggle}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                      Hide thoughts ({count})
                    </span>
                    {tokenSummary ? (
                      <span className="mt-0.5 block text-[11px] font-normal normal-case tracking-normal text-muted/80">
                        {tokenSummary}
                      </span>
                    ) : null}
                  </span>
                  <span className="grid h-6 w-6 place-items-center rounded-md text-muted">
                    <ChevronUp size={15} />
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function extractThoughtTokenSummary(thoughts) {
  const tokenPattern =
    /(?:tokens?\s*(?:used|spent|total)?\s*[:=]?\s*([\d,.]+k?)|([\d,.]+k?)\s*tokens?\s*(?:used|spent)?)/i;
  for (const thought of thoughts) {
    const match = String(thought?.body ?? "").match(tokenPattern);
    const value = match?.[1] || match?.[2];
    if (value) return `${value} tokens`;
  }
  return "";
}

function defaultChatMessages() {
  return [
    {
      id: "welcome",
      role: "assistant",
      body: "Ask me to explain, edit, validate, or design this workflow. I will use the bundled Gofer Flow workflow-builder skill.",
    },
  ];
}

function chatStorageKeyFor(workflowId) {
  return `gofer-flow-chat:${workflowId ?? "no-workflow"}`;
}

function loadChatMessages(storageKey) {
  try {
    const storedMessages = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (
      Array.isArray(storedMessages) &&
      storedMessages.every((message) => message?.role && typeof message.body === "string")
    ) {
      return storedMessages;
    }
  } catch {
    return defaultChatMessages();
  }
  return defaultChatMessages();
}

function buildChatItems(messages) {
  const items = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.kind !== "thought") {
      items.push({ type: "message", message });
      index += 1;
      continue;
    }

    const groupId = message.groupId || `legacy-${message.id}`;
    const thoughts = [];
    while (
      index < messages.length &&
      messages[index].kind === "thought" &&
      (messages[index].groupId || `legacy-${messages[index].id}`) === groupId
    ) {
      thoughts.push({
        ...messages[index],
        groupAnchorId: `thought-group-${groupId}`,
      });
      index += 1;
    }
    items.push({
      id: `thought-group-${groupId}`,
      type: "thought-group",
      thoughts,
    });
  }

  return items;
}

function parseChatStreamEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function uniqueClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function CreateWorkflowDialog({ error, open, saving, onClose, onCreate }) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
    }
  }, [open]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onCreate(name);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <form
        className="w-full max-w-[420px] rounded-lg border border-line bg-white shadow-panel"
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">New workflow</h2>
            <p className="text-xs text-muted">Stored in the Gofer data directory</p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            disabled={saving}
            title="Close"
            type="button"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-5">
          <label className="block">
            <span className="text-xs font-medium text-muted">Name</span>
            <input
              autoFocus
              className="mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm outline-none transition focus:border-teal-500"
              disabled={saving}
              placeholder="Daily Analysis"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving}
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving || !name.trim()}
            type="submit"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyWorkspace({ error, loading, onRefresh }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-line bg-white p-6 text-center shadow-panel">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-slate-100 text-slate-700">
          {loading ? <Loader2 size={22} className="animate-spin" /> : <AlertCircle size={22} />}
        </div>
        <h2 className="mt-4 text-base font-semibold">
          {loading ? "Loading workflows" : "No workflow selected"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {error || "Create or save a workflow TOML file in the Gofer data directory."}
        </p>
        <button
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-sm font-medium text-white transition hover:bg-slate-700"
          type="button"
          onClick={onRefresh}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }) {
  const normalizedStatus = status || "Ready";
  const color = {
    Ready: "bg-emerald-500",
    Success: "bg-emerald-500",
    Error: "bg-red-500",
  }[normalizedStatus] ?? "bg-emerald-500";

  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1 text-[11px] font-medium text-slate-600">
      {normalizedStatus === "Running" ? (
        <Loader2 size={11} className="animate-spin text-muted" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      )}
      {normalizedStatus}
    </span>
  );
}
