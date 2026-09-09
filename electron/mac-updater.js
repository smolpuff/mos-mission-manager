"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const { getReleaseArtifact, downloadArtifact } = require("./update-download");
const { extractAppZip } = require("./update-extract");

const BUNDLE_NAME = "missions-v3-mcp.app";
const BUNDLE_ID = "dephlect.pbp-missions.desktop";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (file) => fs.access(file).then(() => true, () => false);
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function getMacTarget(execPath) {
  const realExecutable = await fs.realpath(execPath);
  const target = path.resolve(path.dirname(realExecutable), "../..");
  if (!target.endsWith(".app") || path.basename(path.dirname(realExecutable)) !== "MacOS" ||
      path.basename(path.dirname(path.dirname(realExecutable))) !== "Contents") {
    throw new Error("Run the packaged Mac app to update it.");
  }
  if (target.includes("/AppTranslocation/") || target.startsWith("/Volumes/")) {
    throw new Error("Move the app to a writable Applications folder and reopen it before updating.");
  }
  await fs.access(path.dirname(target), fs.constants.W_OK);
  return target;
}

async function validateMacBundle(bundle, version, arch) {
  const plist = path.join(bundle, "Contents", "Info.plist");
  const value = async (key) => (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).stdout.trim();
  const [id, bundleVersion, executable] = await Promise.all([
    value("CFBundleIdentifier"), value("CFBundleShortVersionString"), value("CFBundleExecutable"),
  ]);
  if (id !== BUNDLE_ID || bundleVersion !== version || !executable ||
      executable !== path.basename(executable) || /[\x00-\x1f]/.test(executable)) {
    throw new Error("Downloaded app identity or version does not match this update.");
  }
  const binary = path.join(bundle, "Contents", "MacOS", executable);
  const realBinary = await fs.realpath(binary);
  if (!realBinary.startsWith(await fs.realpath(bundle) + path.sep)) throw new Error("Invalid app executable.");
  await fs.access(binary, fs.constants.X_OK);
  const architectures = (await run("/usr/bin/lipo", ["-archs", binary])).stdout.trim().split(/\s+/);
  if (!architectures.includes(arch === "x64" ? "x86_64" : "arm64")) {
    throw new Error("Downloaded app does not support this Mac's architecture.");
  }
}

function receiptPath(userData) { return path.join(userData, "desktop-update-transaction.json"); }

async function readTransaction(userData, execPath) {
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath(userData), "utf8"));
    const target = await getMacTarget(execPath);
    if (receipt.target !== target || !/^[a-f0-9]{32}$/.test(receipt.token) ||
        !/^\d+\.\d+\.\d+$/.test(receipt.version) ||
        path.dirname(receipt.directory) !== path.dirname(target) ||
        !path.basename(receipt.directory).startsWith(`.${path.basename(target)}.update-`)) return null;
    if (await fs.realpath(receipt.directory) !== receipt.directory) return null;
    const journal = JSON.parse(await fs.readFile(path.join(receipt.directory, "transaction.json"), "utf8"));
    if (JSON.stringify(journal) !== JSON.stringify(receipt)) return null;
    const state = (await fs.readFile(path.join(receipt.directory, "state"), "utf8").catch(() => "preparing")).trim();
    return { ...receipt, state };
  } catch { return null; }
}

async function cleanupPreviousTransaction(receipt) {
  if (!receipt || await exists(path.join(receipt.directory, "backup.app"))) return;
  const helperPid = Number(await fs.readFile(path.join(receipt.directory, "helper.pid"), "utf8").catch(() => "0"));
  if (processAlive(receipt.ownerPid) || processAlive(helperPid)) return;
  const lock = path.join(path.dirname(receipt.target), `.${path.basename(receipt.target)}.update-lock`);
  // Never break a stale lock automatically: another instance could be taking ownership.
  // Its recovery instructions remain available until the user clears it with all copies closed.
  if (await exists(lock)) return;
  if (!["preparing", "ready", "complete", "cancelled", "commit_timeout", "exit_timeout", "replace_failed", "rolled_back"].includes(receipt.state)) return;
  await fs.rm(receipt.directory, { recursive: true, force: true });
}

async function acknowledgeMacUpdate({ userData, execPath, version, argv }) {
  const receipt = await readTransaction(userData, execPath);
  if (!receipt || receipt.version !== version || !argv.includes(`--missions-update-token=${receipt.token}`) ||
      !["opening", "startup_timeout"].includes(receipt.state)) return;
  await fs.writeFile(path.join(receipt.directory, "healthy.next"), `${receipt.token} ${version}`, { mode: 0o600 });
  await fs.rename(path.join(receipt.directory, "healthy.next"), path.join(receipt.directory, "healthy"));
}

async function updateRecoveryMessage(userData, execPath) {
  const receipt = await readTransaction(userData, execPath);
  if (!receipt || receipt.state === "complete") return null;
  if (receipt.state === "opening" &&
      (await fs.readFile(path.join(receipt.directory, "healthy"), "utf8").catch(() => "")) === `${receipt.token} ${receipt.version}`) return null;
  if (await exists(path.join(receipt.directory, "backup.app"))) {
    return `The previous update needs checking. Its backup is at ${path.join(receipt.directory, "backup.app")}. Quit the app before restoring it. Details: ${path.join(receipt.directory, "RECOVERY.txt")}`;
  }
  if (["rolled_back", "replace_failed", "cancelled", "commit_timeout", "exit_timeout"].includes(receipt.state)) {
    return "The previous update was not completed. Your existing app was kept; you can try again.";
  }
  return null;
}

class MacUpdater {
  constructor({ userData, execPath, arch, onStatus = () => {}, fetchImpl }) {
    Object.assign(this, { userData, execPath, arch, onStatus, fetchImpl });
    this.busy = false;
  }

  async install(version, { stopGracefully, quit }) {
    if (this.busy) throw new Error("An update is already in progress.");
    this.busy = true;
    let directory, lock, token, helper, committed = false;
    const status = (phase, extra = {}) => this.onStatus({ phase, ...extra });
    try {
      const target = await getMacTarget(this.execPath);
      await validateMacBundle(target, require("../package.json").version, this.arch);
      const previous = await readTransaction(this.userData, this.execPath);
      if (previous && await exists(path.join(previous.directory, "backup.app"))) {
        throw new Error(await updateRecoveryMessage(this.userData, this.execPath));
      }
      await cleanupPreviousTransaction(previous);
      lock = path.join(path.dirname(target), `.${path.basename(target)}.update-lock`);
      // Exclusive mkdir is shared by all app instances. Never break a lock we do not own.
      await fs.mkdir(lock, { mode: 0o700 }).catch((error) => {
        if (error.code === "EEXIST") throw new Error(`Another update is active or was interrupted. Quit all app copies and check ${lock} before retrying.`);
        throw new Error("The app's folder is not writable. Move it to a writable Applications folder and reopen it.");
      });
      token = crypto.randomBytes(16).toString("hex");
      await fs.writeFile(path.join(lock, "token"), token, { flag: "wx", mode: 0o600 });
      directory = await fs.mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}.update-`));
      const receipt = { target, directory, token, version, ownerPid: process.pid };
      await fs.writeFile(path.join(directory, "transaction.json"), JSON.stringify(receipt), { mode: 0o600 });
      await fs.mkdir(this.userData, { recursive: true });
      await fs.writeFile(receiptPath(this.userData), JSON.stringify(receipt), { mode: 0o600 });
      await fs.writeFile(path.join(directory, "RECOVERY.txt"),
        `Update to ${version}\nOriginal app: ${target}\nBackup: ${directory}/backup.app\n` +
        `If startup failed, quit all copies of the app before restoring backup.app to the original location.\n` +
        `Do not delete the backup until the new app works. See state and helper.log in this folder.\n` +
        `If an interrupted update left a lock, remove ${lock} only after all app and update-helper processes have exited.\n`);
      status("downloading", { percent: 0 });
      const artifact = await getReleaseArtifact(version, "darwin", this.arch, this.fetchImpl);
      const archive = path.join(directory, "update.zip");
      let lastPercent = -1;
      await downloadArtifact(artifact, archive, { fetchImpl: this.fetchImpl, onProgress: (progress) => {
        if (progress.percent !== lastPercent) { lastPercent = progress.percent; status("downloading", progress); }
      } });
      status("verifying");
      const staged = await extractAppZip(archive, path.join(directory, "payload"), BUNDLE_NAME);
      await validateMacBundle(staged, version, this.arch);
      status("preparing");
      const script = path.join(directory, "helper.sh");
      await fs.copyFile(path.join(__dirname, "mac-update-helper.sh"), script);
      await fs.chmod(script, 0o700);
      const log = await fs.open(path.join(directory, "helper.log"), "wx", 0o600);
      try {
        helper = spawn("/bin/sh", [script, target, directory, String(process.pid), token, version, lock],
          { detached: true, stdio: ["ignore", log.fd, log.fd], cwd: directory });
        await new Promise((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
        helper.unref();
      } finally { await log.close(); }
      const deadline = Date.now() + 5000;
      while (!(await exists(path.join(directory, "ready")))) {
        if (Date.now() > deadline || helper.exitCode !== null) throw new Error("The update helper could not start.");
        await sleep(50);
      }
      await stopGracefully();
      await fs.writeFile(path.join(directory, "commit"), token, { flag: "wx", mode: 0o600 });
      committed = true;
      status("restarting");
      quit();
    } catch (error) {
      if (directory && !committed) {
        if (helper) {
          await fs.writeFile(path.join(directory, "cancel"), "", { mode: 0o600 }).catch(() => {});
          const deadline = Date.now() + 2500;
          while (helper.exitCode === null && helper.signalCode === null && Date.now() < deadline) await sleep(50);
        }
        if (!helper || helper.exitCode !== null || helper.signalCode !== null) {
          await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (!committed && lock && token && (!helper || helper.exitCode !== null || helper.signalCode !== null)) {
        if ((await fs.readFile(path.join(lock, "token"), "utf8").catch(() => "")) === token) {
          await fs.unlink(path.join(lock, "token")).catch(() => {});
          await fs.rmdir(lock).catch(() => {});
        }
      }
      status("error", { error: error.message });
      throw error;
    } finally { if (!committed) this.busy = false; }
  }
}

module.exports = { MacUpdater, getMacTarget, validateMacBundle, acknowledgeMacUpdate, updateRecoveryMessage,
  readTransaction, cleanupPreviousTransaction, BUNDLE_NAME, BUNDLE_ID };
