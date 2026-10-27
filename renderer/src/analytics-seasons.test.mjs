import assert from "node:assert/strict";
import test from "node:test";
import {
  availableAnalyticsSeasons,
  currentAnalyticsSeasonKey,
  analyticsSeasonLabel,
} from "./analytics-seasons.mjs";
import ranges from "../../electron/analytics-ranges.js";

test("Season 72 includes September 15 through all of October 26 Eastern time", () => {
  const bounds = ranges.analyticsRangeBounds("season72");
  for (const [timestamp, included] of [
    ["2026-09-14T23:59:59.999-04:00", false],
    ["2026-09-15T00:00:00-04:00", true],
    ["2026-10-26T23:59:59.999-04:00", true],
    ["2026-10-27T00:00:00-04:00", false],
  ]) {
    const at = Date.parse(timestamp);
    assert.equal(ranges.isInAnalyticsRange({ at }, bounds), included, timestamp);
    assert.equal(currentAnalyticsSeasonKey(at) === "season72", included, timestamp);
  }
});

test("both stats views can label the current season without relabeling history", () => {
  const now = Date.parse("2026-10-19T12:00:00-04:00");
  assert.equal(currentAnalyticsSeasonKey(now), "season72");
  assert.equal(analyticsSeasonLabel("season72", now), "This season (72)");
  assert.equal(analyticsSeasonLabel("season71", now), "Season 71");
  assert.equal(analyticsSeasonLabel("season73", now), "Season 73");
});

test("both stats selectors include Season 73 before it starts", () => {
  assert.deepEqual(availableAnalyticsSeasons().map(([key]) => key), ["season72", "season73", "resetCompetition"]);
});

test("Season 73 includes October 27 through December 7 across daylight saving", () => {
  const bounds = ranges.analyticsRangeBounds("season73");
  for (const [timestamp, included] of [
    ["2026-10-26T23:59:59.999-04:00", false],
    ["2026-10-27T00:00:00-04:00", true],
    ["2026-11-01T01:30:00-04:00", true],
    ["2026-11-01T01:30:00-05:00", true],
    ["2026-12-07T23:59:59.999-05:00", true],
    ["2026-12-08T00:00:00-05:00", false],
  ]) {
    const at = Date.parse(timestamp);
    assert.equal(ranges.isInAnalyticsRange({ at }, bounds), included, timestamp);
    assert.equal(currentAnalyticsSeasonKey(at) === "season73", included, timestamp);
  }
});

test("the current season rolls over at the exclusive cutoff", () => {
  const now = Date.parse("2026-10-27T00:00:00-04:00");
  assert.equal(currentAnalyticsSeasonKey(now), "season73");
  assert.equal(analyticsSeasonLabel("season72", now), "Season 72");
  assert.equal(analyticsSeasonLabel("season73", now), "This season (73)");
});

test("dates outside the known schedule do not claim a current season", () => {
  for (const timestamp of ["2026-08-03T12:00:00-04:00", "2026-12-08T00:00:00-05:00"]) {
    assert.equal(currentAnalyticsSeasonKey(Date.parse(timestamp)), null);
  }
});

test("temporary Reset Competition includes Sep 27–Nov 15 Eastern across daylight saving", () => {
  const bounds = ranges.analyticsRangeBounds("resetCompetition");
  assert.equal(ranges.normalizeAnalyticsRange("resetCompetition"), "resetCompetition");
  assert.equal(analyticsSeasonLabel("resetCompetition"), "Reset Competition (Sep 27–Nov 15, 2026)");
  for (const [timestamp, included] of [
    ["2026-09-26T23:59:59.999-04:00", false],
    ["2026-09-27T00:00:00-04:00", true],
    ["2026-10-24T12:00:00-04:00", true],
    ["2026-11-01T01:30:00-04:00", true],
    ["2026-11-01T01:30:00-05:00", true],
    ["2026-11-15T23:59:59.999-05:00", true],
    ["2026-11-16T00:00:00-05:00", false],
  ]) assert.equal(ranges.isInAnalyticsRange({ at: Date.parse(timestamp) }, bounds), included, timestamp);
  assert.equal(currentAnalyticsSeasonKey(bounds.start), "season72");
});
