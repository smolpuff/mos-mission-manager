"use strict";

const { spawn } = require("child_process");
const path = require("path");

// Mac and Windows use Electron's original CLI, including its environment,
// argument handling, exit codes, and signal handling.
if (process.platform !== "linux") {
  const cli = require.resolve("electron/cli.js");
  process.argv.splice(1, 1, cli, ".");
  require(cli);
} else {
  const args = process.argv.slice(2);
  // Select the backend before Electron starts: native Wayland on this Hyprland
  // setup renders a smaller surface than the window on a 2x display.
  if (
    process.platform === "linux" &&
    process.env.HYPRLAND_INSTANCE_SIGNATURE &&
    process.env.DISPLAY &&
    !args.some((arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="))
  ) {
    args.unshift("--ozone-platform=x11");
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [path.join(__dirname, ".."), ...args], {
    stdio: "inherit",
    env,
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}
