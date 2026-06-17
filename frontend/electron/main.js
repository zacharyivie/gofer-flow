import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const distIndexPath = path.join(__dirname, "..", "dist", "index.html");

if (process.platform === "linux" && !process.env.GTK_USE_PORTAL) {
  process.env.GTK_USE_PORTAL = "0";
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const VITE_DEV_SERVER_URL =
  process.env.GOFER_VITE_DEV_SERVER_URL ||
  process.env.VITE_DEV_SERVER_URL ||
  "http://127.0.0.1:5173";
const BACKEND_READY_PREFIX = "GOFER_UI_READY ";
const BACKEND_START_TIMEOUT_MS = 15000;
const ELECTRON_READY_MESSAGE = "GOFER_ELECTRON_READY";
const BACKEND_EXECUTABLE_NAME = process.platform === "win32" ? "gof.exe" : "gof";
const isProduction =
  app.isPackaged || process.env.GOFER_ELECTRON_MODE === "production";
const isSmokeTest = process.env.GOFER_ELECTRON_SMOKE_TEST === "1";
let backendProcess;
let backendLogStream;
const expectedBackendStops = new WeakSet();
let isQuitting = false;
let activeApiBaseUrl;
let selectedDataDir;
let mainWindow;
let backendErrorWindow;

const singleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

function createWindow(apiBaseUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    title: "Gofer Flow",
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--gofer-api-base-url=${apiBaseUrl}`],
    },
  });

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
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.GOFER_ELECTRON_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

function startBackend() {
  const manualApiBaseUrl = process.env.GOFER_API_BASE_URL || process.env.VITE_API_BASE_URL;
  if (manualApiBaseUrl) {
    return Promise.resolve(manualApiBaseUrl);
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
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendProcess = child;
    backendLogStream = createBackendLogStream();

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const timeoutId = setTimeout(() => {
      fail(new Error("Timed out waiting for Gofer backend to start."));
    }, BACKEND_START_TIMEOUT_MS);

    function succeed(apiBaseUrl) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      writeBackendLog(`READY ${apiBaseUrl}\n`);
      resolve(apiBaseUrl);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      stopBackend();
      reject(error);
    }

    function handleOutput(chunk) {
      writeBackendLog(chunk.toString());
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        console.log(`[gofer-backend] ${line}`);
        if (!line.startsWith(BACKEND_READY_PREFIX)) continue;

        try {
          const payload = JSON.parse(line.slice(BACKEND_READY_PREFIX.length));
          const host = payload.host || "127.0.0.1";
          const port = Number(payload.port);
          if (!port) {
            throw new Error("Ready payload did not include a valid port.");
          }
          succeed(`http://${host}:${port}`);
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

  createBackendErrorWindow(error, { title: "Gofer backend stopped" });
}

function createBackendErrorWindow(error, { title = "Gofer backend did not start" } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  if (backendErrorWindow && !backendErrorWindow.isDestroyed()) {
    backendErrorWindow.focus();
    return;
  }

  const errorWindow = new BrowserWindow({
    width: 720,
    height: 420,
    title: "Gofer Flow Backend Error",
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: path.join(__dirname, "error-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  backendErrorWindow = errorWindow;

  errorWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(renderBackendErrorHtml(title, message))}`,
  );
  errorWindow.on("closed", () => {
    backendErrorWindow = undefined;
  });
}

function renderBackendErrorHtml(title, message) {
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Gofer Flow Backend Error</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #1f1f1f;
        color: #d4d4d4;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 560px;
        padding: 32px;
      }
      h1 {
        margin: 0 0 12px;
        color: #f2f2f2;
        font-size: 24px;
      }
      p {
        margin: 0 0 18px;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin: 18px 0;
      }
      button {
        border: 1px solid #3c3c3c;
        border-radius: 6px;
        background: #2d2d30;
        color: #f2f2f2;
        cursor: pointer;
        font: inherit;
        padding: 9px 13px;
      }
      button:hover {
        background: #383838;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        padding: 16px;
        background: #252526;
        border: 1px solid #3c3c3c;
        color: #f48771;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>Electron could not keep the local Gofer Flow backend running. Restart it, or open the logs folder for troubleshooting details.</p>
      <div class="actions">
        <button id="restart">Restart backend</button>
        <button id="logs">Open logs</button>
      </div>
      <pre>${escapeHtml(message)}</pre>
    </main>
    <script>
      document.getElementById("restart").addEventListener("click", () => {
        window.goferBackend.restart();
      });
      document.getElementById("logs").addEventListener("click", () => {
        window.goferBackend.openLogs();
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.whenReady().then(async () => {
  setupApplicationMenu();
  setupIpcHandlers();
  try {
    const apiBaseUrl = await startBackend();
    activeApiBaseUrl = apiBaseUrl;
    createWindow(apiBaseUrl);
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
      createWindow(activeApiBaseUrl);
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
  stopBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function setupApplicationMenu() {
  const template = [
    {
      label: "Gofer Flow",
      submenu: [
        {
          label: "About Gofer Flow",
          click: () => {
            dialog.showMessageBox({
              type: "info",
              title: "About Gofer Flow",
              message: "Gofer Flow",
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
  ];

  if (!isProduction) {
    template.push({
      label: "View",
      submenu: [
        { role: "reload", label: "Reload" },
        { role: "forceReload", label: "Force Reload" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupIpcHandlers() {
  ipcMain.handle("gofer:restart-backend", restartBackend);
  ipcMain.handle("gofer:open-logs", openLogsFolder);
  ipcMain.handle("gofer:get-data-dir", getGoferDataDir);
  ipcMain.handle("gofer:list-directory", listDirectory);
  ipcMain.handle("gofer:open-path", openPath);
  ipcMain.handle("gofer:set-data-dir", setDataDir);
  ipcMain.handle("gofer:select-path", selectPath);
}

async function openPath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }

  const result = await shell.openPath(options.targetPath);
  if (result) {
    throw new Error(result);
  }
  return { opened: true };
}

async function setDataDir(_event, options = {}) {
  if (!options.dataDir || typeof options.dataDir !== "string") {
    throw new Error("A data directory path is required.");
  }

  selectedDataDir = path.resolve(options.dataDir);
  process.env.GOFER_DATA_DIR = selectedDataDir;
  fs.mkdirSync(selectedDataDir, { recursive: true });
  writePersistedDataDir(selectedDataDir);
  await restartBackend();
  return { dataDir: selectedDataDir };
}

async function listDirectory(_event, options = {}) {
  const directory = resolvePickerDefaultPath(options.currentPath);
  fs.mkdirSync(directory, { recursive: true });
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });

  return {
    directory,
    parent: path.dirname(directory) === directory ? null : path.dirname(directory),
    entries: entries
      .map((entry) => ({
        hidden: entry.name.startsWith("."),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        name: entry.name,
        path: path.join(directory, entry.name),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      }),
  };
}

async function selectPath(_event, options = {}) {
  const parentWindow =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const defaultPath = resolvePickerDefaultPath(options.currentPath);
  fs.mkdirSync(defaultPath, { recursive: true });
  const result = await dialog.showOpenDialog(parentWindow, {
    defaultPath,
    properties: ["openFile", "openDirectory", "showHiddenFiles", "createDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

function resolvePickerDefaultPath(currentPath) {
  if (!currentPath || typeof currentPath !== "string") {
    return getGoferDataDir();
  }

  let candidate = currentPath.trim();
  if (!candidate) {
    return getGoferDataDir();
  }

  if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(getGoferDataDir(), candidate);
  }

  if (fs.existsSync(candidate)) {
    try {
      return fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
    } catch {
      return path.dirname(candidate);
    }
  }

  let parent = path.dirname(candidate);
  while (parent && parent !== path.dirname(parent)) {
    if (fs.existsSync(parent)) {
      return parent;
    }
    parent = path.dirname(parent);
  }

  return getGoferDataDir();
}

async function restartBackend() {
  stopBackend();
  try {
    const apiBaseUrl = await startBackend();
    activeApiBaseUrl = apiBaseUrl;
    if (backendErrorWindow && !backendErrorWindow.isDestroyed()) {
      backendErrorWindow.close();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    createWindow(apiBaseUrl);
  } catch (error) {
    createBackendErrorWindow(error);
  }
}

function openLogsFolder() {
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  shell.openPath(app.getPath("logs"));
}
