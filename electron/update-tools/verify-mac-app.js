"use strict";

// Builds and drives the actual packaged application. No alternate main/renderer/preload.
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const asar = require("@electron/asar");
const { version } = require("../../package.json");
const { UPDATE_JSON_URL } = require("../update-checker");
const { releaseAssetUrl } = require("../update-download");
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file) => fs.access(file).then(() => true, () => false);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function hash(file, algorithm = "sha256") {
  const result = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(file)) result.update(chunk);
  return result.digest("hex");
}
async function waitFor(check, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await sleep(200); }
  throw new Error("Timed out waiting for the actual application. See app.log in the printed test folder.");
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function connectRenderer(port) {
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) => entry.type === "page" && entry.url.includes("dist/index.html")); }
    catch { return false; }
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const requests = new Map(), alerts = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Inspector timed out: ${method}`)); }, 15000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Page.javascriptDialogOpening") {
      alerts.push(message.params.message);
      void send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
    const request = requests.get(message.id);
    if (request) { clearTimeout(request.timer); requests.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Page.enable");
  return { send, evaluate, alerts, close: () => socket.close(),
    screenshot: async (file) => fs.writeFile(file, Buffer.from((await send("Page.captureScreenshot")).data, "base64")) };
}

async function main() {
  assert(process.platform === "darwin", "Run this application update test on a Mac.");
  const args = new Set(process.argv.slice(2));
  assert([...args].every((arg) => ["--auto", "--bad-md5"].includes(arg)), "Options: --auto, --bad-md5");
  const automatic = args.has("--auto"), badMd5 = args.has("--bad-md5");
  const root = await fs.mkdtemp("/private/tmp/missions-actual-app-update-");
  const nextVersion = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const settings = path.join(root, "settings"), installed = path.join(root, "installed/missions-v3-mcp.app");
  const candidate = path.join(root, "release/missions-v3-mcp.app");
  const archive = path.join(root, `missions-v3-mcp-${nextVersion}-${process.arch}-mac.zip`);
  const cdpPort = await freePort(), token = crypto.randomBytes(16).toString("hex");
  const notes = ["Verify the existing Missions update dialog.", "Download and replace the complete application."];
  const requests = { version: 0, manifest: 0, archive: 0, bytes: 0 };
  let manifest, launched, inspector, updatedLaunch, failed = true;
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
      const route = request.url.slice(token.length + 2);
      if (route === "version") {
        requests.version += 1; response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ version: nextVersion, downloadUrl: `https://github.com/smolpuff/mos-mission-manager/releases/tag/v${nextVersion}`, notes }));
      } else if (route === "manifest") {
        requests.manifest += 1; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(manifest));
      } else if (route === "archive") {
        requests.archive += 1;
        response.writeHead(200, { "Content-Length": (await fs.stat(archive)).size, "Content-Type": "application/zip" });
        const source = createReadStream(archive);
        source.on("data", (chunk) => { requests.bytes += chunk.length; });
        await pipeline(source, response);
      } else response.writeHead(404).end();
    } catch (error) { response.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/${token}`;
  const routes = { [UPDATE_JSON_URL]: `${origin}/version`, [releaseAssetUrl(nextVersion, "desktop-update.json")]: `${origin}/manifest`,
    [releaseAssetUrl(nextVersion, path.basename(archive))]: `${origin}/archive` };
  const launches = path.join(root, "launches.jsonl");
  // Inject only external test boundaries into copies of the production ASAR:
  // private data location, local release transport, and inspector. UI/IPC/updater stay intact.
  const bootstrap = `"use strict";
const { app } = require("electron");
const fs = require("node:fs");
const privateHome = ${JSON.stringify(path.join(settings, "home"))};
fs.mkdirSync(privateHome, { recursive: true });
require("node:os").homedir = () => privateHome;
fs.mkdirSync(${JSON.stringify(path.join(settings, "session"))}, { recursive: true });
app.setPath("userData", ${JSON.stringify(settings)});
app.setPath("sessionData", ${JSON.stringify(path.join(settings, "session"))});
app.setAppLogsPath(${JSON.stringify(path.join(settings, "logs"))});
app.commandLine.appendSwitch("remote-debugging-port", ${JSON.stringify(String(cdpPort))});
process.env.PBP_DESKTOP_DEVTOOLS = "1";
const originalFetch = globalThis.fetch;
const routes = ${JSON.stringify(routes)};
globalThis.fetch = (url, options) => {
  if (routes[String(url)]) return originalFetch(routes[String(url)], options);
  ${automatic ? 'return Promise.reject(new Error("401: isolated test account has no external session"));' : 'return originalFetch(url, options);'}
};
app.on("ready", () => fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: process.pid, version: app.getVersion(), execPath: process.execPath }) + "\\n"));
`;
  try {
    console.log(`Building the actual Missions Mac app. Test files: ${root}`);
    const log = await fs.open(path.join(root, "build.log"), "w");
    const command = async (file, commandArgs, env = {}) => {
      await new Promise((resolve, reject) => {
        const child = spawn(file, commandArgs, { cwd: path.resolve(__dirname, "../.."), env: { ...process.env, DEBUG: "", ...env }, stdio: ["ignore", log.fd, log.fd] });
        child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${file} failed (${code}); see ${root}/build.log`)));
      });
    };
    try {
      await command("npm", ["run", "desktop:build"]);
      await command("npx", ["electron-builder", "--mac", "dir", `--${process.arch}`, "--publish", "never", `--config.directories.output=${root}/build`], { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
    } finally { await log.close(); }
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.rename(path.join(root, "build", process.arch === "arm64" ? "mac-arm64" : "mac", "missions-v3-mcp.app"), installed);
    const archiveRelative = "Contents/Resources/app.asar";
    const tree = path.join(root, "packaged-source");
    asar.extractAll(path.join(installed, archiveRelative), tree);
    await fs.writeFile(path.join(tree, "electron/local-update-verification.cjs"), bootstrap);
    const mainPath = path.join(tree, "electron/main.js");
    await fs.writeFile(mainPath, 'require("./local-update-verification.cjs");\n' + await fs.readFile(mainPath, "utf8"));
    async function pack(bundle, targetVersion) {
      const pkg = JSON.parse(await fs.readFile(path.join(tree, "package.json"), "utf8"));
      pkg.version = targetVersion;
      await fs.writeFile(path.join(tree, "package.json"), JSON.stringify(pkg, null, 2));
      const appArchive = path.join(bundle, archiveRelative);
      await asar.createPackageWithOptions(tree, appArchive, { unpack: "**/*.node" });
      asar.uncache(appArchive);
      const plist = path.join(bundle, "Contents/Info.plist");
      for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) await run("/usr/bin/plutil", ["-replace", key, "-string", targetVersion, plist]);
      const integrity = crypto.createHash("sha256").update(asar.getRawHeader(appArchive).headerString).digest("hex");
      await run("/usr/bin/plutil", ["-replace", "ElectronAsarIntegrity", "-json", JSON.stringify({ "Resources/app.asar": { algorithm: "SHA256", hash: integrity } }), plist]);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,requirements,flags,runtime", bundle]);
    }
    await pack(installed, version);
    await fs.cp(installed, candidate, { recursive: true, verbatimSymlinks: true });
    // Build the unchanged real renderer against the next package version too;
    // its navigation version is compiled from package.json by Vite.
    const nextSource = path.join(root, "next-renderer-source");
    const repository = path.resolve(__dirname, "../..");
    await fs.mkdir(nextSource);
    await fs.cp(path.join(repository, "renderer"), path.join(nextSource, "renderer"), { recursive: true });
    for (const file of ["vite.config.js", "index.html", "tailwind.config.js"]) await fs.copyFile(path.join(repository, file), path.join(nextSource, file));
    await fs.writeFile(path.join(nextSource, "package.json"), JSON.stringify({ ...require("../../package.json"), version: nextVersion }));
    await fs.symlink(path.join(repository, "node_modules"), path.join(nextSource, "node_modules"), "dir");
    await run(process.execPath, [path.join(repository, "node_modules/vite/bin/vite.js"), "build", "--outDir", path.join(tree, "dist")], { cwd: nextSource, timeout: 120000 });
    await pack(candidate, nextVersion);
    const oldHash = await hash(path.join(installed, archiveRelative)), nextHash = await hash(path.join(candidate, archiveRelative));
    await fs.mkdir(settings, { recursive: true });
    await fs.writeFile(path.join(settings, "config.json"), JSON.stringify({ autoUpdateCheckEnabled: true, appUpdateVerification: token }));
    console.log(`Packing the actual ${nextVersion} application ZIP…`);
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", candidate, archive], { timeout: 120000 });
    const expected = { url: releaseAssetUrl(nextVersion, path.basename(archive)), size: (await fs.stat(archive)).size,
      sha256: await hash(archive), md5: badMd5 ? "0".repeat(32) : await hash(archive, "md5") };
    manifest = { schemaVersion: 1, version: nextVersion, artifacts: { [`darwin-${process.arch}`]: expected } };
    await fs.writeFile(path.join(root, "desktop-update.json"), JSON.stringify(manifest, null, 2));
    const appLog = await fs.open(path.join(root, "app.log"), "w");
    try {
      const env = { ...process.env }; for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_ENV", "PBP_DESKTOP_DEV_MODE", "PBP_STANDALONE_CLI", "VITE_DEV_SERVER_URL"]) delete env[key];
      launched = spawn(path.join(installed, "Contents/MacOS/missions-v3-mcp"), [], { env, stdio: ["ignore", appLog.fd, appLog.fd] });
      await new Promise((resolve, reject) => { launched.once("spawn", resolve); launched.once("error", reject); });
    } finally { await appLog.close(); }
    inspector = await connectRenderer(cdpPort);
    const dialogExpression = `Array.from(document.querySelectorAll('[role="dialog"]')).find(el => el.textContent.includes('Update Available'))`;
    const dialog = await waitFor(() => inspector.evaluate(`(() => { const el = ${dialogExpression}; return el && { text: el.innerText, buttons: Array.from(el.querySelectorAll('button')).map(b => b.innerText.trim()) }; })()`));
    assert(JSON.stringify(dialog.buttons) === JSON.stringify(["Cancel", "Download and restart"]), `Unexpected dialog buttons: ${JSON.stringify(dialog.buttons)}`);
    assert(notes.every((note) => dialog.text.includes(note)), "Release notes were not shown in the actual update dialog.");
    assert(requests.archive === 0, "The app downloaded before confirmation.");
    await inspector.screenshot(path.join(root, "before-update.png"));
    console.log("The existing Missions dialog found the release and displays its notes. No file downloaded yet.");
    if (automatic) {
      const point = await inspector.evaluate(`(() => { const b = Array.from((${dialogExpression}).querySelectorAll('button')).find(b => b.innerText.trim() === 'Download and restart'); const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
      await inspector.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await inspector.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    } else console.log("Click Download and restart in YOUR APPLICATION's existing dialog. This terminal will verify the result.");
    const until = automatic ? 180000 : 1800000;
    if (badMd5) {
      await waitFor(() => inspector.alerts.find((message) => message.includes("MD5 verification failed")), until);
      assert(await hash(path.join(installed, archiveRelative)) === oldHash, "The old application changed despite MD5 failure.");
      await inspector.screenshot(path.join(root, "after-rejection.png"));
    } else {
      updatedLaunch = await waitFor(async () => {
        if (inspector.alerts.length) throw new Error(`The actual application reported: ${inspector.alerts.at(-1)}`);
        const entries = (await fs.readFile(launches, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
        return entries.find((entry) => entry.version === nextVersion && entry.pid !== launched.pid);
      }, until);
      inspector.close(); inspector = await connectRenderer(cdpPort);
      const receipt = JSON.parse(await fs.readFile(path.join(settings, "desktop-update-transaction.json"), "utf8"));
      await waitFor(async () => (await fs.readFile(path.join(receipt.directory, "state"), "utf8")).trim() === "complete" && !(await exists(path.join(receipt.directory, "backup.app"))));
      assert(await hash(path.join(installed, archiveRelative)) === nextHash, "Installed application ASAR differs from the actual release payload.");
      assert(updatedLaunch.execPath === path.join(installed, "Contents/MacOS/missions-v3-mcp"), "The new app launched from a different location.");
      await waitFor(() => inspector.evaluate(`document.body.textContent.includes(${JSON.stringify(`v${nextVersion}`)})`));
      await inspector.screenshot(path.join(root, "after-update.png"));
    }
    assert(requests.bytes === expected.size && requests.archive === 1, "The complete ZIP was not downloaded exactly once.");
    assert(JSON.parse(await fs.readFile(path.join(settings, "config.json"), "utf8")).appUpdateVerification === token, "Settings were not preserved.");
    const report = { passed: true, actualApplication: true, scenario: badMd5 ? "bad-md5-rejected" : "download-replace-relaunch", installed,
      beforeVersion: version, offeredVersion: nextVersion, dialog, requests, expected, originalAsarSha256: oldHash,
      installedAsarSha256: await hash(path.join(installed, archiveRelative)), expectedAsarSha256: badMd5 ? oldHash : nextHash, updatedLaunch };
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
    console.log(badMd5 ? "PASS: the actual app rejected the incorrect MD5 and kept its original files." : `PASS: the actual app downloaded ${requests.bytes} bytes, replaced its complete ASAR, and reopened version ${nextVersion} at the same path.`);
    console.log(`Proof and screenshots: ${root}`);
    failed = false;
  } finally {
    inspector?.close();
    if (automatic || failed) {
      if (launched && launched.exitCode === null) launched.kill("SIGTERM");
      if (updatedLaunch) { try { process.kill(updatedLaunch.pid, "SIGTERM"); } catch {} }
    } else launched?.unref();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    console.log(`Application copies and logs retained at ${root}`);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
