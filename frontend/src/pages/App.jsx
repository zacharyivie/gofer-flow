import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  FolderOpen,
  GitBranch,
  History,
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
import DagCanvas from "../components/DagCanvas.jsx";
import { apiUrl } from "../lib/api.js";
import {
  applyWorkflowPatch,
  buildPatchReview,
  extractWorkflowPatch,
  selectedPatchOperations,
} from "../lib/workflowPatch.js";

const RETENTION_STORAGE_KEY = "gofer.retentionSettings";
const DEFAULT_RETENTION_SETTINGS = {
  keepDays: 14,
  keepFailedDays: 30,
  keepLast: 100,
};
const RUN_LOG_TAIL_BYTES = 64 * 1024;
const WORKFLOW_UNDO_LIMIT = 100;

function cloneWorkflowForEditHistory(workflow) {
  return workflow ? JSON.parse(JSON.stringify(workflow)) : workflow;
}

function workflowEditSnapshotEquals(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function pushWorkflowEditHistory(history, workflowId, workflow, limit = WORKFLOW_UNDO_LIMIT) {
  if (!workflowId || !workflow) return history;
  const currentHistory = history[workflowId] ?? [];
  const snapshot = cloneWorkflowForEditHistory(workflow);
  if (workflowEditSnapshotEquals(currentHistory.at(-1), snapshot)) return history;
  return {
    ...history,
    [workflowId]: [...currentHistory, snapshot].slice(-limit),
  };
}

export function popWorkflowEditHistory(history, workflowId) {
  const currentHistory = history[workflowId] ?? [];
  if (!currentHistory.length) return { history, workflow: null };
  const workflow = currentHistory.at(-1);
  return {
    history: {
      ...history,
      [workflowId]: currentHistory.slice(0, -1),
    },
    workflow,
  };
}

function loadRetentionSettings() {
  if (typeof window === "undefined") return DEFAULT_RETENTION_SETTINGS;
  try {
    const stored = window.localStorage?.getItem(RETENTION_STORAGE_KEY);
    if (!stored) return DEFAULT_RETENTION_SETTINGS;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return DEFAULT_RETENTION_SETTINGS;
    return {
      keepDays: Number.isFinite(parsed.keepDays)
        ? parsed.keepDays
        : DEFAULT_RETENTION_SETTINGS.keepDays,
      keepFailedDays: Number.isFinite(parsed.keepFailedDays)
        ? parsed.keepFailedDays
        : DEFAULT_RETENTION_SETTINGS.keepFailedDays,
      keepLast: Number.isFinite(parsed.keepLast)
        ? parsed.keepLast
        : DEFAULT_RETENTION_SETTINGS.keepLast,
    };
  } catch {
    return DEFAULT_RETENTION_SETTINGS;
  }
}

function isBundleFile(file) {
  const name = file?.name?.toLowerCase?.() ?? "";
  return name.endsWith(".zip") || name.endsWith(".gof");
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

export function formatBundleImportPreview(plan) {
  const manifest = plan.manifest ?? {};
  const promptPaths = (manifest.includedPaths ?? [])
    .filter((item) => item.kind === "prompt" || item.kind === "prompt_template")
    .map((item) => `${item.path}${item.kind === "prompt_template" ? " (template)" : ""}`);
  const lines = [
    `Import bundle "${plan.workflowName}" as ${plan.workflowId}?`,
    "",
    "Files to create:",
    ...previewLines(plan.filesToCreate),
    "",
    "Files to overwrite:",
    ...previewLines(plan.filesToOverwrite),
    "",
    "Agents and providers:",
    ...previewProviderLines(manifest.providerAssumptions),
    "",
    "Prompts:",
    ...previewLines(promptPaths),
    "",
    "Triggers:",
    ...previewTriggerLines(manifest.triggers),
  ];
  if (plan.riskWarnings?.length) {
    lines.push("", "High-risk configuration:", ...plan.riskWarnings.map((item) => `- ${item}`));
  }
  if (plan.conflicts?.length) {
    lines.push("", "Conflicts:", ...plan.conflicts.map((item) => `- ${item.path}: ${item.action}`));
  }
  if (plan.requiredSecrets?.length) {
    lines.push("", "Required secrets:", ...plan.requiredSecrets.map((item) => `- ${item.name}`));
  }
  if (plan.externalRequirements?.length) {
    lines.push(
      "",
      "External requirements:",
      ...plan.externalRequirements.map((item) => `- ${item.path}: ${item.reason}`),
    );
  }
  return lines.join("\n");
}

function previewLines(items = []) {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

function previewProviderLines(items = []) {
  if (!items.length) return ["- None"];
  return items.map((item) => {
    const details = [item.subscription, item.profile && `profile ${item.profile}`, item.model].filter(
      Boolean,
    );
    return `- ${item.agentId}: ${details.join(", ")}`;
  });
}

function previewTriggerLines(items = []) {
  if (!items.length) return ["- None"];
  return items.map((item) => {
    if (item.type === "schedule") {
      return `- schedule: ${item.cron} (${item.timezone})`;
    }
    if (item.type === "watch") {
      return `- watch: ${item.path} ${item.glob} (${item.mode})`;
    }
    if (item.type === "webhook") {
      const details = [item.source, item.enabled === "true" ? "enabled" : "disabled"];
      if (item.tokenEnv) details.push(`secret ${item.tokenEnv}`);
      if (item.allowUnauthenticated === "true") details.push("allows unauthenticated requests");
      if (item.risk === "high") details.push("high risk");
      if (item.riskReasons) details.push(`risk ${item.riskReasons}`);
      if (item.fanoutPath) details.push(`fanout ${item.fanoutPath}`);
      return `- webhook ${item.id}: ${details.join(", ")}`;
    }
    return `- ${item.type ?? "trigger"}`;
  });
}

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [dashboards, setDashboards] = useState([]);
  const [promptAgentIds, setPromptAgentIds] = useState([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState();
  const [activeDashboardId, setActiveDashboardId] = useState();
  const [workspaceMode, setWorkspaceMode] = useState("workflows");
  const [query, setQuery] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [loadState, setLoadState] = useState({ loading: true, error: "" });
  const [doctorState, setDoctorState] = useState({
    loading: true,
    error: "",
    errors: [],
    warnings: [],
  });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createState, setCreateState] = useState({ saving: false, error: "" });
  const [exportDialog, setExportDialog] = useState({
    error: "",
    outputPath: "",
    saving: false,
    workflow: null,
  });
  const [workflowTemplates, setWorkflowTemplates] = useState([]);
  const [historyState, setHistoryState] = useState({
    diff: null,
    error: "",
    loading: false,
    open: false,
    revisions: [],
  });
  const [dirtyWorkflow, setDirtyWorkflow] = useState();
  const [, setSaveState] = useState({ saving: false, error: "" });
  const [topBarNotice, setTopBarNotice] = useState({ type: "", message: "" });
  const [runPreview, setRunPreview] = useState(null);
  const [executionMode, setExecutionMode] = useState("local");
  const [queueState, setQueueState] = useState({ runners: [], runs: [], error: "" });
  const [retentionSettings, setRetentionSettings] = useState(loadRetentionSettings);
  const [updateState, setUpdateState] = useState({
    available: false,
    checking: false,
    error: "",
    info: null,
  });
  const [runState, setRunState] = useState({ running: false, error: "", result: null });
  const [chatPatchReview, setChatPatchReview] = useState(null);
  const [logState, setLogState] = useState({
    loading: false,
    error: "",
    text: "",
    path: null,
    nodeOutputs: null,
    nodeOutputsTruncated: false,
    nodeOutputsMaxBytes: null,
    usageSummary: null,
    runEvents: [],
    runNodes: {},
    runs: [],
    selectedRunId: null,
  });
  const [approvalState, setApprovalState] = useState({
    approvals: [],
    error: "",
    loading: false,
  });
  const [theme, setTheme] = useState(getInitialTheme);
  const [workflowPaneWidth, setWorkflowPaneWidth] = useState(292);
  const [chatPaneWidth, setChatPaneWidth] = useState(356);
  const saveRevisionRef = useRef(0);
  const dirtyWorkflowRef = useRef();
  const deletedWorkflowIdsRef = useRef(new Set());
  const logRequestRef = useRef(0);
  const pendingDashboardMutationsRef = useRef(0);
  const pendingWorkflowPersistenceRef = useRef(new Set());
  const workflowRedoHistoryRef = useRef({});
  const workflowUndoHistoryRef = useRef({});
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];
  const activeDashboard =
    dashboards.find((dashboard) => dashboard.id === activeDashboardId) ?? dashboards[0];

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
        const workflowIdsToPreserve = new Set(pendingWorkflowPersistenceRef.current);
        if (dirtyWorkflowRef.current?.id) {
          workflowIdsToPreserve.add(dirtyWorkflowRef.current.id);
        }
        const mergedWorkflows =
          silent && workflowIdsToPreserve.size
            ? preserveLocalWorkflows(
                refreshedWorkflows,
                current.filter(
                  (workflow) =>
                    workflowIdsToPreserve.has(workflow.id) &&
                    !deletedWorkflowIdsRef.current.has(workflow.id),
                ),
                payloadDataDir,
              )
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

  const loadDashboards = useCallback(async () => {
    if (pendingDashboardMutationsRef.current > 0) {
      return;
    }
    try {
      const response = await fetch(apiUrl("/dashboards"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Dashboard API returned ${response.status}`);
      }
      const nextDashboards = payload.dashboards ?? [];
      setDashboards(nextDashboards);
      setActiveDashboardId((currentId) =>
        nextDashboards.some((dashboard) => dashboard.id === currentId)
          ? currentId
          : nextDashboards[0]?.id,
      );
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to load dashboards",
      });
    }
  }, []);

  const loadWorkflowTemplates = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/workflow-templates"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setWorkflowTemplates(payload.templates ?? []);
    } catch {
      setWorkflowTemplates([]);
    }
  }, []);

  const loadDoctor = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setDoctorState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(apiUrl("/doctor"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Doctor API returned ${response.status}`);
      }
      setDoctorState({
        loading: false,
        error: "",
        errors: payload.errors ?? [],
        warnings: payload.warnings ?? [],
      });
    } catch (error) {
      if (!silent) {
        setDoctorState({
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load health checks",
          errors: [],
          warnings: [],
        });
      }
    }
  }, []);

  const loadQueue = useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await fetch(apiUrl("/queue"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Queue API returned ${response.status}`);
      }
      setQueueState({
        runners: payload.runners ?? [],
        runs: payload.runs ?? [],
        error: "",
      });
    } catch (error) {
      if (!silent) {
        setQueueState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load runners",
        }));
      }
    }
  }, []);

  useEffect(() => {
    loadWorkflows();
    loadDashboards();
  }, [loadDashboards, loadWorkflows]);

  useEffect(() => {
    loadWorkflowTemplates();
  }, [loadWorkflowTemplates]);

  useEffect(() => {
    loadDoctor();
    loadQueue();
  }, [loadDoctor, loadQueue]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadWorkflows({ silent: true });
      loadDashboards();
      loadDoctor({ silent: true });
      loadQueue({ silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [loadDashboards, loadDoctor, loadQueue, loadWorkflows]);

  useEffect(() => {
    window.localStorage.setItem("gofer-ui-theme", theme);
  }, [theme]);

  const loadRetentionSettingsForWorkflow = useCallback(async (workflowId) => {
    if (!workflowId) return;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/retention`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (payload.settings) {
        setRetentionSettings(payload.settings);
        window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(payload.settings));
      }
    } catch {
      setRetentionSettings(loadRetentionSettings());
    }
  }, []);

  const saveRetentionSettingsForWorkflow = useCallback(async (workflowId, nextSettings) => {
    setRetentionSettings(nextSettings);
    window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(nextSettings));
    if (!workflowId) return;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/retention`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSettings),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (payload.settings) {
        setRetentionSettings(payload.settings);
        window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(payload.settings));
      }
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unable to save retention settings",
      });
    }
  }, []);

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
    if (!topBarNotice?.message) return undefined;

    const timeoutId = window.setTimeout(() => {
      setTopBarNotice({ type: "", message: "" });
    }, 3500);

    return () => window.clearTimeout(timeoutId);
  }, [topBarNotice?.message]);

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
      const nextNodeOutputs = payload.log?.nodeOutputs ?? null;
      const nextUsageSummary = payload.log?.usageSummary ?? null;
      const nextRunEvents = payload.log?.runEvents ?? [];
      const nextRunNodes = payload.log?.runNodes ?? {};
      setLogState((current) => {
        if (
          current.text === nextText &&
          current.path === nextPath &&
          JSON.stringify(current.nodeOutputs ?? null) === JSON.stringify(nextNodeOutputs) &&
          JSON.stringify(current.usageSummary ?? null) === JSON.stringify(nextUsageSummary) &&
          JSON.stringify(current.runEvents ?? []) === JSON.stringify(nextRunEvents) &&
          JSON.stringify(current.runNodes ?? {}) === JSON.stringify(nextRunNodes) &&
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
          nodeOutputs: nextNodeOutputs,
          nodeOutputsTruncated: Boolean(payload.log?.nodeOutputsTruncated),
          nodeOutputsMaxBytes: payload.log?.nodeOutputsMaxBytes ?? null,
          usageSummary: nextUsageSummary,
          runEvents: nextRunEvents,
          runNodes: nextRunNodes,
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
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs?limit=100`),
      );
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
      const params = new URLSearchParams({
        tailBytes: String(RUN_LOG_TAIL_BYTES),
        details: silent ? "0" : "1",
      });
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/logs/${encodeURIComponent(runId)}?${params}`,
        ),
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
        nodeOutputs: silent ? current.nodeOutputs : (payload.log?.nodeOutputs ?? null),
        nodeOutputsTruncated: silent
          ? current.nodeOutputsTruncated
          : Boolean(payload.log?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: silent
          ? current.nodeOutputsMaxBytes
          : (payload.log?.nodeOutputsMaxBytes ?? null),
        usageSummary: silent ? current.usageSummary : (payload.log?.usageSummary ?? null),
        runEvents: silent ? current.runEvents : (payload.log?.runEvents ?? []),
        runNodes: silent ? current.runNodes : (payload.log?.runNodes ?? {}),
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

  const loadApprovals = useCallback(async (workflowId, { silent = false } = {}) => {
    if (!silent) {
      setApprovalState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/approvals`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setApprovalState({
        approvals: payload.approvals ?? [],
        error: "",
        loading: false,
      });
    } catch (error) {
      if (!silent) {
        setApprovalState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load approvals",
          loading: false,
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
        nodeOutputs: null,
        nodeOutputsTruncated: false,
        nodeOutputsMaxBytes: null,
        usageSummary: null,
        runEvents: [],
        runNodes: {},
        runs: [],
        selectedRunId: null,
      });
      setApprovalState({ approvals: [], error: "", loading: false });
      return;
    }

    loadLatestLog(activeWorkflow.id, { silent: true });
    loadRunLogs(activeWorkflow.id);
    loadApprovals(activeWorkflow.id);
    loadRetentionSettingsForWorkflow(activeWorkflow.id);
  }, [
    activeWorkflow?.id,
    loadApprovals,
    loadLatestLog,
    loadRetentionSettingsForWorkflow,
    loadRunLogs,
  ]);

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
      loadApprovals(activeWorkflow.id, { silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [
    activeWorkflow?.id,
    loadApprovals,
    loadLatestLog,
    loadRunLog,
    loadRunLogs,
    logState.selectedRunId,
  ]);

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
  const filteredDashboards = useMemo(() => {
    return dashboards.filter((dashboard) => {
      const text = `${dashboard.name} ${dashboard.id}`;
      return text.toLowerCase().includes(query.toLowerCase());
    });
  }, [dashboards, query]);
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

  function markWorkflowDirty(workflowId) {
    saveRevisionRef.current += 1;
    const nextDirtyWorkflow = { id: workflowId, revision: saveRevisionRef.current };
    dirtyWorkflowRef.current = nextDirtyWorkflow;
    setDirtyWorkflow(nextDirtyWorkflow);
  }

  function updateActiveWorkflow(nextWorkflow) {
    const summarizedWorkflow = summarizeWorkflow(nextWorkflow, dataDir);
    const previousWorkflow = workflows.find((workflow) => workflow.id === summarizedWorkflow.id);
    if (!previousWorkflow || workflowEditSnapshotEquals(previousWorkflow, summarizedWorkflow)) {
      return;
    }
    workflowUndoHistoryRef.current = pushWorkflowEditHistory(
      workflowUndoHistoryRef.current,
      summarizedWorkflow.id,
      previousWorkflow,
    );
    workflowRedoHistoryRef.current = {
      ...workflowRedoHistoryRef.current,
      [summarizedWorkflow.id]: [],
    };
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === summarizedWorkflow.id ? summarizedWorkflow : workflow,
      ),
    );
    markWorkflowDirty(summarizedWorkflow.id);
  }

  function restoreWorkflowEdit(direction) {
    if (!activeWorkflow?.id) return;
    const workflowId = activeWorkflow.id;
    const sourceRef = direction === "undo" ? workflowUndoHistoryRef : workflowRedoHistoryRef;
    const targetRef = direction === "undo" ? workflowRedoHistoryRef : workflowUndoHistoryRef;
    const { history: nextSourceHistory, workflow: restoredWorkflow } = popWorkflowEditHistory(
      sourceRef.current,
      workflowId,
    );
    if (!restoredWorkflow) return;

    sourceRef.current = nextSourceHistory;
    targetRef.current = pushWorkflowEditHistory(
      targetRef.current,
      workflowId,
      activeWorkflow,
    );

    const summarizedWorkflow = summarizeWorkflow(restoredWorkflow, dataDir);
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === workflowId ? summarizedWorkflow : workflow,
      ),
    );
    markWorkflowDirty(workflowId);
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented) return;
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

      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
        event.preventDefault();
        restoreWorkflowEdit("undo");
      } else if (
        (event.ctrlKey || event.metaKey) &&
        (key === "y" || (key === "z" && event.shiftKey))
      ) {
        event.preventDefault();
        restoreWorkflowEdit("redo");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeWorkflow, dataDir]);

  async function saveWorkflow(workflow, revision) {
    setSaveState({ saving: true, error: "" });
    pendingWorkflowPersistenceRef.current.add(workflow.id);
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
    } finally {
      pendingWorkflowPersistenceRef.current.delete(workflow.id);
    }
  }

  async function persistWorkflow(workflow, auditMetadata = null) {
    const response = await fetch(
      apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...workflowPayloadForSave(workflow, dataDir),
          ...(auditMetadata ? { auditMetadata } : {}),
        }),
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Workflow API returned ${response.status}`);
    }
    return payload.workflow;
  }

  function openChatPatchReview({ message, prompt, thread }) {
    if (!activeWorkflow) return;
    const parsed = extractWorkflowPatch(message?.body ?? "");
    if (!parsed.ok) {
      setTopBarNotice({ type: "error", message: parsed.error });
      return;
    }
    const review = buildPatchReview(parsed.patch, activeWorkflow);
    setChatPatchReview({
      audit: {
        prompt: prompt?.body ?? "",
        response: message?.body ?? "",
        messageId: message?.id ?? null,
        threadId: thread?.id ?? null,
        threadTitle: thread?.title ?? "",
      },
      error: "",
      patch: parsed.patch,
      review,
      saving: false,
      workflowId: activeWorkflow.id,
    });
  }

  async function applyReviewedChatPatch(selectedHunkIds) {
    if (!chatPatchReview || !activeWorkflow) return;
    const patch = selectedPatchOperations(chatPatchReview.patch, selectedHunkIds);
    if (!patch.operations.length) {
      setChatPatchReview((current) => ({
        ...current,
        error: "Select at least one change to apply.",
      }));
      return;
    }

    setChatPatchReview((current) => ({ ...current, saving: true, error: "" }));
    try {
      const nextWorkflow = applyWorkflowPatch(activeWorkflow, patch);
      const validateResponse = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(nextWorkflow.id)}/validate`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workflowPayloadForSave(nextWorkflow, dataDir)),
        },
      );
      const validation = await validateResponse.json();
      if (!validateResponse.ok) {
        throw new Error(validation.error || `Workflow API returned ${validateResponse.status}`);
      }
      const validationErrors = (validation.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (validationErrors.length) {
        throw new Error(validationErrors.map((diagnostic) => diagnostic.message).join("; "));
      }

      setSaveState({ saving: true, error: "" });
      pendingWorkflowPersistenceRef.current.add(nextWorkflow.id);
      const savedWorkflow = await persistWorkflow(nextWorkflow, {
        source: "chat_patch",
        patchTitle: chatPatchReview.patch.title,
        appliedHunkIds: patch.operations.map((operation) => operation.id),
        prompt: chatPatchReview.audit.prompt,
        response: chatPatchReview.audit.response,
        messageId: chatPatchReview.audit.messageId,
        threadId: chatPatchReview.audit.threadId,
        threadTitle: chatPatchReview.audit.threadTitle,
      });
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === savedWorkflow.id
            ? summarizeWorkflow(mergeSavedWorkflow(nextWorkflow, savedWorkflow), dataDir)
            : candidate,
        ),
      );
      saveRevisionRef.current += 1;
      dirtyWorkflowRef.current = undefined;
      setDirtyWorkflow(undefined);
      setSaveState({ saving: false, error: "" });
      setTopBarNotice({ type: "success", message: "Applied chat workflow patch." });
      setChatPatchReview(null);
    } catch (error) {
      setChatPatchReview((current) => ({
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : "Unable to apply workflow patch",
      }));
      setSaveState({ saving: false, error: "" });
    } finally {
      pendingWorkflowPersistenceRef.current.delete(activeWorkflow?.id);
    }
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
    pendingWorkflowPersistenceRef.current.add(workflowToRun.id);

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
      const externalAccessWarnings = agentExternalAccessWarnings(savedWorkflow);
      if (externalAccessWarnings.length > 0) {
        const confirmed = window.confirm(
          [
            "Agent filesystem access outside working_dir:",
            "",
            ...externalAccessWarnings.map((warning) => `- ${warning}`),
            "",
            "Run this workflow?",
          ].join("\n"),
        );
        if (!confirmed) {
          setRunState({
            running: false,
            workflowId: savedWorkflow.id,
            error: "",
            result: null,
          });
          setLogState((current) => ({ ...current, loading: false }));
          return;
        }
      }

      const triggerContext = buildRunPreviewTriggerContext(savedWorkflow);
      const initialParameters = initialWorkflowParameters(savedWorkflow);
      const previewRequest = workflowPlanRequest(savedWorkflow.id, triggerContext, initialParameters);
      const previewResponse = await fetch(previewRequest.url, previewRequest.options);
      const previewPayload = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error(previewPayload.error || `Workflow API returned ${previewResponse.status}`);
      }
      setRunState({ running: false, workflowId: savedWorkflow.id, error: "", result: null });
      setLogState((current) => ({ ...current, loading: false }));
      setRunPreview({
        workflow: savedWorkflow,
        plan: previewPayload.plan,
        triggerContext,
        parameters: initialParameters,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, workflowId: workflowToRun.id, error: message, result: null });
      setSaveState((current) => ({ ...current, saving: false }));
      loadLatestLog(workflowToRun.id, { silent: true });
      loadRunLogs(workflowToRun.id, { silent: true });
    } finally {
      pendingWorkflowPersistenceRef.current.delete(workflowToRun.id);
    }
  }

  async function executeWorkflowRun(workflow, triggerContext = {}, parameters = {}) {
    setRunPreview(null);
    setRunState({ running: true, workflowId: workflow.id, error: "", result: null });
    setLogState((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedRunId: null,
    }));
    try {
      if (executionMode === "remote") {
        const response = await fetch(apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/queue`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trigger: "ui",
            parameters:
              Object.keys(parameters ?? {}).length > 0
                ? { triggerContext, workflowParams: parameters }
                : { triggerContext },
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `Queue API returned ${response.status}`);
        }
        setRunState({ running: false, workflowId: workflow.id, error: "", result: payload.run });
        setLogState((current) => ({ ...current, loading: false }));
        setTopBarNotice({
          type: "success",
          message: `Queued ${workflow.name} for remote execution`,
        });
        loadQueue({ silent: true });
        return;
      }
      const runRequest = workflowRunRequest(workflow.id, {
        dryRun: false,
        triggerContext,
        parameters,
      });
      const response = await fetch(runRequest.url, runRequest.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, workflowId: workflow.id, error: "", result: payload.run });
      const nextRunStatus =
        payload.run?.status === "stopped"
          ? "Stopped"
          : payload.run?.success
            ? "Success"
            : "Error";
      const nextRunTag =
        payload.run?.status === "stopped" ? "stopped" : payload.run?.success ? "success" : "error";
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === workflow.id
            ? {
                ...candidate,
                status: nextRunStatus,
                tags: [nextRunTag, ...(candidate.tags ?? []).slice(1)],
              }
            : candidate,
        ),
      );
      setLogState({
        loading: false,
        error: "",
        text: payload.run?.logText ?? "",
        path: payload.run?.logPath ?? null,
        nodeOutputs: payload.run?.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(payload.run?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: payload.run?.nodeOutputsMaxBytes ?? null,
        usageSummary: payload.run?.usageSummary ?? null,
        runEvents: payload.run?.runEvents ?? [],
        runNodes: payload.run?.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      loadRunLogs(workflow.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, workflowId: workflow.id, error: message, result: null });
      loadLatestLog(workflow.id, { silent: true });
      loadRunLogs(workflow.id, { silent: true });
    }
  }

  async function decideApproval(workflow, approval, decision, notes = "", by = "ui") {
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflow.id)}/approvals/${encodeURIComponent(
            approval.runId,
          )}/${encodeURIComponent(approval.nodeId)}/${decision === "approved" ? "approve" : "reject"}`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ by, notes }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setTopBarNotice({
        type: "success",
        message: decision === "approved" ? "Approval recorded" : "Rejection recorded",
      });
      setApprovalState((current) => ({
        ...current,
        approvals: current.approvals.map((candidate) =>
          candidate.runId === approval.runId && candidate.nodeId === approval.nodeId
            ? (payload.approval ?? {
                ...candidate,
                status: "decided",
                decision: { decision, decidedBy: by, notes },
              })
            : candidate,
        ),
      }));
      loadApprovals(workflow.id, { silent: true });
      loadLatestLog(workflow.id, { silent: true });
      loadRunLogs(workflow.id, { silent: true });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to record approval",
      });
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

  async function resumeWorkflowRunLog(workflowId, runId, options = {}) {
    if (!workflowId || !runId) return;

    setRunState({ running: true, workflowId, error: "", result: null, resumingRunId: runId });
    setLogState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const request = workflowResumeRequest(workflowId, runId, options);
      const response = await fetch(request.url, request.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, workflowId, error: "", result: payload.run });
      setLogState({
        loading: false,
        error: "",
        text: payload.run?.logText ?? "",
        path: payload.run?.logPath ?? null,
        nodeOutputs: payload.run?.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(payload.run?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: payload.run?.nodeOutputsMaxBytes ?? null,
        usageSummary: payload.run?.usageSummary ?? null,
        runEvents: payload.run?.runEvents ?? [],
        runNodes: payload.run?.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      setTopBarNotice({ type: "success", message: "Workflow run resumed" });
      loadWorkflows({ silent: true });
      loadRunLogs(workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resume workflow run";
      setRunState({ running: false, workflowId, error: message, result: null });
      setLogState((current) => ({ ...current, loading: false, error: message }));
      loadLatestLog(workflowId, { silent: true });
      loadRunLogs(workflowId, { silent: true });
    }
  }

  async function replayWorkflowTriggerLog(workflowId, runId, triggerId = null) {
    if (!workflowId || !runId) return;

    setRunState({ running: true, workflowId, error: "", result: null, resumingRunId: runId });
    setLogState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const request = workflowReplayTriggerRequest(workflowId, runId, triggerId);
      const response = await fetch(request.url, request.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const runPayload = payload.trigger?.run ?? payload.run ?? {};
      setRunState({ running: false, workflowId, error: "", result: runPayload });
      setLogState({
        loading: false,
        error: "",
        text: runPayload.logText ?? "",
        path: runPayload.logPath ?? null,
        nodeOutputs: runPayload.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(runPayload.nodeOutputsTruncated),
        nodeOutputsMaxBytes: runPayload.nodeOutputsMaxBytes ?? null,
        usageSummary: runPayload.usageSummary ?? null,
        runEvents: runPayload.runEvents ?? [],
        runNodes: runPayload.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      setTopBarNotice({ type: "success", message: "Webhook payload replayed" });
      loadWorkflows({ silent: true });
      loadRunLogs(workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to replay webhook payload";
      setRunState({ running: false, workflowId, error: message, result: null });
      setLogState((current) => ({ ...current, loading: false, error: message }));
      loadRunLogs(workflowId, { silent: true });
    }
  }

  async function pruneWorkflowRunLogs(workflowId, options = {}) {
    if (!workflowId) return;
    const dryRun = options.dryRun !== false;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs/prune`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dryRun,
            keepLast: options.keepLast ?? retentionSettings.keepLast,
            keepDays: options.keepDays ?? retentionSettings.keepDays,
            keepFailedDays: options.keepFailedDays ?? retentionSettings.keepFailedDays,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const count = payload.runs?.length ?? 0;
      setTopBarNotice({
        type: dryRun ? "info" : "success",
        message: dryRun
          ? `Retention preview: ${count} run${count === 1 ? "" : "s"} would be removed`
          : `Retention cleanup removed ${count} run${count === 1 ? "" : "s"}`,
      });
      loadRunLogs(workflowId, { silent: true });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to prune workflow runs",
      });
    }
  }

  async function createWorkflow(name, options = {}) {
    setCreateState({ saving: true, error: "" });
    try {
      const response = await fetch(apiUrl("/workflows"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, template: options.template || undefined }),
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

  async function loadWorkflowHistory(workflowId) {
    setHistoryState((current) => ({ ...current, error: "", loading: true }));
    try {
      const response = await fetch(apiUrl(`/workflows/${encodeURIComponent(workflowId)}/history`));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setHistoryState((current) => ({
        ...current,
        error: "",
        loading: false,
        revisions: payload.revisions ?? [],
      }));
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to load workflow history",
        loading: false,
      }));
    }
  }

  async function openWorkflowHistory(workflow) {
    if (!workflow?.id) return;
    setHistoryState({
      diff: null,
      error: "",
      loading: true,
      open: true,
      revisions: [],
    });
    await loadWorkflowHistory(workflow.id);
  }

  async function previewWorkflowRevision(workflowId, revisionId) {
    setHistoryState((current) => ({ ...current, error: "" }));
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/history/${encodeURIComponent(revisionId)}/diff`,
        ),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setHistoryState((current) => ({ ...current, diff: payload }));
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to load revision diff",
      }));
    }
  }

  async function restoreWorkflowRevision(workflowId, revisionId, { asCopy = false } = {}) {
    const action = asCopy ? "restore this revision as a copy" : "restore this revision";
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;
    setHistoryState((current) => ({ ...current, error: "", loading: true }));
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/history/${encodeURIComponent(revisionId)}/restore`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asCopy }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const restored = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(restored.id);
      setWorkflows((current) => {
        const withoutRestored = current.filter((candidate) => candidate.id !== restored.id);
        return [...withoutRestored, restored];
      });
      setActiveWorkflowId(restored.id);
      setHistoryState((current) => ({ ...current, loading: false, open: false }));
      setTopBarNotice({
        type: "success",
        message: asCopy ? `Restored ${restored.name} as a copy` : `Restored ${restored.name}`,
      });
      loadWorkflows({ silent: true });
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to restore workflow revision",
        loading: false,
      }));
    }
  }

  async function importWorkflow(file) {
    if (!file) return;
    try {
      if (isBundleFile(file)) {
        const bundleContent = await fileToBase64(file);
        let grantId = "";
        try {
          const selectedPath = await window.goferDesktop?.grantDroppedPath?.(file);
          grantId = window.goferDesktop?.workspace?.pathGrantForApi?.(selectedPath) || "";
        } catch {
          grantId = "";
        }
        const previewResponse = await fetch(apiUrl("/workflows/import/preview"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ bundleContent, filename: file.name, grantId }),
        });
        const previewPayload = await previewResponse.json();
        if (!previewResponse.ok) {
          throw new Error(previewPayload.error || `Workflow API returned ${previewResponse.status}`);
        }
        const plan = previewPayload.import;
        if (!window.confirm(formatBundleImportPreview(plan))) {
          return;
        }
        const importResponse = await fetch(apiUrl("/workflows/import"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ bundleContent, filename: file.name, grantId }),
        });
        const importPayload = await importResponse.json();
        if (!importResponse.ok) {
          throw new Error(importPayload.error || `Workflow API returned ${importResponse.status}`);
        }
        const imported = importPayload.import;
        deletedWorkflowIdsRef.current.delete(imported.workflowId);
        await loadWorkflows({ silent: true });
        setActiveWorkflowId(imported.workflowId);
        setTopBarNotice({ type: "success", message: `Imported ${imported.workflowName}` });
        return;
      }

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

  async function exportWorkflow(workflow) {
    if (!workflow) return;
    const defaultPath = `${dataDir ? `${dataDir.replace(/\/$/, "")}/` : ""}${workflow.id}.gof.zip`;
    setExportDialog({
      error: "",
      outputPath: defaultPath,
      saving: false,
      workflow,
    });
  }

  async function confirmExportWorkflow(outputPath) {
    const workflow = exportDialog.workflow;
    if (!workflow || !outputPath.trim()) return;
    setExportDialog((current) => ({ ...current, error: "", saving: true }));
    try {
      const trimmedOutputPath = outputPath.trim();
      const grantId = window.goferDesktop?.workspace?.pathGrantForApi?.(trimmedOutputPath) || "";
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/export`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ outputPath: trimmedOutputPath, grantId }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setExportDialog({ error: "", outputPath: "", saving: false, workflow: null });
      setTopBarNotice({ type: "success", message: `Exported bundle to ${payload.bundlePath}` });
    } catch (error) {
      setExportDialog((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to export workflow bundle",
        saving: false,
      }));
    }
  }

  async function chooseExportDestination(currentPath) {
    const workflow = exportDialog.workflow;
    if (!workflow || !window.goferDesktop?.workspace?.selectPath) return;
    try {
      const selectedPath = await window.goferDesktop.workspace.selectPath({
        currentPath: currentPath || dataDir,
        directoryOnly: true,
      });
      if (!selectedPath) return;
      const filename = `${workflow.id}.gof.zip`;
      const separator = selectedPath.includes("\\") ? "\\" : "/";
      const nextPath = `${selectedPath.replace(/[\\/]+$/, "")}${separator}${filename}`;
      setExportDialog((current) => ({ ...current, outputPath: nextPath }));
    } catch (error) {
      setExportDialog((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to choose export destination",
      }));
    }
  }

  async function deleteWorkflow(workflow) {
    if (!workflow) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;

    try {
      setCreateState({ saving: false, error: "" });
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
              nodeOutputs: null,
              nodeOutputsTruncated: false,
              nodeOutputsMaxBytes: null,
              usageSummary: null,
              runEvents: [],
              runNodes: {},
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
    if (!workflow) return null;
    if (!nextName || nextName.trim() === workflow.name) return workflow;

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
      return renamed;
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to rename workflow",
      });
      return null;
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

  async function changeDataDir() {
    if (!window.goferDesktop?.dataDirectory?.choose) {
      setTopBarNotice({
        type: "error",
        message: "Changing the app data folder is only available in the desktop app",
      });
      return;
    }

    try {
      setTopBarNotice({ type: "success", message: "Switching app data folder..." });
      const result = await window.goferDesktop.dataDirectory.choose({ currentPath: dataDir });
      if (!result?.dataDir) {
        setTopBarNotice({ type: "", message: "" });
        return;
      }
      setDataDir(result.dataDir);
      await loadWorkflows();
      await loadDashboards();
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to change app data folder",
      });
    }
  }

  async function dashboardRequest(path, options = {}) {
    const method = options.method ?? "GET";
    const tracksMutation = method !== "GET";
    if (tracksMutation) {
      pendingDashboardMutationsRef.current += 1;
    }
    try {
      const response = await fetch(apiUrl(path), {
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        ...options,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Dashboard API returned ${response.status}`);
      }
      if (payload.dashboard) {
        setDashboards((current) => {
          const exists = current.some((dashboard) => dashboard.id === payload.dashboard.id);
          return exists
            ? current.map((dashboard) =>
                dashboard.id === payload.dashboard.id ? payload.dashboard : dashboard,
              )
            : [payload.dashboard, ...current];
        });
        setActiveDashboardId(payload.dashboard.id);
      }
      return payload;
    } finally {
      if (tracksMutation) {
        pendingDashboardMutationsRef.current = Math.max(
          0,
          pendingDashboardMutationsRef.current - 1,
        );
      }
    }
  }

  async function createDashboard() {
    try {
      await dashboardRequest("/dashboards", {
        method: "POST",
        body: JSON.stringify({ name: "New Dashboard" }),
      });
      setWorkspaceMode("dashboards");
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to create dashboard",
      });
    }
  }

  async function duplicateDashboard(dashboard) {
    if (!dashboard) return;
    try {
      await dashboardRequest(`/dashboards/${encodeURIComponent(dashboard.id)}`, {
        method: "POST",
        body: JSON.stringify({ duplicate: true }),
      });
      setWorkspaceMode("dashboards");
      setTopBarNotice({ type: "success", message: `Duplicated ${dashboard.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to duplicate dashboard",
      });
    }
  }

  async function deleteDashboard(dashboard) {
    if (!dashboard || !window.confirm(`Delete dashboard "${dashboard.name}"?`)) return;
    try {
      await dashboardRequest(`/dashboards/${encodeURIComponent(dashboard.id)}`, { method: "DELETE" });
      await loadDashboards();
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to delete dashboard",
      });
    }
  }

  async function mutateDashboard(path, body) {
    try {
      await dashboardRequest(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to update dashboard",
      });
    }
  }

  function updateDashboardLocally(dashboardId, updater) {
    setDashboards((current) =>
      current.map((dashboard) => (dashboard.id === dashboardId ? updater(dashboard) : dashboard)),
    );
  }

  return (
    <main className={`flex h-screen min-h-[720px] min-w-[1180px] bg-canvas text-ink ${theme}`}>
      <WorkflowSidebar
        activeDashboardId={activeDashboard?.id}
        activeWorkflowId={activeWorkflow?.id}
        dashboards={filteredDashboards}
        dataDir={dataDir}
        loading={loadState.loading}
        query={query}
        runState={runState}
        workspaceMode={workspaceMode}
        workflows={filteredWorkflows}
        width={workflowPaneWidth}
        onCreateDashboard={createDashboard}
        onQueryChange={setQuery}
        onCreate={() => {
          setCreateState({ saving: false, error: "" });
          setCreateDialogOpen(true);
        }}
        onDataDirPick={changeDataDir}
        onDeleteDashboard={deleteDashboard}
        onDeleteWorkflow={deleteWorkflow}
        onDuplicateWorkflow={duplicateWorkflow}
        onRefresh={loadWorkflows}
        onRenameWorkflow={renameWorkflow}
        onRunWorkflow={runWorkflowNow}
        onSelectDashboard={(dashboardId) => {
          setActiveDashboardId(dashboardId);
          setWorkspaceMode("dashboards");
        }}
        onResizeStart={(event) =>
          startPaneResize(event, {
            max: 420,
            min: 240,
            side: "right",
            width: workflowPaneWidth,
            onResize: setWorkflowPaneWidth,
          })
        }
        onSelect={(workflowId) => {
          setActiveWorkflowId(workflowId);
          setWorkspaceMode("workflows");
        }}
        onWorkspaceModeChange={setWorkspaceMode}
      />

      <section className="flex min-w-0 flex-1 flex-col border-x border-line bg-[#f9fbfd]">
        {workspaceMode === "dashboards" ? (
          <DashboardWorkspace
            dashboard={activeDashboard}
            loading={loadState.loading}
            notice={topBarNotice}
            onAddComponent={(dashboard, section, type = "board") =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/sections/${encodeURIComponent(section.id)}`,
                { title: dashboardComponentLabel(type), type },
              )
            }
            onAddDashboard={createDashboard}
            onAddItem={(dashboard, component, item) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}/items`,
                { action: "add", item },
              )
            }
            onAddSection={(dashboard) =>
              mutateDashboard(`/dashboards/${encodeURIComponent(dashboard.id)}/sections`, {
                title: "New Section",
              })
            }
            onDeleteDashboard={deleteDashboard}
            onDuplicateDashboard={duplicateDashboard}
            onDeleteSection={(dashboard, section) => {
              if (!window.confirm(`Delete section "${section.title}"?`)) return;
              dashboardRequest(
                `/dashboards/${encodeURIComponent(dashboard.id)}/sections/${encodeURIComponent(section.id)}`,
                { method: "DELETE" },
              ).catch((error) =>
                setTopBarNotice({
                  type: "error",
                  message: error instanceof Error ? error.message : "Unable to delete dashboard section",
                }),
              );
            }}
            onDeleteComponent={(dashboard, component) => {
              if (!window.confirm(`Remove "${component.title}" from this section?`)) return;
              updateDashboardLocally(dashboard.id, (currentDashboard) => ({
                ...currentDashboard,
                sections: (currentDashboard.sections ?? []).map((section) => ({
                  ...section,
                  components: (section.components ?? []).filter((item) => item.id !== component.id),
                })),
              }));
              dashboardRequest(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { method: "DELETE" },
              ).catch((error) =>
                setTopBarNotice({
                  type: "error",
                  message: error instanceof Error ? error.message : "Unable to remove dashboard component",
                }),
              );
            }}
            onDeleteItem={(dashboard, component, item) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}/items`,
                { action: "delete", itemId: item.id },
              )
            }
            onRename={(dashboard, name) =>
              mutateDashboard(`/dashboards/${encodeURIComponent(dashboard.id)}`, { name })
            }
            onUpdateSection={(dashboard, section, patch) => {
              updateDashboardLocally(dashboard.id, (currentDashboard) => ({
                ...currentDashboard,
                sections: (currentDashboard.sections ?? []).map((item) =>
                  item.id === section.id
                    ? {
                        ...item,
                        ...("title" in patch ? { title: patch.title } : {}),
                        layout: patch.layout ? { ...(item.layout ?? {}), ...patch.layout } : item.layout,
                      }
                    : item,
                ),
              }));
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/sections/${encodeURIComponent(section.id)}`,
                patch,
              );
            }}
            onSetSchema={(dashboard, component, schema) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { schema },
              )
            }
            onSetViews={(dashboard, component, views) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { views },
              )
            }
            onSetContent={(dashboard, component, content) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { content },
              )
            }
            onSetComponentTitle={(dashboard, component, title) => {
              updateDashboardLocally(dashboard.id, (currentDashboard) => ({
                ...currentDashboard,
                sections: (currentDashboard.sections ?? []).map((section) => ({
                  ...section,
                  components: (section.components ?? []).map((item) =>
                    item.id === component.id ? { ...item, title } : item,
                  ),
                })),
              }));
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { title },
              );
            }}
            onSetDisplay={(dashboard, component, display) => {
              updateDashboardLocally(dashboard.id, (currentDashboard) => ({
                ...currentDashboard,
                sections: (currentDashboard.sections ?? []).map((section) => ({
                  ...section,
                  components: (section.components ?? []).map((item) =>
                    item.id === component.id ? { ...item, display } : item,
                  ),
                })),
              }));
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}`,
                { display },
              );
            }}
            onUpdateItem={(dashboard, component, item, patch) =>
              mutateDashboard(
                `/dashboards/${encodeURIComponent(dashboard.id)}/components/${encodeURIComponent(component.id)}/items`,
                { action: "update", itemId: item.id, patch },
              )
            }
          />
        ) : activeWorkflow ? (
          <>
            <TopBar
              theme={theme}
              updateState={updateState}
              workflow={activeWorkflow}
              onCheckForUpdates={() => checkForUpdates()}
              onApplyUpdate={() => applyUpdate(updateState)}
              onOpenHistory={() => openWorkflowHistory(activeWorkflow)}
              onToggleTheme={() =>
                setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))
              }
            />
            <WorkflowHealthPanel doctorState={doctorState} workflow={activeWorkflow} />
            <DagCanvas
              dashboards={dashboards}
              dataDir={dataDir}
              logState={logState}
              approvalState={approvalState}
              notice={topBarNotice}
              retentionSettings={retentionSettings}
              runState={runState}
              workflow={activeWorkflow}
              workflows={workflows}
              usedAgentIds={usedAgentIds}
              onLoadLatestLog={() => loadLatestLog(activeWorkflow.id)}
              onSelectRunLog={(runId) => loadRunLog(activeWorkflow.id, runId)}
              onStopRunLog={(runId) => stopWorkflowRunLog(activeWorkflow.id, runId)}
              onResumeRunLog={(runId, options) =>
                resumeWorkflowRunLog(activeWorkflow.id, runId, options)
              }
              onReplayRunLog={(runId, triggerId) =>
                replayWorkflowTriggerLog(activeWorkflow.id, runId, triggerId)
              }
              onPruneRunLogs={(options) => pruneWorkflowRunLogs(activeWorkflow.id, options)}
              onRetentionSettingsChange={(nextSettings) =>
                saveRetentionSettingsForWorkflow(activeWorkflow.id, nextSettings)
              }
              onImportWorkflow={importWorkflow}
              onExportWorkflow={() => exportWorkflow(activeWorkflow)}
              onRunWorkflow={runWorkflowNow}
              onValidateWorkflow={() => validateWorkflow(activeWorkflow)}
              onStopWorkflow={stopWorkflowRun}
              onNavigateWorkflow={(workflowId) => {
                if (workflowId) {
                  setActiveWorkflowId(workflowId);
                  setWorkspaceMode("workflows");
                }
              }}
              onRenameWorkflow={(workflowId, nextName) => {
                const targetWorkflow = workflows.find((candidate) => candidate.id === workflowId);
                return renameWorkflow(targetWorkflow, nextName);
              }}
              onDecideApproval={(approval, decision, notes, by) =>
                decideApproval(activeWorkflow, approval, decision, notes, by)
              }
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
        onReviewPatch={openChatPatchReview}
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
      {runPreview ? (
        <RunPreviewDialog
          plan={runPreview.plan}
          workflow={runPreview.workflow}
          onCancel={() => setRunPreview(null)}
          initialParameters={runPreview.parameters}
          onRun={(parameters) =>
            executeWorkflowRun(runPreview.workflow, runPreview.triggerContext, parameters)
          }
          executionMode={executionMode}
          onExecutionModeChange={setExecutionMode}
          queueState={queueState}
        />
      ) : null}
      {chatPatchReview ? (
        <ChatPatchReviewDialog
          reviewState={chatPatchReview}
          onApply={applyReviewedChatPatch}
          onCancel={() => setChatPatchReview(null)}
        />
      ) : null}
      <CreateWorkflowDialog
        error={createState.error}
        open={createDialogOpen}
        saving={createState.saving}
        templates={workflowTemplates}
        onClose={() => {
          if (!createState.saving) {
            setCreateDialogOpen(false);
            setCreateState({ saving: false, error: "" });
          }
        }}
        onCreate={createWorkflow}
      />

      <ExportWorkflowDialog
        error={exportDialog.error}
        open={Boolean(exportDialog.workflow)}
        outputPath={exportDialog.outputPath}
        saving={exportDialog.saving}
        workflow={exportDialog.workflow}
        onClose={() => {
          if (!exportDialog.saving) {
            setExportDialog({ error: "", outputPath: "", saving: false, workflow: null });
          }
        }}
        onExport={confirmExportWorkflow}
        onBrowse={
          window.goferDesktop?.workspace?.selectPath ? chooseExportDestination : null
        }
      />

      {historyState.open && activeWorkflow ? (
        <WorkflowHistoryDialog
          diff={historyState.diff}
          error={historyState.error}
          loading={historyState.loading}
          revisions={historyState.revisions}
          workflow={activeWorkflow}
          onClose={() => setHistoryState((current) => ({ ...current, open: false }))}
          onRefresh={() => loadWorkflowHistory(activeWorkflow.id)}
          onPreview={(revisionId) => previewWorkflowRevision(activeWorkflow.id, revisionId)}
          onRestore={(revisionId, options) =>
            restoreWorkflowRevision(activeWorkflow.id, revisionId, options)
          }
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

export function summarizeWorkflow(workflow, dataDir = "") {
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
    }${Object.values(workflow.webhooks ?? {}).some((config) => config?.enabled) ? " API trigger enabled." : ""
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

export function mergeSavedWorkflow(localWorkflow, savedWorkflow) {
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

export function preserveLocalWorkflow(remoteWorkflows, localWorkflow, dataDir = "") {
  return preserveLocalWorkflows(remoteWorkflows, [localWorkflow], dataDir);
}

export function preserveLocalWorkflows(remoteWorkflows, localWorkflows, dataDir = "") {
  const localById = new Map(
    (localWorkflows ?? []).filter(Boolean).map((workflow) => [workflow.id, workflow]),
  );
  if (!localById.size) {
    return remoteWorkflows;
  }
  const merged = remoteWorkflows.map((workflow) => {
    const localWorkflow = localById.get(workflow.id);
    return localWorkflow
      ? summarizeWorkflow({
          ...localWorkflow,
          sourcePath: workflow.sourcePath ?? localWorkflow.sourcePath,
          status: workflow.status ?? localWorkflow.status,
          updatedAt: workflow.updatedAt ?? localWorkflow.updatedAt,
        }, dataDir)
      : workflow;
  });
  localById.forEach((localWorkflow) => {
    if (!remoteWorkflows.some((workflow) => workflow.id === localWorkflow.id)) {
      merged.push(localWorkflow);
    }
  });
  return merged;
}

export function workflowPayloadForSave(workflow, dataDir = "") {
  return {
    ...workflow,
    filesystemAccess: normalizeWorkflowFilesystemAccess([
      dataDir ? { path: dataDir } : null,
      ...(workflow.filesystemAccess ?? []),
    ]),
    nodes: (workflow.nodes ?? []).map((node) => ({
      ...node,
      x: node.x ?? 0,
      y: node.y ?? 0,
    })),
    edges: workflow.edges ?? [],
    agents: workflow.agents ?? {},
  };
}

export function normalizeWorkflowFilesystemAccess(entries = []) {
  const seen = new Set();
  return (entries ?? [])
    .map((entry) => ({
      path: String(entry?.path ?? "").trim(),
      read: true,
      write: true,
      execute: false,
    }))
    .filter((entry) => {
      const key = entry.path.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function workflowPlanRequest(workflowId, triggerContext = {}, parameters = {}) {
  const body = { triggerContext };
  if (Object.keys(parameters ?? {}).length > 0) {
    body.parameters = parameters;
  }
  return {
    url: apiUrl(`/workflows/${encodeURIComponent(workflowId)}/plan`),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function workflowRunRequest(
  workflowId,
  { dryRun = false, triggerContext = {}, parameters = {} } = {},
) {
  const body = { dryRun, triggerContext };
  if (Object.keys(parameters ?? {}).length > 0) {
    body.parameters = parameters;
  }
  return {
    url: apiUrl(`/workflows/${encodeURIComponent(workflowId)}/run`),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function workflowResumeRequest(
  workflowId,
  runId,
  { force = false, fromNode = null, onlyNode = null, skipCache = false, triggerContext = {} } = {},
) {
  return {
    url: apiUrl(
      `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/resume`,
    ),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ force, fromNode, onlyNode, skipCache, triggerContext }),
    },
  };
}

export function workflowReplayTriggerRequest(workflowId, runId, triggerId = null) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const encodedTriggerId = encodeURIComponent(triggerId || "default");
  return {
    url: apiUrl(
      `/workflows/${encodedWorkflowId}/webhooks/${encodedTriggerId}/replay`,
    ),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId }),
    },
  };
}

export function workflowLogUrls(workflowId, runId = null) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const selectedParams = new URLSearchParams({
    tailBytes: String(RUN_LOG_TAIL_BYTES),
    details: "0",
  });
  return {
    latest: apiUrl(`/workflows/${encodedWorkflowId}/logs/latest`),
    runs: apiUrl(`/workflows/${encodedWorkflowId}/logs`),
    selected: runId
      ? `${apiUrl(
          `/workflows/${encodedWorkflowId}/logs/${encodeURIComponent(runId)}`,
        )}?${selectedParams}`
      : null,
  };
}

export function chatStreamRequestBody({ provider, model, messages, workflow }) {
  return {
    provider,
    model,
    messages,
    workflow,
  };
}

export function workflowIdsAfterDelete(workflows, deletedWorkflowId) {
  return workflows
    .filter((workflow) => workflow.id !== deletedWorkflowId)
    .map((workflow) => workflow.id);
}

export function nextActiveWorkflowIdAfterDelete(workflows, activeWorkflowId, deletedWorkflowId) {
  if (activeWorkflowId !== deletedWorkflowId) return activeWorkflowId;
  return workflows.find((workflow) => workflow.id !== deletedWorkflowId)?.id;
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
  activeDashboardId,
  activeWorkflowId,
  dashboards,
  dataDir,
  loading,
  query,
  runState,
  workspaceMode,
  workflows,
  onCreateDashboard,
  onCreate,
  onDataDirPick,
  onDeleteDashboard,
  onDeleteWorkflow,
  onDuplicateWorkflow,
  onQueryChange,
  onRefresh,
  onRenameWorkflow,
  onResizeStart,
  onRunWorkflow,
  onSelectDashboard,
  onSelect,
  onWorkspaceModeChange,
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
    await window.goferDesktop?.workspace?.openPath?.(dataDir);
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

        <div className="mt-5 grid grid-cols-2 gap-2 rounded-lg border border-line bg-slate-50 p-1">
          <button
            className={`flex h-8 items-center justify-center gap-2 rounded-md text-xs font-medium transition ${
              workspaceMode === "workflows"
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
            type="button"
            onClick={() => onWorkspaceModeChange("workflows")}
          >
            <Waypoints size={14} />
            Workflows
          </button>
          <button
            className={`flex h-8 items-center justify-center gap-2 rounded-md text-xs font-medium transition ${
              workspaceMode === "dashboards"
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
            type="button"
            onClick={() => onWorkspaceModeChange("dashboards")}
          >
            <Database size={14} />
            Dashboards
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2">
          <Search size={16} className="text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            placeholder={workspaceMode === "dashboards" ? "Search dashboards" : "Search workflows"}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListFilter size={16} className="text-muted" />
          {workspaceMode === "dashboards" ? "Dashboards" : "Workflows"}
        </div>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
          title={workspaceMode === "dashboards" ? "Create dashboard" : "Create workflow"}
          type="button"
          onClick={workspaceMode === "dashboards" ? onCreateDashboard : onCreate}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="workflow-scrollbar flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {workspaceMode === "dashboards" ? (
          dashboards.length ? (
            dashboards.map((dashboard) => (
              <DashboardListItem
                key={dashboard.id}
                active={dashboard.id === activeDashboardId}
                dashboard={dashboard}
                onDelete={() => onDeleteDashboard(dashboard)}
                onSelect={() => onSelectDashboard(dashboard.id)}
              />
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-slate-50 p-4 text-sm leading-6 text-muted">
              {loading ? "Loading dashboards..." : "No dashboards found."}
            </div>
          )
        ) : workflows.length ? (
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

function DashboardListItem({ active, dashboard, onDelete, onSelect }) {
  const itemCount = (dashboard.sections ?? []).reduce(
    (total, section) =>
      total +
      (section.components ?? []).reduce(
        (componentTotal, component) => componentTotal + (component.items?.length ?? 0),
        0,
      ),
    0,
  );
  return (
    <div
      className={`group rounded-lg border p-3 transition ${
        active ? "border-teal-200 bg-teal-50" : "border-line bg-white hover:border-slate-300"
      }`}
    >
      <button className="w-full text-left" type="button" onClick={onSelect}>
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-slate-100 text-muted">
            <Database size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">{dashboard.name}</div>
            <div className="mt-1 truncate text-xs text-muted">{dashboard.id}</div>
            <div className="mt-2 text-xs text-muted">
              {(dashboard.sections ?? []).length} sections · {itemCount} items
            </div>
          </div>
        </div>
      </button>
      <div className="mt-2 flex justify-end opacity-0 transition group-hover:opacity-100">
        <button
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
          title="Delete dashboard"
          type="button"
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </button>
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
  onOpenHistory,
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
          title="Workflow history"
          type="button"
          onClick={onOpenHistory}
        >
          <History size={16} />
        </button>
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

function WorkflowHistoryDialog({
  diff,
  error,
  loading,
  revisions,
  workflow,
  onClose,
  onPreview,
  onRefresh,
  onRestore,
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <div className="flex max-h-[86vh] w-full max-w-[920px] flex-col rounded-lg border border-line bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Workflow history</h2>
            <p className="truncate text-xs text-muted">
              {workflow.name} · {workflow.id}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:bg-slate-50 hover:text-ink"
              title="Refresh history"
              type="button"
              onClick={onRefresh}
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
              title="Close"
              type="button"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden">
          <div className="workflow-scrollbar min-h-0 overflow-y-auto border-r border-line">
            {error ? (
              <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}
            {loading && !revisions.length ? (
              <div className="px-4 py-6 text-sm text-muted">Loading history...</div>
            ) : null}
            {!loading && !revisions.length ? (
              <div className="px-4 py-6 text-sm text-muted">No revisions found.</div>
            ) : null}
            {revisions.map((revision) => (
              <div key={revision.revisionId} className="border-b border-line px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {formatRevisionDate(revision.createdAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {revision.source} · {revision.author}
                    </p>
                  </div>
                  <button
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-slate-50 hover:text-ink"
                    type="button"
                    onClick={() => onPreview(revision.revisionId)}
                  >
                    Diff
                  </button>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {(revision.summary ?? []).slice(0, 4).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <button
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => onRestore(revision.revisionId)}
                  >
                    Restore
                  </button>
                  <button
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => onRestore(revision.revisionId, { asCopy: true })}
                  >
                    Restore as copy
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="min-h-0 overflow-hidden">
            {diff ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-line px-4 py-3">
                  <p className="text-sm font-semibold">Revision diff</p>
                  <p className="mt-1 text-xs text-muted">
                    {(diff.summary ?? []).join("; ") || "No material changes"}
                  </p>
                </div>
                <pre className="workflow-scrollbar min-h-0 flex-1 overflow-auto bg-[#0f172a] p-4 text-xs leading-5 text-slate-100">
                  {diff.tomlDiff || "No TOML diff."}
                </pre>
              </div>
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-muted">
                Select a revision diff to inspect TOML and graph-level changes.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRevisionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function ChatPane({ activeWorkflowId, onResizeStart, onReviewPatch, width, workflow, workflows }) {
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
        body: JSON.stringify(chatStreamRequestBody({
          provider: providerId,
          model,
          messages: nextMessages.map(({ role, body }) => ({ role, body })),
          workflow: {
            ...workflowContext,
            id: `workflow-assistant:${targetThreadId}`,
            chatThreadId: targetThreadId,
          },
        })),
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

  function reviewPatchMessage(message) {
    const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
    const prompt = messages
      .slice(0, Math.max(0, messageIndex))
      .reverse()
      .find((candidate) => candidate.role === "user");
    onReviewPatch?.({ message, prompt, thread: activeThread });
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
                <ChatMessageBubble
                  key={item.message.id}
                  message={item.message}
                  workflow={workflow}
                  onReviewPatch={reviewPatchMessage}
                />
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

function ChatPatchReviewDialog({ onApply, onCancel, reviewState }) {
  const hunks = reviewState.review.hunks;
  const [selectedIds, setSelectedIds] = useState(() => hunks.map((hunk) => hunk.id));
  const grouped = groupPatchHunksByRisk(hunks);
  const canApply = reviewState.review.ok && selectedIds.length > 0 && !reviewState.saving;

  function toggleHunk(hunkId) {
    setSelectedIds((current) =>
      current.includes(hunkId)
        ? current.filter((candidate) => candidate !== hunkId)
        : [...current, hunkId],
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 px-4">
      <section className="max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-white shadow-panel">
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-ink">Review workflow patch</h2>
              <p className="mt-1 text-sm text-muted">{reviewState.review.title}</p>
            </div>
            <button
              className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-ink"
              title="Close patch review"
              type="button"
              onClick={onCancel}
            >
              <X size={16} />
            </button>
          </div>
          {reviewState.review.summary ? (
            <p className="mt-3 text-sm leading-6 text-slate-700">{reviewState.review.summary}</p>
          ) : null}
        </div>
        <div className="workflow-scrollbar max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
          {reviewState.review.errors.length ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">
              <div className="font-semibold">Patch rejected</div>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {reviewState.review.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {reviewState.error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">
              {reviewState.error}
            </div>
          ) : null}
          {grouped.map(([risk, riskHunks]) => (
            <section key={risk} className="rounded-lg border border-line">
              <div className="border-b border-line bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                {riskLabel(risk)}
              </div>
              <div className="divide-y divide-line">
                {riskHunks.map((hunk) => (
                  <label
                    key={hunk.id}
                    className="flex cursor-pointer items-start gap-3 px-3 py-3 transition hover:bg-slate-50"
                  >
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={selectedIds.includes(hunk.id)}
                      disabled={!reviewState.review.ok || reviewState.saving}
                      onChange={() => toggleHunk(hunk.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{hunk.label}</span>
                      <span className="mt-1 block break-words text-xs leading-5 text-muted">
                        {hunk.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          <p className="text-xs text-muted">
            Applying changes validates the draft and saves a revision with chat audit metadata.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              type="button"
              disabled={reviewState.saving}
              onClick={onCancel}
            >
              Reject
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={!canApply}
              onClick={() => onApply(selectedIds)}
            >
              {reviewState.saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              Apply selected
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function groupPatchHunksByRisk(hunks) {
  const order = ["destructive", "filesystem", "secret", "trigger", "agent", "graph", "workflow"];
  const grouped = new Map();
  for (const hunk of hunks) {
    if (!grouped.has(hunk.risk)) grouped.set(hunk.risk, []);
    grouped.get(hunk.risk).push(hunk);
  }
  return [...grouped.entries()].sort(
    ([left], [right]) => order.indexOf(left) - order.indexOf(right),
  );
}

function riskLabel(risk) {
  return {
    agent: "Agents",
    destructive: "Destructive changes",
    filesystem: "Filesystem access",
    graph: "Graph changes",
    secret: "Secrets and parameters",
    trigger: "Triggers",
    workflow: "Workflow settings",
  }[risk] ?? risk;
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

function ChatMessageBubble({ message, onReviewPatch, workflow }) {
  const isSystem = message.role === "system" || message.kind === "system";
  const patchParse = message.role === "assistant" ? extractWorkflowPatch(message.body) : null;
  const review = patchParse?.ok ? buildPatchReview(patchParse.patch, workflow) : null;
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
        {review ? (
          <div className="mt-3 rounded-md border border-teal-200 bg-teal-50 p-2">
            <div className="text-xs font-semibold text-teal-800">{review.title}</div>
            <div className="mt-1 text-xs text-teal-700">
              {review.hunks.length} proposed change{review.hunks.length === 1 ? "" : "s"}
              {review.errors.length ? `, ${review.errors.length} validation issue${review.errors.length === 1 ? "" : "s"}` : ""}
            </div>
            <button
              className="mt-2 inline-flex h-8 items-center gap-2 rounded-md border border-teal-200 bg-white px-2.5 text-xs font-semibold text-teal-800 transition hover:bg-teal-100"
              type="button"
              onClick={() => onReviewPatch?.(message)}
            >
              <GitBranch size={13} />
              Review patch
            </button>
          </div>
        ) : null}
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

export function loadChatThreads() {
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

export function persistChatThreads(threads) {
  window.localStorage.setItem(chatThreadsStorageKey, JSON.stringify(threads));
}

export function threadTitleFromMessage(message) {
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

export function chatStorageKeyFor(threadId) {
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

export function buildChatItems(messages) {
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

export function parseChatStreamEvent(line) {
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

function formatPreviewValue(value) {
  if (value && typeof value === "object") {
    if (typeof value.path === "string") return value.path;
    if (typeof value.name === "string") return value.name;
    return JSON.stringify(value);
  }
  return String(value);
}

function formatFanOutCount(fanOut) {
  if (!fanOut || fanOut.count == null) return "unknown";
  if (fanOut.countExact === false) {
    return `at least ${fanOut.countLowerBound ?? fanOut.count}`;
  }
  return String(fanOut.count);
}

function formatNetworkAllowlistItems(sideEffectDetails) {
  return (sideEffectDetails ?? [])
    .filter(
      (detail) =>
        detail?.kind === "network" &&
        Array.isArray(detail.networkAllowlist) &&
        detail.networkAllowlist.length > 0,
    )
    .map((detail) => {
      const host = detail.host ? ` ${detail.host}` : "";
      return `Network allowlist${host}: ${detail.networkAllowlist.join(", ")}`;
    });
}

function formatValidationItems(validation) {
  const diagnostics = Array.isArray(validation?.diagnostics) ? validation.diagnostics : [];
  return diagnostics.map((item) => {
    const severity = item.severity ?? "warning";
    const subject = item.subject || item.targetId;
    return `${severity}: ${item.message}${subject ? ` (${subject})` : ""}`;
  });
}

function hasBlockingValidationErrors(validation) {
  if (validation?.ok === false) return true;
  const diagnostics = Array.isArray(validation?.diagnostics) ? validation.diagnostics : [];
  return diagnostics.some((item) => item?.severity === "error");
}

function formatSecretItem(item) {
  if (item && typeof item === "object") return item.name ?? "";
  return String(item);
}

function formatSecretReadinessItems(readiness) {
  return (readiness ?? []).map((item) => {
    const status = item.present || item.status === "present" ? "present" : "missing";
    const sources = Array.isArray(item.sources) && item.sources.length ? ` (${item.sources.join(", ")})` : "";
    return `${item.name}: ${status}${sources}`;
  });
}

function formatConditionalBranchItems(branches) {
  return (branches ?? []).map(
    (branch) => `${branch.from} -> ${branch.to} when ${branch.label ?? branch.condition}`,
  );
}

function formatResourceLimitItems(resourceLimits, executionLimits) {
  if (!resourceLimits || typeof resourceLimits !== "object") return [];
  return [
    `Fan-out items: ${resourceLimits.max_fanout_items}`,
    `Fan-out concurrency: ${resourceLimits.max_fanout_concurrency}`,
    `Files scanned: ${resourceLimits.max_files_scanned}`,
    `File read bytes: ${resourceLimits.max_file_read_bytes}`,
    `Total node runs: ${executionLimits?.maxTotalNodeRuns ?? "default"}`,
  ];
}

function formatUsageBudgetItems(usageBudget) {
  if (!usageBudget?.enabled) return [];
  return Object.entries(usageBudget)
    .filter(([key, value]) => key !== "enabled" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`);
}

function formatProjectedUsageItems(projectedUsage) {
  if (!projectedUsage || !projectedUsage.agent_calls) return [];
  return [
    `Agent calls: ${projectedUsage.agent_calls}`,
    `Tokens: ${projectedUsage.total_tokens}`,
    `Estimated cost: $${Number(projectedUsage.estimated_cost || 0).toFixed(6)}`,
    `Agent time: ${Number(projectedUsage.agent_time_seconds || 0).toFixed(2)}s`,
  ];
}

function formatTriggerContextItems(triggerContext) {
  if (!triggerContext || typeof triggerContext !== "object") return [];
  const items = [];
  if (triggerContext.schedule) {
    const schedule = triggerContext.schedule;
    items.push(
      `Schedule: ${schedule.cron_expression ?? schedule.cron ?? "configured"} timezone=${schedule.timezone ?? "local"}`,
    );
  }
  if (triggerContext.watch) {
    const watch = triggerContext.watch;
    items.push(
      `Watch: ${watch.path ?? ""} glob=${watch.glob ?? "*"} mode=${watch.mode ?? "batch"}`,
    );
  }
  if (triggerContext.runContinuously) {
    items.push("Run continuously: enabled");
  }
  if (triggerContext.provided) {
    items.push(`Provided trigger context: ${JSON.stringify(triggerContext.provided)}`);
  }
  return items;
}

function buildRunPreviewTriggerContext(workflow) {
  const triggerContext = {};
  if (workflow.schedule) {
    triggerContext.schedule = workflow.schedule;
  }
  if (workflow.watch) {
    triggerContext.watch = workflow.watch;
  }
  if (workflow.runContinuously) {
    triggerContext.runContinuously = true;
  }
  return triggerContext;
}

function initialWorkflowParameters(workflow) {
  const values = {};
  for (const [name, spec] of Object.entries(workflow.parameters ?? {})) {
    if (spec.default !== undefined && spec.default !== null) {
      values[name] = spec.default;
    } else if (spec.type === "boolean") {
      values[name] = false;
    } else {
      values[name] = "";
    }
  }
  return values;
}

function validateWorkflowParameters(workflow, values) {
  const errors = {};
  for (const [name, spec] of Object.entries(workflow.parameters ?? {})) {
    const value = values[name];
    if (spec.required && (value === undefined || value === null || value === "")) {
      errors[name] = "Required";
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (spec.type === "number" && Number.isNaN(Number(value))) {
      errors[name] = "Enter a number";
    }
    if (spec.type === "enum" && Array.isArray(spec.choices) && !spec.choices.includes(value)) {
      errors[name] = "Choose a valid option";
    }
  }
  return errors;
}

export function RunPreviewDialog({
  plan,
  workflow,
  onCancel,
  onRun,
  initialParameters = {},
  executionMode = "local",
  onExecutionModeChange = () => {},
  queueState = { runners: [] },
}) {
  const parameterSchema = workflow.parameters ?? {};
  const [parameters, setParameters] = useState(() => ({
    ...initialWorkflowParameters(workflow),
    ...initialParameters,
  }));
  const [parameterErrors, setParameterErrors] = useState({});
  const warnings = plan?.warnings ?? [];
  const destructiveActions = plan?.destructiveActions ?? [];
  const providers = plan?.providerRequirements ?? [];
  const requiredSecrets = plan?.requiredSecrets ?? [];
  const secretReadinessItems = formatSecretReadinessItems(
    plan?.secretReadiness ?? workflow.secretReadiness,
  );
  const unresolvedValues = plan?.unresolvedDynamicValues ?? [];
  const triggerItems = formatTriggerContextItems(plan?.triggerContext);
  const validationItems = formatValidationItems(plan?.validation);
  const branchItems = formatConditionalBranchItems(plan?.conditionalBranches);
  const resourceLimitItems = formatResourceLimitItems(plan?.resourceLimits, plan?.executionLimits);
  const usageBudgetItems = formatUsageBudgetItems(plan?.usageBudget);
  const projectedUsageItems = formatProjectedUsageItems(plan?.projectedLlmUsage);
  const startNodes = plan?.startNodes ?? [];
  const generations = plan?.generations ?? [];
  const validationBlocked = hasBlockingValidationErrors(plan?.validation);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <div className="flex max-h-[86vh] w-full max-w-[760px] flex-col rounded-lg border border-line bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Run preview: {workflow.name}</h2>
            <p className="text-xs text-muted">{workflow.id}</p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="Close"
            type="button"
            onClick={onCancel}
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          {startNodes.length > 0 ? (
            <PreviewSection title="Start nodes" items={startNodes} />
          ) : null}
          {validationItems.length > 0 ? (
            <PreviewSection
              title="Validation diagnostics"
              tone={validationItems.some((item) => item.startsWith("error:")) ? "danger" : "warning"}
              items={validationItems}
            />
          ) : null}
          {destructiveActions.length > 0 ? (
            <PreviewSection title="Destructive actions" tone="danger" items={destructiveActions} />
          ) : null}
          {warnings.length > 0 ? (
            <PreviewSection title="Warnings" tone="warning" items={warnings} />
          ) : null}
          {requiredSecrets.length > 0 ? (
            <PreviewSection title="Required secrets" items={requiredSecrets.map(formatSecretItem)} />
          ) : null}
          {secretReadinessItems.length > 0 ? (
            <PreviewSection
              title="Secret readiness"
              tone={secretReadinessItems.some((item) => item.includes(": missing")) ? "warning" : "default"}
              items={secretReadinessItems}
            />
          ) : null}
          {triggerItems.length > 0 ? (
            <PreviewSection title="Trigger context" items={triggerItems} />
          ) : null}
          {branchItems.length > 0 ? (
            <PreviewSection title="Conditional branches" items={branchItems} />
          ) : null}
          {Object.keys(parameterSchema).length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
                Run parameters
              </h3>
              <div className="space-y-3 rounded-lg border border-line bg-slate-50 p-3">
                {Object.entries(parameterSchema).map(([name, spec]) => (
                  <RunParameterField
                    key={name}
                    name={name}
                    spec={spec}
                    value={parameters[name]}
                    error={parameterErrors[name]}
                    onChange={(value) =>
                      setParameters((current) => ({ ...current, [name]: value }))
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}
          {providers.length > 0 ? (
            <PreviewSection
              title="Provider CLI requirements"
              items={providers.map((provider) => {
                const profile = provider.profile ? ` profile=${provider.profile}` : "";
                const model = provider.model ? ` model=${provider.model}` : "";
                const timeout =
                  provider.timeout !== undefined && provider.timeout !== null
                    ? ` timeout=${provider.timeout}s`
                    : "";
                const extraPaths = provider.extraPaths?.length
                  ? ` extra_paths=${provider.extraPaths.join(", ")}`
                  : "";
                const binary = provider.binary ?? "unknown";
                const availability = provider.available ? "available" : "missing";
                return `${provider.agentId}: ${provider.subscription} binary=${binary} (${availability}) cwd=${provider.workingDir}${profile}${model}${timeout}${extraPaths}`;
              })}
            />
          ) : null}
          {projectedUsageItems.length > 0 ? (
            <PreviewSection title="Projected LLM usage" items={projectedUsageItems} />
          ) : null}
          {usageBudgetItems.length > 0 ? (
            <PreviewSection title="Usage budget" items={usageBudgetItems} />
          ) : null}
          {resourceLimitItems.length > 0 ? (
            <PreviewSection title="Resource limits" items={resourceLimitItems} />
          ) : null}
          {unresolvedValues.length > 0 ? (
            <PreviewSection
              title="Unresolved dynamic values"
              tone="warning"
              items={unresolvedValues}
            />
          ) : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
              Execution target
            </h3>
            <div className="inline-flex rounded-lg border border-line bg-slate-50 p-1">
              <button
                className={`rounded-md px-3 py-1.5 text-sm ${
                  executionMode === "local" ? "bg-white font-semibold shadow-sm" : "text-muted"
                }`}
                type="button"
                onClick={() => onExecutionModeChange("local")}
              >
                Local
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-sm ${
                  executionMode === "remote" ? "bg-white font-semibold shadow-sm" : "text-muted"
                }`}
                type="button"
                onClick={() => onExecutionModeChange("remote")}
              >
                Remote
              </button>
            </div>
            {executionMode === "remote" ? (
              <p className="mt-2 text-xs text-muted">
                {(queueState.runners ?? []).length
                  ? `${queueState.runners.length} runner${queueState.runners.length === 1 ? "" : "s"} registered`
                  : "No runners registered yet"}
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
              Execution order
            </h3>
            <div className="space-y-2">
              {generations.map((generation) => (
                <details
                  key={generation.index}
                  className="rounded-lg border border-line bg-slate-50 px-3 py-2"
                  open={generation.index === 0}
                >
                  <summary className="cursor-pointer text-sm font-semibold">
                    Generation {generation.index} · {(generation.nodes ?? []).length} node
                    {(generation.nodes ?? []).length === 1 ? "" : "s"}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {(generation.nodes ?? []).map((node) => (
                      <div
                        key={node.id}
                        className="rounded-md border border-line bg-white px-3 py-2 text-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold">{node.id}</p>
                            <p className="break-words text-xs text-muted">{node.detail}</p>
                          </div>
                          <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">
                            {node.type}
                          </span>
                        </div>
                        {(node.sideEffects ?? []).length > 0 ? (
                          <p className="mt-2 text-xs text-slate-600">
                            {(node.sideEffects ?? []).join("; ")}
                          </p>
                        ) : null}
                        {formatNetworkAllowlistItems(node.sideEffectDetails).length > 0 ? (
                          <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                            {formatNetworkAllowlistItems(node.sideEffectDetails).map((item) => (
                              <li key={`${node.id}-${item}`}>{item}</li>
                            ))}
                          </ul>
                        ) : null}
                        {node.workingDir ? (
                          <p className="mt-2 break-words text-xs text-slate-600">
                            Working directory: {node.workingDir}
                          </p>
                        ) : null}
                        {node.fanOut ? (
                          <div className="mt-2 text-xs text-slate-600">
                            <p>
                              Fan-out {node.fanOut.sourceType}:{" "}
                              {formatFanOutCount(node.fanOut)} item
                              {node.fanOut.count === 1 && node.fanOut.countExact !== false
                                ? ""
                                : "s"}
                            </p>
                            {(node.fanOut.sampleItems ?? []).length > 0 ? (
                              <ul className="mt-1 space-y-0.5">
                                {(node.fanOut.sampleItems ?? []).map((sample, index) => (
                                  <li key={`${node.id}-sample-${index}`}>
                                    Sample: {formatPreviewValue(sample)}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ) : null}
                        {(node.unresolvedDynamicValues ?? []).length > 0 ? (
                          <div className="mt-2 text-xs text-amber-700">
                            <p className="font-medium">Unresolved values</p>
                            <ul className="mt-1 space-y-0.5">
                              {(node.unresolvedDynamicValues ?? []).map((value) => (
                                <li key={value}>{value}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {node.timeoutSeconds || node.retryCount || node.allowFailure ? (
                          <p className="mt-2 text-xs text-slate-600">
                            {[
                              node.timeoutSeconds ? `Timeout: ${node.timeoutSeconds}s` : "",
                              node.retryCount
                                ? `Retries: ${node.retryCount} delay=${node.retryDelaySeconds}s`
                                : "",
                              node.allowFailure ? "Allow failure" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          {validationBlocked ? (
            <p className="mr-auto self-center text-xs font-medium text-red-700">
              Resolve validation errors before running.
            </p>
          ) : null}
          <button className="btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary inline-flex items-center justify-center gap-2 whitespace-nowrap"
            disabled={validationBlocked}
            type="button"
            onClick={() => {
              if (validationBlocked) return;
              const errors = validateWorkflowParameters(workflow, parameters);
              setParameterErrors(errors);
              if (Object.keys(errors).length === 0) {
                onRun(parameters);
              }
            }}
          >
            Run workflow
          </button>
        </div>
      </div>
    </div>
  );
}

function RunParameterField({ error, name, onChange, spec, value }) {
  const id = `run-param-${name}`;
  const label = spec.label || name;
  const commonClass =
    "mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-teal-500";
  const inputType =
    spec.type === "number"
      ? "number"
      : spec.type === "date"
        ? "date"
        : spec.type === "time"
          ? "time"
          : spec.type === "datetime"
            ? "datetime-local"
            : spec.type === "secret"
              ? "password"
              : "text";
  return (
    <label className="block text-sm" htmlFor={id}>
      <span className="font-medium">
        {label}
        {spec.required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {spec.description ? (
        <span className="mt-0.5 block text-xs text-muted">{spec.description}</span>
      ) : null}
      {spec.type === "boolean" ? (
        <input
          id={id}
          className="mt-2 h-4 w-4 rounded border-line"
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : spec.type === "enum" ? (
        <select
          id={id}
          className={commonClass}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select...</option>
          {(spec.choices ?? []).map((choice) => (
            <option key={String(choice)} value={choice}>
              {String(choice)}
            </option>
          ))}
        </select>
      ) : spec.type === "text" || spec.type === "multiline" ? (
        <textarea
          id={id}
          className={`${commonClass} min-h-24 resize-y`}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className={commonClass}
          type={inputType}
          value={value ?? ""}
          min={spec.min}
          max={spec.max}
          pattern={spec.pattern}
          onChange={(event) => {
            const nextValue = spec.type === "number" ? event.target.value : event.target.value;
            onChange(nextValue);
          }}
        />
      )}
      {spec.type === "file" || spec.type === "folder" ? (
        <span className="mt-1 block text-xs text-muted">
          Enter a path accessible to the runner.
        </span>
      ) : null}
      {error ? <span className="mt-1 block text-xs text-rose-700">{error}</span> : null}
    </label>
  );
}

function PreviewSection({ title, items, tone = "default" }) {
  const toneClass =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-line bg-slate-50 text-slate-700";

  return (
    <section className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <h3 className="text-xs font-semibold uppercase">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((item) => (
          <li key={item}>- {item}</li>
        ))}
      </ul>
    </section>
  );
}

function CreateWorkflowDialog({ error, open, saving, templates, onClose, onCreate }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState("blank");
  const [templateName, setTemplateName] = useState("");

  const selectedTemplate = templates.find((item) => item.name === templateName) ?? null;

  useEffect(() => {
    if (open) {
      setName("");
      setMode("blank");
      setTemplateName("");
    }
  }, [open]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onCreate(name, { template: mode === "template" ? templateName : "" });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <form
        className="w-full max-w-[560px] rounded-lg border border-line bg-white shadow-panel"
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

        <div className="space-y-4 px-5 py-5">
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
            <button
              className={`h-9 rounded-md text-sm font-medium transition ${
                mode === "blank" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
              disabled={saving}
              type="button"
              onClick={() => setMode("blank")}
            >
              Blank
            </button>
            <button
              className={`h-9 rounded-md text-sm font-medium transition ${
                mode === "template" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
              disabled={saving}
              type="button"
              onClick={() => {
                setMode("template");
                setTemplateName((current) => current || templates[0]?.name || "");
              }}
            >
              Template
            </button>
          </div>
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
          {mode === "template" ? (
            <>
              <label className="block">
                <span className="text-xs font-medium text-muted">Template</span>
                <select
                  className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                  disabled={saving}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                >
                  <option value="" disabled>
                    Select a template
                  </option>
                  {templates.map((template) => (
                    <option key={template.name} value={template.name}>
                      {template.title}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTemplate ? (
                <div className="rounded-lg border border-line bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-medium text-ink">{selectedTemplate.purpose}</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TemplatePreviewList
                      title="Inputs"
                      items={(selectedTemplate.required_inputs ?? []).map(
                        (item) => `${item.name} (${item.type ?? "string"})`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Providers"
                      items={(selectedTemplate.provider_assumptions ?? []).map(
                        (item) => `${item.agentId}: ${item.subscription}`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Nodes"
                      items={(selectedTemplate.generated_nodes ?? []).map(
                        (item) => `${item.id} (${item.type})`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Assets"
                      items={(selectedTemplate.assets ?? []).map((item) => item.path)}
                    />
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Template previews are unavailable.
                </div>
              )}
            </>
          ) : null}
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
            disabled={saving || (mode === "blank" && !name.trim()) || (mode === "template" && !templateName)}
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

function ExportWorkflowDialog({
  error,
  open,
  outputPath,
  saving,
  workflow,
  onBrowse,
  onClose,
  onExport,
}) {
  const [draftPath, setDraftPath] = useState(outputPath || "");

  useEffect(() => {
    if (open) {
      setDraftPath(outputPath || "");
    }
  }, [open, outputPath]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onExport(draftPath);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <form
        className="w-full max-w-[600px] rounded-lg border border-line bg-white shadow-panel"
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Export workflow bundle</h2>
            <p className="text-xs text-muted">
              {workflow?.name ? `Create a portable bundle for ${workflow.name}` : "Create a portable workflow bundle"}
            </p>
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

        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="text-xs font-medium text-muted">Output path</span>
            <div className="mt-1 flex gap-2">
              <input
                autoFocus
                className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm outline-none transition focus:border-teal-500"
                disabled={saving}
                placeholder="/path/to/workflow.gof.zip"
                value={draftPath}
                onChange={(event) => setDraftPath(event.target.value)}
              />
              {onBrowse ? (
                <button
                  className="grid h-10 w-10 flex-none place-items-center rounded-lg border border-line bg-white text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={saving}
                  title="Choose export folder"
                  type="button"
                  onClick={async () => {
                    await onBrowse(draftPath);
                  }}
                >
                  <FolderOpen size={16} />
                </button>
              ) : null}
            </div>
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
            disabled={saving || !draftPath.trim()}
            title="Confirm workflow export"
            type="submit"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            Export
          </button>
        </div>
      </form>
    </div>
  );
}

function TemplatePreviewList({ title, items }) {
  const visibleItems = items?.length ? items.slice(0, 4) : ["None"];
  return (
    <div>
      <div className="text-xs font-semibold text-muted">{title}</div>
      <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-700">
        {visibleItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DashboardWorkspace({
  dashboard,
  loading,
  notice,
  onAddComponent,
  onAddDashboard,
  onAddItem,
  onAddSection,
  onDeleteDashboard,
  onDuplicateDashboard,
  onDeleteComponent,
  onDeleteSection,
  onDeleteItem,
  onRename,
  onSetComponentTitle,
  onSetContent,
  onSetDisplay,
  onSetSchema,
  onSetViews,
  onUpdateSection,
  onUpdateItem,
}) {
  const [draftName, setDraftName] = useState("");
  const [editingSectionIds, setEditingSectionIds] = useState(() => new Set());

  useEffect(() => {
    setDraftName(dashboard?.name ?? "");
    setEditingSectionIds(new Set());
  }, [dashboard?.id, dashboard?.name]);

  function toggleSectionEditing(sectionId) {
    setEditingSectionIds((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  if (!dashboard) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md rounded-lg border border-dashed border-line bg-white p-6 text-center">
          <Database className="mx-auto text-muted" size={28} />
          <h2 className="mt-4 text-base font-semibold">No dashboards</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {loading ? "Loading dashboards..." : "Create a dashboard to organize workflow state."}
          </p>
          <button
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700"
            type="button"
            onClick={onAddDashboard}
          >
            <Plus size={15} />
            New dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="border-b border-line bg-white px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted">
              <Database size={14} />
              Dashboard
            </div>
            <input
              className="mt-2 w-full bg-transparent text-xl font-semibold outline-none"
              value={draftName}
              onBlur={() => draftName.trim() && draftName !== dashboard.name && onRename(dashboard, draftName)}
              onChange={(event) => setDraftName(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted">ID: {dashboard.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              type="button"
              onClick={() => onAddSection(dashboard)}
            >
              <Plus size={15} />
              Section
            </button>
            <button
              className="grid h-9 w-9 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="Duplicate dashboard"
              type="button"
              onClick={() => onDuplicateDashboard(dashboard)}
            >
              <Copy size={15} />
            </button>
            <button
              className="grid h-9 w-9 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              title="Delete dashboard"
              type="button"
              onClick={() => onDeleteDashboard(dashboard)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {notice?.message ? (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              notice.type === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {notice.message}
          </div>
        ) : null}
      </div>

      <div className="workflow-scrollbar flex-1 overflow-y-auto px-6 py-5">
        {(dashboard.sections ?? []).length ? (
          <div className="grid grid-cols-12 gap-5">
            {dashboard.sections.map((section) => (
              <DashboardSectionPanel
                key={section.id}
                dashboard={dashboard}
                editing={editingSectionIds.has(section.id)}
                section={section}
                onAddComponent={onAddComponent}
                onAddItem={onAddItem}
                onDeleteComponent={onDeleteComponent}
                onDeleteItem={onDeleteItem}
                onDeleteSection={onDeleteSection}
                onSetComponentTitle={onSetComponentTitle}
                onSetContent={onSetContent}
                onSetDisplay={onSetDisplay}
                onSetSchema={onSetSchema}
                onSetViews={onSetViews}
                onToggleEditing={() => toggleSectionEditing(section.id)}
                onUpdateItem={onUpdateItem}
                onUpdateSection={onUpdateSection}
              />
            ))}
          </div>
        ) : (
          <button
            className="flex h-40 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-white text-sm font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
            type="button"
            onClick={() => onAddSection(dashboard)}
          >
            <Plus size={16} />
            Add section
          </button>
        )}
      </div>
    </>
  );
}

function DashboardSectionPanel({
  dashboard,
  editing,
  section,
  onAddComponent,
  onAddItem,
  onDeleteComponent,
  onDeleteItem,
  onDeleteSection,
  onSetComponentTitle,
  onSetContent,
  onSetDisplay,
  onSetSchema,
  onSetViews,
  onToggleEditing,
  onUpdateItem,
  onUpdateSection,
}) {
  const [sectionTitleDraft, setSectionTitleDraft] = useState(section.title ?? "");

  useEffect(() => {
    setSectionTitleDraft(section.title ?? "");
  }, [section.id, section.title]);

  function commitSectionTitle() {
    const title = sectionTitleDraft.trim();
    if (title && title !== section.title) {
      onUpdateSection(dashboard, section, { title });
    } else {
      setSectionTitleDraft(section.title ?? "");
    }
  }
  const sectionTitleHidden = Boolean(section.layout?.hideTitle);

  return (
    <section
      className={`col-span-12 rounded-lg border bg-white ${
        editing ? "border-teal-200 shadow-sm" : "border-line"
      }`}
      style={{
        gridColumn: `span ${dashboardSectionColumns(section)} / span ${dashboardSectionColumns(section)}`,
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {editing ? (
            <input
              className="w-full min-w-0 bg-transparent text-base font-semibold outline-none focus:text-teal-700"
              value={sectionTitleDraft}
              onBlur={commitSectionTitle}
              onChange={(event) => setSectionTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setSectionTitleDraft(section.title ?? "");
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <h2 className={`truncate text-base font-semibold ${sectionTitleHidden ? "sr-only" : ""}`}>
              {section.title}
            </h2>
          )}
          {editing ? <p className="mt-0.5 truncate text-xs text-muted">ID: {section.id}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {editing ? (
            <>
              <label className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-muted">
                <input
                  type="checkbox"
                  checked={sectionTitleHidden}
                  onChange={(event) =>
                    onUpdateSection(dashboard, section, {
                      layout: { ...(section.layout ?? {}), hideTitle: event.target.checked },
                    })
                  }
                />
                Hide title
              </label>
              <select
                className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-muted outline-none transition hover:border-slate-300 focus:border-teal-500"
                title="Section width"
                value={dashboardSectionColumns(section)}
                onChange={(event) =>
                  onUpdateSection(dashboard, section, {
                    layout: { ...(section.layout ?? {}), columns: Number(event.target.value) },
                  })
                }
              >
                {DASHBOARD_SECTION_WIDTHS.map((option) => (
                  <option key={option.columns} value={option.columns}>
                    {option.label}
                  </option>
                ))}
              </select>
              {DASHBOARD_COMPONENT_TYPES.map(({ type, label }) => (
                <button
                  key={type}
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-white px-2.5 text-xs font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                  type="button"
                  onClick={() => onAddComponent(dashboard, section, type)}
                >
                  <Plus size={14} />
                  {label}
                </button>
              ))}
              <button
                className="grid h-8 w-8 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                title="Delete section"
                type="button"
                onClick={() => onDeleteSection(dashboard, section)}
              >
                <Trash2 size={14} />
              </button>
            </>
          ) : null}
          <button
            className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition ${
              editing
                ? "border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100"
                : "border-line bg-white text-muted hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
            }`}
            type="button"
            onMouseDown={() => {
              if (!editing) return;
              const activeElement = document.activeElement;
              if (activeElement && typeof activeElement.blur === "function") {
                activeElement.blur();
              }
            }}
            onClick={() => {
              if (editing) commitSectionTitle();
              onToggleEditing();
            }}
          >
            <PencilLine size={14} />
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>
      <div className={editing ? "grid min-w-0 grid-cols-1 gap-4 p-4 2xl:grid-cols-2" : "space-y-4 p-4"}>
        {(section.components ?? []).length ? (
          (section.components ?? []).map((component) =>
            editing ? (
              <DashboardComponentPanel
                key={component.id}
                component={component}
                dashboard={dashboard}
                onAddItem={onAddItem}
                onDeleteComponent={onDeleteComponent}
                onDeleteItem={onDeleteItem}
                onSetComponentTitle={onSetComponentTitle}
                onSetContent={onSetContent}
                onSetDisplay={onSetDisplay}
                onSetSchema={onSetSchema}
                onSetViews={onSetViews}
                onUpdateItem={onUpdateItem}
              />
            ) : (
              <DashboardComponentView
                key={component.id}
                component={component}
                dashboard={dashboard}
                onAddItem={onAddItem}
                onDeleteItem={onDeleteItem}
                onUpdateItem={onUpdateItem}
              />
            ),
          )
        ) : (
          <div className="rounded-md border border-dashed border-line bg-slate-50 px-4 py-8 text-center text-sm text-muted">
            {editing ? "Add a component to this section." : "No dashboard content yet."}
          </div>
        )}
      </div>
    </section>
  );
}

function DashboardComponentPanel({
  component,
  dashboard,
  onAddItem,
  onDeleteComponent,
  onDeleteItem,
  onSetComponentTitle,
  onSetContent,
  onSetDisplay,
  onSetSchema,
  onSetViews,
  onUpdateItem,
}) {
  const [titleDraft, setTitleDraft] = useState(component.title ?? "");
  const [schemaDraft, setSchemaDraft] = useState(schemaToRows(component.schema));
  const [viewDraft, setViewDraft] = useState(viewsToRows(component.views));
  const [cardDisplayDraft, setCardDisplayDraft] = useState(displayToRows(component.display?.cardFields, "card"));
  const [detailDisplayDraft, setDetailDisplayDraft] = useState(
    displayToRows(component.display?.detailFields, "detail"),
  );
  const [contentDraft, setContentDraft] = useState(component.content ?? "");
  const [itemDraft, setItemDraft] = useState({});
  const fields = Object.keys(component.schema ?? {});
  const views = component.views ?? [];

  useEffect(() => {
    setTitleDraft(component.title ?? "");
    setSchemaDraft(schemaToRows(component.schema));
    setViewDraft(viewsToRows(component.views));
    setCardDisplayDraft(displayToRows(component.display?.cardFields, "card"));
    setDetailDisplayDraft(displayToRows(component.display?.detailFields, "detail"));
    setContentDraft(component.content ?? "");
    setItemDraft({});
  }, [component.id]);

  function commitComponentTitle() {
    const title = titleDraft.trim();
    if (title && title !== component.title) {
      onSetComponentTitle(dashboard, component, title);
    } else {
      setTitleDraft(component.title ?? "");
    }
  }

  function saveSchema() {
    const schema = {};
    for (const row of schemaDraft) {
      if (!row.name.trim()) continue;
      schema[row.name.trim()] =
        row.type === "enum"
          ? {
              type: "enum",
              values: row.values.split(",").map((value) => value.trim()).filter(Boolean),
            }
          : row.type;
    }
    onSetSchema(dashboard, component, schema);
  }

  function addItem() {
    const item = {};
    for (const field of fields) {
      if (itemDraft[field] !== undefined && itemDraft[field] !== "") {
        item[field] = itemDraft[field];
      }
    }
    onAddItem(dashboard, component, item);
    setItemDraft({});
  }

  function setDefaultBoardViews() {
    const defaultViews = [
      { title: "Backlog", filter: { field: "status", operator: "equals", value: "backlog" } },
      { title: "Todo", filter: { field: "status", operator: "equals", value: "todo" } },
      { title: "In Progress", filter: { field: "status", operator: "equals", value: "in_progress" } },
      { title: "Completed", filter: { field: "status", operator: "equals", value: "completed" } },
    ];
    setViewDraft(viewsToRows(defaultViews));
    onSetViews(dashboard, component, defaultViews);
  }

  function saveViews() {
    onSetViews(
      dashboard,
      component,
      viewDraft
        .filter((view) => view.title.trim())
        .map((view) => ({
          title: view.title.trim(),
          filter: view.field.trim()
            ? {
                field: view.field.trim(),
                operator: view.operator,
                value: view.operator === "exists" ? null : view.value,
              }
            : null,
        })),
    );
  }

  function saveContent() {
    onSetContent(dashboard, component, contentDraft);
  }

  function saveDisplay() {
    onSetDisplay(dashboard, component, {
      ...(component.display ?? {}),
      cardFields: displayRowsToConfig(cardDisplayDraft),
      detailFields: displayRowsToConfig(detailDisplayDraft),
    });
  }
  const componentTitleHidden = Boolean(component.display?.hideTitle);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-white">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <input
              className="w-full min-w-0 bg-transparent text-sm font-semibold outline-none focus:text-teal-700"
              value={titleDraft}
              onBlur={commitComponentTitle}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setTitleDraft(component.title ?? "");
                  event.currentTarget.blur();
                }
              }}
            />
            <p className="mt-0.5 truncate text-xs text-muted">
              {component.type} · ID: {component.id}
            </p>
          </div>
          <label className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-line px-2 text-xs font-medium text-muted">
            <input
              type="checkbox"
              checked={componentTitleHidden}
              onChange={(event) =>
                onSetDisplay(dashboard, component, {
                  ...(component.display ?? {}),
                  hideTitle: event.target.checked,
                })
              }
            />
            Hide title
          </label>
          {component.type === "board" ? (
            <button
              className="h-8 rounded-md border border-line px-2 text-xs font-medium text-muted transition hover:bg-slate-50 hover:text-ink"
              type="button"
              onClick={setDefaultBoardViews}
            >
              Defaults
            </button>
          ) : null}
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            title="Remove component"
            type="button"
            onClick={() => onDeleteComponent(dashboard, component)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {component.type === "markdown" ? (
        <DashboardMarkdownBlock
          contentDraft={contentDraft}
          onContentDraftChange={setContentDraft}
          onSave={saveContent}
        />
      ) : (
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-muted">Schema</span>
            <button
              className="text-xs font-medium text-teal-700"
              type="button"
              onClick={() =>
                setSchemaDraft((current) => [
                  ...current,
                  { rowId: newDraftRowId("field"), name: "", type: "string", values: "" },
                ])
              }
            >
              Add field
            </button>
          </div>
          <div className="space-y-2">
            {schemaDraft.map((row, index) => (
              <div
                key={row.rowId}
                className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)_32px]"
              >
                <input
                  className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                  placeholder="field"
                  value={row.name}
                  onChange={(event) =>
                    setSchemaDraft((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
                <select
                  className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                  value={row.type}
                  onChange={(event) =>
                    setSchemaDraft((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, type: event.target.value } : item,
                      ),
                    )
                  }
                >
                  {["string", "text", "number", "boolean", "date", "datetime", "enum", "json"].map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <input
                  className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500 disabled:bg-slate-50"
                  disabled={row.type !== "enum"}
                  placeholder="enum values"
                  value={row.values}
                  onChange={(event) =>
                    setSchemaDraft((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, values: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
                  type="button"
                  onClick={() => setSchemaDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="mt-2 h-8 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-slate-700"
            type="button"
            onClick={saveSchema}
          >
            Save schema
          </button>
        </div>

        {component.type === "board" ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted">Columns</span>
              <button
                className="text-xs font-medium text-teal-700"
                type="button"
                onClick={() =>
                  setViewDraft((current) => [
                    ...current,
                    {
                      rowId: newDraftRowId("view"),
                      title: "New column",
                      field: "status",
                      operator: "equals",
                      value: "",
                    },
                  ])
                }
              >
                Add column
              </button>
            </div>
            <div className="space-y-2">
              {viewDraft.map((view, index) => (
                <div
                  key={view.rowId}
                  className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_minmax(0,1fr)_72px]"
                >
                  <input
                    className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                    placeholder="column title"
                    value={view.title}
                    onChange={(event) =>
                      setViewDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, title: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <input
                    className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                    placeholder="field"
                    value={view.field}
                    onChange={(event) =>
                      setViewDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, field: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <select
                    className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                    value={view.operator}
                    onChange={(event) =>
                      setViewDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, operator: event.target.value } : item,
                        ),
                      )
                    }
                  >
                    {["equals", "not_equals", "contains", "exists"].map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500 disabled:bg-slate-50"
                    disabled={view.operator === "exists"}
                    placeholder="value"
                    value={view.value}
                    onChange={(event) =>
                      setViewDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, value: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <div className="flex items-center justify-end gap-1">
                    <button
                      className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-slate-50 hover:text-ink disabled:opacity-40"
                      disabled={index === 0}
                      type="button"
                      onClick={() => setViewDraft((current) => moveArrayItem(current, index, index - 1))}
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-slate-50 hover:text-ink disabled:opacity-40"
                      disabled={index === viewDraft.length - 1}
                      type="button"
                      onClick={() => setViewDraft((current) => moveArrayItem(current, index, index + 1))}
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
                      type="button"
                      onClick={() => setViewDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="mt-2 h-8 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-slate-700"
              type="button"
              onClick={saveViews}
            >
              Save columns
            </button>
          </div>
        ) : null}

        {component.type === "board" ? (
          <DashboardBoardDisplayEditor
            cardDisplayDraft={cardDisplayDraft}
            detailDisplayDraft={detailDisplayDraft}
            fields={fields}
            onAddCardField={() =>
              setCardDisplayDraft((current) => [
                ...current,
                { rowId: newDraftRowId("card-display"), field: fields[0] ?? "title", style: "text" },
              ])
            }
            onAddDetailField={() =>
              setDetailDisplayDraft((current) => [
                ...current,
                { rowId: newDraftRowId("detail-display"), field: fields[0] ?? "title", style: "text" },
              ])
            }
            onCardDisplayChange={setCardDisplayDraft}
            onDetailDisplayChange={setDetailDisplayDraft}
            onSave={saveDisplay}
          />
        ) : null}

        <div>
          <div className="mb-2 text-xs font-semibold uppercase text-muted">Items</div>
          {fields.length ? (
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {fields.map((field) => (
                <input
                  key={field}
                  className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
                  placeholder={field}
                  value={itemDraft[field] ?? ""}
                  onChange={(event) => setItemDraft((current) => ({ ...current, [field]: event.target.value }))}
                />
              ))}
              <button
                className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                type="button"
                onClick={addItem}
              >
                Add item
              </button>
            </div>
          ) : null}

          {component.type === "board" && views.length ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-4">
              {views.map((view) => (
                <DashboardBoardColumn
                  key={view.title}
                  component={component}
                  dashboard={dashboard}
                  items={(component.items ?? []).filter((item) => dashboardItemMatchesView(item, view))}
                  view={view}
                  onAddItem={onAddItem}
                  onDeleteItem={onDeleteItem}
                  onMoveItem={(item, patch) => onUpdateItem(dashboard, component, item, patch)}
                  onUpdateItem={onUpdateItem}
                />
              ))}
            </div>
          ) : component.type === "stats" ? (
            <DashboardStats component={component} fields={fields} />
          ) : component.type === "chart" ? (
            <DashboardChart component={component} views={views} />
          ) : component.type === "json_list" ? (
            <pre className="max-h-72 overflow-auto rounded-md border border-line bg-slate-950 p-3 text-xs text-slate-100">
              {JSON.stringify(component.items ?? [], null, 2)}
            </pre>
          ) : (
            <div className="overflow-hidden rounded-md border border-line">
              {(component.items ?? []).map((item) => (
                <DashboardItemRow
                  key={item.id}
                  component={component}
                  dashboard={dashboard}
                  item={item}
                  onDeleteItem={onDeleteItem}
                  onUpdateItem={onUpdateItem}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function DashboardBoardDisplayEditor({
  cardDisplayDraft,
  detailDisplayDraft,
  fields,
  onAddCardField,
  onAddDetailField,
  onCardDisplayChange,
  onDetailDisplayChange,
  onSave,
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted">Card display</span>
        <button className="text-xs font-medium text-teal-700" type="button" onClick={onAddCardField}>
          Add card field
        </button>
      </div>
      <DashboardDisplayRows
        fields={fields}
        rows={cardDisplayDraft}
        styles={DASHBOARD_CARD_FIELD_STYLES}
        onChange={onCardDisplayChange}
      />

      <div className="mb-2 mt-4 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted">Preview pane</span>
        <button className="text-xs font-medium text-teal-700" type="button" onClick={onAddDetailField}>
          Add preview field
        </button>
      </div>
      <DashboardDisplayRows
        fields={fields}
        rows={detailDisplayDraft}
        styles={DASHBOARD_DETAIL_FIELD_STYLES}
        onChange={onDetailDisplayChange}
      />

      <button
        className="mt-2 h-8 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-slate-700"
        type="button"
        onClick={onSave}
      >
        Save display
      </button>
    </div>
  );
}

function DashboardDisplayRows({ fields, rows, styles, onChange }) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={row.rowId}
          className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_140px_32px]"
        >
          <select
            className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
            value={row.field}
            onChange={(event) =>
              onChange((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, field: event.target.value } : item,
                ),
              )
            }
          >
            {fields.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
          <select
            className="h-8 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
            value={row.style}
            onChange={(event) =>
              onChange((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, style: event.target.value } : item,
                ),
              )
            }
          >
            {styles.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
          <button
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
            type="button"
            onClick={() => onChange((current) => current.filter((_, itemIndex) => itemIndex !== index))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function DashboardComponentView({ component, dashboard, onAddItem, onDeleteItem, onUpdateItem }) {
  const fields = Object.keys(component.schema ?? {});
  const views = component.views ?? [];

  if (component.type === "markdown") {
    return (
      <div className="rounded-lg border border-transparent bg-transparent">
        <DashboardMarkdownPreview content={component.content} />
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-lg border border-line bg-white">
      {component.display?.hideTitle ? null : (
        <div className="border-b border-line px-4 py-3">
          <h3 className="truncate text-sm font-semibold">{component.title}</h3>
        </div>
      )}
      <div className="p-4">
        {component.type === "board" && views.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-4">
            {views.map((view) => (
              <DashboardBoardColumn
                key={view.title}
                component={component}
                dashboard={dashboard}
                items={(component.items ?? []).filter((item) => dashboardItemMatchesView(item, view))}
                view={view}
                onAddItem={onAddItem}
                onDeleteItem={onDeleteItem}
                onMoveItem={(item, patch) => onUpdateItem(dashboard, component, item, patch)}
                onUpdateItem={onUpdateItem}
              />
            ))}
          </div>
        ) : component.type === "stats" ? (
          <DashboardStats component={component} fields={fields} />
        ) : component.type === "chart" ? (
          <DashboardChart component={component} views={views} />
        ) : component.type === "json_list" ? (
          <pre className="max-h-72 overflow-auto rounded-md border border-line bg-slate-950 p-3 text-xs text-slate-100">
            {JSON.stringify(component.items ?? [], null, 2)}
          </pre>
        ) : (
          <div className="overflow-hidden rounded-md border border-line">
            {(component.items ?? []).length ? (
              (component.items ?? []).map((item) => (
                <DashboardItemRow
                  key={item.id}
                  component={component}
                  dashboard={dashboard}
                  item={item}
                  onDeleteItem={onDeleteItem}
                  onUpdateItem={onUpdateItem}
                />
              ))
            ) : (
              <div className="bg-slate-50 px-3 py-6 text-center text-sm text-muted">No items yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardBoardColumn({
  component,
  dashboard,
  items,
  view,
  onAddItem,
  onDeleteItem,
  onMoveItem,
  onUpdateItem,
}) {
  const [draftTitle, setDraftTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const movePatch = dashboardBoardColumnPatch(view);
  const titleField = dashboardPrimaryField(component);
  const selectedItem = (component.items ?? []).find((item) => String(item.id) === String(selectedItemId));

  function addCard() {
    const title = draftTitle.trim();
    if (!title || !movePatch) return;
    onAddItem(dashboard, component, { [titleField]: title, ...movePatch });
    setDraftTitle("");
  }

  function dropCard(event) {
    event.preventDefault();
    setDragOver(false);
    if (!movePatch) return;
    const raw = event.dataTransfer.getData("application/x-gofer-dashboard-card");
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      if (payload.dashboardId !== dashboard.id || payload.componentId !== component.id) return;
      const item = (component.items ?? []).find((candidate) => String(candidate.id) === String(payload.itemId));
      if (item) {
        onMoveItem(item, movePatch);
      }
    } catch {
      // Ignore malformed drag payloads from outside the board.
    }
  }

  return (
    <div
      className={`min-w-0 rounded-md border p-3 transition ${
        dragOver ? "border-teal-300 bg-teal-50" : "border-line bg-slate-50"
      }`}
      onDragLeave={() => setDragOver(false)}
      onDragOver={(event) => {
        if (!movePatch) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDrop={dropCard}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase text-muted">{view.title}</div>
          <div className="mt-0.5 text-[11px] text-muted">{items.length} items</div>
        </div>
      </div>
      {movePatch ? (
        <div className="mb-3 flex gap-2">
          <input
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-xs outline-none focus:border-teal-500"
            placeholder="Add card"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCard();
              if (event.key === "Escape") setDraftTitle("");
            }}
          />
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:opacity-40"
            disabled={!draftTitle.trim()}
            title="Add card"
            type="button"
            onClick={addCard}
          >
            <Plus size={14} />
          </button>
        </div>
      ) : null}
      <div className="space-y-2">
        {items.length ? (
          items.map((item) => (
            <DashboardItemCard
              key={item.id}
              component={component}
              dashboard={dashboard}
              draggable
              item={item}
              onDeleteItem={onDeleteItem}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "application/x-gofer-dashboard-card",
                  JSON.stringify({
                    dashboardId: dashboard.id,
                    componentId: component.id,
                    itemId: item.id,
                  }),
                );
              }}
              onOpen={() => setSelectedItemId(item.id)}
              onUpdateItem={onUpdateItem}
            />
          ))
        ) : (
          <div className="rounded-md border border-dashed border-line bg-white px-3 py-6 text-center text-xs text-muted">
            Drop cards here
          </div>
        )}
      </div>
      {selectedItem ? (
        <DashboardItemPreviewPane
          component={component}
          dashboard={dashboard}
          item={selectedItem}
          onClose={() => setSelectedItemId(null)}
          onDeleteItem={(targetDashboard, targetComponent, targetItem) => {
            onDeleteItem(targetDashboard, targetComponent, targetItem);
            setSelectedItemId(null);
          }}
          onUpdateItem={onUpdateItem}
        />
      ) : null}
    </div>
  );
}

function DashboardItemCard({
  component,
  dashboard,
  draggable = false,
  item,
  onDeleteItem,
  onDragStart,
  onOpen,
  onUpdateItem,
}) {
  return (
    <div
      className="cursor-pointer rounded-md border border-line bg-white p-3 text-xs shadow-sm transition hover:border-teal-200 hover:shadow"
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
    >
      <DashboardCardFields component={component} item={item} />
    </div>
  );
}

function DashboardCardFields({ component, item }) {
  const rows = dashboardDisplayRows(component, "card");
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <DashboardDisplayValue key={`${row.field}-${row.style}`} item={item} row={row} compact />
      ))}
    </div>
  );
}

function DashboardItemPreviewPane({ component, dashboard, item, onClose, onDeleteItem, onUpdateItem }) {
  const rows = dashboardDisplayRows(component, "detail");
  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-[calc(100vw-40px)] flex-col border-l border-line bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted">Card preview</div>
          <div className="mt-1 truncate text-base font-semibold text-ink">
            {item.title ?? item.name ?? item.id}
          </div>
        </div>
        <button
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-slate-50 hover:text-ink"
          type="button"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="workflow-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {rows.map((row) => (
          <DashboardPreviewField
            key={`${row.field}-${row.style}`}
            component={component}
            dashboard={dashboard}
            item={item}
            row={row}
            onUpdateItem={onUpdateItem}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-600 transition hover:bg-red-100"
          type="button"
          onClick={() => onDeleteItem(dashboard, component, item)}
        >
          <Trash2 size={15} />
          Delete
        </button>
        <button
          className="h-9 rounded-md bg-ink px-3 text-sm font-medium text-white transition hover:bg-slate-700"
          type="button"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function DashboardPreviewField({ component, dashboard, item, row, onUpdateItem }) {
  const [draft, setDraft] = useState(String(item[row.field] ?? ""));
  const fieldSchema = component.schema?.[row.field];
  const enumValues = fieldSchema?.type === "enum" ? fieldSchema.values ?? [] : [];

  useEffect(() => {
    setDraft(String(item[row.field] ?? ""));
  }, [item.id, item[row.field], row.field]);

  function commit(nextValue = draft) {
    if (nextValue !== String(item[row.field] ?? "")) {
      onUpdateItem(dashboard, component, item, { [row.field]: nextValue });
    }
  }

  if (enumValues.length && (row.style === "text" || row.style === "dropdown" || row.style === "textarea")) {
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase text-muted">{row.field}</span>
        <select
          className="mt-2 h-9 w-full rounded-md border border-line bg-white px-3 text-sm outline-none focus:border-teal-500"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            commit(event.target.value);
          }}
        >
          {enumValues.map((value) => (
            <option key={String(value)} value={String(value)}>
              {String(value)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (row.style === "textarea") {
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase text-muted">{row.field}</span>
        <textarea
          className="mt-2 min-h-32 w-full resize-y rounded-md border border-line px-3 py-2 text-sm leading-6 outline-none focus:border-teal-500"
          value={draft}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    );
  }

  if (row.style === "text") {
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase text-muted">{row.field}</span>
        <input
          className="mt-2 h-9 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-teal-500"
          value={draft}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(String(item[row.field] ?? ""));
              event.currentTarget.blur();
            }
          }}
        />
      </label>
    );
  }

  return (
    <div>
      <div className="text-xs font-semibold uppercase text-muted">{row.field}</div>
      <DashboardDisplayValue item={item} row={row} />
    </div>
  );
}

function DashboardDisplayValue({ compact = false, item, row }) {
  const value = item[row.field] ?? "";
  const text = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  if (row.style === "heading") {
    return <div className={`${compact ? "text-sm" : "text-xl"} font-semibold leading-6 text-ink`}>{text}</div>;
  }
  if (row.style === "muted") {
    return <div className={`${compact ? "line-clamp-2 text-xs" : "text-sm"} leading-6 text-muted`}>{text}</div>;
  }
  if (row.style === "code") {
    return (
      <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-2 text-xs text-slate-100">{text}</pre>
    );
  }
  return <div className={`${compact ? "line-clamp-2 text-xs" : "text-sm"} leading-6 text-slate-700`}>{text}</div>;
}

function DashboardMarkdownBlock({ contentDraft, onContentDraftChange, onSave }) {
  return (
    <div className="space-y-3 p-4">
      <textarea
        className="min-h-28 w-full resize-y rounded-md border border-line px-3 py-2 text-sm leading-6 outline-none focus:border-teal-500"
        placeholder={"# Label\n\nAdd explanatory dashboard text here."}
        value={contentDraft}
        onChange={(event) => onContentDraftChange(event.target.value)}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">Markdown label and paragraph block</span>
        <button
          className="h-8 rounded-md bg-ink px-3 text-xs font-medium text-white transition hover:bg-slate-700"
          type="button"
          onClick={onSave}
        >
          Save Markdown
        </button>
      </div>
      <div className="rounded-md border border-line bg-slate-50 p-4 text-ink">
        <DashboardMarkdownPreview content={contentDraft} />
      </div>
    </div>
  );
}

function DashboardMarkdownPreview({ content }) {
  const blocks = dashboardMarkdownBlocks(content);
  if (!blocks.length) {
    return <p className="text-sm leading-6 text-muted">Markdown content</p>;
  }
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          const sizeClass =
            block.level === 1 ? "text-lg" : block.level === 2 ? "text-base" : "text-sm";
          return (
            <Tag key={`${block.type}-${index}`} className={`${sizeClass} font-semibold leading-6`}>
              {block.text}
            </Tag>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={`${block.type}-${index}`} className="list-disc space-y-1 pl-5 text-sm leading-6">
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`${block.type}-${index}`} className="text-sm leading-6 text-slate-700">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function DashboardItemRow({ component, dashboard, item, onDeleteItem, onUpdateItem }) {
  return (
    <div className="border-b border-line bg-white p-2 text-xs last:border-b-0">
      <DashboardItemFields
        component={component}
        dashboard={dashboard}
        item={item}
        onDeleteItem={onDeleteItem}
        onUpdateItem={onUpdateItem}
      />
    </div>
  );
}

function DashboardItemFields({ component, dashboard, item, onDeleteItem, onUpdateItem }) {
  const fields = Object.keys(component.schema ?? {});
  const [draft, setDraft] = useState(() => itemFieldsDraft(item, fields));

  useEffect(() => {
    setDraft(itemFieldsDraft(item, fields));
  }, [item.id, fields.join("|")]);

  function commitField(field) {
    const nextValue = draft[field] ?? "";
    if (String(nextValue) !== String(item[field] ?? "")) {
      onUpdateItem(dashboard, component, item, { [field]: nextValue });
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{item.title ?? item.name ?? item.id}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted">{item.id}</div>
        </div>
        <button
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
          type="button"
          onClick={() => onDeleteItem(dashboard, component, item)}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {fields.map((field) => (
        <label key={field} className="grid grid-cols-[72px_1fr] items-center gap-2">
          <span className="truncate text-[11px] text-muted">{field}</span>
          <input
            className="h-7 min-w-0 rounded-md border border-line px-2 text-xs outline-none focus:border-teal-500"
            value={draft[field] ?? ""}
            onBlur={() => commitField(field)}
            onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraft(itemFieldsDraft(item, fields));
                event.currentTarget.blur();
              }
            }}
          />
        </label>
      ))}
    </div>
  );
}

function itemFieldsDraft(item, fields) {
  return Object.fromEntries(fields.map((field) => [field, item[field] ?? ""]));
}

const DASHBOARD_COMPONENT_TYPES = [
  { type: "markdown", label: "Markdown label" },
  { type: "table", label: "Table" },
  { type: "board", label: "Board" },
  { type: "stats", label: "Stats" },
  { type: "json_list", label: "JSON List" },
  { type: "chart", label: "Chart" },
];

const DASHBOARD_SECTION_WIDTHS = [
  { columns: 12, label: "Full" },
  { columns: 8, label: "Wide" },
  { columns: 6, label: "Half" },
  { columns: 4, label: "Third" },
];

const DASHBOARD_CARD_FIELD_STYLES = ["heading", "text", "muted", "code"];
const DASHBOARD_DETAIL_FIELD_STYLES = ["heading", "text", "muted", "textarea", "dropdown", "code"];

function dashboardComponentLabel(type) {
  if (type === "markdown") return "Markdown Label";
  return DASHBOARD_COMPONENT_TYPES.find((item) => item.type === type)?.label ?? "Component";
}

function dashboardSectionColumns(section) {
  const columns = Number(section.layout?.columns ?? 12);
  return DASHBOARD_SECTION_WIDTHS.some((option) => option.columns === columns) ? columns : 12;
}

function dashboardPrimaryField(component) {
  const fields = Object.keys(component.schema ?? {});
  if (fields.includes("title")) return "title";
  if (fields.includes("name")) return "name";
  return fields[0] ?? "title";
}

function dashboardFieldSchema(component, field) {
  return component.schema?.[field] ?? {};
}

function dashboardBoardColumnPatch(view) {
  if (!view?.filter || view.filter.operator !== "equals" || !view.filter.field) {
    return null;
  }
  return { [view.filter.field]: view.filter.value };
}

function dashboardDisplayRows(component, kind) {
  const configured = kind === "card" ? component.display?.cardFields : component.display?.detailFields;
  const fallback = kind === "card" ? defaultCardDisplay(component) : defaultDetailDisplay(component);
  return (configured?.length ? configured : fallback).filter((row) => row.field);
}

function defaultCardDisplay(component) {
  const fields = Object.keys(component.schema ?? {});
  const primary = dashboardPrimaryField(component);
  return [
    { field: primary, style: "heading" },
    ...(fields.includes("description") ? [{ field: "description", style: "muted" }] : []),
  ];
}

function defaultDetailDisplay(component) {
  const fields = Object.keys(component.schema ?? {});
  const primary = dashboardPrimaryField(component);
  const rows = [{ field: primary, style: "heading" }];
  for (const field of fields) {
    if (field === primary) continue;
    rows.push({
      field,
      style: dashboardFieldSchema(component, field).type === "enum" ? "dropdown" : field === "description" ? "textarea" : "text",
    });
  }
  return rows;
}

function displayToRows(rows, kind) {
  const source = rows?.length
    ? rows
    : kind === "card"
      ? [
          { field: "title", style: "heading" },
          { field: "description", style: "muted" },
        ]
      : [
          { field: "title", style: "heading" },
          { field: "status", style: "dropdown" },
          { field: "description", style: "textarea" },
        ];
  return source.map((row) => ({
    rowId: newDraftRowId(`${kind}-display`),
    field: row.field ?? "",
    style: row.style ?? "text",
  }));
}

function displayRowsToConfig(rows) {
  return rows
    .filter((row) => row.field)
    .map((row) => ({
      field: row.field,
      style: row.style || "text",
    }));
}

function dashboardMarkdownBlocks(content) {
  const blocks = [];
  let listItems = [];
  function flushList() {
    if (listItems.length) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  }
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      listItems.push(listItem[1]);
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", text: line });
  }
  flushList();
  return blocks;
}

function viewsToRows(views = []) {
  const rows = views.map((view) => ({
    rowId: view.id ?? newDraftRowId("view"),
    title: view.title ?? "",
    field: view.filter?.field ?? "",
    operator: view.filter?.operator ?? "equals",
    value: view.filter?.value ?? "",
  }));
  return rows.length
    ? rows
    : [
        { rowId: newDraftRowId("view"), title: "Backlog", field: "status", operator: "equals", value: "backlog" },
        { rowId: newDraftRowId("view"), title: "Todo", field: "status", operator: "equals", value: "todo" },
        { rowId: newDraftRowId("view"), title: "In Progress", field: "status", operator: "equals", value: "in_progress" },
        { rowId: newDraftRowId("view"), title: "Completed", field: "status", operator: "equals", value: "completed" },
      ];
}

function newDraftRowId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function moveArrayItem(items, fromIndex, toIndex) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function DashboardStats({ component, fields }) {
  const items = component.items ?? [];
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-md border border-line bg-slate-50 p-3">
        <div className="text-[11px] font-semibold uppercase text-muted">Items</div>
        <div className="mt-1 text-2xl font-semibold text-ink">{items.length}</div>
      </div>
      {fields.slice(0, 5).map((field) => (
        <div key={field} className="rounded-md border border-line bg-slate-50 p-3">
          <div className="truncate text-[11px] font-semibold uppercase text-muted">{field}</div>
          <div className="mt-1 text-2xl font-semibold text-ink">
            {new Set(items.map((item) => item[field]).filter((value) => value !== undefined && value !== "")).size}
          </div>
        </div>
      ))}
    </div>
  );
}

function DashboardChart({ component, views }) {
  const items = component.items ?? [];
  const buckets = views.length
    ? views.map((view) => ({
        title: view.title,
        count: items.filter((item) => dashboardItemMatchesView(item, view)).length,
      }))
    : [{ title: "Items", count: items.length }];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <div className="space-y-2 rounded-md border border-line bg-slate-50 p-3">
      {buckets.map((bucket) => (
        <div key={bucket.title} className="grid grid-cols-[96px_1fr_32px] items-center gap-2 text-xs">
          <div className="truncate font-medium text-muted">{bucket.title}</div>
          <div className="h-2 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-teal-600" style={{ width: `${(bucket.count / max) * 100}%` }} />
          </div>
          <div className="text-right font-semibold text-ink">{bucket.count}</div>
        </div>
      ))}
    </div>
  );
}

function schemaToRows(schema = {}) {
  const rows = Object.entries(schema).map(([name, config]) => {
    const normalized = typeof config === "string" ? { type: config } : config ?? {};
    return {
      rowId: `field-${name}`,
      name,
      type: normalized.type ?? "string",
      values: (normalized.values ?? []).join(", "),
    };
  });
  return rows.length ? rows : [{ rowId: "field-title", name: "title", type: "string", values: "" }];
}

function dashboardItemMatchesView(item, view) {
  const filter = view?.filter;
  if (!filter?.field) return true;
  const current = item[filter.field];
  if (filter.operator === "not_equals") return String(current) !== String(filter.value);
  if (filter.operator === "contains") {
    return String(current ?? "").toLowerCase().includes(String(filter.value ?? "").toLowerCase());
  }
  if (filter.operator === "exists") return current !== undefined && current !== null && current !== "";
  return String(current) === String(filter.value);
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

function WorkflowHealthPanel({ doctorState, workflow }) {
  const globalErrors = doctorState?.errors ?? [];
  const globalWarnings = doctorState?.warnings ?? [];
  const workflowErrors = workflow?.healthErrors ?? [];
  const workflowWarnings = workflow?.healthWarnings ?? [];
  const validationErrors = workflow?.validationErrors ?? [];
  const validationWarnings = workflow?.validationWarnings ?? [];
  const errors = [...globalErrors, ...workflowErrors, ...validationErrors];
  const warnings = [...globalWarnings, ...workflowWarnings, ...validationWarnings];
  const diagnostics = [...errors, ...warnings].filter((diagnostic) =>
    diagnostic?.severity === "error" || diagnostic?.severity === "warning",
  );
  const diagnosticKey = diagnostics
    .map((diagnostic) =>
      [
        diagnostic.id,
        diagnostic.subject ?? "",
        diagnostic.severity,
        diagnostic.message,
      ].join(":"),
    )
    .join("|");
  const [dismissedDiagnosticKey, setDismissedDiagnosticKey] = useState("");
  const [dismissedDoctorError, setDismissedDoctorError] = useState("");
  if (doctorState?.loading && !diagnostics.length) {
    return (
      <section className="border-b border-line bg-white px-5 py-2">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" />
          <span>Checking environment health...</span>
        </div>
      </section>
    );
  }
  if (doctorState?.error && !diagnostics.length) {
    if (dismissedDoctorError === doctorState.error) {
      return null;
    }
    return (
      <section className="border-b border-amber-200 bg-amber-50 px-5 py-2">
        <div className="flex items-center gap-2 text-sm text-amber-800">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{doctorState.error}</span>
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-amber-800 transition hover:bg-amber-100 hover:text-amber-950"
            title="Hide environment warning"
            aria-label="Hide environment warning"
            onClick={() => setDismissedDoctorError(doctorState.error)}
          >
            <X size={16} />
          </button>
        </div>
      </section>
    );
  }
  if (!diagnostics.length) {
    return null;
  }
  if (diagnostics.length && dismissedDiagnosticKey === diagnosticKey) {
    return null;
  }

  const errorCount = errors.length;
  return (
    <section
      className={`border-b px-5 py-3 ${
        errorCount ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className={`mt-0.5 shrink-0 ${errorCount ? "text-red-600" : "text-amber-700"}`}
          size={17}
        />
        <div className="min-w-0 flex-1">
          <h2 className={`text-sm font-semibold ${errorCount ? "text-red-800" : "text-amber-900"}`}>
            {errorCount ? "Environment setup needs attention" : "Environment setup warnings"}
          </h2>
          <ul className={`mt-1 space-y-1 text-sm leading-5 ${errorCount ? "text-red-700" : "text-amber-800"}`}>
            {diagnostics.slice(0, 3).map((diagnostic, index) => (
              <li key={`${diagnostic.id}-${diagnostic.subject ?? "workflow"}-${index}`}>
                {diagnostic.message}
              </li>
            ))}
          </ul>
          {diagnostics.length > 3 ? (
            <p className={`mt-1 text-xs ${errorCount ? "text-red-700" : "text-amber-800"}`}>
              {diagnostics.length - 3} more issue{diagnostics.length === 4 ? "" : "s"} shown in workflow settings.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition ${
            errorCount
              ? "text-red-700 hover:bg-red-100 hover:text-red-900"
              : "text-amber-800 hover:bg-amber-100 hover:text-amber-950"
          }`}
          title="Hide environment warning"
          aria-label="Hide environment warning"
          onClick={() => setDismissedDiagnosticKey(diagnosticKey)}
        >
          <X size={16} />
        </button>
      </div>
    </section>
  );
}

function agentExternalAccessWarnings(workflow) {
  return (workflow?.resourceWarnings ?? []).filter((warning) =>
    String(warning).includes("grants provider filesystem access outside working_dir"),
  );
}

function StatusDot({ status }) {
  const normalizedStatus = status || "Ready";
  const color = {
    Ready: "bg-emerald-500",
    Success: "bg-emerald-500",
    Error: "bg-red-500",
    Stopped: "bg-amber-500",
  }[normalizedStatus] ?? "bg-emerald-500";
  const running = normalizedStatus === "Running";

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${
        running
          ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-sky-700/70 dark:bg-sky-950/70 dark:text-sky-200"
          : "border-line bg-white text-slate-600"
      }`}
    >
      {running ? (
        <Loader2 size={11} className="animate-spin text-blue-600 dark:text-sky-300" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      )}
      {normalizedStatus}
    </span>
  );
}
