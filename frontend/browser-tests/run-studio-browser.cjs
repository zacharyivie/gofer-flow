/* global __dirname, console, process */

const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

const child = spawn(
  electronPath,
  [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-rasterization",
    "--disable-dev-shm-usage",
    path.join(__dirname, "studio.browser.cjs"),
  ],
  {
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || "1",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Browser studio regression tests exited with signal ${signal}.`);
  }
  process.exit(code || (signal ? 1 : 0));
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
