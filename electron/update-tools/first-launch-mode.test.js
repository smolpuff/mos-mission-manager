"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { firstLaunchModePatch } = require("../first-launch-mode");

test("a fresh desktop setup defaults to Auto Mode", () => {
  assert.deepEqual(firstLaunchModePatch({}), {
    autoModeEnabled: true, missionModeEnabled: false, enableRentals: true,
  });
});

test("saved modes and completed setups retain their existing behavior", () => {
  for (const config of [
    { autoModeEnabled: false },
    { autoModeEnabled: true },
    { missionModeEnabled: true },
    { missionModeEnabled: false },
    { firstRunOnboardingCompleted: true },
  ]) assert.equal(firstLaunchModePatch(config), null);
});

test("unrelated first-launch settings do not prevent the Auto default", () => {
  assert.equal(firstLaunchModePatch({ signerMode: "app_wallet" }).autoModeEnabled, true);
});
