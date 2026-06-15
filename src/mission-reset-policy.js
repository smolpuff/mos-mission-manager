"use strict";

function normalizeMissionResetPerSlotEnabledBySlot(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (let slot = 1; slot <= 4; slot += 1) {
    out[String(slot)] = src[slot] === true || src[String(slot)] === true;
  }
  return out;
}

function normalizeMissionResetPerSlotLevel(value, fallback = 10) {
  const next = Number(value);
  if (Number.isFinite(next) && next > 0) return Math.floor(next);
  const safeFallback = Number(fallback);
  if (Number.isFinite(safeFallback) && safeFallback > 0) {
    return Math.floor(safeFallback);
  }
  return 10;
}

function normalizeMissionResetPerSlotLevelBySlot(raw, fallback = 10) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (let slot = 1; slot <= 4; slot += 1) {
    out[String(slot)] = normalizeMissionResetPerSlotLevel(
      src[slot] ?? src[String(slot)],
      fallback,
    );
  }
  return out;
}

function defaultMissionModeThreshold(ctx = {}) {
  return normalizeMissionResetPerSlotLevel(
    ctx?.currentMissionResetLevel ||
      ctx?.config?.missionResetLevel ||
      process.env.PBP_DEFAULT_MISSION_RESET_LEVEL ||
      ctx?.runtimeDefaults?.missionResetLevel ||
      10,
    10,
  );
}

function debugModeEnabled(ctx = {}) {
  return ctx?.debugMode === true || ctx?.config?.debugMode === true;
}

function missionResetPerSlotModeEnabled(ctx = {}) {
  return (
    debugModeEnabled(ctx) &&
    (ctx?.missionResetPerSlotModeEnabled === true ||
      ctx?.config?.missionResetPerSlotModeEnabled === true)
  );
}

function missionResetPerSlotLevelBySlot(ctx = {}) {
  return normalizeMissionResetPerSlotLevelBySlot(
    ctx?.missionResetPerSlotLevelBySlot ||
      ctx?.config?.missionResetPerSlotLevelBySlot,
    defaultMissionModeThreshold(ctx),
  );
}

function missionResetPerSlotEnabledBySlot(ctx = {}) {
  return normalizeMissionResetPerSlotEnabledBySlot(
    ctx?.missionResetPerSlotEnabledBySlot ||
      ctx?.config?.missionResetPerSlotEnabledBySlot,
  );
}

function defaultResetPolicy(ctx = {}) {
  const mmEnabled =
    ctx?.missionModeEnabled === true || ctx?.config?.missionModeEnabled === true;
  if (mmEnabled) {
    const threshold = defaultMissionModeThreshold(ctx);
    return { enabled: true, threshold, label: `mm(${threshold})`, source: "mm" };
  }
  if (
    ctx?.level20ResetEnabled === true ||
    ctx?.config?.level20ResetEnabled === true
  ) {
    return { enabled: true, threshold: 20, label: "20r", source: "20r" };
  }
  return { enabled: false, threshold: null, label: "", source: "off" };
}

function resetPolicyForSlot(ctx = {}, slot) {
  const fallback = defaultResetPolicy(ctx);
  const slotNumber = Number(slot);
  if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 4) {
    return fallback;
  }
  if (!missionResetPerSlotModeEnabled(ctx)) return fallback;
  const enabledBySlot = missionResetPerSlotEnabledBySlot(ctx);
  if (enabledBySlot[String(Math.floor(slotNumber))] !== true) return fallback;
  const threshold =
    missionResetPerSlotLevelBySlot(ctx)[String(Math.floor(slotNumber))];
  return {
    enabled: true,
    threshold,
    label: `mr(${threshold})`,
    source: "mr",
  };
}

function resetPolicyForMission(ctx = {}, mission = {}) {
  return resetPolicyForSlot(ctx, mission?.slot);
}

module.exports = {
  normalizeMissionResetPerSlotEnabledBySlot,
  normalizeMissionResetPerSlotLevel,
  normalizeMissionResetPerSlotLevelBySlot,
  missionResetPerSlotModeEnabled,
  missionResetPerSlotLevelBySlot,
  missionResetPerSlotEnabledBySlot,
  defaultResetPolicy,
  resetPolicyForSlot,
  resetPolicyForMission,
};
