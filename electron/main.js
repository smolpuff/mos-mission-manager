"use strict";

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { app, BrowserWindow, Menu, ipcMain } = require("electron");

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
const maxLogHistory = 1200;
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
  currentMissionStats: null,
  currentMode: null,
  level20ResetEnabled: null,
  missionModeEnabled: null,
  currentMissionResetLevel: null,
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
  backendStatus.currentMissionStats = null;
  backendStatus.currentMode = null;
  backendStatus.level20ResetEnabled = null;
  backendStatus.missionModeEnabled = null;
  backendStatus.currentMissionResetLevel = null;
  backendStatus.fundingWalletSummary = null;
  backendStatus.guiMissionSlots = null;
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
      publishEvent(message);
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

  createSplashWindow();
  await createControlWindow();
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
