import seasons from "../../src/analytics-seasons.json" with { type: "json" };
import competitions from "../../src/analytics-competitions.json" with { type: "json" };

export function availableAnalyticsSeasons() {
  return Object.entries({ ...seasons, ...competitions }).filter(([key]) => !["season70", "season71"].includes(key));
}

export function currentAnalyticsSeasonKey(now = Date.now()) {
  return Object.entries(seasons).find(
    ([, season]) => now >= Date.parse(season.start) && now < Date.parse(season.end),
  )?.[0] || null;
}

export function analyticsSeasonLabel(key, now = Date.now()) {
  const season = seasons[key] || competitions[key];
  if (!season) return null;
  return key === currentAnalyticsSeasonKey(now)
    ? `This season (${key.replace(/^season/, "")})`
    : season.label;
}
