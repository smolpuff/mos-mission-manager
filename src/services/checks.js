"use strict";

const {
  normalizeMissionList,
  normalizeNftList,
  normalizeMissionCatalogList,
  computeMissionStats,
  missionHasAssignedNft,
  missionIsClaimable,
} = require("../missions/normalize");

function createChecksService(ctx, logger, mcp) {
  const { logWithTimestamp, logDebug, redrawHeaderAndLog } = logger;
  const canonicalNameKey = (v) =>
    String(v || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  const isUsableIdValue = (v) => {
    if (typeof v !== "string") return false;
    const s = v.trim();
    if (!s) return false;
    const lowered = s.toLowerCase();
    return !["null", "undefined", "none", "false", "n/a"].includes(lowered);
  };

  function toolCallSucceeded(result) {
    if (!result || typeof result !== "object") return true;
    if (result.isError === true) return false;
    const sc = result.structuredContent || {};
    if (sc.success === false) return false;
    if (sc.details?.error === true) return false;
    return true;
  }

  function nftIsAvailable(n) {
    if (n?.onCooldown === true) return false;
    const cooldownSeconds = Number(
      n?.cooldownSeconds ?? n?.cooldown_seconds ?? n?.cooldown ?? 0,
    );
    return !Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0;
  }

  function missionName(mission) {
    return String(mission?.name || mission?.missionName || mission?.mission_name || "")
      .trim();
  }
  function missionLevel(mission) {
    const raw = mission?.current_level ?? mission?.level ?? null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function assignedMissionId(mission) {
    const id = mission?.assignedMissionId || mission?.assigned_mission_id;
    return isUsableIdValue(id) ? id.trim() : null;
  }

  function catalogMissionId(mission) {
    const id = mission?.missionId || mission?.mission_id || mission?.id;
    return isUsableIdValue(id) ? id.trim() : null;
  }

  function nftAccountId(nft) {
    const id =
      nft?.nftAccount ||
      nft?.nft_account ||
      nft?.tokenAddress ||
      nft?.token_address ||
      nft?.mintAddress ||
      nft?.mint_address ||
      nft?.id;
    return isUsableIdValue(id) ? id.trim() : null;
  }

  function assignFailureMessage(assignResult) {
    return (
      assignResult?.structuredContent?.details?.message ||
      assignResult?.content?.[0]?.text ||
      "assign_nft_to_mission failed"
    );
  }

  function assignFailureDetails(assignResult) {
    return assignResult?.structuredContent?.details || null;
  }

  function isRetryableActiveMissionAssignError(message = "") {
    return /NFT is already in an active mission/i.test(String(message || ""));
  }

  function configuredTargetEntries() {
    if (!Array.isArray(ctx.config.targetMissions)) return [];
    return ctx.config.targetMissions.map((v) => String(v || "").trim()).filter(Boolean);
  }

  function shouldRetryAssignmentSync(reason = "") {
    const value = String(reason || "");
    return (
      value === "post_claim" ||
      value === "post_claim_state_fallback" ||
      value.startsWith("post_claim_")
    );
  }

  function buildAssignCandidates(missions, resolved) {
    return missions.filter((m) => {
      const name = missionName(m).toLowerCase();
      const key = canonicalNameKey(name);
      const id = catalogMissionId(m);
      const selectedById = id ? resolved.targetIds.has(id) : false;
      const selectedByName = key ? resolved.targetNames.has(key) : false;
      return (selectedById || selectedByName) && !missionHasAssignedNft(m);
    });
  }

  function summarizeSelectedMissionState(missions, resolved) {
    return missions
      .filter((m) => {
        const name = canonicalNameKey(missionName(m));
        const id = catalogMissionId(m);
        return (id && resolved.targetIds.has(id)) || (name && resolved.targetNames.has(name));
      })
      .map((m) => ({
        name: missionName(m) || null,
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
        hasAssignedNft: missionHasAssignedNft(m),
        claimable: missionIsClaimable(m),
      }));
  }

  async function loadAssignableCandidatesWithSyncWait(reason, resolved, initialMissionResult = null) {
    let result = initialMissionResult || (await mcp.mcpToolCall("get_user_missions", {}));
    let missions = normalizeMissionList(result);
    let candidates = buildAssignCandidates(missions, resolved);
    logDebug("assign", "sync_wait_snapshot", {
      reason,
      attempt: 0,
      selected: summarizeSelectedMissionState(missions, resolved),
      candidates: candidates.map((m) => ({
        name: missionName(m),
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
      })),
    });
    if (candidates.length > 0 || !shouldRetryAssignmentSync(reason)) {
      return { result, missions, candidates };
    }

    const retryDelaysMs = [1200, 2500, 5000];
    for (let i = 0; i < retryDelaysMs.length; i += 1) {
      const delayMs = retryDelaysMs[i];
      logWithTimestamp(
        `[ASSIGN] ⏳ Waiting ${delayMs}ms for mission state sync before recheck ${i + 1}/${retryDelaysMs.length}...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await mcp.mcpToolCall("get_user_missions", {});
      missions = normalizeMissionList(result);
      candidates = buildAssignCandidates(missions, resolved);
      logDebug("assign", "sync_wait_snapshot", {
        reason,
        attempt: i + 1,
        delayMs,
        selected: summarizeSelectedMissionState(missions, resolved),
        candidates: candidates.map((m) => ({
          name: missionName(m),
          assignedMissionId: assignedMissionId(m),
          catalogMissionId: catalogMissionId(m),
          slot: m?.slot ?? null,
          level: missionLevel(m),
        })),
      });
      if (candidates.length > 0) break;
    }

    return { result, missions, candidates };
  }

  function resolveConfiguredTargets(catalogMissions = ctx.missionCatalogEntries || []) {
    const configured = configuredTargetEntries();
    if (catalogMissions.length === 0) {
      return {
        configured,
        targetIds: new Set(),
        targetNames: new Set(configured.map((x) => canonicalNameKey(x)).filter(Boolean)),
        invalid: [],
      };
    }
    const byId = new Map();
    const byName = new Map();
    for (const m of catalogMissions) {
      const id = catalogMissionId(m);
      const name = missionName(m);
      if (id) byId.set(id.toLowerCase(), { id, name });
      if (name) byName.set(canonicalNameKey(name), { id, name });
    }

    const targetIds = new Set();
    const targetNames = new Set();
    const invalid = [];
    for (const raw of configured) {
      const key = raw.toLowerCase();
      const idMatch = byId.get(key);
      if (idMatch) {
        targetIds.add(idMatch.id);
        if (idMatch.name) targetNames.add(idMatch.name.toLowerCase());
        continue;
      }
      const nameMatch = byName.get(key);
      const canonicalMatch = byName.get(canonicalNameKey(raw));
      if (!nameMatch && canonicalMatch) {
        if (canonicalMatch.id) targetIds.add(canonicalMatch.id);
        targetNames.add(canonicalNameKey(canonicalMatch.name));
        continue;
      }
      if (nameMatch) {
        if (nameMatch.id) targetIds.add(nameMatch.id);
        targetNames.add(canonicalNameKey(nameMatch.name));
        continue;
      }
      invalid.push(raw);
    }

    return { configured, targetIds, targetNames, invalid };
  }

  function isConfiguredTargetMission(mission, resolved = null) {
    const r = resolved || resolveConfiguredTargets();
    if (r.targetIds.size === 0 && r.targetNames.size === 0) return true;
    const name = canonicalNameKey(missionName(mission));
    const id = catalogMissionId(mission);
    const selectedById = id ? r.targetIds.has(id) : false;
    const selectedByName = name ? r.targetNames.has(name) : false;
    return selectedById || selectedByName;
  }

  function filterSelectedMissions(missions = []) {
    const resolved = resolveConfiguredTargets();
    if (resolved.targetIds.size === 0 && resolved.targetNames.size === 0) return missions;
    return missions.filter((m) => isConfiguredTargetMission(m, resolved));
  }

  async function refreshMissionCatalog() {
    try {
      const result = await mcp.mcpToolCall("get_mission_catalog", {});
      const missions = normalizeMissionCatalogList(result);
      ctx.missionCatalogEntries = missions;
      logWithTimestamp(`[CATALOG] ✅ Loaded ${missions.length} missions`);
      return { ok: true, total: missions.length };
    } catch (error) {
      logWithTimestamp(`[CATALOG] ❌ Failed to load mission catalog: ${error.message}`);
      logDebug("catalog", "load_failed", { error: error.message });
      return { ok: false, total: 0 };
    }
  }

  function validateConfiguredTargets() {
    const resolved = resolveConfiguredTargets();
    if (resolved.configured.length === 0) return resolved;
    if (resolved.invalid.length > 0) {
      logWithTimestamp(
        `[CONFIG] ⚠️ targetMissions not found in catalog: ${resolved.invalid.join(", ")}`,
      );
    }
    const validNames = Array.from(resolved.targetNames);
    if (validNames.length > 0) {
      logWithTimestamp(`[CONFIG] ✅ targetMissions resolved: ${validNames.join(", ")}`);
    }
    return resolved;
  }

  function selectedTargetsForDisplay(resolved = resolveConfiguredTargets()) {
    const out = [];
    const added = new Set();
    const catalog = Array.isArray(ctx.missionCatalogEntries) ? ctx.missionCatalogEntries : [];
    for (const m of catalog) {
      const id = catalogMissionId(m);
      const name = missionName(m);
      const byId = id ? resolved.targetIds.has(id) : false;
      const byName = name ? resolved.targetNames.has(name.toLowerCase()) : false;
      if (!(byId || byName)) continue;
      const label = name || id;
      if (!label || added.has(label)) continue;
      added.add(label);
      out.push(label);
    }
    if (out.length > 0) return out;
    // Fallback when catalog is unavailable: echo configured values.
    return resolved.configured.slice();
  }

  function logSelectedWatchTargetsAtStartup() {
    const resolved = resolveConfiguredTargets();
    const selected = selectedTargetsForDisplay(resolved);
    if (selected.length === 0) {
      logWithTimestamp("[WATCH] selected targets: (none configured)");
      return;
    }
    for (const name of selected) {
      logWithTimestamp(`[WATCH] - ${name}`);
    }
  }

  async function autoAssignConfiguredMissions({ reason = "periodic", missionsResult = null } = {}) {
    const resolved = resolveConfiguredTargets();
    logDebug("assign", "check", {
      reason,
      configured: resolved.configured.length,
      targets: resolved.targetIds.size || resolved.targetNames.size,
    });
    if (resolved.targetIds.size === 0 && resolved.targetNames.size === 0) {
      return { ok: true, attempted: 0, assigned: 0 };
    }
    if (ctx.autoAssignRunning) {
      logWithTimestamp(`[ASSIGN] ℹ️ Assign check skipped (already running) reason=${reason}`);
      return { ok: true, attempted: 0, assigned: 0, skipped: true };
    }

    ctx.autoAssignRunning = true;
    try {
      const { missions, candidates } = await loadAssignableCandidatesWithSyncWait(
        reason,
        resolved,
        missionsResult,
      );
      logDebug("assign", "candidates_built", {
        reason,
        candidates: candidates.map((m) => ({
          name: missionName(m),
          assignedMissionId: assignedMissionId(m),
          catalogMissionId: catalogMissionId(m),
          slot: m?.slot ?? null,
        })),
      });
      logDebug("assign", "check_result", { reason, candidates: candidates.length });

      if (candidates.length === 0) {
        if (
          reason === "manual" ||
          reason === "post_claim" ||
          String(reason || "").startsWith("post_claim_")
        ) {
          logWithTimestamp("[ASSIGN] ℹ️ No unassigned target mission to start right now.");
        }
        logDebug("assign", "no_candidates", {
          reason,
          targetCount: resolved.targetIds.size || resolved.targetNames.size,
          configuredTargets: resolved.configured,
          selectedMissionState: summarizeSelectedMissionState(missions, resolved),
        });
        return { ok: true, attempted: 0, assigned: 0 };
      }

      logWithTimestamp(
        `[ASSIGN] 🚀 Attempting to start ${candidates.length} mission(s) via NFT assignment...`,
      );
      let assigned = 0;
      const startedMissionNames = [];
      const startedMissionDetails = [];
      for (const mission of candidates) {
        const id = assignedMissionId(mission);
        const name = missionName(mission) || "unknown mission";
        const level = missionLevel(mission);
        const levelText = level === null ? "" : ` lvl=${level}`;
        if (!id) {
          logDebug("assign", "candidate_missing_assigned_mission_id", {
            reason,
            name,
            slot: mission?.slot ?? null,
            raw: mission,
          });
          logDebug("assign", "missing_mission_id", { name });
          continue;
        }

        let nfts = [];
        try {
          const nftResult = await mcp.mcpToolCall("get_mission_nfts", { assignedMissionId: id });
          nfts = normalizeNftList(nftResult).filter(nftIsAvailable);
          logDebug("assign", "eligible_nfts_loaded", {
            reason,
            missionName: name,
            missionId: id,
            eligibleCount: nfts.length,
          });
        } catch (error) {
          logDebug("assign", "nft_list_failed", { missionId: id, name, error: error.message });
          continue;
        }
        const assignableNfts = nfts
          .map((nft) => ({ nft, account: nftAccountId(nft) }))
          .filter((entry) => entry.account)
          .slice(0, 3);
        if (assignableNfts.length === 0) {
          logWithTimestamp(`[ASSIGN] ℹ️ No eligible NFT available for: ${name}`);
          continue;
        }

        const slot = mission?.slot ?? null;
        let missionAssigned = false;
        let lastError = null;
        logWithTimestamp(`[ASSIGN] 🚀 Starting mission: ${name}${levelText}`);
        for (let index = 0; index < assignableNfts.length; index += 1) {
          const { nft, account } = assignableNfts[index];
          try {
            logDebug("assign", "assign_call_start", {
              reason,
              missionName: name,
              missionId: id,
              slot,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignableNfts.length,
              selectedFrom: "owned",
            });
            const assignResult = await mcp.mcpToolCall("assign_nft_to_mission", {
              assignedMissionId: id,
              nftAccount: account,
            });
            logDebug("assign", "assign_call_done", {
              reason,
              missionName: name,
              missionId: id,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignableNfts.length,
              success: toolCallSucceeded(assignResult),
              selectedFrom: "owned",
              result: assignResult?.structuredContent || assignResult,
            });
            if (!toolCallSucceeded(assignResult)) {
              const message = assignFailureMessage(assignResult);
              const details = assignFailureDetails(assignResult);
              throw new Error(
                details ? `${message} details=${JSON.stringify(details)}` : message,
              );
            }
            assigned += 1;
            missionAssigned = true;
            startedMissionNames.push(name);
            startedMissionDetails.push({ name, level, slot });
            logWithTimestamp(`[ASSIGN] ✅ Started mission: ${name}${levelText}`);
            break;
          } catch (error) {
            lastError = error;
            const retryable = isRetryableActiveMissionAssignError(error.message);
            const hasNext = index + 1 < assignableNfts.length;
            logDebug("assign", "assign_failed", {
              missionName: name,
              missionId: id,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignableNfts.length,
              error: error.message,
              retryable,
              willRetry: retryable && hasNext,
              selectedNft: nft || null,
            });
            if (retryable && hasNext) {
              continue;
            }
            break;
          }
        }

        if (!missionAssigned && lastError) {
          logWithTimestamp(
            `[ASSIGN] ❌ Failed assign for ${name} (missionId=${id}): ${lastError.message}`,
          );
        }
      }

      if (assigned > 0) {
        await refreshMissionHeaderStats({ refreshNftCount: true });
        if (ctx.debugMode) {
          logWithTimestamp(
            `[ASSIGN] ✅ done: reason=${reason} attempted=${candidates.length} assigned=${assigned}`,
          );
        }
      } else if (ctx.debugMode) {
        logWithTimestamp(
          `[ASSIGN] ℹ️ done: reason=${reason} attempted=${candidates.length} assigned=0`,
        );
      }
      logDebug("assign", "auto_assign_complete", {
        reason,
        attempted: candidates.length,
        assigned,
        startedMissionNames,
        startedMissionDetails,
      });
      return { ok: true, attempted: candidates.length, assigned, startedMissionNames, startedMissionDetails };
    } finally {
      ctx.autoAssignRunning = false;
    }
  }

  async function claimClaimableMissions({
    maxClaims = 10,
    reason = "fallback",
    onlySelected = true,
    missionsResult = null,
  } = {}) {
    const limit = Math.max(1, Number(maxClaims || 10));
    try {
      const result = missionsResult || (await mcp.mcpToolCall("get_user_missions", {}));
      const missionsAll = normalizeMissionList(result);
      const missions = onlySelected ? filterSelectedMissions(missionsAll) : missionsAll;
      const candidates = missions
        .filter((m) => missionIsClaimable(m))
        .map((m) => ({
          id: assignedMissionId(m),
          name: missionName(m) || "unknown mission",
          level: missionLevel(m),
          slot: m?.slot ?? null,
        }))
        .filter((m) => m.id)
        .slice(0, limit);

      if (candidates.length === 0) return { ok: true, claimed: 0 };

      let claimed = 0;
      for (const mission of candidates) {
        try {
          const claimResult = await mcp.mcpToolCall("claim_mission_reward", {
            assignedMissionId: mission.id,
          });
          if (!toolCallSucceeded(claimResult)) {
            const message =
              claimResult?.structuredContent?.details?.message ||
              claimResult?.content?.[0]?.text ||
              "claim_mission_reward failed";
            throw new Error(message);
          }
          claimed += 1;
          const levelText = mission.level === null ? "" : ` lvl=${mission.level}`;
          const slotText = mission.slot === null ? "" : ` slot=${mission.slot}`;
          logWithTimestamp(`[WATCH] ✅ Claimed (fallback): ${mission.name}${slotText}${levelText}`);
        } catch (error) {
          const levelText = mission.level === null ? "" : ` lvl=${mission.level}`;
          const slotText = mission.slot === null ? "" : ` slot=${mission.slot}`;
          logWithTimestamp(
            `[WATCH] ❌ Claim failed (fallback) for ${mission.name}${slotText}${levelText}: ${error.message}`,
          );
          logDebug("watch", "fallback_claim_failed", {
            reason,
            missionId: mission.id,
            error: error.message,
          });
        }
      }
      return { ok: true, claimed };
    } catch (error) {
      logDebug("watch", "fallback_claim_scan_failed", { reason, error: error.message });
      return { ok: false, claimed: 0 };
    }
  }

  async function runWhoAmICheck() {
    try {
      const json = await mcp.mcpToolCall("who_am_i", {});
      const info = json?.structuredContent || {};
      const displayName = info.display_name || info.displayName || info.username || "unknown";
      const walletId = info.wallet_id || info.walletId || "unknown";
      logDebug("check", "whoami_ok", { displayName, walletId });
      return { ok: true, displayName, walletId };
    } catch (error) {
      logDebug("check", "whoami_failed", { error: error.message });
      return { ok: false, displayName: "unknown", walletId: "unknown" };
    }
  }

  async function runMcpHealthCheck() {
    try {
      const json = await mcp.mcpToolCall("mcp_health", {});
      const healthOk = json?.structuredContent?.success ?? json?.structuredContent?.ok ?? true;
      logDebug("check", "mcp_health_ok", { healthOk });
      return { ok: true, healthOk };
    } catch (error) {
      logDebug("check", "mcp_health_failed", { error: error.message });
      return { ok: false, healthOk: false };
    }
  }

  async function refreshMissionHeaderStats({ refreshNftCount = false, missionsResult = null } = {}) {
    try {
      const result = missionsResult || (await mcp.mcpToolCall("get_user_missions", {}));
      const missions = normalizeMissionList(result);
      const computed = computeMissionStats(missions, ctx.sessionClaimedCount);

      let nftCount = ctx.currentMissionStats.nfts || 0;
      let nftAvailable = ctx.currentMissionStats.nftsAvailable || 0;
      if (refreshNftCount) {
        try {
          const nftResult = await mcp.mcpToolCall("get_mission_nfts", {});
          const nfts = normalizeNftList(nftResult);
          nftCount = nfts.length;
          nftAvailable = nfts.filter(nftIsAvailable).length;
        } catch (error) {
          logDebug("check", "nft_count_failed", { error: error.message });
        }
      }

      ctx.currentMissionStats = {
        ...ctx.currentMissionStats,
        ...computed,
        nfts: nftCount,
        nftsTotal: nftCount,
        nftsAvailable: nftAvailable,
        totalClaimed: Number(ctx.config.totalClaimed || 0),
      };
      redrawHeaderAndLog(ctx.currentMissionStats);
      logDebug("check", "missions_loaded", {
        total: computed.total,
        active: computed.active,
        available: computed.available,
        claimable: computed.claimable,
        nfts: nftCount,
        nftsAvailable: nftAvailable,
        sessionClaimed: ctx.sessionClaimedCount,
      });
      return {
        ok: true,
        stats: {
          ...computed,
          nfts: nftCount,
          nftsTotal: nftCount,
          nftsAvailable: nftAvailable,
        },
      };
    } catch (error) {
      logDebug("check", "missions_failed", { error: error.message });
      return { ok: false, stats: null };
    }
  }

  async function runInitialChecks() {
    logWithTimestamp("[CHECK] ⏳ Loading data...");
    ctx.isAuthenticated = false;

    const whoami = await runWhoAmICheck();
    if (!whoami.ok) {
      logWithTimestamp("[CHECK] ❌ Loading data failed (not authenticated).");
      return false;
    }

    ctx.isAuthenticated = true;
    ctx.currentUserDisplayName = whoami.displayName || "unknown";
    ctx.currentUserWalletId = whoami.walletId || "unknown";
    await refreshMissionCatalog();
    validateConfiguredTargets();
    logSelectedWatchTargetsAtStartup();
    const health = await runMcpHealthCheck();
    const missions = await refreshMissionHeaderStats({ refreshNftCount: true });

    if (!health.ok || !missions.ok) {
      logWithTimestamp("[CHECK] ❌ Loading data failed.");
      return false;
    }

    logWithTimestamp("[CHECK] ✅ Loading data complete.");
    logWithTimestamp(
      `[INFO] 🎯 ${missions.stats.total} missions found: ${missions.stats.active} active, ${missions.stats.available} available, ${missions.stats.claimable} claimable, 💎 ${missions.stats.nftsAvailable}/${missions.stats.nftsTotal} NFT`,
    );
    return true;
  }

  return {
    runWhoAmICheck,
    refreshMissionCatalog,
    validateConfiguredTargets,
    runMcpHealthCheck,
    refreshMissionHeaderStats,
    claimClaimableMissions,
    isConfiguredTargetMission,
    filterSelectedMissions,
    logSelectedWatchTargetsAtStartup,
    autoAssignConfiguredMissions,
    runInitialChecks,
  };
}

module.exports = {
  createChecksService,
};
