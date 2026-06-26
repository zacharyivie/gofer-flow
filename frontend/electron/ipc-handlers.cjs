const desktopIpcHandlers = [
  ["gofer:restart-backend", "restartBackend"],
  ["gofer:open-logs", "openLogsFolder"],
  ["gofer:get-data-dir", "getGoferDataDir"],
  ["gofer:grant-path", "grantPath"],
  ["gofer:list-directory", "listDirectory"],
  ["gofer:open-path", "openPath"],
  ["gofer:reveal-path", "revealPath"],
  ["gofer:path-info", "pathInfo"],
  ["gofer:copy-path", "copyPath"],
  ["gofer:delete-path", "deletePath"],
  ["gofer:rename-path", "renamePath"],
  ["gofer:create-file", "createFile"],
  ["gofer:create-folder", "createFolder"],
  ["gofer:read-text-file", "readTextFile"],
  ["gofer:write-text-file", "writeTextFile"],
  ["gofer:set-data-dir", "setDataDir"],
  ["gofer:select-path", "selectPath"],
];

const updateIpcHandlers = [
  ["gofer:check-for-updates", "checkForUpdates"],
  ["gofer:download-and-install-update", "downloadAndInstallUpdate"],
  ["gofer:install-downloaded-update", "installDownloadedUpdate"],
  ["gofer:open-update-release", "openUpdateRelease"],
  ["gofer:get-update-state", "getUpdateState"],
];

const ipcHandlerDefinitions = [...desktopIpcHandlers, ...updateIpcHandlers];

function registerIpcHandlers(ipcMain, handlers, options = {}) {
  const wrapHandler =
    typeof options.secureHandler === "function" ? options.secureHandler : (handler) => handler;
  for (const [channel, handlerName] of ipcHandlerDefinitions) {
    const handler = handlers[handlerName];
    if (typeof handler !== "function") {
      throw new Error(`Missing IPC handler: ${handlerName}`);
    }
    ipcMain.handle(channel, wrapHandler(handler, channel));
  }
}

module.exports = {
  desktopIpcHandlers,
  ipcHandlerDefinitions,
  registerIpcHandlers,
  updateIpcHandlers,
};
