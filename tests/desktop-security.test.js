"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { createRendererSecurity } = require("../electron/security");

function fixture(isDev = false) {
  const rendererPath = path.resolve("dist/index.html");
  const url = pathToFileURL(rendererPath).href;
  function window(hash = "") {
    const contents = Object.assign(new EventEmitter(), {
      mainFrame: { url: url + hash }, isDestroyed: () => false,
      getURL() { return this.mainFrame.url; },
      setWindowOpenHandler(handler) { this.openHandler = handler; },
    });
    return { isDestroyed: () => false, webContents: contents };
  }
  const control = window(), cli = window("#/cli"), stranger = window();
  const security = createRendererSecurity({ rendererPath, isDev,
    devServerUrl: "http://127.0.0.1:5179", getWindows: () => [control, cli] });
  const event = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { security, control, cli, stranger, event, url };
}

test("privileged IPC accepts only known windows at the exact app page, in the main frame", () => {
  const { security, control, cli, stranger, event, url } = fixture();
  assert.doesNotThrow(() => security.assertTrustedSender(event(control)));
  assert.doesNotThrow(() => security.assertTrustedSender(event(cli)));
  for (const invalid of [event(stranger), {}, { ...event(control), senderFrame: null },
    { ...event(control), senderFrame: { url } }]) {
    assert.throws(() => security.assertTrustedSender(invalid), /Untrusted IPC/);
  }
  assert.throws(() => security.assertTrustedSender(event(cli), { controlOnly: true }), /Untrusted IPC/);
  for (const maliciousUrl of ["https://example.com/", "about:blank", "data:text/html,test",
    pathToFileURL(path.resolve("dist/other.html")).href, url + "?injected=true"]) {
    control.webContents.mainFrame.url = maliciousUrl;
    assert.throws(() => security.assertTrustedSender(event(control)), /Untrusted IPC/);
  }
  control.webContents.mainFrame.url = url;
  control.webContents.isDestroyed = () => true;
  assert.throws(() => security.assertTrustedSender(event(control)), /Untrusted IPC/);
});

test("IPC authorization runs before a privileged handler can touch secrets", () => {
  const { security, control, stranger, event } = fixture();
  let handler, calls = 0;
  security.registerHandler({ handle(_name, callback) { handler = callback; } }, "reveal", () => { calls++; return "test secret"; }, { controlOnly: true });
  assert.throws(() => handler(event(stranger)), /Untrusted IPC/);
  assert.equal(calls, 0);
  assert.equal(handler(event(control)), "test secret");
  assert.equal(calls, 1);
});

test("navigation blocks other pages, redirects, subframes, popups and webviews", () => {
  const { security, control, url } = fixture();
  security.hardenNavigation(control);
  assert.deepEqual(control.webContents.openHandler({ url }), { action: "deny" });
  for (const name of ["will-navigate", "will-redirect"]) {
    let prevented = false;
    control.webContents.emit(name, { preventDefault() { prevented = true; } }, "https://example.com");
    assert.equal(prevented, true);
    prevented = false;
    control.webContents.emit(name, { preventDefault() { prevented = true; } }, url + "#/cli");
    assert.equal(prevented, false);
  }
  for (const [name, details] of [["will-frame-navigate", { isMainFrame: false, url }],
    ["will-frame-navigate", { isMainFrame: true, url: "https://example.com" }], ["will-attach-webview", {}]]) {
    let prevented = false;
    control.webContents.emit(name, { ...details, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test("production policy blocks inline/remote scripts, connections and embedding; dev trust is narrow", () => {
  const { security } = fixture();
  assert.match(security.contentSecurityPolicy, /script-src 'self';/);
  assert.match(security.contentSecurityPolicy, /connect-src 'none';/);
  assert.match(security.contentSecurityPolicy, /frame-src 'none';/);
  const dev = fixture(true).security;
  assert.equal(dev.isTrustedUrl("http://127.0.0.1:5179/#/cli"), true);
  for (const url of ["http://127.0.0.1:5179/other.html", "http://127.0.0.1:5180/", "http://localhost:5179/", "http://127.0.0.1:5179/?x=1"]) {
    assert.equal(dev.isTrustedUrl(url), false);
  }
  assert.equal(security.isTrustedUrl("http://127.0.0.1:5179/"), false);
  assert.match(dev.contentSecurityPolicy, /connect-src http:\/\/127.0.0.1:5179 ws:\/\/127.0.0.1:5179/);
});

test("the app page receives the enforced policy without applying it to scraper pages", () => {
  const { security, url } = fixture();
  let receive;
  security.installContentSecurityPolicy({ webRequest: { onHeadersReceived(callback) { receive = callback; } } });
  let result;
  receive({ url, resourceType: "mainFrame", responseHeaders: { "content-security-policy": ["script-src *"], Other: ["kept"] } }, value => { result = value; });
  assert.equal(result.responseHeaders["content-security-policy"], undefined);
  assert.deepEqual(result.responseHeaders["Content-Security-Policy"], [security.contentSecurityPolicy]);
  assert.deepEqual(result.responseHeaders.Other, ["kept"]);
  const headers = { Existing: ["unchanged"] };
  receive({ url: "https://pixelbypixel.studio/missions/competitions", resourceType: "mainFrame", responseHeaders: headers }, value => { result = value; });
  assert.equal(result.responseHeaders, headers);
});
