"use strict";

const NORMAL_DEFAULTS = {
  missionResetLevel: "10",
  rentalFastRefreshTickMs: 7500,
  rentalBatchLimit: 1,
  watchMaxLimitSeconds: 60,
  watchMinCycleSeconds: 30,
  watchDefaultPollSeconds: 30,
};

const DEV_DEFAULTS = {
  missionResetLevel: "5",
  rentalFastRefreshTickMs: 5250,
  rentalBatchLimit: 3,
  watchMaxLimitSeconds: 60,
  watchMinCycleSeconds: 15,
  watchDefaultPollSeconds: 15,
};

function runtimeDefaults(devMode = false) {
  return devMode ? DEV_DEFAULTS : NORMAL_DEFAULTS;
}

function runtimeDefaultsForFlags({ debugMode = false, devMode = false } = {}) {
  return runtimeDefaults(Boolean(debugMode || devMode));
}

function applyRuntimeDefaults(ctx) {
  if (!ctx || typeof ctx !== "object") return NORMAL_DEFAULTS;
  const defaults = runtimeDefaultsForFlags({
    debugMode: ctx.debugMode === true,
    devMode: ctx.devMode === true,
  });
  ctx.runtimeDefaults = defaults;
  return defaults;
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
  runtimeDefaultsForFlags,
  applyRuntimeDefaults,
  detectNodeDevMode,
};
