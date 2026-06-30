"use strict";

const {
  missionIsActive,
  missionIsClaimable,
} = require("./normalize");

const TRANSIENT_ASSIGNMENT_TTL_MS = 60_000;

function isUsableIdValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  const lowered = s.toLowerCase();
  return !["null", "undefined", "none", "false", "n/a"].includes(lowered);
}

function missionName(mission) {
  return String(
    mission?.missionName ||
      mission?.name ||
      mission?.mission_name ||
      mission?.title ||
      mission?.mission ||
      mission?.label ||
      "",
  ).trim();
}

function assignedMissionId(mission) {
  const id = mission?.assignedMissionId || mission?.assigned_mission_id || "";
  return isUsableIdValue(id) ? String(id).trim() : null;
}

function missionSlot(mission) {
  const slot = Number(mission?.slot);
  return Number.isFinite(slot) && slot >= 1 ? Math.floor(slot) : null;
}

function missionStableKey(mission) {
  const slot = missionSlot(mission);
  const name = missionName(mission).toLowerCase();
  if (!name || slot === null) return null;
  return `${name}|slot=${slot}`;
}

function assignedNftAccount(mission) {
  const candidates = [
    mission?.assigned_nft,
    mission?.assignedNft,
    mission?.assigned_nft_account,
    mission?.assignedNftAccount,
    mission?.nftAccount,
    mission?.nft_account,
    mission?.nft?.nftAccount,
    mission?.nft?.nft_account,
    mission?.nft?.tokenAddress,
    mission?.nft?.token_address,
    mission?.nft?.mintAddress,
    mission?.nft?.mint_address,
    mission?.current_assigned_nft?.nftAccount,
    mission?.current_assigned_nft?.tokenAddress,
    mission?.current_assigned_nft?.mintAddress,
  ];
  const found = candidates.find((value) => isUsableIdValue(value));
  return found ? String(found).trim() : null;
}

function ensureCache(ctx) {
  if (!ctx.transientMissionAssignmentCache) {
    ctx.transientMissionAssignmentCache = {
      byAssignedMissionId: {},
      byStableKey: {},
    };
  }
  if (!ctx.transientMissionAssignmentCache.byAssignedMissionId) {
    ctx.transientMissionAssignmentCache.byAssignedMissionId = {};
  }
  if (!ctx.transientMissionAssignmentCache.byStableKey) {
    ctx.transientMissionAssignmentCache.byStableKey = {};
  }
  return ctx.transientMissionAssignmentCache;
}

function noteMissionAssignments(ctx, missions = [], now = Date.now()) {
  const cache = ensureCache(ctx);
  for (const mission of Array.isArray(missions) ? missions : []) {
    const nftAccount = assignedNftAccount(mission);
    if (!nftAccount) continue;
    const entry = {
      account: nftAccount,
      name: missionName(mission) || null,
      slot: missionSlot(mission),
      nftSource: mission?.nft_source || mission?.nftSource || null,
      seenAt: now,
    };
    const missionId = assignedMissionId(mission);
    if (missionId) cache.byAssignedMissionId[missionId] = entry;
    const stableKey = missionStableKey(mission);
    if (stableKey) cache.byStableKey[stableKey] = entry;
  }
}

function stabilizeMissionAssignments(
  ctx,
  result,
  { now = Date.now(), ttlMs = TRANSIENT_ASSIGNMENT_TTL_MS } = {},
) {
  const missions = result?.structuredContent?.missions?.missions;
  if (!Array.isArray(missions) || missions.length === 0) {
    return { result, patchedCount: 0 };
  }

  noteMissionAssignments(ctx, missions, now);
  const cache = ensureCache(ctx);
  const maxAgeMs = Math.max(0, Number(ttlMs) || 0);
  let patchedCount = 0;
  let nextMissions = null;

  for (let index = 0; index < missions.length; index += 1) {
    const mission = missions[index];
    if (assignedNftAccount(mission)) continue;
    // Only backfill missing assignment data while the mission still looks active.
    // After a claim, the API can briefly return the same mission without an NFT;
    // patching that response creates a ghost assignment in the UI and blocks
    // the immediate post-claim auto-assign pass.
    if (!missionIsActive(mission) || missionIsClaimable(mission)) continue;
    const missionId = assignedMissionId(mission);
    const stableKey = missionStableKey(mission);
    const cached =
      (missionId ? cache.byAssignedMissionId[missionId] : null) ||
      (stableKey ? cache.byStableKey[stableKey] : null) ||
      null;
    if (!cached?.account) continue;
    const ageMs = Math.max(0, now - Number(cached.seenAt || 0));
    if (ageMs > maxAgeMs) continue;
    if (!nextMissions) nextMissions = missions.slice();
    nextMissions[index] = {
      ...mission,
      assigned_nft: mission?.assigned_nft || cached.account,
      assignedNft: mission?.assignedNft || cached.account,
      assigned_nft_account:
        mission?.assigned_nft_account || cached.account,
      assignedNftAccount:
        mission?.assignedNftAccount || cached.account,
      nftAccount: mission?.nftAccount || cached.account,
      nft_account: mission?.nft_account || cached.account,
      nft_source:
        mission?.nft_source || mission?.nftSource || cached.nftSource || "transient_cache",
      transientAssignedNft: true,
      transientAssignedNftAgeMs: ageMs,
    };
    patchedCount += 1;
  }

  if (!nextMissions) return { result, patchedCount: 0 };
  return {
    result: {
      ...result,
      structuredContent: {
        ...result.structuredContent,
        missions: {
          ...result.structuredContent.missions,
          missions: nextMissions,
        },
      },
    },
    patchedCount,
  };
}

module.exports = {
  TRANSIENT_ASSIGNMENT_TTL_MS,
  stabilizeMissionAssignments,
};
