"use strict";

const fs = require("fs");
const path = require("path");
const { fork, execFile } = require("child_process");
const { app, BrowserWindow, Menu, ipcMain, clipboard, shell } = require("electron");
const { fetchOnchainFundingWalletSummary } = require("../src/wallet/onchain-summary");
const { scrapeLatestCompetition } = require("./scrapeCompetitions");

const ROOT_DIR = path.resolve(__dirname, "..");
const RENDERER_DEV_URL =
  process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const rendererIndexPath = path.join(ROOT_DIR, "dist", "index.html");
const DESKTOP_DEVTOOLS_ENABLED = process.env.PBP_DESKTOP_DEVTOOLS === "1";

let controlWindow = null;
let cliWindow = null;
let splashWindow = null;
let backend = null;
let stopTimer = null;
let logHistory = [];
const pendingBackendRequests = new Map();
const maxLogHistory = 1200;
const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
const backendStatus = {
  running: false,
  pid: null,
  exitCode: null,
  exitSignal: null,
  signerLocked: null,
  signerReady: null,
  signerMode: null,
  signerWallet: null,
  signerStatus: null,
  isAuthenticated: null,
  watcherRunning: null,
  watchLoopEnabled: null,
  currentUserDisplayName: null,
  currentUserWalletId: null,
  currentUserWalletSummary: null,
  currentMissionStats: null,
  slotUnlockSummary: null,
  currentMode: null,
  level20ResetEnabled: null,
  missionModeEnabled: null,
  currentMissionResetLevel: null,
  sessionRewardTotals: null,
  sessionSpendTotals: null,
  fundingWalletSummary: null,
  guiMissionSlots: null,
  cliWindowOpen: false,
};

function isDev() {
  return !app.isPackaged;
}

function getRendererUrl(hash = "") {
  if (isDev()) {
    return `${RENDERER_DEV_URL}/${hash ? `#${hash}` : ""}`;
  }
  return `${rendererIndexPath}${hash ? `#${hash}` : ""}`;
}

async function loadWindow(win, hash = "") {
  const target = getRendererUrl(hash);
  if (isDev()) {
    await win.loadURL(target);
    return;
  }
  await win.loadFile(rendererIndexPath, { hash });
}

function publish(channel, payload) {
  for (const win of [controlWindow, cliWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function pushOutput(stream, text) {
  const payload = {
    stream,
    text,
    at: Date.now(),
  };
  logHistory.push(payload);
  if (logHistory.length > maxLogHistory) {
    logHistory = logHistory.slice(-maxLogHistory);
  }
  publish("backend:output", payload);
}

function publishStatus() {
  publish("backend:status", { ...backendStatus });
}

function updateBackendStateFromIpc(payload) {
  if (!payload || payload.type !== "pbp_state") return;
  const next = payload.state || {};
  let changed = false;
  for (const key of Object.keys(backendStatus)) {
    if (
      key === "running" ||
      key === "pid" ||
      key === "exitCode" ||
      key === "exitSignal"
    ) {
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(next, key) &&
      backendStatus[key] !== next[key]
    ) {
      backendStatus[key] = next[key];
      changed = true;
    }
  }
  if (changed) publishStatus();
}

function publishEvent(payload) {
  publish("backend:event", payload);
}

function clearStopTimer() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function getBackendWorkingDirectory() {
  return app.isPackaged ? app.getPath("userData") : ROOT_DIR;
}

function getConfigPath() {
  return path.join(getBackendWorkingDirectory(), "config.json");
}

function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function applyDesktopConfigPatch(patch = {}) {
  const next = {
    ...readDesktopConfig(),
    ...patch,
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2));
  return next;
}

function hydrateBackendStatusFromConfig() {
  const config = readDesktopConfig();
  if (typeof config.level20ResetEnabled === "boolean") {
    backendStatus.level20ResetEnabled = config.level20ResetEnabled;
  }
  if (typeof config.missionModeEnabled === "boolean") {
    backendStatus.missionModeEnabled = config.missionModeEnabled;
  }
  if (typeof config.missionResetLevel === "string") {
    backendStatus.currentMissionResetLevel = config.missionResetLevel;
  }
  backendStatus.currentMode = backendStatus.missionModeEnabled
    ? `mission-${backendStatus.currentMissionResetLevel || "11"}`
    : "normal";
}

// Note: MCP `get_wallet_summary` is identity-based (no args) and returns the
// authenticated wallet. For the generated app-wallet funding address we always
// use an on-chain lookup via `fetchOnchainFundingWalletSummary`.

function extractBalanceNumber(balances, matcher) {
  const entries = Array.isArray(balances) ? balances : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const symbol = String(entry.symbol || entry.key || "").trim().toUpperCase();
    const name = String(entry.name || "").trim().toUpperCase();
    if (!matcher({ symbol, name, entry })) continue;
    const raw = entry.displayBalance ?? entry.balance ?? null;
    const n = typeof raw === "string" ? Number(raw.replace(/[, _]/g, "")) : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeWalletBalanceEntries(raw = []) {
  if (Array.isArray(raw)) {
    return raw.filter((entry) => entry && typeof entry === "object");
  }
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([symbol, balance]) => {
    const amount = Number(balance);
    return {
      key: String(symbol || "").trim().toLowerCase(),
      symbol: String(symbol || "").trim().toUpperCase(),
      name: String(symbol || "").trim().toUpperCase(),
      mint: null,
      balance: Number.isFinite(amount) ? amount : null,
      displayBalance: Number.isFinite(amount)
        ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : null,
    };
  });
}

function summarizeWalletPayload(payload) {
  const sc = payload?.structuredContent || {};
  const walletId = sc.walletId || sc.wallet_id || null;
  const displayName = sc.displayName || sc.display_name || null;
  const baseBalances = normalizeWalletBalanceEntries(
    sc.balances || sc.walletBalances || sc.wallet_balances || [],
  );
  const virtualCurrencies =
    sc.virtualCurrencies || sc.virtual_currencies || {};
  const virtualCurrencyBalances = Object.entries(virtualCurrencies)
    .map(([symbol, balance]) => ({
      key: String(symbol || "").trim().toLowerCase(),
      symbol: String(symbol || "").trim().toUpperCase(),
      name: String(symbol || "").trim().toUpperCase(),
      mint: null,
      balance: Number(balance),
      displayBalance: Number(balance).toLocaleString(undefined, {
        maximumFractionDigits: 2,
      }),
    }))
    .filter((entry) => entry.key && Number.isFinite(entry.balance));
  const mergedBalances = [...baseBalances, ...virtualCurrencyBalances];
  const sol = extractBalanceNumber(mergedBalances, ({ symbol, name }) => symbol === "SOL" || name === "SOL");
  const pbp = extractBalanceNumber(mergedBalances, ({ symbol, name }) => symbol === "PBP" || name === "PBP");
  return {
    walletId,
    displayName,
    fundingWalletSummary: {
      address: sc.walletAddress || sc.wallet_address || null,
      sol,
      pbp,
      status: "ok",
      source: "mcp",
    },
  };
}

function installMinimalApplicationMenu() {
  const template = isDev()
    ? [
        ...(process.platform === "darwin"
          ? [
              {
                label: app.name,
                submenu: [
                  { role: "about" },
                  { type: "separator" },
                  { role: "services" },
                  { type: "separator" },
                  { role: "hide" },
                  { role: "hideOthers" },
                  { role: "unhide" },
                  { type: "separator" },
                  { role: "quit" },
                ],
              },
            ]
          : []),
        {
          label: "File",
          submenu: [
            ...(process.platform === "darwin"
              ? [{ role: "close" }]
              : [{ role: "quit" }]),
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { type: "separator" },
            { role: "toggleDevTools" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            ...(process.platform === "darwin"
              ? [{ type: "separator" }, { role: "front" }, { role: "window" }]
              : [{ role: "close" }]),
          ],
        },
      ]
    : process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "File",
            submenu: [{ role: "close" }],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Window",
            submenu: [
              { role: "minimize" },
              { role: "close" },
              { type: "separator" },
              { role: "front" },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [{ role: "quit" }],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
          },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenWindow(win) {
  const hideMenuBar = !isDev();
  if (typeof win.setMenuBarVisibility === "function") {
    win.setMenuBarVisibility(!hideMenuBar);
  }
  if (typeof win.setAutoHideMenuBar === "function") {
    win.setAutoHideMenuBar(hideMenuBar);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (!isDev()) {
    win.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      const blockedDevtools =
        key === "f12" ||
        ((input.control || input.meta) &&
          input.shift &&
          (key === "i" || key === "j" || key === "c"));
      const blockedReload =
        key === "f5" || ((input.control || input.meta) && key === "r");
      if (blockedDevtools || blockedReload) {
        event.preventDefault();
      }
    });
    win.webContents.on("context-menu", (event) => {
      event.preventDefault();
    });
  }
}

function startBackend() {
  if (backendStatus.running && backend) {
    return { ...backendStatus };
  }

  logHistory = [];
  backend = fork(path.join(ROOT_DIR, "app.js"), ["--plain-output"], {
    cwd: getBackendWorkingDirectory(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PBP_GUI_BRIDGE: "1",
      PBP_CONFIG_DIR: getBackendWorkingDirectory(),
      FORCE_COLOR: "0",
    },
    silent: true,
  });

  backendStatus.running = true;
  backendStatus.pid = backend.pid;
  backendStatus.exitCode = null;
  backendStatus.exitSignal = null;
  backendStatus.signerLocked = null;
  backendStatus.signerReady = null;
  backendStatus.signerMode = null;
  backendStatus.signerWallet = null;
  backendStatus.signerStatus = null;
  backendStatus.isAuthenticated = null;
  backendStatus.watcherRunning = null;
  backendStatus.watchLoopEnabled = null;
  backendStatus.currentUserDisplayName = null;
  backendStatus.currentUserWalletId = null;
  backendStatus.currentUserWalletSummary = null;
  backendStatus.currentMissionStats = null;
  backendStatus.currentMode = null;
  backendStatus.level20ResetEnabled = null;
  backendStatus.missionModeEnabled = null;
  backendStatus.currentMissionResetLevel = null;
  backendStatus.sessionRewardTotals = null;
  backendStatus.sessionSpendTotals = null;
  backendStatus.fundingWalletSummary = null;
  backendStatus.guiMissionSlots = null;
  backendStatus.slotUnlockSummary = null;
  publishStatus();
  pushOutput("system", "[GUI] Backend started.\n");

  backend.stdout.on("data", (chunk) => {
    pushOutput("stdout", chunk.toString("utf8"));
  });

  backend.stderr.on("data", (chunk) => {
    pushOutput("stderr", chunk.toString("utf8"));
  });

  backend.on("message", (message) => {
    updateBackendStateFromIpc(message);
    if (message && message.type === "pbp_event") {
      if (message.event === "app_quit") {
        try {
          stopBackend();
        } catch {}
        // Quit the entire desktop app (not just the backend runner).
        setTimeout(() => {
          try {
            app.quit();
          } catch {}
        }, 50);
        return;
      }
      publishEvent(message);
    }
    if (message && message.type === "pbp_response") {
      const requestId = String(message.requestId || "");
      const pending = requestId ? pendingBackendRequests.get(requestId) : null;
      if (pending) {
        pendingBackendRequests.delete(requestId);
        try {
          pending.resolve(message.payload);
        } catch {}
      }
    }
  });

  backend.on("exit", (code, signal) => {
    clearStopTimer();
    backendStatus.running = false;
    backendStatus.pid = null;
    backendStatus.exitCode = code;
    backendStatus.exitSignal = signal;
    backendStatus.currentMissionStats = null;
    backendStatus.guiMissionSlots = null;
    backendStatus.slotUnlockSummary = null;
    backend = null;
    pushOutput(
      "system",
      `[GUI] Backend exited (code=${code ?? "null"}, signal=${signal ?? "null"}).\n`,
    );
    publishStatus();
  });

  backend.on("error", (error) => {
    pushOutput("stderr", `[GUI] Backend error: ${error.message}\n`);
  });

  return { ...backendStatus };
}

function stopBackend() {
  if (!backend || !backendStatus.running) {
    return { ...backendStatus };
  }

  pushOutput("system", "[GUI] Stopping backend...\n");
  backendStatus.currentMissionStats = null;
  backendStatus.guiMissionSlots = null;
  backendStatus.slotUnlockSummary = null;
  publishStatus();
  backend.kill("SIGTERM");
  clearStopTimer();
  stopTimer = setTimeout(() => {
    if (backend && backendStatus.running) {
      pushOutput(
        "system",
        "[GUI] Backend did not exit in time; forcing stop.\n",
      );
      backend.kill("SIGKILL");
    }
  }, 4000);
  return { ...backendStatus };
}

function sendBackendCommand(command) {
  const trimmed = String(command || "").trim();
  if (!backend || !backendStatus.running) {
    throw new Error("Backend is not running.");
  }
  if (!trimmed) {
    throw new Error("Command is empty.");
  }
  backend.stdin.write(`${trimmed}\n`);
  pushOutput("stdin", `> ${trimmed}\n`);
  return true;
}

async function requestBackend(action, payload = {}, options = {}) {
  const ensureRunning = options?.ensureRunning === true;
  if ((!backend || !backendStatus.running) && ensureRunning) {
    startBackend();
  }
  if (!backend || !backendStatus.running) {
    throw new Error("Backend is not running.");
  }
  const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBackendRequests.delete(requestId);
      reject(new Error(`backend request timeout: ${action}`));
    }, timeoutMs);
    pendingBackendRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    backend.send({ type: "pbp_request", requestId, action, payload });
  });
}

async function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 800,
    height: 800,
    minWidth: 800,
    minHeight: 800,
    maxWidth: 800,
    maxHeight: 800,
    title: "missions-v3-mcp",
    backgroundColor: "#0b1116",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -100, y: -100 },
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DESKTOP_DEVTOOLS_ENABLED,
    },
  });

  controlWindow.on("closed", () => {
    controlWindow = null;
  });

  hardenWindow(controlWindow);
  await loadWindow(controlWindow);
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 800,
    height: 800,
    // above resized from 8x8
    minWidth: 800,
    minHeight: 800,
    maxWidth: 800,
    maxHeight: 800,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#0b1116",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashBgCandidates = [
    path.join(ROOT_DIR, "renderer", "src", "img", "back.png"),
    ...(() => {
      const assetsDir = path.join(ROOT_DIR, "dist", "assets");
      if (!fs.existsSync(assetsDir)) return [];
      try {
        return fs
          .readdirSync(assetsDir)
          .filter((name) => /^back-.*\.png$/i.test(name))
          .map((name) => path.join(assetsDir, name));
      } catch {
        return [];
      }
    })(),
  ];
  let splashBgDataUrl = "";
  for (const candidate of splashBgCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const b64 = fs.readFileSync(candidate).toString("base64");
      splashBgDataUrl = `data:image/png;base64,${b64}`;
      break;
    } catch {}
  }

  const splashHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background-color: #0b1116;
        ${splashBgDataUrl ? `background-image: url("${splashBgDataUrl}");` : ""}
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        color: #cfe6f5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wrap {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        opacity: 0.92;
      }
      .spinner {
        width: 20px;
        height: 20px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.18);
        border-top-color: rgba(127, 191, 233, 0.95);
        animation: spin 700ms linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="row">
        <div class="spinner"></div>
        <div>Loading missions...</div>
      </div>
    </div>
  </body>
</html>`;

  splashWindow.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`,
  );
}

async function createCliWindow() {
  if (cliWindow && !cliWindow.isDestroyed()) {
    backendStatus.cliWindowOpen = true;
    publishStatus();
    publishEvent({ type: "cli_window_state", open: true });
    cliWindow.focus();
    return;
  }

  cliWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 720,
    minHeight: 520,
    title: "missions-v3-mcp CLI",
    backgroundColor: "#061017",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -100, y: -100 },
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DESKTOP_DEVTOOLS_ENABLED,
    },
  });

  cliWindow.on("closed", () => {
    cliWindow = null;
    backendStatus.cliWindowOpen = false;
    publishStatus();
    publishEvent({ type: "cli_window_state", open: false });
  });

  hardenWindow(cliWindow);
  backendStatus.cliWindowOpen = true;
  publishStatus();
  publishEvent({ type: "cli_window_state", open: true });
  await loadWindow(cliWindow, "/cli");
}

app.whenReady().then(async () => {
  installMinimalApplicationMenu();
  ipcMain.handle("backend:start", async () => startBackend());
  ipcMain.handle("backend:stop", async () => stopBackend());
  ipcMain.handle("backend:send-command", async (_event, command) =>
    sendBackendCommand(command),
  );
  ipcMain.handle("backend:get-state", async () => ({
    status: { ...backendStatus },
    logs: logHistory,
  }));
  ipcMain.handle("config:get", async () => ({
    config: readDesktopConfig(),
  }));
  ipcMain.handle("config:update", async (_event, patch) => {
    const next = applyDesktopConfigPatch(patch || {});
    if (typeof next.level20ResetEnabled === "boolean") {
      backendStatus.level20ResetEnabled = next.level20ResetEnabled;
    }
    if (typeof next.missionModeEnabled === "boolean") {
      backendStatus.missionModeEnabled = next.missionModeEnabled;
    }
    if (typeof next.missionResetLevel === "string") {
      backendStatus.currentMissionResetLevel = next.missionResetLevel;
    }
    if (next.currentUserWalletSummary !== undefined) {
      backendStatus.currentUserWalletSummary = next.currentUserWalletSummary;
    }
    if (next.sessionRewardTotals !== undefined) {
      backendStatus.sessionRewardTotals = next.sessionRewardTotals;
    }
    backendStatus.currentMode = backendStatus.missionModeEnabled
      ? `mission-${backendStatus.currentMissionResetLevel || "11"}`
      : "normal";
    publishStatus();
    return { config: next, status: { ...backendStatus } };
  });
  ipcMain.handle("wallet:refresh-summary", async () => {
    const config = readDesktopConfig();
    const walletAddress =
      String(config?.signer?.walletAddress || config?.signer?.wallet || "").trim() ||
      String(config?.walletAddress || "").trim() ||
      null;
    if (!walletAddress) {
      backendStatus.fundingWalletSummary = null;
      backendStatus.signerMode = config.signerMode || backendStatus.signerMode;
      publishStatus();
      return { walletId: null, displayName: null, fundingWalletSummary: null };
    }
    try {
      const rpcSummary = await fetchOnchainFundingWalletSummary(walletAddress);
      const summary = {
        walletId: null,
        displayName: null,
        fundingWalletSummary: rpcSummary,
      };
      backendStatus.signerMode = config.signerMode || backendStatus.signerMode;
      backendStatus.fundingWalletSummary = summary.fundingWalletSummary;
      publishStatus();
      return summary;
    } catch (error) {
      // Don't crash the renderer on RPC rate limits; keep the last known good summary.
      publishStatus();
      return {
        walletId: null,
        displayName: null,
        fundingWalletSummary: backendStatus.fundingWalletSummary || null,
        error: String(error?.message || error),
      };
    }
  });
  ipcMain.handle("signer:reveal-backup", async () => {
    const payload = await requestBackend("signer_reveal_backup", {}, {
      ensureRunning: true,
      timeoutMs: 12000,
    });
    return payload;
  });
  ipcMain.handle("signer:create-generated-wallet", async () => {
    const payload = await requestBackend("signer_create_generated_wallet", {});
    return payload;
  });
  ipcMain.handle("slot:prepare-unlock4", async () => {
    const payload = await requestBackend("prepare_slot4_unlock", {}, {
      ensureRunning: true,
      timeoutMs: 15000,
    });
    return payload;
  });
  ipcMain.handle("clipboard:copy", async (_event, text) => {
    const value = String(text || "");
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle("external:open", async (_event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("Invalid external URL.");
    }
    await shell.openExternal(target);
    return true;
  });
  ipcMain.handle("window:open-cli", async () => {
    await createCliWindow();
    return true;
  });
  ipcMain.handle("window:is-cli-open", async () => {
    return Boolean(cliWindow && !cliWindow.isDestroyed());
  });
  ipcMain.handle("window:minimize", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
    return true;
  });
  ipcMain.handle("window:close", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close();
    }
    return true;
  });

  ipcMain.handle("pbp:get-latest-competition", async (_event, opts = {}) => {
    try {
      const competition = await scrapeLatestCompetition(opts || {});
      return { ok: true, competition };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  createSplashWindow();
  hydrateBackendStatusFromConfig();
  publishStatus();
  await createControlWindow();
  try {
    const launchConfig = readDesktopConfig();
    const walletAddress =
      String(launchConfig?.signer?.walletAddress || launchConfig?.signer?.wallet || "").trim() ||
      String(launchConfig?.walletAddress || "").trim() ||
      null;
    if (launchConfig.signerMode) {
      backendStatus.signerMode = launchConfig.signerMode;
    }
    // One-time funding wallet load at desktop startup (do not poll).
    if (walletAddress) {
      try {
        backendStatus.fundingWalletSummary =
          await fetchOnchainFundingWalletSummary(walletAddress);
      } catch {
        // Keep it null; the user can trigger refresh later (or it will refresh
        // after token-affecting actions).
        backendStatus.fundingWalletSummary = null;
      }
    } else {
      backendStatus.fundingWalletSummary = null;
    }
    publishStatus();
  } catch {}
  const closeSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();
  };
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.once("ready-to-show", closeSplash);
    controlWindow.webContents.once("dom-ready", closeSplash);
    setTimeout(closeSplash, 1800);
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createControlWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
