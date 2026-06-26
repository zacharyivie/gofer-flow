import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { createIpcSecurity, isSafeExternalUrl } = require("./security.cjs");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const distIndexPath = path.join(__dirname, "..", "dist", "index.html");
const backendErrorHtmlPath = path.join(__dirname, "backend-error.html");

if (process.platform === "linux" && !process.env.GTK_USE_PORTAL) {
  process.env.GTK_USE_PORTAL = "0";
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
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
const expectedBackendStops = new WeakSet();
let isQuitting = false;
let activeApiBaseUrl;
let selectedDataDir;
let mainWindow;
let backendErrorWindow;
let ipcSecurity;
let backendErrorIpcSecurity;
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
      sandbox: !isSmokeTest,
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
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
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
    createFile,
    createFolder,
    deletePath,
    downloadAndInstallUpdate,
    getGoferDataDir,
    grantPath,
    getUpdateState,
    installDownloadedUpdate,
    listDirectory,
    openLogsFolder,
    openPath,
    openUpdateRelease,
    pathInfo,
    readTextFile,
    renamePath,
    restartBackend,
    revealPath,
    selectPath,
    setDataDir,
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
      "User-Agent": `Gofer-Flow/${app.getVersion()}`,
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

async function grantPath(_event, options = {}) {
  if (!options.targetPath || typeof options.targetPath !== "string") {
    throw new Error("A path is required.");
  }
  return pathHandle(path.resolve(options.targetPath));
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
    throw new Error("File is too large to edit in Gofer Flow.");
  }
  return {
    content: await fs.promises.readFile(targetPath, "utf-8"),
    ...pathHandle(targetPath),
  };
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
    : ["openFile", "openDirectory", "showHiddenFiles", "createDirectory"];
  const result = await dialog.showOpenDialog(parentWindow, {
    defaultPath,
    properties,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return getIpcSecurity().grantPath(result.filePaths[0]);
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
