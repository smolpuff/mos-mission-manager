"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ranges = require("../electron/analytics-ranges");

// Run the real desktop analytics functions without starting Electron or writing
// the user's analytics file. History normalization is outside these tests.
function desktopAnalytics() {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const normalizeHistory = (entries) => entries || [];
  const context = vm.createContext({
    ...ranges,
    backendStatus: { analytics: {}, nftUsageStats: [] },
    normalizeAnalytics: (value) => value,
    normalizeClaimHistory: normalizeHistory,
    normalizeSpendHistory: normalizeHistory,
    normalizeResetHistory: normalizeHistory,
    normalizeRentalHistory: normalizeHistory,
    normalizeAssignmentHistory: normalizeHistory,
    claimCountFromHistoryEntry: (entry) => entry.claims || 1,
    normalizeRewardToken: (token) => token,
    canonicalNftCollectionName: (name) => name,
    loadPersistedNftUsageStats: () => [],
    getAnalyticsPath: () => "test-analytics.json",
    saveAnalytics: (value) => { context.backendStatus.analytics = value; },
    publishStatus: () => {},
    buildAnalyticsSpendRows: () => [],
    buildAnalyticsEventRows: () => [],
  });
  vm.runInContext(source.slice(
    source.indexOf("function analyticsBucketFromRange("),
    source.indexOf("async function exportAnalyticsCsv("),
  ), context);
  return context;
}

function historyBucket() {
  const at = [
    "2026-08-03T23:59:59.999-04:00",
    "2026-08-04T00:00:00-04:00",
    "2026-09-14T23:59:59.999-04:00",
    "2026-09-15T00:00:00-04:00",
    "2026-10-27T00:00:00-04:00",
    "2026-12-07T23:59:59.999-05:00",
    "2026-12-08T00:00:00-05:00",
  ].map(Date.parse);
  return {
    startedAt: at[0],
    claimHistory: at.map((at) => ({ at, mission: "Race!", rewardToken: "pbp", rewardAmount: 10 })),
    spendHistory: at.map((at) => ({ at, action: "mission_reroll", amount: 2 })),
    resetHistory: at.map((at) => ({ at, kind: "nft", source: "owned" })),
    rentalHistory: at.map((at) => ({ at })),
    assignmentHistory: at.map((at) => ({ at, nft: "Marble", nftAccount: "nft-1", usedReset: true })),
  };
}

test("season windows match Eastern midnight, including the Season 73 DST change", () => {
  assert.equal(new Date(ranges.analyticsRangeBounds("season71").start).toISOString(), "2026-08-04T04:00:00.000Z");
  assert.equal(ranges.analyticsRangeBounds("season71").end, ranges.analyticsRangeBounds("season72").start);
  assert.equal(ranges.analyticsRangeBounds("season72").end, ranges.analyticsRangeBounds("season73").start);
  assert.equal(new Date(ranges.analyticsRangeBounds("season73").end).toISOString(), "2026-12-08T05:00:00.000Z");
  assert.equal(ranges.normalizeAnalyticsRange("season73"), "season73");
  assert.equal(ranges.normalizeAnalyticsRange("unknown"), "session");
});

test("season stats and NFT CSV exports include the start and exclude the next season", () => {
  const desktop = desktopAnalytics();
  desktop.backendStatus.analytics = { lifetime: historyBucket(), session: historyBucket() };
  for (const [key, count] of [["season71", 2], ["season72", 1], ["season73", 2]]) {
    const view = desktop.analyticsView(key);
    assert.equal(view.rangeKey, key);
    assert.equal(view.analytics.totalClaims, count);
    assert.equal(view.analytics.currencyEarned.pbp, count * 10);
    assert.equal(view.analytics.totalResetCostPbp, count * 2);
    assert.equal(view.analytics.totalResets, count);
    assert.equal(view.analytics.totalLeased, count);
    assert.equal(view.analytics.assignmentHistory.length, count);
    assert.equal(view.analytics.nftResetUsage.owned.assigned, count);
    assert.match(desktop.buildAnalyticsCsv(key), new RegExp(`Range,${key}\\n`));
    assert.match(desktop.buildAnalyticsCsv(key), new RegExp(`\\nClaims,${count}\\n`));
    assert.match(desktop.buildNftUsageCsv(key), new RegExp(`Marble,Unknown collection,,Unknown,${count},`));
  }
});

test("clearing season stats preserves every event outside that season", () => {
  const desktop = desktopAnalytics();
  desktop.backendStatus.analytics = { lifetime: historyBucket(), session: historyBucket() };
  assert.equal(desktop.resetAnalyticsRange("season71").analytics.totalClaims, 0);
  assert.equal(desktop.analyticsView("season72").analytics.totalClaims, 1);
  assert.equal(desktop.analyticsView("season73").analytics.totalClaims, 2);
  assert.equal(desktop.analyticsView("all").analytics.totalClaims, 5);
});

test("clearing season NFT usage preserves claims and other seasons' assignments", () => {
  const desktop = desktopAnalytics();
  desktop.backendStatus.analytics = { lifetime: historyBucket(), session: historyBucket() };
  const view = desktop.resetNftUsageRange("season72");
  assert.equal(view.analytics.assignmentHistory.length, 0);
  assert.equal(view.analytics.totalClaims, 1);
  assert.equal(desktop.analyticsView("season71").analytics.assignmentHistory.length, 2);
  assert.equal(desktop.analyticsView("season73").analytics.assignmentHistory.length, 2);
});

test("rolling ranges keep their existing durations", () => {
  const now = Date.parse("2026-10-15T16:00:00Z");
  assert.equal(ranges.analyticsRangeBounds("24h", now).start, now - 86400000);
  assert.equal(ranges.analyticsRangeBounds("7d", now).start, now - 7 * 86400000);
});

test("selectors reveal seasons at launch and retain completed seasons", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/src/pages/StatsPage.jsx"), "utf8");
  const context = vm.createContext({ analyticsSeasons: require("../src/analytics-seasons.json") });
  vm.runInContext(source.slice(
    source.indexOf("function availableAnalyticsSeasons("),
    source.indexOf("function formatNumber("),
  ), context);
  const keysAt = (iso) => Array.from(context.availableAnalyticsSeasons(Date.parse(iso)), ([key]) => key);
  assert.deepEqual(keysAt("2026-08-04T00:00:00-04:00"), ["season71"]);
  assert.deepEqual(keysAt("2026-09-14T23:59:59.999-04:00"), ["season71"]);
  assert.deepEqual(keysAt("2026-09-15T00:00:00-04:00"), ["season71", "season72"]);
  assert.deepEqual(keysAt("2026-10-27T00:00:00-04:00"), ["season71", "season72", "season73"]);
  assert.deepEqual(keysAt("2027-01-01T00:00:00-05:00"), ["season71", "season72", "season73"]);
});
