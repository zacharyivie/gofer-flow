const fs = require("node:fs");
const path = require("node:path");

async function inspectPath(targetPath) {
  try {
    const stat = await fs.promises.stat(targetPath);
    return pathInfoFromStat(targetPath, stat);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      basename: path.basename(targetPath),
      exists: false,
      extension: path.extname(targetPath),
      isDirectory: false,
      isFile: false,
      path: targetPath,
    };
  }
}

function pathInfoFromStat(targetPath, stat) {
  return {
    basename: path.basename(targetPath),
    exists: true,
    extension: path.extname(targetPath),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    path: targetPath,
  };
}

module.exports = { inspectPath, pathInfoFromStat };
