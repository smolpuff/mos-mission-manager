"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { build, Platform, Arch } = require("electron-builder");
const config = require("./auth-debug-builder.cjs");
const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pbp-auth-build-"));

(async () => {
  const renderer = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "desktop:build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (renderer.error) throw renderer.error;
  if (renderer.status !== 0) throw new Error(`Renderer build exited ${renderer.status}`);
  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : [process.platform === "win32" ? "--win" : "--mac"];
  for (const target of targets) {
    const platform = target === "--win" ? Platform.WINDOWS : target === "--mac" ? Platform.MAC : null;
    if (!platform) throw new Error(`Unknown build target: ${target}`);
    try {
      await build({ projectDir: root, config, publish: "never", targets: platform.createTarget(
        target === "--win" ? ["portable"] : ["dir", "zip"], target === "--win" ? Arch.x64 : process.arch === "arm64" ? Arch.arm64 : Arch.x64,
      ) });
    } finally {
      for (const name of ["builder-effective-config.yaml", "builder-debug.yml", "latest.yml", "latest-mac.yml"]) {
        const file = path.join(root, config.directories.output, name);
        if (fs.existsSync(file)) fs.renameSync(file, path.join(temporary, `${target.slice(2)}-${name}`));
      }
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
