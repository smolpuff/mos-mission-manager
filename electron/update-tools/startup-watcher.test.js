"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scheduleStartupWatching } = require("../startup-watcher");
const { startFromWindowsTray } = require("../windows-tray-state");
const { flushConfig } = require("../../src/config");

function fixture(t, config = { autoStartWatchingEnabled: true }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { config, status: {}, quitting: false, starts: 0, errors: [] };
  const options = {
    getConfig: () => state.config,
    getStatus: () => state.status,
    isQuitting: () => state.quitting,
    startWatching: async () => { state.starts++; },
    onError: error => state.errors.push(error),
  };
  return { state, options };
}

test("startup watching waits 0.75 seconds and only starts once", async t => {
  const { state, options } = fixture(t);
  scheduleStartupWatching(options);
  t.mock.timers.tick(749);
  assert.equal(state.starts, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(state.starts, 1);
  t.mock.timers.tick(10000);
  assert.equal(state.starts, 1);
});

test("startup watching is off by default and does not start when enabled later", t => {
  const { state, options } = fixture(t, {});
  scheduleStartupWatching(options);
  state.config.autoStartWatchingEnabled = true;
  t.mock.timers.tick(750);
  assert.equal(state.starts, 0);
});

for (const reason of ["disabled", "running", "quitting", "cancelled"]) {
  test(`startup watching skips a pending start when ${reason}`, t => {
    const { state, options } = fixture(t);
    const cancel = scheduleStartupWatching(options);
    if (reason === "disabled") state.config.autoStartWatchingEnabled = false;
    if (reason === "running") state.status.running = true;
    if (reason === "quitting") state.quitting = true;
    if (reason === "cancelled") cancel();
    t.mock.timers.tick(750);
    assert.equal(state.starts, 0);
  });
}

test("startup watching reports a start failure without retrying", async t => {
  const { state, options } = fixture(t);
  const error = new Error("start failed");
  options.startWatching = async () => { throw error; };
  scheduleStartupWatching(options);
  t.mock.timers.tick(750);
  await Promise.resolve();
  assert.deepEqual(state.errors, [error]);
});

test("startup watching uses the existing start path and saved modes on all desktop platforms", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scenarios = [];
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const [mode, commands] of [
      [{}, ["mm off", "20r off", "resume"]],
      [{ autoModeEnabled: true }, ["am on", "resume"]],
      [{ missionModeEnabled: true, missionModeResetLevel: "15" }, ["mm 15", "resume"]],
    ]) {
      const calls = [];
      const config = { autoStartWatchingEnabled: true, ...mode };
      const bridge = {
        getConfig: async () => ({ config }),
        startBackend: async () => { calls.push("start"); return {}; },
        sendCommand: async command => { calls.push(command); },
      };
      scheduleStartupWatching({
        getConfig: () => config, getStatus: () => ({}), isQuitting: () => false,
        startWatching: () => startFromWindowsTray(bridge, {}),
        onError: error => assert.fail(error),
      });
      scenarios.push({ platform, calls, expected: ["start", ...commands] });
    }
  }
  t.mock.timers.tick(750);
  await new Promise(resolve => setImmediate(resolve));
  for (const { platform, calls, expected } of scenarios) assert.deepEqual(calls, expected, platform);
});

test("runner config saves preserve the startup-watching setting changed in Settings", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-watching-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  for (const enabled of [true, false]) {
    fs.writeFileSync(configPath, JSON.stringify({ autoStartWatchingEnabled: enabled }));
    flushConfig({ configPath, config: { autoStartWatchingEnabled: !enabled } }, () => {});
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).autoStartWatchingEnabled, enabled);
  }
});
