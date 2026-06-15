const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("goferBackend", {
  openLogs: () => ipcRenderer.invoke("gofer:open-logs"),
  restart: () => ipcRenderer.invoke("gofer:restart-backend"),
});
