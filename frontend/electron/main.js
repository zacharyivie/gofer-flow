import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const pty = require("node-pty");
const {
  addGitWorktree,
  readGitFileBaseline,
  readGitHistory,
  readGitStatus,
  readGitWorktrees,
  removeGitWorktree,
} = require("./git-status.cjs");
const { browserShortcutAction, normalizeBrowserUrl } = require("./browser-utils.cjs");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createIpcSecurity, isSafeExternalUrl } = require("./security.cjs");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const distIndexPath = path.join(__dirname, "..", "dist", "index.html");
const backendErrorHtmlPath = path.join(__dirname, "backend-error.html");

if (process.platform === "linux" && !process.env.GTK_USE_PORTAL) {
  process.env.GTK_USE_PORTAL = "0";
}

if (
  process.env.GOFER_ELECTRON_SMOKE_TEST === "1" ||
  process.env.GOFER_DISABLE_HARDWARE_ACCELERATION === "1"
) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}
if (process.env.GOFER_ELECTRON_SMOKE_TEST === "1") {
  app.commandLine.appendSwitch("no-sandbox");
}

const VITE_DEV_SERVER_URL =
  process.env.GOFER_VITE_DEV_SERVER_URL ||
  process.env.VITE_DEV_SERVER_URL ||
  "http://127.0.0.1:5173";
const BACKEND_READY_PREFIX = "GOFER_UI_READY ";
const BACKEND_START_TIMEOUT_MS = 15000;
const ELECTRON_READY_MESSAGE = "GOFER_ELECTRON_READY";
const BACKEND_EXECUTABLE_NAME = process.platform === "win32" ? "gof.exe" : "gof";
const LATEST_RELEASE_URL =
  "https://api.github.com/repos/zacharyivie/gofer-flow/releases/latest";
const isProduction =
  app.isPackaged || process.env.GOFER_ELECTRON_MODE === "production";
const isSmokeTest = process.env.GOFER_ELECTRON_SMOKE_TEST === "1";
let backendProcess;
let backendLogStream;
const desktopGrantSecret = crypto.randomBytes(32).toString("hex");
const expectedBackendStops = new WeakSet();
let isQuitting = false;
let activeApiBaseUrl;
let activeUiApiToken;
let selectedDataDir;
let mainWindow;
let backendErrorWindow;
let ipcSecurity;
let backendErrorIpcSecurity;
const terminalSessions = new Map();
const browserSessions = new Map();
let updateState = {
  available: false,
  checking: false,
  downloading: false,
  downloaded: false,
  error: "",
  info: null,
  progress: null,
};
let installUpdateAfterDownload = false;

const singleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

function createWindow(apiBaseUrl, apiToken = "") {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    title: "Taskurotta",
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isSmokeTest,
      additionalArguments: [
        `--gofer-api-base-url=${apiBaseUrl}`,
        `--gofer-api-token=${apiToken}`,
      ],
    },
  });
  const terminalOwnerId = mainWindow.webContents.id;

  mainWindow.webContents.once("did-finish-load", () => {
    if (!isSmokeTest) return;

    console.log(ELECTRON_READY_MESSAGE);
    setTimeout(() => app.quit(), 250);
  });

  mainWindow.webContents.once(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      if (!isSmokeTest) return;

      console.error(
        `GOFER_ELECTRON_LOAD_FAILED ${JSON.stringify({
          errorCode,
          errorDescription,
          url: validatedUrl,
        })}`,
      );
      app.exit(1);
    },
  );

  if (isProduction) {
    mainWindow.loadFile(distIndexPath);
  } else {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (process.env.GOFER_ELECTRON_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    closeBrowsersForOwner(terminalOwnerId);
    closeTerminalsForOwner(terminalOwnerId);
    mainWindow = undefined;
  });
}

function startBackend() {
  const manualApiBaseUrl = process.env.GOFER_API_BASE_URL || process.env.VITE_API_BASE_URL;
  if (manualApiBaseUrl) {
    return Promise.resolve({
      apiBaseUrl: manualApiBaseUrl,
      apiToken: process.env.GOFER_UI_API_TOKEN || "",
    });
  }

  return new Promise((resolve, reject) => {
    const backendCommand = getBackendCommand();
    const args = [
      ...backendCommand.args,
      "ui",
      "serve",
      "--port",
      "0",
      "--data-dir",
      getGoferDataDir(),
    ];

    const child = spawn(backendCommand.command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        GOFER_DESKTOP_GRANT_SECRET: desktopGrantSecret,
        GOFER_UI_EMIT_READY_TOKEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendProcess = child;
    backendLogStream = createBackendLogStream();

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const timeoutId = setTimeout(() => {
      fail(new Error("Timed out waiting for the Taskurotta backend to start."));
    }, BACKEND_START_TIMEOUT_MS);

    function succeed(apiBaseUrl, apiToken = "") {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      writeBackendLog(`READY ${apiBaseUrl}\n`);
      resolve({ apiBaseUrl, apiToken });
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      stopBackend();
      reject(error);
    }

    function handleOutput(chunk) {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith(BACKEND_READY_PREFIX)) {
          writeBackendLog(`${line}\n`);
          console.log(`[gofer-backend] ${line}`);
          continue;
        }

        try {
          const payload = JSON.parse(line.slice(BACKEND_READY_PREFIX.length));
          const host = payload.host || "127.0.0.1";
          const port = Number(payload.port);
          const apiToken = typeof payload.apiToken === "string" ? payload.apiToken : "";
          if (!port) {
            throw new Error("Ready payload did not include a valid port.");
          }
          console.log(`[gofer-backend] GOFER_UI_READY ${JSON.stringify({ host, port })}`);
          succeed(`http://${host}:${port}`, apiToken);
        } catch (error) {
          fail(error);
        }
      }
    }

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      writeBackendLog(text);
      process.stderr.write(`[gofer-backend] ${text}`);
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("exit", (code, signal) => {
      if (backendProcess === child) {
        backendProcess = undefined;
        closeBackendLogStream();
      }
      if (isQuitting || expectedBackendStops.has(child)) {
        return;
      }
      const detail = stderrBuffer.trim() || `Backend exited with code ${code ?? signal}.`;
      if (!settled) {
        fail(new Error(detail));
        return;
      }

      showBackendCrash(new Error(detail));
    });
  });
}

function getBackendCommand() {
  if (!isProduction) {
    return {
      command: "uv",
      args: ["run", "gof"],
    };
  }

  return {
    command: process.env.GOFER_BACKEND_PATH || defaultPackagedBackendPath(),
    args: [],
  };
}

function defaultPackagedBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", BACKEND_EXECUTABLE_NAME);
  }

  return path.join(repoRoot, "dist", BACKEND_EXECUTABLE_NAME);
}

function getGoferDataDir() {
  if (selectedDataDir) {
    return selectedDataDir;
  }

  if (process.env.GOFER_DATA_DIR) {
    return process.env.GOFER_DATA_DIR;
  }

  const persistedDataDir = readPersistedDataDir();
  if (persistedDataDir) {
    selectedDataDir = persistedDataDir;
    process.env.GOFER_DATA_DIR = persistedDataDir;
    return persistedDataDir;
  }

  if (process.platform === "win32") {
    return path.join(app.getPath("appData"), "gofer");
  }

  if (process.platform === "darwin") {
    return path.join(app.getPath("appData"), "gofer");
  }

  return path.join(
    process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share"),
    "gofer",
  );
}

function readPersistedDataDir() {
  try {
    const payload = JSON.parse(fs.readFileSync(dataDirConfigPath(), "utf8"));
    return typeof payload.dataDir === "string" && payload.dataDir.trim()
      ? payload.dataDir
      : "";
  } catch {
    return "";
  }
}

function writePersistedDataDir(dataDir) {
  const configPath = dataDirConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ dataDir }, null, 2)}\n`,
    "utf8",
  );
}

function dataDirConfigPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) return;

  const child = backendProcess;
  backendProcess = undefined;
  expectedBackendStops.add(child);
  closeBackendLogStream();
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 3000).unref();
}

function createBackendLogStream() {
  const logsPath = app.getPath("logs");
  fs.mkdirSync(logsPath, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return fs.createWriteStream(path.join(logsPath, `backend-${timestamp}.log`), {
    flags: "a",
  });
}

function writeBackendLog(message) {
  if (!backendLogStream) return;
  backendLogStream.write(message);
}

function closeBackendLogStream() {
  if (!backendLogStream) return;
  backendLogStream.end();
  backendLogStream = undefined;
}

function showBackendCrash(error) {
  if (isSmokeTest) {
    console.error(
      `GOFER_ELECTRON_BACKEND_FAILED ${JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      })}`,
    );
    app.exit(1);
    return;
  }

  createBackendErrorWindow(error, { title: "Taskurotta backend stopped" });
}

function createBackendErrorWindow(error, { title = "Taskurotta backend did not start" } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  if (backendErrorWindow && !backendErrorWindow.isDestroyed()) {
    backendErrorWindow.focus();
    return;
  }

  const errorWindow = new BrowserWindow({
    width: 720,
    height: 420,
    title: "Taskurotta Backend Error",
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: path.join(__dirname, "error-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isSmokeTest,
    },
  });
  backendErrorWindow = errorWindow;

  errorWindow.loadFile(backendErrorHtmlPath, {
    query: {
      message,
      title,
    },
  });
  errorWindow.on("closed", () => {
    backendErrorWindow = undefined;
    backendErrorIpcSecurity = undefined;
  });
}

app.whenReady().then(async () => {
  setupApplicationMenu();
  setupIpcHandlers();
  setupAutoUpdater();
  try {
    const backend = await startBackend();
    activeApiBaseUrl = backend.apiBaseUrl;
    activeUiApiToken = backend.apiToken;
    createWindow(backend.apiBaseUrl, backend.apiToken);
  } catch (error) {
    if (isSmokeTest) {
      console.error(
        `GOFER_ELECTRON_BACKEND_FAILED ${JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        })}`,
      );
      app.exit(1);
      return;
    }

    createBackendErrorWindow(error);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && activeApiBaseUrl) {
      createWindow(activeApiBaseUrl, activeUiApiToken);
    }
  });
});

app.on("second-instance", () => {
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.on("before-quit", () => {
  isQuitting = true;
  closeAllBrowsers();
  closeAllTerminals();
  stopBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function setupApplicationMenu() {
  const viewSubmenu = [
    {
      label: "Browser",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("gofer:browser-command", { action: "open-browser" });
        }
      },
    },
  ];
  if (!isProduction) {
    viewSubmenu.push(
      { type: "separator" },
      { role: "reload", label: "Reload" },
      { role: "forceReload", label: "Force Reload" },
      { type: "separator" },
      { role: "toggleDevTools" },
    );
  }
  const template = [
    {
      label: "Taskurotta",
      submenu: [
        {
          label: "About Taskurotta",
          click: () => {
            dialog.showMessageBox({
              type: "info",
              title: "About Taskurotta",
              message: "Taskurotta",
              detail: "Local workflow automation studio.",
            });
          },
        },
        { type: "separator" },
        {
          label: "Open Logs Folder",
          click: openLogsFolder,
        },
        { type: "separator" },
        {
          role: "quit",
          label: "Quit",
        },
      ],
    },
    {
      label: "View",
      submenu: viewSubmenu,
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupIpcHandlers() {
  ipcSecurity = createIpcSecurity({
    appRoots: [path.dirname(distIndexPath)],
    devServerUrl: VITE_DEV_SERVER_URL,
    getDataDir: getGoferDataDir,
    getMainWebContents: () =>
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null,
    isProduction,
  });
  backendErrorIpcSecurity = createIpcSecurity({
    appRoots: [path.dirname(backendErrorHtmlPath)],
    devServerUrl: VITE_DEV_SERVER_URL,
    getDataDir: getGoferDataDir,
    getMainWebContents: () =>
      backendErrorWindow && !backendErrorWindow.isDestroyed()
        ? backendErrorWindow.webContents
        : null,
    isProduction,
  });
  registerIpcHandlers(ipcMain, {
    checkForUpdates,
    copyPath,
    browserAction,
    createBrowser,
    createFile,
    createFolder,
    createTerminal,
    deletePath,
    downloadAndInstallUpdate,
    getGoferDataDir,
    gitStatus,
    gitFileBaseline,
    gitHistory,
    gitWorktrees,
    gitWorktreeAdd,
    gitWorktreeRemove,
    grantPath,
    getUpdateState,
    installDownloadedUpdate,
    listDirectory,
    openLogsFolder,
    openPath,
    openUpdateRelease,
    pathInfo,
    readBinaryPreview,
    readTextFile,
    resizeTerminal,
    renamePath,
    resolveProjectFile,
    restartBackend,
    revealPath,
    selectPath,
    setDataDir,
    closeTerminal,
    writeTerminal,
    writeTextFile,
  }, {
    secureHandler: (handler, channel) => async (event, ...args) => {
      if (
        (channel === "gofer:restart-backend" || channel === "gofer:open-logs") &&
        backendErrorWindow &&
        !backendErrorWindow.isDestroyed()
      ) {
        return backendErrorIpcSecurity.secureHandler(handler)(event, ...args);
      }
      return ipcSecurity.secureHandler(handler)(event, ...args);
    },
  });
}

function createBrowser(event, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("The browser window is unavailable.");
  }
  const requestedPath = typeof options.path === "string" ? options.path.trim() : "";
  let url = "about:blank";
  let grantId = "";
  if (requestedPath) {
    const targetPath = resolveExactPath(requestedPath, {
      grantId: options.grantId,
      mustExist: true,
    });
    if (!fs.statSync(targetPath).isFile()) {
      throw new Error(`Browser preview path is not a file: ${targetPath}`);
    }
    url = pathToFileURL(targetPath).toString();
    grantId = typeof options.grantId === "string" ? options.grantId : "";
  } else if (options.url) {
    url = normalizeBrowserUrl(options.url);
  }

  const id = crypto.randomUUID();
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "persist:taskurotta-browser",
    },
  });
  view.setBackgroundColor("#ffffff");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  const session = {
    clientId: typeof options.clientId === "string" ? options.clientId : "",
    error: "",
    grantId,
    id,
    owner: event.sender,
    ownerId: event.sender.id,
    openBrowserBinding: typeof options.openBrowserBinding === "string"
      ? options.openBrowserBinding.slice(0, 120)
      : "Mod+Alt+Slash",
    view,
  };
  browserSessions.set(id, session);
  configureBrowserSession(session);
  void view.webContents.loadURL(url).catch((error) => {
    session.error = error instanceof Error ? error.message : String(error);
    emitBrowserState(session);
  });
  event.sender.once("destroyed", () => closeBrowserSession(session));
  return browserSessionState(session, url);
}

function browserAction(event, options = {}) {
  const session = ownedBrowserSession(event, options.id);
  const contents = session.view.webContents;
  switch (options.action) {
    case "activate":
      setBrowserSessionActive(session, options.active === true);
      break;
    case "back":
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      break;
    case "close":
      closeBrowserSession(session);
      return { closed: true };
    case "focus":
      contents.focus();
      break;
    case "forward":
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      break;
    case "navigate":
      session.error = "";
      void contents.loadURL(normalizeBrowserUrl(options.url)).catch((error) => {
        session.error = error instanceof Error ? error.message : String(error);
        emitBrowserState(session);
      });
      break;
    case "open-external": {
      const url = contents.getURL();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      break;
    }
    case "reload":
      contents.reload();
      break;
    case "set-preferences":
      session.openBrowserBinding = typeof options.openBrowserBinding === "string"
        ? options.openBrowserBinding.slice(0, 120)
        : session.openBrowserBinding;
      break;
    case "set-bounds":
      setBrowserSessionBounds(session, options.bounds);
      break;
    case "stop":
      contents.stop();
      break;
    default:
      throw new Error(`Unknown browser action: ${options.action || "missing"}`);
  }
  return browserSessionState(session);
}

function configureBrowserSession(session) {
  const contents = session.view.webContents;
  const update = () => emitBrowserState(session);
  contents.on("did-start-loading", () => {
    session.error = "";
    update();
  });
  contents.on("did-stop-loading", update);
  contents.on("did-navigate", update);
  contents.on("did-navigate-in-page", update);
  contents.on("page-title-updated", update);
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    session.error = `${errorDescription}: ${validatedUrl}`;
    update();
  });
  contents.on("render-process-gone", (_event, details) => {
    session.error = `Browser renderer stopped: ${details.reason}`;
    update();
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedBrowserNavigation(session, url)) event.preventDefault();
  });
  contents.on("before-input-event", (event, input) => {
    const action = browserShortcutAction(input, process.platform, session.openBrowserBinding);
    if (!action) return;
    event.preventDefault();
    if (action === "focus-location" || action === "close") {
      emitBrowserCommand(session, action);
      return;
    }
    if (action === "open-browser") {
      emitBrowserCommand(session, action);
      return;
    }
    if (action === "reload") contents.reload();
    if (action === "back" && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
    if (action === "forward" && contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
    if (action === "zoom-in") contents.setZoomFactor(Math.min(3, contents.getZoomFactor() + 0.1));
    if (action === "zoom-out") contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() - 0.1));
    if (action === "zoom-reset") contents.setZoomFactor(1);
  });
  if (session.grantId) {
    contents.on("before-mouse-event", (event, mouse) => {
      if (mouse.type !== "mouseDown" || mouse.button !== "left" || mouse.clickCount !== 2) return;
      event.preventDefault();
      emitBrowserCommand(session, "edit-local-html");
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserNavigation(session, url) && !session.owner.isDestroyed()) {
      session.owner.send("gofer:browser-open-tab", { url });
    }
    return { action: "deny" };
  });
  contents.on("context-menu", (_event, params) => showBrowserContextMenu(session, params));
}

function showBrowserContextMenu(session, params) {
  const contents = session.view.webContents;
  const template = [];
  if (params.linkURL && isSafeExternalUrl(params.linkURL)) {
    template.push({
      label: "Open link in new browser tab",
      click: () => session.owner.send("gofer:browser-open-tab", { url: params.linkURL }),
    });
    template.push({ type: "separator" });
  }
  if (params.isEditable) {
    template.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" });
  } else if (params.selectionText) {
    template.push({ role: "copy" }, { type: "separator" });
  }
  template.push(
    {
      label: "Back",
      enabled: contents.navigationHistory.canGoBack(),
      click: () => contents.navigationHistory.goBack(),
    },
    {
      label: "Forward",
      enabled: contents.navigationHistory.canGoForward(),
      click: () => contents.navigationHistory.goForward(),
    },
    { label: "Reload", click: () => contents.reload() },
    { type: "separator" },
    { label: "Inspect", click: () => contents.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

function setBrowserSessionActive(session, active) {
  if (active) {
    for (const candidate of browserSessions.values()) {
      if (candidate.ownerId === session.ownerId && candidate.id !== session.id) {
        candidate.view.setVisible(false);
      }
    }
  }
  session.view.setVisible(active);
  if (active) session.view.webContents.focus();
}

function setBrowserSessionBounds(session, bounds = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const windowBounds = mainWindow.getContentBounds();
  const x = clampInteger(bounds.x, 0, windowBounds.width);
  const y = clampInteger(bounds.y, 0, windowBounds.height);
  const width = clampInteger(bounds.width, 0, windowBounds.width - x);
  const height = clampInteger(bounds.height, 0, windowBounds.height - y);
  session.view.setBounds({ x, y, width, height });
}

function browserSessionState(session, fallbackUrl = "about:blank") {
  const contents = session.view.webContents;
  return {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    clientId: session.clientId,
    error: session.error,
    id: session.id,
    loading: contents.isLoading(),
    title: contents.getTitle(),
    url: contents.getURL() || fallbackUrl,
  };
}

function emitBrowserState(session) {
  if (!session.owner.isDestroyed()) {
    session.owner.send("gofer:browser-state", browserSessionState(session));
  }
}

function emitBrowserCommand(session, action) {
  if (!session.owner.isDestroyed()) {
    session.owner.send("gofer:browser-command", {
      action,
      clientId: session.clientId,
      id: session.id,
    });
  }
}

function ownedBrowserSession(event, id) {
  const session = typeof id === "string" ? browserSessions.get(id) : null;
  if (!session || session.ownerId !== event.sender.id) {
    throw new Error("Browser session was not found.");
  }
  return session;
}

function closeBrowserSession(session) {
  if (!session || !browserSessions.has(session.id)) return;
  browserSessions.delete(session.id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(session.view);
  }
  if (!session.view.webContents.isDestroyed()) session.view.webContents.close();
}

function closeBrowsersForOwner(ownerId) {
  for (const session of [...browserSessions.values()]) {
    if (session.ownerId === ownerId) closeBrowserSession(session);
  }
}

function closeAllBrowsers() {
  for (const session of [...browserSessions.values()]) closeBrowserSession(session);
}

function isAllowedBrowserNavigation(session, value) {
  try {
    const url = new URL(value);
    if (["http:", "https:", "about:", "blob:", "data:"].includes(url.protocol)) return true;
    if (url.protocol !== "file:" || !session.grantId) return false;
    resolveExactPath(fileURLToPath(url), { grantId: session.grantId, mustExist: true });
    return true;
  } catch {
    return false;
  }
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || 0)));
}

function createTerminal(event, options = {}) {
  const requestedCwd = typeof options.cwd === "string" ? options.cwd.trim() : "";
  const cwd = requestedCwd
    ? resolveExactPath(requestedCwd, { grantId: options.grantId, mustExist: true })
    : getGoferDataDir();
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`Terminal directory is not a folder: ${cwd}`);
  }

  const shell = terminalShell();
  const id = crypto.randomUUID();
  const terminal = pty.spawn(shell.command, shell.args, {
    cols: terminalDimension(options.cols, 80, 2, 500),
    cwd,
    env: {
      ...process.env,
      ...(shell.env ?? {}),
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    },
    name: "xterm-256color",
    rows: terminalDimension(options.rows, 24, 1, 200),
  });
  const session = {
    id,
    ownerId: event.sender.id,
    terminal,
  };
  terminalSessions.set(id, session);
  terminal.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("gofer:terminal-data", { data, id });
    }
  });
  terminal.onExit(({ exitCode, signal }) => {
    terminalSessions.delete(id);
    if (!event.sender.isDestroyed()) {
      event.sender.send("gofer:terminal-exit", { exitCode, id, signal });
    }
  });

  return {
    cwd,
    id,
    pid: terminal.pid,
    shell: shell.label,
  };
}

function writeTerminal(event, options = {}) {
  const session = ownedTerminalSession(event, options.id);
  if (typeof options.data !== "string" || options.data.length > 64 * 1024) {
    throw new Error("Terminal input must be a string smaller than 64 KB.");
  }
  session.terminal.write(options.data);
  return { written: true };
}

function resizeTerminal(event, options = {}) {
  const session = ownedTerminalSession(event, options.id);
  session.terminal.resize(
    terminalDimension(options.cols, 80, 2, 500),
    terminalDimension(options.rows, 24, 1, 200),
  );
  return { resized: true };
}

function closeTerminal(event, options = {}) {
  const session = ownedTerminalSession(event, options.id);
  terminalSessions.delete(session.id);
  session.terminal.kill();
  return { closed: true };
}

function ownedTerminalSession(event, id) {
  const session = typeof id === "string" ? terminalSessions.get(id) : null;
  if (!session || session.ownerId !== event.sender.id) {
    throw new Error("Terminal session was not found.");
  }
  return session;
}

function terminalShell() {
  if (process.platform === "win32") {
    return {
      args: ["-NoLogo", "-NoExit", "-Command", powershellIntegrationCommand()],
      command: path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      label: "PowerShell",
    };
  }
  const integrationPath = bashIntegrationPath();
  if (integrationPath) {
    return {
      args: ["--rcfile", integrationPath],
      command: "/bin/bash",
      label: "bash",
    };
  }
  return {
    args: [],
    command: "/bin/bash",
    env: {
      PROMPT_COMMAND: [
        "printf '\\033]633;P;Cwd=%s\\007' \"$PWD\"",
        process.env.PROMPT_COMMAND,
      ].filter(Boolean).join(";"),
    },
    label: "bash",
  };
}

function bashIntegrationPath() {
  try {
    const integrationDirectory = path.join(app.getPath("userData"), "shell-integration");
    const integrationPath = path.join(integrationDirectory, "bash.sh");
    const source = [
      'if [ -f "$HOME/.bashrc" ]; then',
      '  . "$HOME/.bashrc"',
      "fi",
      "__taskurotta_report_cwd() {",
      "  printf '\\033]633;P;Cwd=%s\\007' \"$PWD\"",
      "}",
      'case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in',
      '  "declare -a"*) PROMPT_COMMAND[${#PROMPT_COMMAND[@]}]=__taskurotta_report_cwd ;;',
      '  *) if [ -n "$PROMPT_COMMAND" ]; then',
      '       PROMPT_COMMAND="__taskurotta_report_cwd;$PROMPT_COMMAND"',
      "     else",
      '       PROMPT_COMMAND="__taskurotta_report_cwd"',
      "     fi ;;",
      "esac",
      "",
    ].join("\n");
    fs.mkdirSync(integrationDirectory, { recursive: true });
    fs.writeFileSync(integrationPath, source, { encoding: "utf8", mode: 0o600 });
    return integrationPath;
  } catch {
    return "";
  }
}

function powershellIntegrationCommand() {
  return [
    "$global:__TaskurottaOriginalPrompt = $function:prompt",
    'function global:prompt { $cwdPath = $executionContext.SessionState.Path.CurrentLocation.Path; [Console]::Write("$([char]27)]633;P;Cwd=$cwdPath$([char]7)"); if ($global:__TaskurottaOriginalPrompt) { & $global:__TaskurottaOriginalPrompt } else { "PS $cwdPath> " } }',
  ].join("; ");
}

function terminalDimension(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function closeTerminalsForOwner(ownerId) {
  if (!ownerId) return;
  for (const [id, session] of terminalSessions.entries()) {
    if (session.ownerId !== ownerId) continue;
    terminalSessions.delete(id);
    session.terminal.kill();
  }
}

function closeAllTerminals() {
  for (const [id, session] of terminalSessions.entries()) {
    terminalSessions.delete(id);
    session.terminal.kill();
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ checking: true, error: "" });
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      available: true,
      checking: false,
      downloaded: false,
      downloading: false,
      error: "",
      info: updateInfoPayload(info),
      progress: null,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({
      available: false,
      checking: false,
      downloaded: false,
      downloading: false,
      error: "",
      info: updateInfoPayload(info),
      progress: null,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      downloading: true,
      progress: {
        percent: Number(progress.percent || 0),
        transferred: Number(progress.transferred || 0),
        total: Number(progress.total || 0),
        bytesPerSecond: Number(progress.bytesPerSecond || 0),
      },
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({
      available: true,
      checking: false,
      downloaded: true,
      downloading: false,
      error: "",
      info: updateInfoPayload(info),
      progress: { percent: 100 },
    });
    if (installUpdateAfterDownload) {
      installUpdateAfterDownload = false;
      setImmediate(() => {
        isQuitting = true;
        stopBackend();
        autoUpdater.quitAndInstall(false, true);
      });
    }
  });
  autoUpdater.on("error", (error) => {
    installUpdateAfterDownload = false;
    if (isNoPublishedVersionsError(error)) {
      setNoReleasesUpdateState();
      return;
    }
    setUpdateState({
      checking: false,
      downloading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged || isSmokeTest) {
    setUpdateState(await checkLatestReleaseFallback());
    return getUpdateState();
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (isNoPublishedVersionsError(error)) {
      setNoReleasesUpdateState();
      return getUpdateState();
    }
    throw error;
  }
  return getUpdateState();
}

async function downloadAndInstallUpdate() {
  if (!app.isPackaged || isSmokeTest) {
    await openUpdateRelease();
    return getUpdateState();
  }

  installUpdateAfterDownload = true;
  setUpdateState({ downloading: true, error: "" });
  await autoUpdater.downloadUpdate();
  return getUpdateState();
}

function installDownloadedUpdate() {
  if (!app.isPackaged || isSmokeTest) {
    return getUpdateState();
  }
  isQuitting = true;
  stopBackend();
  autoUpdater.quitAndInstall(false, true);
  return getUpdateState();
}

async function openUpdateRelease() {
  await shell.openExternal("https://github.com/zacharyivie/gofer-flow/releases/latest");
  return { opened: true };
}

function getUpdateState() {
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    supported: app.isPackaged && !isSmokeTest,
  };
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("gofer:update-state", getUpdateState());
  }
}

function setNoReleasesUpdateState() {
  setUpdateState({
    available: false,
    checking: false,
    downloaded: false,
    downloading: false,
    error: "",
    info: {
      noReleases: true,
      releaseName: "No published releases yet",
      version: app.getVersion(),
    },
    progress: null,
  });
}

function updateInfoPayload(info) {
  if (!info) return null;
  return {
    version: info.version || "",
    releaseName: info.releaseName || "",
    releaseDate: info.releaseDate || "",
  };
}

async function checkLatestReleaseFallback() {
  const currentVersion = app.getVersion();
  if (isSmokeTest) {
    return {
      available: false,
      checking: false,
      downloading: false,
      downloaded: false,
      error: "",
      info: { version: currentVersion },
      progress: null,
    };
  }

  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `Taskurotta/${app.getVersion()}`,
    },
  });
  if (response.status === 404) {
    return {
      available: false,
      checking: false,
      downloading: false,
      downloaded: false,
      error: "",
      info: {
        noReleases: true,
        releaseName: "No published releases yet",
        version: currentVersion,
      },
      progress: null,
    };
  }
  if (!response.ok) {
    throw new Error(`GitHub releases API returned ${response.status}`);
  }
  const release = await response.json();
  return {
    available: compareVersions(normalizeVersion(release.tag_name), normalizeVersion(currentVersion)) > 0,
    checking: false,
    downloading: false,
    downloaded: false,
    error: "",
    info: {
      version: normalizeVersion(release.tag_name || release.name || ""),
      releaseName: release.name || release.tag_name || "",
      releaseDate: release.published_at || "",
    },
    progress: null,
  };
}

function isNoPublishedVersionsError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("No published versions on GitHub") ||
    message.includes("ERR_XML_MISSED_ELEMENT")
  );
}

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/v?(\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : "0.0.0";
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function versionParts(version) {
  return normalizeVersion(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

async function openPath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const result = await shell.openPath(resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  }));
  if (result) {
    throw new Error(result);
  }
  return { opened: true };
}

async function revealPath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  if (fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
    return { opened: true };
  }

  const parentPath = path.dirname(targetPath);
  if (fs.existsSync(parentPath)) {
    const result = await shell.openPath(parentPath);
    if (result) {
      throw new Error(result);
    }
    return { opened: true };
  }

  throw new Error(`Path does not exist: ${targetPath}`);
}

async function pathInfo(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(targetPath);
  return pathInfoFromStat(targetPath, stat);
}

async function resolveProjectFile(_event, options = {}) {
  const selectedPath = resolveExactPath(options.selectedPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(selectedPath);
  const selectedDirectory = stat.isDirectory() ? selectedPath : path.dirname(selectedPath);
  const projectRoot = nearestProjectRoot(selectedDirectory);
  const handle = pathHandle(projectRoot);
  await registerBackendPathGrant(handle);
  return {
    directory: projectRoot,
    grantId: handle.grantId,
    selectedPath,
  };
}

function nearestProjectRoot(startDirectory) {
  let current = path.resolve(startDirectory);
  const fallback = current;
  while (true) {
    if (
      fs.existsSync(path.join(current, ".taskurotta"))
      || fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

async function grantPath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }
  const handle = pathHandle(path.resolve(options.targetPath));
  await registerBackendPathGrant(handle);
  return handle;
}

async function copyPath(_event, options = {}) {
  if (!options.sourcePath || typeof options.sourcePath !== "string") {
    throw new Error("A source path is required.");
  }
  if (!options.destinationPath || typeof options.destinationPath !== "string") {
    throw new Error("A destination path is required.");
  }

  const sourcePath = resolveExactPath(options.sourcePath, {
    grantId: options.sourceGrantId,
    mustExist: true,
  });
  const destinationPath = resolveExactPath(options.destinationPath, {
    grantId: options.destinationGrantId,
  });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Path does not exist: ${sourcePath}`);
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Destination already exists: ${destinationPath}`);
  }
  await fs.promises.cp(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  return pathHandle(destinationPath);
}

async function deletePath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
  if (typeof shell.trashItem !== "function") {
    throw new Error("Trash is not available on this platform.");
  }
  await shell.trashItem(targetPath);
  return { deleted: true };
}

async function renamePath(_event, options = {}) {
  if (!options.sourcePath || typeof options.sourcePath !== "string") {
    throw new Error("A source path is required.");
  }
  if (!options.name || typeof options.name !== "string") {
    throw new Error("A new name is required.");
  }

  const sourcePath = resolveExactPath(options.sourcePath, {
    grantId: options.grantId,
    mustExist: true,
  });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Path does not exist: ${sourcePath}`);
  }
  const destinationPath = resolveNewChildPath(path.dirname(sourcePath), options.name, options.grantId);
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Destination already exists: ${destinationPath}`);
  }
  await fs.promises.rename(sourcePath, destinationPath);
  return pathHandle(destinationPath);
}

async function createFile(_event, options = {}) {
  const filePath = resolveNewChildPath(options.directory, options.name, options.grantId);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, "", { encoding: "utf-8", flag: "wx" });
  return pathHandle(filePath);
}

async function createFolder(_event, options = {}) {
  const folderPath = resolveNewChildPath(options.directory, options.name, options.grantId);
  await fs.promises.mkdir(folderPath, { recursive: false });
  return pathHandle(folderPath);
}

async function readTextFile(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${targetPath}`);
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error("File is too large to edit in Taskurotta.");
  }
  const content = await fs.promises.readFile(targetPath);
  if (content.includes(0)) {
    throw new Error("Binary files cannot be opened in the code editor.");
  }
  return {
    content: content.toString("utf-8"),
    ...pathHandle(targetPath),
  };
}

async function readBinaryPreview(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }
  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${targetPath}`);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error("File is too large to preview in Taskurotta.");
  }
  const mimeType = imageMimeType(targetPath);
  if (!mimeType) throw new Error("This file type does not have an image preview.");
  const content = await fs.promises.readFile(targetPath);
  return {
    dataUrl: `data:${mimeType};base64,${content.toString("base64")}`,
    ...pathHandle(targetPath),
  };
}

function imageMimeType(targetPath) {
  const types = {
    ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif",
    ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp",
  };
  return types[path.extname(targetPath).toLowerCase()] ?? "";
}

async function writeTextFile(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }
  if (typeof options.content !== "string") {
    throw new Error("File content is required.");
  }

  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
  });
  await fs.promises.writeFile(targetPath, options.content, "utf-8");
  return pathHandle(targetPath);
}

function pathInfoFromStat(targetPath, stat) {
  return {
    basename: path.basename(targetPath),
    extension: path.extname(targetPath),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    path: targetPath,
  };
}

function resolveNewChildPath(directory, name, grantId = "") {
  return getIpcSecurity().resolveAllowedChildPath(directory, name, { grantId });
}

async function setDataDir(_event, options = {}) {
  if (!options.dataDir || typeof options.dataDir !== "string") {
    throw new Error("A data directory path is required.");
  }

  selectedDataDir = resolveExactPath(options.dataDir, {
    grantId: options.grantId,
    mustExist: true,
  });
  process.env.GOFER_DATA_DIR = selectedDataDir;
  fs.mkdirSync(selectedDataDir, { recursive: true });
  getIpcSecurity().grantPath(selectedDataDir);
  writePersistedDataDir(selectedDataDir);
  await restartBackend();
  return { dataDir: selectedDataDir };
}

async function listDirectory(_event, options = {}) {
  const directory = options.create === false
    ? resolveExactPath(options.currentPath, {
        grantId: options.grantId,
        mustExist: true,
      })
    : resolvePickerDefaultPath(options.currentPath, options.grantId);
  if (options.create !== false) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });

  return {
    ...pathHandle(directory),
    directory,
    parent: path.dirname(directory) === directory ? null : path.dirname(directory),
    entries: entries
      .map((entry) => ({
        hidden: entry.name.startsWith("."),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        name: entry.name,
        ...pathHandle(path.join(directory, entry.name)),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      }),
  };
}

async function gitStatus(_event, options = {}) {
  const projectRoot = resolveExactPath(options.projectRoot, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(projectRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Git status path is not a folder: ${projectRoot}`);
  }
  return readGitStatus(projectRoot);
}

async function gitFileBaseline(_event, options = {}) {
  const targetPath = resolveExactPath(options.targetPath, {
    grantId: options.grantId,
    mustExist: true,
  });
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Git comparison path is not a file: ${targetPath}`);
  }
  return readGitFileBaseline(targetPath);
}

async function gitHistory(_event, options = {}) {
  const projectRoot = await resolveGitProjectDirectory(options);
  return readGitHistory(projectRoot);
}

async function gitWorktrees(_event, options = {}) {
  const projectRoot = await resolveGitProjectDirectory(options);
  const result = await readGitWorktrees(projectRoot);
  const worktrees = await Promise.all(result.worktrees.map(async (worktree) => {
    if (worktree.missing) return worktree;
    const handle = pathHandle(worktree.path);
    await registerBackendPathGrant(handle);
    return { ...worktree, grantId: handle.grantId, path: handle.path };
  }));
  return { ...result, worktrees };
}

async function gitWorktreeAdd(_event, options = {}) {
  const projectRoot = await resolveGitProjectDirectory(options);
  if (typeof options.targetPath !== "string" || !options.targetPath.trim()) throw new Error("A worktree folder is required.");
  if (typeof options.branch !== "string" || !options.branch.trim()) throw new Error("A branch is required.");
  const targetPath = resolveExactPath(options.targetPath, { grantId: options.targetGrantId, mustExist: true });
  const targetStat = await fs.promises.stat(targetPath);
  if (!targetStat.isDirectory()) throw new Error("The worktree target must be a folder.");
  const result = await addGitWorktree(projectRoot, targetPath, options.branch.trim(), { createBranch: options.createBranch === true });
  const handle = pathHandle(targetPath);
  await registerBackendPathGrant(handle);
  return { ...result, createdPath: targetPath, grantId: handle.grantId };
}

async function gitWorktreeRemove(_event, options = {}) {
  const projectRoot = await resolveGitProjectDirectory(options);
  const listed = await readGitWorktrees(projectRoot);
  const listedWorktree = listed.worktrees.find(
    (worktree) => path.resolve(worktree.path) === path.resolve(String(options.targetPath || "")),
  );
  if (!listedWorktree) throw new Error("The selected path is not a registered worktree.");
  const targetPath = listedWorktree.missing
    ? listedWorktree.path
    : resolveExactPath(options.targetPath, {
        grantId: options.targetGrantId,
        mustExist: true,
      });
  if (path.resolve(targetPath) === path.resolve(projectRoot)) throw new Error("The current worktree cannot be removed.");
  return removeGitWorktree(projectRoot, targetPath);
}

async function resolveGitProjectDirectory(options = {}) {
  const projectRoot = resolveExactPath(options.projectRoot, { grantId: options.grantId, mustExist: true });
  const stat = await fs.promises.stat(projectRoot);
  if (!stat.isDirectory()) throw new Error(`Git project path is not a folder: ${projectRoot}`);
  return projectRoot;
}

function resolveExactPath(currentPath, options = {}) {
  return getIpcSecurity().resolveAllowedPath(currentPath, options);
}

async function selectPath(_event, options = {}) {
  const parentWindow =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const defaultPath = resolvePickerDefaultPath(options.currentPath, options.grantId);
  fs.mkdirSync(defaultPath, { recursive: true });
  const properties = options.directoryOnly === true
    ? ["openDirectory", "showHiddenFiles", "createDirectory"]
    : options.fileOnly === true
      ? ["openFile", "showHiddenFiles"]
      : ["openFile", "openDirectory", "showHiddenFiles", "createDirectory"];
  const result = await dialog.showOpenDialog(parentWindow, {
    defaultPath,
    properties,
    ...(options.directoryOnly === true ? { buttonLabel: "Open Folder", title: "Open Folder" } : {}),
    ...(options.fileOnly === true ? { buttonLabel: "Open File", title: "Open File" } : {}),
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const handle = getIpcSecurity().grantPath(result.filePaths[0]);
  await registerBackendPathGrant(handle);
  return handle;
}

function resolvePickerDefaultPath(currentPath, grantId = "") {
  return getIpcSecurity().resolvePickerPath(currentPath, { grantId });
}

function pathHandle(targetPath) {
  const security = getIpcSecurity();
  const existingGrantId = security.grantForPath(targetPath);
  if (existingGrantId) {
    return { grantId: existingGrantId, path: targetPath };
  }
  return security.grantPath(targetPath);
}

async function registerBackendPathGrant(handle) {
  if (!activeApiBaseUrl || !desktopGrantSecret) return;
  if (!handle || typeof handle.path !== "string" || typeof handle.grantId !== "string") return;
  try {
    const headers = {
      "Content-Type": "application/json",
      "X-Gofer-Desktop-Grant-Secret": desktopGrantSecret,
    };
    if (activeUiApiToken) {
      headers.Authorization = `Bearer ${activeUiApiToken}`;
    }
    const response = await fetch(`${activeApiBaseUrl}/api/desktop/path-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ grantId: handle.grantId, path: handle.path }),
    });
    if (!response.ok) {
      writeBackendLog(`PATH_GRANT_REGISTER_FAILED ${response.status}\n`);
    }
  } catch (error) {
    writeBackendLog(`PATH_GRANT_REGISTER_FAILED ${error?.message || error}\n`);
  }
}

function getIpcSecurity() {
  if (!ipcSecurity) {
    ipcSecurity = createIpcSecurity({
      appRoot: path.dirname(distIndexPath),
      devServerUrl: VITE_DEV_SERVER_URL,
      getDataDir: getGoferDataDir,
      getMainWebContents: () =>
        mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null,
      isProduction,
    });
  }
  return ipcSecurity;
}

async function restartBackend() {
  stopBackend();
  try {
    const backend = await startBackend();
    activeApiBaseUrl = backend.apiBaseUrl;
    activeUiApiToken = backend.apiToken;
    if (backendErrorWindow && !backendErrorWindow.isDestroyed()) {
      backendErrorWindow.close();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    createWindow(backend.apiBaseUrl, backend.apiToken);
  } catch (error) {
    createBackendErrorWindow(error);
  }
}

function openLogsFolder() {
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  shell.openPath(app.getPath("logs"));
}
