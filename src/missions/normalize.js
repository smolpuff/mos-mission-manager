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
  if (Array.isArray(result?.missions?.missions)) return result.missions.missions;
  if (Array.isArray(result?.missions)) return result.missions;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeNftList(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc)) return sc;
  if (Array.isArray(sc?.nfts)) return sc.nfts;
  if (Array.isArray(sc?.walletNfts)) return sc.walletNfts;
  if (Array.isArray(sc?.items)) return sc.items;
  if (Array.isArray(result?.nfts)) return result.nfts;
  if (Array.isArray(result?.walletNfts)) return result.walletNfts;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeMissionCatalogList(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc?.missions)) return sc.missions;
  if (Array.isArray(sc)) return sc;
  return [];
}

function normalizeRewardToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (
    normalized === "pbp" ||
    normalized === "pbp_token" ||
    normalized === "pixel_by_pixel"
  ) {
    return "PBP";
  }
  if (
    normalized === "tc" ||
    normalized === "tc_token" ||
    normalized === "tournament_coin" ||
    normalized === "tournament_coins"
  ) {
    return "TC";
  }
  if (
    normalized === "cc" ||
    normalized === "cc_token" ||
    normalized === "community_coin" ||
    normalized === "community_coins"
  ) {
    return "CC";
  }
  return raw;
}

function parseRewardAmount(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value === "string") {
    const match = value.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function parseRewardText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z_]+)/);
  if (!match) {
    return { amount: null, token: null, label: text };
  }
  const amount = parseRewardAmount(match[1]);
  const token = normalizeRewardToken(match[2]);
  return {
    amount,
    token,
    label:
      amount !== null && token
        ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token}`
        : text,
  };
}

function buildRewardDetails(amount, token, fallbackLabel = null) {
  const numericAmount = parseRewardAmount(amount);
  const normalizedToken = normalizeRewardToken(token);
  if (numericAmount !== null && normalizedToken) {
    return {
      amount: numericAmount,
      token: normalizedToken,
      label: `${numericAmount.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })} ${normalizedToken}`,
    };
  }
  if (numericAmount !== null) {
    return {
      amount: numericAmount,
      token: null,
      label: numericAmount.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      }),
    };
  }
  if (fallbackLabel) {
    const parsed = parseRewardText(fallbackLabel);
    if (parsed) return parsed;
  }
  return { amount: null, token: null, label: null };
}

function rewardDetailsFromObject(entry) {
  if (!entry || typeof entry !== "object") return null;
  return buildRewardDetails(
    entry?.amount ??
      entry?.value ??
      entry?.rewardAmount ??
      entry?.reward_amount ??
      entry?.prizeAmount ??
      entry?.prize_amount ??
      null,
    entry?.symbol ??
      entry?.token ??
      entry?.currency ??
      entry?.rewardSymbol ??
      entry?.reward_symbol ??
      entry?.rewardToken ??
      entry?.reward_token ??
      entry?.prize ??
      entry?.prizeToken ??
      null,
    entry?.label ?? entry?.reward ?? entry?.rewardText ?? null,
  );
}

function extractMissionReward(mission = {}) {
  if (!mission || typeof mission !== "object") {
    return { amount: null, token: null, label: null };
  }

  if (Array.isArray(mission?.rewards)) {
    const labels = [];
    let primary = null;
    for (const reward of mission.rewards) {
      if (typeof reward === "string") {
        const parsed = parseRewardText(reward);
        if (parsed?.label) {
          labels.push(parsed.label);
          if (!primary && (parsed.amount !== null || parsed.token)) primary = parsed;
        }
        continue;
      }
      const details = rewardDetailsFromObject(reward);
      if (details?.label) {
        labels.push(details.label);
        if (!primary && (details.amount !== null || details.token)) {
          primary = details;
        }
      }
    }
    if (labels.length > 0) {
      return primary
        ? { ...primary, label: labels.join(" + ") }
        : { amount: null, token: null, label: labels.join(" + ") };
    }
  }

  if (mission?.reward && typeof mission.reward === "object") {
    const details = rewardDetailsFromObject(mission.reward);
    if (details?.label) return details;
  }

  const direct = buildRewardDetails(
    mission?.rewardAmount ??
      mission?.reward_amount ??
      mission?.tokenReward ??
      mission?.token_reward ??
      mission?.prizeAmount ??
      mission?.prize_amount ??
      mission?.amount ??
      null,
    mission?.rewardSymbol ??
      mission?.reward_symbol ??
      mission?.tokenSymbol ??
      mission?.token_symbol ??
      mission?.prize ??
      mission?.rewardToken ??
      mission?.reward_token ??
      mission?.prizeToken ??
      mission?.currency ??
      mission?.currencySymbol ??
      null,
    mission?.rewardText ?? null,
  );
  if (direct.label) return direct;

  const fallbackTextCandidates = [mission?.rewardText, mission?.reward, mission?.rewards];
  for (const candidate of fallbackTextCandidates) {
    if (typeof candidate !== "string") continue;
    const parsed = parseRewardText(candidate);
    if (parsed?.label) return parsed;
  }

  return { amount: null, token: null, label: null };
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
  normalizeRewardToken,
  extractMissionReward,
  missionHasAssignedNft,
  missionIsClaimable,
  missionIsActive,
  computeMissionStats,
};
