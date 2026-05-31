"use strict";

function normalizeMissionActionEnabledBySlot(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (let slot = 1; slot <= 4; slot += 1) {
    const key = String(slot);
    out[key] = src[slot] !== false && src[key] !== false;
  }
  return out;
}

function missionActionEnabledBySlot(ctx = {}) {
  return normalizeMissionActionEnabledBySlot(
    ctx?.missionActionEnabledBySlot || ctx?.config?.missionActionEnabledBySlot,
  );
}

function missionActionEnabledForSlot(ctx = {}, slot) {
  const slotNumber = Number(slot);
  if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 4) {
    return true;
  }
  return missionActionEnabledBySlot(ctx)[String(Math.floor(slotNumber))] !== false;
}

function missionActionEnabledForMission(ctx = {}, mission = {}) {
  return missionActionEnabledForSlot(ctx, mission?.slot);
}

module.exports = {
  normalizeMissionActionEnabledBySlot,
  missionActionEnabledBySlot,
  missionActionEnabledForSlot,
  missionActionEnabledForMission,
};
