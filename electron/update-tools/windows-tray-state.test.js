"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runnerLabel, missionRows, startFromWindowsTray } = require("../windows-tray-state");

test("four summaries distinguish active, unassigned, claimable and locked slots", () => {
  const rows = missionRows({
    slotUnlockSummary: { canUnlockMore: true, nextUnlockSlot: 4 },
    guiMissionSlots: [
      { slot: 1, missionName: "One", missionLevel: 15, assignedNft: "nft-1", missionActive: true, progress: 3, goal: 10 },
      { slot: 2, missionName: "Two", missionLevel: 4 },
      { slot: 3, missionName: "Three", assignedNft: "nft-3", missionActive: true, progress: 12, goal: 10 },
      { slot: 4, missionName: "Stale cached mission" },
    ],
  });
  assert.equal(rows.length, 4);
  assert.match(rows[0], /Level 15 · Active · 3 \/ 10 \(30%\)/);
  assert.match(rows[1], /No NFT assigned · —$/);
  assert.match(rows[2], /Claimable · 12 \/ 10 \(100%\)/);
  assert.equal(rows[3], "4. Locked");
  assert.deepEqual(missionRows({}), ["1. No mission", "2. No mission", "3. No mission", "4. No mission"]);
  assert.equal(missionRows({ startupMissionSlotsLoading: true })[0], "1. Loading…");
});

test("runner labels distinguish process startup, watcher activity and pause", () => {
  assert.equal(runnerLabel(), "Stopped");
  assert.equal(runnerLabel({ running: true }), "Starting…");
  assert.equal(runnerLabel({ running: true, watcherRunning: true }), "Watching missions…");
  assert.equal(runnerLabel({ running: true, watcherRunning: true, watchLoopEnabled: false }), "Paused");
});

test("Start applies the saved mode and resumes through existing commands", async () => {
  for (const [config, expected] of [
    [{ autoModeEnabled: true }, ["am on", "resume"]],
    [{ missionModeEnabled: true, missionModeResetLevel: "15" }, ["mm 15", "resume"]],
    [{ missionModeEnabled: true, missionModeResetLevel: "invalid" }, ["mm 10", "resume"]],
    [{ level20ResetEnabled: true }, ["mm off", "20r on", "resume"]],
    [{}, ["mm off", "20r off", "resume"]],
  ]) {
    for (const running of [false, true]) {
      const calls = [];
      await startFromWindowsTray({
        getConfig: async () => ({ config }),
        startBackend: async () => { calls.push("start"); return {}; },
        sendCommand: async (command) => calls.push(command),
      }, { running });
      assert.deepEqual(calls, running ? expected : ["start", ...expected]);
    }
  }
});

test("cancelled or failed startup never sends mode/resume commands", async () => {
  const bridge = {
    getConfig: async () => ({ config: {} }),
    startBackend: async () => ({ startCancelled: true }),
    sendCommand: async () => assert.fail("Commands sent after cancelled startup"),
  };
  await startFromWindowsTray(bridge, { running: false });
  bridge.startBackend = async () => { throw new Error("start failed"); };
  await assert.rejects(startFromWindowsTray(bridge, { running: false }), /start failed/);
});
