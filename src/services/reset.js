"use strict";

function parseResetLevel(mission) {
  const fields = [
    mission?.current_level,
    mission?.currentLevel,
    mission?.level,
    mission?.mission_level,
    mission?.missionLevel,
  ];
  for (const raw of fields) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    if (typeof raw === "string") {
      const match = raw.match(/\d+/);
      if (match) return Number(match[0]);
    }
  }
  return 0;
}

function evaluateResetCandidates(snapshotMap, threshold) {
  const t = Number(threshold);
  if (!Number.isFinite(t) || t <= 0) return { ready: [], blocked: [] };
  const ready = [];
  const blocked = [];
  for (const mission of snapshotMap.values()) {
    const level = Number(mission?.level || 0);
    const hasActiveNft = Boolean(mission?.assignedNft);
    if (!Number.isFinite(level) || level < t) continue;
    if (!hasActiveNft) ready.push(mission);
    else blocked.push(mission);
  }
  return { ready, blocked };
}

module.exports = {
  parseResetLevel,
  evaluateResetCandidates,
};
