"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpClient } = require("./client");
const { createWatchService } = require("../services/watch");

async function scenario(t, options) {
  let now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-routing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ctx = {
    config: {}, runtimeDefaults: {}, currentMissionStats: {},
    tokenFilePath: path.join(directory, "token.json"), configPath: path.join(directory, "config.json"),
    MCP_URL: "https://simulation.invalid/mcp", isAuthenticated: true, watchLoopEnabled: true,
  };
  fs.writeFileSync(ctx.tokenFilePath, JSON.stringify({
    access_token: "offline-access-fixture", refresh_token: "offline-refresh-fixture",
    expires_at: new Date(now + (options.expiring ? 30_000 : 900_000)).toISOString(),
  }));
  const counts = { tools: 0, refreshes: 0, launches: 0, retries: 0 };
  const logger = {
    logWithTimestamp(message) {
      if (message.includes("Cycle failed:")) {
        counts.retries++;
        if (!options.allowRecoveryRetry) ctx.watchLoopEnabled = false;
      }
    },
    logDebug() {}, redrawHeaderAndLog() {}, formatTaggedLog(_tag, _icon, message) { return message; },
  };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (url === "https://simulation.invalid/token") {
      counts.refreshes++;
      if (options.refreshError) throw new Error(options.refreshError);
      if (options.refreshStatus) return Response.json({ error: options.refreshCode || "temporarily_unavailable" }, { status: options.refreshStatus });
      return Response.json({ access_token: "offline-renewed-fixture", refresh_token: "offline-next-refresh-fixture", expires_in: 900 });
    }
    if (String(url).includes(".well-known")) return Response.json({ token_endpoint: "https://simulation.invalid/token" });
    assert.equal(url, ctx.MCP_URL, "No unexpected network requests");
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      if (options.initializeStatus && !counts.refreshes) return Response.json({ error: "rejected" }, { status: options.initializeStatus });
      return Response.json({ result: {} });
    }
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "watch_and_claim");
    counts.tools++;
    if (!counts.refreshes && options.response) return Response.json(options.response, { status: options.status || 200 });
    counts.success = true;
    ctx.watchLoopEnabled = false;
    return Response.json({ result: { structuredContent: { success: true, claims: [], watch: { polls: 1 } } } });
  });
  const client = createMcpClient(ctx, logger, { login: async (args) => {
    if (args.beforeOpenBrowser().allowed) counts.launches++;
    throw new Error("Offline callback simulation");
  } });
  const mcp = { ...client, async getUserMissions() { return { structuredContent: { missions: [] } }; } };
  const service = createWatchService(ctx, logger, mcp, {
    async refreshMissionHeaderStats() { return {}; }, filterSelectedMissions(missions) { return missions; },
    async autoAssignConfiguredMissions() { return { assigned: 0 }; },
  }, { saveConfig() {} });
  let finished = false;
  const pending = service.startWatchLoop().finally(() => { finished = true; });
  for (let i = 0; i < 100 && !finished; i++) {
    await new Promise(setImmediate);
    now += 1000;
    t.mock.timers.tick(1000);
  }
  assert.equal(finished, true, "The real watcher must complete the simulated recovery/retry path");
  await pending;
  return { counts, ctx };
}

const toolError = (text, structuredContent = {}) => ({ result: {
  isError: true, content: [{ type: "text", text }], structuredContent,
} });

for (const text of [
  "A watch_and_claim request is already active for this authenticated user. Wait for it to finish before starting another.",
  "watch_and_claim failed for mission 14013", "NFT 40399 failed", "Forbidden", "Authorization failed",
  "Authentication service unavailable", "tool call failed: HTTP 401",
]) {
  test(`real client + watcher never refresh or open login for ${text}`, async (t) => {
    const { counts, ctx } = await scenario(t, { response: toolError(text) });
    assert.equal(counts.refreshes, 0);
    assert.equal(counts.launches, 0);
    assert.equal(counts.retries, 1);
    assert.equal(ctx.isAuthenticated, true);
  });
}

test("HTTP 403 permission denial does not imply invalid credentials", async (t) => {
  const { counts, ctx } = await scenario(t, { status: 403, response: { error: "forbidden" } });
  assert.equal(counts.refreshes, 0);
  assert.equal(counts.launches, 0);
  assert.equal(ctx.isAuthenticated, true);
});

test("generic RPC errors do not infer auth failure from words or numbers", async (t) => {
  const { counts } = await scenario(t, { response: { error: { code: -32000, message: "mission 40123 has forbidden metadata" } } });
  assert.equal(counts.refreshes, 0);
  assert.equal(counts.launches, 0);
});

for (const options of [
  { initializeStatus: 401 },
  { status: 401, response: { error: "unauthorized" } },
  { status: 403, response: { error: "invalid_token" } },
  { response: { error: { code: -32000, message: "Not authenticated" } } },
  { response: toolError("Not authenticated") },
  { response: toolError("Credentials rejected", { error: { code: "TOKEN_EXPIRED" } }) },
]) {
  test(`explicit auth rejection renews silently: ${JSON.stringify(options)}`, async (t) => {
    const { counts } = await scenario(t, { ...options, allowRecoveryRetry: true });
    assert.equal(counts.refreshes, 1);
    assert.equal(counts.launches, 0);
    assert.equal(counts.success, true);
  });
}

for (const options of [
  { expiring: true, refreshStatus: 503 },
  { expiring: true, refreshStatus: 429 },
  { expiring: true, refreshError: "fetch failed" },
  { expiring: true, refreshError: "request timeout" },
  { status: 401, response: { error: "unauthorized" }, refreshStatus: 503 },
]) {
  test(`transient renewal failure never forces login: ${JSON.stringify(options)}`, async (t) => {
    const { counts, ctx } = await scenario(t, options);
    assert.equal(counts.refreshes, 3);
    assert.equal(counts.launches, 0);
    assert.equal(counts.retries, 1);
    assert.equal(ctx.isAuthenticated, true);
  });
}

test("a revoked refresh grant still permits necessary, gated browser authentication", async (t) => {
  const { counts } = await scenario(t, { expiring: true, refreshStatus: 400, refreshCode: "invalid_grant" });
  assert.equal(counts.refreshes, 3);
  assert.equal(counts.launches, 1);
});
