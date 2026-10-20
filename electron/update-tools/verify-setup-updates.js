"use strict";

// Exercise the real main process, preload and built React UI in private settings.
// Only remote account/update responses are simulated. Never install an update.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missions-setup-update-test-"));
  console.log(`Private setup/update test: ${root}`);
  const env = { ...process.env, MISSIONS_SETUP_UPDATE_TEST_ROOT: root, NODE_ENV: "production" };
  for (const name of ["ELECTRON_RUN_AS_NODE", "PBP_DESKTOP_DEV_MODE", "PBP_STANDALONE_CLI", "VITE_DEV_SERVER_URL"]) delete env[name];
  const log = fs.openSync(path.join(root, "app.log"), "wx");
  const child = spawn(require("electron"), [__filename], { env, windowsHide: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const timeout = setTimeout(() => { child.kill(); console.error("Setup/update test timed out"); }, 60000);
  child.once("error", error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once("exit", code => {
    clearTimeout(timeout);
    const resultFile = path.join(root, "result.json");
    console.log(fs.readFileSync(fs.existsSync(resultFile) ? resultFile : path.join(root, "app.log"), "utf8"));
    process.exitCode = code || (fs.existsSync(resultFile) ? 0 : 1);
  });
} else {
  const { app, ipcMain } = require("electron");
  const root = process.env.MISSIONS_SETUP_UPDATE_TEST_ROOT;
  assert.ok(root, "Launch through npm run test:setup-updates");
  const home = path.join(root, "home"), appData = path.join(root, "appData");
  const settings = path.join(appData, "missions-v3-mcp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(settings, { recursive: true });
  const configPath = path.join(settings, "config.json");
  const writeConfig = patch => fs.writeFileSync(configPath, JSON.stringify({ missionsAnalyticsEnabled: false, ...patch }));
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  writeConfig({});
  os.homedir = () => home;
  app.setPath("appData", appData);
  app.setPath("userData", settings);
  app.setAppLogsPath(path.join(root, "logs"));
  Object.defineProperty(app, "isPackaged", { value: true });
  globalThis.fetch = () => Promise.reject(new Error("Setup/update test: external traffic disabled"));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let checks = 0, checkRequests = 0, installRequests = 0, applyAttempts = 0;
  const checker = require("../update-checker");
  checker.checkForUpdates = async ({ currentVersion }) => {
    checks++;
    return { ok: true, currentVersion, latestVersion: "999.0.0", updateAvailable: true,
      downloadUrl: "https://example.invalid/test-only.zip", notes: ["Simulated update for setup regression test"] };
  };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, ...args) => {
    // Deliberately exceed the old 300 ms startup timer.
    if (channel === "config:get") await pause(800);
    if (channel === "updates:check") checkRequests++;
    if (channel === "updates:install") installRequests++;
    if (channel === "onboarding:fetch-account") {
      await pause(700);
      return { ok: true, missions: [{ slot: 1, name: "Test Mission", missionId: "test-mission" }], missionCatalog: [] };
    }
    if (channel === "onboarding:apply-selection") {
      applyAttempts++;
      await pause(700);
      if (applyAttempts === 1) return { ok: false, error: "Simulated setup save failure" };
    }
    return handler(event, ...args);
  });
  const rendererLoaded = new Promise(resolve => {
    app.on("browser-window-created", (_event, win) => {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on("did-finish-load", () => {
        if (win.webContents.getURL().includes("dist/index.html")) resolve(win);
      });
    });
  });
  require("../main");
  (async () => {
    const win = await rendererLoaded;
    const evaluate = source => win.webContents.executeJavaScript(source);
    const text = () => evaluate("document.body.innerText");
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await pause(50);
      }
      throw new Error(`Timed out: ${label}\n${await text()}`);
    };
    const click = label => evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) throw new Error('Missing/enabled button: ' + ${JSON.stringify(label)});
      button.click();
    })()`);
    const screenshot = async name => {
      await pause(300); // Allow React changes to paint before capturing visual evidence.
      fs.writeFileSync(path.join(root, name), (await win.webContents.capturePage()).toPNG());
    };
    await pause(400);
    assert.equal(checkRequests, 0, "Startup queried updates before config finished loading");
    await waitFor(async () => (await text()).includes("Step 1/2"), "first setup screen");
    await pause(500);
    assert.equal(checkRequests, 0, "Startup queried updates during setup");
    for (const manual of [false, true]) {
      const result = await evaluate(`window.missionsDesktop.checkForUpdates({ manual: ${manual} })`);
      assert.equal(result.reason, "setup_incomplete");
      assert.equal(result.updateAvailable, false);
    }
    const install = await evaluate('window.missionsDesktop.installUpdate("999.0.0")');
    assert.match(install.error, /Finish initial setup/);
    assert.equal(checks, 0, "The main process fetched update metadata during setup");
    const initialRequests = checkRequests;
    await screenshot("01-setup-no-update.png");
    await evaluate(`document.querySelector('input[name="onboarding_signer_mode"][value="manual"]').click()`);
    await click("Continue");
    await waitFor(async () => (await text()).includes("Step 2/2"), "second setup screen");
    await waitFor(() => evaluate("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Apply' && !el.disabled)"), "mission data ready");
    assert.equal(checkRequests, initialRequests, "Updates ran while selecting missions");
    await click("Apply");
    await waitFor(async () => (await text()).includes("Simulated setup save failure"), "failed setup save");
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true, "Failed setup was persisted as complete");
    assert.equal(checkRequests, initialRequests, "Failed setup unlocked updates");
    await click("Apply");
    await pause(350);
    assert.equal(checkRequests, initialRequests, "Updates ran while setup was still saving");
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true);
    await waitFor(async () => (await text()).includes("Update Available"), "deferred update after successful setup");
    assert.equal(readConfig().firstRunOnboardingCompleted, true);
    assert.equal(readConfig().signerMode, "manual");
    assert.deepEqual(readConfig().targetMissions, ["Test Mission"]);
    assert.equal(checks, 1, "Expected exactly one deferred startup check");
    assert.ok(!(await text()).includes("Step 2/2"));
    assert.equal((await evaluate("window.missionsDesktop.getState()")).status.running, false);
    await screenshot("02-setup-complete-update-offered.png");
    // Reload with completed setup: startup updates must still work.
    const reload = async () => {
      const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
      win.reload();
      await loaded;
    };
    await reload();
    await waitFor(() => checks === 2, "normal startup update check");
    assert.ok(!(await text()).includes("Step 1/2"));
    await pause(500);
    assert.equal(checks, 2, "Startup issued duplicate checks");
    // Respect the existing automatic-update preference after setup.
    writeConfig({ firstRunOnboardingCompleted: true, autoUpdateCheckEnabled: false });
    await reload();
    await pause(1700);
    assert.equal(checks, 2, "Disabled automatic updates fetched metadata");
    assert.ok(!(await text()).includes("Update Available"));
    const manual = await evaluate("window.missionsDesktop.checkForUpdates({ manual: true })");
    assert.equal(manual.updateAvailable, true, "Manual checks should still work after setup");
    // The existing Close action explicitly skips setup and should release the check.
    writeConfig({});
    const beforeClose = checks;
    await reload();
    await waitFor(async () => (await text()).includes("Step 1/2"), "setup for explicit dismissal");
    await pause(400);
    assert.equal(checks, beforeClose);
    await evaluate("document.querySelector('[role=dialog] button[title=Close]').click()");
    await waitFor(() => checks === beforeClose + 1, "update after explicit setup dismissal");
    assert.equal(readConfig().firstRunOnboardingCompleted, true);
    assert.equal(installRequests, 1, "Only the rejected install probe should have run");
    const result = { passed: true, actualMainPreloadAndRenderer: true, privateSettings: settings,
      slowConfigBlocksChecks: true, bothSetupStepsBlockChecks: true,
      manualCheckAndInstallBlockedDuringSetup: true, failedSaveKeepsUpdatesBlocked: true,
      successfulSetupSavesBeforeSingleUpdateCheck: true, normalStartupChecks: true,
      autoUpdatePreferenceRespected: true, explicitSetupDismissalReleasesCheck: true,
      screenshots: ["01-setup-no-update.png", "02-setup-complete-update-offered.png"].map(name => path.join(root, name)) };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    app.exit(0);
  })().catch(error => {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  });
}
