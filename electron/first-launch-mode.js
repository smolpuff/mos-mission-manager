"use strict";

function firstLaunchModePatch(config = {}) {
  if (
    config.firstRunOnboardingCompleted === true ||
    typeof config.autoModeEnabled === "boolean" ||
    typeof config.missionModeEnabled === "boolean"
  ) return null;
  return { autoModeEnabled: true, missionModeEnabled: false, enableRentals: true };
}

module.exports = { firstLaunchModePatch };
