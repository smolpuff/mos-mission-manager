"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMcpClient } = require("./client");

function simulation(t, { durationMs, retryAfterSeconds = null }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watch-pacing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFilePath = path.join(directory, "token.json");
  fs.writeFileSync(tokenFilePath, JSON.stringify({ access_token: "simulation-only" }));
  const startedAt = 1_800_000_000_000;
  let now = startedAt;
  let dispatched = 0;
  const events = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method !== "tools/call") {
      return Response.json({ result: {} });
    }
    assert.equal(body.params.name, "watch_and_claim");
    dispatched += 1;
    now += durationMs;
    if (retryAfterSeconds !== null) {
      return Response.json({ error: { message: "simulated server limit" } }, {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      });
    }
    return Response.json({ result: { structuredContent: { success: true, claims: [] } } });
  });
  const makeClient = () => createMcpClient({
    config: {},
    configPath: path.join(directory, "config.json"),
    tokenFilePath,
    MCP_URL: "https://simulation.invalid/mcp",
    guiBridge: { sendEvent(type, payload) { events.push({ type, ...payload }); } },
  }, { logWithTimestamp() {}, logDebug() {} });
  return { makeClient, startedAt, events, dispatched: () => dispatched };
}

for (const durationMs of [5_000, 60_000, 90_000]) {
  test(`a ${durationMs / 1000}s watch response does not restart the dispatch cooldown`, async (t) => {
    const { makeClient, startedAt, dispatched, events } = simulation(t, { durationMs });
    const client = makeClient();
    await client.mcpToolCall("watch_and_claim");
    const expectedWaitMs = Math.max(0, 62_000 - durationMs);
    assert.equal(client.getToolWindowBudget("watch_and_claim").waitMs, expectedWaitMs);
    const restarted = makeClient();
    assert.equal(restarted.getToolWindowBudget("watch_and_claim").waitMs, expectedWaitMs);
    assert.equal(client.getToolWindowBudget("assign_nft_to_mission").waitMs, 0);
    if (expectedWaitMs > 0) {
      await assert.rejects(restarted.mcpToolCall("watch_and_claim"), (error) => {
        assert.equal(error.cooldownActive, true);
        return true;
      });
      assert.equal(dispatched(), 1, "An early local retry must not reach the server");
      assert.deepEqual(events, [], "Local pacing must not open the MCP throttle dialog");
    }
    t.mock.method(Date, "now", () => startedAt + Math.max(62_000, durationMs));
    assert.equal(restarted.getToolWindowBudget("watch_and_claim").waitMs, 0);
  });
}

test("a server Retry-After still extends the persisted watch deadline", async (t) => {
  const { makeClient, dispatched, events } = simulation(t, { durationMs: 5_000, retryAfterSeconds: 120 });
  const client = makeClient();
  await assert.rejects(client.mcpToolCall("watch_and_claim"), (error) => {
    assert.equal(error.rateLimited, true);
    assert.equal(error.cooldownActive, undefined);
    return true;
  });
  // Keep the server's 120 seconds plus the existing two-second buffer.
  assert.equal(client.getToolWindowBudget("watch_and_claim").waitMs, 122_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "throttle_notice");
  assert.equal(events[0].source, "mcp");
  assert.equal(events[0].trigger, "watch_and_claim");
  const restarted = makeClient();
  assert.equal(restarted.getToolWindowBudget("watch_and_claim").waitMs, 122_000);
  await assert.rejects(restarted.mcpToolCall("watch_and_claim"));
  assert.equal(dispatched(), 1);
  assert.equal(events.length, 1, "Waiting on a remembered server cooldown must not reopen the dialog");
});

test("local assignment budget exhaustion stays silent", async (t) => {
  const { makeClient, dispatched, events } = simulation(t, { durationMs: 0 });
  const client = makeClient();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(client.reserveToolWindowCapacity("assign_nft_to_mission").ok, true);
  }
  await assert.rejects(client.mcpToolCall("assign_nft_to_mission"), (error) => {
    assert.equal(error.cooldownActive, true);
    assert.equal(error.reason, "local_per_tool_window");
    return true;
  });
  assert.equal(dispatched(), 0);
  assert.deepEqual(events, []);
});
