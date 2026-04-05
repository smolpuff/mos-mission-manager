"use strict";

const { normalizeMissionList, missionHasAssignedNft, missionIsClaimable } = require("../missions/normalize");
const { parseResetLevel, evaluateResetCandidates } = require("./reset");
const { spawn } = require("child_process");

function createWatchService(ctx, logger, mcp, checks, configApi) {
  const { logWithTimestamp, logDebug, redrawHeaderAndLog } = logger;
  const { saveConfig } = configApi;
  const WATCH_MAX_LIMIT_SECONDS = 600;
  const WATCH_MAX_CLAIMS = 3;
  const WATCH_FALLBACK_CLAIMS = true;
  const WATCH_CYCLE_SECONDS = 240;
  const MISSION_PLAY_URL = "https://pixelbypixel.studio/missions/play";
  let cycleInFlight = null;
  let lastResetPopupKey = "";

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
    const byEvents = collectClaimEvents(watchResult).filter((c) => c?.success !== false).length;
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
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw);
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
    return null;
  }

  function extractFailedClaimCount(watchResult) {
    return collectClaimEvents(watchResult).filter((c) => c?.success === false).length;
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
      claim?.assignedMissionId || claim?.assigned_mission_id || claim?.missionId || claim?.id || null;
    const fromLookup =
      missionId && lookupByAssignedMissionId instanceof Map
        ? lookupByAssignedMissionId.get(missionId) || null
        : null;
    return {
      missionId,
      name: claim?.name || claim?.missionName || fromLookup?.name || null,
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
      raw: claim,
    };
  }

  function logClaimDetails(claims, lookupByAssignedMissionId = null) {
    let successCount = 0;
    for (const c of claims) {
      const d = compactClaimDetails(c, lookupByAssignedMissionId);
      const missionText = d.name ? `${d.name}` : d.missionId || "unknown mission";
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
        logWithTimestamp(
          `[WATCH] ✅ Claimed: ${missionText}${slotText}${levelText}${rewardText}${messageText}`.trim(),
        );
      }
    }
    return successCount;
  }

  function watchConfig() {
    const maxLimitSeconds = WATCH_MAX_LIMIT_SECONDS;
    const configuredPoll = Number(ctx.config.watchPollIntervalSeconds);
    const pollIntervalSeconds =
      Number.isFinite(configuredPoll) && configuredPoll > 0 ? configuredPoll : 30;
    const maxClaims = WATCH_MAX_CLAIMS;
    const fallbackClaims = WATCH_FALLBACK_CLAIMS;
    const configuredCycleSeconds = WATCH_CYCLE_SECONDS;
    const watchSeconds = Math.max(
      Math.max(10, pollIntervalSeconds),
      Math.min(maxLimitSeconds, configuredCycleSeconds),
    );
    return { maxLimitSeconds, pollIntervalSeconds, maxClaims, watchSeconds, fallbackClaims };
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
      mission?.task_amount ?? mission?.taskAmount ?? mission?.goal ?? mission?.target ?? 0;
    const taskAmount = Number(taskAmountRaw);
    const eventName = String(mission?.task_event || mission?.taskEvent || "progress")
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
    const missions = checks.filterSelectedMissions(normalizeMissionList(missionResult));
    const byId = new Map();
    for (const m of missions) {
      const id = m?.assignedMissionId || m?.assigned_mission_id;
      if (!id) continue;
      const name = String(m?.name || m?.missionName || m?.mission_name || id);
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
    { logInitial = false, missionResult = null } = {},
  ) {
    const result = missionResult || (await mcp.mcpToolCall("get_user_missions", {}));
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

  async function loadAssignedMissionLookup(missionResult = null) {
    const result = missionResult || (await mcp.mcpToolCall("get_user_missions", {}));
    const missions = normalizeMissionList(result);
    const byAssignedMissionId = new Map();
    for (const m of missions) {
      const id = m?.assignedMissionId || m?.assigned_mission_id;
      if (!id) continue;
      byAssignedMissionId.set(id, {
        name: m?.name || m?.missionName || m?.mission_name || null,
        slot: m?.slot ?? null,
        level: m?.current_level ?? m?.level ?? null,
        reward: m?.prize_amount ?? m?.prizeAmount ?? m?.rewardAmount ?? m?.reward_amount ?? null,
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
        });
      }
    }
    return merged;
  }

  async function loadSelectedMissionSnapshot(missionResult = null) {
    const result = missionResult || (await mcp.mcpToolCall("get_user_missions", {}));
    const missions = checks.filterSelectedMissions(normalizeMissionList(result));
    const byAssignedMissionId = new Map();
    for (const m of missions) {
      const assignedMissionId = m?.assignedMissionId || m?.assigned_mission_id;
      if (!assignedMissionId) continue;
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
        name: String(m?.name || m?.missionName || m?.mission_name || assignedMissionId),
        slot: m?.slot ?? null,
        completed,
        assignedNft: missionHasAssignedNft(m) ? String(assignedNftRaw || "assigned") : null,
        level: parseResetLevel(m),
        startTime: String(m?.start_time || m?.startTime || ""),
      });
    }
    return byAssignedMissionId;
  }

  function deriveStateTransitions(beforeMap, afterMap) {
    const started = [];
    const restarted = [];
    let claimedTransitions = 0;
    const allIds = new Set([...(beforeMap?.keys() || []), ...(afterMap?.keys() || [])]);
    for (const id of allIds) {
      const before = beforeMap?.get(id) || null;
      const after = afterMap?.get(id) || null;
      if (!before || !after) continue;
      if (!before.assignedNft && after.assignedNft) {
        started.push({
          name: after.name,
          slot: after.slot,
          nft: after.assignedNft,
          assignedMissionId: id,
        });
      }
      const levelUp = Number(after.level || 0) > Number(before.level || 0);
      const startTimeChanged = before.startTime && after.startTime && before.startTime !== after.startTime;
      if (before.assignedNft && after.assignedNft && (levelUp || startTimeChanged)) {
        restarted.push({
          name: after.name,
          slot: after.slot,
          fromLevel: before.level,
          toLevel: after.level,
          startTimeChanged,
          assignedMissionId: id,
        });
      }
      if (before.completed === true && after.completed === false) {
        claimedTransitions += 1;
      } else if (levelUp) {
        claimedTransitions += 1;
      }
    }
    return { started, restarted, claimedTransitions };
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
    if (ctx.debugMode) {
      logWithTimestamp(`[WATCH] ✅ ${logLabel}: +${claimed} (session ${safeBefore} -> ${ctx.sessionClaimedCount})`);
    }
    return claimed;
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

  async function fetchSelectedSnapshot(missionResult = null) {
    const result = missionResult || (await mcp.mcpToolCall("get_user_missions", {}));
    const snapshot = await loadSelectedMissionSnapshot(result);
    return { result, snapshot };
  }

  async function runSharedClaimFollowup({
    claimed = 0,
    beforeSnapshot = new Map(),
    assignReason,
    claimLogLabel = "Claimed",
    assignIntro = "[ASSIGN] ▶ Post-claim assign check (immediate)...",
    initialMissionResult = null,
    allowStateFallback = true,
  } = {}) {
    let currentClaimed = Number(claimed || 0);
    let assigned = 0;
    let missionResult = initialMissionResult;

    if (!(missionResult && typeof missionResult === "object")) {
      try {
        missionResult = await mcp.mcpToolCall("get_user_missions", {});
      } catch (error) {
        logDebug("watch", "post_cycle_missions_failed", { error: error.message });
      }
    }

    if (currentClaimed > 0) {
      try {
        applyClaimCountUpdate(currentClaimed, { logLabel: claimLogLabel });
      } catch (error) {
        logWithTimestamp(`[WATCH] ❌ Claimed counter update error: ${error.message}`);
        logDebug("watch", "claimed_counter_update_failed", {
          error: error.message,
          stack: error.stack,
          claimed: currentClaimed,
        });
      }
      logWithTimestamp(assignIntro);
      try {
        logDebug("watch", "assign_check_start", { reason: assignReason });
        const assignResult = await checks.autoAssignConfiguredMissions({ reason: assignReason });
        logDebug("watch", "assign_check_done", {
          reason: assignReason,
          attempted: Number(assignResult?.attempted || 0),
          assigned: Number(assignResult?.assigned || 0),
          skipped: assignResult?.skipped === true,
        });
        logAssignCheckResult(assignResult);
        assigned = Number(assignResult?.assigned || 0);
        if (assigned > 0) {
          missionResult = await mcp.mcpToolCall("get_user_missions", {});
        }
      } catch (error) {
        logWithTimestamp(`[ASSIGN] ❌ Post-claim assign error: ${error.message}`);
        logDebug("watch", "post_claim_assign_error", { error: error.message, stack: error.stack });
      }
    }

    if (allowStateFallback && currentClaimed === 0 && beforeSnapshot.size > 0) {
      try {
        const afterSnapshot = await loadSelectedMissionSnapshot(missionResult);
        const transitions = deriveStateTransitions(beforeSnapshot, afterSnapshot);
        if (transitions.claimedTransitions > 0) {
          currentClaimed = transitions.claimedTransitions;
          applyClaimCountUpdate(currentClaimed, { logLabel: claimLogLabel });
          if (assigned === 0) {
            logWithTimestamp("[ASSIGN] ▶ Post-claim assign check (state fallback)...");
            const fallbackAssign = await checks.autoAssignConfiguredMissions({
              reason: "post_claim_state_fallback",
            });
            logDebug("watch", "assign_check_done", {
              reason: "post_claim_state_fallback",
              attempted: Number(fallbackAssign?.attempted || 0),
              assigned: Number(fallbackAssign?.assigned || 0),
              skipped: fallbackAssign?.skipped === true,
            });
            logAssignCheckResult(fallbackAssign);
            assigned = Math.max(assigned, Number(fallbackAssign?.assigned || 0));
            if (assigned > 0) {
              missionResult = await mcp.mcpToolCall("get_user_missions", {});
            }
          }
        }
      } catch (error) {
        logDebug("watch", "state_fallback_failed", { error: error.message, stack: error.stack });
      }
    }

    return {
      claimed: currentClaimed,
      assigned,
      missionResult,
    };
  }

  async function openMissionPlayPage() {
    const url = MISSION_PLAY_URL;
    const candidates =
      process.platform === "darwin"
        ? [["open", [url]]]
        : process.platform === "win32"
          ? [["cmd", ["/c", "start", "", url]]]
          : [
              ["xdg-open", [url]],
              ["gio", ["open", url]],
            ];
    for (const [cmd, args] of candidates) {
      const ok = await new Promise((resolve) => {
        let settled = false;
        const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
        child.once("error", () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
        child.once("exit", (code) => {
          if (!settled) {
            settled = true;
            resolve(code === 0);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve(true);
          }
        }, 250);
      });
      if (ok) return true;
    }
    return false;
  }

  function getResetPolicy() {
    const mmEnabled = ctx.missionModeEnabled || ctx.config.missionModeEnabled === true;
    if (mmEnabled) {
      const rawLevel = ctx.currentMissionResetLevel || ctx.config.missionResetLevel || "11";
      const threshold = Number(rawLevel);
      if (Number.isFinite(threshold) && threshold > 0) {
        return { enabled: true, threshold, label: `mm(${Math.floor(threshold)})` };
      }
      return { enabled: true, threshold: 11, label: "mm(11)" };
    }
    if (ctx.level20ResetEnabled || ctx.config.level20ResetEnabled === true) {
      return { enabled: true, threshold: 20, label: "20r" };
    }
    return { enabled: false, threshold: null, label: "" };
  }

  async function handleLevelResetIfNeeded(snapshotMap, { reason = "cycle", threshold = 20, label = "reset" } = {}) {
    const { ready: resetHits, blocked } = evaluateResetCandidates(snapshotMap, threshold);
    if (blocked.length > 0) {
      logDebug("reset", "deferred", {
        reason,
        label,
        threshold,
        blocked: blocked.map((m) => ({
          missionId: m.assignedMissionId,
          name: m.name,
          level: m.level,
          completed: m.completed,
          hasActiveNft: Boolean(m.assignedNft),
        })),
      });
      if (resetHits.length === 0) {
        const names = blocked.map((m) => `${m.name} lvl=${Number(m.level || 0)}`).join(", ");
        logWithTimestamp(
          `[RESET] ℹ️ Deferred (${label}): above threshold but mission has active NFT: ${names}`,
        );
      }
    }
    if (resetHits.length === 0) {
      lastResetPopupKey = "";
      return false;
    }
    const popupKey = `${label}|${Math.floor(Number(threshold) || 0)}|${resetHits
      .map((m) => `${m.assignedMissionId}:${Number(m.level || 0)}`)
      .sort()
      .join(",")}`;
    if (popupKey && popupKey === lastResetPopupKey) {
      logDebug("reset", "popup_duplicate_suppressed", { reason, label, threshold, popupKey });
      return true;
    }
    lastResetPopupKey = popupKey;
    const names = resetHits.map((m) => `${m.name} lvl=${Number(m.level || 0)}`).join(", ");
    logWithTimestamp(`[RESET] ⚠️ ${label} threshold hit (${reason}): ${names}`);
    logWithTimestamp("[RESET] 🌐 Opening missions page for manual reset...");
    const opened = await openMissionPlayPage();
    if (!opened) {
      logWithTimestamp(`[RESET] ❌ Failed to auto-open browser. Open manually: ${MISSION_PLAY_URL}`);
    }
    logWithTimestamp("[RESET] ℹ️ Manual reset needed. Watcher continues running.");
    return true;
  }

  async function runResetCheckIfEnabled(reason, missionResult = null) {
    const resetPolicy = getResetPolicy();
    if (!resetPolicy.enabled) return false;
    const snapshot = await loadSelectedMissionSnapshot(missionResult);
    return handleLevelResetIfNeeded(snapshot, {
      reason,
      threshold: resetPolicy.threshold,
      label: resetPolicy.label,
    });
  }

  async function runWatchCycle() {
    const opts = watchConfig();
    logDebug("watch", "cycle_start", opts);
    logWithTimestamp("[WATCH] Watching missions...");

    let preCycleMissionResult = null;
    try {
      preCycleMissionResult = await mcp.mcpToolCall("get_user_missions", {});
      await runResetCheckIfEnabled("cycle_start", preCycleMissionResult);
    } catch (error) {
      logDebug("watch", "pre_cycle_missions_failed", { error: error.message });
    }

    let beforeSnapshot = new Map();
    try {
      beforeSnapshot = await loadSelectedMissionSnapshot(preCycleMissionResult);
    } catch (error) {
      logDebug("watch", "snapshot_before_failed", { error: error.message });
    }

    const watchTimeoutMs = Math.max(
      30000,
      opts.watchSeconds * 1000 + 15000,
    );
    const startedAt = Date.now();
    let watchTick = 0;
    let missionStateById = new Map();
    let postClaimAssignRan = false;
    let postClaimAssigned = 0;
    let missionStatePollRunning = false;
    let refreshKickPending = false;
    const runLiveMissionCheck = (reason) => {
      if (missionStatePollRunning) {
        refreshKickPending = true;
        return;
      }
      missionStatePollRunning = true;
      const pollPromise = ctx.debugMode
        ? pollMissionStateChanges(missionStateById, reason)
        : mcp.mcpToolCall("get_user_missions", {});
      pollPromise
        .then((updated) => {
          if (ctx.debugMode) missionStateById = updated;
          return runResetCheckIfEnabled(reason, updated);
        })
        .catch((error) => {
          logDebug("watch", "poll_tick_check_failed", { reason, error: error.message });
        })
        .finally(() => {
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
      logWithTimestamp("[WATCH] ✅ Token refresh detected; running immediate check...");
      runLiveMissionCheck("token_refresh");
    };
    if (ctx.debugMode) {
      try {
        missionStateById = await pollMissionStateChanges(
          missionStateById,
          "cycle_start",
          { logInitial: true, missionResult: preCycleMissionResult },
        );
      } catch (error) {
        logDebug("watch", "mission_state_poll_failed", {
          reason: "cycle_start",
          error: error.message,
        });
      }
    }
    const tickEveryMs = Math.max(1000, opts.pollIntervalSeconds * 1000);
    const tickTimer = setInterval(() => {
      watchTick += 1;
      const snapshot = ctx.currentMissionStats || {};
      const claimable = Number(snapshot.claimable || 0);
      const available = Number(snapshot.available || 0);
      const chance = claimable > 0 ? "high" : available > 0 ? "medium" : "low";
      logDebug("watch", "poll_tick", {
        tick: watchTick,
        elapsedMs: Date.now() - startedAt,
        watchSeconds: opts.watchSeconds,
        pollIntervalSeconds: opts.pollIntervalSeconds,
        chance,
        claimable,
        available,
        active: Number(snapshot.active || 0),
        sessionClaimedCount: Number(ctx.sessionClaimedCount || 0),
      });
      runLiveMissionCheck(`poll_tick_${watchTick}`);
    }, tickEveryMs);

    let result;
    try {
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
        { timeoutMs: watchTimeoutMs },
      );
      logDebug("watch", "watch_call_done", {
        success: result?.structuredContent?.success,
        watch: result?.structuredContent?.watch || {},
      });
    } finally {
      clearInterval(tickTimer);
      ctx.onAuthRefresh = previousAuthRefreshHandler || null;
    }

    const summary = summarizeWatch(result);
    const rawClaimCounter = extractRawClaimCounterValue(result);
    let claimed = extractClaimCount(result);
    const failedClaims = extractFailedClaimCount(result);
    const claimEvents = extractClaimEventCount(result);
    if (rawClaimCounter !== null) claimed = Math.max(claimed, rawClaimCounter);
    const watchSuccess = result?.structuredContent?.success;
    logDebug("watch", "claim_parse", { claimEvents, claimed, failedClaims, watchSuccess });
    if (claimed > 0) {
      logWithTimestamp(`[WATCH] ✅ Claim signal detected: parsedSuccess=${claimed}`);
    }
    logDebug("watch", "watch_and_claim_returned", {
      success: watchSuccess === undefined ? "n/a" : String(watchSuccess),
      claimEvents,
      parsedSuccess: claimed,
      parsedFailed: failedClaims,
      eligible: summary.eligible,
      total: summary.total,
    });
    const payloadClaimedRaw =
      result?.structuredContent?.claimedCount ??
      result?.structuredContent?.claim_count ??
      result?.structuredContent?.claimed ??
      result?.structuredContent?.totalClaimed ??
      result?.structuredContent?.claimsProcessed ??
      result?.structuredContent?.watch?.claimedCount ??
      result?.structuredContent?.watch?.claim_count ??
      result?.structuredContent?.watch?.claimed ??
      result?.structuredContent?.watch?.totalClaimed ??
      result?.structuredContent?.watch?.claimsProcessed;
    logDebug("watch", "payload_counters", {
      payloadClaimedCounter: payloadClaimedRaw ?? "n/a",
      parsedSuccess: claimed,
      parsedEvents: claimEvents,
      rawCounter: rawClaimCounter ?? "n/a",
      successEvents: summary.claims.filter((c) => c?.success !== false).length,
      failedEvents: failedClaims,
    });
    if (claimed === 0 && opts.fallbackClaims) {
      logDebug("watch", "fallback_claim_start", { reason: "watch_reported_zero", maxClaims: opts.maxClaims });
      const fallback = await checks.claimClaimableMissions({
        maxClaims: opts.maxClaims,
        reason: "watch_reported_zero",
      });
      logDebug("watch", "fallback_claim_done", { claimed: fallback?.claimed || 0, ok: fallback?.ok });
      claimed += Number(fallback?.claimed || 0);
    }
    logDebug("watch", "cycle_result", {
      watch: result?.structuredContent?.watch || {},
      watchWindowEnded: summary.windowEnded,
      missionSnapshot: result?.structuredContent?.missionSnapshot || {},
      claimsCount: summary.claims.length,
      claimEvents,
      failedClaims,
      claims: summary.claims.map((c) => compactClaimDetails(c)),
      raw: result?.structuredContent || result,
    });
    let postCycleMissionResult = null;
    try {
      postCycleMissionResult = await mcp.mcpToolCall("get_user_missions", {});
    } catch (error) {
      logDebug("watch", "post_cycle_missions_failed", { error: error.message });
    }

    if (summary.claims.length > 0) {
      let lookupByAssignedMissionId = null;
      const needsLookup = summary.claims.some((c) => {
        const d = compactClaimDetails(c);
        return d.name === null || d.slot === null;
      });
      if (needsLookup) {
        try {
          const [preLookup, postLookup] = await Promise.all([
            loadAssignedMissionLookup(preCycleMissionResult),
            loadAssignedMissionLookup(postCycleMissionResult),
          ]);
          lookupByAssignedMissionId = mergeAssignedMissionLookups(preLookup, postLookup);
        } catch (error) {
          logDebug("watch", "claim_lookup_failed", { error: error.message });
        }
      }
      const successFromClaimLines = logClaimDetails(summary.claims, lookupByAssignedMissionId);
      // Guarantee claimed counters track successful claim events even when aggregate counters are stale.
      claimed = Math.max(claimed, successFromClaimLines);
    }
    if (claimed > 0 && summary.claims.length === 0) {
      logWithTimestamp(`[WATCH] ✅ Claimed ${claimed} mission reward(s).`);
    }

    const claimFollowup = await runSharedClaimFollowup({
      claimed,
      beforeSnapshot,
      assignReason: "post_claim",
      claimLogLabel: "Claimed count updated",
      assignIntro: "[ASSIGN] ▶ Post-claim assign check (immediate)...",
      initialMissionResult: postCycleMissionResult,
      allowStateFallback: true,
    });
    claimed = claimFollowup.claimed;
    postClaimAssigned = claimFollowup.assigned;
    postClaimAssignRan = claimed > 0;
    postCycleMissionResult = claimFollowup.missionResult;

    await checks.refreshMissionHeaderStats({ missionsResult: postCycleMissionResult });
    try {
      await runResetCheckIfEnabled("cycle_end", postCycleMissionResult);
    } catch (error) {
      logDebug("watch", "snapshot_after_for_reset_failed", { error: error.message });
    }
    if (postClaimAssignRan && postClaimAssigned > 0) {
      logDebug("watch", "cycle_end_assign_skipped", {
        reason: "post_claim_assign_succeeded",
        postClaimAssigned,
      });
    } else {
      if (ctx.debugMode) logWithTimestamp("[ASSIGN] ▶ Cycle-end assign check...");
      try {
        const assignResult = await checks.autoAssignConfiguredMissions({
          reason: "cycle_end_unassigned_check",
        });
        if (Number(assignResult?.assigned || 0) > 0) {
          logWithTimestamp(
            `[ASSIGN] ✅ cycle-end result: attempted=${Number(assignResult?.attempted || 0)} assigned=${Number(assignResult?.assigned || 0)}`,
          );
        } else if (ctx.debugMode) {
          logWithTimestamp(
            `[ASSIGN] ℹ️ cycle-end result: attempted=${Number(assignResult?.attempted || 0)} assigned=0`,
          );
        }
      } catch (error) {
        logWithTimestamp(`[ASSIGN] ❌ cycle-end assign error: ${error.message}`);
        logDebug("watch", "cycle_end_assign_error", { error: error.message, stack: error.stack });
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

  async function runManualProcess() {
    if (cycleInFlight) await cycleInFlight.catch(() => {});
    if (!ctx.isAuthenticated) throw new Error("Not authenticated");
    logWithTimestamp("[WATCH] ▶ Manual immediate process (claim+assign)...");
    let beforeSnapshot = new Map();
    try {
      const preManualMissionResult = await mcp.mcpToolCall("get_user_missions", {});
      beforeSnapshot = await loadSelectedMissionSnapshot(preManualMissionResult);
      await runResetCheckIfEnabled("manual_pre", preManualMissionResult);
    } catch (error) {
      logDebug("watch", "manual_reset_precheck_failed", { error: error.message, stack: error.stack });
    }
    try {
      const claimResult = await checks.claimClaimableMissions({
        maxClaims: WATCH_MAX_CLAIMS,
        reason: "manual",
        onlySelected: false,
      });
      const followup = await runSharedClaimFollowup({
        claimed: Number(claimResult?.claimed || 0),
        beforeSnapshot,
        assignReason: "manual",
        claimLogLabel: "Manual claimed",
        assignIntro: "[ASSIGN] ▶ Post-claim assign check (immediate)...",
        initialMissionResult: null,
        allowStateFallback: true,
      });
      await checks.refreshMissionHeaderStats({ missionsResult: followup.missionResult });
      await runResetCheckIfEnabled("manual_post", followup.missionResult);
      return { claimed: followup.claimed, assigned: followup.assigned };
    } catch (error) {
      logDebug("watch", "manual_reset_check_failed", { error: error.message, stack: error.stack });
      throw error;
    }
  }

  async function startWatchLoop() {
    if (!ctx.watchLoopEnabled || !ctx.isAuthenticated || ctx.watcherRunning) return;

    ctx.watcherRunning = true;
    ctx.isIdle = false;
    redrawHeaderAndLog(ctx.currentMissionStats);

    const opts = watchConfig();
    logWithTimestamp(
      `[WATCH] 👀 Started: poll=${opts.pollIntervalSeconds}s refresh=${opts.watchSeconds}s`,
    );
    logWithTimestamp("[WATCH] ▶ Initial mission check...");
    try {
      const startupClaims = await checks.claimClaimableMissions({
        maxClaims: opts.maxClaims,
        reason: "watch_loop_startup",
        onlySelected: false,
      });
      const startupClaimed = Number(startupClaims?.claimed || 0);
      if (startupClaimed === 0) {
        logWithTimestamp("[WATCH] ℹ️ Startup claim check: no claimable missions.");
      }
      applyClaimCountUpdate(startupClaimed, { logLabel: "Startup claimed" });
    } catch (error) {
      logWithTimestamp(`[WATCH] ❌ Startup claim check failed: ${error.message}`);
      logDebug("watch", "startup_claim_check_failed", { error: error.message, stack: error.stack });
    }

    try {
      const startupAssign = await checks.autoAssignConfiguredMissions({
        reason: "watch_loop_startup",
      });
      if (Number(startupAssign?.assigned || 0) > 0) {
        const started = Array.isArray(startupAssign?.startedMissionDetails)
          ? startupAssign.startedMissionDetails
              .filter((x) => x && x.name)
              .map((x) => {
                const level = Number.isFinite(Number(x.level)) ? Number(x.level) : null;
                const levelText = level === null ? "" : ` lvl=${level}`;
                return `${x.name}${levelText}`;
              })
          : Array.isArray(startupAssign?.startedMissionNames)
            ? startupAssign.startedMissionNames.filter(Boolean)
            : [];
        if (ctx.debugMode && started.length > 0) {
          logWithTimestamp(`[ASSIGN] ✅ Startup started: ${started.join(", ")}`);
        }
      }
      if (ctx.debugMode && Number(startupAssign?.assigned || 0) > 0) {
        logWithTimestamp(
          `[ASSIGN] ✅ startup result: attempted=${Number(startupAssign?.attempted || 0)} assigned=${Number(startupAssign?.assigned || 0)}`,
        );
      } else if (ctx.debugMode) {
        logWithTimestamp(
          `[ASSIGN] ℹ️ startup result: attempted=${Number(startupAssign?.attempted || 0)} assigned=0`,
        );
      }

      // Backend mission state can lag briefly after claim/startup fetches.
      // Do one short retry pass at startup when first assign found nothing.
      if (Number(startupAssign?.assigned || 0) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const startupAssignRetry = await checks.autoAssignConfiguredMissions({
          reason: "watch_loop_startup_retry_1",
        });
        if (Number(startupAssignRetry?.assigned || 0) > 0) {
          const retryStarted = Array.isArray(startupAssignRetry?.startedMissionDetails)
            ? startupAssignRetry.startedMissionDetails
                .filter((x) => x && x.name)
                .map((x) => {
                  const level = Number.isFinite(Number(x.level)) ? Number(x.level) : null;
                  const levelText = level === null ? "" : ` lvl=${level}`;
                  return `${x.name}${levelText}`;
                })
            : Array.isArray(startupAssignRetry?.startedMissionNames)
              ? startupAssignRetry.startedMissionNames.filter(Boolean)
              : [];
          if (ctx.debugMode && retryStarted.length > 0) {
            logWithTimestamp(`[ASSIGN] ✅ Startup started: ${retryStarted.join(", ")}`);
          }
          if (ctx.debugMode) {
            logWithTimestamp(
              `[ASSIGN] ✅ startup retry result: attempted=${Number(startupAssignRetry?.attempted || 0)} assigned=${Number(startupAssignRetry?.assigned || 0)}`,
            );
          }
        } else if (Number(ctx.currentMissionStats?.available || 0) > 0) {
          logWithTimestamp("[ASSIGN] ℹ️ Startup: open slots exist, but no target mission was assignable yet.");
        } else if (ctx.debugMode) {
          logWithTimestamp(
            `[ASSIGN] ℹ️ startup retry result: attempted=${Number(startupAssignRetry?.attempted || 0)} assigned=0`,
          );
        }
      }
    } catch (error) {
      logWithTimestamp(`[ASSIGN] ❌ Startup assign check failed: ${error.message}`);
      logDebug("watch", "startup_assign_check_failed", { error: error.message, stack: error.stack });
    }

    try {
      const startupMissionResult = await mcp.mcpToolCall("get_user_missions", {});
      await runResetCheckIfEnabled("startup", startupMissionResult);
    } catch (error) {
      logDebug("watch", "startup_reset_check_failed", { error: error.message, stack: error.stack });
    }

    while (ctx.watchLoopEnabled) {
      try {
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
      } catch (error) {
        const msg = String(error?.message || "");
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
                logWithTimestamp("[AUTH] ✅ Re-authenticated. Retrying watch cycle...");
                continue;
              }
              logWithTimestamp("[AUTH] ❌ Re-auth succeeded but checks failed.");
            } else {
              logWithTimestamp("[AUTH] ❌ Re-authentication failed.");
            }
          } catch (reAuthError) {
            logWithTimestamp(`[AUTH] ❌ Re-authentication error: ${reAuthError.message}`);
            logDebug("watch", "reauth_failed", {
              error: reAuthError.message,
              stack: reAuthError.stack,
            });
          }
        }
        logWithTimestamp("[WATCH] ❌ Cycle failed; retrying in 3s.");
        logDebug("watch", "cycle_error", { error: error.message, stack: error.stack });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    ctx.watcherRunning = false;
    ctx.isIdle = true;
    redrawHeaderAndLog(ctx.currentMissionStats);
    logWithTimestamp("[WATCH] ⏹️ Stopped.");
  }

  return {
    extractClaimCount,
    watchConfig,
    runWatchCycle: runWatchCycleExclusive,
    runManualProcess,
    startWatchLoop,
    stopWatchLoop: async ({ persist = true } = {}) => {
      ctx.watchLoopEnabled = false;
      if (persist) {
        ctx.config.watchLoopEnabled = false;
        saveConfig(ctx, logDebug);
      }
      if (cycleInFlight) {
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
