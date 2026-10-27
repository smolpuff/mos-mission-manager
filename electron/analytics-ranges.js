"use strict";

// Match dash-mock's America/New_York season boundaries, including the
// daylight-saving transition in Season 73. End boundaries are exclusive.
const seasons = { ...require("../src/analytics-seasons.json"), ...require("../src/analytics-competitions.json") };

function normalizeAnalyticsRange(rangeKey) {
  return ["session", "24h", "7d", "all", ...Object.keys(seasons)].includes(rangeKey)
    ? rangeKey
    : "session";
}

function analyticsRangeBounds(rangeKey, now = Date.now()) {
  const season = Object.hasOwn(seasons, rangeKey) ? seasons[rangeKey] : null;
  if (season) {
    return { start: Date.parse(season.start), end: Date.parse(season.end) };
  }
  const duration = rangeKey === "24h" ? 24 : 7 * 24;
  return { start: now - duration * 60 * 60 * 1000, end: Infinity };
}

function isInAnalyticsRange(entry, bounds) {
  const at = Number(entry?.at);
  return at >= bounds.start && at < bounds.end;
}

module.exports = { normalizeAnalyticsRange, analyticsRangeBounds, isInAnalyticsRange };
