"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWatchService } = require("./watch");

async function watchFailure(t, message) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = {
    isAuthenticated: true,
    watchLoopEnabled: true,
    config: {},
    runtimeDefaults: {},
    currentMissionStats: {},
  };
  const loginCalls = [];
  const retryLogs = [];
  let watchCalls = 0;
  const logger = {
    logWithTimestamp(message) {
      if (message.includes("Cycle failed:")) {
        retryLogs.push(message);
        ctx.watchLoopEnabled = false;
      }
    },
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) { return message; },
  };
  const mcp = {
    async getUserMissions() { return { structuredContent: { missions: [] } }; },
    async mcpToolCall(tool) {
      assert.equal(tool, "watch_and_claim");
      watchCalls += 1;
      throw new Error(message);
    },
    async runLoginFlow(options) { loginCalls.push(options); return false; },
  };
  const service = createWatchService(ctx, logger, mcp, {
    async refreshMissionHeaderStats() {},
  }, { saveConfig() {} });
  const pending = service.startWatchLoop();
  await new Promise(setImmediate);
  assert.equal(watchCalls, 1, "Exercise a real watcher tool failure");
  assert.equal(retryLogs.length, 1, "Keep the ordinary watcher retry path");
  t.mock.timers.tick(3000);
  await pending;
  return { ctx, loginCalls };
}

test("an already-active watch for an authenticated user does not force login", async (t) => {
  const { ctx, loginCalls } = await watchFailure(t,
    "A watch_and_claim request is already active for this authenticated user. Wait for it to finish before starting another.");
  assert.equal(ctx.isAuthenticated, true);
  assert.deepEqual(loginCalls, []);
});

for (const message of [
  "Not authenticated",
  "Unauthenticated",
  "Authentication failed",
  "Authorization failed",
  "Auth error",
  "Login required",
  "missing token",
  "tool call failed: HTTP 401",
  "tool call failed: HTTP 403",
  "Unauthorized",
  "Forbidden",
]) {
  test(`watcher still reauthenticates for ${message}`, async (t) => {
    const { ctx, loginCalls } = await watchFailure(t, message);
    assert.equal(ctx.isAuthenticated, false);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].forceInteractive, true);
    assert.equal(loginCalls[0].forceBrowser, true);
    assert.equal(loginCalls[0].reason, "watch_auth_error");
  });
}
