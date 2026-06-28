const { contextBridge, ipcRenderer, webUtils } = require("electron");

const API_BASE_URL_ARG = "--gofer-api-base-url=";
const API_TOKEN_ARG = "--gofer-api-token=";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8765";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function readApiBaseUrl() {
  const arg = process.argv.find((value) => value.startsWith(API_BASE_URL_ARG));
  const value = arg ? arg.slice(API_BASE_URL_ARG.length) : DEFAULT_API_BASE_URL;

  return isSafeLocalHttpUrl(value) ? value : DEFAULT_API_BASE_URL;
}

function readApiToken() {
  const arg = process.argv.find((value) => value.startsWith(API_TOKEN_ARG));
  return arg ? arg.slice(API_TOKEN_ARG.length) : "";
}

function isSafeLocalHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld("goferApiBaseUrl", readApiBaseUrl());
contextBridge.exposeInMainWorld("goferApiToken", readApiToken());
const pathGrants = new Map();

function rememberPathGrant(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (typeof payload.path === "string" && typeof payload.grantId === "string") {
    pathGrants.set(payload.path, payload.grantId);
  }
  if (typeof payload.directory === "string" && typeof payload.grantId === "string") {
    pathGrants.set(payload.directory, payload.grantId);
  }
  if (Array.isArray(payload.entries)) {
    for (const entry of payload.entries) {
      rememberPathGrant(entry);
    }
  }
  return payload;
}

function stripGrantIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripGrantIds(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const clean = {};
  const hasPathGrant = typeof value.path === "string" || typeof value.directory === "string";
  for (const [key, item] of Object.entries(value)) {
    if (hasPathGrant && key === "grantId") continue;
    clean[key] = stripGrantIds(item);
  }
  return clean;
}

function grantForPath(targetPath) {
  if (typeof targetPath !== "string") return "";
  const target = normalizeGrantPath(targetPath);
  let selectedGrantId = "";
  let selectedRootLength = -1;
  for (const [rootPath, grantId] of pathGrants.entries()) {
    const root = normalizeGrantPath(rootPath);
    if (!root) continue;
    const matchesRoot = target === root || target.startsWith(`${root}/`);
    if (matchesRoot && root.length > selectedRootLength) {
      selectedGrantId = grantId;
      selectedRootLength = root.length;
    }
  }
  return selectedGrantId;
}

function normalizeGrantPath(targetPath) {
  return String(targetPath ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

async function invokeDesktop(channel, payload = {}) {
  const result = await ipcRenderer.invoke(channel, payload);
  rememberPathGrant(result);
  return stripGrantIds(result);
}

contextBridge.exposeInMainWorld("goferDesktop", {
  getDataDir: () => ipcRenderer.invoke("gofer:get-data-dir"),
  dataDirectory: {
    choose: async (options = {}) => {
      let selectedPath = null;
      try {
        selectedPath = await selectPath({
          currentPath:
            typeof options.currentPath === "string" ? options.currentPath : "",
          directoryOnly: true,
        });
      } catch {
        selectedPath = null;
      }
      if (!selectedPath) return null;
      return invokeDesktop("gofer:set-data-dir", {
        dataDir: selectedPath,
        grantId: grantForPath(selectedPath),
      });
    },
    get: () => ipcRenderer.invoke("gofer:get-data-dir"),
  },
  workspace: {
    listDirectory: (options = {}) =>
      listDirectory(options),
    openPath: (targetPath) =>
      openPath(targetPath),
    revealPath: (targetPath) =>
      revealPath(targetPath),
    getPathInfo: (targetPath) =>
      getPathInfo(targetPath),
    pathGrantForApi: (targetPath) =>
      grantForPath(targetPath),
    copyPath: (options = {}) =>
      copyPath(options),
    deletePath: (targetPath) =>
      deletePath(targetPath),
    renamePath: (options = {}) =>
      renamePath(options),
    createFile: (options = {}) =>
      createFile(options),
    createFolder: (options = {}) =>
      createFolder(options),
    selectPath: (options = {}) =>
      selectPath(options),
  },
  textFiles: {
    read: (targetPath) =>
      readTextFile(targetPath),
    write: (options = {}) =>
      writeTextFile(options),
  },
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || "",
  grantDroppedPath: async (file) => {
    const targetPath = webUtils.getPathForFile(file) || "";
    if (!targetPath) return null;
    const payload = await invokeDesktop("gofer:grant-path", { targetPath });
    return payload?.path || targetPath;
  },
});

function listDirectory(options = {}) {
  return (
    invokeDesktop("gofer:list-directory", {
      currentPath: typeof options.currentPath === "string" ? options.currentPath : "",
      grantId: grantForPath(options.currentPath),
      create: options.create !== false,
    })
  );
}

function openPath(targetPath) {
  return invokeDesktop("gofer:open-path", {
    grantId: grantForPath(targetPath),
    targetPath: typeof targetPath === "string" ? targetPath : "",
  });
}

function revealPath(targetPath) {
  return invokeDesktop("gofer:reveal-path", {
    grantId: grantForPath(targetPath),
    targetPath: typeof targetPath === "string" ? targetPath : "",
  });
}

function getPathInfo(targetPath) {
  return invokeDesktop("gofer:path-info", {
    grantId: grantForPath(targetPath),
    targetPath: typeof targetPath === "string" ? targetPath : "",
  });
}

function copyPath(options = {}) {
  return invokeDesktop("gofer:copy-path", {
    destinationGrantId: grantForPath(options.destinationPath),
    sourcePath:
      typeof options.sourcePath === "string" ? options.sourcePath : "",
    sourceGrantId: grantForPath(options.sourcePath),
    destinationPath:
      typeof options.destinationPath === "string" ? options.destinationPath : "",
  });
}

function deletePath(targetPath) {
  return invokeDesktop("gofer:delete-path", {
    grantId: grantForPath(targetPath),
    targetPath: typeof targetPath === "string" ? targetPath : "",
  });
}

function renamePath(options = {}) {
  return invokeDesktop("gofer:rename-path", {
    grantId: grantForPath(options.sourcePath),
    sourcePath:
      typeof options.sourcePath === "string" ? options.sourcePath : "",
    name: typeof options.name === "string" ? options.name : "",
  });
}

function createFile(options = {}) {
  return invokeDesktop("gofer:create-file", {
    directory: typeof options.directory === "string" ? options.directory : "",
    grantId: grantForPath(options.directory),
    name: typeof options.name === "string" ? options.name : "",
  });
}

function createFolder(options = {}) {
  return invokeDesktop("gofer:create-folder", {
    directory: typeof options.directory === "string" ? options.directory : "",
    grantId: grantForPath(options.directory),
    name: typeof options.name === "string" ? options.name : "",
  });
}

function readTextFile(targetPath) {
  return invokeDesktop("gofer:read-text-file", {
    grantId: grantForPath(targetPath),
    targetPath: typeof targetPath === "string" ? targetPath : "",
  });
}

function writeTextFile(options = {}) {
  return invokeDesktop("gofer:write-text-file", {
    grantId: grantForPath(options.targetPath),
    targetPath:
      typeof options.targetPath === "string" ? options.targetPath : "",
    content: typeof options.content === "string" ? options.content : "",
  });
}

function selectPath(options = {}) {
  return invokeDesktop("gofer:select-path", {
    currentPath:
      typeof options.currentPath === "string" ? options.currentPath : "",
    directoryOnly: options.directoryOnly === true,
    grantId: grantForPath(options.currentPath),
  }).then((payload) => (payload && typeof payload.path === "string" ? payload.path : null));
}

contextBridge.exposeInMainWorld("goferUpdates", {
  check: () => ipcRenderer.invoke("gofer:check-for-updates"),
  downloadAndInstall: () => ipcRenderer.invoke("gofer:download-and-install-update"),
  installDownloaded: () => ipcRenderer.invoke("gofer:install-downloaded-update"),
  openRelease: () => ipcRenderer.invoke("gofer:open-update-release"),
  getState: () => ipcRenderer.invoke("gofer:get-update-state"),
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("gofer:update-state", listener);
    return () => ipcRenderer.removeListener("gofer:update-state", listener);
  },
});
