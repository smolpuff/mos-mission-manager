"use strict";

// TEMP_AUTH_DIAGNOSTICS: remove with the temporary diagnostic instrumentation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const diagnostics = require("./auth-diagnostics");
const mcp = require("./mcp");
const { createMcpClient } = require("../src/mcp/client");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pbp-auth-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token.json");
  const logFile = path.join(directory, "pbp-auth-debug.log");
  diagnostics.configureAuthDiagnostics(tokenFile, { logFile });
  return { directory, tokenFile, logFile,
    log: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
    entries: () => fs.readFileSync(logFile, "utf8").split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).flatMap(entry => entry.events || [entry]) };
}

test("the incident includes context, real OAuth errors and later recovery without leaking credentials", async t => {
  const s = fixture(t);
  const access = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ iat: 10, exp: 910, sid: "private-session" })).toString("base64url")}.signature123`;
  const refresh = "opaque-refresh-token-diagnostic-fixture";
  fs.writeFileSync(s.tokenFile, JSON.stringify({ access_token: access, refresh_token: refresh, client_id: "public-client", expires_at: "2026-10-20T00:00:00Z" }));
  diagnostics.authRuntime(s.tokenFile, { logFile: s.logFile, role: "test" });
  diagnostics.authEvent(s.tokenFile, "token.check", { credentials: diagnostics.tokenFileSummary(s.tokenFile) });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant", error_description: `The stored grant is invalid: ${refresh}`, registration_access_token: "registration-secret" }, {
    status: 400, headers: { "x-request-id": "provider-request-123", "retry-after": "30" },
  }));
  const response = await diagnostics.authFetch("https://example.invalid/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${access}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_secret: "client-secret" }).toString(),
  }, { tokenFile: s.tokenFile, step: "oauth.refresh_token" });
  diagnostics.authResponse(response, await response.text());
  const error = new Error(`request failed using ${access}`);
  error.cause = Object.assign(new Error(`socket closed: ${refresh}`), { code: "ECONNRESET" });
  diagnostics.authEvent(s.tokenFile, "request.error", { error }, { failure: true });
  diagnostics.authEvent(s.tokenFile, "tool.complete", {}, { resolved: true });
  const log = s.log();
  for (const secret of [access, refresh, "registration-secret", "client-secret", "private-session"]) assert.ok(!log.includes(secret), secret);
  assert.match(log, /PBP AUTH INCIDENT .* BEGIN/);
  assert.match(log, /preceding events/);
  assert.match(log, /invalid_grant/);
  assert.match(log, /The stored grant is invalid/);
  assert.match(log, /provider-request-123/);
  assert.match(log, /ECONNRESET/);
  assert.match(log, /END: authenticated request succeeded/);
  assert.match(log, new RegExp(diagnostics.fingerprint(refresh)));
  assert.equal(fs.statSync(s.logFile).mode & 0o777, 0o600);
});

test("HTTP 200 SSE RPC failures retain the actual provider error body", async t => {
  const s = fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","error":{"code":-32001,"message":"PBP exact permission failure"}}\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const res = await diagnostics.authFetch("https://example.invalid/mcp", { method: "POST", body: "{}" }, { tokenFile: s.tokenFile, step: "mcp.tools/call" });
  diagnostics.authResponse(res, await res.text());
  assert.match(s.log(), /PBP exact permission failure/);
  assert.match(s.log(), /PBP AUTH INCIDENT/);
});

test("an overlapping credential write is recorded without changing the original refresh behavior", async t => {
  const s = fixture(t);
  mcp.saveTokenFile({ access_token: "old-access", refresh_token: "old-refresh", client_id: "test-client", expires_in: 900 }, s.tokenFile);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes(".well-known")) return Response.json({ issuer: "https://example.invalid", token_endpoint: "https://example.invalid/token" });
    fs.writeFileSync(s.tokenFile, JSON.stringify({ access_token: "other-process-access", refresh_token: "other-process-refresh" }));
    return Response.json({ access_token: "renewed-access", refresh_token: "renewed-refresh", expires_in: 900 });
  });
  await mcp.refreshAccessToken({ tokenFile: s.tokenFile, url: "https://example.invalid/mcp" });
  assert.equal(s.log(), "", "successful renewal must stay quiet");
  diagnostics.authEvent(s.tokenFile, "subsequent.auth.failure", {}, { failure: true });
  const event = s.entries().find(entry => entry.event === "refresh.received");
  assert.equal(event.fileChangedDuringRequest, true);
  assert.equal(event.currentCredentials.refreshFingerprint, diagnostics.fingerprint("other-process-refresh"));
  assert.equal(mcp.readTokenFile(s.tokenFile).refresh_token, "renewed-refresh");
  assert.ok(!s.log().includes('"renewed-refresh"'));
});

test("unwritable diagnostics never prevent the original HTTP operation", async t => {
  const s = fixture(t);
  diagnostics.configureAuthDiagnostics(s.tokenFile, { logFile: s.directory });
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const res = await diagnostics.authFetch("https://example.invalid/mcp", {}, { tokenFile: s.tokenFile, step: "mcp.test" });
  const text = await res.text();
  assert.doesNotThrow(() => diagnostics.authResponse(res, text));
  assert.equal(JSON.parse(text).ok, true);
  assert.doesNotThrow(() => diagnostics.tokenFileSummary(s.tokenFile));
});

test("diagnostic files rotate to two backups", t => {
  const s = fixture(t);
  fs.writeFileSync(s.logFile, "x".repeat(5 * 1024 * 1024 + 1));
  diagnostics.authEvent(s.tokenFile, "after.rotation", {}, { failure: true });
  assert.ok(fs.existsSync(`${s.logFile}.1`));
  assert.match(s.log(), /after.rotation/);
});

test("normal token checks and authenticated requests stay in memory until an auth failure", async t => {
  const s = fixture(t);
  mcp.saveTokenFile({ access_token: "normal-access-fixture", refresh_token: "normal-refresh-fixture", expires_in: 900 }, s.tokenFile);
  t.mock.method(globalThis, "fetch", async () => Response.json({ result: { structuredContent: { success: true } } }));
  const client = createMcpClient({ tokenFilePath: s.tokenFile, configPath: path.join(s.directory, "config.json"), MCP_URL: "https://example.invalid/mcp", debugMode: false }, { logWithTimestamp() {}, logDebug() {} });
  await client.mcpToolCall("get_mission_catalog");
  assert.equal(s.log(), "");
  assert.equal(fs.existsSync(s.logFile), false);
  diagnostics.authEvent(s.tokenFile, "client.refresh.failed", { error: new Error("actual renewal failure") }, { failure: true });
  const log = s.log();
  assert.match(log, /client.tool.credentials_check/);
  assert.match(log, /mcp.initialize.request/);
  assert.match(log, /mcp.tools\/call.response/);
  assert.match(log, /bearerFingerprint/);
  assert.ok(!log.includes("normal-access-fixture"));
  assert.ok(!log.includes("normal-refresh-fixture"));
});

test("provider error text is preserved exactly beyond 16000 characters, including SSE framing", async t => {
  const s = fixture(t);
  const raw = 'event: message\ndata: {"jsonrpc":"2.0","error":{"code":-32001,"message":"' + 'provider detail '.repeat(1500) + '"}}\n\n';
  t.mock.method(globalThis, "fetch", async () => new Response(raw, {
    status: 401, headers: { "Content-Type": "text/event-stream", "x-pbp-detail": "exact-header" },
  }));
  const res = await diagnostics.authFetch("https://example.invalid/mcp", { method: "POST" }, { tokenFile: s.tokenFile, step: "mcp.tools/call" });
  diagnostics.authResponse(res, await res.text());
  const event = s.entries().find(entry => entry.event === "mcp.tools/call.response");
  assert.equal(event.rawResponse, raw);
  assert.equal(event.status, 401);
  assert.equal(event.headers["x-pbp-detail"], "exact-header");
});

test("a popup always records its trigger and token state, then successful operation goes quiet", async t => {
  const s = fixture(t);
  mcp.saveTokenFile({ access_token: "popup-access-fixture", refresh_token: "popup-refresh-fixture", expires_in: 900 }, s.tokenFile);
  const client = createMcpClient({ tokenFilePath: s.tokenFile, configPath: path.join(s.directory, "config.json"), MCP_URL: "https://example.invalid/mcp" },
    { logWithTimestamp() {}, logDebug() {} }, {
      login: async options => {
        assert.equal(options.beforeOpenBrowser().allowed, true);
      },
    });
  assert.equal(s.log(), "");
  assert.equal(await client.runLoginFlow({ forceInteractive: true, forceBrowser: true, automatic: true,
    reason: "watch_auth_error", triggerError: "PBP exact rejected authorization" }), true);
  const popup = s.entries().find(entry => entry.event === "client.login.window_claim");
  assert.equal(popup.allowed, true);
  assert.equal(popup.trigger.reason, "watch_auth_error");
  assert.equal(popup.trigger.triggerError, "PBP exact rejected authorization");
  assert.equal(popup.trigger.credentials.hasRefreshToken, true);
  assert.match(popup.trigger.caller, /performLoginFlow/);
  diagnostics.authEvent(s.tokenFile, "client.tool.complete", {}, { resolved: true });
  const recovered = s.log();
  for (let i = 0; i < 200; i++) {
    mcp.readTokenFile(s.tokenFile);
    diagnostics.authEvent(s.tokenFile, "client.tool.complete", {}, { resolved: true });
  }
  assert.equal(s.log(), recovered);
  assert.ok(!recovered.includes("popup-access-fixture"));
  assert.ok(!recovered.includes("popup-refresh-fixture"));
});

test("normal proactive renewal does not start a failure report", async t => {
  const s = fixture(t);
  mcp.saveTokenFile({ access_token: "expiring-access", refresh_token: "valid-refresh", expires_in: 30 }, s.tokenFile);
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).includes(".well-known")) return Response.json({ token_endpoint: "https://example.invalid/token" });
    if (String(url).endsWith("/token")) return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 });
    return Response.json({ result: { structuredContent: { success: true } } });
  });
  const client = createMcpClient({ tokenFilePath: s.tokenFile, configPath: path.join(s.directory, "config.json"), MCP_URL: "https://example.invalid/mcp" },
    { logWithTimestamp() {}, logDebug() {} });
  await client.mcpToolCall("get_mission_catalog");
  assert.equal(mcp.readTokenFile(s.tokenFile).access_token, "new-access");
  assert.equal(s.log(), "");
});
