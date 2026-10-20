"use strict";

// Exercise the real main process, preload and built React UI in private settings.
// Remote responses and installation/restart are simulated. Never replace the installed app.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const visibleDemo = process.argv.includes("--visible") || process.env.MISSIONS_SETUP_UPDATE_VISIBLE === "1";

if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missions-setup-update-test-"));
  console.log(`Private setup/update test: ${root}`);
  const env = { ...process.env, MISSIONS_SETUP_UPDATE_TEST_ROOT: root, MISSIONS_SETUP_UPDATE_VISIBLE: visibleDemo ? "1" : "0", NODE_ENV: "production" };
  for (const name of ["ELECTRON_RUN_AS_NODE", "PBP_DESKTOP_DEV_MODE", "PBP_STANDALONE_CLI", "VITE_DEV_SERVER_URL"]) delete env[name];
  const log = fs.openSync(path.join(root, "app.log"), "wx");
  const child = spawn(require("electron"), [__filename], { env, windowsHide: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const timeout = setTimeout(() => { child.kill(); console.error("Setup/update test timed out"); }, visibleDemo ? 30 * 60_000 : 60_000);
  child.once("error", error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once("exit", code => {
    clearTimeout(timeout);
    const resultFile = path.join(root, "result.json");
    console.log(fs.readFileSync(fs.existsSync(resultFile) ? resultFile : path.join(root, "app.log"), "utf8"));
    process.exitCode = code || (visibleDemo || fs.existsSync(resultFile) ? 0 : 1);
  });
} else {
  const electron = require("electron");
  const { app, ipcMain } = electron;
  // Never expose simulation dialogs, splash screens or focus changes on the
  // user's desktop. The real renderer still runs and can be captured below.
  const RealBrowserWindow = electron.BrowserWindow;
  class HiddenSimulationWindow extends RealBrowserWindow {
    constructor(options) {
      super({ ...options, show: false,
        webPreferences: { ...options?.webPreferences, offscreen: true } });
    }
    show() {}
    showInactive() {}
    focus() {}
  }
  // Electron's exports are getter-only. Substitute the constructor only for
  // modules loaded by this test, without mutating those exports.
  const Module = require("node:module");
  const originalLoad = Module._load;
  const testElectron = new Proxy(electron, {
    get(target, key) {
      return key === "BrowserWindow" ? HiddenSimulationWindow : target[key];
    },
  });
  if (!visibleDemo) {
    Module._load = function (request, ...args) {
      return request === "electron" ? testElectron : originalLoad.call(this, request, ...args);
    };
    app.whenReady().then(() => app.dock?.hide());
  }
  const root = process.env.MISSIONS_SETUP_UPDATE_TEST_ROOT;
  assert.ok(root, "Launch through npm run test:setup-updates");
  process.on("uncaughtException", error => {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  });
  const home = path.join(root, "home"), appData = path.join(root, "appData");
  const settings = path.join(appData, "missions-v3-mcp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(settings, { recursive: true });
  const configPath = path.join(settings, "config.json");
  const writeConfig = patch => fs.writeFileSync(configPath, JSON.stringify({ missionsAnalyticsEnabled: false, ...patch }));
  const readConfig = () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  os.homedir = () => home;
  app.setPath("appData", appData);
  app.setPath("userData", settings);
  app.setAppLogsPath(path.join(root, "logs"));
  Object.defineProperty(app, "isPackaged", { value: true });
  globalThis.fetch = () => Promise.reject(new Error("Setup/update test: external traffic disabled"));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let competitionQueries = 0, missionSyncMode = "success";
  let checks = 0, checkRequests = 0, installRequests = 0, applyAttempts = 0;
  let updateMode = "offer", installMode = visibleDemo ? "success" : "fail", simulatedRestarts = 0;
  const checker = require("../update-checker");
  checker.checkForUpdates = async ({ currentVersion }) => {
    checks++;
    const mode = updateMode;
    await pause(mode === "late" ? 9500 : 350);
    if (mode === "error") throw new Error("Simulated update check failure");
    return { ok: true, currentVersion, latestVersion: mode === "none" ? currentVersion : "999.0.0",
      updateAvailable: mode !== "none", downloadUrl: "https://example.invalid/test-only.zip",
      notes: ["Simulated update for setup regression test"] };
  };
  const simulateInstall = async function (version) {
    assert.equal(version, "999.0.0");
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true, "Installation incorrectly completed setup");
    this.busy = true;
    this.onStatus({ phase: "downloading", percent: 25 });
    await pause(visibleDemo ? 1500 : 250);
    if (installMode === "fail") {
      this.busy = false;
      this.onStatus({ phase: "error", error: "Simulated download failure" });
      throw new Error("Simulated download failure");
    }
    this.onStatus({ phase: "verifying", percent: 100 });
    await pause(visibleDemo ? 700 : 100);
    this.onStatus({ phase: "restarting", percent: 100 });
    simulatedRestarts++;
    this.busy = false;
    if (visibleDemo) {
      updateMode = "none";
      setTimeout(() => {
        const win = RealBrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes("dist/index.html"));
        win?.reload();
      }, 700);
    }
  };
  require("../mac-updater").MacUpdater.prototype.install = simulateInstall;
  require("../windows-updater").WindowsUpdater.prototype.install = simulateInstall;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, ...args) => {
    // Deliberately exceed the old 300 ms startup timer.
    if (channel === "config:get") await pause(800);
    if (channel === "updates:check") checkRequests++;
    if (channel === "updates:install") installRequests++;
    if (channel === "pbp:get-competition-count") {
      competitionQueries++;
      return { ok: true, total: 123, active: true };
    }
    if (channel === "pbp:get-latest-competition") return { ok: true, competition: null };
    if (channel === "onboarding:fetch-account") {
      await pause(700);
      if (missionSyncMode === "fail") return { ok: false, error: "Simulated mission sync failure" };
      if (missionSyncMode === "empty") return { ok: true, missions: [], missionCatalog: [] };
      return { ok: true, missions: [{ slot: 1, name: "Test Mission", missionId: "test-mission" }], missionCatalog: [] };
    }
    if (channel === "onboarding:apply-selection") {
      applyAttempts++;
      await pause(700);
      if (!visibleDemo && applyAttempts === 1) return { ok: false, error: "Simulated setup save failure" };
    }
    return handler(event, ...args);
  });
  const rendererLoaded = new Promise(resolve => {
    app.on("browser-window-created", (_event, win) => {
      if (!visibleDemo) assert.equal(win.isVisible(), false, "Simulation windows must never be shown");
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on("did-finish-load", () => {
        if (win.webContents.getURL().includes("dist/index.html")) resolve(win);
      });
    });
  });
  require("../main");
  (async () => {
    const win = await rendererLoaded;
    if (visibleDemo) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const contents = await win.webContents.executeJavaScript("document.body.innerText");
        if (contents.includes("Update required") && contents.includes("Step 1/3")) {
          win.show();
          win.focus();
          fs.writeFileSync(path.join(root, "demo-ready.json"), JSON.stringify({
            visible: win.isVisible(), step: "update", privateSettings: settings,
            realUpdatesInstalled: 0, interactive: true,
          }, null, 2));
          console.log("Visible simulation ready. Update now simulates installation and reopens wallet setup.");
          return;
        }
        await pause(50);
      }
      throw new Error("Visible simulation did not reach the update step");
    }
    const evaluate = source => win.webContents.executeJavaScript(source);
    const text = () => evaluate("document.body.innerText");
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 12000;
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
    const noSetup = async () => assert.equal(await evaluate(`document.querySelectorAll('input[name="onboarding_signer_mode"]').length`), 0, "Wallet selection opened before the update decision");
    const assertMandatorySetup = async step => {
      const result = await evaluate(`(() => {
        const dialog = document.querySelector('[data-onboarding-step]');
        const before = dialog.dataset.onboardingStep;
        const hasClose = [...dialog.querySelectorAll('button')].some(button =>
          /close|skip|later|cancel|✕/i.test((button.title || '') + button.textContent));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Simulate another app dialog inserted later in DOM at the normal layer.
        const popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;inset:0;z-index:60';
        document.body.appendChild(popup);
        const aboveOtherDialogs = dialog.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2));
        popup.remove();
        const backgroundButton = [...document.querySelectorAll('button')].find(button => !dialog.contains(button));
        backgroundButton?.focus();
        // Hidden/offscreen windows do not dispatch focus events automatically.
        backgroundButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        const focusContained = dialog.contains(document.activeElement);
        return { before, hasClose, aboveOtherDialogs, focusContained };
      })()`);
      assert.equal(result.before, String(step));
      assert.equal(result.hasClose, false, "Setup exposes a dismissal button");
      assert.equal(result.aboveOtherDialogs, true, "Another dialog can cover setup");
      assert.equal(result.focusContained, true, "Keyboard focus escaped setup");
      await pause(50);
      assert.equal(await evaluate(`document.querySelector('[data-onboarding-step]')?.dataset.onboardingStep`), String(step));
      assert.notEqual(readConfig().firstRunOnboardingCompleted, true);
      assert.equal(competitionQueries, 0, "Competition popup checked before setup finished");
    };
    const reload = async () => {
      const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
      win.reload();
      await loaded;
    };
    const assertStopped = async () => assert.equal((await evaluate("window.missionsDesktop.getState()")).status.running, false);
    await pause(400);
    assert.equal(checkRequests, 0, "Startup queried updates before config finished loading");
    await noSetup();
    await waitFor(async () => (await text()).includes("Update required"), "required update before first-ever setup");
    assert.equal(checks, 1);
    await noSetup();
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true);
    assert.ok((await text()).includes("Step 1/3"));
    assert.equal(await evaluate(`document.querySelectorAll('[role="dialog"]').length`), 1, "Update must use the setup window, not another overlay");
    assert.equal(await evaluate(`document.querySelector('[data-onboarding-step="update"]') !== null`), true);
    assert.ok((await text()).includes("The latest version is required to continue"));
    assert.equal(await evaluate(`document.querySelector('[data-onboarding-step] button[title="Close"]') === null`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button => ['Continue setup', 'Later'].includes(button.textContent.trim()))`), false);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate(`document.querySelector('[data-onboarding-step="update"]') !== null`), true, "Escape bypassed the required update");
    await assertMandatorySetup("update");
    await screenshot("01-update-before-setup.png");
    const invalidInstall = await evaluate('window.missionsDesktop.installUpdate("998.0.0")');
    assert.match(invalidInstall.error, /offer has changed/);
    await click("Update now");
    await waitFor(async () => (await text()).includes("Simulated download failure"), "download failure fallback");
    await noSetup();
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Continue setup')`), false);
    await screenshot("02-download-failure.png");
    installMode = "success";
    await click("Retry update");
    await waitFor(() => simulatedRestarts === 1, "simulated update and restart");
    await noSetup();
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true);
    // Simulate reopening the newer app: the checker now reports no update.
    updateMode = "none";
    await reload();
    await waitFor(async () => (await text()).includes("Step 1/2"), "setup after updated relaunch");
    assert.ok(!(await text()).includes("Update Available"));
    await assertStopped();
    await screenshot("03-setup-after-update.png");
    await assertMandatorySetup(1);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Continue').disabled`), true, "Wallet choice is required");
    await reload();
    await waitFor(async () => (await text()).includes("Step 1/2"), "unfinished setup survives reopening");
    await assertMandatorySetup(1);
    // Complete setup, including failed/empty sync and failed save.
    missionSyncMode = "fail";
    const beforeSetupChecks = checks;
    await evaluate(`document.querySelector('input[name="onboarding_signer_mode"][value="manual"]').click()`);
    await click("Continue");
    await waitFor(async () => (await text()).includes("Step 2/2"), "second setup screen");
    await waitFor(async () => (await text()).includes("Simulated mission sync failure"), "failed sync stays in setup");
    await assertMandatorySetup(2);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Apply').disabled`), true);
    missionSyncMode = "empty";
    await click("Refresh mission status");
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Refresh mission status' && !button.disabled)`), "empty sync completed");
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Apply').disabled`), true, "Empty sync completed setup");
    await assertMandatorySetup(2);
    missionSyncMode = "success";
    await click("Refresh mission status");
    await waitFor(() => evaluate("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Apply' && !el.disabled)"), "mission data ready");
    await assertMandatorySetup(2);
    await click("Apply");
    await waitFor(async () => (await text()).includes("Simulated setup save failure"), "failed setup save");
    assert.notEqual(readConfig().firstRunOnboardingCompleted, true);
    await assertMandatorySetup(2);
    await click("Apply");
    await waitFor(() => readConfig().firstRunOnboardingCompleted === true, "setup saved");
    await pause(500);
    assert.equal(checks, beforeSetupChecks, "Setup completion repeated the startup check");
    assert.equal(readConfig().signerMode, "manual");
    assert.deepEqual(readConfig().targetMissions, ["Test Mission"]);
    await assertStopped();
    await waitFor(() => competitionQueries > 0, "competition checks resume after setup");
    // An unverifiable version cannot bypass the required update step.
    writeConfig({});
    updateMode = "error";
    await reload();
    await waitFor(async () => (await text()).includes("Unable to verify the latest version"), "failed check keeps setup blocked");
    await noSetup();
    assert.ok((await text()).includes("Update required"));
    await screenshot("04-offline-update-retry.png");
    updateMode = "none";
    await click("Retry check");
    await waitFor(async () => (await text()).includes("Step 1/2"), "successful version check releases setup");
    // A timed-out check stays on the required step. A late response must
    // not silently release setup or replace the retry UI.
    updateMode = "late";
    const checksBeforeTimeout = checks;
    await reload();
    await waitFor(() => checks > checksBeforeTimeout, "bounded startup check");
    await waitFor(async () => (await text()).includes("Unable to verify the latest version"), "timeout keeps setup blocked");
    await pause(1800);
    await noSetup();
    assert.ok((await text()).includes("Retry check"));
    await assertStopped();
    updateMode = "none";
    await click("Retry check");
    await waitFor(async () => (await text()).includes("Step 1/2"), "retry after timeout releases setup");
    // Completed installations still check on startup and honor preferences.
    writeConfig({ firstRunOnboardingCompleted: true });
    updateMode = "offer";
    let before = checks;
    await reload();
    await waitFor(async () => (await text()).includes("Update Available"), "existing-user startup check");
    await noSetup();
    assert.equal(checks, before + 1);
    writeConfig({ firstRunOnboardingCompleted: true, autoUpdateCheckEnabled: false });
    before = checks;
    await reload();
    await pause(1700);
    assert.equal(checks, before, "Disabled automatic updates fetched metadata");
    assert.ok(!(await text()).includes("Update Available"));
    const manual = await evaluate("window.missionsDesktop.checkForUpdates({ manual: true })");
    assert.equal(manual.updateAvailable, true, "Manual checks should still work after setup");
    const result = { passed: true, actualMainPreloadAndRenderer: true, privateSettings: settings,
      firstEverLaunchChecksBeforeSetup: true, noUpdateContinuesToSetup: true,
      updateOfferedBeforeSetup: true, updateIsFirstStepInSameSetupWindow: true,
      noExtraUpdateOverlay: true, simulationWindowsHidden: true,
      simulatedUpdateAndRelaunchReturnsToSetup: true,
      downloadFailureBlocksSetupUntilRetrySucceeds: true, updateCannotBeSkippedOrDismissed: true,
      failedCheckBlocksSetupUntilVerified: true, eightSecondTimeoutIgnoresLateOffer: true,
      setupCannotCloseOnAnyStep: true, setupAboveOtherDialogs: true,
      keyboardFocusStaysInSetup: true, unfinishedSetupSurvivesReload: true,
      failedOrEmptyMissionSyncBlocksCompletion: true, competitionChecksWaitForSetup: true,
      failedSetupSaveStaysIncomplete: true, noDuplicateCheckAfterSetup: true,
      autoUpdatePreferenceRespected: true, runnerStayedStopped: true,
      realUpdatesInstalled: 0, simulatedRestarts,
      screenshots: ["01-update-before-setup.png", "02-download-failure.png", "03-setup-after-update.png", "04-offline-update-retry.png"].map(name => path.join(root, name)) };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    app.exit(0);
  })().catch(error => {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  });
}
