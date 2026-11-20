"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createChecksService } = require("./checks");

function scenario(t, { enabled = true, locked = true, pending = false, failUnlock = false, failSwap = false, randomName = "Random mission", disabled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-unlock-slot4-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mission = (name) => ({ slot: 4, name, mission_id: name === "Race!" ? "race" : "random", assigned_mission_id: "assigned-4", current_level: 1, assigned_nft: "nft-4", active: true });
  const snapshot = (isLocked, name) => ({ structuredContent: { missions: {
    missions: isLocked ? [] : [mission(name)],
    slotUnlockSummary: { canUnlockMore: isLocked, nextUnlockSlot: isLocked ? 4 : null },
  } } });
  let latest = snapshot(locked, randomName);
  const calls = [];
  const statuses = [];
  const ctx = {
    configPath: path.join(dir, "config.json"),
    config: { targetMissions: ["Race!"], autoUnlockSlot4Enabled: enabled, autoUnlockSlot4MissionName: "Race!", autoUnlockSlot4RestorePending: pending, missionActionEnabledBySlot: { 4: !disabled } },
    missionActionEnabledBySlot: { 4: !disabled },
    signerMode: "app_wallet", currentMissionStats: { nfts: 1 },
    missionCatalogEntries: [{ id: "race", name: "Race!" }],
    guiBridge: { emitNow() { statuses.push(ctx.autoUnlockSlot4Status || null); } },
  };
  const logger = { logWithTimestamp() {}, logDebug() {}, redrawHeaderAndLog() {}, formatTaggedLog(_tag, _icon, text) { return text; } };
  const mcp = {
    async getUserMissions() { ctx.lastUserMissionsResult = latest; return latest; },
    async mcpToolCall(tool, args) {
      calls.push(tool);
      if (tool === "unlock_mission_slot") return { structuredContent: { unlockCost: 2500 } };
      if (tool === "prepare_mission_swap") {
        assert.equal(args.chosenMissionId, "race");
        return { structuredContent: { swapCost: 500 } };
      }
      if (tool === "submit_signed_mission_slot_unlock") {
        if (failUnlock) throw new Error("Unlock rejected");
        latest = snapshot(false, randomName);
        return { structuredContent: { success: true } };
      }
      if (tool === "submit_signed_mission_swap") {
        if (failSwap) throw new Error("Swap rejected");
        latest = snapshot(false, "Race!");
        ctx.lastUserMissionsResult = latest;
        return latest;
      }
      // Existing delayed funding-wallet refresh is unrelated to mission actions.
      if (tool === "get_app_wallet_summary") return { structuredContent: {} };
      throw new Error(`Unexpected call: ${tool}`);
    },
  };
  const signer = {
    ensureMissionActionSupported() {},
    async signPreparedMissionActionPayload(action, prepared) {
      return { submitTool: `submit_signed_${action}`, submitArgs: {}, cost: prepared.structuredContent.unlockCost ?? prepared.structuredContent.swapCost };
    },
  };
  const checks = createChecksService(ctx, logger, mcp, { signer });
  return {
    ctx, checks, calls, statuses,
    expire() { latest = snapshot(true, randomName); },
    run: () => checks.autoAssignConfiguredMissions({ reason: "test", missionsResult: latest }),
  };
}

test("auto unlocks slot 4, restores the target, and publishes both card statuses", async (t) => {
  const { ctx, checks, run, calls, statuses } = scenario(t);
  assert.equal(checks.needsAutoUnlockSlot4({ structuredContent: { slotUnlockSummary: { canUnlockMore: true, nextUnlockSlot: 4 } } }), true);
  const result = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 4), ["unlock_mission_slot", "submit_signed_mission_slot_unlock", "prepare_mission_swap", "submit_signed_mission_swap"]);
  assert.ok(statuses.includes("unlocking"));
  assert.ok(statuses.includes("resetting"));
  assert.equal(statuses.at(-1), null);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, false);
  assert.equal(ctx.config.autoUnlockSlot4MissionName, "Race!");
  assert.equal(ctx.sessionSpendTotals.pbp, 3000);
  assert.equal(result.missionResult.structuredContent.missions.missions[0].name, "Race!");
  await run();
  assert.equal(calls.filter((tool) => tool === "unlock_mission_slot").length, 1);
  assert.equal(calls.filter((tool) => tool === "prepare_mission_swap").length, 1);
});

for (const options of [{ enabled: false }, { disabled: true }, { locked: false }]) {
  test(`does not spend when ${JSON.stringify(options)}`, async (t) => {
    const { run, calls, statuses } = scenario(t, options);
    await run();
    assert.equal(calls.length, 0);
    assert.ok(!statuses.includes("unlocking"));
    assert.ok(!statuses.includes("resetting"));
  });
}

test("failed unlock does not swap and clears the visible status", async (t) => {
  const { run, calls, ctx } = scenario(t, { failUnlock: true });
  await run();
  assert.deepEqual(calls, ["unlock_mission_slot", "submit_signed_mission_slot_unlock"]);
  assert.equal(ctx.autoUnlockSlot4Status, null);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, true);
});

test("failed restore keeps its target and retries the swap without another unlock", async (t) => {
  const { run, calls, ctx } = scenario(t, { failSwap: true });
  await run();
  await run();
  assert.equal(calls.filter((tool) => tool === "unlock_mission_slot").length, 1);
  assert.equal(calls.filter((tool) => tool === "prepare_mission_swap").length, 2);
  assert.equal(ctx.config.autoUnlockSlot4MissionName, "Race!");
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, true);
  assert.equal(ctx.autoUnlockSlot4Status, null);
});

test("resumes a saved pending restore after restart without paying to unlock again", async (t) => {
  const { run, calls, ctx } = scenario(t, { locked: false, pending: true });
  await run();
  assert.deepEqual(calls, ["prepare_mission_swap", "submit_signed_mission_swap"]);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, false);
});

test("does not swap when unlocking already assigned the saved target", async (t) => {
  const { run, calls, ctx } = scenario(t, { randomName: "Race!" });
  await run();
  assert.deepEqual(calls, ["unlock_mission_slot", "submit_signed_mission_slot_unlock"]);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, false);
  assert.equal(ctx.sessionSpendTotals.pbp, 2500);
});

test("keeps the saved slot 4 target when locked missions are absent from the target list", async (t) => {
  const { ctx, run, calls } = scenario(t);
  ctx.config.targetMissions = [];
  await run();
  assert.equal(calls.filter((tool) => tool === "submit_signed_mission_slot_unlock").length, 1);
  assert.equal(calls.filter((tool) => tool === "submit_signed_mission_swap").length, 1);
  assert.equal(ctx.config.autoUnlockSlot4MissionName, "Race!");
});

test("an enabled unlocked slot expires and renews automatically on every expiry without UI approval", async (t) => {
  const { ctx, run, expire, calls, statuses } = scenario(t, { locked: false, randomName: "Race!" });
  await run();
  assert.deepEqual(calls, [], "Already unlocked: leave the mission alone");
  expire();
  await run();
  assert.deepEqual(calls, ["unlock_mission_slot", "submit_signed_mission_slot_unlock"]);
  assert.equal(ctx.config.autoUnlockSlot4Enabled, true);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, false);
  expire();
  await run();
  assert.equal(calls.filter((tool) => tool === "submit_signed_mission_slot_unlock").length, 2);
  assert.equal(statuses.filter((state, index) => state === "unlocking" && statuses[index - 1] !== state).length, 2);
});

test("the application unlocks before swapping and repeats the complete automatic sequence after expiry", async (t) => {
  const { ctx, run, expire, calls, statuses } = scenario(t);
  await run();
  const firstSequence = [...calls];
  expire();
  await run();
  assert.deepEqual(calls, [...firstSequence, ...firstSequence]);
  assert.deepEqual(firstSequence, ["unlock_mission_slot", "submit_signed_mission_slot_unlock", "prepare_mission_swap", "submit_signed_mission_swap"]);
  assert.equal(ctx.config.autoUnlockSlot4Enabled, true);
  assert.equal(ctx.config.autoUnlockSlot4RestorePending, false);
  assert.equal(ctx.sessionSpendTotals.pbp, 6000);
  assert.ok(statuses.indexOf("unlocking") < statuses.indexOf("resetting"));
  assert.equal(statuses.at(-1), null);
});
