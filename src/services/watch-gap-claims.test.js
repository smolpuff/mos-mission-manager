"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWatchService } = require("./watch");
const { createChecksService, allowsRecentClaimedMissionOverride } = require("./checks");

function missionResult({ completed, level }) {
  return {
    structuredContent: {
      missions: {
        missions: [
          {
            assigned_mission_id: "assigned-mission-1",
            name: "Race for Points",
            slot: 3,
            current_level: level,
            completed,
            assigned_nft: "nft-1",
            start_time: "2026-08-31T18:14:02.810Z",
            prize: "pbp_token",
            prize_amount: 150,
          },
        ],
      },
    },
  };
}

for (const scenario of [
  { name: "assigns immediately after a gap claim", waitMs: 31_000, claimed: 1, authoritative: true, assigned: 1 },
  { name: "assigns after a confirmed gap claim without per-claim details", waitMs: 31_000, claimed: 1, authoritative: true, assigned: 1, omitDetails: true },
  { name: "leaves claims to the watcher when it is only 10 seconds away", waitMs: 10_000, claimed: 0, authoritative: true, assigned: 0 },
  { name: "does not assign after an unsuccessful gap claim", waitMs: 31_000, claimed: 0, authoritative: true, assigned: 0 },
  { name: "does not assign from pre-claim state when mutation state is missing", waitMs: 31_000, claimed: 1, authoritative: false, assigned: 0 },
]) {
  test(scenario.name, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
    const active = missionResult({ completed: false, level: 16 });
    const completed = missionResult({ completed: true, level: 16 });
    const after = missionResult({ completed: false, level: 17 });
    after.structuredContent.missions.missions[0].assigned_nft = null;
    const calls = [];
    const debug = [];
    let inGap = false;
    let assigned = 0;
    const ctx = {
      isAuthenticated: true,
      watchLoopEnabled: true,
      watcherRunning: true,
      config: { targetMissions: ["Race for Points"], postClaimSettleDelayMs: 0 },
      runtimeDefaults: {},
      currentMissionStats: {},
      sessionClaimedCount: 0,
      lastUserMissionsResult: active,
    };
    const logger = {
      logWithTimestamp() {}, logDebug(...args) { debug.push(args); }, redrawHeaderAndLog() {},
      formatTaggedLog(_tag, _icon, message) { return message; },
    };
    const mcp = {
      async mcpToolCall(tool) {
        calls.push(tool);
        return { structuredContent: { success: true, watch: { polls: 1 }, claims: [] } };
      },
      async getUserMissions() {
        calls.push("get_user_missions");
        return inGap ? completed : active;
      },
      getToolCooldownRemainingMs() { return 0; },
      getToolWindowBudget() { return { waitMs: inGap ? scenario.waitMs : 0 }; },
    };
    const actualChecks = createChecksService(ctx, logger, mcp);
    const checks = {
      filterSelectedMissions: (missions) => missions,
      async refreshMissionHeaderStats() {},
      async claimClaimableMissions() {
        calls.push("claim_mission_reward");
        return {
          claimed: scenario.claimed,
          claims: scenario.claimed && !scenario.omitDetails ? [{ success: true, assignedMissionId: "assigned-mission-1", name: "Race for Points", slot: 3, level: 16 }] : [],
          missionResult: scenario.authoritative ? after : null,
          missionStateAuthoritative: scenario.authoritative,
          mutationStateMissing: !scenario.authoritative,
        };
      },
      async autoAssignConfiguredMissions({ missionsResult, reason }) {
        if (!inGap) return { assigned: 0, missionResult: missionsResult };
        assert.equal(missionsResult, after, "Reuse the claim mutation response");
        // Verify assignment eligibility using the real candidate rules and
        // the updated mission state returned by the claim.
        assert.equal(actualChecks.hasAssignableConfiguredMissions(missionsResult, reason), true);
        calls.push("assign_nft_to_mission");
        assigned += 1;
        return { assigned: 1, missionResult: after, missionStateAuthoritative: true };
      },
    };
    const service = createWatchService(ctx, logger, mcp, checks, { saveConfig() {} });
    await service.runWatchCycle();
    assert.equal(calls.filter((tool) => tool === "watch_and_claim").length, 1);
    calls.length = 0;
    inGap = true;
    t.mock.timers.tick(31_000);
    // Drain the asynchronous timer's claim lifecycle without advancing to
    // the next watcher call or any delayed wallet refresh.
    for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    assert.equal(assigned, scenario.assigned, JSON.stringify(debug));
    assert.equal(calls.includes("claim_mission_reward"), scenario.waitMs > 10_000);
    assert.equal(ctx.sessionClaimedCount, scenario.claimed);
    if (scenario.assigned) {
      assert.deepEqual(calls, ["get_user_missions", "claim_mission_reward", "assign_nft_to_mission"]);
    }
  });
}

test("gap and manual post-claim assignments release recently claimed mission slots", () => {
  for (const reason of [
    "post_claim_watch_gap_direct_claim",
    "post_claim_manual",
  ]) {
    assert.equal(allowsRecentClaimedMissionOverride(reason), true);
    assert.equal(allowsRecentClaimedMissionOverride(`${reason}_owned_cooldown_fallback`), true);
  }
  assert.equal(allowsRecentClaimedMissionOverride("periodic"), false);
});
