"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { compareVersions, checkForUpdates } = require("../update-checker");
const { selectArtifact, getReleaseArtifact, releaseAssetUrl } = require("../update-download");

function downloadModule(metadata) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../update-download.js"), "utf8"), {
    module,
    require: (name) => name === "../package.json" ? metadata : require(name),
  });
  return module.exports;
}

test("beta builds use beta/version.json and stable builds use main/version.json", () => {
  for (const version of ["3.3.0b5", "3.3.0-beta.5"]) {
    assert.match(downloadModule({ version }).VERSION_JSON_URL, /\/beta\/version\.json$/);
  }
  assert.match(downloadModule({ version: "3.3.0" }).VERSION_JSON_URL, /\/main\/version\.json$/);
  assert.match(downloadModule({ version: "3.3.0", pbpAuthDiagnostics: true }).VERSION_JSON_URL, /\/main\/version\.json$/);
});

test("numbered betas compare correctly in tag and installed version formats", () => {
  for (let n = 1; n <= 6; n++) {
    assert.equal(compareVersions("3.3.0-beta.7", `3.3.0b${n}`), 1);
    assert.equal(compareVersions("3.3.0-beta.7", `3.3.0-beta.${n}`), 1);
  }
  assert.equal(compareVersions("3.3.0-beta.8", "3.3.0-beta.7"), 1);
  assert.equal(compareVersions("3.3.0-beta.7", "3.3.0-beta.7"), 0);
  assert.equal(compareVersions("3.3.0b5", "3.3.0-beta.4"), 1);
  assert.equal(compareVersions("3.3.0-beta.5", "3.3.0b5"), 0);
  assert.equal(compareVersions("3.3.0-beta.10", "3.3.0-beta.9"), 1);
  assert.equal(compareVersions("3.3.0-beta.4", "3.3.0-beta.5"), -1);
  assert.equal(compareVersions("3.3.0", "3.3.0-beta.5"), 1);
  assert.equal(compareVersions("3.3.0-beta.5", "3.3.0"), -1);
  assert.equal(compareVersions("3.3.1", "3.3.0"), 1);
  assert.equal(compareVersions("3.3.0", "3.3.0"), 0);
});

function manifest() {
  const version = "3.3.0-beta.6";
  return {
    schemaVersion: 1, version,
    downloadUrl: "https://github.com/smolpuff/mos-mission-manager/releases/tag/v3.3.0b6",
    notes: ["Beta regression fixture"],
    artifacts: Object.fromEntries([
      ["win32-x64", "missions-v3-mcp.3.3.0b6.exe"],
      ["darwin-arm64", "missions-v3-mcp-3.3.0b6-arm64-mac.zip"],
      ["darwin-x64", "missions-v3-mcp-3.3.0b6-x64-mac.zip"],
    ].map(([key, file]) => [key, {
      url: releaseAssetUrl(version, file), size: 100, sha256: "a".repeat(64), md5: "b".repeat(32),
    }])),
  };
}

test("a beta offer and its artifact lookup both fetch the beta repository feed", async () => {
  const metadata = manifest();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return Response.json(metadata);
  };
  const offer = await checkForUpdates({ currentVersion: "3.3.0-beta.5", fetchImpl });
  assert.equal(offer.updateAvailable, true);
  assert.equal(offer.latestVersion, metadata.version);
  const artifact = await getReleaseArtifact(offer.latestVersion, "win32", "x64", fetchImpl);
  assert.equal(artifact.url, metadata.artifacts["win32-x64"].url);
  assert.equal(urls.length, 2);
  for (const url of urls) assert.match(url, /\/beta\/version\.json$/);
});

test("promoting final production metadata to the beta feed installs production and then uses main", async () => {
  const metadata = manifest();
  metadata.version = "3.3.0";
  metadata.downloadUrl = "https://github.com/smolpuff/mos-mission-manager/releases/tag/v3.3.0";
  metadata.artifacts["win32-x64"].url = releaseAssetUrl("3.3.0", "missions-v3-mcp.3.3.0.exe");
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return Response.json(metadata); };
  const offer = await checkForUpdates({ currentVersion: "3.3.0-beta.7", fetchImpl });
  assert.equal(offer.updateAvailable, true);
  assert.equal(offer.latestVersion, "3.3.0");
  const artifact = await getReleaseArtifact(offer.latestVersion, "win32", "x64", fetchImpl);
  assert.match(artifact.url, /\/v3\.3\.0\//);
  for (const url of urls) assert.match(url, /\/beta\/version\.json$/);
  assert.match(downloadModule({ version: "3.3.0" }).VERSION_JSON_URL, /\/main\/version\.json$/);
});

test("beta artifact validation retains version, repository and checksum checks", () => {
  const metadata = manifest();
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) {
    assert.match(selectArtifact(metadata, metadata.version, platform, arch).url, /\/v3\.3\.0b6\//);
  }
  assert.throws(() => selectArtifact(metadata, "3.3.0-beta.5", "win32", "x64"), /offered version/);
  metadata.artifacts["win32-x64"].url = metadata.artifacts["win32-x64"].url.replace("v3.3.0b6", "v3.3.0b5");
  assert.throws(() => selectArtifact(metadata, metadata.version, "win32", "x64"), /tagged release/);
  metadata.artifacts["win32-x64"] = { ...manifest().artifacts["win32-x64"], sha256: "bad" };
  assert.throws(() => selectArtifact(metadata, metadata.version, "win32", "x64"), /valid update download/);
  assert.throws(() => releaseAssetUrl("3.3.0-beta.0", "bad.exe"), /Unsupported update version/);
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform} accepts the installed beta version in update acknowledgement`, async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "beta-update-receipt-")));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const userData = path.join(base, "user-data");
    fs.mkdirSync(userData);
    const target = path.join(base, platform === "win32" ? "missions.exe" : "missions.app");
    const execPath = platform === "win32" ? target : path.join(target, "Contents/MacOS/missions");
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    fs.writeFileSync(execPath, "offline fixture");
    const directory = fs.mkdtempSync(path.join(base, `.${path.basename(target)}.update-`));
    const receipt = { target, directory, token: "a".repeat(32), version: "3.3.0-beta.8", ownerPid: process.pid };
    fs.writeFileSync(path.join(userData, "desktop-update-transaction.json"), JSON.stringify(receipt));
    fs.writeFileSync(path.join(directory, "transaction.json"), JSON.stringify(receipt));
    fs.writeFileSync(path.join(directory, "state"), "opening");
    const args = { userData, execPath, version: receipt.version, argv: [`--missions-update-token=${receipt.token}`] };
    if (platform === "win32") {
      const previous = process.env.PORTABLE_EXECUTABLE_FILE;
      process.env.PORTABLE_EXECUTABLE_FILE = execPath;
      try { await require("../windows-updater").acknowledgeWindowsUpdate(args); }
      finally {
        if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
        else process.env.PORTABLE_EXECUTABLE_FILE = previous;
      }
    } else {
      await require("../mac-updater").acknowledgeMacUpdate(args);
    }
    assert.equal(fs.readFileSync(path.join(directory, "healthy"), "utf8"), `${receipt.token} ${receipt.version}`);
  });
}
