"use strict";

const CLAIM_ANALYTICS_DEDUP_TTL_MS = 15000;

function normalizeTimestampMs(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  const text = String(value || "").trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeLevel(payload = {}) {
  const level = Number(
    payload?.missionLevel ??
      payload?.level ??
      payload?.mission_level ??
      payload?.currentLevel ??
      payload?.current_level ??
      null,
  );
  return Number.isFinite(level) ? level : null;
}

function dedupeKeyFromPayload(payload = {}) {
  const missionStartedAt = normalizeTimestampMs(
    payload?.missionStartedAt ??
      payload?.missionStartTimestamp ??
      payload?.mission_start_timestamp,
  );
  const missionCompletedAt = normalizeTimestampMs(
    payload?.missionCompletedAt ??
      payload?.missionCompletionTimestamp ??
      payload?.mission_completion_timestamp ??
      payload?.at,
  );
  const slot = Number(payload?.slot);
  const level = normalizeLevel(payload);
  const missionName = String(payload?.missionName || payload?.mission || "")
    .trim()
    .toLowerCase();
  const rewardToken = String(payload?.rewardToken || payload?.prize || "")
    .trim()
    .toLowerCase();
  const rewardAmount = Number(
    payload?.rewardAmount ??
      payload?.reward_amount ??
      payload?.amount ??
      payload?.prizeAmount ??
      payload?.prize_amount ??
      null,
  );
  const parts = ["claim"];
  if (Number.isFinite(missionStartedAt) && missionStartedAt > 0) {
    parts.push(`start:${missionStartedAt}`);
  }
  if (Number.isFinite(missionCompletedAt) && missionCompletedAt > 0) {
    parts.push(`done:${missionCompletedAt}`);
  }
  if (Number.isFinite(slot)) parts.push(`slot:${slot}`);
  if (Number.isFinite(level)) parts.push(`level:${level}`);
  if (missionName) parts.push(`mission:${missionName}`);
  if (rewardToken) parts.push(`token:${rewardToken}`);
  if (Number.isFinite(rewardAmount) && rewardAmount > 0) {
    parts.push(`amount:${rewardAmount}`);
  }
  return parts.length >= 4 ? parts.join("|") : "";
}

function recentClaimEventMap(ctx, scope = "analytics") {
  if (!ctx || typeof ctx !== "object") return null;
  if (
    !ctx.recentClaimEventScopes ||
    typeof ctx.recentClaimEventScopes !== "object"
  ) {
    ctx.recentClaimEventScopes = {};
  }
  if (!(ctx.recentClaimEventScopes[scope] instanceof Map)) {
    ctx.recentClaimEventScopes[scope] = new Map();
  }
  return ctx.recentClaimEventScopes[scope];
}

function registerClaimEvent(ctx, payload = {}, { scope = "analytics" } = {}) {
  if (!ctx || typeof ctx !== "object") return false;
  const now = Date.now();
  const recent = recentClaimEventMap(ctx, scope);
  if (!(recent instanceof Map)) return false;
  for (const [key, expiresAt] of recent.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) recent.delete(key);
  }
  const key = dedupeKeyFromPayload(payload);
  if (!key) return true;
  const expiresAt = Number(recent.get(key) || 0);
  if (Number.isFinite(expiresAt) && expiresAt > now) return false;
  recent.set(key, now + CLAIM_ANALYTICS_DEDUP_TTL_MS);
  return true;
}

function emitClaimAnalyticsEvent(ctx, payload = {}) {
  if (!ctx?.guiBridge || typeof ctx.guiBridge.sendEvent !== "function") {
    return false;
  }
  if (!registerClaimEvent(ctx, payload, { scope: "analytics" })) return false;
  ctx.guiBridge.sendEvent("stats_claim", payload);
  return true;
}

module.exports = {
  emitClaimAnalyticsEvent,
  registerClaimEvent,
};
