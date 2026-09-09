"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { getReleaseArtifact, downloadArtifact } = require("./update-download");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => fs.access(file).then(() => true, () => false);

async function getWindowsTarget() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!portable || !path.isAbsolute(portable) || !portable.toLowerCase().endsWith(".exe")) {
    throw new Error("Run the packaged Windows portable app to update it.");
  }
  const target = await fs.realpath(portable);
  await fs.access(path.dirname(target), fs.constants.W_OK);
  return target;
}

async function validatePortableExe(file) {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, 64, 0);
    const offset = header.readUInt32LE(60), size = (await handle.stat()).size;
    if (header.toString("ascii", 0, 2) !== "MZ" || offset < 64 || offset > size - 24) throw new Error("Invalid Windows update executable.");
    const pe = Buffer.alloc(24); await handle.read(pe, 0, 24, offset);
    // The NSIS portable launcher can be 32-bit even when its embedded app is x64.
    if (pe.readUInt32LE(0) !== 0x4550 || ![0x14c, 0x8664, 0xaa64].includes(pe.readUInt16LE(4))) throw new Error("Invalid Windows update executable.");
  } finally { await handle.close(); }
}

async function readWindowsTransaction(userData) {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(userData, "desktop-update-transaction.json"), "utf8"));
    const target = await getWindowsTarget();
    if (receipt.target !== target || !/^[a-f0-9]{32}$/.test(receipt.token) || !/^\d+\.\d+\.\d+$/.test(receipt.version) ||
        path.dirname(receipt.directory) !== path.dirname(target) || !path.basename(receipt.directory).startsWith(`.${path.basename(target)}.update-`) ||
        await fs.realpath(receipt.directory) !== receipt.directory) return null;
    const journal = JSON.parse(await fs.readFile(path.join(receipt.directory, "transaction.json"), "utf8"));
    if (JSON.stringify(receipt) !== JSON.stringify(journal)) return null;
    return { ...receipt, state: (await fs.readFile(path.join(receipt.directory, "state"), "utf8").catch(() => "preparing")).trim() };
  } catch { return null; }
}

async function acknowledgeWindowsUpdate({ userData, version, argv }) {
  const receipt = await readWindowsTransaction(userData);
  if (!receipt || receipt.version !== version || !argv.includes(`--missions-update-token=${receipt.token}`) ||
      !["opening", "startup_timeout"].includes(receipt.state)) return;
  await fs.writeFile(path.join(receipt.directory, "healthy.next"), `${receipt.token} ${version}`);
  await fs.rename(path.join(receipt.directory, "healthy.next"), path.join(receipt.directory, "healthy"));
}

async function windowsRecoveryMessage(userData) {
  const receipt = await readWindowsTransaction(userData);
  if (!receipt || receipt.state === "complete") return null;
  if (receipt.state === "opening" && (await fs.readFile(path.join(receipt.directory, "healthy"), "utf8").catch(() => "")) === `${receipt.token} ${receipt.version}`) return null;
  if (await exists(path.join(receipt.directory, "backup.exe"))) return `The update needs checking. Quit all app copies before restoring ${path.join(receipt.directory, "backup.exe")} to ${receipt.target}. See ${path.join(receipt.directory, "RECOVERY.txt")}.`;
  if (["rolled_back", "replace_failed", "cancelled", "commit_timeout", "exit_timeout"].includes(receipt.state)) return "The previous update did not complete. Your original app was kept; you can retry.";
  return null;
}

class WindowsUpdater {
  constructor({ userData, arch, onStatus = () => {} }) { Object.assign(this, { userData, arch, onStatus }); this.busy = false; }
  async install(version, { stopGracefully, quit }) {
    if (this.busy) throw new Error("An update is already in progress.");
    this.busy = true;
    let directory, lock, token, helper, committed = false;
    try {
      const target = await getWindowsTarget();
      const previous = await readWindowsTransaction(this.userData);
      if (previous && await exists(path.join(previous.directory, "backup.exe"))) throw new Error(await windowsRecoveryMessage(this.userData));
      lock = path.join(path.dirname(target), `.${path.basename(target)}.update-lock`);
      await fs.mkdir(lock).catch(() => { throw new Error(`Another update is active, or the app's folder is not writable. Check ${lock} after closing all copies.`); });
      token = crypto.randomBytes(16).toString("hex");
      await fs.writeFile(path.join(lock, "token"), token, { flag: "wx" });
      directory = await fs.mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}.update-`));
      const receipt = { target, directory, token, version, ownerPid: process.pid };
      await fs.writeFile(path.join(directory, "transaction.json"), JSON.stringify(receipt));
      await fs.writeFile(path.join(this.userData, "desktop-update-transaction.json"), JSON.stringify(receipt));
      await fs.writeFile(path.join(directory, "RECOVERY.txt"), `Original file: ${target}\r\nBackup: ${directory}\\backup.exe\r\nQuit all app/launcher/helper processes before restoring the backup or removing a stale lock at ${lock}. Keep the backup until the new app works.\r\n`);
      this.onStatus({ phase: "downloading", percent: 0 });
      const artifact = await getReleaseArtifact(version, "win32", this.arch);
      const download = path.join(directory, "download.exe");
      let percent = -1;
      await downloadArtifact(artifact, download, { onProgress: (progress) => {
        if (progress.percent !== percent) { percent = progress.percent; this.onStatus({ phase: "downloading", ...progress }); }
      } });
      this.onStatus({ phase: "verifying" });
      await validatePortableExe(download);
      const script = path.join(directory, "helper.ps1");
      await fs.copyFile(path.join(__dirname, "windows-update-helper.ps1"), script);
      const log = await fs.open(path.join(directory, "helper.log"), "wx");
      try {
        const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
        helper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
          "-Transaction", directory, "-ParentProcessId", String(process.pid), "-LauncherProcessId", String(process.ppid)],
          { detached: true, windowsHide: true, cwd: directory, stdio: ["ignore", log.fd, log.fd] });
        await new Promise((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); });
        helper.unref();
      } finally { await log.close(); }
      const until = Date.now() + 10000;
      while (!(await exists(path.join(directory, "ready")))) {
        if (Date.now() > until || helper.exitCode !== null) throw new Error("The Windows update helper could not start. See helper.log in the update folder.");
        await sleep(100);
      }
      this.onStatus({ phase: "preparing" });
      await stopGracefully();
      await fs.writeFile(path.join(directory, "commit"), token, { flag: "wx" });
      committed = true;
      this.onStatus({ phase: "restarting" });
      quit();
    } catch (error) {
      if (!committed && directory) {
        await fs.writeFile(path.join(directory, "cancel"), "").catch(() => {});
        const until = Date.now() + 3000;
        while (helper && helper.exitCode === null && helper.signalCode === null && Date.now() < until) await sleep(100);
      }
      if (!committed && (!helper || helper.exitCode !== null || helper.signalCode !== null)) {
        if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        if (lock && token && (await fs.readFile(path.join(lock, "token"), "utf8").catch(() => "")) === token) {
          await fs.unlink(path.join(lock, "token")).catch(() => {}); await fs.rmdir(lock).catch(() => {});
        }
      }
      this.onStatus({ phase: "error", error: error.message });
      throw error;
    } finally { if (!committed) this.busy = false; }
  }
}
module.exports = { WindowsUpdater, acknowledgeWindowsUpdate, windowsRecoveryMessage };
