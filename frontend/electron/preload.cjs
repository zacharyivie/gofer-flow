const { contextBridge, ipcRenderer, webUtils } = require("electron");

const API_BASE_URL_ARG = "--gofer-api-base-url=";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8765";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function readApiBaseUrl() {
  const arg = process.argv.find((value) => value.startsWith(API_BASE_URL_ARG));
  const value = arg ? arg.slice(API_BASE_URL_ARG.length) : DEFAULT_API_BASE_URL;

  return isSafeLocalHttpUrl(value) ? value : DEFAULT_API_BASE_URL;
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
contextBridge.exposeInMainWorld("goferDesktop", {
  getDataDir: () => ipcRenderer.invoke("gofer:get-data-dir"),
  listDirectory: (options = {}) =>
    ipcRenderer.invoke("gofer:list-directory", {
      currentPath:
        typeof options.currentPath === "string" ? options.currentPath : "",
      create: options.create !== false,
    }),
  openPath: (targetPath) =>
    ipcRenderer.invoke("gofer:open-path", {
      targetPath: typeof targetPath === "string" ? targetPath : "",
    }),
  revealPath: (targetPath) =>
    ipcRenderer.invoke("gofer:reveal-path", {
      targetPath: typeof targetPath === "string" ? targetPath : "",
    }),
  getPathInfo: (targetPath) =>
    ipcRenderer.invoke("gofer:path-info", {
      targetPath: typeof targetPath === "string" ? targetPath : "",
    }),
  copyPath: (options = {}) =>
    ipcRenderer.invoke("gofer:copy-path", {
      sourcePath:
        typeof options.sourcePath === "string" ? options.sourcePath : "",
      destinationPath:
        typeof options.destinationPath === "string" ? options.destinationPath : "",
    }),
  deletePath: (targetPath) =>
    ipcRenderer.invoke("gofer:delete-path", {
      targetPath: typeof targetPath === "string" ? targetPath : "",
    }),
  renamePath: (options = {}) =>
    ipcRenderer.invoke("gofer:rename-path", {
      sourcePath:
        typeof options.sourcePath === "string" ? options.sourcePath : "",
      name: typeof options.name === "string" ? options.name : "",
    }),
  createFile: (options = {}) =>
    ipcRenderer.invoke("gofer:create-file", {
      directory: typeof options.directory === "string" ? options.directory : "",
      name: typeof options.name === "string" ? options.name : "",
    }),
  createFolder: (options = {}) =>
    ipcRenderer.invoke("gofer:create-folder", {
      directory: typeof options.directory === "string" ? options.directory : "",
      name: typeof options.name === "string" ? options.name : "",
    }),
  readTextFile: (targetPath) =>
    ipcRenderer.invoke("gofer:read-text-file", {
      targetPath: typeof targetPath === "string" ? targetPath : "",
    }),
  writeTextFile: (options = {}) =>
    ipcRenderer.invoke("gofer:write-text-file", {
      targetPath:
        typeof options.targetPath === "string" ? options.targetPath : "",
      content: typeof options.content === "string" ? options.content : "",
    }),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || "",
  setDataDir: (dataDir) =>
    ipcRenderer.invoke("gofer:set-data-dir", {
      dataDir: typeof dataDir === "string" ? dataDir : "",
    }),
  selectPath: (options = {}) =>
    ipcRenderer.invoke("gofer:select-path", {
      currentPath:
        typeof options.currentPath === "string" ? options.currentPath : "",
    }),
});

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
