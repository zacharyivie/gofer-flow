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
