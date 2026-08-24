"use strict";

const { BrowserWindow, session } = require("electron");

const PBP_ORIGIN = "https://pixelbypixel.studio";
const PBP_TIMER_PATH = "/api/user/streams/twitch";
const PBP_SESSION_PATH = "/api/auth/session";
const PBP_SITE_PARTITION = "persist:pbp-site-timers-sample";

let loginWindow = null;

function pbpSiteSession() {
  return session.fromPartition(PBP_SITE_PARTITION);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PBP returned a non-JSON response (HTTP ${response.status})`);
  }
}

async function fetchPbpJson(pathname) {
  const response = await pbpSiteSession().fetch(`${PBP_ORIGIN}${pathname}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await readJson(response);
  return { response, payload };
}

function publicSessionUser(sessionPayload) {
  const user = sessionPayload?.user;
  if (!user || typeof user !== "object") return null;
  return {
    name: String(user.name || user.displayName || "PBP user"),
    image: typeof user.image === "string" ? user.image : null,
  };
}

async function getPbpTimerSessionStatus() {
  try {
    const { response, payload } = await fetchPbpJson(PBP_SESSION_PATH);
    if (!response.ok) {
      return {
        ok: false,
        authenticated: false,
        error: `PBP session check returned HTTP ${response.status}`,
      };
    }
    const user = publicSessionUser(payload);
    return { ok: true, authenticated: Boolean(user), user };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      error: String(error?.message || error),
    };
  }
}

async function fetchPbpTimers() {
  const status = await getPbpTimerSessionStatus();
  if (!status.ok || !status.authenticated) {
    return {
      ...status,
      ok: false,
      error: status.error || "Log in to the PBP website before loading timers.",
    };
  }

  try {
    const { response, payload } = await fetchPbpJson(PBP_TIMER_PATH);
    if (!response.ok) {
      return {
        ok: false,
        authenticated: response.status !== 401 && response.status !== 403,
        user: status.user,
        error: `PBP timer API returned HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      authenticated: true,
      user: status.user,
      fetchedAt: new Date().toISOString(),
      endpoint: PBP_TIMER_PATH,
      timers: payload,
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: true,
      user: status.user,
      error: String(error?.message || error),
    };
  }
}

function openPbpTimerLogin(parentWindow = null) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return Promise.resolve({ ok: true, opened: false, alreadyOpen: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let authenticatedUser = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    loginWindow = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      show: false,
      parent:
        parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      title: "Log in to Pixel by Pixel",
      backgroundColor: "#071018",
      webPreferences: {
        partition: PBP_SITE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });

    const checkForLogin = async () => {
      if (checking || !loginWindow || loginWindow.isDestroyed()) return;
      checking = true;
      try {
        const status = await getPbpTimerSessionStatus();
        if (status.authenticated) {
          authenticatedUser = status.user;
          finish({
            ok: true,
            authenticated: true,
            user: authenticatedUser,
          });
          loginWindow.close();
        }
      } finally {
        checking = false;
      }
    };

    loginWindow.webContents.on("did-finish-load", () => {
      void checkForLogin();
    });
    loginWindow.webContents.on("did-navigate", () => {
      void checkForLogin();
    });
    loginWindow.webContents.on("did-navigate-in-page", () => {
      void checkForLogin();
    });
    loginWindow.once("ready-to-show", () => loginWindow?.show());
    loginWindow.once("closed", () => {
      loginWindow = null;
      finish({
        ok: Boolean(authenticatedUser),
        authenticated: Boolean(authenticatedUser),
        user: authenticatedUser,
        cancelled: !authenticatedUser,
      });
    });

    const callbackUrl = `${PBP_ORIGIN}/missions/play`;
    const signInUrl = `${PBP_ORIGIN}/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;
    loginWindow.loadURL(signInUrl).catch((error) => {
      finish({ ok: false, authenticated: false, error: error.message });
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    });
  });
}

module.exports = {
  fetchPbpTimers,
  getPbpTimerSessionStatus,
  openPbpTimerLogin,
};
