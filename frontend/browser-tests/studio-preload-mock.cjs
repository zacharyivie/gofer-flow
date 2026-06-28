/* global window */

const bridgeCalls = [];

function recordBridgeCall(method, payload) {
  bridgeCalls.push({ method, payload });
}

const selectedPath = "/workspace/inputs";

window.__goferBridgeCalls = bridgeCalls;

window.goferDesktop = {
  getDataDir: async () => {
    recordBridgeCall("getDataDir");
    return "/workspace";
  },
  getDroppedFilePath: (file) => {
    recordBridgeCall("getDroppedFilePath", { name: file?.name ?? "" });
    return file?.path || selectedPath;
  },
  grantDroppedPath: async (file) => {
    recordBridgeCall("grantDroppedPath", { name: file?.name ?? "" });
    return selectedPath;
  },
  workspace: {
    copyPath: async (options) => {
      recordBridgeCall("workspace.copyPath", options);
      return true;
    },
    createFile: async (options) => {
      recordBridgeCall("workspace.createFile", options);
      return { path: `${options.directory}/${options.name}` };
    },
    createFolder: async (options) => {
      recordBridgeCall("workspace.createFolder", options);
      return { path: `${options.directory}/${options.name}` };
    },
    deletePath: async (targetPath) => {
      recordBridgeCall("workspace.deletePath", targetPath);
      return true;
    },
    getPathInfo: async (targetPath) => {
      recordBridgeCall("workspace.getPathInfo", targetPath);
      return {
        basename: targetPath.split("/").filter(Boolean).at(-1) || "workspace",
        isDirectory: !targetPath.endsWith(".json") && !targetPath.endsWith(".txt"),
        isFile: targetPath.endsWith(".json") || targetPath.endsWith(".txt"),
        path: targetPath,
      };
    },
    openPath: async (targetPath) => {
      recordBridgeCall("workspace.openPath", targetPath);
      return true;
    },
    pathGrantForApi: (targetPath) => {
      recordBridgeCall("workspace.pathGrantForApi", targetPath);
      return targetPath === selectedPath ? "test-grant" : "";
    },
    renamePath: async (options) => {
      recordBridgeCall("workspace.renamePath", options);
      return { path: options.nextPath };
    },
    revealPath: async (targetPath) => {
      recordBridgeCall("workspace.revealPath", targetPath);
      return true;
    },
    selectPath: async (options = {}) => {
      recordBridgeCall("workspace.selectPath", options);
      return selectedPath;
    },
  },
  textFiles: {
    read: async (targetPath) => {
      recordBridgeCall("textFiles.read", targetPath);
      return { content: "{\n  \"enabled\": true\n}" };
    },
    write: async (options) => {
      recordBridgeCall("textFiles.write", options);
      return { bytesWritten: options?.content?.length ?? 0 };
    },
  },
};
