"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { countRentalAssignments, hasRecordedAssignment } = require("./rental-analytics");
const { analyticsRangeBounds, isInAnalyticsRange } = require("../electron/analytics-ranges");
const { createChecksService } = require("./services/checks");
const os = require("node:os");

// Load only the analytics functions, without launching Electron or a runner.
const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
function analyticsFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing actual analytics function ${name}`);
  const remainder = mainSource.slice(start + 1);
  const next = remainder.search(/\n(?:async )?function /);
  assert.ok(next >= 0);
  return mainSource.slice(start, start + 1 + next);
}
function analyticsHarness() {
  let saved = {
    lifetime: { assignmentHistory: [], nftResetUsage: { rental: { assigned: 0 }, owned: { assigned: 0 } } },
    session: { assignmentHistory: [], nftResetUsage: { rental: { assigned: 0 }, owned: { assigned: 0 } } },
  };
  const telemetry = [];
  const context = vm.createContext({
    Date, countRentalAssignments, hasRecordedAssignment, analyticsRangeBounds, isInAnalyticsRange,
    normalizeClaimHistory: (rows) => rows || [],
    claimCountFromHistoryEntry: (entry) => entry.claims || 0,
    normalizeRewardToken: (token) => token,
    normalizeAnalytics: (value) => structuredClone(value),
    backendStatus: {},
    loadAnalytics: () => saved,
    saveAnalytics: (value) => { saved = value; context.backendStatus.analytics = value; },
    resolveMissionLabelFromPayload: (value) => value.missionName || "Race!",
    missionLevelFromPayload: (value) => value.missionLevel || 1,
    trackFeatureUsage: (event, payload) => telemetry.push({ event, payload }),
    publishStatus() {},
  });
  for (const name of ["normalizeAnalyticsTimestampMs", "analyticsTimestampIso", "normalizeSpendHistory", "normalizeResetHistory", "normalizeRentalHistory", "normalizeAssignmentHistory", "applyAnalyticsAssignmentEvent", "analyticsBucketFromRange", "rebuildAnalyticsBucketFromHistories"]) {
    vm.runInContext(analyticsFunction(name), context);
  }
  return { context, telemetry, saved: () => saved };
}

test("competition mission-reset totals exclude NFT resets and events outside Nov 2–15", () => {
  const { context } = analyticsHarness();
  const start = Date.parse("2026-11-02T00:00:00-05:00");
  const end = Date.parse("2026-11-16T00:00:00-05:00");
  const result = context.analyticsBucketFromRange({ resetHistory: [
    { at: start - 1, kind: "mission" },
    { at: start, kind: "mission", source: "watch_reroll" },
    { at: start + 1, kind: "nft", source: "owned" },
    { at: start + 2, kind: "nft", source: "rental" },
    { at: end - 1, kind: "mission", source: "assign_auto_mode_reroll" },
    { at: end, kind: "mission" },
  ] }, "resetCompetition");
  assert.equal(result.resetTypes.mission, 2);
  assert.equal(result.resetTypes.nft, 2);
});

test("rental usage is recovered from retained assignments for session, all and Season 72", () => {
  const { context } = analyticsHarness();
  const start = Date.parse("2026-09-15T00:00:00-04:00");
  const end = Date.parse("2026-10-27T00:00:00-04:00");
  const bucket = {
    startedAt: start - 1000,
    rentalHistory: [{ at: start + 1 }],
    assignmentHistory: [
      { at: start - 1, source: "rental" },
      { at: start, source: "rental", nftAccount: "rental-a" },
      { at: start + 1, source: "owned", nftAccount: "owned-a" },
      { at: end - 1, source: "rental", nftAccount: "rental-b" },
      { at: end, source: "rental", nftAccount: "rental-c" },
    ],
  };
  for (const range of ["session", "all"]) {
    const result = context.analyticsBucketFromRange(bucket, range);
    assert.equal(result.totalRentalsUsed, 4);
    assert.equal(result.totalLeased, 1, "Legacy lease acquisitions keep their original meaning");
  }
  const seasonal = context.analyticsBucketFromRange(bucket, "season72");
  assert.equal(seasonal.totalRentalsUsed, 2, "Season boundary and owned assignments are respected");
  assert.equal(seasonal.totalLeased, 1);
});

test("recording a rental assignment updates usage without emitting duplicate lease telemetry", () => {
  const { context, telemetry, saved } = analyticsHarness();
  const event = {
    eventId: "rental:mission-1:rental-1:123", source: "rental", usedReset: true,
    at: Date.parse("2026-10-24T22:40:55Z"), assignedMissionId: "mission-1", nftAccount: "rental-1",
  };
  assert.equal(context.applyAnalyticsAssignmentEvent(event), true);
  assert.equal(context.applyAnalyticsAssignmentEvent(event), false, "Replayed confirmation is ignored");
  const result = context.analyticsBucketFromRange(saved().lifetime, "season72");
  assert.equal(result.totalRentalsUsed, 1);
  assert.equal(result.nftResetUsage.rental.assigned, 1);
  assert.equal(result.totalLeased, 0);
  assert.deepEqual(telemetry.map(({ event }) => event), ["mission_assignment", "nft_reset_assignment"]);
  assert.equal(telemetry[0].payload.event_id, event.eventId);
  assert.equal(telemetry[0].payload.nft_account, "rental-1");
  context.applyAnalyticsAssignmentEvent({ ...event, source: "owned", eventId: "owned:mission-2", usedReset: false });
  assert.equal(context.analyticsBucketFromRange(saved().lifetime, "all").totalRentalsUsed, 1);
});

test("explicit replay IDs are deduplicated without discarding legacy rental records", () => {
  assert.equal(countRentalAssignments([
    { source: "rental", eventId: "a" }, { source: "rental", eventId: "a" },
    { source: "rental" }, { source: "rental" }, { source: "owned", eventId: "b" },
  ]), 3);
});

test("NFT cost display includes both historical and current action names", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../renderer/src/pages/StatsPage.jsx"), "utf8");
  const statement = renderer.match(/const nftResetPbp = asNumber\([\s\S]*?\n  \);/)[0];
  for (const [spendByAction, expected] of [[{ cooldown_reset: 10 }, 10], [{ nft_cooldown_reset: 20, cooldown_reset: 10 }, 30]]) {
    const context = vm.createContext({ spendByAction, asNumber: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback });
    vm.runInContext(`${statement}\nthis.result = nftResetPbp;`, context);
    assert.equal(context.result, expected);
  }
});

test("reconciled rental assignment retries failed persistence and records usage once", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rental-analytics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const events = [];
  const mission = { assigned_mission_id: "mission-1", name: "Race!", slot: 1, current_level: 5,
    assigned_nft: "rental-1", active: true, startTime: "2026-10-24T22:40:55Z" };
  const result = { structuredContent: { missions: { missions: [mission] } } };
  const ctx = {
    config: {}, currentMissionStats: {}, lastUserMissionsResult: result,
    nftAssignmentRotationPath: path.join(directory, "rotation.json"),
    nftUsageStatsPath: path.join(directory, "usage.json"), nftAssignmentScanPath: path.join(directory, "scan.json"),
    guiBridge: { sendEvent: (type, payload) => events.push({ type, payload }), emitNow() {} },
  };
  fs.mkdirSync(ctx.nftAssignmentRotationPath);
  const checks = createChecksService(ctx,
    { logWithTimestamp() {}, logDebug() {}, redrawHeaderAndLog() {}, formatTaggedLog() {} },
    { async getUserMissions() { return result; }, async mcpToolCall() { return {}; } });
  const request = { mission, missionKey: "mission-1", candidate: { nftAccount: "rental-1", inFlightAt: 123, cooldownResetSucceeded: true } };
  assert.equal((await checks.reconcileAmbiguousRentalAssignment(request)).assigned, false, "Failed persistence leaves confirmation retryable");
  assert.equal(events.filter(({ type }) => type === "stats_assignment").length, 0);
  fs.rmdirSync(ctx.nftAssignmentRotationPath);
  assert.equal((await checks.reconcileAmbiguousRentalAssignment(request)).assigned, true);
  assert.equal((await checks.reconcileAmbiguousRentalAssignment(request)).assigned, true);
  assert.equal(JSON.parse(fs.readFileSync(ctx.nftAssignmentRotationPath, "utf8")).usage["rental-1"], 1);
  const assignments = events.filter(({ type }) => type === "stats_assignment");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].payload.usedReset, true);
  assert.equal(assignments[0].payload.source, "rental");
  assert.equal(assignments[0].payload.missionStartTimestamp, mission.startTime);
});
