"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  normalizeMissionList,
  latestMissionResultFromClaims,
  extractMissionReward,
} = require("../src/missions/normalize");
const {
  createChecksService,
  shouldRetryAssignmentOption,
} = require("../src/services/checks");
const { resetPolicyForSlot } = require("../src/mission-reset-policy");
const { createWatchService } = require("../src/services/watch");
const {
  applyWalletBalanceDeltas,
} = require("../src/wallet/balance-delta");

const repoRoot = path.resolve(__dirname, "..");

function mission(id, slot, assignedNft = null) {
  return {
    assigned_mission_id: id,
    slot,
    name: `mission-${slot}`,
    assigned_nft: assignedNft,
  };
}

test("disabled per-slot override falls back to Manual, Mission, and Auto reset policy", () => {
  const shared = {
    missionResetPerSlotModeEnabled: true,
    missionResetPerSlotEnabledBySlot: {
      "1": false,
      "2": false,
      "3": false,
      "4": false,
    },
  };
  const missionMode = {
    ...shared,
    missionModeEnabled: true,
    currentMissionResetLevel: "10",
  };

  assert.deepEqual(resetPolicyForSlot(missionMode, 3), {
    enabled: true,
    threshold: 10,
    label: "mm(10)",
    source: "mm",
  });
  assert.deepEqual(
    resetPolicyForSlot(
      {
        ...shared,
        level20ResetEnabled: true,
        currentMissionResetLevel: "7",
      },
      3,
    ),
    {
      enabled: true,
      threshold: 7,
      label: "20r",
      source: "20r",
    },
  );
  assert.deepEqual(
    resetPolicyForSlot({ ...shared, autoModeEnabled: true }, 3),
    {
      enabled: true,
      threshold: 20,
      label: "auto20",
      source: "auto20",
    },
  );
});

test("normalizes documented claim and assignment mutation mission shapes", () => {
  const direct = { missions: [mission("a", 1)] };
  const structured = {
    structuredContent: { missions: [mission("b", 2)] },
  };
  const nested = {
    structuredContent: { missions: { missions: [mission("c", 3)] } },
  };
  const claimResultNested = {
    structuredContent: { result: { missions: [mission("d", 4)] } },
  };

  assert.equal(normalizeMissionList(direct)[0].assigned_mission_id, "a");
  assert.equal(normalizeMissionList(structured)[0].assigned_mission_id, "b");
  assert.equal(normalizeMissionList(nested)[0].assigned_mission_id, "c");
  assert.equal(
    normalizeMissionList(claimResultNested)[0].assigned_mission_id,
    "d",
  );
});

test("new claim balanceChange payload drives reward totals and local wallet balances", () => {
  const claim = {
    assignedMissionId: "claimed-1",
    success: true,
    reward: {
      prize: "pbp_token",
      missionRewardAmount: 75,
      claimantRewardAmount: 75,
      balanceChange: { currency: "PBP", amount: 75 },
    },
  };
  assert.deepEqual(extractMissionReward(claim), {
    amount: 75,
    token: "PBP",
    label: "75 PBP",
  });
  assert.deepEqual(
    applyWalletBalanceDeltas(
      {
        balances: [
          {
            key: "pbp",
            symbol: "PBP",
            balance: 116197,
            displayBalance: "116,197",
          },
        ],
      },
      { pbp: 75 },
    ).balances[0],
    {
      key: "pbp",
      symbol: "PBP",
      balance: 116272,
      displayBalance: 116272,
    },
  );
});

test("same cycle assigns a claim whose watch response omitted missions after cooldown", async () => {
  let missionReads = 0;
  let watchCalls = 0;
  let missionCooldownChecks = 0;
  const assignmentInputs = [];
  const claimingEvents = [];
  const replacementMissionResult = {
    structuredContent: {
      missions: {
        missions: [mission("replacement-1", 1)],
      },
    },
  };
  const assignedMissionResult = {
    structuredContent: {
      missions: {
        missions: [mission("replacement-1", 1, "nft-a")],
      },
    },
  };
  const preClaimMissionResult = {
    structuredContent: {
      missions: {
        missions: [mission("claimed-old-id", 1, "old-nft")],
      },
    },
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      targetMissions: ["mission-1"],
    },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    lastUserMissionsResult: preClaimMissionResult,
    lastUserMissionsFetchedAt: Date.now() - 60_000,
    currentMissionStats: {},
    currentUserWalletSummary: {
      balances: [{ key: "pbp", balance: 100, displayBalance: 100 }],
    },
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: {
      sendEvent(type, payload) {
        if (type === "claiming") claimingEvents.push(payload);
      },
      emitNow() {},
    },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      watchCalls += 1;
      if (watchCalls > 1) {
        return {
          structuredContent: {
            success: true,
            watch: { polls: 1, elapsedMs: 1, timedOut: true },
            missionSnapshot: { total: 1, eligible: 0 },
            claims: [],
          },
        };
      }
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 1 },
          claims: [
            {
              assignedMissionId: "claimed-old-id",
              success: true,
              reward: {
                balanceChange: { currency: "PBP", amount: 75 },
              },
            },
          ],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      return replacementMissionResult;
    },
    getToolCooldownRemainingMs(toolName) {
      assert.equal(toolName, "get_user_missions");
      missionCooldownChecks += 1;
      return missionCooldownChecks === 1 ? 5 : 0;
    },
  };
  const checks = {
    filterSelectedMissions(missions) {
      return missions;
    },
    async refreshMissionHeaderStats({ missionsResult }) {
      assert.ok(missionsResult);
      ctx.currentMissionStats = { ...ctx.currentMissionStats, available: 1 };
      return { ok: true, stats: ctx.currentMissionStats };
    },
    async autoAssignConfiguredMissions(args) {
      assignmentInputs.push(args);
      return {
        attempted: 1,
        assigned: 1,
        missionResult: assignedMissionResult,
        missionStateAuthoritative: true,
      };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const claimResult = await watch.runWatchCycle();

  assert.equal(claimResult.claimed, 1);
  assert.equal(missionReads, 1);
  assert.equal(watchCalls, 1);
  assert.equal(assignmentInputs.length, 1);
  assert.equal(
    normalizeMissionList(assignmentInputs[0].missionsResult)[0]
      .assigned_mission_id,
    "replacement-1",
  );
  assert.equal(ctx.sessionRewardTotals.pbp, 75);
  assert.equal(ctx.sessionClaimedCount, 1);
  assert.equal(ctx.config.totalClaimed, 1);
  assert.equal(ctx.currentUserWalletSummary.balances[0].balance, 175);
  assert.deepEqual(
    claimingEvents.map((event) => event.state),
    ["start", "done"],
  );
});

test("watch claim missions reply updates and assigns with zero mission reads", async () => {
  let missionReads = 0;
  const assignmentInputs = [];
  const replacementMissionResult = {
    structuredContent: {
      success: true,
      watch: { polls: 1, elapsedMs: 1, timedOut: true },
      missionSnapshot: { total: 1, eligible: 1 },
      claims: [
        {
          assignedMissionId: "claimed-old-id",
          success: true,
          reward: { balanceChange: { currency: "PBP", amount: 75 } },
        },
      ],
      missions: [mission("replacement-direct", 1)],
    },
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
    },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return replacementMissionResult;
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    async refreshMissionHeaderStats() {
      return { ok: true, stats: { available: 1 } };
    },
    async autoAssignConfiguredMissions(args) {
      assignmentInputs.push(args);
      return {
        attempted: 1,
        assigned: 1,
        missionResult: {
          structuredContent: {
            missions: [mission("replacement-direct", 1, "nft-direct")],
          },
        },
        missionStateAuthoritative: true,
      };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 0);
  assert.equal(assignmentInputs.length, 1);
  assert.equal(
    normalizeMissionList(assignmentInputs[0].missionsResult)[0]
      .assigned_mission_id,
    "replacement-direct",
  );
});

async function assertPostClaimThresholdReset(resetMode) {
  const callOrder = [];
  const assignmentInputs = [];
  const refreshedMissionIds = [];
  let missionReads = 0;
  const thresholdMission = {
    ...mission("replacement-level-5", 3),
    name: "Race for Points",
    current_level: 5,
    level: 5,
  };
  const rerolledMission = {
    ...mission("replacement-after-reset", 3),
    name: "Race for Points",
    current_level: 1,
    level: 1,
  };
  const claimedResult = {
    structuredContent: {
      success: true,
      watch: { polls: 1, elapsedMs: 1, timedOut: true },
      missionSnapshot: { total: 1, eligible: 1 },
      claims: [
        {
          assignedMissionId: "claimed-old-id",
          success: true,
          reward: { balanceChange: { currency: "PBP", amount: 75 } },
        },
      ],
      missions: [thresholdMission],
    },
  };
  const rerollResult = {
    structuredContent: { success: true, missions: [rerolledMission] },
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      missionResetLevel: "5",
      missionActionEnabledBySlot: { "3": true },
      missionResetPerSlotModeEnabled: true,
      missionResetPerSlotEnabledBySlot: {
        "1": false,
        "2": false,
        "3": false,
        "4": false,
      },
      ...resetMode,
    },
    currentMissionResetLevel: "5",
    missionActionEnabledBySlot: { "3": true },
    missionResetPerSlotModeEnabled: true,
    missionResetPerSlotEnabledBySlot: {
      "1": false,
      "2": false,
      "3": false,
      "4": false,
    },
    ...resetMode,
    signerMode: "local",
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      callOrder.push(toolName);
      if (toolName === "watch_and_claim") return claimedResult;
      if (toolName === "prepare_mission_reroll") {
        return {
          structuredContent: {
            success: true,
            assignedMissionId: "replacement-level-5",
            rerollCost: 0,
            transaction: "prepared",
            rerollToken: "token",
          },
        };
      }
      if (toolName === "submit_signed_mission_reroll") return rerollResult;
      throw new Error(`unexpected tool: ${toolName}`);
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    async refreshMissionHeaderStats(args = {}) {
      const refreshedMission = normalizeMissionList(args.missionsResult)[0];
      if (refreshedMission?.assigned_mission_id) {
        refreshedMissionIds.push(refreshedMission.assigned_mission_id);
      }
      return { ok: true, stats: { available: 0 } };
    },
    async autoAssignConfiguredMissions(args) {
      callOrder.push("assign_nft_to_mission");
      assignmentInputs.push(args);
      return {
        attempted: 1,
        assigned: 1,
        missionResult: {
          structuredContent: {
            missions: [
              { ...rerolledMission, assigned_nft: "nft-after-reset" },
            ],
          },
        },
        missionStateAuthoritative: true,
      };
    },
  };
  const signer = {
    ensureMissionActionSupported(actionName) {
      assert.equal(actionName, "mission_reroll");
    },
    async signPreparedMissionActionPayload(actionName) {
      assert.equal(actionName, "mission_reroll");
      return {
        submitTool: "submit_signed_mission_reroll",
        submitArgs: { encodedSignedTransaction: "signed" },
        cost: 0,
      };
    },
  };
  const watch = createWatchService(
    ctx,
    logger,
    mcp,
    checks,
    { saveConfig() {} },
    { signer },
  );

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 0);
  assert.deepEqual(callOrder, [
    "watch_and_claim",
    "prepare_mission_reroll",
    "submit_signed_mission_reroll",
    "assign_nft_to_mission",
  ]);
  assert.equal(assignmentInputs.length, 1);
  assert.ok(refreshedMissionIds.includes("replacement-after-reset"));
  assert.equal(
    normalizeMissionList(assignmentInputs[0].missionsResult)[0]
      .assigned_mission_id,
    "replacement-after-reset",
  );
}

test("manual mode reset completes before post-claim assignment", async () => {
  await assertPostClaimThresholdReset({ level20ResetEnabled: true });
});

test("mission mode reset completes before post-claim assignment", async () => {
  await assertPostClaimThresholdReset({ missionModeEnabled: true });
});

test("failed required reset blocks assignment of the threshold mission", async () => {
  let assignments = 0;
  const thresholdMission = {
    ...mission("replacement-level-5", 3),
    name: "Race for Points",
    current_level: 5,
    level: 5,
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      level20ResetEnabled: true,
      missionResetLevel: "5",
      missionActionEnabledBySlot: { "3": true },
    },
    currentMissionResetLevel: "5",
    level20ResetEnabled: true,
    missionActionEnabledBySlot: { "3": true },
    signerMode: "local",
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      if (toolName === "watch_and_claim") {
        return {
          structuredContent: {
            success: true,
            watch: { polls: 1, elapsedMs: 1, timedOut: true },
            missionSnapshot: { total: 1, eligible: 1 },
            claims: [{ assignedMissionId: "claimed-old-id", success: true }],
            missions: [thresholdMission],
          },
        };
      }
      if (toolName === "prepare_mission_reroll") {
        throw new Error("reroll rejected");
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
    async getUserMissions() {
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    async refreshMissionHeaderStats() {
      return { ok: true, stats: { available: 1 } };
    },
    async autoAssignConfiguredMissions() {
      assignments += 1;
      return { attempted: 1, assigned: 1 };
    },
  };
  const signer = {
    ensureMissionActionSupported() {},
    async signPreparedMissionActionPayload() {
      throw new Error("signing should not start");
    },
  };
  const watch = createWatchService(
    ctx,
    logger,
    mcp,
    checks,
    { saveConfig() {} },
    { signer },
  );

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(assignments, 0);
});

test("auto mode level-20 claim restores the prior mission before assignment", async () => {
  const callOrder = [];
  const assignmentInputs = [];
  const publishedMissionNames = [];
  let missionReads = 0;
  const replacement = {
    ...mission("random-replacement", 3),
    name: "Different Mission",
    current_level: 1,
    level: 1,
  };
  const restored = {
    ...mission("restored-race", 3),
    name: "Race for Points",
    current_level: 1,
    level: 1,
  };
  const completedBeforeClaim = {
    ...mission("claimed-level-20", 3, "level-20-nft"),
    name: "Race for Points",
    current_level: 20,
    level: 20,
    completed: true,
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      autoModeEnabled: true,
      autoModeMissionRestoreDelayMs: 0,
      missionActionEnabledBySlot: { "3": true },
    },
    autoModeEnabled: true,
    missionActionEnabledBySlot: { "3": true },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    lastUserMissionsResult: {
      structuredContent: { missions: [completedBeforeClaim] },
    },
    lastUserMissionsFetchedAt: Date.now(),
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      callOrder.push(toolName);
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 1 },
          claims: [
            {
              assignedMissionId: "claimed-level-20",
              success: true,
            },
          ],
          missions: [replacement],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    filterSelectedMissions(missions) {
      return missions;
    },
    isConfiguredTargetMission() {
      return true;
    },
    async applyMissionSelection({ slot, missionName, missionsResult }) {
      callOrder.push("restore_mission");
      assert.equal(slot, 3);
      assert.equal(missionName, "Race for Points");
      assert.equal(
        normalizeMissionList(missionsResult)[0].assigned_mission_id,
        "random-replacement",
      );
      return {
        ok: true,
        changed: true,
        swapped: true,
        missionResult: { structuredContent: { missions: [restored] } },
        missionStateAuthoritative: true,
      };
    },
    async refreshMissionHeaderStats({ missionsResult } = {}) {
      const publishedName = normalizeMissionList(missionsResult)[0]?.name;
      if (publishedName) publishedMissionNames.push(publishedName);
      return { ok: true, stats: { available: 0 } };
    },
    async autoAssignConfiguredMissions(args) {
      callOrder.push("assign_nft_to_mission");
      assignmentInputs.push(args);
      return {
        attempted: 1,
        assigned: 1,
        missionResult: {
          structuredContent: {
            missions: [{ ...restored, assigned_nft: "auto-nft" }],
          },
        },
        missionStateAuthoritative: true,
      };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 0);
  assert.deepEqual(callOrder, [
    "watch_and_claim",
    "restore_mission",
    "assign_nft_to_mission",
  ]);
  assert.equal(
    normalizeMissionList(assignmentInputs[0].missionsResult)[0].name,
    "Race for Points",
  );
  assert.deepEqual(publishedMissionNames, ["Race for Points"]);
});

test("auto mode blocks assignment when required restore lacks mutation missions", async () => {
  let missionReads = 0;
  let assignments = 0;
  const replacement = {
    ...mission("random-replacement", 3),
    name: "Different Mission",
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      autoModeEnabled: true,
      autoModeMissionRestoreDelayMs: 0,
      missionActionEnabledBySlot: { "3": true },
    },
    autoModeEnabled: true,
    missionActionEnabledBySlot: { "3": true },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 1 },
          claims: [
            {
              assignedMissionId: "claimed-level-20",
              missionName: "Race for Points",
              currentLevel: 20,
              slot: 3,
              success: true,
            },
          ],
          missions: [replacement],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    isConfiguredTargetMission() {
      return true;
    },
    async applyMissionSelection({ missionsResult }) {
      assert.equal(
        normalizeMissionList(missionsResult)[0].assigned_mission_id,
        "random-replacement",
      );
      return {
        ok: true,
        changed: true,
        swapped: true,
        missionResult: null,
        missionStateAuthoritative: false,
        mutationStateMissing: true,
      };
    },
    async refreshMissionHeaderStats() {
      return { ok: true, stats: { available: 1 } };
    },
    async autoAssignConfiguredMissions() {
      assignments += 1;
      return { attempted: 1, assigned: 1 };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 0);
  assert.equal(assignments, 0);
});

test("same-cycle level-20 fallback poll never publishes the replacement mission", async () => {
  const publishedMissionNames = [];
  let missionReads = 0;
  let assignments = 0;
  const completed = {
    ...mission("claimed-level-20", 3, "level-20-nft"),
    name: "Race for Points",
    current_level: 20,
    level: 20,
    completed: true,
  };
  const replacement = {
    ...mission("random-replacement", 3),
    name: "Different Mission",
    current_level: 1,
    level: 1,
  };
  const restored = {
    ...mission("restored-race", 3),
    name: "Race for Points",
    current_level: 1,
    level: 1,
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
      autoModeEnabled: true,
      autoModeMissionRestoreDelayMs: 0,
      missionActionEnabledBySlot: { "3": true },
    },
    autoModeEnabled: true,
    missionActionEnabledBySlot: { "3": true },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    lastUserMissionsResult: {
      structuredContent: { missions: [completed] },
    },
    lastUserMissionsFetchedAt: Date.now() - 60_000,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 1 },
          claims: [
            { assignedMissionId: "claimed-level-20", success: true },
          ],
        },
      };
    },
    invalidateUserMissionsSnapshot() {},
    getToolCooldownRemainingMs() {
      return 0;
    },
    async getUserMissions() {
      missionReads += 1;
      return { structuredContent: { missions: [replacement] } };
    },
  };
  const checks = {
    filterSelectedMissions(missions) {
      return missions;
    },
    isConfiguredTargetMission() {
      return true;
    },
    async applyMissionSelection({ publishMissionState }) {
      assert.equal(publishMissionState, false);
      return {
        ok: true,
        changed: true,
        swapped: true,
        missionResult: { structuredContent: { missions: [restored] } },
        missionStateAuthoritative: true,
      };
    },
    async refreshMissionHeaderStats({ missionsResult } = {}) {
      const name = normalizeMissionList(missionsResult)[0]?.name;
      if (name) publishedMissionNames.push(name);
      return { ok: true, stats: { available: 0 } };
    },
    async autoAssignConfiguredMissions() {
      assignments += 1;
      return {
        attempted: 1,
        assigned: 1,
        missionResult: {
          structuredContent: {
            missions: [{ ...restored, assigned_nft: "auto-nft" }],
          },
        },
        missionStateAuthoritative: true,
      };
    },
  };

  const result = await createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  }).runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 1);
  assert.equal(assignments, 1);
  assert.deepEqual(publishedMissionNames, ["Race for Points"]);
});

test("mission restore swaps the claim replacement rather than stale cached mission", async () => {
  let missionReads = 0;
  const staleMissionResult = {
    structuredContent: {
      missions: [
        {
          ...mission("old-preclaim-id", 3),
          mission_id: "race-catalog-id",
          name: "Race for Points",
        },
      ],
    },
  };
  const replacementMissionResult = {
    structuredContent: {
      missions: [
        {
          ...mission("replacement-id", 3),
          mission_id: "different-catalog-id",
          name: "Different Mission",
        },
      ],
    },
  };
  const restoredMissionResult = {
    structuredContent: {
      missions: [
        {
          ...mission("restored-id", 3),
          mission_id: "race-catalog-id",
          name: "Race for Points",
        },
      ],
    },
  };
  const ctx = {
    config: {
      targetMissions: ["Race for Points"],
      missionActionEnabledBySlot: { "3": true },
    },
    missionActionEnabledBySlot: { "3": true },
    signerMode: "local",
    lastUserMissionsResult: staleMissionResult,
    missionCatalogEntries: [
      {
        id: "race-catalog-id",
        mission_id: "race-catalog-id",
        name: "Race for Points",
      },
    ],
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName, args) {
      if (toolName === "prepare_mission_swap") {
        assert.equal(args.assignedMissionId, "replacement-id");
        assert.equal(args.chosenMissionId, "race-catalog-id");
        return {
          structuredContent: {
            success: true,
            assignedMissionId: "replacement-id",
            chosenMissionId: "race-catalog-id",
            swapCost: 0,
            transaction: "prepared",
          },
        };
      }
      if (toolName === "submit_signed_mission_swap") {
        return restoredMissionResult;
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
  };
  const signer = {
    ensureMissionActionSupported(actionName) {
      assert.equal(actionName, "mission_swap");
    },
    async signPreparedMissionActionPayload(actionName) {
      assert.equal(actionName, "mission_swap");
      return {
        submitTool: "submit_signed_mission_swap",
        submitArgs: { encodedSignedTransaction: "signed" },
        cost: 0,
      };
    },
  };
  const checks = createChecksService(ctx, logger, mcp, { signer });

  const result = await checks.applyMissionSelection({
    slot: 3,
    missionName: "Race for Points",
    missionsResult: replacementMissionResult,
  });

  assert.equal(result.ok, true);
  assert.equal(result.swapped, true);
  assert.equal(result.missionStateAuthoritative, true);
  assert.equal(missionReads, 0);
  assert.equal(
    normalizeMissionList(result.missionResult)[0].assigned_mission_id,
    "restored-id",
  );
});

test("auto mode rerolls an open level-20 mission when no NFT is available", async () => {
  const callOrder = [];
  const level20Mission = {
    ...mission("open-level-20", 1),
    current_level: 20,
    level: 20,
  };
  const rerolledMission = {
    ...mission("after-auto-reroll", 1),
    current_level: 1,
    level: 1,
  };
  const ctx = {
    config: {
      autoModeEnabled: true,
      targetMissions: ["mission-1"],
      missionActionEnabledBySlot: { "1": true },
      enableRentals: false,
    },
    autoModeEnabled: true,
    missionActionEnabledBySlot: { "1": true },
    signerMode: "local",
    currentMissionStats: { nftsAvailable: 0 },
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    invalidateUserMissionsSnapshot() {},
    async getUserMissions() {
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName) {
      callOrder.push(toolName);
      if (toolName === "get_mission_nfts") {
        return { structuredContent: { nfts: [] } };
      }
      if (toolName === "prepare_mission_reroll") {
        return {
          structuredContent: {
            success: true,
            assignedMissionId: "open-level-20",
            rerollCost: 0,
            transaction: "prepared",
            rerollToken: "token",
          },
        };
      }
      if (toolName === "submit_signed_mission_reroll") {
        return {
          structuredContent: { success: true, missions: [rerolledMission] },
        };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
  };
  const signer = {
    ensureMissionActionSupported(actionName) {
      assert.equal(actionName, "mission_reroll");
    },
    async signPreparedMissionActionPayload(actionName) {
      assert.equal(actionName, "mission_reroll");
      return {
        submitTool: "submit_signed_mission_reroll",
        submitArgs: { encodedSignedTransaction: "signed" },
        cost: 0,
      };
    },
  };
  const checks = createChecksService(ctx, logger, mcp, { signer });

  const result = await checks.autoAssignConfiguredMissions({
    reason: "post_claim",
    missionsResult: { structuredContent: { missions: [level20Mission] } },
  });

  assert.equal(result.assigned, 0);
  assert.deepEqual(callOrder, [
    "get_mission_nfts",
    "prepare_mission_reroll",
    "submit_signed_mission_reroll",
  ]);
});

test("failed same-cycle post-claim state read is neither published nor assigned", async () => {
  let missionReads = 0;
  let refreshes = 0;
  let assignments = 0;
  const staleMissionResult = {
    structuredContent: {
      missions: { missions: [mission("claimed-old-id", 1, "old-nft")] },
    },
  };
  const ctx = {
    config: {
      totalClaimed: 0,
      watchPollIntervalSeconds: 60,
      watchRequestSeconds: 1,
    },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    currentMissionStats: {},
    sessionClaimedCount: 0,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  let invalidations = 0;
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 1 },
          claims: [
            {
              assignedMissionId: "claimed-old-id",
              success: true,
              reward: { balanceChange: { currency: "PBP", amount: 75 } },
            },
          ],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("mission state temporarily unavailable");
    },
    invalidateUserMissionsSnapshot(reason) {
      invalidations += 1;
      assert.equal(reason, "watch_claim_mutation_without_missions");
    },
  };
  const checks = {
    async refreshMissionHeaderStats() {
      refreshes += 1;
      return { ok: true };
    },
    async autoAssignConfiguredMissions() {
      assignments += 1;
      return { attempted: 0, assigned: 0 };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 1);
  assert.equal(missionReads, 1);
  assert.equal(refreshes, 0);
  assert.equal(assignments, 0);
  assert.equal(invalidations, 1);
});

test("fresh startup mission snapshot prevents an immediate duplicate mission read", async () => {
  let missionReads = 0;
  let refreshedWith = null;
  const liveMissions = {
    structuredContent: {
      missions: {
        missions: [mission("live-1", 1, "nft-live")],
      },
    },
  };
  const ctx = {
    config: { watchPollIntervalSeconds: 60, watchRequestSeconds: 1 },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    lastUserMissionsResult: liveMissions,
    lastUserMissionsFetchedAt: Date.now(),
    startupAccountSnapshot: {
      cachedAt: Date.now(),
      missionsResult: liveMissions,
    },
    currentMissionStats: {},
    guiMissionSlots: [],
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 0 },
          claims: [],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
  };
  const checks = {
    filterSelectedMissions(missions) {
      return missions;
    },
    async refreshMissionHeaderStats({ missionsResult }) {
      refreshedWith = missionsResult;
      ctx.currentMissionStats = { total: 1, active: 1, available: 0 };
      return { ok: true, stats: ctx.currentMissionStats };
    },
    async autoAssignConfiguredMissions() {
      return { attempted: 0, assigned: 0, missionResult: liveMissions };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 0);
  assert.equal(missionReads, 0);
  assert.equal(refreshedWith, liveMissions);
  assert.equal(ctx.currentMissionStats.active, 1);
});

test("wallet-only startup does not suppress the watcher's first mission poll", async () => {
  let missionReads = 0;
  let refreshedWith = null;
  const liveMissions = {
    structuredContent: {
      missions: {
        missions: [mission("live-1", 1, "nft-live")],
      },
    },
  };
  const ctx = {
    config: { watchPollIntervalSeconds: 60, watchRequestSeconds: 1 },
    runtimeDefaults: {
      watchDefaultPollSeconds: 60,
      watchRequestSeconds: 1,
      watchMaxLimitSeconds: 240,
      watchMinCycleSeconds: 30,
    },
    watchLoopEnabled: true,
    watcherRunning: true,
    lastUserMissionsResult: null,
    lastUserMissionsFetchedAt: 0,
    startupAccountSnapshot: {
      cachedAt: Date.now(),
      walletSummaryResult: { structuredContent: { success: true } },
    },
    currentMissionStats: {},
    guiMissionSlots: [],
    missionDataLoading: true,
    guiBridge: { sendEvent() {}, emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async mcpToolCall(toolName) {
      assert.equal(toolName, "watch_and_claim");
      return {
        structuredContent: {
          success: true,
          watch: { polls: 1, elapsedMs: 1, timedOut: true },
          missionSnapshot: { total: 1, eligible: 0 },
          claims: [],
        },
      };
    },
    async getUserMissions() {
      missionReads += 1;
      return liveMissions;
    },
  };
  const checks = {
    filterSelectedMissions(missions) {
      return missions;
    },
    async refreshMissionHeaderStats({ missionsResult }) {
      refreshedWith = missionsResult;
      ctx.currentMissionStats = { total: 1, active: 1, available: 0 };
      ctx.missionDataLoading = false;
      return { ok: true, stats: ctx.currentMissionStats };
    },
    async autoAssignConfiguredMissions() {
      return { attempted: 0, assigned: 0, missionResult: liveMissions };
    },
  };
  const watch = createWatchService(ctx, logger, mcp, checks, {
    saveConfig() {},
  });

  const result = await watch.runWatchCycle();

  assert.equal(result.claimed, 0);
  assert.equal(missionReads, 1);
  assert.equal(refreshedWith, liveMissions);
  assert.equal(ctx.currentMissionStats.active, 1);
  assert.equal(ctx.missionDataLoading, false);
});

test("two claims use the second claim mutation as authoritative state", () => {
  const afterFirstClaim = {
    structuredContent: {
      missions: [mission("replacement-1", 1), mission("old-2", 2, "nft")],
    },
  };
  const afterSecondClaim = {
    structuredContent: {
      missions: [mission("replacement-1", 1), mission("replacement-2", 2)],
    },
  };
  const result = latestMissionResultFromClaims([
    { assignedMissionId: "old-1", claimResult: afterFirstClaim },
    { assignedMissionId: "old-2", response: afterSecondClaim },
  ]);

  assert.equal(result, afterSecondClaim);
  assert.deepEqual(
    normalizeMissionList(result).map((entry) => entry.assigned_mission_id),
    ["replacement-1", "replacement-2"],
  );
});

test("authoritative NFT inventory refresh excludes assigned accounts without another mission read", async () => {
  let missionReads = 0;
  let inventoryReads = 0;
  let inventoryPoll = 0;
  const ctx = {
    config: { targetMissions: [] },
    currentMissionStats: {},
    sessionClaimedCount: 0,
    lastUserMissionsResult: { marker: "transport-cache" },
    lastUserMissionsFetchedAt: 123,
    guiBridge: { emitNow() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName) {
      assert.equal(toolName, "get_mission_nfts");
      inventoryReads += 1;
      inventoryPoll += 1;
      return {
        structuredContent: {
          nfts: [
            { account: "assigned-nft", onCooldown: false },
            {
              account: "available-nft",
              onCooldown: inventoryPoll > 1,
            },
          ],
        },
      };
    },
  };
  const checks = createChecksService(ctx, logger, mcp);
  const missionsResult = {
    structuredContent: {
      missions: {
        missions: [mission("mission-1", 1, "assigned-nft")],
      },
    },
  };

  const result = await checks.refreshMissionHeaderStats({
    missionsResult,
    refreshNftCount: true,
    hydrateAssignedMetadata: false,
  });

  assert.equal(result.ok, true);
  assert.equal(inventoryReads, 1);
  assert.equal(missionReads, 0);
  assert.equal(ctx.currentMissionStats.nftsTotal, 2);
  assert.equal(ctx.currentMissionStats.nftsAvailable, 1);

  await checks.refreshMissionHeaderStats({
    missionsResult,
    refreshNftCount: true,
    hydrateAssignedMetadata: false,
  });
  assert.equal(inventoryReads, 2);
  assert.equal(missionReads, 0);
  assert.equal(ctx.currentMissionStats.nftsAvailable, 0);
  assert.deepEqual(ctx.lastUserMissionsResult, { marker: "transport-cache" });
  assert.equal(ctx.lastUserMissionsFetchedAt, 123);
});

test("an older accepted mission snapshot cannot roll cards back after a mutation", async () => {
  const oldResult = {
    structuredContent: {
      missions: [{ ...mission("mission-1", 1), current_level: 4, level: 4 }],
    },
  };
  const mutationResult = {
    structuredContent: {
      missions: [{ ...mission("mission-1", 1), current_level: 5, level: 5 }],
    },
  };
  const revisions = new WeakMap([
    [oldResult, 1],
    [mutationResult, 2],
  ]);
  const ctx = {
    config: { targetMissions: ["mission-1"], totalClaimed: 0 },
    currentMissionStats: {},
    sessionClaimedCount: 0,
    lastUserMissionsResult: mutationResult,
    guiMissionSlots: [],
    guiBridge: { emitNow() {}, sendEvent() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    getMissionSnapshotRevision(result) {
      return revisions.get(result) ?? null;
    },
    getCurrentMissionSnapshotRevision() {
      return 2;
    },
  };
  const checks = createChecksService(ctx, logger, mcp);

  const mutationRefresh = await checks.refreshMissionHeaderStats({
    missionsResult: mutationResult,
    hydrateAssignedMetadata: false,
  });
  assert.equal(mutationRefresh.ok, true);
  assert.equal(ctx.guiMissionSlots[0].missionLevel, 5);

  const staleRefresh = await checks.refreshMissionHeaderStats({
    missionsResult: oldResult,
    hydrateAssignedMetadata: false,
  });
  assert.equal(staleRefresh.superseded, true);
  assert.equal(staleRefresh.staleMissionSnapshot, true);
  assert.equal(ctx.guiMissionSlots[0].missionLevel, 5);
});

test("one assignment pass fills every open configured slot without a mission read", async () => {
  let missionReads = 0;
  let inventoryReads = 0;
  const inventoryOffsets = [];
  const assignedIds = [];
  const assignedAccounts = [];
  const callOrder = [];
  let liveMissions = [mission("open-1", 1), mission("open-2", 2)];
  const ctx = {
    config: {
      targetMissions: ["mission-1", "mission-2"],
      nftAssignmentOrder: "normal",
      missionActionEnabledBySlot: { "1": true, "2": true },
    },
    missionActionEnabledBySlot: { "1": true, "2": true },
    currentMissionStats: { nftsAvailable: 2 },
    sessionClaimedCount: 0,
    guiBridge: { emitNow() {}, sendEvent() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      missionReads += 1;
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName, args) {
      if (toolName === "get_mission_nfts") {
        callOrder.push(`inventory:${args.assignedMissionId}`);
        inventoryReads += 1;
        inventoryOffsets.push(Number(args?.offset || 0));
        return {
          structuredContent: {
            nfts: [
              { account: "nft-a", onCooldown: false },
              { account: "nft-b", onCooldown: false },
            ],
          },
        };
      }
      if (toolName === "assign_nft_to_mission") {
        callOrder.push(`assign:${args.assignedMissionId}`);
        assignedIds.push(args.assignedMissionId);
        assignedAccounts.push(args.nftAccount);
        liveMissions = liveMissions.map((entry) =>
          entry.assigned_mission_id === args.assignedMissionId
            ? { ...entry, assigned_nft: args.nftAccount }
            : entry,
        );
        return { structuredContent: { missions: liveMissions } };
      }
      if (toolName === "get_nft") {
        return { structuredContent: { nfts: [] } };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
  };
  const checks = createChecksService(ctx, logger, mcp);
  const missionsResult = {
    structuredContent: { missions: { missions: liveMissions } },
  };

  const result = await checks.autoAssignConfiguredMissions({
    reason: "poll_tick_available_recheck",
    missionsResult,
  });

  assert.equal(result.assigned, 2);
  assert.deepEqual(assignedIds, ["open-1", "open-2"]);
  assert.deepEqual(assignedAccounts, ["nft-a", "nft-b"]);
  assert.equal(inventoryReads, 2);
  assert.deepEqual(inventoryOffsets, [0, 0]);
  assert.deepEqual(callOrder, [
    "inventory:open-1",
    "inventory:open-2",
    "assign:open-1",
    "assign:open-2",
  ]);
  assert.equal(missionReads, 0);
  assert.equal(ctx.currentMissionStats.nftsAvailable, 0);
});

test("ownership rejection tries the next NFT and releases assigning UI state", async () => {
  const assignmentAccounts = [];
  const assigningEvents = [];
  let liveMissions = [mission("open-1", 1)];
  const ctx = {
    config: {
      targetMissions: ["mission-1"],
      nftAssignmentOrder: "normal",
      missionActionEnabledBySlot: { "1": true },
    },
    missionActionEnabledBySlot: { "1": true },
    currentMissionStats: { nftsAvailable: 2 },
    sessionClaimedCount: 0,
    guiBridge: {
      emitNow() {},
      sendEvent(type, payload) {
        if (type === "assigning") assigningEvents.push(payload);
      },
    },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName, args) {
      if (toolName === "get_mission_nfts") {
        return {
          structuredContent: {
            nfts: [
              { account: "a-stale-nft", onCooldown: false },
              { account: "b-owned-nft", onCooldown: false },
            ],
          },
        };
      }
      if (toolName === "assign_nft_to_mission") {
        assignmentAccounts.push(args.nftAccount);
        if (args.nftAccount === "a-stale-nft") {
          return {
            structuredContent: {
              success: false,
              details: { message: "NFT is no longer owned by user" },
            },
          };
        }
        liveMissions = liveMissions.map((entry) => ({
          ...entry,
          assigned_nft: args.nftAccount,
        }));
        return { structuredContent: { missions: liveMissions } };
      }
      if (toolName === "get_nft") {
        return { structuredContent: { nfts: [] } };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
  };
  const checks = createChecksService(ctx, logger, mcp);

  const result = await checks.autoAssignConfiguredMissions({
    reason: "poll_tick_available_recheck",
    missionsResult: {
      structuredContent: { missions: { missions: liveMissions } },
    },
  });

  assert.equal(result.assigned, 1);
  assert.deepEqual(assignmentAccounts, ["a-stale-nft", "b-owned-nft"]);
  assert.equal(ctx.autoAssignRunning, false);
  assert.equal(assigningEvents.at(-1)?.state, "done");
  assert.equal(assigningEvents.some((event) => event.state === "error"), false);
});

test("NFT lookup cooldown exits assignment immediately and releases assigning UI state", async () => {
  const assigningEvents = [];
  const ctx = {
    config: {
      targetMissions: ["mission-1"],
      missionActionEnabledBySlot: { "1": true },
    },
    missionActionEnabledBySlot: { "1": true },
    currentMissionStats: { nftsAvailable: 1 },
    guiBridge: {
      emitNow() {},
      sendEvent(type, payload) {
        if (type === "assigning") assigningEvents.push(payload);
      },
    },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName) {
      assert.equal(toolName, "get_mission_nfts");
      const error = new Error("rate limited; retry in 60s");
      error.rateLimited = true;
      error.retryAfterSeconds = 60;
      throw error;
    },
  };
  const checks = createChecksService(ctx, logger, mcp);
  const missionsResult = {
    structuredContent: {
      missions: { missions: [mission("open-1", 1)] },
    },
  };

  const startedAt = Date.now();
  const result = await checks.autoAssignConfiguredMissions({
    reason: "post_claim",
    missionsResult,
  });

  assert.equal(result.assigned, 0);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(ctx.autoAssignRunning, false);
  assert.equal(assigningEvents.at(-1)?.state, "done");
  assert.equal(checks.hasAssignableConfiguredMissions(missionsResult), true);
});

test("each assignment response is propagated and missing mutation state halts", () => {
  const checksSource = fs.readFileSync(
    path.join(repoRoot, "src/services/checks.js"),
    "utf8",
  );

  assert.match(checksSource, /currentMissionResult = assignResult;\s*missions = responseMissions;/);
  assert.match(
    checksSource,
    /assign_nft_to_mission succeeded without authoritative missions state/,
  );
  assert.doesNotMatch(
    checksSource,
    /patchMissionResultAfterAssignment\(currentMissionResult/,
  );
  assert.equal(
    shouldRetryAssignmentOption({
      abortedForMutationState: true,
      source: "rental",
      hasNext: true,
      retryable: true,
    }),
    false,
  );
  assert.equal(
    shouldRetryAssignmentOption({
      source: "owned",
      hasNext: true,
      retryable: false,
    }),
    true,
  );
  assert.match(checksSource, /const AUTO_ASSIGN_MAX_STARTS_PER_PASS = 4;/);
  assert.equal(
    shouldRetryAssignmentOption({
      abortedForMutationState: true,
      source: "owned_cooldown",
      hasNext: true,
    }),
    false,
  );
});

test("successful claims and assignments have no confirmation-read fallbacks", () => {
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );
  const checksSource = fs.readFileSync(
    path.join(repoRoot, "src/services/checks.js"),
    "utf8",
  );
  const mcpClientSource = fs.readFileSync(
    path.join(repoRoot, "src/mcp/client.js"),
    "utf8",
  );
  const electronSource = fs.readFileSync(
    path.join(repoRoot, "electron/main.js"),
    "utf8",
  );

  assert.doesNotMatch(watchSource, /post_claim_settle_wait/);
  assert.doesNotMatch(watchSource, /after_assign_legacy_fallback/);
  assert.doesNotMatch(watchSource, /after_fallback_assign/);
  assert.doesNotMatch(watchSource, /claim_followup_refetched_after_assign/);
  assert.doesNotMatch(watchSource, /reason: "watch_reported_zero"/);
  assert.doesNotMatch(watchSource, /scheduleCurrentWalletSummaryRefresh/);
  assert.match(watchSource, /reason: "startup_missing_snapshot_refresh"/);
  assert.match(watchSource, /reason: "startup_background_mission_refresh"/);
  assert.doesNotMatch(electronSource, /reason: "startup_mission_sync"/);
  assert.doesNotMatch(
    `${watchSource}\n${checksSource}`,
    /scheduleFundingWalletRefresh\([^)]*reward_/,
  );
  assert.match(watchSource, /applyWalletBalanceDeltas\(/);
  assert.match(watchSource, /assignResult\?\.mutationStateMissing === true/);
  assert.doesNotMatch(
    watchSource,
    /currentClaimed > 0 && !missionStateAuthoritative[\s\S]{0,500}ctx\.missionMutationStateBlockedUntil = Date\.now\(\) \+ 60_000;/,
  );
  assert.doesNotMatch(
    `${watchSource}\n${checksSource}`,
    /missionMutationStateBlockedUntil = Date\.now\(\) \+ 60_000/,
  );
  assert.doesNotMatch(
    checksSource,
    /lastUserMissionsFetchedAt\s*=\s*Date\.now\(\)/,
  );
  assert.doesNotMatch(
    mcpClientSource,
    /shouldInvalidateUserMissionsSnapshot[\s\S]{0,500}"watch_and_claim"/,
  );
  assert.match(
    watchSource,
    /!hasClaimActivity &&\s*\(clientPollingEnabled \|\| !postCycleMissionResult\)/,
  );
});

test("first-run App Wallet creation cannot start the mission watcher", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );
  const electronSource = fs.readFileSync(
    path.join(repoRoot, "electron/main.js"),
    "utf8",
  );
  const appSource = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");

  assert.match(
    rendererSource,
    /startBackend\(\{ startPaused: true \}\)/,
  );
  assert.match(rendererSource, /startedBackendForWallet[\s\S]{0,1200}stopBackend\(\)/);
  assert.match(electronSource, /PBP_START_PAUSED: "1"/);
  assert.match(electronSource, /PBP_LOCAL_ACTION_ONLY: "1"/);
  assert.match(appSource, /const START_PAUSED = process\.env\.PBP_START_PAUSED === "1";/);
  assert.match(
    appSource,
    /if \(LOCAL_ACTION_ONLY\)[\s\S]{0,500}MCP startup checks skipped/,
  );
  assert.match(appSource, /if \(START_PAUSED \|\| START_PAUSED_FOR_COMP_LOCK\)/);
});

test("onboarding persists the existing per-slot automation controls", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );
  const electronSource = fs.readFileSync(
    path.join(repoRoot, "electron/main.js"),
    "utf8",
  );

  assert.match(
    rendererSource,
    /switchID={`onboarding-slot-action-enabled-\$\{slot\}`}/,
  );
  assert.match(rendererSource, /setOnboardingMissionActionEnabledBySlot/);
  assert.match(
    rendererSource,
    /applyOnboardingSelection\(\{[\s\S]{0,350}missionActionEnabledBySlot/,
  );
  assert.match(
    electronSource,
    /missionActionEnabledBySlot: normalizeMissionActionEnabledBySlot\(/,
  );
});

test("runner startup synchronizes every assigned MCP slot before assignment", () => {
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.match(
    watchSource,
    /syncTargetsFromAssigned: true,\s*syncReason: "startup_snapshot"/,
  );
  assert.match(
    watchSource,
    /syncTargetsFromAssigned: true,\s*syncReason: "startup_missing_snapshot_refresh"/,
  );
  assert.match(
    watchSource,
    /syncTargetsFromAssigned: true,\s*syncReason: "startup_background_mission_refresh"/,
  );
});

test("onboarding cannot apply before mission rows seed the slot selections", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );

  assert.match(rendererSource, /setOnboardingMissionStateReady\(missions\.length > 0\)/);
  assert.match(
    rendererSource,
    /if \(!onboardingMissionStateReady\)[\s\S]{0,250}Wait for mission status to finish syncing/,
  );
  assert.match(
    rendererSource,
    /onboardingDataLoading \|\|\s*!onboardingMissionStateReady/,
  );
});

test("mission cards distinguish stopped unsynced state from running sync", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.match(
    rendererSource,
    /status\.running === true\s*&&\s*status\.missionDataLoading === true/,
  );
  assert.match(rendererSource, /label="SYNCING MISSION DATA\.\.\."/);
  assert.match(rendererSource, /label="MISSION STATUS NOT SYNCED"/);
  assert.match(
    watchSource,
    /startup_mission_refresh_deferred[\s\S]{0,500}scheduleStartupMissionRefresh/,
  );
});

test("per-slot mission reset overrides are always visible and self-enable", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );

  assert.match(rendererSource, /const perSlotMissionResetControlsVisible = true/);
  assert.match(rendererSource, /const perSlotMissionResetControlsDisabled = false/);
  assert.match(
    rendererSource,
    /const nextPerSlotModeEnabled =\s*missionResetPerSlotModeEnabled === true \|\| enabled === true/,
  );
  assert.match(
    rendererSource,
    /missionResetPerSlotModeEnabled: nextPerSlotModeEnabled,\s*missionResetPerSlotEnabledBySlot: nextEnabledBySlot/,
  );
});

test("activity status timeout survives unrelated backend events", () => {
  const rendererSource = fs.readFileSync(
    path.join(repoRoot, "renderer/src/pages/ControlPage.jsx"),
    "utf8",
  );

  assert.match(rendererSource, /const activityResetTimerRef = useRef\(null\)/);
  assert.match(
    rendererSource,
    /activityResetTimerRef\.current = setTimeout\([\s\S]{0,700}Watching missions/,
  );
  assert.doesNotMatch(
    rendererSource,
    /activityResetTimerRef\.current = setTimeout\([\s\S]{0,700}return \(\) => clearTimeout\(timer\)/,
  );
});

test("NFT count deferrals keep a stable reason and prefer cycle mutation state", () => {
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.doesNotMatch(watchSource, /\$\{reason\}_claim_state_pending/);
  assert.doesNotMatch(watchSource, /\$\{reason\}_assignment_priority/);
  assert.match(
    watchSource,
    /ctx\.lastUserMissionsResult \|\| startupMissionResult\(\) \|\| missionsResult/,
  );
  assert.match(watchSource, /preserveMissionState: true/);
  assert.match(
    watchSource,
    /missionResult: postCycleMissionResult/,
  );
});

test("watch mutation state replaces passive cache and rejects pre-mutation polls", () => {
  const clientSource = fs.readFileSync(
    path.join(repoRoot, "src/mcp/client.js"),
    "utf8",
  );
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.match(clientSource, /function adoptUserMissionsSnapshot/);
  assert.match(clientSource, /function getUserMissionsGeneration/);
  assert.match(clientSource, /function rejectOrReplaceStaleMissionRead/);
  assert.match(clientSource, /stale_mission_read_replaced/);
  assert.match(clientSource, /stale_mission_read_rejected/);
  assert.match(clientSource, /userMissionsAcceptedRequestSequence/);
  assert.match(
    clientSource,
    /return toolName === "get_user_missions"[\s\S]{0,300}rejectOrReplaceStaleMissionRead/,
  );
  assert.match(
    watchSource,
    /mcp\.adoptUserMissionsSnapshot\(\s*watchMissionResult,\s*"watch_and_claim"/,
  );
  assert.match(watchSource, /missionResultCoordinator\.seed\(watchMissionResult\)/);
  assert.match(watchSource, /mission_state_poll_rejected_pre_mutation/);
  assert.match(watchSource, /!missionPollRejectedPreMutation/);
});

test("mission UI polling keeps 2 seconds of additional cooldown headroom", () => {
  const clientSource = fs.readFileSync(
    path.join(repoRoot, "src/mcp/client.js"),
    "utf8",
  );
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.match(
    clientSource,
    /\["get_user_missions", \{ limit: 10, windowMs: 60_000 \}\]/,
  );
  assert.doesNotMatch(
    clientSource,
    /\["get_user_missions", 60_000\]/,
  );
  assert.match(watchSource, /MISSION_UI_POLL_HEADROOM_MS = 2_000/);
  assert.match(
    watchSource,
    /WATCH_START_INTERVAL_MS = 60_000 \+ MISSION_UI_POLL_HEADROOM_MS/,
  );
  assert.match(
    watchSource,
    /refreshWatchCycleMissionUi\("watch_cycle_ui_state_poll"\)/,
  );
  assert.match(watchSource, /reason: "watch_cycle_pre_start_ui_state_poll"/);
  assert.match(watchSource, /\}, 31_000\);/);
  assert.doesNotMatch(watchSource, /mission_result_short_throttle_retry/);
  assert.match(
    watchSource,
    /claim_poll_ui_publish_deferred/,
  );
});

test("100k and 500k NFTs are never assigned to lower-level missions", async () => {
  const assignedAccounts = [];
  const openMission = {
    ...mission("lower-level-open", 1),
    name: "Race for Points",
    level: 9,
  };
  const ctx = {
    config: {
      targetMissions: ["Race for Points"],
      enableRentals: true,
      nftAssignmentOrder: "normal",
      missionActionEnabledBySlot: { "1": true },
    },
    missionActionEnabledBySlot: { "1": true },
    currentMissionStats: { nftsAvailable: 0 },
    sessionClaimedCount: 0,
    guiBridge: { emitNow() {}, sendEvent() {} },
  };
  const logger = {
    logWithTimestamp() {},
    logDebug() {},
    redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, message) {
      return message;
    },
  };
  const mcp = {
    async getUserMissions() {
      throw new Error("unexpected get_user_missions");
    },
    async mcpToolCall(toolName, args) {
      if (toolName === "get_mission_nfts") {
        return { structuredContent: { nfts: [] } };
      }
      if (toolName === "get_rentable_nfts") {
        return {
          structuredContent: {
            data: [
              {
                listingId: "reserved-listing",
                nftData: { account: "reserved-100k", collection: "100K" },
              },
              {
                listingId: "standard-listing",
                nft: { account: "standard-nft", collection: "Genesis" },
              },
            ],
          },
        };
      }
      if (toolName === "get_nft") {
        return { structuredContent: { nft: { account: args.nftAccount } } };
      }
      if (toolName === "assign_nft_to_mission") {
        assignedAccounts.push(args.nftAccount);
        return {
          structuredContent: {
            missions: [{ ...openMission, assigned_nft: args.nftAccount }],
          },
        };
      }
      throw new Error(`unexpected tool: ${toolName}`);
    },
  };
  const checks = createChecksService(ctx, logger, mcp);

  const result = await checks.autoAssignConfiguredMissions({
    reason: "poll_tick_available_recheck",
    missionsResult: { structuredContent: { missions: [openMission] } },
  });

  assert.equal(result.assigned, 1);
  assert.deepEqual(assignedAccounts, ["standard-nft"]);
});
