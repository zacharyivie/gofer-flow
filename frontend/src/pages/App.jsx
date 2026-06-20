import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  ListFilter,
  Loader2,
  MessageSquare,
  Moon,
  MoreVertical,
  Plus,
  PencilLine,
  Play,
  RefreshCw,
  Search,
  Send,
  Square,
  Sun,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import DagCanvas, { PathPickerDialog } from "../components/DagCanvas.jsx";
import { apiUrl } from "../lib/api.js";

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [promptAgentIds, setPromptAgentIds] = useState([]);
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
  const [updateState, setUpdateState] = useState({
    available: false,
    checking: false,
    error: "",
    info: null,
  });
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
      const payloadDataDir = payload.dataDir ?? "";
      setPromptAgentIds(payload.promptAgentIds ?? []);
      const nextWorkflows = (payload.workflows ?? [])
        .filter((workflow) => !deletedWorkflowIdsRef.current.has(workflow.id))
        .map((workflow) => summarizeWorkflow(workflow, payloadDataDir));
      setWorkflows((current) => {
        const refreshedWorkflows = nextWorkflows.map((workflow) => {
          const localWorkflow = current.find((candidate) => candidate.id === workflow.id);
          return localWorkflow
            ? summarizeWorkflow(mergeSavedWorkflow(localWorkflow, workflow), payloadDataDir)
            : workflow;
        });
        const dirtyWorkflowId = dirtyWorkflowRef.current?.id;
        const localDirtyWorkflow = dirtyWorkflowId && !deletedWorkflowIdsRef.current.has(dirtyWorkflowId)
          ? current.find((workflow) => workflow.id === dirtyWorkflowId)
          : null;
        const mergedWorkflows =
          silent && localDirtyWorkflow
            ? preserveLocalWorkflow(refreshedWorkflows, localDirtyWorkflow, payloadDataDir)
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

  const checkForUpdates = useCallback(async ({ silent = false } = {}) => {
    if (!window.goferUpdates?.check) return;
    setUpdateState((current) => ({
      ...current,
      checking: true,
      error: silent ? current.error : "",
    }));
    try {
      const info = await window.goferUpdates.check();
      setUpdateState({
        available: Boolean(info?.available),
        checking: false,
        error: "",
        info,
      });
      if (!silent) {
        setTopBarNotice({
          type: info?.available ? "success" : "success",
          message: info?.available
            ? `Gofer Flow ${info.info?.version ?? "update"} is available`
            : info?.info?.noReleases
              ? "No published Gofer Flow releases yet"
            : "Gofer Flow is up to date",
        });
      }
    } catch (error) {
      setUpdateState((current) => ({
        ...current,
        checking: false,
        error: error instanceof Error ? error.message : "Unable to check for updates",
      }));
      if (!silent) {
        setTopBarNotice({
          type: "error",
          message: error instanceof Error ? error.message : "Unable to check for updates",
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!window.goferUpdates?.onState) return undefined;
    const unsubscribe = window.goferUpdates.onState((nextState) => {
      setUpdateState((current) => ({ ...current, ...nextState }));
    });
    window.goferUpdates.getState?.().then((nextState) => {
      setUpdateState((current) => ({ ...current, ...nextState }));
    }).catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    checkForUpdates({ silent: true });
  }, [checkForUpdates]);

  async function applyUpdate(update) {
    if (!window.goferUpdates) return;
    try {
      const nextState = update.downloaded
        ? await window.goferUpdates.installDownloaded()
        : await window.goferUpdates.downloadAndInstall();
      setUpdateState((current) => ({ ...current, ...nextState }));
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to apply update",
      });
    }
  }

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

  const loadRunLog = useCallback(async (workflowId, runId, { silent = false } = {}) => {
    const requestId = logRequestRef.current + 1;
    logRequestRef.current = requestId;
    if (!silent) {
      setLogState((current) => ({
        ...current,
        loading: true,
        error: "",
        selectedRunId: runId,
      }));
    }
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
      if (!silent) {
        setLogState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflow run",
        }));
      }
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
      if (logState.selectedRunId) {
        loadRunLog(activeWorkflow.id, logState.selectedRunId, { silent: true });
      } else {
        loadLatestLog(activeWorkflow.id, { silent: true });
      }
      loadRunLogs(activeWorkflow.id, { silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [activeWorkflow?.id, loadLatestLog, loadRunLog, loadRunLogs, logState.selectedRunId]);

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
  const usedAgentIds = useMemo(() => {
    return [
      ...new Set(
        [
          ...promptAgentIds,
          ...workflows.flatMap((workflow) => [
            ...Object.keys(workflow.agents ?? {}),
            ...(workflow.nodes ?? [])
              .map((node) => node.operation?.agent_id)
              .filter(Boolean),
          ]),
        ],
      ),
    ];
  }, [promptAgentIds, workflows]);

  function updateActiveWorkflow(nextWorkflow) {
    const summarizedWorkflow = summarizeWorkflow(nextWorkflow, dataDir);
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
              ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow), dataDir)
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
    const workflowToRun = summarizeWorkflow(workflow, dataDir);
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
            ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow), dataDir)
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
    if (!workflow?.id) return;

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
        message: payload.stopped ? "Stopping workflow runs..." : payload.message || "No active run",
      });
      setRunState((current) => ({
        ...current,
        stopping: false,
      }));
      loadWorkflows({ silent: true });
      loadRunLogs(workflow.id, { silent: true });
    } catch (error) {
      setRunState((current) => ({ ...current, stopping: false }));
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to stop workflow run",
      });
    }
  }

  async function stopWorkflowRunLog(workflowId, runId) {
    if (!workflowId || !runId) return;

    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/stop`,
        ),
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
      loadRunLogs(workflowId, { silent: true });
    } catch (error) {
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

      const nextWorkflow = summarizeWorkflow(payload.workflow, dataDir);
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
      await persistWorkflow(summarizeWorkflow(workflow, dataDir));
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

      const nextWorkflow = summarizeWorkflow(payload.workflow, dataDir);
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

  async function renameWorkflow(workflow, nextName) {
    if (!workflow) return;
    if (!nextName || nextName.trim() === workflow.name) return;

    try {
      if (dirtyWorkflowRef.current?.id === workflow.id) {
        await persistWorkflow(summarizeWorkflow(dirtyWorkflowRef.current, dataDir));
        dirtyWorkflowRef.current = undefined;
        setDirtyWorkflow(undefined);
      }

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/rename`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: nextName.trim() }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const renamed = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(renamed.id);
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === workflow.id ? renamed : candidate,
        ),
      );
      setActiveWorkflowId((currentId) =>
        currentId === workflow.id ? renamed.id : currentId,
      );
      setTopBarNotice({ type: "success", message: `Renamed to ${renamed.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to rename workflow",
      });
    }
  }

  async function duplicateWorkflow(workflow) {
    if (!workflow) return;

    try {
      if (dirtyWorkflowRef.current?.id === workflow.id) {
        await persistWorkflow(summarizeWorkflow(dirtyWorkflowRef.current, dataDir));
        dirtyWorkflowRef.current = undefined;
        setDirtyWorkflow(undefined);
      }

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/duplicate`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const duplicated = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(duplicated.id);
      setWorkflows((current) => [...current, duplicated]);
      setActiveWorkflowId(duplicated.id);
      setTopBarNotice({ type: "success", message: `Duplicated ${workflow.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to duplicate workflow",
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
        onDuplicateWorkflow={duplicateWorkflow}
        onRefresh={loadWorkflows}
        onRenameWorkflow={renameWorkflow}
        onRunWorkflow={runWorkflowNow}
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
              updateState={updateState}
              workflow={activeWorkflow}
              onCheckForUpdates={() => checkForUpdates()}
              onApplyUpdate={() => applyUpdate(updateState)}
              onToggleTheme={() =>
                setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))
              }
            />
            <DagCanvas
              dataDir={dataDir}
              logState={logState}
              notice={topBarNotice}
              runState={runState}
              workflow={activeWorkflow}
              usedAgentIds={usedAgentIds}
              onLoadLatestLog={() => loadLatestLog(activeWorkflow.id)}
              onSelectRunLog={(runId) => loadRunLog(activeWorkflow.id, runId)}
              onStopRunLog={(runId) => stopWorkflowRunLog(activeWorkflow.id, runId)}
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
        activeWorkflowId={activeWorkflow?.id}
        workflow={activeWorkflow}
        workflows={workflows}
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

function summarizeWorkflow(workflow, dataDir = "") {
  if (workflow.invalid) {
    return {
      ...workflow,
      agents: workflow.agents ?? {},
      nodes: workflow.nodes ?? [],
      edges: workflow.edges ?? [],
      description: workflow.description || `Invalid workflow TOML: ${workflow.validationError}`,
      status: "Error",
      tags: ["error", "invalid"],
    };
  }
  const agentCount = agentIdsForWorkflow(workflow).length;
  const operationTypes = [...new Set((workflow.nodes ?? []).map((node) => node.type))].sort();
  const status = workflow.status ?? "Ready";
  const watchPath = workflow.watch?.path
    ? resolveDisplayPath(workflow.watch.path, dataDir)
    : "";
  return {
    ...workflow,
    description: `${workflow.nodes.length} nodes, ${workflow.edges.length} edges, ${agentCount} agents.${
      workflow.schedule ? ` Scheduled with ${workflow.schedule.cron_expression}.` : ""
    }${workflow.watch ? ` Watching ${watchPath}.` : ""
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

function preserveLocalWorkflow(remoteWorkflows, localWorkflow, dataDir = "") {
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
        }, dataDir)
      : workflow,
  );
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

function resolveDisplayPath(pathValue = "", basePath = "") {
  const value = String(pathValue ?? "").trim();
  if (!value || isUrlPath(value) || isAbsolutePath(value)) {
    return value;
  }
  if (!basePath) return value;
  if (value === ".") return basePath;
  const separator = String(basePath).includes("\\") && !String(basePath).includes("/") ? "\\" : "/";
  return `${String(basePath).replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
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
  onDuplicateWorkflow,
  onQueryChange,
  onRefresh,
  onRenameWorkflow,
  onResizeStart,
  onRunWorkflow,
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
              onDuplicate={() => onDuplicateWorkflow(workflow)}
              onRename={(name) => onRenameWorkflow(workflow, name)}
              onRun={() => onRunWorkflow(workflow)}
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

function WorkflowListItem({
  active,
  onDelete,
  onDuplicate,
  onRename,
  onRun,
  onSelect,
  status,
  workflow,
}) {
  const menuRef = useRef(null);
  const nameInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event) {
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    setDraftName(workflow.name);
  }, [workflow.name]);

  useEffect(() => {
    if (!renaming) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [renaming]);

  function commitRename() {
    const nextName = draftName.trim();
    setRenaming(false);
    if (!nextName) {
      setDraftName(workflow.name);
      return;
    }
    if (nextName !== workflow.name) {
      onRename(nextName);
    }
  }

  function cancelRename() {
    setRenaming(false);
    setDraftName(workflow.name);
  }

  return (
    <div
      className={`group relative w-full rounded-lg border text-left transition ${
        active
          ? "border-teal-200 bg-teal-50 shadow-sm"
          : "border-transparent bg-white hover:border-line hover:bg-slate-50"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        className="w-full rounded-lg p-3 pr-10 text-left"
        onClick={() => {
          if (!renaming) {
            onSelect();
          }
        }}
        onKeyDown={(event) => {
          if (!renaming && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {renaming ? (
              <input
                ref={nameInputRef}
                className="w-full rounded-md border border-teal-300 bg-white px-2 py-1 text-sm font-semibold text-ink outline-none ring-2 ring-teal-100"
                value={draftName}
                onBlur={commitRename}
                onChange={(event) => setDraftName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <p className="truncate text-sm font-semibold">{workflow.name}</p>
            )}
            <p className="text-clamp-2 mt-1 text-xs leading-5 text-muted">
              {workflow.description}
            </p>
          </div>
          <StatusDot status={status} />
        </div>
      </div>
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
          <div className="absolute right-0 top-8 z-40 w-48 rounded-lg border border-line bg-white p-1 shadow-panel">
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onRun();
              }}
            >
              <Play size={15} />
              Run workflow
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              <PencilLine size={15} />
              Rename workflow
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onDuplicate();
              }}
            >
              <Copy size={15} />
              Duplicate workflow
            </button>
            <div className="my-1 border-t border-line" />
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
  updateState,
  workflow,
  onApplyUpdate,
  onCheckForUpdates,
  onToggleTheme,
}) {
  const nodeCount = workflow.nodes?.length ?? 0;
  const edgeCount = workflow.edges?.length ?? 0;
  const hasUpdateBridge = Boolean(window.goferUpdates?.check);
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
            {workflow.invalid ? "Invalid TOML" : `${nodeCount} nodes`}
          </span>
          {!workflow.invalid ? (
            <span className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted">
              {edgeCount} edges
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {hasUpdateBridge ? (
          updateState?.available ? (
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-teal-700/30 bg-teal-50 px-3 text-xs font-semibold text-teal-800 transition hover:border-teal-700/50 hover:bg-teal-100 disabled:cursor-wait disabled:opacity-70 dark:border-teal-500/30 dark:bg-teal-950/40 dark:text-teal-200 dark:hover:bg-teal-900/50"
              disabled={Boolean(updateState.downloading)}
              title={updateButtonTitle(updateState)}
              type="button"
              onClick={onApplyUpdate}
            >
              {updateState.downloading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              {updateButtonLabel(updateState)}
            </button>
          ) : (
            <button
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              title={
                updateState?.error
                  ? `Update check failed: ${updateState.error}`
                  : "Check for updates"
              }
              type="button"
              onClick={onCheckForUpdates}
            >
              <RefreshCw
                size={16}
                className={updateState?.checking ? "animate-spin" : ""}
              />
            </button>
          )
        ) : null}
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

function updateButtonLabel(updateState) {
  if (updateState?.downloaded) return "Restart to update";
  if (updateState?.downloading) {
    const percent = Math.max(0, Math.min(100, updateState.progress?.percent ?? 0));
    return `Downloading ${Math.round(percent)}%`;
  }
  return `Update ${updateState?.info?.version ?? "available"}`;
}

function updateButtonTitle(updateState) {
  if (updateState?.downloaded) return "Restart Gofer Flow and apply the downloaded update";
  if (updateState?.downloading) return "Downloading update";
  return "Download, install, and restart Gofer Flow";
}

function ChatPane({ activeWorkflowId, onResizeStart, width, workflow, workflows }) {
  const chatScrollRef = useRef(null);
  const conversationMenuRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState("codex");
  const [model, setModel] = useState("cli-default");
  const [threads, setThreads] = useState(loadChatThreads);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messagesByThread, setMessagesByThread] = useState({});
  const [chatStateByThread, setChatStateByThread] = useState({});
  const [showTypingByThread, setShowTypingByThread] = useState({});
  const [typingDelayByThread, setTypingDelayByThread] = useState({});
  const [expandedThoughtGroups, setExpandedThoughtGroups] = useState({});
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const chatAbortControllersRef = useRef({});
  const workflowName = workflow?.name ?? "All workflows";
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const messages = activeThreadId
    ? messagesByThread[activeThreadId] ?? loadChatMessages(chatStorageKeyFor(activeThreadId))
    : [];
  const chatState = activeThreadId
    ? chatStateByThread[activeThreadId] ?? { sending: false, error: "" }
    : { sending: false, error: "" };
  const showTypingIndicator = Boolean(activeThreadId && showTypingByThread[activeThreadId]);
  const typingDelayKey = activeThreadId ? typingDelayByThread[activeThreadId] ?? 0 : 0;
  const workflowContext = useMemo(
    () => ({
      id: activeThreadId ? `workflow-assistant:${activeThreadId}` : "workflow-assistant",
      chatThreadId: activeThreadId,
      selectedWorkflowId: activeWorkflowId ?? null,
      workflows: workflows ?? [],
    }),
    [activeThreadId, activeWorkflowId, workflows],
  );
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
    if (!activeThreadId) {
      setDraft("");
      setConversationMenuOpen(false);
      return;
    }

    setMessagesByThread((current) =>
      current[activeThreadId]
        ? current
        : {
            ...current,
            [activeThreadId]: loadChatMessages(chatStorageKeyFor(activeThreadId)),
          },
    );
    setDraft("");
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) return undefined;

    if (!chatState.sending) {
      setShowTypingByThread((current) => ({ ...current, [activeThreadId]: false }));
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setShowTypingByThread((current) => ({ ...current, [activeThreadId]: true }));
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [activeThreadId, chatState.sending, typingDelayKey]);

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
    if (!activeThreadId || !text || chatState.sending) return;
    const targetThreadId = activeThreadId;

    const userMessage = {
      id: uniqueClientId(),
      role: "user",
      body: text,
    };
    const nextMessages = [...messages, userMessage];
    updateThreadMessages(targetThreadId, nextMessages);
    updateThreadTitleFromMessage(targetThreadId, text);
    setDraft("");
    setChatStateByThread((current) => ({
      ...current,
      [targetThreadId]: { sending: true, error: "" },
    }));
    const thoughtGroupId = uniqueClientId();
    window.requestAnimationFrame(() => {
      scrollMessageNearTop(userMessage.id);
    });

    function appendAssistantMessage(body, kind = "final", extra = {}) {
      const assistantMessageId = uniqueClientId();
      updateThreadMessages(targetThreadId, (current) => [
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
      setShowTypingByThread((current) => ({ ...current, [targetThreadId]: false }));
      setTypingDelayByThread((current) => ({
        ...current,
        [targetThreadId]: (current[targetThreadId] ?? 0) + 1,
      }));
    }

    try {
      const abortController = new AbortController();
      chatAbortControllersRef.current[targetThreadId] = abortController;
      const response = await fetch(apiUrl("/chat/stream"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify({
          provider: providerId,
          model,
          messages: nextMessages.map(({ role, body }) => ({ role, body })),
          workflow: {
            ...workflowContext,
            id: `workflow-assistant:${targetThreadId}`,
            chatThreadId: targetThreadId,
          },
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
            } else if (event.type === "compaction") {
              const compactedMessages = Array.isArray(event.messages)
                ? event.messages
                : null;
              if (compactedMessages) {
                updateThreadMessages(targetThreadId, compactedMessages);
              } else {
                appendAssistantMessage(
                  event.message || "Compacting workflow assistant context",
                  "system",
                  { role: "system" },
                );
              }
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
      setChatStateByThread((current) => ({
        ...current,
        [targetThreadId]: { sending: false, error: "" },
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        appendAssistantMessage("Workflow assistant stopped.", "final");
        setChatStateByThread((current) => ({
          ...current,
          [targetThreadId]: { sending: false, error: "" },
        }));
        return;
      }
      setChatStateByThread((current) => ({
        ...current,
        [targetThreadId]: {
          sending: false,
          error: error instanceof Error ? error.message : "Unable to send message",
        },
      }));
    } finally {
      if (chatAbortControllersRef.current[targetThreadId]) {
        delete chatAbortControllersRef.current[targetThreadId];
      }
    }
  }

  function stopAssistant(threadId) {
    chatAbortControllersRef.current[threadId]?.abort();
    setShowTypingByThread((current) => ({ ...current, [threadId]: false }));
  }

  function updateThreadMessages(threadId, nextValue) {
    setMessagesByThread((current) => {
      const currentMessages =
        current[threadId] ?? loadChatMessages(chatStorageKeyFor(threadId));
      const nextMessages =
        typeof nextValue === "function" ? nextValue(currentMessages) : nextValue;
      window.localStorage.setItem(chatStorageKeyFor(threadId), JSON.stringify(nextMessages));
      return { ...current, [threadId]: nextMessages };
    });
  }

  function createThread() {
    const now = new Date().toISOString();
    const thread = {
      id: uniqueClientId(),
      title: "New thread",
      createdAt: now,
      updatedAt: now,
    };
    const nextThreads = [thread, ...threads];
    persistChatThreads(nextThreads);
    setThreads(nextThreads);
    setActiveThreadId(thread.id);
    setDraft("");
  }

  function updateThreadTitleFromMessage(threadId, message) {
    setThreads((currentThreads) => {
      const nextThreads = currentThreads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              title: thread.title === "New thread" ? threadTitleFromMessage(message) : thread.title,
              updatedAt: new Date().toISOString(),
            }
          : thread,
      );
      persistChatThreads(nextThreads);
      return nextThreads;
    });
  }

  async function deleteThread(threadId) {
    const nextThreads = threads.filter((thread) => thread.id !== threadId);
    persistChatThreads(nextThreads);
    setThreads(nextThreads);
    window.localStorage.removeItem(chatStorageKeyFor(threadId));
    setMessagesByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setChatStateByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setShowTypingByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setTypingDelayByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    chatAbortControllersRef.current[threadId]?.abort();
    delete chatAbortControllersRef.current[threadId];
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
    }
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);

    try {
      const response = await fetch(
        apiUrl(`/chat/threads/${encodeURIComponent(threadId)}`),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to delete chat handoff file";
      if (activeThreadId === threadId) {
        setChatStateByThread((current) => ({
          ...current,
          [threadId]: { sending: false, error: message },
        }));
      }
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
              <div className="flex min-w-0 items-center gap-2">
                {activeThread ? (
                  <button
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                    title="Back to threads"
                    type="button"
                    onClick={() => setActiveThreadId(null)}
                  >
                    <ArrowLeft size={15} />
                  </button>
                ) : null}
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">Workflow assistant</h2>
                  <p className="truncate text-xs text-muted">
                    {activeThread
                      ? activeThread.title
                      : workflow
                        ? `${workflowName} selected`
                        : "No workflow selected"}
                  </p>
                </div>
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
                      disabled={!activeThread}
                      onClick={() => activeThread && deleteThread(activeThread.id)}
                    >
                      Delete thread
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
        {!activeThread ? (
          <ThreadList
            threads={threads}
            onCreate={createThread}
            onDelete={deleteThread}
            onOpen={setActiveThreadId}
          />
        ) : (
          <>
            <div className="rounded-lg border border-line bg-slate-50 p-3">
              <p className="text-sm leading-6 text-slate-700">
                The workflow assistant understands all workflows in the open workspace.
                It can answer questions, create and modify workflows, run them, and
                handle anything else available through the Gofer Flow CLI.
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
          </>
        )}
      </div>

      {activeThread ? (
        <div className="border-t border-line p-4">
          <div className="rounded-lg border border-line bg-slate-50 p-2">
            <textarea
              className="h-20 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-muted"
              disabled={chatState.sending}
              placeholder="Ask about your workflows"
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
                className={`grid h-8 w-8 place-items-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  chatState.sending
                    ? "border border-line bg-white text-red-600 hover:border-red-200 hover:bg-red-50"
                    : "bg-ink text-white hover:bg-slate-700 dark:border dark:border-[#3a3a3d] dark:bg-[#2d2d30] dark:text-[#f2f2f2] dark:hover:border-[#4a4a4f] dark:hover:bg-[#37373d] dark:disabled:border-[#2a2a2a] dark:disabled:bg-[#242426] dark:disabled:text-[#777]"
                }`}
                disabled={!chatState.sending && !draft.trim()}
                title={chatState.sending ? "Stop workflow assistant" : "Send message"}
                type="button"
                onClick={() =>
                  chatState.sending
                    ? activeThreadId && stopAssistant(activeThreadId)
                    : sendMessage()
                }
              >
                {chatState.sending ? (
                  <Square size={13} fill="currentColor" strokeWidth={1.7} />
                ) : (
                  <Send size={15} />
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function ThreadList({ onCreate, onDelete, onOpen, threads }) {
  if (threads.length) {
    return (
      <div className="space-y-2">
        <button
          className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
          type="button"
          onClick={onCreate}
        >
          <Plus size={14} />
          New thread
        </button>

        <div className="space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="group flex items-center gap-2 rounded-lg border border-line bg-white p-2 transition hover:bg-slate-50"
            >
              <button
                className="min-w-0 flex-1 px-2 py-1 text-left"
                type="button"
                onClick={() => onOpen(thread.id)}
              >
                <div className="truncate text-sm font-medium text-ink">{thread.title}</div>
                <div className="mt-0.5 text-xs text-muted">{formatThreadDate(thread.updatedAt)}</div>
              </button>
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted opacity-70 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                title="Delete thread"
                type="button"
                onClick={() => onDelete(thread.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-slate-50 p-4">
      <p className="text-sm leading-6 text-slate-700">
        The workflow assistant understands all workflows in the open workspace. It can
        answer questions, create and modify workflows, run them, and handle anything
        else available through the Gofer Flow CLI. Start a new thread to begin.
      </p>
      <button
        className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium text-ink transition hover:border-slate-300 hover:bg-slate-50"
        type="button"
        onClick={onCreate}
      >
        <Plus size={15} />
        New thread
      </button>
    </div>
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
  const isSystem = message.role === "system" || message.kind === "system";
  return (
    <div
      data-message-id={message.id}
      className={`flex ${
        isSystem ? "justify-center" : message.role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`max-w-[86%] rounded-lg px-3 py-2 text-sm leading-6 ${
          isSystem
            ? "border border-line bg-slate-50 text-xs font-medium text-muted"
            : message.role === "user"
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
    /(?:tokens?\s*(?:used|spent|total)?\s*[:=]?\s*([\d,.]+k?)|([\d,.]+k?)\s*tokens?\s*(?:used|spent)?)/gi;
  for (const thought of [...thoughts].reverse()) {
    const matches = [...String(thought?.body ?? "").matchAll(tokenPattern)];
    const match = matches.at(-1);
    const value = match?.[1] || match?.[2];
    if (value) return `${value} tokens used`;
  }
  return "";
}

const chatThreadsStorageKey = "gofer-flow-chat-threads";

function loadChatThreads() {
  try {
    const storedThreads = JSON.parse(window.localStorage.getItem(chatThreadsStorageKey) || "[]");
    if (
      Array.isArray(storedThreads) &&
      storedThreads.every((thread) => thread?.id && typeof thread.title === "string")
    ) {
      return storedThreads;
    }
  } catch {
    return [];
  }
  return [];
}

function persistChatThreads(threads) {
  window.localStorage.setItem(chatThreadsStorageKey, JSON.stringify(threads));
}

function threadTitleFromMessage(message) {
  const words = message.trim().split(/\s+/).slice(0, 8);
  const title = words.join(" ");
  return title.length < message.trim().length ? `${title}...` : title || "New thread";
}

function formatThreadDate(value) {
  if (!value) return "No messages yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No messages yet";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function defaultChatMessages() {
  return [];
}

function chatStorageKeyFor(threadId) {
  return `gofer-flow-chat-thread:${threadId}`;
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
    if (message.kind === "memory") {
      index += 1;
      continue;
    }
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
