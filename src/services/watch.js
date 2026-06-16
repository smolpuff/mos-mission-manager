"use strict";

const {
  normalizeMissionList,
  missionHasAssignedNft,
  missionIsClaimable,
} = require("../missions/normalize");
const { parseResetLevel, evaluateResetCandidates } = require("./reset");
const {
  defaultResetPolicy,
  resetPolicyForMission,
} = require("../mission-reset-policy");
const {
  missionActionEnabledForMission,
} = require("../mission-slot-policy");
const {
  MISSION_PLAY_URL,
  openMissionPlayPage,
  MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
} = require("../mission-page");
const { createMissionActionExecutor } = require("../mission-actions");

function createWatchService(
  ctx,
  logger,
  mcp,
  checks,
  configApi,
  services = {},
) {
  const { logWithTimestamp, logDebug, redrawHeaderAndLog, formatTaggedLog } =
    logger;
  const { saveConfig } = configApi;
  const { signer = null } = services;
  const { executePreparedMissionAction } = createMissionActionExecutor(
    logger,
    mcp,
    signer,
  );
  const WATCH_MAX_CLAIMS = 4;
  const WATCH_FALLBACK_CLAIMS = true;
  const RESET_PROMPT_REOPEN_COOLDOWN_MS = 60_000;
  const DEFAULT_SESSION_REWARD_TOTALS = { pbp: 0, tc: 0, cc: 0 };
  const DEFAULT_SESSION_SPEND_TOTALS = { pbp: 0, tc: 0, cc: 0 };
  let cycleInFlight = null;
  let cycleAbortController = null;
  let traceSequence = 0;
  let walletRefreshTimer = null;
  let walletRefreshPendingReason = null;
  let currentWalletSummaryRefreshTimer = null;
  let currentWalletSummaryRefreshPendingReason = null;
  let nftCountWarmTimer = null;

  function summarizeNamesForUser(items = [], limit = 2) {
    const list = Array.isArray(items)
      ? items
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [];
    if (list.length === 0) return "(none)";
    if (list.length <= limit) return list.join(", ");
    return `${list.slice(0, limit).join(", ")} +${list.length - limit} more`;
  }

  function createMissionResultCoordinator({
    ttlMs = 1200,
    debugScope = "watch",
  } = {}) {
    let cachedResult = null;
    let cachedAt = 0;
    let inflight = null;
    let inflightForceFresh = false;

    function seed(result) {
      if (!(result && typeof result === "object")) return result;
      cachedResult = result;
      cachedAt = Date.now();
      return result;
    }

    async function get({ forceFresh = false, reason = "general" } = {}) {
      const now = Date.now();
      if (
        !forceFresh &&
        cachedResult &&
        now - Number(cachedAt || 0) <= Math.max(0, Number(ttlMs) || 0)
      ) {
        logDebug(debugScope, "mission_result_cache_hit", { reason });
        return cachedResult;
      }
      if (inflight && (!forceFresh || inflightForceFresh)) {
        logDebug(debugScope, "mission_result_inflight_reused", {
          reason,
          forceFresh: Boolean(forceFresh),
          inflightForceFresh,
        });
        return inflight;
      }
      if (inflight && forceFresh && !inflightForceFresh) {
        logDebug(debugScope, "mission_result_force_fresh_bypass_inflight", {
          reason,
        });
      }
      inflightForceFresh = Boolean(forceFresh);
      const request = mcp
        .getUserMissions({ reason })
        .then((result) => seed(result))
        .finally(() => {
          if (inflight === request) {
            inflight = null;
            inflightForceFresh = false;
          }
        });
      inflight = request;
      return request;
    }

    return {
      get,
      seed,
      peek: () => cachedResult,
      clear: () => {
        cachedResult = null;
        cachedAt = 0;
        inflight = null;
        inflightForceFresh = false;
      },
    };
  }

  function watchMinCycleSeconds() {
    return ctx.runtimeDefaults?.watchMinCycleSeconds || 30;
  }

  function claimWorkPaused() {
    return ctx.watchLoopEnabled === false;
  }

  function missionAutomationEnabled(mission) {
    return missionActionEnabledForMission(ctx, mission);
  }

  function missionName(mission, fallback = "") {
    return String(
      mission?.missionName ||
        mission?.name ||
        mission?.mission_name ||
        mission?.title ||
        mission?.mission ||
        mission?.label ||
        fallback,
    ).trim();
  }

  function looksLikeOpaqueMissionId(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      text,
    );
  }

  function resolveClaimDisplayName({
    missionName: providedMissionName = "",
    assignedMissionId = "",
    slot = null,
  } = {}) {
    const directName = missionName({ missionName: providedMissionName });
    if (directName && !looksLikeOpaqueMissionId(directName)) return directName;

    const wantedId = String(assignedMissionId || "").trim();
    const slotNumber = Number(slot);
    const cachedLookup =
      ctx.lastAssignedMissionLookup && typeof ctx.lastAssignedMissionLookup === "object"
        ? ctx.lastAssignedMissionLookup
        : {};
    const guiSlots = Array.isArray(ctx.guiMissionSlots) ? ctx.guiMissionSlots : [];

    if (wantedId) {
      const cached = cachedLookup[wantedId];
      const cachedName = missionName(cached);
      if (cachedName && !looksLikeOpaqueMissionId(cachedName)) return cachedName;
    }

    if (wantedId) {
      const byId =
        guiSlots.find(
          (entry) =>
            String(entry?.missionId || "").trim() === wantedId ||
            String(entry?.assignedMissionId || "").trim() === wantedId ||
            String(entry?.id || "").trim() === wantedId,
        ) || null;
      const byIdName = missionName(byId);
      if (byIdName && !looksLikeOpaqueMissionId(byIdName)) return byIdName;
    }

    if (Number.isFinite(slotNumber) && slotNumber >= 1) {
      const cachedBySlot =
        Object.values(cachedLookup).find(
          (entry) => Number(entry?.slot) === Math.floor(slotNumber),
        ) || null;
      const cachedSlotName = missionName(cachedBySlot);
      if (cachedSlotName && !looksLikeOpaqueMissionId(cachedSlotName)) {
        return cachedSlotName;
      }
      const bySlot =
        guiSlots.find((entry) => Number(entry?.slot) === Math.floor(slotNumber)) ||
        null;
      const bySlotName = missionName(bySlot);
      if (bySlotName && !looksLikeOpaqueMissionId(bySlotName)) return bySlotName;
    }

    return "";
  }

  function missionPageCooldownMs() {
    const sec = Number(ctx.config?.missionPageOpenCooldownSeconds);
    if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);
    const ms = Number(ctx.config?.missionPageOpenCooldownMs);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
    return MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT;
  }

  function usesBrowserBridgeSigning() {
    return ctx.signerMode === "dapp";
  }

  function preparedActionSigningArgs() {
    if (usesBrowserBridgeSigning()) return { signingMode: "browser_bridge" };
    return {
      signingMode: "agent_managed",
      ...(String(ctx.signerConfig?.walletAddress || "").trim()
        ? { payerWallet: String(ctx.signerConfig.walletAddress).trim() }
        : {}),
    };
  }

  function compactStructuredSummary(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      topLevelKeys: Object.keys(payload).slice(0, 8),
      success:
        typeof payload.success === "boolean" ? payload.success : undefined,
      assignedMissionId: payload.assignedMissionId || null,
      leaseId: payload.leaseId || payload.rentalLeaseId || null,
      nftId: payload.nftId || payload.nftAccount || payload.nftMint || null,
      message:
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.responseMessage === "string"
            ? payload.responseMessage
            : null,
    };
  }

  function browserBridgeUrlFromPrepared(prepared) {
    const sc =
      prepared?.structuredContent && typeof prepared.structuredContent === "object"
        ? prepared.structuredContent
        : {};
    const seen = new Set();
    const candidates = [
      sc.signingBridgeUrl,
      sc.signingUrl,
      sc?.signingMethods?.browserBridge?.signingUrl,
      sc?.signingMethods?.browserBridge?.url,
    ];
    const collectUrls = (value, path = "") => {
      if (value === null || value === undefined) return;
      if (typeof value === "string") {
        const url = value.trim();
        if (
          /^https?:\/\//i.test(url) &&
          /(sign|bridge|browser|wallet|transaction|tx)/i.test(path + url)
        ) {
          candidates.push(url);
        }
        const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        for (const matched of matches) {
          const clean = matched.replace(/[),.;]+$/, "");
          if (/(sign|bridge|browser|wallet|transaction|tx)/i.test(path + clean)) {
            candidates.push(clean);
          }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectUrls(entry, `${path}.${index}`));
        return;
      }
      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        collectUrls(child, path ? `${path}.${key}` : key);
      }
    };
    collectUrls(sc);
    collectUrls(prepared);
    for (const value of candidates) {
      const url = String(value || "").trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    const bridgePath = String(sc.signingBridgePath || "").trim();
    if (bridgePath.startsWith("/")) {
      return `https://pixelbypixel.studio${bridgePath}`;
    }
    const bridgeIdFallbacks = [
      {
        id: sc.missionRerollId,
        path: "/mcp/sign-mission-reroll",
        param: "missionRerollId",
      },
      {
        id: sc.missionSwapId,
        path: "/mcp/sign-mission-swap",
        param: "missionSwapId",
      },
      {
        id: sc.missionSlotUnlockId || sc.slotUnlockId || sc.unlockId,
        path: "/mcp/sign-mission-slot-unlock",
        param: "missionSlotUnlockId",
      },
    ];
    for (const entry of bridgeIdFallbacks) {
      const id = String(entry.id || "").trim();
      if (id) {
        return `https://pixelbypixel.studio${entry.path}?${entry.param}=${encodeURIComponent(id)}`;
      }
    }
    return null;
  }

  function scheduleFundingWalletRefresh(reason = "token_change") {
    // If the funding wallet is not in use, skip. Avoid spamming summary calls
    // when multiple token-affecting actions happen close together.
    if (ctx.signerMode !== "app_wallet") return;
    walletRefreshPendingReason = reason;
    if (walletRefreshTimer) return;
    walletRefreshTimer = setTimeout(() => {
      walletRefreshTimer = null;
      const pending = walletRefreshPendingReason || "token_change";
      walletRefreshPendingReason = null;
      Promise.resolve()
        .then(() => checks.refreshFundingWalletSummary())
        .catch((error) =>
          logDebug("watch", "funding_wallet_refresh_failed", {
            reason: pending,
            error: error.message,
          }),
        );
    }, 250);
  }

  function scheduleCurrentWalletSummaryRefresh(reason = "wallet_change") {
    currentWalletSummaryRefreshPendingReason = reason;
    if (currentWalletSummaryRefreshTimer) return;
    currentWalletSummaryRefreshTimer = setTimeout(() => {
      currentWalletSummaryRefreshTimer = null;
      const pending =
        currentWalletSummaryRefreshPendingReason || "wallet_change";
      currentWalletSummaryRefreshPendingReason = null;
      if (!checks || typeof checks.runWhoAmICheck !== "function") return;
      Promise.resolve()
        .then(() => checks.runWhoAmICheck())
        .then(() => {
          logDebug("watch", "current_wallet_summary_refreshed", {
            reason: pending,
          });
          if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        })
        .catch((error) =>
          logDebug("watch", "current_wallet_summary_refresh_failed", {
            reason: pending,
            error: error.message,
          }),
        );
    }, 350);
  }

  function nextTraceId(kind = "cycle") {
    traceSequence += 1;
    return `${kind}_${traceSequence}`;
  }

  function clearGuiMissionSlot(slot) {
    const slotNumber = Number(slot);
    if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 4) {
      return false;
    }
    const slots = Array.isArray(ctx.guiMissionSlots) ? ctx.guiMissionSlots : [];
    if (slots.length !== 4) return false;
    const next = slots.slice();
    next[slotNumber - 1] = {
      slot: slotNumber,
      missionId: null,
      missionName: null,
      missionLevel: null,
      progress: null,
      goal: null,
      assignedNft: null,
      nftLevel: null,
      nftImage: null,
    };
    ctx.guiMissionSlots = next;
    return true;
  }

  async function sleep(ms) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Number(ms) || 0)),
    );
  }

  async function waitForDappRerollSettlement(assignedMissionId, opts = {}) {
    const wantedId = String(assignedMissionId || "").trim();
    if (!wantedId)
      return { settled: false, reason: "missing_assigned_mission_id" };
    const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 12_000);
    const pollMs = Math.max(250, Number(opts.pollMs) || 1_500);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const missionsResult = await mcp.getUserMissions({
          forceFresh: true,
          reason: "dapp_reroll_settlement_poll",
        });
        const missions = normalizeMissionList(missionsResult);
        const mission = missions.find((entry) => {
          const id = String(
            entry?.assignedMissionId || entry?.assigned_mission_id || "",
          ).trim();
          return id === wantedId;
        });
        if (!mission) {
          return { settled: true, reason: "mission_not_found" };
        }
        if (!missionHasAssignedNft(mission)) {
          return { settled: true, reason: "assigned_nft_cleared" };
        }
      } catch (error) {
        logDebug("watch", "dapp_reroll_settle_poll_failed", {
          assignedMissionId: wantedId,
          error: error.message,
        });
      }
      await sleep(pollMs);
    }
    return { settled: false, reason: "timeout" };
  }

  function snapshotTraceSummary(snapshotMap) {
    if (!(snapshotMap instanceof Map)) return [];
    return Array.from(snapshotMap.values()).map((m) => ({
      id: m.assignedMissionId || m.id || null,
      name: m.name || null,
      slot: m.slot ?? null,
      completed: m.completed === true,
      assignedNft: m.assignedNft ? "yes" : "no",
      level: m.level ?? null,
      startTime: m.startTime || "",
    }));
  }

  function trace(scope, action, meta = {}) {
    logDebug(scope, `trace_${action}`, meta);
  }

  function normalizeRewardBucket(prize) {
    const value = String(prize || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    if (!value) return null;
    if (
      value === "pbp" ||
      value === "pbp_token" ||
      value === "pixel_by_pixel"
    ) {
      return "pbp";
    }
    if (
      value === "tc" ||
      value === "tc_token" ||
      value === "tournament_coin" ||
      value === "tournament_coins"
    ) {
      return "tc";
    }
    if (
      value === "cc" ||
      value === "cc_token" ||
      value === "community_coin" ||
      value === "community_coins"
    ) {
      return "cc";
    }
    return null;
  }

  function ensureSessionRewardTotals() {
    if (
      !ctx.sessionRewardTotals ||
      typeof ctx.sessionRewardTotals !== "object"
    ) {
      ctx.sessionRewardTotals = { ...DEFAULT_SESSION_REWARD_TOTALS };
    }
    for (const key of Object.keys(DEFAULT_SESSION_REWARD_TOTALS)) {
      if (typeof ctx.sessionRewardTotals[key] !== "number") {
        ctx.sessionRewardTotals[key] = 0;
      }
    }
    return ctx.sessionRewardTotals;
  }

  function resetSessionRewardTotals() {
    ctx.sessionRewardTotals = { ...DEFAULT_SESSION_REWARD_TOTALS };
  }

  function ensureSessionSpendTotals() {
    if (!ctx.sessionSpendTotals || typeof ctx.sessionSpendTotals !== "object") {
      ctx.sessionSpendTotals = { ...DEFAULT_SESSION_SPEND_TOTALS };
    }
    for (const key of Object.keys(DEFAULT_SESSION_SPEND_TOTALS)) {
      if (typeof ctx.sessionSpendTotals[key] !== "number") {
        ctx.sessionSpendTotals[key] = 0;
      }
    }
    return ctx.sessionSpendTotals;
  }

  function resetSessionSpendTotals() {
    ctx.sessionSpendTotals = { ...DEFAULT_SESSION_SPEND_TOTALS };
  }

  function addSessionSpendTotals(
    cost,
    { actionName = "prepared_action" } = {},
  ) {
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const totals = ensureSessionSpendTotals();
    totals.pbp += amount;
    logDebug("watch", "session_spend_totals_updated", {
      actionName,
      cost: amount,
      totals: { ...totals },
    });
    if (ctx.guiBridge?.sendEvent) {
      ctx.guiBridge.sendEvent("stats_spend", {
        source: "watch",
        at: Date.now(),
        actionName,
        amount,
      });
    }
    if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
    logWithTimestamp(
      `[SPEND] 💸 ${actionName}: -${amount} PBP (session spend ${totals.pbp})`,
    );
    scheduleFundingWalletRefresh(`spend_${actionName}`);
    return totals;
  }

  function addSessionRewardTotals(deltas = {}, { logLabel = "Claimed" } = {}) {
    const totals = ensureSessionRewardTotals();
    let changed = false;
    for (const [key, delta] of Object.entries(deltas || {})) {
      const amount = Number(delta || 0);
      if (!Number.isFinite(amount) || amount === 0) continue;
      if (typeof totals[key] !== "number") totals[key] = 0;
      totals[key] += amount;
      changed = true;
    }
    if (changed) {
      logDebug("watch", "session_reward_totals_updated", {
        logLabel,
        totals: { ...totals },
      });
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      scheduleFundingWalletRefresh(
        `reward_${String(logLabel || "claim").toLowerCase()}`,
      );
    }
    return totals;
  }

  function summarizeWatchPayload(result) {
    const sc = result?.structuredContent || {};
    return {
      topLevelKeys: Object.keys(sc),
      watchKeys:
        sc.watch && typeof sc.watch === "object" ? Object.keys(sc.watch) : [],
      missionSnapshot: sc.missionSnapshot || null,
      claimedCount:
        sc.claimedCount ??
        sc.claim_count ??
        sc.claimed ??
        sc.totalClaimed ??
        sc.claimsProcessed ??
        null,
      watchClaimedCount:
        sc?.watch?.claimedCount ??
        sc?.watch?.claim_count ??
        sc?.watch?.claimed ??
        sc?.watch?.totalClaimed ??
        sc?.watch?.claimsProcessed ??
        null,
      rawClaimsLength: Array.isArray(sc.claims) ? sc.claims.length : null,
      rawClaimedMissionsLength: Array.isArray(sc.claimedMissions)
        ? sc.claimedMissions.length
        : null,
      rawRewardsClaimedLength: Array.isArray(sc.rewardsClaimed)
        ? sc.rewardsClaimed.length
        : null,
      rawWatchClaimsLength: Array.isArray(sc?.watch?.claims)
        ? sc.watch.claims.length
        : null,
      compactClaims: collectClaimEvents(result).map((c) =>
        compactClaimDetails(c),
      ),
    };
  }

  function extractClaimCount(watchResult) {
    const sc = watchResult?.structuredContent || {};
    const byKeyRaw =
      sc.claimedCount ??
      sc.claim_count ??
      sc.claimed ??
      sc.totalClaimed ??
      sc.claimsProcessed ??
      sc?.watch?.claimedCount ??
      sc?.watch?.claim_count ??
      sc?.watch?.claimed ??
      sc?.watch?.totalClaimed ??
      sc?.watch?.claimsProcessed;
    const asNumber =
      typeof byKeyRaw === "number"
        ? byKeyRaw
        : typeof byKeyRaw === "string"
          ? Number(byKeyRaw)
          : NaN;
    const byKey = Number.isFinite(asNumber) ? Math.max(0, asNumber) : 0;
    const byEvents = collectClaimEvents(watchResult).filter(
      (c) => c?.success !== false,
    ).length;
    // Some responses include aggregate counters that can be stale. Prefer successful events.
    return Math.max(byKey, byEvents);
  }

  function extractRawClaimCounterValue(watchResult) {
    const sc = watchResult?.structuredContent || {};
    const raw =
      sc.claimedCount ??
      sc.claim_count ??
      sc.claimed ??
      sc.totalClaimed ??
      sc.claimsProcessed ??
      sc?.watch?.claimedCount ??
      sc?.watch?.claim_count ??
      sc?.watch?.claimed ??
      sc?.watch?.totalClaimed ??
      sc?.watch?.claimsProcessed ??
      sc?.watch?.claims_count ??
      sc?.watch?.successfulClaims ??
      sc?.watch?.successful_claims;
    if (typeof raw === "number" && Number.isFinite(raw))
      return Math.max(0, raw);
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
    return null;
  }

  function extractFailedClaimCount(watchResult) {
    return collectClaimEvents(watchResult).filter((c) => c?.success === false)
      .length;
  }

  function extractClaimEventCount(watchResult) {
    return collectClaimEvents(watchResult).length;
  }

  function normalizeClaimEvent(entry) {
    if (entry && typeof entry === "object") return entry;
    if (typeof entry === "string" && entry.trim().length > 0) {
      return { assignedMissionId: entry, success: true };
    }
    return null;
  }

  function collectClaimEvents(result) {
    const sc = result?.structuredContent || {};
    const buckets = [
      sc.claims,
      sc.claimedMissions,
      sc.rewardsClaimed,
      sc?.watch?.claims,
      sc?.watch?.claimedMissions,
      sc?.watch?.rewardsClaimed,
    ];
    const events = [];
    for (const bucket of buckets) {
      if (!Array.isArray(bucket)) continue;
      for (const item of bucket) {
        const normalized = normalizeClaimEvent(item);
        if (normalized) events.push(normalized);
      }
    }
    return events;
  }

  function summarizeWatch(result) {
    const sc = result?.structuredContent || {};
    const watch = sc.watch || {};
    const snapshot = sc.missionSnapshot || {};
    const claims = collectClaimEvents(result);
    return {
      polls: Number(watch.polls || 0),
      windowEnded: Boolean(watch.timedOut),
      elapsedMs: Number(watch.elapsedMs || 0),
      eligible: Number(snapshot.eligible || 0),
      total: Number(snapshot.total || 0),
      claims,
    };
  }

  function compactClaimDetails(claim, lookupByAssignedMissionId = null) {
    const missionId =
      claim?.assignedMissionId ||
      claim?.assigned_mission_id ||
      claim?.missionId ||
      claim?.id ||
      null;
    const fromLookup =
      missionId && lookupByAssignedMissionId instanceof Map
        ? lookupByAssignedMissionId.get(missionId) || null
        : null;
    return {
      missionId,
      name:
        missionName(claim) || missionName(fromLookup) || fromLookup?.name || null,
      level: claim?.level ?? claim?.current_level ?? fromLookup?.level ?? null,
      slot: claim?.slot ?? fromLookup?.slot ?? null,
      reward:
        claim?.rewardAmount ??
        claim?.reward_amount ??
        claim?.amount ??
        claim?.prize_amount ??
        claim?.reward ??
        fromLookup?.reward ??
        null,
      prize: claim?.prize ?? claim?.rewardToken ?? fromLookup?.prize ?? null,
      raw: claim,
    };
  }

  function logClaimDetails(claims, lookupByAssignedMissionId = null) {
    let successCount = 0;
    for (const c of claims) {
      const d = compactClaimDetails(c, lookupByAssignedMissionId);
      const missionText = d.name
        ? `${d.name}`
        : d.missionId || "unknown mission";
      const slotText = d.slot === null ? "" : ` slot=${d.slot}`;
      const levelText = d.level === null ? "" : ` lvl=${d.level}`;
      const rewardText = d.reward === null ? "" : ` Reward: ${d.reward}`;
      const messageText = c?.message ? ` msg=${c.message}` : "";
      if (c?.success === false) {
        logWithTimestamp(
          `[WATCH] ❌ Claim failed: ${missionText}${slotText}${levelText}${rewardText}${messageText}`.trim(),
        );
      } else {
        successCount += 1;
        if (ctx.guiBridge && typeof ctx.guiBridge.sendEvent === "function") {
          const label = resolveClaimDisplayName({
            missionName: d.name,
            assignedMissionId: d.missionId,
            slot: d.slot,
          });
          ctx.guiBridge.sendEvent("stats_claim", {
            source: "watch_claims",
            at: Date.now(),
            assignedMissionId: d.missionId || null,
            missionName: label || null,
            slot: d.slot ?? null,
            level: d.level ?? null,
            rewardAmount: d.reward ?? null,
            rewardToken: d.prize ?? null,
          });
        }
        logWithTimestamp(
          `[WATCH] ✅ Claimed: ${missionText}${slotText}${levelText}${rewardText}${messageText}`.trim(),
        );
      }
    }
    return successCount;
  }

  function collectClaimRewardDeltas(claims, lookupByAssignedMissionId = null) {
    const totals = { ...DEFAULT_SESSION_REWARD_TOTALS };
    for (const c of Array.isArray(claims) ? claims : []) {
      if (c?.success === false) continue;
      const missionId =
        c?.assignedMissionId ||
        c?.assigned_mission_id ||
        c?.missionId ||
        c?.id ||
        null;
      const lookup =
        missionId && lookupByAssignedMissionId instanceof Map
          ? lookupByAssignedMissionId.get(missionId) || null
          : null;
      const bucket = normalizeRewardBucket(
        c?.prize || c?.rewardToken || lookup?.prize,
      );
      const amountRaw =
        c?.prizeAmount ??
        c?.prize_amount ??
        c?.rewardAmount ??
        c?.reward_amount ??
        c?.amount ??
        c?.reward ??
        lookup?.reward ??
        lookup?.prizeAmount ??
        null;
      let amount = Number(amountRaw);
      if (!Number.isFinite(amount) && typeof amountRaw === "string") {
        const match = amountRaw.match(/([0-9]+(?:\.[0-9]+)?)/);
        amount = match ? Number(match[1]) : NaN;
      }
      if (!bucket || !Number.isFinite(amount) || amount <= 0) continue;
      totals[bucket] += amount;
    }
    return totals;
  }

  function watchConfig() {
    const minCycleSeconds = watchMinCycleSeconds();
    const maxLimitSeconds = ctx.runtimeDefaults?.watchMaxLimitSeconds || 600;
    const configuredPoll = Number(ctx.config.watchPollIntervalSeconds);
    const rawPollIntervalSeconds =
      Number.isFinite(configuredPoll) && configuredPoll > 0
        ? configuredPoll
        : ctx.runtimeDefaults?.watchDefaultPollSeconds || 45;
    // Server-facing poll interval: keep this conservative by default.
    const pollIntervalSeconds = Math.max(
      minCycleSeconds,
      Math.floor(rawPollIntervalSeconds),
    );
    const maxClaims = WATCH_MAX_CLAIMS;
    const fallbackClaims = WATCH_FALLBACK_CLAIMS;
    const configuredCycleSeconds = Number(ctx.config.watchCycleSeconds);
    const derivedCycleSeconds = Math.max(
      minCycleSeconds,
      Math.ceil(pollIntervalSeconds),
    );
    const watchSeconds =
      Number.isFinite(configuredCycleSeconds) && configuredCycleSeconds > 0
        ? Math.max(
            minCycleSeconds,
            Math.min(maxLimitSeconds, configuredCycleSeconds),
          )
        : Math.min(maxLimitSeconds, derivedCycleSeconds);
    return {
      maxLimitSeconds,
      pollIntervalSeconds,
      maxClaims,
      watchSeconds,
      fallbackClaims,
    };
  }

  function missionStatusValue(mission, statsByAssignedMissionId) {
    const id = mission?.assignedMissionId || mission?.assigned_mission_id;
    const stats = id ? statsByAssignedMissionId?.[id] : null;
    const progressRaw =
      mission?.progress ??
      mission?.currentProgress ??
      mission?.task_progress ??
      mission?.taskProgress ??
      stats?.progress ??
      0;
    const progress = Number(progressRaw);
    const taskAmountRaw =
      mission?.task_amount ??
      mission?.taskAmount ??
      mission?.goal ??
      mission?.target ??
      0;
    const taskAmount = Number(taskAmountRaw);
    const eventName = String(
      mission?.task_event || mission?.taskEvent || "progress",
    )
      .trim()
      .toLowerCase();
    const eventSuffix = eventName ? ` ${eventName}` : "";
    const lhs = Number.isFinite(progress) ? progress : 0;
    const rhs = Number.isFinite(taskAmount) ? taskAmount : 0;
    return `${lhs}/${rhs}${eventSuffix}`.trim();
  }

  function buildMissionStateMap(missionResult) {
    const sc = missionResult?.structuredContent || {};
    const statsByAssignedMissionId = sc?.missions?.stats || {};
    const missions = checks.filterSelectedMissions(
      normalizeMissionList(missionResult),
    );
    const byId = new Map();
    for (const m of missions) {
      const id = m?.assignedMissionId || m?.assigned_mission_id;
      if (!id) continue;
      const name = missionName(m, id);
      const slot = m?.slot ?? null;
      const status = missionStatusValue(m, statsByAssignedMissionId);
      const completed = m?.completed === true;
      const assigned = Boolean(m?.assigned_nft);
      byId.set(id, {
        id,
        name,
        slot,
        status,
        completed,
        assigned,
        signature: `${name}|slot=${slot}|status=${status}|completed=${completed}|assigned=${assigned}`,
      });
    }
    return byId;
  }

  async function pollMissionStateChanges(
    previousState,
    reason,
    { logInitial = false, missionResult = null, missionResultLoader = null } = {},
  ) {
    const result =
      missionResult ||
      (missionResultLoader
        ? await missionResultLoader({
            reason: `poll_state_${reason}`,
          })
        : await mcp.getUserMissions({ reason: `poll_state_${reason}` }));
    const currentState = buildMissionStateMap(result);
    if (logInitial) {
      for (const entry of currentState.values()) {
        logDebug("watch", "mission_state_initial", {
          reason,
          missionId: entry.id,
          name: entry.name,
          slot: entry.slot,
          status: entry.status,
          completed: entry.completed,
          assigned: entry.assigned,
        });
      }
      return currentState;
    }

    const allIds = new Set([...previousState.keys(), ...currentState.keys()]);
    for (const id of allIds) {
      const before = previousState.get(id) || null;
      const after = currentState.get(id) || null;
      if (!before && after) {
        logDebug("watch", "mission_state_changed", {
          reason,
          missionId: id,
          change: "added",
          nameAfter: after.name,
          slotAfter: after.slot,
          statusAfter: after.status,
          completedAfter: after.completed,
          assignedAfter: after.assigned,
        });
        continue;
      }
      if (before && !after) {
        logDebug("watch", "mission_state_changed", {
          reason,
          missionId: id,
          change: "removed",
          nameBefore: before.name,
          slotBefore: before.slot,
          statusBefore: before.status,
          completedBefore: before.completed,
          assignedBefore: before.assigned,
        });
        continue;
      }
      if (before && after && before.signature !== after.signature) {
        logDebug("watch", "mission_state_changed", {
          reason,
          missionId: id,
          change: "updated",
          nameBefore: before.name,
          statusBefore: before.status,
          completedBefore: before.completed,
          assignedBefore: before.assigned,
          nameAfter: after.name,
          slotAfter: after.slot,
          statusAfter: after.status,
          completedAfter: after.completed,
          assignedAfter: after.assigned,
        });
      }
    }
    return currentState;
  }

  async function loadAssignedMissionLookup(
    missionResult = null,
    missionResultLoader = null,
  ) {
    const result =
      missionResult ||
      (missionResultLoader
        ? await missionResultLoader({ reason: "assigned_mission_lookup" })
        : await mcp.getUserMissions({ reason: "assigned_mission_lookup" }));
    const missions = normalizeMissionList(result);
    const byAssignedMissionId = new Map();
    for (const m of missions) {
      const id = m?.assignedMissionId || m?.assigned_mission_id;
      if (!id) continue;
      byAssignedMissionId.set(id, {
        name: missionName(m) || null,
        slot: m?.slot ?? null,
        level: m?.current_level ?? m?.level ?? null,
        reward:
          m?.prize_amount ??
          m?.prizeAmount ??
          m?.rewardAmount ??
          m?.reward_amount ??
          null,
        prize: m?.prize ?? m?.prizeToken ?? m?.rewardToken ?? null,
      });
    }
    return byAssignedMissionId;
  }

  function mergeAssignedMissionLookups(...maps) {
    const merged = new Map();
    for (const map of maps) {
      if (!(map instanceof Map)) continue;
      for (const [id, value] of map.entries()) {
        const existing = merged.get(id) || {};
        merged.set(id, {
          name: existing.name ?? value?.name ?? null,
          slot: existing.slot ?? value?.slot ?? null,
          level: existing.level ?? value?.level ?? null,
          reward: existing.reward ?? value?.reward ?? null,
          prize: existing.prize ?? value?.prize ?? null,
        });
      }
    }
    return merged;
  }

  async function loadMissionSnapshot(
    missionResult = null,
    { selectedOnly = true, missionResultLoader = null } = {},
  ) {
    const result =
      missionResult ||
      (missionResultLoader
        ? await missionResultLoader({ reason: "mission_snapshot" })
        : await mcp.getUserMissions({ reason: "mission_snapshot" }));
    const allMissions = normalizeMissionList(result);
    const missions = selectedOnly
      ? checks.filterSelectedMissions(allMissions)
      : allMissions;
    const byAssignedMissionId = new Map();
    for (const m of missions) {
      if (!missionAutomationEnabled(m)) continue;
      const rawAssignedMissionId =
        m?.assignedMissionId || m?.assigned_mission_id || "";
      const missionLabel = missionName(m, "unknown mission");
      const slot = m?.slot ?? "na";
      const assignedMissionId =
        String(rawAssignedMissionId || "").trim() ||
        `slot:${slot}:${missionLabel}`;
      const completed = missionIsClaimable(m) || m?.completed === true;
      const assignedNftRaw =
        m?.assigned_nft ||
        m?.assignedNft ||
        m?.assigned_nft_account ||
        m?.assignedNftAccount ||
        m?.nftAccount ||
        m?.nft_account ||
        m?.nft?.nftAccount ||
        m?.nft?.tokenAddress ||
        null;
      byAssignedMissionId.set(assignedMissionId, {
        assignedMissionId,
        name: missionLabel,
        slot: m?.slot ?? null,
        completed,
        assignedNft: missionHasAssignedNft(m)
          ? String(assignedNftRaw || "assigned")
          : null,
        level: parseResetLevel(m),
        startTime: String(m?.start_time || m?.startTime || ""),
      });
    }
    return byAssignedMissionId;
  }

  async function loadSelectedMissionSnapshot(
    missionResult = null,
    missionResultLoader = null,
  ) {
    return loadMissionSnapshot(missionResult, {
      selectedOnly: true,
      missionResultLoader,
    });
  }

  function deriveStateTransitions(beforeMap, afterMap) {
    const started = [];
    const restarted = [];
    const claimed = [];
    let claimedTransitions = 0;
    const stableKey = (m) =>
      `${String(m?.name || "")
        .trim()
        .toLowerCase()}|slot=${m?.slot ?? "na"}`;
    const beforeByStable = new Map();
    const afterByStable = new Map();
    for (const mission of beforeMap?.values() || []) {
      beforeByStable.set(stableKey(mission), mission);
    }
    for (const mission of afterMap?.values() || []) {
      afterByStable.set(stableKey(mission), mission);
    }
    const allStable = new Set([
      ...beforeByStable.keys(),
      ...afterByStable.keys(),
    ]);
    for (const key of allStable) {
      const before = beforeByStable.get(key) || null;
      const after = afterByStable.get(key) || null;
      if (!before || !after) continue;
      const beforeId = before.assignedMissionId || null;
      const afterId = after.assignedMissionId || null;
      const idChanged = Boolean(beforeId && afterId && beforeId !== afterId);
      if (!before.assignedNft && after.assignedNft) {
        started.push({
          name: after.name,
          slot: after.slot,
          nft: after.assignedNft,
          assignedMissionId:
            after.assignedMissionId || before.assignedMissionId || null,
        });
      }
      const levelUp = Number(after.level || 0) > Number(before.level || 0);
      const startTimeChanged =
        before.startTime &&
        after.startTime &&
        before.startTime !== after.startTime;
      if (
        before.assignedNft &&
        after.assignedNft &&
        (levelUp || startTimeChanged)
      ) {
        restarted.push({
          name: after.name,
          slot: after.slot,
          fromLevel: before.level,
          toLevel: after.level,
          startTimeChanged,
          assignedMissionId:
            after.assignedMissionId || before.assignedMissionId || null,
        });
      }
      if (before.completed === true && after.completed === false) {
        claimedTransitions += 1;
        claimed.push({
          name: before.name || after.name || "unknown mission",
          slot: before.slot ?? after.slot ?? null,
          fromLevel: before.level ?? null,
          toLevel: after.level ?? null,
          assignedMissionId: beforeId || afterId || null,
          reason: "completed_to_incomplete",
        });
      } else if (levelUp) {
        claimedTransitions += 1;
        claimed.push({
          name: before.name || after.name || "unknown mission",
          slot: before.slot ?? after.slot ?? null,
          fromLevel: before.level ?? null,
          toLevel: after.level ?? null,
          assignedMissionId: beforeId || afterId || null,
          reason: "level_up",
        });
      } else if (idChanged && before.assignedNft && !after.assignedNft) {
        // Backend can represent claim as remove+add with a new assignedMissionId.
        claimedTransitions += 1;
        claimed.push({
          name: before.name || after.name || "unknown mission",
          slot: before.slot ?? after.slot ?? null,
          fromLevel: before.level ?? null,
          toLevel: after.level ?? null,
          assignedMissionId: beforeId || afterId || null,
          reason: "id_changed_unassigned",
        });
      }
    }
    return { started, restarted, claimedTransitions, claimed };
  }

  function logClaimTransitionDetails(
    claimedTransitions,
    prefix = "[WATCH] ✅ Claimed",
    lookupByAssignedMissionId = null,
  ) {
    if (!Array.isArray(claimedTransitions) || claimedTransitions.length === 0) {
      return 0;
    }
    let logged = 0;
    for (const entry of claimedTransitions) {
      const d = compactClaimDetails(entry, lookupByAssignedMissionId);
      const missionText = String(
        d.name || entry?.name || d.missionId || "unknown mission",
      ).trim();
      const slotText = entry?.slot === null ? "" : ` slot=${entry.slot}`;
      const fromText =
        entry?.fromLevel === null ? "" : ` lvl=${Number(entry.fromLevel || 0)}`;
      const toText =
        entry?.toLevel === null || entry?.toLevel === entry?.fromLevel
          ? ""
          : ` -> lvl=${Number(entry.toLevel || 0)}`;
      if (ctx.guiBridge && typeof ctx.guiBridge.sendEvent === "function") {
        const label = resolveClaimDisplayName({
          missionName: d.name || entry?.name,
          assignedMissionId: d.missionId || entry?.assignedMissionId || entry?.id,
          slot: d.slot ?? entry?.slot ?? null,
        });
        ctx.guiBridge.sendEvent("stats_claim", {
          source: String(prefix || "").replace(/^\[WATCH\]\s+✅\s+/, ""),
          at: Date.now(),
          assignedMissionId: d.missionId || entry?.assignedMissionId || entry?.id || null,
          missionName: label || null,
          slot: d.slot ?? entry?.slot ?? null,
          level: entry?.fromLevel ?? null,
          rewardAmount: d.reward ?? null,
          rewardToken: d.prize ?? null,
        });
      }
      logWithTimestamp(
        `${prefix}: ${missionText}${slotText}${fromText}${toText}`,
      );
      logged += 1;
    }
    return logged;
  }

  function applyClaimCountUpdate(claimed, { logLabel = "Claimed" } = {}) {
    if (!(claimed > 0)) return 0;
    const before = Number(ctx.sessionClaimedCount || 0);
    const totalBefore = Number(ctx.config.totalClaimed || 0);
    const safeBefore = Number.isFinite(before) ? before : 0;
    const safeTotalBefore = Number.isFinite(totalBefore) ? totalBefore : 0;
    ctx.sessionClaimedCount = safeBefore + claimed;
    ctx.currentMissionStats.claimed = ctx.sessionClaimedCount;
    ctx.config.totalClaimed = safeTotalBefore + claimed;
    saveConfig(ctx, logDebug);
    logDebug("watch", "claimed_counter_updated", {
      delta: claimed,
      sessionBefore: safeBefore,
      sessionAfter: ctx.sessionClaimedCount,
      totalBefore: safeTotalBefore,
      totalAfter: Number(ctx.config.totalClaimed || 0),
      logLabel,
    });
    logWithTimestamp(
      `[WATCH] ✅ ${logLabel}: +${claimed} (session ${safeBefore} -> ${ctx.sessionClaimedCount}, total ${safeTotalBefore} -> ${ctx.config.totalClaimed})`,
    );
    if (ctx.guiBridge && typeof ctx.guiBridge.sendEvent === "function") {
      ctx.guiBridge.sendEvent("claimed", { claimed, logLabel });
    }
    if (ctx.guiBridge && typeof ctx.guiBridge.emitNow === "function") {
      ctx.guiBridge.emitNow();
    }
    scheduleCurrentWalletSummaryRefresh("claim");
    return claimed;
  }

  function applyOptimisticClaimSlotRefresh(
    claims,
    lookupByAssignedMissionId = null,
  ) {
    const claimedSlots = new Set();
    const claimSummaries = [];
    for (const claim of Array.isArray(claims) ? claims : []) {
      const d = compactClaimDetails(claim, lookupByAssignedMissionId);
      claimSummaries.push(d);
      const slot = Number(d.slot);
      if (Number.isFinite(slot) && slot > 0) claimedSlots.add(slot);
    }
    if (claimedSlots.size === 0) return 0;
    const existing = Array.isArray(ctx.guiMissionSlots)
      ? ctx.guiMissionSlots
      : [];
    let changed = false;
    const next = existing.map((entry) => {
      const slot = Number(entry?.slot);
      if (!Number.isFinite(slot) || !claimedSlots.has(slot)) return entry;
      changed = true;
      const summary = claimSummaries.find(
        (item) => Number(item?.slot) === slot && item?.slot !== null,
      );
      return {
        ...entry,
        missionId: null,
        missionName: null,
        missionLevel: null,
        progress: null,
        goal: null,
        missionImage: null,
        image: null,
        assignedNft: null,
        assignedNftAccount: null,
        assignedNftImage: null,
        nftLevel: null,
        nftImage: null,
        pendingHydration: true,
        slotHydrationState: "loading",
        slotHydrationReason: "claim_refresh",
        slotHydrationLabel: summary?.name || `slot ${slot}`,
      };
    });
    if (!changed) return 0;
    ctx.guiMissionSlots = next;
    if (ctx.guiBridge && typeof ctx.guiBridge.emitNow === "function") {
      ctx.guiBridge.emitNow();
    }
    return claimedSlots.size;
  }

  function applyPendingClaimSlotRefresh({
    reason = "claim_refresh",
    slots = [],
  } = {}) {
    const existing = Array.isArray(ctx.guiMissionSlots)
      ? ctx.guiMissionSlots
      : [];
    if (existing.length === 0) return 0;
    const targetSlots = new Set(
      (Array.isArray(slots) ? slots : [])
        .map((slot) => Number(slot))
        .filter((slot) => Number.isFinite(slot) && slot > 0),
    );
    if (targetSlots.size === 0) {
      logDebug("watch", "pending_claim_slot_refresh_skipped", {
        reason,
        because: "no_target_slots",
      });
      return 0;
    }
    let changed = false;
    const next = existing.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const slot = Number(entry.slot);
      if (!Number.isFinite(slot) || !targetSlots.has(slot)) return entry;
      changed = true;
      return {
        ...entry,
        missionId: null,
        missionName: null,
        missionLevel: null,
        progress: null,
        goal: null,
        missionImage: null,
        image: null,
        assignedNft: null,
        assignedNftAccount: null,
        assignedNftImage: null,
        nftLevel: null,
        nftImage: null,
        pendingHydration: true,
        slotHydrationState: "loading",
        slotHydrationReason: reason,
        slotHydrationLabel: `slot ${slot || "?"}`,
      };
    });
    if (!changed) return 0;
    ctx.guiMissionSlots = next;
    if (ctx.guiBridge && typeof ctx.guiBridge.emitNow === "function") {
      ctx.guiBridge.emitNow();
    }
    return targetSlots.size;
  }

  function logAssignCheckResult(assignResult) {
    if (!ctx.debugMode) return;
    const attempted = Number(assignResult?.attempted || 0);
    const assigned = Number(assignResult?.assigned || 0);
    const skipped = assignResult?.skipped === true;
    logWithTimestamp(
      assigned > 0
        ? `[ASSIGN] ✅ result: attempted=${attempted} assigned=${assigned} skipped=${skipped}`
        : `[ASSIGN] ℹ️ result: attempted=${attempted} assigned=${assigned} skipped=${skipped}`,
    );
  }

  // this was poopoo method.
  async function fetchSelectedSnapshot(
    missionResult = null,
    missionResultLoader = null,
  ) {
    const result =
      missionResult ||
      (missionResultLoader
        ? await missionResultLoader({ reason: "selected_snapshot" })
        : await mcp.getUserMissions({ reason: "selected_snapshot" }));
    const snapshot = await loadSelectedMissionSnapshot(result, missionResultLoader);
    return { result, snapshot };
  }

  // Prime said he had a one-shot solution, but he didnt.
  async function runClaimLifecycle({
    traceId = null,
    beforeSnapshot = new Map(),
    claimed = 0,
    claims = [],
    claimLookupByAssignedMissionId = null,
    aggregateClaimLogLine = "",
    assignReason,
    claimLogLabel = "Claimed",
    assignIntro = "[ASSIGN] ▶ Post-claim assign check (immediate)...",
    initialMissionResult = null,
    allowStateFallback = true,
    finalTraceAction = "",
    finalTraceMeta = {},
    missionResultLoader = null,
  } = {}) {
    if (claimWorkPaused()) {
      trace("watch", "claim_lifecycle_skipped_paused", {
        traceId,
        claimed: Number(claimed || 0),
        assignReason,
      });
      return {
        claimed: Number(claimed || 0),
        assigned: 0,
        missionResult: initialMissionResult,
      };
    }
    let currentClaimed = Number(claimed || 0);
    if (Array.isArray(claims) && claims.length > 0) {
      const successFromClaimLines = logClaimDetails(
        claims,
        claimLookupByAssignedMissionId,
      );
      addSessionRewardTotals(
        collectClaimRewardDeltas(claims, claimLookupByAssignedMissionId),
        { logLabel: claimLogLabel },
      );
      const parsedClaimed = Math.max(currentClaimed, successFromClaimLines);
      if (
        parsedClaimed > 0 &&
        successFromClaimLines === 0 &&
        aggregateClaimLogLine
      ) {
        logWithTimestamp(aggregateClaimLogLine);
      }
      currentClaimed = parsedClaimed;
    } else if (currentClaimed > 0 && aggregateClaimLogLine) {
      logWithTimestamp(aggregateClaimLogLine);
    }

    if (currentClaimed > 0) {
      const optimisticRefreshCount = applyOptimisticClaimSlotRefresh(
        claims,
        claimLookupByAssignedMissionId,
      );
      if (optimisticRefreshCount === 0) {
        applyPendingClaimSlotRefresh({
          reason: `${assignReason || "claim_followup"}_pending_refresh`,
        });
      }
    }

    const followup = await runSharedClaimFollowup({
      claimed: currentClaimed,
      beforeSnapshot,
      claimLookupByAssignedMissionId,
      assignReason,
      claimLogLabel,
      assignIntro,
      initialMissionResult,
      allowStateFallback,
      traceId,
      missionResultLoader,
    });

    if (claimWorkPaused()) {
      trace("watch", "claim_lifecycle_after_followup_paused", {
        traceId,
        claimed: followup.claimed,
        assigned: followup.assigned,
        assignReason,
      });
      return followup;
    }

    await checks.refreshMissionHeaderStats({
      missionsResult: followup.missionResult,
    });

    if (claimWorkPaused()) {
      trace("watch", "claim_lifecycle_after_stats_paused", {
        traceId,
        claimed: followup.claimed,
        assigned: followup.assigned,
        assignReason,
      });
      return followup;
    }

    if (finalTraceAction) {
      try {
        const finalSnapshot = await loadSelectedMissionSnapshot(
          followup.missionResult,
          missionResultLoader,
        );
        trace("watch", finalTraceAction, {
          traceId,
          finalSnapshot: snapshotTraceSummary(finalSnapshot),
          claimed: followup.claimed,
          assigned: followup.assigned,
          ...finalTraceMeta,
        });
      } catch (error) {
        logDebug("watch", `${finalTraceAction}_failed`, {
          error: error.message,
        });
      }
    }

    return followup;
  }

  async function runSharedClaimFollowup({
    claimed = 0,
    beforeSnapshot = new Map(),
    claimLookupByAssignedMissionId = null,
    assignReason,
    claimLogLabel = "Claimed",
    assignIntro = "[ASSIGN] ▶ Post-claim assign check (immediate)...",
    initialMissionResult = null,
    allowStateFallback = true,
    traceId = null,
    missionResultLoader = null,
  } = {}) {
    let currentClaimed = Number(claimed || 0);
    let assigned = 0;
    let missionResult = initialMissionResult;
    trace("watch", "claim_followup_start", {
      traceId,
      assignReason,
      claimed: currentClaimed,
      beforeSnapshot: snapshotTraceSummary(beforeSnapshot),
      hasInitialMissionResult: Boolean(missionResult),
      allowStateFallback,
    });

    if (!(missionResult && typeof missionResult === "object")) {
      if (claimWorkPaused()) {
        trace("watch", "claim_followup_skipped_before_load_paused", {
          traceId,
          assignReason,
          claimed: currentClaimed,
        });
        return { claimed: currentClaimed, assigned, missionResult };
      }
      try {
        missionResult = missionResultLoader
          ? await missionResultLoader({
              forceFresh: true,
              reason: `${assignReason || "claim_followup"}_initial_load`,
            })
          : await mcp.getUserMissions({
              forceFresh: true,
              reason: `${assignReason || "claim_followup"}_initial_load`,
            });
        trace("watch", "claim_followup_loaded_missions", {
          traceId,
          assignReason,
        });
      } catch (error) {
        logDebug("watch", "post_cycle_missions_failed", {
          error: error.message,
        });
      }
    }

    if (currentClaimed > 0) {
      try {
        applyClaimCountUpdate(currentClaimed, { logLabel: claimLogLabel });
      } catch (error) {
        logWithTimestamp(
          `[WATCH] ❌ Claimed counter update error: ${error.message}`,
        );
        logDebug("watch", "claimed_counter_update_failed", {
          error: error.message,
          stack: error.stack,
          claimed: currentClaimed,
        });
      }
    }

    try {
      if (claimWorkPaused()) {
        trace("watch", "claim_followup_skipped_before_refetch_paused", {
          traceId,
          assignReason,
          claimed: currentClaimed,
        });
        return { claimed: currentClaimed, assigned, missionResult };
      }
      missionResult = missionResultLoader
        ? await missionResultLoader({
            forceFresh: true,
            reason: `${assignReason || "claim_followup"}_after_claim`,
          })
        : await mcp.getUserMissions({
            forceFresh: true,
            reason: `${assignReason || "claim_followup"}_after_claim`,
          });
      trace("watch", "claim_followup_refetched_after_claim", {
        traceId,
        assignReason,
      });
    } catch (error) {
      logDebug("watch", "post_claim_missions_refresh_failed", {
        error: error.message,
      });
    }
    if (claimWorkPaused()) {
      trace("watch", "claim_followup_skipped_before_assign_paused", {
        traceId,
        assignReason,
        claimed: currentClaimed,
      });
      return { claimed: currentClaimed, assigned, missionResult };
    }
    logWithTimestamp(assignIntro);
    try {
      if (claimWorkPaused()) {
        trace("watch", "claim_followup_assign_aborted_paused", {
          traceId,
          assignReason,
          claimed: currentClaimed,
        });
        return { claimed: currentClaimed, assigned, missionResult };
      }
      logDebug("watch", "assign_check_start", { reason: assignReason });
      const assignResult = await checks.autoAssignConfiguredMissions({
        reason: assignReason,
        missionsResult: missionResult,
      });
      logDebug("watch", "assign_check_done", {
        reason: assignReason,
        attempted: Number(assignResult?.attempted || 0),
        assigned: Number(assignResult?.assigned || 0),
        skipped: assignResult?.skipped === true,
      });
      logAssignCheckResult(assignResult);
      assigned = Number(assignResult?.assigned || 0);
      trace("watch", "claim_followup_assign_done", {
        traceId,
        assignReason,
        attempted: Number(assignResult?.attempted || 0),
        assigned,
        skipped: assignResult?.skipped === true,
      });
      if (assigned > 0) {
        if (claimWorkPaused()) {
          trace("watch", "claim_followup_skipped_before_assign_refetch_paused", {
            traceId,
            assignReason,
            assigned,
          });
          return { claimed: currentClaimed, assigned, missionResult };
        }
        missionResult = missionResultLoader
          ? await missionResultLoader({
              forceFresh: true,
              reason: `${assignReason || "claim_followup"}_after_assign`,
            })
          : await mcp.getUserMissions({
              forceFresh: true,
              reason: `${assignReason || "claim_followup"}_after_assign`,
            });
        trace("watch", "claim_followup_refetched_after_assign", {
          traceId,
          assignReason,
          assigned,
        });
      }
    } catch (error) {
      logWithTimestamp(
        `[ASSIGN] ❌ Post-claim assign error: ${error.message}`,
      );
      logDebug("watch", "post_claim_assign_error", {
        error: error.message,
        stack: error.stack,
      });
    }

    if (allowStateFallback && currentClaimed === 0 && beforeSnapshot.size > 0) {
      try {
        if (claimWorkPaused()) {
          trace("watch", "claim_followup_state_fallback_skipped_paused", {
            traceId,
            assignReason,
          });
          return { claimed: currentClaimed, assigned, missionResult };
        }
        const afterSnapshot = await loadSelectedMissionSnapshot(
          missionResult,
          missionResultLoader,
        );
        const transitions = deriveStateTransitions(
          beforeSnapshot,
          afterSnapshot,
        );
        trace("watch", "claim_followup_state_compare", {
          traceId,
          assignReason,
          afterSnapshot: snapshotTraceSummary(afterSnapshot),
          transitions,
        });
        if (transitions.claimedTransitions > 0) {
          currentClaimed = transitions.claimedTransitions;
          logClaimTransitionDetails(
            transitions.claimed,
            "[WATCH] ✅ Claimed (state fallback)",
            claimLookupByAssignedMissionId,
          );
          addSessionRewardTotals(
            collectClaimRewardDeltas(
              transitions.claimed,
              claimLookupByAssignedMissionId,
            ),
            { logLabel: claimLogLabel },
          );
          logWithTimestamp(
            `[WATCH] ✅ Claim detected from mission state: ${currentClaimed}`,
          );
          applyOptimisticClaimSlotRefresh(
            transitions.claimed,
            claimLookupByAssignedMissionId,
          );
          applyClaimCountUpdate(currentClaimed, { logLabel: claimLogLabel });
          if (assigned === 0) {
            if (claimWorkPaused()) {
              trace("watch", "claim_followup_fallback_assign_skipped_paused", {
                traceId,
                assignReason,
                claimed: currentClaimed,
              });
              return { claimed: currentClaimed, assigned, missionResult };
            }
            logWithTimestamp(
              "[ASSIGN] ▶ Post-claim assign check (state fallback)...",
            );
            const fallbackAssign = await checks.autoAssignConfiguredMissions({
              reason: "post_claim_state_fallback",
              missionsResult: missionResult,
            });
            logDebug("watch", "assign_check_done", {
              reason: "post_claim_state_fallback",
              attempted: Number(fallbackAssign?.attempted || 0),
              assigned: Number(fallbackAssign?.assigned || 0),
              skipped: fallbackAssign?.skipped === true,
            });
            logAssignCheckResult(fallbackAssign);
            assigned = Math.max(
              assigned,
              Number(fallbackAssign?.assigned || 0),
            );
            trace("watch", "claim_followup_fallback_assign_done", {
              traceId,
              attempted: Number(fallbackAssign?.attempted || 0),
              assigned: Number(fallbackAssign?.assigned || 0),
              skipped: fallbackAssign?.skipped === true,
            });
            if (assigned > 0) {
              if (claimWorkPaused()) {
                trace(
                  "watch",
                  "claim_followup_fallback_assign_refetch_skipped_paused",
                  {
                    traceId,
                    assignReason,
                    assigned,
                  },
                );
                return { claimed: currentClaimed, assigned, missionResult };
              }
              missionResult = await mcp.getUserMissions({
                forceFresh: true,
                reason: `${assignReason || "claim_followup"}_after_fallback_assign`,
              });
              trace("watch", "claim_followup_refetched_after_fallback_assign", {
                traceId,
              });
            }
          }
        }
      } catch (error) {
        logDebug("watch", "state_fallback_failed", {
          error: error.message,
          stack: error.stack,
        });
      }
    }

    trace("watch", "claim_followup_complete", {
      traceId,
      assignReason,
      claimed: currentClaimed,
      assigned,
    });
    return {
      claimed: currentClaimed,
      assigned,
      missionResult,
    };
  }

  async function performMissionReroll(mission, meta = {}) {
    const assignedMissionId = String(
      mission?.assignedMissionId || mission?.id || "",
    ).trim();
    const name = String(mission?.name || "unknown mission");
    const level = Number(mission?.level || 0);
    const slot = mission?.slot ?? null;
    const { reason = "cycle", label = "reset" } = meta;
    if (!assignedMissionId) {
      throw new Error("Assigned mission id is missing for reroll.");
    }
    if (!missionAutomationEnabled(mission)) {
      logDebug("watch", "mission_reroll_skipped_disabled_slot", {
        reason,
        label,
        assignedMissionId,
        name,
        level,
        slot,
      });
      return false;
    }
    if (!signer) {
      throw new Error("Signer service unavailable.");
    }

    logDebug("watch", "mission_reroll_prepare_start", {
      reason,
      label,
      assignedMissionId,
      name,
      level,
      slot,
    });
    let manualBridgeUrl = null;
    const rerollArgs = {
      assignedMissionId,
      ...preparedActionSigningArgs(),
    };
    logDebug("watch", "mission_reroll_prepare_args", {
      reason,
      label,
      assignedMissionId,
      signerMode: ctx.signerMode,
      args: rerollArgs,
    });
    const prepared = await mcp.mcpToolCall(
      "prepare_mission_reroll",
      rerollArgs,
    );
    manualBridgeUrl = browserBridgeUrlFromPrepared(prepared) || "";
    logDebug("watch", "mission_reroll_prepare_result", {
      reason,
      label,
      assignedMissionId,
      name,
      level,
      slot,
      structuredContent: compactStructuredSummary(prepared?.structuredContent),
    });
    if (usesBrowserBridgeSigning()) {
      if (!manualBridgeUrl) {
        const error = new Error(
          "Browser wallet prepare did not return a signing URL.",
        );
        error.manualBridgeUrl = "";
        throw error;
      }
      const error = new Error(
        "Browser wallet signing is required. Open the signing URL.",
      );
      error.manualBridgeUrl = manualBridgeUrl;
      throw error;
    }
    let actionResult;
    try {
      actionResult = await executePreparedMissionAction({
        actionName: "mission_reroll",
        prepareResult: prepared,
        expected: { assignedMissionId },
        debugScope: "watch",
        submitDebugAction: "mission_reroll_submit",
        debugMeta: {
          reason,
          label,
          assignedMissionId,
          name,
          level,
          slot,
        },
      });
    } catch (error) {
      if (manualBridgeUrl) {
        error.manualBridgeUrl = manualBridgeUrl;
      }
      throw error;
    }
    if (actionResult?.submitted) {
      addSessionSpendTotals(
        actionResult?.signed?.cost ?? prepared?.structuredContent?.rerollCost,
        { actionName: "mission_reroll" },
      );
    }
    if (usesBrowserBridgeSigning() && !actionResult?.submitted) {
      logWithTimestamp("[DAPP] ⏳ Waiting briefly for reroll to settle...");
      const settle = await waitForDappRerollSettlement(assignedMissionId, {
        timeoutMs: 12_000,
        pollMs: 1_500,
      });
      logDebug("watch", "dapp_reroll_settle_done", {
        reason,
        label,
        assignedMissionId,
        settled: settle.settled === true,
        settleReason: settle.reason || null,
      });
    }
    logWithTimestamp(
      `[RESET] ✅ Rerolled: ${name} lvl=${level}${slot === null ? "" : ` slot=${slot}`}`,
    );
    if (ctx.guiBridge?.sendEvent) {
      ctx.guiBridge.sendEvent("stats_reset", {
        source: "watch_reroll",
        at: Date.now(),
        resetType: "mission",
        missionName: name,
        slot,
        level,
        assignedMissionId,
      });
    }
    logDebug("watch", "mission_reroll_ok", {
      reason,
      label,
      assignedMissionId,
      name,
      level,
      slot,
    });
    if (ctx.guiBridge?.sendEvent) {
      ctx.guiBridge.sendEvent("reset_error_cleared", {
        actionName: "mission_reroll",
        assignedMissionId,
        missionName: name,
        slot,
      });
    }
    return true;
  }

  function getResetPolicy() {
    return defaultResetPolicy(ctx);
  }

  // reset my heart, version control girl
  async function handleLevelResetIfNeeded(
    snapshotMap,
    {
      reason = "cycle",
      threshold = 20,
      label = "reset",
      thresholdForMission = null,
    } = {},
  ) {
    const { ready: thresholdHits, blocked: blockedHits } =
      evaluateResetCandidates(
        snapshotMap,
        typeof thresholdForMission === "function"
          ? thresholdForMission
          : threshold,
      );
    const enabledThresholdHits = thresholdHits.filter(missionAutomationEnabled);
    const enabledBlockedHits = blockedHits.filter(missionAutomationEnabled);
    // Once the mission NFT is cleared, this mission is reroll-eligible even if
    // the source payload still reports stale active/completed flags.
    const resetHits = enabledThresholdHits;
    if (enabledBlockedHits.length > 0) {
      const blockedNames = summarizeNamesForUser(
        enabledBlockedHits.map(
          (m) => `${m.name} lvl=${Number(m.level || 0)} slot=${m.slot ?? "?"}`,
        ),
      );
      logWithTimestamp(
        `[RESET] ⏸️ ${label} threshold reached but NFT still assigned (${reason}): ${blockedNames}`,
      );
      logDebug("watch", "blocked_threshold_hits", {
        reason,
        label,
        missions: enabledBlockedHits.map((m) => ({
          name: m.name,
          level: Number(m.level || 0),
          slot: m.slot ?? "?",
        })),
      });
      logWithTimestamp(
        "[RESET] ℹ️ Waiting for the mission NFT to clear before opening manual reset.",
      );
      if (ctx.signerMode === "manual") {
        const openResult = await openMissionPlayPage({
          cooldownMs: missionPageCooldownMs(),
        });
        if (openResult?.suppressed) {
          logDebug("watch", "mission_page_open_suppressed", {
            reason: "blocked_threshold_hit",
            cooldownMs:
              openResult?.cooldownMs ?? MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
            nextAllowedInMs: openResult?.nextAllowedInMs ?? null,
          });
        } else {
          logWithTimestamp(
            "[RESET] 🌐 Manual mode: opening missions page so you can inspect/resolve the threshold-hit mission.",
          );
        }
        if (!openResult?.ok) {
          logWithTimestamp(
            `[RESET] ❌ Failed to auto-open browser. Open manually: ${MISSION_PLAY_URL}`,
          );
        }
      }
    }
    if (resetHits.length === 0) {
      ctx.lastResetPromptKey = "";
      ctx.lastResetPromptAt = 0;
      return false;
    }
    const resetPromptKey = resetHits
      .map(
        (m) =>
          `${m.assignedMissionId || m.id || m.name || "unknown"}:${Number(m.level || 0)}`,
      )
      .sort()
      .join("|");
    const now = Date.now();
    const samePrompt =
      resetPromptKey && ctx.lastResetPromptKey === resetPromptKey;
    const withinReopenCooldown =
      samePrompt &&
      Number.isFinite(Number(ctx.lastResetPromptAt || 0)) &&
      now - Number(ctx.lastResetPromptAt || 0) <
        RESET_PROMPT_REOPEN_COOLDOWN_MS;
    if (withinReopenCooldown) {
      logDebug("watch", "reset_prompt_suppressed", {
        reason,
        label,
        resetPromptKey,
        cooldownMs: RESET_PROMPT_REOPEN_COOLDOWN_MS,
      });
      return true;
    }
    const names = summarizeNamesForUser(
      resetHits.map((m) => `${m.name} lvl=${Number(m.level || 0)}`),
    );
    logWithTimestamp(`[RESET] ⚠️ ${label} threshold hit (${reason}): ${names}`);
    logDebug("watch", "reset_threshold_hits", {
      reason,
      label,
      missions: resetHits.map((m) => ({
        name: m.name,
        level: Number(m.level || 0),
        slot: m.slot ?? null,
      })),
    });
    ctx.lastResetPromptKey = resetPromptKey;
    ctx.lastResetPromptAt = now;
    if (ctx.signerMode === "manual") {
      const openResult = await openMissionPlayPage({
        cooldownMs: missionPageCooldownMs(),
      });
      if (openResult?.suppressed) {
        logDebug("watch", "mission_page_open_suppressed", {
          reason: "reset_threshold_hit",
          cooldownMs:
            openResult?.cooldownMs ?? MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
          nextAllowedInMs: openResult?.nextAllowedInMs ?? null,
        });
      } else {
        logWithTimestamp("[RESET] 🌐 Manual mode: opening missions page...");
      }
      if (!openResult?.ok) {
        logWithTimestamp(
          `[RESET] ❌ Failed to auto-open browser. Open manually: ${MISSION_PLAY_URL}`,
        );
      }
      logWithTimestamp(
        "[RESET] ℹ️ Manual mode selected. Reset the mission yourself on the site.",
      );
      if (ctx.guiBridge?.sendEvent) {
        for (const mission of resetHits) {
          ctx.guiBridge.sendEvent("reset_error", {
            actionName: "mission_reroll",
            assignedMissionId: mission.assignedMissionId || mission.id || null,
            missionName: mission.name || null,
            level: mission.level ?? null,
            slot: mission.slot ?? null,
            error: "Manual mode selected. Open the missions page and reset this mission there.",
            bridgeUrl: MISSION_PLAY_URL,
          });
        }
      }
      return true;
    }
    let rerolledCount = 0;
    for (const mission of resetHits) {
      try {
        if (!signer) {
          throw new Error("Signer service unavailable.");
        }
        signer.ensureMissionActionSupported("mission_reroll");
        await performMissionReroll(mission, { reason, label });
        rerolledCount += 1;
      } catch (error) {
        const clearedSlot = clearGuiMissionSlot(mission?.slot);
        logWithTimestamp(
          `[RESET] ❌ Reroll blocked for ${mission.name}: ${error.message}`,
        );
        logDebug("watch", "mission_reroll_failed", {
          reason,
          label,
          assignedMissionId: mission.assignedMissionId || mission.id || null,
          name: mission.name || null,
          level: mission.level ?? null,
          slot: mission.slot ?? null,
          clearedSlot,
          error: error.message,
        });
        if (ctx.guiBridge?.sendEvent) {
          ctx.guiBridge.sendEvent("reset_error", {
            actionName: "mission_reroll",
            assignedMissionId: mission.assignedMissionId || mission.id || null,
            missionName: mission.name || null,
            level: mission.level ?? null,
            slot: mission.slot ?? null,
            error: String(error?.message || error || "Reset failed"),
            bridgeUrl: String(error?.manualBridgeUrl || "").trim() || null,
          });
        }
        if (clearedSlot && ctx.guiBridge?.emitNow) {
          ctx.guiBridge.emitNow();
        }
      }
    }
    if (rerolledCount > 0) {
      logWithTimestamp(
        `[ASSIGN] ▶ Post-reset assign check (rerolled=${rerolledCount})...`,
      );
      try {
        let latestMissionResult = await mcp.getUserMissions({
          forceFresh: true,
          reason: `post_reset_${reason}_initial`,
        });
        let assignResult = await checks.autoAssignConfiguredMissions({
          reason: `post_reset_${reason}`,
          missionsResult: latestMissionResult,
        });
        logAssignCheckResult(assignResult);
        if (Number(assignResult?.assigned || 0) === 0) {
          await sleep(1200);
          latestMissionResult = await mcp.getUserMissions({
            forceFresh: true,
            reason: `post_reset_${reason}_retry_after_wait`,
          });
          assignResult = await checks.autoAssignConfiguredMissions({
            reason: `post_reset_${reason}_retry`,
            missionsResult: latestMissionResult,
          });
          logAssignCheckResult(assignResult);
        }
        if (Number(assignResult?.assigned || 0) > 0) {
          latestMissionResult = await mcp.getUserMissions({
            forceFresh: true,
            reason: `post_reset_${reason}_after_assign`,
          });
        }
        await checks.refreshMissionHeaderStats({
          missionsResult: latestMissionResult,
        });
      } catch (error) {
        logWithTimestamp(
          `[ASSIGN] ❌ Post-reset assign check failed: ${error.message}`,
        );
        logDebug("watch", "post_reset_assign_failed", {
          reason,
          label,
          rerolledCount,
          error: error.message,
          stack: error.stack,
        });
      }
    }
    return true;
  }

  async function runResetCheckIfEnabled(reason, missionResult = null) {
    const resetPolicy = getResetPolicy();
    if (!resetPolicy.enabled) return false;
    const resolvedMissionResult =
      missionResult ||
      (await mcp.getUserMissions({ reason: `reset_check_${reason}` }));
    const snapshot = await loadMissionSnapshot(resolvedMissionResult, {
      selectedOnly: false,
    });
    const openedFromSnapshot = await handleLevelResetIfNeeded(snapshot, {
      reason,
      threshold: resetPolicy.threshold,
      label: resetPolicy.label,
      thresholdForMission: (mission) =>
        resetPolicyForMission(ctx, mission).threshold,
    });
    if (openedFromSnapshot) return true;

    // Manual checks should never miss reset popup when threshold is present. Prime disapproves of my name. :D
    const isManualReason =
      reason === "manual" ||
      reason === "manual_pre" ||
      reason === "manual_post";
    if (!isManualReason) return false;

    const missions = checks.filterSelectedMissions(
      normalizeMissionList(resolvedMissionResult),
    );
    const hits = missions
      .filter(missionAutomationEnabled)
      .map((m) => ({
        assignedMissionId:
          String(m?.assignedMissionId || m?.assigned_mission_id || "").trim() ||
          `slot:${m?.slot ?? "na"}:${missionName(m, "unknown mission")}`,
        name: missionName(m, "unknown mission"),
        level: Number(parseResetLevel(m) || 0),
        slot: m?.slot ?? null,
        assignedNft: missionHasAssignedNft(m) ? "assigned" : null,
        completed: missionIsClaimable(m) || m?.completed === true,
      }))
      .filter(
        (m) =>
          Number.isFinite(m.level) &&
          m.level >= Number(resetPolicyForMission(ctx, m).threshold) &&
          !m.assignedNft,
      );
    if (hits.length === 0) return false;

    const fallbackSnapshot = new Map(hits.map((m) => [m.assignedMissionId, m]));
    return handleLevelResetIfNeeded(fallbackSnapshot, {
      reason,
      threshold: resetPolicy.threshold,
      label: resetPolicy.label,
      thresholdForMission: (mission) =>
        resetPolicyForMission(ctx, mission).threshold,
    });
  }

  async function runResetCheckSafely(reason, missionResult, debugAction) {
    try {
      return await runResetCheckIfEnabled(reason, missionResult);
    } catch (error) {
      logDebug("watch", debugAction, {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  function getMcpCooldownRemainingMs() {
    const until = Number(ctx.mcpRateLimitedUntil || 0);
    return until > Date.now() ? until - Date.now() : 0;
  }

  function hasActiveMcpCooldown() {
    return getMcpCooldownRemainingMs() > 0;
  }

  function hasDisabledMissionSlots() {
    const map =
      ctx.missionActionEnabledBySlot &&
      typeof ctx.missionActionEnabledBySlot === "object"
        ? ctx.missionActionEnabledBySlot
        : ctx.config?.missionActionEnabledBySlot &&
            typeof ctx.config.missionActionEnabledBySlot === "object"
          ? ctx.config.missionActionEnabledBySlot
          : null;
    if (!map) return false;
    for (let slot = 1; slot <= 4; slot += 1) {
      if (map[String(slot)] === false || map[slot] === false) return true;
    }
    return false;
  }

  function startupMissionResult() {
    const wrapper =
      ctx.startupAccountSnapshot && typeof ctx.startupAccountSnapshot === "object"
        ? ctx.startupAccountSnapshot
        : null;
    const snapshot =
      wrapper?.snapshot && typeof wrapper.snapshot === "object"
        ? wrapper.snapshot
        : null;
    return snapshot?.missionsResult && typeof snapshot.missionsResult === "object"
      ? snapshot.missionsResult
      : null;
  }

  function getAutoAssignCooldownRemainingMs() {
    const until = Number(ctx.autoAssignRateLimitedUntil || 0);
    return until > Date.now() ? until - Date.now() : 0;
  }

  function scheduleNftCountWarmup({
    reason = "watch",
    missionsResult = null,
    minDelayMs = 0,
  } = {}) {
    if (nftCountWarmTimer) return;
    if (Number(ctx.currentMissionStats?.nftsTotal || 0) > 0) return;
    const delayMs = Math.max(
      8000,
      Number(minDelayMs || 0),
      getMcpCooldownRemainingMs(),
      getAutoAssignCooldownRemainingMs(),
    );
    logDebug("watch", "nft_count_warmup_scheduled", {
      reason,
      delayMs,
      hasMissionResult: Boolean(missionsResult),
    });
    nftCountWarmTimer = setTimeout(async () => {
      nftCountWarmTimer = null;
      if (!ctx.watchLoopEnabled || !ctx.watcherRunning) return;
      if (Number(ctx.currentMissionStats?.nftsTotal || 0) > 0) return;
      const retryDelayMs = Math.max(
        getMcpCooldownRemainingMs(),
        getAutoAssignCooldownRemainingMs(),
      );
      if (retryDelayMs > 0) {
        scheduleNftCountWarmup({
          reason: `${reason}_retry`,
          missionsResult:
            missionsResult || ctx.lastUserMissionsResult || startupMissionResult(),
          minDelayMs: retryDelayMs,
        });
        return;
      }
      try {
        await checks.refreshMissionHeaderStats({
          missionsResult:
            missionsResult || ctx.lastUserMissionsResult || startupMissionResult(),
          refreshNftCount: true,
          hydrateAssignedMetadata: false,
        });
        logDebug("watch", "nft_count_warmup_complete", {
          reason,
          nftsTotal: Number(ctx.currentMissionStats?.nftsTotal || 0),
          nftsAvailable: Number(ctx.currentMissionStats?.nftsAvailable || 0),
        });
      } catch (error) {
        logDebug("watch", "nft_count_warmup_failed", {
          reason,
          error: error.message,
        });
      }
    }, delayMs);
  }

  async function runWatchCycle() {
    const traceId = nextTraceId("cycle");
    const opts = watchConfig();
    const watchSafeLocalMode = hasDisabledMissionSlots();
    logDebug("watch", "cycle_start", opts);
    trace("watch", "cycle_start", { traceId, opts, watchSafeLocalMode });
    logWithTimestamp(formatTaggedLog("WATCH", "👀", "Watching missions..."));

    let beforeSnapshot = new Map();
    let preCycleMissionResult = null;

    const watchTimeoutMs = Math.max(
      45000,
      opts.watchSeconds * 1000 + opts.pollIntervalSeconds * 1000 + 15000,
    );
    const startedAt = Date.now();
    let watchTick = 0;
    let missionStateById = new Map();
    let postClaimAssignRan = false;
    let postClaimAssigned = 0;
    let missionStatePollRunning = false;
    let refreshKickPending = false;
    let claimFollowupRunning = false;
    let liveSelectedSnapshot = beforeSnapshot;
    let liveStateRecoveryRunning = false;
    let liveStateClaimedApplied = 0;
    let nextAssignRecheckAtMs = 0;
    const ASSIGN_RECHECK_COOLDOWN_MS = Math.max(
      15000,
      opts.pollIntervalSeconds * 1000,
    );
    const missionResultCoordinator = createMissionResultCoordinator({
      ttlMs: 1200,
      debugScope: "watch",
    });
    const getMissionResultShared = (options = {}) =>
      missionResultCoordinator.get(options);
    const seedMissionResult = (result) => missionResultCoordinator.seed(result);
    const maybeRunLiveStateRecovery = async (missionResult, reason) => {
      if (liveStateRecoveryRunning) return;
      if (!(missionResult && typeof missionResult === "object")) return;
      seedMissionResult(missionResult);
      try {
        const afterSnapshot = await loadSelectedMissionSnapshot(
          missionResult,
          getMissionResultShared,
        );
        const transitions = deriveStateTransitions(
          liveSelectedSnapshot,
          afterSnapshot,
        );
        logDebug("watch", "live_state_compare", {
          reason,
          claimedTransitions: transitions.claimedTransitions,
          started: transitions.started,
          restarted: transitions.restarted,
        });
        if (transitions.claimedTransitions > 0) {
          liveStateRecoveryRunning = true;
          const liveClaimLookup = await loadAssignedMissionLookup(
            missionResult,
            getMissionResultShared,
          );
          logClaimTransitionDetails(
            transitions.claimed,
            "[WATCH] ✅ Claimed (live state)",
            liveClaimLookup,
          );
          applyClaimCountUpdate(transitions.claimedTransitions, {
            logLabel: "Claimed count updated",
          });
          liveStateClaimedApplied += Number(
            transitions.claimedTransitions || 0,
          );
          logWithTimestamp(
            "[ASSIGN] ▶ Post-claim assign check (live state)...",
          );
          const assignResult = await checks.autoAssignConfiguredMissions({
            reason: "post_claim_live_state",
            missionsResult: missionResult,
          });
          logAssignCheckResult(assignResult);
          const assigned = Number(assignResult?.assigned || 0);
          if (assigned > 0) {
            postClaimAssignRan = true;
            postClaimAssigned = Math.max(postClaimAssigned, assigned);
            missionResult = await getMissionResultShared({
              forceFresh: true,
              reason: "post_claim_live_state_after_assign",
            });
          }
          liveSelectedSnapshot = await loadSelectedMissionSnapshot(
            missionResult,
            getMissionResultShared,
          );
          return;
        }
        liveSelectedSnapshot = afterSnapshot;
      } catch (error) {
        logDebug("watch", "live_state_recovery_failed", {
          reason,
          error: error.message,
        });
      } finally {
        liveStateRecoveryRunning = false;
      }
    };
    const clientConfiguredPollSeconds = Number(
      ctx.config.clientMissionPollIntervalSeconds,
    );
    const clientPollIntervalSeconds =
      Number.isFinite(clientConfiguredPollSeconds) &&
      clientConfiguredPollSeconds > 0
        ? Math.max(
            watchMinCycleSeconds(),
            Math.floor(clientConfiguredPollSeconds),
          )
        : 0;
    const clientPollingEnabled =
      watchSafeLocalMode || ctx.debugMode || clientPollIntervalSeconds > 0;

    const runLiveMissionCheck = (reason) => {
      if (missionStatePollRunning || claimFollowupRunning) {
        refreshKickPending = true;
        return;
      }
      missionStatePollRunning = true;
      let updatedMissionResult = null;
      const pollPromise = (async () => {
        const result = await getMissionResultShared({
          forceFresh: true,
          reason,
        });
        if (ctx.debugMode) {
          missionStateById = await pollMissionStateChanges(
            missionStateById,
            reason,
            {
              missionResult: result,
              missionResultLoader: getMissionResultShared,
            },
          );
        }
        updatedMissionResult = result;
        return result;
      })();
      pollPromise
        .then((updated) => {
          return Promise.resolve()
            .then(() =>
              runResetCheckSafely(
                reason,
                updated,
                "poll_tick_reset_check_failed",
              ),
            )
            .then(() => maybeRunLiveStateRecovery(updated, reason));
        })
        .catch((error) => {
          logDebug("watch", "poll_tick_check_failed", {
            reason,
            error: error.message,
          });
        })
        .finally(() => {
          const shouldRecheckAssign =
            !liveStateRecoveryRunning &&
            Date.now() >= nextAssignRecheckAtMs &&
            Number(ctx.currentMissionStats?.available || 0) > 0;
          if (shouldRecheckAssign) {
            nextAssignRecheckAtMs = Date.now() + ASSIGN_RECHECK_COOLDOWN_MS;
            checks
              .autoAssignConfiguredMissions({
                reason: "poll_tick_available_recheck",
                missionsResult: updatedMissionResult,
              })
              .then((assignResult) => {
                if (Number(assignResult?.assigned || 0) > 0) {
                  return getMissionResultShared({
                    forceFresh: true,
                    reason: "poll_tick_available_recheck_after_assign",
                  })
                    .then((fresh) =>
                      checks.refreshMissionHeaderStats({
                        missionsResult: fresh,
                      }),
                    )
                    .catch((error) =>
                      logDebug("watch", "poll_tick_assign_refresh_failed", {
                        error: error.message,
                      }),
                    );
                }
                return null;
              })
              .catch((error) => {
                logDebug("watch", "poll_tick_assign_recheck_failed", {
                  error: error.message,
                });
              });
          }
          missionStatePollRunning = false;
          if (refreshKickPending) {
            refreshKickPending = false;
            runLiveMissionCheck(`${reason}_refresh_kick`);
          }
        });
    };
    const previousAuthRefreshHandler = ctx.onAuthRefresh;
    ctx.onAuthRefresh = () => {
      if (!ctx.watcherRunning) return;
      logWithTimestamp(
        "[WATCH][DEBUG] ✅ Token refresh detected; running immediate check...",
      );
      // Token refresh usually implies state changes; only do an immediate
      // server fetch if client-side polling is enabled.
      if (clientPollingEnabled) runLiveMissionCheck("token_refresh");
    };
    if (ctx.debugMode && preCycleMissionResult) {
      try {
        missionStateById = await pollMissionStateChanges(
          missionStateById,
          "cycle_start",
          {
            logInitial: true,
            missionResult: preCycleMissionResult,
            missionResultLoader: getMissionResultShared,
          },
        );
      } catch (error) {
        logDebug("watch", "mission_state_poll_failed", {
          reason: "cycle_start",
          error: error.message,
        });
      }
    }
    let tickTimer = null;
    if (clientPollingEnabled) {
      const tickEveryMs = Math.max(
        1000,
        (clientPollIntervalSeconds || opts.pollIntervalSeconds) * 1000,
      );
      tickTimer = setInterval(() => {
        watchTick += 1;
        const snapshot = ctx.currentMissionStats || {};
        const claimable = Number(snapshot.claimable || 0);
        const available = Number(snapshot.available || 0);
        const chance =
          claimable > 0 ? "high" : available > 0 ? "medium" : "low";
        logDebug("watch", "poll_tick", {
          tick: watchTick,
          elapsedMs: Date.now() - startedAt,
          watchSeconds: opts.watchSeconds,
          pollIntervalSeconds:
            clientPollIntervalSeconds || opts.pollIntervalSeconds,
          chance,
          claimable,
          available,
          active: Number(snapshot.active || 0),
          sessionClaimedCount: Number(ctx.sessionClaimedCount || 0),
        });
        runLiveMissionCheck(`poll_tick_${watchTick}`);
      }, tickEveryMs);
    }

    let result;
    let usedLocalSafeWatch = false;
    let localSafeElapsedMs = 0;
    cycleAbortController = new AbortController();
    try {
      if (watchSafeLocalMode) {
        usedLocalSafeWatch = true;
        logWithTimestamp(
          "[WATCH] Disabled slots detected. Using local safe watch mode.",
        );
        logDebug("watch", "watch_call_skipped_local_safe_mode", {
          watchSeconds: opts.watchSeconds,
          pollIntervalSeconds: opts.pollIntervalSeconds,
          maxClaims: opts.maxClaims,
        });
        if (clientPollingEnabled) runLiveMissionCheck("local_safe_start");
        const localStartedAt = Date.now();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, Math.max(1000, opts.watchSeconds * 1000));
          cycleAbortController.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const error = new Error("request aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        localSafeElapsedMs = Date.now() - localStartedAt;
        result = {
          structuredContent: {
            success: true,
            watch: {
              polls: 0,
              timedOut: true,
              elapsedMs: localSafeElapsedMs,
              mode: "local_safe",
            },
            missionSnapshot: {},
          },
        };
      } else {
        logDebug("watch", "watch_call_start", {
          watchSeconds: opts.watchSeconds,
          pollIntervalSeconds: opts.pollIntervalSeconds,
          maxClaims: opts.maxClaims,
          watchTimeoutMs,
        });
        result = await mcp.mcpToolCall(
          "watch_and_claim",
          {
            watchSeconds: opts.watchSeconds,
            pollIntervalSeconds: opts.pollIntervalSeconds,
            maxClaims: opts.maxClaims,
          },
          { timeoutMs: watchTimeoutMs, signal: cycleAbortController.signal },
        );
        logDebug("watch", "watch_call_done", {
          success: result?.structuredContent?.success,
          watch: result?.structuredContent?.watch || {},
        });
      }
    } finally {
      if (tickTimer) clearInterval(tickTimer);
      ctx.onAuthRefresh = previousAuthRefreshHandler || null;
      cycleAbortController = null;
    }

    const summary = summarizeWatch(result);
    const rawClaimCounter = extractRawClaimCounterValue(result);
    let claimed = extractClaimCount(result);
    const failedClaims = extractFailedClaimCount(result);
    const claimEvents = extractClaimEventCount(result);
    if (rawClaimCounter !== null) claimed = Math.max(claimed, rawClaimCounter);
    const watchSuccess = result?.structuredContent?.success;
    logDebug("watch", "claim_parse", {
      claimEvents,
      claimed,
      failedClaims,
      watchSuccess,
    });
    if (ctx.debugMode && claimed > 0) {
      logWithTimestamp(
        `[WATCH] [DEBUG] ✅ Claim signal detected: parsedSuccess=${claimed}`,
      );
    }

    logDebug("watch", "watch_and_claim_returned", {
      localSafeMode: usedLocalSafeWatch,
      success: watchSuccess === undefined ? "n/a" : String(watchSuccess),
      claimEvents,
      parsedSuccess: claimed,
      parsedFailed: failedClaims,
      eligible: summary.eligible,
      total: summary.total,
    });
    if (liveStateClaimedApplied > 0) {
      const beforeAdjustment = claimed;
      claimed = Math.max(0, claimed - liveStateClaimedApplied);
      logDebug("watch", "claim_parse_adjusted_for_live_state", {
        beforeAdjustment,
        liveStateClaimedApplied,
        afterAdjustment: claimed,
      });
    }
    if (claimed === 0 && opts.fallbackClaims && !hasActiveMcpCooldown()) {
      logDebug("watch", "fallback_claim_start", {
        reason: "watch_reported_zero",
        maxClaims: opts.maxClaims,
      });
      const fallback = await checks.claimClaimableMissions({
        maxClaims: opts.maxClaims,
        reason: "watch_reported_zero",
      });
      logDebug("watch", "fallback_claim_done", {
        claimed: fallback?.claimed || 0,
        ok: fallback?.ok,
      });
      claimed += Number(fallback?.claimed || 0);
    }
    if (claimWorkPaused()) {
      logDebug("watch", "cycle_followup_skipped_paused", { claimed });
      return { claimed, opts, summary };
    }
    if (claimed === 0 && opts.fallbackClaims && hasActiveMcpCooldown()) {
      logDebug("watch", "⏳ fallback_claim_skipped_rate_limited", {
        retryAfterMs: getMcpCooldownRemainingMs(),
      });
    }
    if (ctx.guiBridge?.sendEvent) {
      ctx.guiBridge.sendEvent("claiming", {
        state: "done",
        reason: "watch",
        claimed,
      });
    }
    if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
    logDebug("watch", "cycle_result", {
      watch: result?.structuredContent?.watch || {},
      watchWindowEnded: summary.windowEnded,
      missionSnapshot: result?.structuredContent?.missionSnapshot || {},
      claimsCount: summary.claims.length,
      claimEvents,
      failedClaims,
      claims: summary.claims.map((c) => compactClaimDetails(c)),
      rawSummary: compactStructuredSummary(result?.structuredContent || result),
    });
    let postCycleMissionResult = null;
    if ((claimed > 0 || summary.claims.length > 0) && !hasActiveMcpCooldown()) {
      try {
        postCycleMissionResult = await getMissionResultShared({
          forceFresh: true,
          reason: "post_cycle_claim_refresh",
        });
      } catch (error) {
        logDebug("watch", "post_cycle_missions_failed", {
          error: error.message,
        });
      }
    }
    if ((claimed > 0 || summary.claims.length > 0) && hasActiveMcpCooldown()) {
      logDebug("watch", "post_cycle_missions_skipped_rate_limited", {
        retryAfterMs: getMcpCooldownRemainingMs(),
      });
    }

    let claimLookupByAssignedMissionId = null;
    if (summary.claims.length > 0) {
      const needsLookup = summary.claims.some((c) => {
        const d = compactClaimDetails(c);
        return (
          d.name === null ||
          d.slot === null ||
          d.reward === null ||
          d.prize === null
        );
      });
      if (needsLookup) {
        try {
          const lookups = [];
          if (preCycleMissionResult && typeof preCycleMissionResult === "object") {
            lookups.push(loadAssignedMissionLookup(preCycleMissionResult));
          }
          if (
            postCycleMissionResult &&
            typeof postCycleMissionResult === "object"
          ) {
            lookups.push(loadAssignedMissionLookup(postCycleMissionResult));
          }
          if (lookups.length > 0) {
            const resolved = await Promise.all(lookups);
            claimLookupByAssignedMissionId = mergeAssignedMissionLookups(
              ...resolved,
            );
          }
        } catch (error) {
          logDebug("watch", "claim_lookup_failed", { error: error.message });
        }
      }
    }

    if (hasActiveMcpCooldown()) {
      logDebug("watch", "⏳ cycle_followup_skipped_rate_limited", {
        retryAfterMs: getMcpCooldownRemainingMs(),
      });
    } else {
      claimFollowupRunning = true;
      const claimFollowup = await runClaimLifecycle({
        traceId,
        beforeSnapshot,
        claimed,
        claims: summary.claims,
        claimLookupByAssignedMissionId,
        aggregateClaimLogLine: `[WATCH] ✅ Claimed ${claimed} mission reward(s).`,
        assignReason: "post_claim",
        claimLogLabel: "Claimed count updated",
        assignIntro: "[ASSIGN] ▶ Post-claim assign check (immediate)...",
        initialMissionResult: postCycleMissionResult,
        allowStateFallback: true,
        finalTraceAction: "cycle_final_snapshot",
        missionResultLoader: getMissionResultShared,
      }).finally(() => {
        claimFollowupRunning = false;
      });
      claimed = claimFollowup.claimed;
      postClaimAssigned = claimFollowup.assigned;
      postClaimAssignRan = claimed > 0;
      postCycleMissionResult = claimFollowup.missionResult;
      if (hasActiveMcpCooldown()) {
        logDebug("watch", "⏳ cycle_end_checks_skipped_rate_limited", {
          retryAfterMs: getMcpCooldownRemainingMs(),
        });
      } else {
        await runResetCheckSafely(
          "cycle_end",
          postCycleMissionResult,
          "cycle_end_reset_check_failed",
        );
        if (postClaimAssignRan && postClaimAssigned > 0) {
          logDebug("watch", "cycle_end_assign_skipped", {
            reason: "post_claim_assign_succeeded",
            postClaimAssigned,
          });
        } else {
          if (ctx.debugMode)
            logWithTimestamp(
              formatTaggedLog("ASSIGN", "🛠️", "Cycle-end assign check..."),
            );
          try {
            const assignResult = await checks.autoAssignConfiguredMissions({
              reason: "cycle_end_unassigned_check",
              missionsResult: postCycleMissionResult,
            });
            if (ctx.debugMode) {
              logWithTimestamp(
                Number(assignResult?.assigned || 0) > 0
                  ? `[ASSIGN] ✅ cycle-end result: attempted=${Number(assignResult?.attempted || 0)} assigned=${Number(assignResult?.assigned || 0)}`
                  : `[ASSIGN] ℹ️ cycle-end result: attempted=${Number(assignResult?.attempted || 0)} assigned=0`,
              );
            }
          } catch (error) {
            logWithTimestamp(
              `[ASSIGN] ❌ cycle-end assign error: ${error.message}`,
            );
            logDebug("watch", "❌ cycle_end_assign_error", {
              error: error.message,
              stack: error.stack,
            });
          }
        }
      }
    }
    logDebug("watch", "stats", {
      sessionClaimed: ctx.sessionClaimedCount,
      totalClaimed: Number(ctx.config.totalClaimed || 0),
    });
    logDebug("watch", "cycle_complete", {
      claimed,
      sessionClaimedCount: ctx.sessionClaimedCount,
      polls: summary.polls,
      eligible: summary.eligible,
      total: summary.total,
      windowEnded: summary.windowEnded,
      elapsedMs: summary.elapsedMs,
    });
    return { claimed, opts, summary };
  }

  async function runWatchCycleExclusive() {
    if (cycleInFlight) return cycleInFlight;
    cycleInFlight = runWatchCycle().finally(() => {
      cycleInFlight = null;
    });
    return cycleInFlight;
  }

  async function runManualProcess({ waitForCycle = true } = {}) {
    const traceId = nextTraceId("manual");
    if (waitForCycle && cycleInFlight) await cycleInFlight.catch(() => {});
    if (!ctx.isAuthenticated) throw new Error("Not authenticated");
    logWithTimestamp(
      formatTaggedLog(
        "WATCH",
        "👀",
        "Manual immediate process (claim+assign)...",
      ),
    );
    let beforeSnapshot = new Map();
    let preManualMissionResult = null;
    let manualResetOpened = false;
    try {
      preManualMissionResult = await mcp.getUserMissions({
        forceFresh: true,
        reason: "manual_process_start",
      });
      beforeSnapshot = await loadSelectedMissionSnapshot(
        preManualMissionResult,
      );
      trace("watch", "manual_before_snapshot", {
        traceId,
        beforeSnapshot: snapshotTraceSummary(beforeSnapshot),
      });
    } catch (error) {
      logDebug("watch", "manual_before_snapshot_failed", {
        error: error.message,
        stack: error.stack,
      });
    }
    manualResetOpened = await runResetCheckSafely(
      "manual_pre",
      preManualMissionResult,
      "manual_reset_precheck_failed",
    );
    try {
      const claimResult = await checks.claimClaimableMissions({
        maxClaims: WATCH_MAX_CLAIMS,
        reason: "manual",
        onlySelected: false,
        missionsResult: preManualMissionResult,
      });
      if (claimWorkPaused()) {
        logDebug("watch", "manual_followup_skipped_paused", {
          claimed: Number(claimResult?.claimed || 0),
        });
        return { claimed: Number(claimResult?.claimed || 0), assigned: 0 };
      }
      const followup = await runClaimLifecycle({
        traceId,
        beforeSnapshot,
        claimed: Number(claimResult?.claimed || 0),
        claims: [],
        assignReason: "manual",
        claimLogLabel: "Manual claimed",
        assignIntro: "[ASSIGN] ▶ Post-claim assign check (immediate)...",
        initialMissionResult: preManualMissionResult,
        allowStateFallback: true,
        finalTraceAction: "manual_final_snapshot",
      });
      if (!manualResetOpened)
        await runResetCheckSafely(
          "manual_post",
          followup.missionResult,
          "manual_reset_postcheck_failed",
        );
      return { claimed: followup.claimed, assigned: followup.assigned };
    } catch (error) {
      logDebug("watch", "manual_reset_check_failed", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async function runManualResetCheck({ waitForCycle = true } = {}) {
    if (waitForCycle && cycleInFlight) await cycleInFlight.catch(() => {});
    if (!ctx.isAuthenticated) throw new Error("Not authenticated");
    const missionResult = await mcp.getUserMissions({
      forceFresh: true,
      reason: "manual_reset_check",
    });
    const triggered = await runResetCheckSafely(
      "manual",
      missionResult,
      "manual_reset_command_failed",
    );
    return { triggered };
  }

  async function startWatchLoop() {
    if (!ctx.watchLoopEnabled || !ctx.isAuthenticated || ctx.watcherRunning)
      return;

    ctx.watchStartPending = false;
    ctx.sessionTotalsEpoch = Math.max(
      Date.now(),
      Number(ctx.sessionTotalsEpoch || 0) + 1,
    );
    resetSessionRewardTotals();
    resetSessionSpendTotals();
    ctx.watcherRunning = true;
    ctx.isIdle = false;
    redrawHeaderAndLog(ctx.currentMissionStats);

    const opts = watchConfig();
    logWithTimestamp(
      `[WATCH] 👀 Started: poll=${opts.pollIntervalSeconds}s refresh=${opts.watchSeconds}s`,
    );
    logWithTimestamp(formatTaggedLog("WATCH", "👀", "Watch loop armed."));
    try {
      let initialMissionResult = startupMissionResult();
      let startupDidClaimOrAssign = false;
      if (initialMissionResult) {
        const initialStatsResult = await checks.refreshMissionHeaderStats({
          missionsResult: initialMissionResult,
          refreshNftCount: false,
          hydrateAssignedMetadata: false,
        });
        logDebug("watch", "startup_ui_refresh_ok", {
          source: "startup_snapshot",
          total: Number(ctx.currentMissionStats?.total || 0),
          active: Number(ctx.currentMissionStats?.active || 0),
          available: Number(ctx.currentMissionStats?.available || 0),
          claimable: Number(ctx.currentMissionStats?.claimable || 0),
        });
        const startupStats = initialStatsResult?.stats || ctx.currentMissionStats || {};
        let startupClaimable = Number(startupStats.claimable || 0);
        let startupAvailable = Number(startupStats.available || 0);
        let startupActionMissionResult = initialMissionResult;
        if (!hasActiveMcpCooldown()) {
          try {
            startupActionMissionResult = await mcp.getUserMissions({
              reason: "startup_action_refresh",
            });
            initialMissionResult =
              startupActionMissionResult || initialMissionResult;
            const freshStartupStatsResult =
              await checks.refreshMissionHeaderStats({
                missionsResult: startupActionMissionResult,
                refreshNftCount: false,
              });
            const freshStartupStats =
              freshStartupStatsResult?.stats || ctx.currentMissionStats || {};
            startupClaimable = Number(freshStartupStats.claimable || 0);
            startupAvailable = Number(freshStartupStats.available || 0);
          } catch (error) {
            logDebug("watch", "startup_action_state_refresh_failed", {
              error: error.message,
            });
          }
        }
        if (!hasActiveMcpCooldown() && startupClaimable > 0) {
          const traceId = nextTraceId("startup");
          let beforeSnapshot = new Map();
          try {
            beforeSnapshot = await loadSelectedMissionSnapshot(
              startupActionMissionResult,
            );
          } catch {}
          logWithTimestamp(
            formatTaggedLog("WATCH", "👀", "Startup claim check..."),
          );
          const claimResult = await checks.claimClaimableMissions({
            maxClaims: WATCH_MAX_CLAIMS,
            reason: "startup",
            missionsResult: startupActionMissionResult,
          });
          if (claimWorkPaused()) {
            logDebug("watch", "startup_followup_skipped_paused", {
              claimed: Number(claimResult?.claimed || 0),
            });
          } else if (Number(claimResult?.claimed || 0) > 0) {
            startupDidClaimOrAssign = true;
            const followup = await runClaimLifecycle({
              traceId,
              beforeSnapshot,
              claimed: Number(claimResult?.claimed || 0),
              claims: [],
              aggregateClaimLogLine: `[WATCH] ✅ Claimed ${Number(claimResult?.claimed || 0)} mission reward(s).`,
              assignReason: "startup_post_claim",
              claimLogLabel: "Startup claimed",
              assignIntro: "[ASSIGN] ▶ Startup post-claim assign check...",
              initialMissionResult: startupActionMissionResult,
              allowStateFallback: true,
              finalTraceAction: "startup_final_snapshot",
            });
            initialMissionResult = followup.missionResult || initialMissionResult;
          }
        } else if (
          !claimWorkPaused() &&
          !hasActiveMcpCooldown() &&
          startupAvailable > 0
        ) {
          logWithTimestamp(
            formatTaggedLog("ASSIGN", "🛠️", "Startup assign check..."),
          );
          const assignResult = await checks.autoAssignConfiguredMissions({
            reason: "startup_unassigned_check",
            missionsResult: startupActionMissionResult,
          });
          logAssignCheckResult(assignResult);
          if (Number(assignResult?.assigned || 0) > 0) {
            startupDidClaimOrAssign = true;
          }
        }

        if (
          !claimWorkPaused() &&
          startupDidClaimOrAssign &&
          !hasActiveMcpCooldown()
        ) {
          try {
            const settledMissionResult = await mcp.getUserMissions({
              forceFresh: true,
              reason: "startup_settle_refresh",
            });
            initialMissionResult = settledMissionResult || initialMissionResult;
            const settledStatsResult = await checks.refreshMissionHeaderStats({
              missionsResult: initialMissionResult,
              refreshNftCount: false,
            });
            const settledStats =
              settledStatsResult?.stats || ctx.currentMissionStats || {};
            const settledAvailable = Number(settledStats.available || 0);
            if (settledAvailable > 0) {
              logWithTimestamp(
                formatTaggedLog(
                  "ASSIGN",
                  "🛠️",
                  "Startup settle assign check...",
                ),
              );
              const secondAssignResult =
                await checks.autoAssignConfiguredMissions({
                  reason: "startup_settle_assign_check",
                  missionsResult: initialMissionResult,
                });
              logAssignCheckResult(secondAssignResult);
              if (Number(secondAssignResult?.assigned || 0) > 0) {
                initialMissionResult = await mcp.getUserMissions({
                  forceFresh: true,
                  reason: "startup_post_assign_refresh",
                });
                await checks.refreshMissionHeaderStats({
                  missionsResult: initialMissionResult,
                  refreshNftCount: false,
                });
              }
            }
          } catch (error) {
            logDebug("watch", "startup_settle_refresh_failed", {
              error: error.message,
            });
          }
        }
      } else {
        logDebug("watch", "startup_ui_refresh_skipped", {
          reason: "no_startup_snapshot",
        });
      }
      scheduleNftCountWarmup({
        reason: "startup",
        missionsResult: initialMissionResult || ctx.lastUserMissionsResult || null,
      });
    } catch (error) {
      logDebug("watch", "startup_ui_refresh_failed", {
        error: error.message,
      });
    }

    while (ctx.watchLoopEnabled) {
      try {
        const preCycleCooldownMs = getMcpCooldownRemainingMs();
        if (preCycleCooldownMs > 0) {
          logWithTimestamp(
            `[WATCH] ⏳ MCP cooldown active. Waiting ${Math.ceil(preCycleCooldownMs / 1000)}s before next cycle.`,
          );
          await new Promise((resolve) => setTimeout(resolve, preCycleCooldownMs));
        }
        const { claimed, summary } = await runWatchCycleExclusive();
        if (ctx.debugMode && claimed > 0) {
          logWithTimestamp(
            `[WATCH] ✅ Cycle complete: claimed ${claimed} (polls=${summary.polls}, eligible=${summary.eligible}).`,
          );
        } else if (ctx.debugMode) {
          logWithTimestamp(
            `[WATCH] ℹ️ Cycle complete: no claims (polls=${summary.polls}, eligible=${summary.eligible}). Next check continues automatically.`,
          );
        }
        if (Number(ctx.currentMissionStats?.nftsTotal || 0) <= 0) {
          scheduleNftCountWarmup({
            reason: "cycle_complete",
            missionsResult: ctx.lastUserMissionsResult || null,
          });
        }
        const cooldownMs = getMcpCooldownRemainingMs();
        if (cooldownMs > 0) {
          logWithTimestamp(
            `[WATCH] ⏳ MCP cooldown active. Waiting ${Math.ceil(cooldownMs / 1000)}s before next cycle.`,
          );
          await new Promise((resolve) => setTimeout(resolve, cooldownMs));
        }
      } catch (error) {
        const msg = String(error?.message || "");
        const isAbort =
          /request aborted|aborterror|aborted/i.test(msg) ||
          error?.name === "AbortError";
        if (!ctx.watchLoopEnabled || isAbort) {
          logDebug("watch", "⏹️ cycle_aborted", { message: msg });
          break;
        }
        const isAuthError =
          /missing token|401|403|unauthorized|forbidden|auth|login/i.test(msg);
        if (isAuthError) {
          ctx.isAuthenticated = false;
          logWithTimestamp(`[AUTH] ❌ Session/auth error during watch: ${msg}`);
          logWithTimestamp("[AUTH] 🔄 Re-authenticating...");
          try {
            const loginOk = await mcp.runLoginFlow({
              forceInteractive: true,
              forceBrowser: true,
            });
            if (loginOk) {
              const checksOk = await checks.runInitialChecks();
              if (checksOk) {
                logWithTimestamp(
                  "[AUTH] ✅ Re-authenticated. Retrying watch cycle...",
                );
                continue;
              }
              logWithTimestamp(
                "[AUTH] ❌ Re-auth succeeded but checks failed.",
              );
            } else {
              logWithTimestamp("[AUTH] ❌ Re-authentication failed.");
            }
          } catch (reAuthError) {
            logWithTimestamp(
              `[AUTH] ❌ Re-authentication error: ${reAuthError.message}`,
            );
            logDebug("watch", "❌ reauth_failed", {
              error: reAuthError.message,
              stack: reAuthError.stack,
            });
          }
        }
        const displayMessage =
          typeof error?.message === "string" && error.message.trim()
            ? error.message.trim()
            : "unknown error";
        const baseRetryAfterSeconds = Math.max(
          1,
          Math.ceil(
            Number(
              error?.retryAfterSeconds ||
                (Number(ctx.mcpRateLimitedUntil || 0) > Date.now()
                  ? (Number(ctx.mcpRateLimitedUntil || 0) - Date.now()) / 1000
                  : 0),
            ) || 3,
          ),
        );
        const repeatedRateLimit =
          error?.rateLimited === true &&
          String(error?.toolName || "") === "watch_and_claim";
        const retryDelayMs =
          error?.rateLimited === true
            ? Math.max(
                baseRetryAfterSeconds * 1000,
                repeatedRateLimit ? opts.pollIntervalSeconds * 2000 : 0,
              )
            : 3000;
        logWithTimestamp(
          `[WATCH] ❌ Cycle failed: ${displayMessage}. Retrying in ${Math.ceil(retryDelayMs / 1000)}s.`,
        );
        logDebug("watch", "❌ cycle_error", {
          error: error.message,
          stack: error.stack,
          retryAfterSeconds:
            error?.rateLimited === true ? baseRetryAfterSeconds : null,
          retryDelaySeconds:
            error?.rateLimited === true
              ? Math.ceil(retryDelayMs / 1000)
              : null,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    ctx.watcherRunning = false;
    ctx.watchStartPending = false;
    ctx.isIdle = true;
    redrawHeaderAndLog(ctx.currentMissionStats);
    logWithTimestamp("[WATCH] ⏹️ Stopped.");
  }

  return {
    extractClaimCount,
    watchConfig,
    runWatchCycle: runWatchCycleExclusive,
    runManualProcess,
    runManualResetCheck,
    startWatchLoop,
    stopWatchLoop: async ({ persist = true, waitForCycle = true } = {}) => {
      ctx.watchLoopEnabled = false;
      if (typeof checks.stopRentalFastRefresh === "function") {
        checks.stopRentalFastRefresh("watch_stopped");
      }
      if (persist) {
        ctx.config.watchLoopEnabled = false;
        saveConfig(ctx, logDebug);
      }
      if (!waitForCycle && cycleAbortController) {
        try {
          cycleAbortController.abort();
        } catch {}
      }
      if (waitForCycle && cycleInFlight) {
        try {
          await cycleInFlight;
        } catch {}
      }
    },
  };
}

module.exports = {
  createWatchService,
};
