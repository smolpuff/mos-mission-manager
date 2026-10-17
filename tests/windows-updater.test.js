"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

// Exercise the installer with private files and a tiny PowerShell helper. Only
// release delivery and the helper's file-replacement work are substituted.
function loadUpdater(root, helperSource, spawnImpl) {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const filename = path.join(root, "electron/windows-updater.js");
  const module = { exports: {} };
  const dependencies = {
    "node:fs/promises": {
      ...fs.promises,
      copyFile: (_source, destination) => fs.promises.writeFile(destination, helperSource),
    },
    "./update-download": {
      getReleaseArtifact: async () => ({}),
      downloadArtifact: async (_artifact, destination) => {
        const exe = Buffer.alloc(88);
        exe.write("MZ");
        exe.writeUInt32LE(64, 60);
        exe.writeUInt32LE(0x4550, 64);
        exe.writeUInt16LE(0x8664, 68);
        await fs.promises.writeFile(destination, exe);
      },
    },
    "node:child_process": { spawn: spawnImpl || require("node:child_process").spawn },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: (name) => dependencies[name] || require(name),
    module, __dirname: path.dirname(filename), process, Buffer, setTimeout,
  }, { filename });
  return module.exports.WindowsUpdater;
}

async function fixture(t) {
  // Spaces and apostrophes must survive both PowerShell command boundaries.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "missions updater's test-"));
  const target = path.join(directory, "app.exe");
  await fs.writeFile(target, "original app");
  const userData = path.join(directory, "settings");
  await fs.mkdir(userData);
  const original = process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_FILE = target;
  t.after(async () => {
    if (original === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = original;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, target, userData, arch: "x64" };
}

const root = path.resolve(__dirname, "..");

test("helper spawn failures preserve diagnostics, release the lock, and allow retry", async (t) => {
  const fixtureData = await fixture(t);
  const { EventEmitter } = require("node:events");
  const WindowsUpdater = loadUpdater(root, "helper", () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    process.nextTick(() => child.emit("error", new Error("PowerShell unavailable")));
    return child;
  });
  const updater = new WindowsUpdater(fixtureData);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(updater.install("3.2.19", {
      stopGracefully: () => assert.fail("runner must stay running"),
      quit: () => assert.fail("app must stay open"),
    }), /PowerShell unavailable/);
    const receipt = JSON.parse(await fs.readFile(path.join(fixtureData.userData, "desktop-update-transaction.json")));
    await fs.access(path.join(receipt.directory, "helper.log"));
    await fs.access(path.join(receipt.directory, "transaction.json"));
    await assert.rejects(fs.access(path.join(receipt.directory, "download.exe")));
    await assert.rejects(fs.access(path.join(fixtureData.directory, ".app.exe.update-lock")));
    assert.equal(updater.busy, false);
    assert.equal(await fs.readFile(fixtureData.target, "utf8"), "original app");
  }
});

test("PowerShell failures keep the log referenced by the error", { skip: process.platform !== "win32" }, async (t) => {
  const fixtureData = await fixture(t);
  const WindowsUpdater = loadUpdater(root, "Write-Output 'helper diagnostic'; exit 7");
  const updater = new WindowsUpdater(fixtureData);
  let failure;
  await assert.rejects(updater.install("3.2.19", {
    stopGracefully: () => assert.fail("runner must stay running"),
    quit: () => assert.fail("app must stay open"),
  }), (error) => { failure = error; return /helper could not start/.test(error.message); });
  const receipt = JSON.parse(await fs.readFile(path.join(fixtureData.userData, "desktop-update-transaction.json")));
  const log = path.join(receipt.directory, "helper.log");
  assert.ok(failure.message.includes(log));
  assert.match(await fs.readFile(log, "utf8"), /helper diagnostic/);
  assert.equal(await fs.readFile(fixtureData.target, "utf8"), "original app");
});

test("the production helper rejects an unrelated launcher without replacing the app", { skip: process.platform !== "win32" }, async (t) => {
  const fixtureData = await fixture(t);
  const WindowsUpdater = loadUpdater(root, await fs.readFile(path.join(root, "electron/windows-update-helper.ps1"), "utf8"));
  await assert.rejects(new WindowsUpdater(fixtureData).install("3.2.19", {
    stopGracefully: () => assert.fail("runner must stay running"),
    quit: () => assert.fail("app must stay open"),
  }), /helper could not start/);
  const receipt = JSON.parse(await fs.readFile(path.join(fixtureData.userData, "desktop-update-transaction.json")));
  assert.match(await fs.readFile(path.join(receipt.directory, "helper.log"), "utf8"), /portable launcher could not be identified/);
  assert.equal((await fs.readFile(path.join(receipt.directory, "state"), "utf8")).trim(), "recovery_required");
  await assert.rejects(fs.access(path.join(fixtureData.directory, ".app.exe.update-lock")));
  assert.equal(await fs.readFile(fixtureData.target, "utf8"), "original app");
});

test("Windows helper starts hidden and survives the installing process exiting", { skip: process.platform !== "win32" }, async (t) => {
  const fixtureData = await fixture(t);
  const helperSource = `param([string]$Transaction, [int]$ParentProcessId, [int]$LauncherProcessId)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText((Join-Path $Transaction 'ready'), '')
$deadline = (Get-Date).AddSeconds(15)
while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { exit 2 }
  Start-Sleep -Milliseconds 100
}
if (!(Test-Path -LiteralPath (Join-Path $Transaction 'commit'))) { exit 3 }
[IO.File]::WriteAllText((Join-Path $Transaction 'survived'), 'yes')
`;
  const driver = `
const WindowsUpdater = (${loadUpdater.toString()})(${JSON.stringify(root)}, ${JSON.stringify(helperSource)});
new WindowsUpdater(${JSON.stringify(fixtureData)}).install('3.2.19', {
  stopGracefully: async () => {}, quit: () => process.exit(0),
}).catch(error => { console.error(error); process.exit(1); });
`;
  const child = spawn(process.execPath, ["-e", driver], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, output);
  const receipt = JSON.parse(await fs.readFile(path.join(fixtureData.userData, "desktop-update-transaction.json")));
  const until = Date.now() + 10000;
  while (!(await fs.access(path.join(receipt.directory, "survived")).then(() => true, () => false))) {
    assert.ok(Date.now() < until, "helper did not survive app exit");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await fs.readFile(path.join(receipt.directory, "commit"), "utf8"), receipt.token);
  assert.equal(await fs.readFile(fixtureData.target, "utf8"), "original app");
  // This helper intentionally omits replacement and lock cleanup.
});
