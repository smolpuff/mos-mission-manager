"use strict";

// Run the real main/preload/built renderer with private, empty settings.
// Never unlock a wallet or use the normal app's home directory.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const repository = path.resolve(__dirname, "../..");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missions-security-test-"));
  console.log(`Private desktop security test: ${root}`);
  const env = { ...process.env, MISSIONS_SECURITY_TEST_ROOT: root, NODE_ENV: "production" };
  for (const name of ["ELECTRON_RUN_AS_NODE", "PBP_DESKTOP_DEV_MODE", "PBP_STANDALONE_CLI", "VITE_DEV_SERVER_URL"]) delete env[name];
  const log = fs.openSync(path.join(root, "app.log"), "wx");
  const child = spawn(require("electron"), [__filename], { env, windowsHide: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const timeout = setTimeout(() => { child.kill(); console.error("Desktop security test timed out"); }, 60000);
  child.once("error", error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once("exit", code => {
    clearTimeout(timeout);
    const resultFile = path.join(root, "result.json");
    console.log(fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : fs.readFileSync(path.join(root, "app.log"), "utf8"));
    process.exitCode = code || (fs.existsSync(resultFile) ? 0 : 1);
  });
} else {
  const { app, BrowserWindow } = require("electron");
  const root = process.env.MISSIONS_SECURITY_TEST_ROOT;
  assert.ok(root, "Launch through npm run test:desktop-security");
  const home = path.join(root, "home"), appData = path.join(root, "appData");
  const settings = path.join(appData, "missions-v3-mcp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, "config.json"), JSON.stringify({ missionsAnalyticsEnabled: false, autoUpdateCheckEnabled: false }));
  os.homedir = () => home;
  app.setPath("appData", appData);
  app.setPath("userData", settings);
  app.setAppLogsPath(path.join(root, "logs"));
  // Exercise production sender and CSP rules using source files, without packaging.
  Object.defineProperty(app, "isPackaged", { value: true });
  globalThis.fetch = () => Promise.reject(new Error("Security test: external traffic disabled"));
  const rendererLoaded = new Promise(resolve => {
    app.on("browser-window-created", (_event, win) => {
      win.on("show", () => win.hide());
      win.webContents.on("did-finish-load", () => {
        if (win.webContents.getURL().startsWith("file:") && win.webContents.getURL().includes("dist/index.html")) resolve(win);
      });
    });
  });
  require("../main");
  (async () => {
    const win = await rendererLoaded;
    const evaluate = source => win.webContents.executeJavaScript(source);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(app.getPath("userData"), settings);
    const state = await evaluate("window.missionsDesktop.getState()");
    assert.ok(state && typeof state === "object", "The real preload's authorized IPC failed");
    const render = await evaluate(`({ text: document.body.innerText,
      policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content })`);
    assert.match(render.text, /MISSIONS/);
    assert.match(render.policy, /script-src 'self';/);
    assert.match(render.policy, /connect-src 'none';/);
    const inlineBlocked = await evaluate(`(() => {
      window.__securityInlineExecuted = false;
      const script = document.createElement('script');
      script.textContent = 'window.__securityInlineExecuted = true';
      document.body.append(script);
      return window.__securityInlineExecuted === false;
    })()`);
    assert.equal(inlineBlocked, true, "Inline JavaScript ran despite CSP");
    const originalUrl = win.webContents.getURL();
    await evaluate("location.href = 'data:text/html,untrusted-navigation'; undefined");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(win.webContents.getURL(), originalUrl, "Untrusted navigation was allowed");
    const stranger = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(repository, "electron/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await stranger.loadFile(path.join(repository, "dist/index.html"));
    const unrelatedWindowBlocked = await stranger.webContents.executeJavaScript(
      "window.missionsDesktop.getConfig().then(() => false, error => /Untrusted IPC sender/.test(error.message))",
    );
    assert.equal(unrelatedWindowBlocked, true, "A different window obtained privileged config access");
    const recoveryBlocked = await stranger.webContents.executeJavaScript(
      "window.missionsDesktop.revealSignerBackup().then(() => false, error => /Untrusted IPC sender/.test(error.message))",
    );
    assert.equal(recoveryBlocked, true, "A different window reached wallet recovery");
    stranger.destroy();
    await evaluate("window.missionsDesktop.openCliWindow()");
    const cli = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("#/cli"));
    assert.ok(cli, "The real CLI window did not load");
    assert.ok(await cli.webContents.executeJavaScript("window.missionsDesktop.getState()"), "CLI IPC was rejected");
    assert.equal(await cli.webContents.executeJavaScript(
      "window.missionsDesktop.revealSignerBackup().then(() => false, error => /Untrusted IPC sender/.test(error.message))",
    ), true, "The recovery API should only be available to the control window");
    const result = { passed: true, actualMainPreloadAndRenderer: true,
      privateSettings: settings, authorizedIpc: true, rendererRendered: true,
      inlineScriptBlocked: true, navigationBlocked: true,
      unrelatedWindowIpcBlocked: true, unrelatedWindowRecoveryBlocked: true,
      cliLoadedAndAuthorized: true, cliRecoveryApiBlocked: true };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    app.exit(0);
  })().catch(error => {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  });
}
