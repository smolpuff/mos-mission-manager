"use strict";

function isUsableIdValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  const lowered = s.toLowerCase();
  if (
    lowered === "null" ||
    lowered === "undefined" ||
    lowered === "none" ||
    lowered === "false" ||
    lowered === "n/a"
  ) {
    return false;
  }
  return true;
}

function normalizeMissionList(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc)) return sc;
  if (Array.isArray(sc?.missions?.missions)) return sc.missions.missions;
  if (Array.isArray(sc?.missions)) return sc.missions;
  return [];
}

function normalizeNftList(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc)) return sc;
  if (Array.isArray(sc?.nfts)) return sc.nfts;
  if (Array.isArray(sc?.walletNfts)) return sc.walletNfts;
  if (Array.isArray(sc?.items)) return sc.items;
  return [];
}

function normalizeMissionCatalogList(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc?.missions)) return sc.missions;
  if (Array.isArray(sc)) return sc;
  return [];
}

function missionHasAssignedNft(mission) {
  const nft = [
    mission?.assigned_nft,
    mission?.nftAccount,
    mission?.nft_account,
    mission?.assignedNft,
    mission?.assigned_nft_account,
    mission?.assignedNftAccount,
    mission?.nft?.nftAccount,
    mission?.nft?.nft_account,
    mission?.nft?.tokenAddress,
    mission?.nft?.token_address,
    mission?.nft?.mintAddress,
    mission?.nft?.mint_address,
    mission?.nftId,
    mission?.nft_id,
  ];
  if (
    mission?.assigned_nft === true ||
    mission?.assignedNft === true ||
    mission?.assigned_nft_active === true ||
    mission?.assignedMissionActive === true
  ) {
    return true;
  }
  const explicitId = nft.find((v) => isUsableIdValue(v));
  if (explicitId) return true;
  const nestedNft = mission?.nft;
  if (nestedNft && typeof nestedNft === "object") {
    return Object.keys(nestedNft).length > 0;
  }
  if (mission?.assigned_nft && typeof mission.assigned_nft === "object") {
    return Object.keys(mission.assigned_nft).length > 0;
  }
  return false;
}

function missionIsClaimable(mission) {
  const explicit = mission?.claimable ?? mission?.isClaimable;
  if (explicit === true) return true;
  if (mission?.completed === true) return true;
  const status = String(mission?.status || mission?.state || "")
    .trim()
    .toLowerCase();
  if (status && ["claimable", "ready_to_claim", "ready-to-claim", "completed", "complete"].includes(status)) {
    return true;
  }
  return false;
}

function missionIsActive(mission) {
  const activeFlag =
    mission?.active ??
    mission?.isActive ??
    mission?.inProgress ??
    mission?.assigned_mission_active;
  if (activeFlag === true) return true;
  const status = String(mission?.status || mission?.state || "")
    .trim()
    .toLowerCase();
  if (status && ["active", "in_progress", "in-progress", "running"].includes(status)) {
    return true;
  }
  const progress = Number(mission?.progress ?? mission?.currentProgress ?? 0) || 0;
  const goal = Number(mission?.goal ?? mission?.task_amount ?? 0) || 0;
  return goal > 0 && progress > 0 && progress < goal;
}

function computeMissionStats(missions, sessionClaimedCount) {
  let active = 0;
  let available = 0;
  let claimable = 0;

  for (const m of missions) {
    const hasNft = missionHasAssignedNft(m);
    if (missionIsClaimable(m)) claimable += 1;
    if (!hasNft) {
      available += 1;
      continue;
    }
    if (missionIsActive(m)) active += 1;
  }

  return {
    total: missions.length,
    active,
    available,
    claimable,
    claimed: sessionClaimedCount,
  };
}

module.exports = {
  normalizeMissionList,
  normalizeNftList,
  normalizeMissionCatalogList,
  missionHasAssignedNft,
  missionIsClaimable,
  missionIsActive,
  computeMissionStats,
};
