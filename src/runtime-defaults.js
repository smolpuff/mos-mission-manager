"use strict";

const NORMAL_DEFAULTS = {
  missionResetLevel: "11",
  rentalFastRefreshTickMs: 15000,
  rentalBatchLimit: 2,
  watchMaxLimitSeconds: 600,
  watchMinCycleSeconds: 30,
  watchDefaultPollSeconds: 30,
};

const DEV_DEFAULTS = {
  missionResetLevel: "6",
  rentalFastRefreshTickMs: 1500,
  rentalBatchLimit: 4,
  watchMaxLimitSeconds: 120,
  watchMinCycleSeconds: 15,
  watchDefaultPollSeconds: 15,
};

function runtimeDefaults(devMode = false) {
  return devMode ? DEV_DEFAULTS : NORMAL_DEFAULTS;
}

function detectNodeDevMode() {
  if (process.env.PBP_DEV_MODE === "1") return true;
  if (process.env.NODE_ENV === "development") return true;
  const lifecycle = String(process.env.npm_lifecycle_event || "");
  return lifecycle === "dev" || lifecycle === "dev:debug";
}

module.exports = {
  NORMAL_DEFAULTS,
  DEV_DEFAULTS,
  runtimeDefaults,
  detectNodeDevMode,
};
