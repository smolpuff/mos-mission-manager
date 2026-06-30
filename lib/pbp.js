"use strict";

const { callTool } = require("./mcp");

function normalizeMissionsResponse(result) {
  const sc = result?.structuredContent;
  if (Array.isArray(sc)) return sc;
  if (Array.isArray(sc?.missions?.missions)) return sc.missions.missions;
  if (Array.isArray(sc?.missions)) return sc.missions;
  if (Array.isArray(result?.missions?.missions)) return result.missions.missions;
  if (Array.isArray(result?.missions)) return result.missions;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeNftsResponse(result) {
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

function assignedMissionId(m) {
  return (
    m?.assignedMissionId ||
    m?.assigned_mission_id ||
    m?.assigned_mission_id ||
    m?.id ||
    null
  );
}

function nftAccount(n) {
  return n?.nftAccount || n?.tokenAddress || n?.mintAddress || n?.mint || n?.id || null;
}

function pickAssignableNft(nfts) {
  const available = nfts.find((n) => n?.onCooldown !== true && nftAccount(n));
  if (available) return nftAccount(available);
  const fallback = nfts.find((n) => nftAccount(n));
  return fallback ? nftAccount(fallback) : null;
}

async function getUserMissions(opts = {}) {
  const res = await callTool("get_user_missions", {}, opts);
  return normalizeMissionsResponse(res);
}

async function getMissionNfts(args = {}, opts = {}) {
  const res = await callTool("get_mission_nfts", args, opts);
  return normalizeNftsResponse(res);
}

module.exports = {
  normalizeMissionsResponse,
  normalizeNftsResponse,
  assignedMissionId,
  nftAccount,
  pickAssignableNft,
  getUserMissions,
  getMissionNfts,
};
