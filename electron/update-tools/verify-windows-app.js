"use strict";

// Rehearse a complete update with private, real NSIS portable applications.
// Production UI, IPC, updater, helper, replacement and acknowledgement are used.
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const asar = require("@electron/asar");
const resedit = require("resedit");
const { version } = require("../../package.json");
const { UPDATE_JSON_URL } = require("../update-checker");
const { releaseAssetUrl } = require("../update-download");

const repository = path.resolve(__dirname, "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => fs.access(file).then(() => true, () => false);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function hash(file, algorithm = "sha256") {
  const digest = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function waitFor(check, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error("Timed out. Inspect the retained app.log, helper.log and transaction state.");
}

async function main() {
  assert(process.platform === "win32", "Run this rehearsal on Windows.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "missions-windows-update-"));
  console.log(`Private update rehearsal: ${root}`);
  const nextVersion = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const appData = path.join(root, "appData");
  const settings = path.join(appData, "missions-v3-mcp");
  const installed = path.join(root, "installed", "Missions Update Test.exe");
  const candidate = path.join(root, "next", `missions-v3-mcp-${nextVersion}-x64-portable.exe`);
  const launchesFile = path.join(root, "launches.jsonl");
  const token = crypto.randomBytes(16).toString("hex");
  const requests = { version: 0, manifest: 0, executable: 0, bytes: 0 };
  const states = [];
  let manifest, launched, receipt, result;
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
      const route = request.url.slice(token.length + 2);
      if (route === "version") {
        requests.version++;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ version: nextVersion,
          downloadUrl: `https://github.com/smolpuff/mos-mission-manager/releases/tag/v${nextVersion}`,
          notes: ["LOCAL UPDATE TEST: private app and settings.",
            `Watch ${version} download, replace its portable EXE, and reopen as test version ${nextVersion}.`,
            "Your normal app, wallets and login are untouched."] }));
      } else if (route === "manifest") {
        requests.manifest++;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(manifest));
      } else if (route === "executable") {
        requests.executable++;
        response.writeHead(200, { "Content-Length": (await fs.stat(candidate)).size, "Content-Type": "application/octet-stream" });
        // Slow localhost delivery enough for the real progress dialog to be visible.
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          requests.bytes += chunk.length;
          setTimeout(() => callback(null, chunk), Math.max(1, Math.round(chunk.length / (12 * 1024))));
        } });
        await pipeline(createReadStream(candidate), meter, response);
      } else response.writeHead(404).end();
    } catch (error) { response.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/${token}`;
  const routes = { [UPDATE_JSON_URL]: `${origin}/version`,
    [releaseAssetUrl(nextVersion, "desktop-update.json")]: `${origin}/manifest`,
    [releaseAssetUrl(nextVersion, path.basename(candidate))]: `${origin}/executable` };
  const bootstrap = `"use strict";
const { app } = require('electron');
const fs = require('node:fs');
const privateHome = ${JSON.stringify(path.join(root, "home"))};
fs.mkdirSync(privateHome, { recursive: true });
fs.mkdirSync(${JSON.stringify(appData)}, { recursive: true });
require('node:os').homedir = () => privateHome;
app.setPath('appData', ${JSON.stringify(appData)});
app.setPath('userData', ${JSON.stringify(settings)});
app.setAppLogsPath(${JSON.stringify(path.join(root, "logs"))});
const originalFetch = globalThis.fetch;
const routes = ${JSON.stringify(routes)};
globalThis.fetch = (url, options) => routes[String(url)]
  ? originalFetch(routes[String(url)], options)
  : Promise.reject(new Error('Isolated update rehearsal: external requests disabled'));
app.on('browser-window-created', (_event, window) => {
  const title = '[UPDATE TEST] Missions v' + app.getVersion();
  window.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title); });
  window.webContents.on('did-finish-load', () => window.setTitle(title));
});
app.on('ready', () => fs.appendFileSync(${JSON.stringify(launchesFile)}, JSON.stringify({
  pid: process.pid, version: app.getVersion(), portable: process.env.PORTABLE_EXECUTABLE_FILE,
  userData: app.getPath('userData'), argv: process.argv
}) + '\\n'));
`;
  const buildLog = await fs.open(path.join(root, "build.log"), "w");
  const command = async (args, cwd = repository) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", buildLog.fd, buildLog.fd] });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Build failed (${code}). See ${root}\\build.log`)));
    });
  };
  try {
    const sourceApp = path.join(repository, "release/win-unpacked");
    const originalArchive = path.join(sourceApp, "resources/app.asar");
    assert(await exists(originalArchive), "Build the Windows app first: npm run desktop:dist:win");
    assert(asar.extractFile(originalArchive, path.join("electron", "windows-updater.js")).equals(
      await fs.readFile(path.join(repository, "electron/windows-updater.js"))), "Rebuild the Windows app first; its updater differs from source.");
    const tree = path.join(root, "packaged-source");
    asar.extractAll(originalArchive, tree);
    await fs.writeFile(path.join(tree, "electron/local-update-verification.cjs"), bootstrap);
    const mainPath = path.join(tree, "electron/main.js");
    await fs.writeFile(mainPath, 'require("./local-update-verification.cjs");\n' + await fs.readFile(mainPath, "utf8"));
    const nextRenderer = path.join(root, "next-renderer");
    await fs.mkdir(nextRenderer);
    await fs.cp(path.join(repository, "renderer"), path.join(nextRenderer, "renderer"), { recursive: true });
    await fs.cp(path.join(repository, "src"), path.join(nextRenderer, "src"), { recursive: true });
    await fs.mkdir(path.join(nextRenderer, "electron"));
    await fs.copyFile(path.join(repository, "electron/security.js"), path.join(nextRenderer, "electron/security.js"));
    for (const name of ["vite.config.js", "index.html", "tailwind.config.js"]) {
      await fs.copyFile(path.join(repository, name), path.join(nextRenderer, name));
    }
    await fs.writeFile(path.join(nextRenderer, "package.json"), JSON.stringify({ ...require("../../package.json"), version: nextVersion }));
    await fs.symlink(path.join(repository, "node_modules"), path.join(nextRenderer, "node_modules"), "junction");
    const builder = path.join(repository, "node_modules/electron-builder/cli.js");
    for (const [label, buildVersion] of [["current", version], ["next", nextVersion]]) {
      console.log(`Packaging real portable test app ${buildVersion}...`);
      const bundle = path.join(root, `${label}-unpacked`);
      await fs.cp(sourceApp, bundle, { recursive: true });
      if (label === "next") {
        await command([path.join(repository, "node_modules/vite/bin/vite.js"), "build", "--outDir", path.join(tree, "dist")], nextRenderer);
      }
      const pkg = JSON.parse(await fs.readFile(path.join(tree, "package.json"), "utf8"));
      pkg.version = buildVersion;
      await fs.writeFile(path.join(tree, "package.json"), JSON.stringify(pkg, null, 2));
      const archive = path.join(bundle, "resources/app.asar");
      await asar.createPackageWithOptions(tree, archive, { unpack: "**/*.node" });
      asar.uncache(archive);
      // Keep Electron's embedded archive integrity in sync with the private ASAR.
      const exePath = path.join(bundle, "missions-v3-mcp.exe");
      const executable = resedit.NtExecutable.from(await fs.readFile(exePath));
      const resources = resedit.NtExecutableResource.from(executable);
      const integrity = resources.entries.find(entry => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR");
      assert(integrity, "Missing Electron ASAR integrity resource");
      integrity.bin = Buffer.from(JSON.stringify([{ file: "resources\\app.asar", alg: "SHA256",
        value: crypto.createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex") }]));
      resources.outputResource(executable);
      await fs.writeFile(exePath, Buffer.from(executable.generate()));
      const output = path.join(root, label);
      await command([builder, "--win", "portable", "--x64", "--prepackaged", bundle, "--publish", "never",
        `--config.directories.output=${output}`, `--config.extraMetadata.version=${buildVersion}`, "--config.compression=store"]);
      if (label === "current") {
        await fs.mkdir(path.dirname(installed));
        await fs.copyFile(path.join(output, `missions-v3-mcp-${buildVersion}-x64-portable.exe`), installed);
      }
    }
    const expected = { url: releaseAssetUrl(nextVersion, path.basename(candidate)), size: (await fs.stat(candidate)).size,
      sha256: await hash(candidate), md5: await hash(candidate, "md5") };
    manifest = { schemaVersion: 1, version: nextVersion, artifacts: { "win32-x64": expected } };
    const oldHash = await hash(installed);
    await fs.mkdir(settings, { recursive: true });
    await fs.writeFile(path.join(settings, "config.json"), JSON.stringify({ autoUpdateCheckEnabled: true, appUpdateVerification: token }));
    await fs.writeFile(path.join(root, "desktop-update.json"), JSON.stringify(manifest, null, 2));
    const env = { ...process.env };
    for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_ENV", "PBP_DESKTOP_DEV_MODE", "PBP_STANDALONE_CLI", "VITE_DEV_SERVER_URL"]) delete env[name];
    const appLog = await fs.open(path.join(root, "app.log"), "w");
    try {
      launched = spawn(installed, [], { env, detached: true, windowsHide: true, stdio: ["ignore", appLog.fd, appLog.fd] });
      await new Promise((resolve, reject) => { launched.once("spawn", resolve); launched.once("error", reject); });
      launched.unref();
    } finally { await appLog.close(); }
    await waitFor(() => requests.version > 0);
    assert(requests.executable === 0, "The app downloaded before confirmation");
    console.log(`READY: Click Download and restart in [UPDATE TEST] Missions v${version}.`);
    console.log(`It will download the real test EXE and reopen at the same path as v${nextVersion}.`);
    await fs.writeFile(path.join(root, "ready.json"), JSON.stringify({ root, installed, version, nextVersion, settings }));
    await waitFor(async () => {
      receipt = JSON.parse(await fs.readFile(path.join(settings, "desktop-update-transaction.json"), "utf8").catch(() => "null"));
      if (!receipt) return false;
      const state = (await fs.readFile(path.join(receipt.directory, "state"), "utf8")
        .catch(() => states.at(-1)?.state || "preparing")).trim();
      if (states.at(-1)?.state !== state) {
        states.push({ state, time: new Date().toISOString() });
        console.log(`Update state: ${state}`);
      }
      if (["recovery_required", "replace_failed", "rolled_back", "startup_timeout", "exit_timeout", "cancelled", "commit_timeout"].includes(state)) {
        throw new Error(`Update failed: ${state}. Inspect ${receipt.directory}`);
      }
      return state === "complete";
    }, 30 * 60 * 1000);
    await waitFor(async () => !(await exists(path.join(receipt.directory, "backup.exe"))));
    const launches = (await fs.readFile(launchesFile, "utf8")).trim().split("\n").map(JSON.parse);
    const before = launches.find(entry => entry.version === version);
    const after = launches.find(entry => entry.version === nextVersion);
    assert(before && after && before.pid !== after.pid, "No distinct updated application process");
    assert(after.portable === installed && after.userData === settings, "The new app changed location or used other settings");
    assert(after.argv.includes(`--missions-update-token=${receipt.token}`), "The replacement did not receive its acknowledgement token");
    assert(await hash(installed) === expected.sha256, "Installed EXE differs from downloaded release");
    assert(oldHash !== expected.sha256, "The test release did not change the EXE");
    assert(await fs.readFile(path.join(receipt.directory, "healthy"), "utf8") === `${receipt.token} ${nextVersion}`, "The real renderer did not acknowledge startup");
    assert(requests.executable === 1 && requests.bytes === expected.size, "The complete EXE was not downloaded exactly once");
    assert(JSON.parse(await fs.readFile(path.join(settings, "config.json"), "utf8")).appUpdateVerification === token, "Settings were lost");
    result = { passed: true, actualApplication: true, beforeVersion: version, afterVersion: nextVersion,
      installed, settings, originalExeSha256: oldHash, installedExeSha256: expected.sha256,
      requests, states, before, after, receipt, completed: new Date().toISOString() };
    console.log(`PASS: downloaded ${requests.bytes} bytes, replaced the real portable EXE, reopened ${nextVersion}, and received the real renderer's healthy acknowledgement.`);
    console.log(`The updated test app stays open. Proof: ${path.join(root, "result.json")}`);
  } catch (error) {
    result = { passed: false, error: error.message, requests, states, receipt };
    throw error;
  } finally {
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    await buildLog.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(`Test copies and logs retained at ${root}`);
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
