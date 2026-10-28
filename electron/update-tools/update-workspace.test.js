"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const workspace = require("../update-workspace");
const { EventEmitter } = require("node:events");
const { promisify } = require("node:util");
const run = promisify(require("node:child_process").execFile);

for (const preserveBackup of [false, true]) {
 test(`Windows helper wrapper ${preserveBackup ? "preserves an unfinished backup" : "removes its completed transaction"}`, { skip: process.platform !== "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(await workspace.tempRoot(), "missions update test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "missions.exe");
  await fs.writeFile(target, "original");
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = target;
  t.after(() => {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  });
  let directory, launch;
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, "../windows-updater.js"), "utf8"), {
    module, process, Buffer, setTimeout, __dirname: path.resolve(__dirname, ".."),
    require: (name) => {
      if (name === "./update-workspace") return workspace;
      if (name === "./update-download") return {
        VERSION_PATTERN: /^\d+\.\d+\.\d+$/,
        getReleaseArtifact: async () => ({}),
        downloadArtifact: async (_artifact, file) => {
          directory = path.dirname(file);
          t.after(() => fs.rm(directory, { recursive: true, force: true }));
          const header = Buffer.alloc(88);
          header.write("MZ"); header.writeUInt32LE(64, 60);
          header.writeUInt32LE(0x4550, 64); header.writeUInt16LE(0x8664, 68);
          await fs.writeFile(file, header);
        },
      };
      if (name === "node:child_process") return { spawn: (_exe, args, options) => {
        assert.equal(options.cwd, path.dirname(directory));
        launch = Buffer.from(args.at(-1), "base64").toString("utf16le");
        const child = new EventEmitter();
        Object.assign(child, { pid: 123, exitCode: null, signalCode: null, unref() {} });
        void fs.writeFile(path.join(directory, "ready"), "").then(() => child.emit("spawn"));
        return child;
      } };
      return require(name);
    },
  });
  const lock = await workspace.updateLock(target);
  t.after(() => fs.rm(lock, { recursive: true, force: true }));
  await new module.exports.WindowsUpdater({ userData: root, arch: "x64" }).install("3.3.1", { stopGracefully: async () => {}, quit() {} });
  // Exercise the exact generated wrapper with a harmless helper, never a real app replacement.
  await fs.writeFile(path.join(directory, "helper.ps1"), "param($Transaction, $ParentProcessId, $LauncherProcessId)\nWrite-Output 'fixture helper'\nexit 0\n");
  if (preserveBackup) await fs.writeFile(path.join(directory, "backup.exe"), "backup");
  const command = launch.match(/'-EncodedCommand', '([^']+)'/)[1];
  await run(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", command], { cwd: await workspace.tempRoot(), windowsHide: true });
  const receipt = path.join(root, "desktop-update-transaction.json");
  if (preserveBackup) {
    assert.equal(await fs.readFile(path.join(directory, "backup.exe"), "utf8"), "backup");
    await fs.access(receipt);
  } else {
    await assert.rejects(fs.access(directory), { code: "ENOENT" });
    await assert.rejects(fs.access(receipt), { code: "ENOENT" });
  }
 });
}

test("Windows failed download removes temp workspace, lock and receipt without touching the app", async (t) => {
  const root = await fs.mkdtemp(path.join(await workspace.tempRoot(), "missions-update-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appFolder = path.join(root, "installed");
  const userData = path.join(root, "settings");
  await fs.mkdir(appFolder); await fs.mkdir(userData);
  const target = path.join(appFolder, "missions.exe");
  await fs.writeFile(target, "original app");
  const previous = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = target;
  t.after(() => {
    if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = previous;
  });
  let directory;
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, "../windows-updater.js"), "utf8"), {
    module, process, Buffer, setTimeout,
    require: (name) => {
      if (name === "./update-workspace") return workspace;
      if (name === "./update-download") return {
        VERSION_PATTERN: /^\d+\.\d+\.\d+$/,
        getReleaseArtifact: async () => ({}),
        downloadArtifact: async (_artifact, download) => {
          directory = path.dirname(download);
          assert.equal(path.dirname(directory), await workspace.tempRoot());
          assert.equal(await workspace.validWorkspace(directory, target), true);
          await fs.writeFile(download, "partial download");
          throw new Error("connection lost");
        },
      };
      return require(name);
    },
  });
  const updater = new module.exports.WindowsUpdater({ userData, arch: "x64" });
  await assert.rejects(updater.install("3.3.1", {
    stopGracefully: () => assert.fail("runner must not stop after failed download"),
    quit: () => assert.fail("app must not quit after failed download"),
  }), /connection lost/);
  assert.equal(updater.busy, false);
  assert.equal(await fs.readFile(target, "utf8"), "original app");
  assert.deepEqual(await fs.readdir(appFolder), ["missions.exe"]);
  assert.deepEqual(await fs.readdir(userData), []);
  await assert.rejects(fs.access(directory), { code: "ENOENT" });
  await assert.rejects(fs.access(await workspace.updateLock(target)), { code: "ENOENT" });
});

test("transaction validation rejects unrelated temp directories and receipts are removed only for their owner", async (t) => {
  const directory = await fs.mkdtemp(path.join(await workspace.tempRoot(), "unrelated-update-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await workspace.validWorkspace(directory, path.join(directory, "missions.exe")), false);
  const file = path.join(directory, "desktop-update-transaction.json");
  await fs.writeFile(file, JSON.stringify({ directory, token: "owner" }));
  await workspace.removeReceipt(directory, directory, "other");
  await fs.access(file);
  await workspace.removeReceipt(directory, directory, "owner");
  await assert.rejects(fs.access(file), { code: "ENOENT" });
});
