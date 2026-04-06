"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const SEA_RESOURCE = "NODE_SEA_BLOB";
const APP_NAME = "missions-v3-mcp";
const APP_VERSION = "3.0.3";

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function configPathFor(platform) {
  return path.join(process.cwd(), `sea-config.${platform}.json`);
}

function blobPathFromConfig(platform) {
  const configPath = configPathFor(platform);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return path.resolve(process.cwd(), config.output);
}

function outputBinaryPath(platform) {
  const suffix = platform === "win" ? ".exe" : "";
  return path.join(process.cwd(), "binaries", `${APP_NAME}_${APP_VERSION}${suffix}`);
}

function baseBinaryPath(platform) {
  if (platform === "mac") return process.execPath;
  const envPath =
    process.env.SEA_WINDOWS_NODE ||
    process.env.SEA_WIN_NODE ||
    process.env.SEA_WINDOWS_NODE_EXE;
  if (envPath) return path.resolve(process.cwd(), envPath);
  return path.join(process.cwd(), "binaries", "node.exe");
}

function build(platform) {
  if (!["mac", "win"].includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }

  const configPath = configPathFor(platform);
  const blobPath = blobPathFromConfig(platform);
  const targetPath = outputBinaryPath(platform);
  const sourceBinary = baseBinaryPath(platform);

  ensureFile(configPath, "SEA config");
  ensureFile(sourceBinary, platform === "win" ? "Windows base node binary" : "Node binary");

  run(process.execPath, ["--experimental-sea-config", configPath]);
  ensureFile(blobPath, "SEA blob");

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourceBinary, targetPath);
  if (platform !== "win") fs.chmodSync(targetPath, 0o755);

  const postjectArgs = [
    targetPath,
    SEA_RESOURCE,
    blobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ];
  if (platform === "mac") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run("npx", ["postject", ...postjectArgs]);

  console.log(`Built ${targetPath}`);
}

try {
  build(process.argv[2] || "");
} catch (error) {
  console.error(`build-sea error: ${error.message}`);
  process.exit(1);
}
