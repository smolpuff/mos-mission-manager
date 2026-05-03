"use strict";

function isUsableIdValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  const lowered = s.toLowerCase();
  return !["null", "undefined", "none", "false", "n/a"].includes(lowered);
}

function assignedNftFromMission(mission) {
  if (!mission || typeof mission !== "object") return null;
  if (mission.currentAssignedNft && typeof mission.currentAssignedNft === "object")
    return mission.currentAssignedNft;
  if (
    mission.current_assigned_nft &&
    typeof mission.current_assigned_nft === "object"
  )
    return mission.current_assigned_nft;
  if (mission.assigned_nft && typeof mission.assigned_nft === "object")
    return mission.assigned_nft;
  if (mission.assignedNft && typeof mission.assignedNft === "object")
    return mission.assignedNft;
  if (mission.nft && typeof mission.nft === "object") return mission.nft;
  return null;
}

function assignedNftLabelFromMission(mission) {
  const directLabel = String(
    mission?.currentAssignedNFT ||
      mission?.current_assigned_nft ||
      mission?.assignedNftName ||
      mission?.assigned_nft_name ||
      mission?.nftName ||
      mission?.nft_name ||
      (typeof mission?.assigned_nft === "string" ? mission.assigned_nft : "") ||
      (typeof mission?.assignedNft === "string" ? mission.assignedNft : ""),
  ).trim();
  if (directLabel) return directLabel;

  const nft = assignedNftFromMission(mission);
  const name = String(nft?.name || nft?.nftName || nft?.symbol || "").trim();
  if (name) return name;
  const id = String(
    mission?.nftAccount ||
      mission?.nft_account ||
      mission?.assignedNftAccount ||
      mission?.assigned_nft_account ||
      mission?.currentAssignedNftAccount ||
      mission?.current_assigned_nft_account ||
      mission?.nftId ||
      mission?.nft_id ||
      "",
  ).trim();
  if (id) return id;

  return null;
}

function assignedNftLevelFromMission(mission) {
  const nft = assignedNftFromMission(mission);
  const raw = nft?.level ?? nft?.current_level ?? nft?.nftLevel ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^ipfs:\/\//i.test(value)) return value;
  if (/^data:image\//i.test(value)) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  if (/^gateway\.irys\.xyz\//i.test(value)) return `https://${value}`;
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[0-9a-z]{20,})$/i.test(value)) {
    return `ipfs://${value}`;
  }
  return null;
}

function deepFindImageUrl(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (typeof node === "string") return normalizeImageUrl(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindImageUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;

  const preferredKeys = [
    "image",
    "imageUrl",
    "image_url",
    "imageURI",
    "image_uri",
    "thumbnail",
    "thumbnailUrl",
    "thumbnail_url",
    "avatar",
    "avatarUrl",
    "avatar_url",
  ];
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const found = deepFindImageUrl(node[key], depth + 1);
    if (found) return found;
  }

  for (const [key, value] of Object.entries(node)) {
    if (/image|thumbnail|avatar|media|cdn|uri/i.test(String(key))) {
      const found = deepFindImageUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function assignedNftImageFromMission(mission) {
  const nft = assignedNftFromMission(mission);
  const candidates = [
    nft?.image,
    nft?.imageUrl,
    nft?.image_url,
    nft?.imageURI,
    nft?.image_uri,
    nft?.img,
    nft?.thumbnail,
    nft?.thumbnailUrl,
    nft?.thumbnail_url,
    nft?.metadata?.image,
    nft?.metadata?.imageUrl,
    nft?.metadata?.image_url,
    nft?.offChainMetadata?.metadata?.image,
    nft?.DASMetadata?.image,
    mission?.nftImage,
    mission?.nft_image,
    mission?.assignedNftImage,
    mission?.assigned_nft_image,
    mission?.currentAssignedNftImage,
    mission?.current_assigned_nft_image,
    mission?.currentAssignedNFT?.image,
    mission?.currentAssignedNFT?.imageUrl,
    mission?.currentAssignedNFT?.image_url,
    mission?.currentAssignedNFT?.imageURI,
    mission?.currentAssignedNFT?.image_uri,
    mission?.current_assigned_nft?.image,
    mission?.current_assigned_nft?.imageUrl,
    mission?.current_assigned_nft?.image_url,
    mission?.current_assigned_nft?.imageURI,
    mission?.current_assigned_nft?.image_uri,
  ];

  for (const value of candidates) {
    const normalized = normalizeImageUrl(value);
    if (normalized) return normalized;
  }

  return (
    deepFindImageUrl(nft) ||
    deepFindImageUrl(mission?.currentAssignedNFT) ||
    deepFindImageUrl(mission?.current_assigned_nft) ||
    deepFindImageUrl(mission?.metadata) ||
    deepFindImageUrl(mission)
  );
}

function missionAssignedNftAccount(mission) {
  const id = String(
    mission?.assigned_nft ||
      mission?.assignedNft ||
      mission?.nftAccount ||
      mission?.nft_account ||
      mission?.assignedNftAccount ||
      mission?.assigned_nft_account ||
      mission?.currentAssignedNftAccount ||
      mission?.current_assigned_nft_account ||
      mission?.nftId ||
      mission?.nft_id ||
      "",
  ).trim();
  return id || null;
}

function missionProgressFromMission(mission, progressByAssignedMissionId = null) {
  const assignedMissionId = String(
    mission?.assigned_mission_id || mission?.assignedMissionId || "",
  ).trim();
  const mappedProgress =
    assignedMissionId && progressByAssignedMissionId
      ? progressByAssignedMissionId.get(assignedMissionId)
      : null;
  const rawProgress =
    mission?.progress ??
    mission?.currentProgress ??
    mission?.current_progress ??
    null;
  const rawGoal =
    mission?.goal ??
    mission?.task_amount ??
    mission?.target ??
    mission?.targetProgress ??
    null;
  const progress = Number(mappedProgress ?? rawProgress);
  const goal = Number(rawGoal);
  return {
    progress: Number.isFinite(progress) ? progress : null,
    goal: Number.isFinite(goal) ? goal : null,
  };
}

function missionName(mission) {
  return String(
    mission?.name || mission?.missionName || mission?.mission_name || "",
  ).trim();
}

function missionLevel(mission) {
  const raw = mission?.current_level ?? mission?.level ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function nftDisplayName(nft) {
  return String(
    nft?.name || nft?.nftName || nft?.symbol || nft?.collection || "unknown nft",
  ).trim();
}

function computeGuiMissionSlots(
  missions,
  {
    progressByAssignedMissionId = null,
    missionNftByAccount = new Map(),
    assignedNftMetadataByAccount = new Map(),
  } = {},
) {
  function missionCardImageFromMission(mission) {
    if (!mission || typeof mission !== "object") return null;
    return assignedNftImageFromMission({
      image: mission?.image,
      imageUrl: mission?.imageUrl,
      image_url: mission?.image_url,
      thumbnail: mission?.thumbnail,
      thumbnailUrl: mission?.thumbnailUrl,
      thumbnail_url: mission?.thumbnail_url,
      missionImage: mission?.missionImage,
      mission_image: mission?.mission_image,
      mission: mission?.mission,
      metadata: mission?.metadata,
    });
  }

  const slots = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const mission = missions.find((m) => Number(m?.slot) === slot) || null;
    const missionLvl = missionLevel(mission);
    const { progress, goal } = missionProgressFromMission(
      mission,
      progressByAssignedMissionId,
    );
    const assignedAccount = missionAssignedNftAccount(mission);
    const nftFromLookup = assignedAccount
      ? missionNftByAccount.get(assignedAccount) || null
      : null;
    const nftFromAssignedCache = assignedAccount
      ? assignedNftMetadataByAccount.get(assignedAccount) || null
      : null;
    const missionImage = missionCardImageFromMission(mission);
    const nftImage =
      assignedNftImageFromMission(mission) ||
      assignedNftImageFromMission({ nft: nftFromLookup }) ||
      assignedNftImageFromMission({ nft: nftFromAssignedCache }) ||
      missionImage ||
      null;
    const nftLabel =
      assignedNftLabelFromMission(mission) ||
      (nftFromLookup
        ? nftDisplayName(nftFromLookup)
        : nftFromAssignedCache
          ? nftDisplayName(nftFromAssignedCache)
          : null);
    const nftLevel =
      assignedNftLevelFromMission(mission) ||
      (Number.isFinite(Number(nftFromLookup?.level))
        ? Number(nftFromLookup.level)
        : Number.isFinite(Number(nftFromAssignedCache?.level))
          ? Number(nftFromAssignedCache.level)
          : null);
    slots.push({
      slot,
      missionId: mission?.assignedMissionId || mission?.assigned_mission_id || null,
      missionName: missionName(mission) || null,
      missionLevel: missionLvl,
      progress,
      goal,
      missionImage,
      image: missionImage,
      assignedNft: nftLabel,
      assignedNftAccount: assignedAccount,
      assignedNftImage: nftImage,
      nftLevel,
      nftImage,
    });
  }
  return slots;
}

module.exports = {
  assignedNftImageFromMission,
  missionAssignedNftAccount,
  computeGuiMissionSlots,
};
