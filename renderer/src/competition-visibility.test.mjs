import test from "node:test";
import assert from "node:assert/strict";
import { resetCompetitionDisplayWindow, resetCompetitionIsVisible } from "./competition-visibility.mjs";

test("competition sections show from Nov 2 through the full week after Nov 15, Eastern", () => {
  assert.deepEqual(resetCompetitionDisplayWindow(), {
    startsAt: Date.parse("2026-11-02T00:00:00-05:00"),
    hidesAt: Date.parse("2026-11-23T00:00:00-05:00"),
  });
  for (const [date, visible] of [
    ["2026-10-18T23:59:59.999-04:00", false],
    ["2026-10-19T23:59:59.999-04:00", false],
    ["2026-11-02T00:00:00-05:00", true],
    ["2026-10-19T01:30:00-04:00", false],
    ["2026-11-16T00:00:00-05:00", true],
    ["2026-11-22T23:59:59.999-05:00", true],
    ["2026-11-23T00:00:00-05:00", false],
  ]) assert.equal(resetCompetitionIsVisible(Date.parse(date), false), visible, date);
});

test("release defaults hide the card before the start and after expiry", () => {
  assert.equal(resetCompetitionIsVisible(Date.parse("2026-10-27T12:00:00-04:00")), false);
  assert.equal(resetCompetitionIsVisible(Date.parse("2026-11-23T00:00:00-05:00")), false);
});
