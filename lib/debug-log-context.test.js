"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { debugLogContext } = require("./debug-log-context");
const { authEvent } = require("./auth-diagnostics");
const { createMcpClient } = require("../src/mcp/client");

test("debug context includes public identity and labeled process and system resources", () => {
  const context = debugLogContext({
    currentUserDisplayName: "unknown",
    currentUserWalletSummary: { username: "Test user", userId: "user-1", walletId: "wallet-1" },
    signerConfig: { walletAddress: "public-address", privateKey: "never-log-this" },
  });
  assert.equal(context.user.name, "Test user");
  assert.equal(context.user.id, "user-1");
  assert.equal(context.wallet.id, "wallet-1");
  assert.equal(context.wallet.address, "public-address");
  assert.ok(context.resourceUsage.process.memoryBytes.rss > 0);
  assert.equal(typeof context.resourceUsage.process.cpuTimeMicroseconds.user, "number");
  assert.ok(context.resourceUsage.system.totalMemoryBytes > 0);
  assert.ok(!JSON.stringify(context).includes("never-log-this"));
  assert.equal(debugLogContext().user.name, "unknown");
});

test("auth incidents and throttle traces write live identity and resources before request details", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "debug-log-header-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ctx = {
    config: {}, debugMode: true,
    configPath: path.join(directory, "config.json"),
    tokenFilePath: path.join(directory, "token.json"),
    MCP_URL: "https://simulation.invalid/mcp",
    signerConfig: { walletAddress: "public-address", privateKey: "never-log-this" },
  };
  fs.writeFileSync(ctx.tokenFilePath, JSON.stringify({ access_token: "fixture-access-token" }));
  const client = createMcpClient(ctx, { logWithTimestamp() {}, logDebug() {} });
  // Identity is commonly loaded after the client is created.
  ctx.currentUserDisplayName = "Test user";
  ctx.currentUserWalletId = "wallet-1";
  ctx.currentUserWalletSummary = { userId: "user-1" };
  authEvent(ctx.tokenFilePath, "client.login.window_claim", {}, { reauthorization: true });
  t.mock.method(globalThis, "fetch", async () => Response.json(
    { error: { message: "simulated server limit" } },
    { status: 429, headers: { "Retry-After": "120" } },
  ));
  await assert.rejects(client.mcpToolCall("watch_and_claim"));
  for (const [name, detail] of [
    ["pbp-auth-debug.log", '"context":"preceding requests'],
    ["mcp-throttle-debug.log", "requestedTool:"],
  ]) {
    const log = fs.readFileSync(path.join(directory, name), "utf8");
    assert.match(log, /user: .*Test user.*user-1/);
    assert.match(log, /wallet: .*wallet-1.*public-address/);
    assert.match(log, /resourceUsage: .*memoryBytes/);
    assert.ok(log.indexOf("resourceUsage:") < log.indexOf(detail));
    assert.ok(!log.includes("never-log-this"));
    assert.ok(!log.includes("fixture-access-token"));
  }
});
