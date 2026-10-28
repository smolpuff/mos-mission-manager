"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

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
module.exports = { tempRoot, createWorkspace, updateLock, validWorkspace, removeReceipt };
