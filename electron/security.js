"use strict";

const { pathToFileURL } = require("node:url");

function createRendererSecurity({ rendererPath, devServerUrl, isDev = false, getWindows }) {
  const rendererUrl = pathToFileURL(rendererPath);
  let devUrl;
  if (isDev) {
    devUrl = new URL(devServerUrl);
    if (!["http:", "https:"].includes(devUrl.protocol) || devUrl.username || devUrl.password) {
      throw new Error("Invalid renderer development server URL");
    }
  }

  function isTrustedUrl(value) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search) return false;
      // Hash routing is allowed; other files and other pages on the dev server are not.
      url.hash = "";
      if (url.href === rendererUrl.href) return true;
      return Boolean(devUrl && url.origin === devUrl.origin &&
        url.pathname === (devUrl.pathname.endsWith("/") ? devUrl.pathname : `${devUrl.pathname}/`));
    } catch { return false; }
  }

  function assertTrustedSender(event, { controlOnly = false } = {}) {
    const windows = getWindows();
    const allowed = controlOnly ? windows.slice(0, 1) : windows;
    if (!event?.sender || event.sender.isDestroyed() ||
        !allowed.some(win => win && !win.isDestroyed() && win.webContents === event.sender) ||
        !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
        !isTrustedUrl(event.senderFrame.url) || !isTrustedUrl(event.sender.getURL())) {
      throw new Error("Untrusted IPC sender");
    }
  }

  function registerHandler(ipcMain, channel, handler, options) {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, options);
      return handler(event, ...args);
    });
  }

  function hardenNavigation(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    // The app never embeds other pages or webviews in its privileged renderer.
    win.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame || !isTrustedUrl(event.url)) event.preventDefault();
    });
    win.webContents.on("will-attach-webview", event => event.preventDefault());
  }

  const connectSources = devUrl
    ? `${devUrl.origin} ${devUrl.protocol === "https:" ? "wss:" : "ws:"}//${devUrl.host}`
    : "'none'";
  const contentSecurityPolicy = [
    "default-src 'none'",
    devUrl ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // React and the existing UI use style attributes; executable inline script stays blocked.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: http:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  function installContentSecurityPolicy(session) {
    session.webRequest.onHeadersReceived((details, callback) => {
      if (!isTrustedUrl(details.url) || details.resourceType !== "mainFrame") {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = { ...details.responseHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "content-security-policy") delete headers[name];
      }
      callback({ responseHeaders: { ...headers, "Content-Security-Policy": [contentSecurityPolicy] } });
    });
  }

  return { isTrustedUrl, assertTrustedSender, registerHandler, hardenNavigation,
    contentSecurityPolicy, installContentSecurityPolicy };
}

module.exports = { createRendererSecurity };
