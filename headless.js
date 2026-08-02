"use strict";

const { BrowserWindow, session } = require("electron");

function waitForNavigationDone(win, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error("headless window timed out"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try {
        win.webContents.removeListener("dom-ready", done);
        win.webContents.removeListener("did-stop-loading", done);
        win.webContents.removeListener("did-finish-load", done);
        win.webContents.removeListener("did-fail-load", onFailLoad);
      } catch {}
    };

    const onFailLoad = (_event, errorCode, errorDescription) => {
      fail(new Error(`headless window failed to load: ${errorCode} ${errorDescription}`));
    };

    // If content is already ready (rare but possible), resolve immediately.
    try {
      if (win.webContents.isLoadingMainFrame && !win.webContents.isLoadingMainFrame()) {
        done();
        return;
      }
    } catch {}

    win.webContents.once("dom-ready", done);
    win.webContents.once("did-stop-loading", done);
    win.webContents.once("did-finish-load", done);
    win.webContents.once("did-fail-load", onFailLoad);
  });
}

async function withHeadlessWindow(
  url,
  {
    timeoutMs = 25_000,
    blockResources = true,
    partition = "persist:pbp-scrape",
    preserveStorage = true,
  } = {},
  fn,
) {
  if (typeof fn !== "function") {
    throw new Error("withHeadlessWindow requires a function callback");
  }

  const partitionName = String(partition || "").trim() || "persist:pbp-scrape";
  const winSession = session.fromPartition(partitionName);

  const resourceBlocker = (details, callback) => {
    const type = String(details?.resourceType || "").toLowerCase();
    const block = ["image", "media", "font", "stylesheet"].includes(type);
    callback({ cancel: block });
  };

  if (blockResources) {
    winSession.webRequest.onBeforeRequest(resourceBlocker);
  }

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: "#0b1116",
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  try {
    // Avoid wasting resources rendering / running animations in background.
    try {
      win.setSkipTaskbar(true);
      win.webContents.setBackgroundThrottling(true);
    } catch {}

    const navDone = waitForNavigationDone(win, timeoutMs);
    await win.loadURL(url);
    await navDone;
    return await fn(win);
  } finally {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {}
    try {
      if (blockResources) {
        winSession.webRequest.onBeforeRequest(null);
      }
      if (!preserveStorage) {
        await winSession.clearStorageData();
        await winSession.clearCache();
      }
    } catch {}
  }
}

module.exports = {
  withHeadlessWindow,
};
