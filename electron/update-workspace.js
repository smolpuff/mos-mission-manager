"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { VERSION_PATTERN } = require("./update-download");

async function tempRoot() { return fs.realpath(os.tmpdir()); }
async function createWorkspace(target) {
  return fs.mkdtemp(path.join(await tempRoot(), `.${path.basename(target)}.update-`));
}
async function updateLock(target) {
  const key = crypto.createHash("sha256").update(target).digest("hex");
  return path.join(await tempRoot(), `missions-update-${key}.lock`);
}
async function validWorkspace(directory, target) {
  // Also recognize old receipts so unfinished updates keep their backup protection.
  return [await tempRoot(), path.dirname(target)].includes(path.dirname(directory)) &&
    path.basename(directory).startsWith(`.${path.basename(target)}.update-`) &&
    await fs.realpath(directory) === directory;
}
async function removeReceipt(userData, directory, token) {
  const file = path.join(userData, "desktop-update-transaction.json");
  const receipt = JSON.parse(await fs.readFile(file, "utf8"));
  if (receipt.directory === directory && receipt.token === token) await fs.unlink(file);
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
async function cleanupCompletedUpdate({ userData, receipt, platform, isAlive = processAlive }) {
  const { state: _state, ...transaction } = receipt;
  const { directory, target, token, version } = transaction;
  if (!/^[a-f0-9]{32}$/.test(token) || !VERSION_PATTERN.test(version) || !(await validWorkspace(directory, target))) return false;
  const saved = await fs.readFile(path.join(userData, "desktop-update-transaction.json"), "utf8");
  const journal = await fs.readFile(path.join(directory, "transaction.json"), "utf8");
  if (saved !== journal || JSON.stringify(JSON.parse(saved)) !== JSON.stringify(transaction)) return false;
  if ((await fs.readFile(path.join(directory, "state"), "utf8")).trim() !== "complete" ||
      (await fs.readFile(path.join(directory, "healthy"), "utf8")) !== `${token} ${version}`) return false;
  const backup = path.join(directory, platform === "win32" ? "backup.exe" : "backup.app");
  const lock = transaction.lock || path.join(path.dirname(target), `.${path.basename(target)}.update-lock`);
  const exists = file => fs.access(file).then(() => true, () => false);
  if (await exists(backup) || await exists(lock)) return false;
  const helperPid = Number(await fs.readFile(path.join(directory, "helper.pid"), "utf8"));
  if (!Number.isInteger(helperPid) || helperPid <= 0 || isAlive(helperPid) || isAlive(transaction.ownerPid)) return false;
  // The old beta helper has exited and released its log/cwd. Delete only its validated transaction.
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  await removeReceipt(userData, directory, token);
  return true;
}
function scheduleCompletedUpdateCleanup(options) {
  let attempts = 0;
  async function attempt() {
    try { if (await cleanupCompletedUpdate(options)) return; } catch {}
    if (++attempts < 180) setTimeout(attempt, 1000).unref();
  }
  void attempt();
}
module.exports = { tempRoot, createWorkspace, updateLock, validWorkspace, removeReceipt,
  cleanupCompletedUpdate, scheduleCompletedUpdateCleanup };
