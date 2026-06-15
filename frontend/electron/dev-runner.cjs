const { spawn } = require("node:child_process");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
env.LIBGL_ALWAYS_SOFTWARE = env.LIBGL_ALWAYS_SOFTWARE || "1";

const child = spawn(electronPath, [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--disable-gpu-rasterization",
  "--disable-dev-shm-usage",
  ".",
], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
