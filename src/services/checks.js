// because... i wanna be teej. i wanna code. i wanna code. I wanna dance, i dont wanna go home.
"use strict";

const {
  normalizeMissionList,
  normalizeNftList,
  normalizeMissionCatalogList,
  computeMissionStats,
  missionHasAssignedNft,
  missionIsClaimable,
} = require("../missions/normalize");
const {
  missionAssignedNftAccount: sharedMissionAssignedNftAccount,
  computeGuiMissionSlots: computeGuiMissionSlotsShared,
} = require("../missions/gui-slots");
const { parseResetLevel } = require("./reset");
const {
  defaultResetPolicy,
  resetPolicyForMission,
} = require("../mission-reset-policy");
const {
  openMissionPlayPage,
  MISSION_PLAY_URL,
  MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
} = require("../mission-page");
const { createMissionActionExecutor } = require("../mission-actions");
const {
  fetchOnchainFundingWalletSummary,
} = require("../wallet/onchain-summary");
const { flushConfig } = require("../config");

function createChecksService(ctx, logger, mcp, services = {}) {
  const { logWithTimestamp, logDebug, redrawHeaderAndLog } = logger;
  const { signer = null } = services;
  const { executePreparedMissionAction } = createMissionActionExecutor(
    logger,
    mcp,
    signer,
  );
  let rentalFastRefreshTimer = null;
  let rentalFastRefreshResumeTimer = null;
  let rentalFastRefreshRunning = false;
  let rentalFastRefreshFailedListings = new Set();
  let rentalFastRefreshRequested = false;
  let rentalFastRefreshRequestMeta = null;
  let walletRefreshTimer = null;
  let walletRefreshPendingReason = null;
  let missionCatalogRefreshPromise = null;
  let ownedMissionNftsCache = null;
  let ownedMissionNftsCacheAt = 0;
  let ownedMissionNftsPromise = null;
  let rentableNftsCallChain = Promise.resolve();
  const OWNED_MISSION_NFTS_CACHE_TTL_MS = 2000;
  const MCP_COOLDOWN_RESUME_BUFFER_MS = 250;
  const RENTAL_RESET_PREPARE_DELAY_MS = 2500;

  function startupAccountSnapshot() {
    const wrapper =
      ctx.startupAccountSnapshot && typeof ctx.startupAccountSnapshot === "object"
        ? ctx.startupAccountSnapshot
        : null;
    const snapshot =
      wrapper?.snapshot && typeof wrapper.snapshot === "object"
        ? wrapper.snapshot
        : null;
    return snapshot;
  }

  function seedStartupSnapshotCaches(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const nftResult = snapshot?.nftResult || null;
    if (nftResult) {
      const nfts = normalizeNftList(nftResult);
      ownedMissionNftsCache = nfts;
      ownedMissionNftsCacheAt = Date.now();
      missionNftByAccount.clear();
      for (const nft of nfts) {
        const key = nftAccountId(nft);
        if (key) missionNftByAccount.set(key, nft);
      }
    }
  }

  function whoAmIFromSnapshot(snapshot) {
    const walletSummarySnapshot =
      snapshot?.walletSummaryResult && typeof snapshot.walletSummaryResult === "object"
        ? snapshot.walletSummaryResult
        : null;
    const parsedWalletSummary = walletSummarySnapshot
      ? parseWalletSummary(walletSummarySnapshot)
      : null;
    const walletSummaryContent = walletSummarySnapshot?.structuredContent || {};
    const info = snapshot?.who?.structuredContent || {};
    const displayName =
      walletSummaryContent.displayName ||
      walletSummaryContent.display_name ||
      info.display_name ||
      info.displayName ||
      info.username ||
      "unknown";
    const walletId =
      walletSummaryContent.walletId ||
      walletSummaryContent.wallet_id ||
      parsedWalletSummary?.address ||
      info.wallet_id ||
      info.walletId ||
      "unknown";
    if (displayName === "unknown" && walletId === "unknown") return null;
    const fallbackBalances = parseTokenBalancesArray(
      info.walletBalances || info.wallet_balances || [],
    );
    const fallbackWalletBalanceSummary = Array.isArray(info.walletBalanceSummary)
      ? info.walletBalanceSummary.slice()
      : Array.isArray(info.wallet_balance_summary)
        ? info.wallet_balance_summary.slice()
        : [];
    const walletSummary = {
      walletId,
      displayName,
      balances: mergeTokenBalanceEntries(
        parsedWalletSummary?.balances || [],
        fallbackBalances,
      ),
      walletBalanceSummary: parsedWalletSummary?.walletBalanceSummary?.length
        ? parsedWalletSummary.walletBalanceSummary
        : fallbackWalletBalanceSummary,
    };
    return { ok: true, displayName, walletId, walletSummary, fromSnapshot: true };
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

  const TARGET_UNLOCK_SLOT = 4;
  const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
  const PBP_MINT = "3f7wfg9yHLtGKvy75MmqsVT1ueTFoqyySQbusrX1YAQ4";
  const missionNftByAccount = new Map();
  const assignedNftMetadataByAccount = new Map();
  const DEFAULT_REWARD_TOTALS = {
    pbp: 0,
    tc: 0,
    cc: 0,
  };
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

  function getMcpCooldownRemainingMs() {
    const until = Number(ctx.mcpRateLimitedUntil || 0);
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }

  function hasActiveMcpCooldown() {
    return getMcpCooldownRemainingMs() > 0;
  }

  function isRateLimitError(error) {
    if (error?.rateLimited === true) return true;
    const message = String(error?.message || "");
    return /rate limited|retry in \d+s|HTTP 429/i.test(message);
  }

  function compactMissionSelection(entry) {
    if (!entry || typeof entry !== "object") return null;
    return {
      name: entry.name || null,
      assignedMissionId: entry.assignedMissionId || null,
      catalogMissionId: entry.catalogMissionId || null,
      slot: Number.isFinite(Number(entry.slot)) ? Number(entry.slot) : null,
      level: Number.isFinite(Number(entry.level)) ? Number(entry.level) : null,
      hasAssignedNft: entry.hasAssignedNft === true,
      claimable: entry.claimable === true,
      resetBlocked: entry.resetBlocked === true,
    };
  }

  function compactNftSelection(nft) {
    if (!nft || typeof nft !== "object") return null;
    return {
      account:
        nft.account ||
        nft.nftAccount ||
        nft.id ||
        nft.mint ||
        nft.address ||
        null,
      name:
        nft.name ||
        nft?.DASMetadata?.name ||
        nft?.offChainMetadata?.metadata?.name ||
        null,
      level: Number.isFinite(Number(nft.level || nft?.stats?.level))
        ? Number(nft.level || nft?.stats?.level)
        : null,
      onCooldown:
        nft.onCooldown === true ||
        Number(nft.cooldownSeconds || nft?.cooldown?.cooldown || 0) > 0,
      cooldownSeconds: Number.isFinite(
        Number(nft.cooldownSeconds || nft?.cooldown?.cooldown),
      )
        ? Number(nft.cooldownSeconds || nft?.cooldown?.cooldown)
        : null,
      rentalListingId: nft.rentalListingId || null,
      rentalLeaseId: nft.rentalLeaseId || null,
      rentalStatus: nft.rentalStatus || null,
    };
  }

  function compactAssignResultSummary(result) {
    const payload = result?.structuredContent || result || {};
    const missions = payload?.missions?.missions;
    return {
      success: toolCallSucceeded(result),
      assignedMissionId: payload.assignedMissionId || null,
      nftAccount: payload.nftAccount || null,
      missionCount: Array.isArray(missions) ? missions.length : null,
      availableSlots: payload?.missions?.slotUnlockSummary?.availableSlots ?? null,
      topLevelKeys:
        payload && typeof payload === "object"
          ? Object.keys(payload).slice(0, 8)
          : [],
    };
  }

  function compactStructuredSummary(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      topLevelKeys: Object.keys(payload).slice(0, 8),
      success:
        typeof payload.success === "boolean" ? payload.success : undefined,
      assignedMissionId: payload.assignedMissionId || null,
      nftId: payload.nftId || payload.nftAccount || payload.nftMint || null,
      leaseId: payload.leaseId || payload.rentalLeaseId || null,
      cost:
        Number.isFinite(Number(payload.resetCost ?? payload.unlockCost ?? payload.cost))
          ? Number(payload.resetCost ?? payload.unlockCost ?? payload.cost)
          : null,
      message:
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.responseMessage === "string"
            ? payload.responseMessage
            : null,
    };
  }

  function compactSlotUnlockSummary(summary) {
    if (!summary || typeof summary !== "object") return null;
    return {
      availableSlots:
        Number.isFinite(Number(summary.availableSlots))
          ? Number(summary.availableSlots)
          : null,
      totalMissionSlots:
        Number.isFinite(Number(summary.totalMissionSlots))
          ? Number(summary.totalMissionSlots)
          : null,
      remainingUnlockableSlots:
        Number.isFinite(Number(summary.remainingUnlockableSlots))
          ? Number(summary.remainingUnlockableSlots)
          : null,
      canUnlockMore: summary.canUnlockMore === true,
      nextUnlockSlot:
        Number.isFinite(Number(summary.nextUnlockSlot))
          ? Number(summary.nextUnlockSlot)
          : null,
    };
  }

  function compactMissionStateList(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => ({
      name: entry?.name || null,
      slot: Number.isFinite(Number(entry?.slot)) ? Number(entry.slot) : null,
      level: Number.isFinite(Number(entry?.level)) ? Number(entry.level) : null,
    }));
  }

  async function getRentableNftsSerialized(args = {}, meta = {}) {
    const waitForPrior = rentableNftsCallChain.catch(() => {});
    let release;
    rentableNftsCallChain = new Promise((resolve) => {
      release = resolve;
    });
    await waitForPrior;
    try {
      logDebug("assign", "rentable_nfts_call_start", {
        source: meta.source || "unknown",
        missionName: meta.missionName || null,
        missionId: meta.missionId || null,
        args,
      });
      return await mcp.mcpToolCall("get_rentable_nfts", args);
    } finally {
      release();
    }
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
      value === "tournament_coins" ||
      value === "tournament_coin"
    ) {
      return "tc";
    }
    if (
      value === "cc" ||
      value === "cc_token" ||
      value === "community_coins" ||
      value === "community_coin"
    ) {
      return "cc";
    }
    return null;
  }

  function createEmptyRewardTotals() {
    return { ...DEFAULT_REWARD_TOTALS };
  }

  function rewardFromClaimToolResult(result = {}) {
    const sc = result?.structuredContent || {};
    const directSources = [
      sc,
      sc.reward,
      sc.claim,
      sc.data,
      sc.result,
      Array.isArray(sc.rewardsClaimed) ? sc.rewardsClaimed[0] : null,
      Array.isArray(sc.claimedMissions) ? sc.claimedMissions[0] : null,
      Array.isArray(sc.claims) ? sc.claims[0] : null,
    ].filter((entry) => entry && typeof entry === "object");

    for (const source of directSources) {
      const token = normalizeRewardBucket(
        source?.rewardToken ??
          source?.reward_token ??
          source?.prize ??
          source?.prizeToken ??
          source?.currency ??
          source?.symbol ??
          source?.token ??
          null,
      );
      const rawAmount =
        source?.rewardAmount ??
        source?.reward_amount ??
        source?.prizeAmount ??
        source?.prize_amount ??
        source?.amount ??
        source?.reward ??
        source?.value ??
        null;
      let amount = Number(rawAmount);
      if (!Number.isFinite(amount) && typeof rawAmount === "string") {
        const match = rawAmount.match(/([0-9]+(?:\.[0-9]+)?)/);
        amount = match ? Number(match[1]) : NaN;
      }
      if (token && Number.isFinite(amount) && amount > 0) {
        return { token, amount };
      }
    }

    const textParts = [
      ...(Array.isArray(result?.content)
        ? result.content
            .map((entry) =>
              entry && typeof entry === "object" ? String(entry.text || "") : "",
            )
            .filter(Boolean)
        : []),
      String(sc?.details?.message || ""),
      String(sc?.message || ""),
      String(sc?.note || ""),
    ].filter(Boolean);
    for (const text of textParts) {
      const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z_]{2,20})/);
      if (!match) continue;
      const amount = Number(match[1]);
      const token = normalizeRewardBucket(match[2]);
      if (token && Number.isFinite(amount) && amount > 0) {
        return { token, amount };
      }
    }

    return { token: null, amount: 0 };
  }

  function parseTokenBalancesArray(balances = []) {
    const summary = [];
    for (const entry of Array.isArray(balances) ? balances : []) {
      if (!entry || typeof entry !== "object") continue;
      const symbol = String(
        entry.symbol ||
          entry.tokenSymbol ||
          entry.ticker ||
          entry.assetSymbol ||
          "",
      )
        .trim()
        .toUpperCase();
      const name = String(entry.name || entry.tokenName || "").trim();
      const key = normalizeRewardBucket(symbol) || normalizeRewardBucket(name);
      const balance =
        parseBalanceNumber(entry.balance) ??
        parseBalanceNumber(entry.displayBalance) ??
        parseBalanceNumber(entry.uiAmount) ??
        parseBalanceNumber(entry.ui_amount) ??
        parseBalanceNumber(entry.amount) ??
        parseBalanceNumber(entry.tokenBalance);
      summary.push({
        key: key || symbol.toLowerCase() || name.toLowerCase() || null,
        symbol: symbol || null,
        name: name || null,
        mint: String(entry.mint || entry.mintAddress || "").trim() || null,
        balance: balance === null ? null : balance,
        displayBalance:
          entry.displayBalance ?? (balance === null ? null : String(balance)),
      });
    }
    return summary;
  }

  function parseVirtualCurrencyBalances(virtualCurrencies = {}) {
    if (!virtualCurrencies) return [];
    const rows = [];
    const pushRow = ({ symbolRaw, nameRaw = null, amountRaw }) => {
      const symbol = String(symbolRaw || "")
        .trim()
        .toUpperCase();
      const key =
        normalizeRewardBucket(symbol) ||
        String(symbolRaw || "")
          .trim()
          .toLowerCase();
      const balance = parseBalanceNumber(amountRaw);
      if (!symbol || balance === null) return;
      rows.push({
        key,
        symbol,
        name: nameRaw ? String(nameRaw).trim() : symbol,
        mint: null,
        balance,
        displayBalance: balance.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        }),
      });
    };

    if (Array.isArray(virtualCurrencies)) {
      for (const entry of virtualCurrencies) {
        if (!entry || typeof entry !== "object") continue;
        pushRow({
          symbolRaw: entry.code || entry.symbol || entry.currency || entry.key,
          nameRaw: entry.name || entry.displayName || null,
          amountRaw: entry.balance ?? entry.amount ?? entry.value,
        });
      }
      return rows;
    }

    if (typeof virtualCurrencies !== "object") return [];
    for (const [symbolRaw, amountRaw] of Object.entries(virtualCurrencies)) {
      pushRow({ symbolRaw, amountRaw });
    }
    return rows;
  }

  function assignedNftLabelFromMission(mission) {
    const directLabel = String(
      mission?.currentAssignedNFT ||
        mission?.current_assigned_nft ||
        mission?.assignedNftName ||
        mission?.assigned_nft_name ||
        mission?.nftName ||
        mission?.nft_name ||
        (typeof mission?.assigned_nft === "string"
          ? mission.assigned_nft
          : "") ||
        (typeof mission?.assignedNft === "string" ? mission.assignedNft : ""),
    ).trim();
    if (directLabel) return directLabel;

    const nft =
      mission?.assigned_nft && typeof mission.assigned_nft === "object"
        ? mission.assigned_nft
        : mission?.assignedNft && typeof mission.assignedNft === "object"
          ? mission.assignedNft
          : mission?.nft && typeof mission.nft === "object"
            ? mission.nft
            : null;
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

    return missionHasAssignedNft(mission) ? "assigned" : null;
  }

  function assignedNftFromMission(mission) {
    if (!mission || typeof mission !== "object") return null;
    if (
      mission.currentAssignedNft &&
      typeof mission.currentAssignedNft === "object"
    )
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

  function assignedNftLevelFromMission(mission) {
    const nft = assignedNftFromMission(mission);
    const raw = nft?.level ?? nft?.current_level ?? nft?.nftLevel ?? null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function assignedNftImageFromMission(mission) {
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

  function missionProgressFromMission(
    mission,
    progressByAssignedMissionId = null,
  ) {
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

  function missionProgressLookupFromResult(result) {
    const map = new Map();
    const stats = result?.structuredContent?.missions?.stats;
    if (!stats || typeof stats !== "object") return map;
    for (const [assignedMissionId, value] of Object.entries(stats)) {
      const id = String(assignedMissionId || "").trim();
      if (!id) continue;
      const p = Number(
        value?.progress ?? value?.currentProgress ?? value?.current_progress,
      );
      if (Number.isFinite(p)) map.set(id, p);
    }
    return map;
  }

  function missionAssignedNftAccount(mission) {
    return sharedMissionAssignedNftAccount(mission);
  }

  function assignedNftAccountSetFromMissions(missions = []) {
    const assigned = new Set();
    for (const mission of Array.isArray(missions) ? missions : []) {
      const account = missionAssignedNftAccount(mission);
      if (account) assigned.add(account);
    }
    return assigned;
  }

  function computeGuiMissionSlots(
    missions,
    progressByAssignedMissionId = null,
  ) {
    return computeGuiMissionSlotsShared(missions, {
      progressByAssignedMissionId,
      missionNftByAccount,
      assignedNftMetadataByAccount,
    });
  }

  function nftIsAvailable(n) {
    if (
      n?.onCooldown === true ||
      n?.on_cooldown === true ||
      n?.cooldownActive === true ||
      n?.cooldown_active === true ||
      n?.nft?.onCooldown === true ||
      n?.nft?.on_cooldown === true ||
      n?.nft?.cooldownActive === true ||
      n?.nft?.cooldown_active === true
    ) {
      return false;
    }
    const cooldownSeconds = Number(
      n?.cooldownSeconds ??
        n?.cooldown_seconds ??
        n?.cooldownRemainingSeconds ??
        n?.cooldown_remaining_seconds ??
        n?.cooldownRemaining ??
        n?.cooldown_remaining ??
        n?.cooldown?.cooldown ??
        n?.cooldown?.cooldown_seconds ??
        n?.cooldown?.cooldownRemaining ??
        n?.cooldown?.cooldown_remaining ??
        n?.cooldown?.seconds ??
        n?.cooldown?.remainingSeconds ??
        n?.cooldown?.remaining_seconds ??
        n?.nft?.cooldownSeconds ??
        n?.nft?.cooldown_seconds ??
        n?.nft?.cooldownRemainingSeconds ??
        n?.nft?.cooldown_remaining_seconds ??
        n?.cooldown ??
        0,
    );
    if (Number.isFinite(cooldownSeconds) && cooldownSeconds > 0) return false;
    const endsAt =
      n?.cooldownEndsAt ??
      n?.cooldown_ends_at ??
      n?.cooldownEndAt ??
      n?.cooldown_end_at ??
      n?.cooldownEndDate ??
      n?.cooldown_end_date ??
      n?.cooldown?.cooldownEndDate ??
      n?.cooldown?.cooldown_end_date ??
      n?.cooldown?.endsAt ??
      n?.cooldown?.ends_at ??
      n?.cooldown?.endAt ??
      n?.cooldown?.end_at ??
      n?.cooldown?.endDate ??
      n?.cooldown?.end_date ??
      n?.nft?.cooldownEndsAt ??
      n?.nft?.cooldown_ends_at ??
      n?.nft?.cooldownEndAt ??
      n?.nft?.cooldown_end_at ??
      null;
    if (!endsAt) return true;
    const endsAtMs = new Date(endsAt).getTime();
    return !Number.isFinite(endsAtMs) || endsAtMs <= Date.now();
  }

  function nftCooldownSeconds(nft) {
    const raw =
      nft?.cooldownSeconds ??
      nft?.cooldown_seconds ??
      nft?.cooldownRemainingSeconds ??
      nft?.cooldown_remaining_seconds ??
      nft?.cooldownRemaining ??
      nft?.cooldown_remaining ??
      nft?.cooldown?.cooldown ??
      nft?.cooldown?.cooldown_seconds ??
      nft?.cooldown?.cooldownRemaining ??
      nft?.cooldown?.cooldown_remaining ??
      nft?.cooldown?.seconds ??
      nft?.cooldown?.remainingSeconds ??
      nft?.cooldown?.remaining_seconds ??
      nft?.nft?.cooldownSeconds ??
      nft?.nft?.cooldown_seconds ??
      nft?.nft?.cooldownRemainingSeconds ??
      nft?.nft?.cooldown_remaining_seconds ??
      nft?.cooldown ??
      0;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.max(0, n);
    const endsAt =
      nft?.cooldownEndsAt ??
      nft?.cooldown_ends_at ??
      nft?.cooldownEndAt ??
      nft?.cooldown_end_at ??
      nft?.cooldownEndDate ??
      nft?.cooldown_end_date ??
      nft?.cooldown?.cooldownEndDate ??
      nft?.cooldown?.cooldown_end_date ??
      nft?.cooldown?.endsAt ??
      nft?.cooldown?.ends_at ??
      nft?.cooldown?.endAt ??
      nft?.cooldown?.end_at ??
      nft?.cooldown?.endDate ??
      nft?.cooldown?.end_date ??
      nft?.nft?.cooldownEndsAt ??
      nft?.nft?.cooldown_ends_at ??
      nft?.nft?.cooldownEndAt ??
      nft?.nft?.cooldown_end_at ??
      null;
    if (!endsAt) return 0;
    const endsAtMs = new Date(endsAt).getTime();
    if (!Number.isFinite(endsAtMs)) return 0;
    return Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
  }

  function timingMs(startedAt) {
    const elapsed = Date.now() - Number(startedAt || 0);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
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

  function updateMissionLookupCache(result, missions) {
    const nextLookup = {
      ...(ctx.lastAssignedMissionLookup &&
      typeof ctx.lastAssignedMissionLookup === "object"
        ? ctx.lastAssignedMissionLookup
        : {}),
    };
    let changed = false;
    for (const mission of Array.isArray(missions) ? missions : []) {
      const assignedMissionId = String(
        mission?.assignedMissionId || mission?.assigned_mission_id || "",
      ).trim();
      if (!assignedMissionId) continue;
      const nextEntry = {
        name: missionName(mission) || null,
        slot: Number.isFinite(Number(mission?.slot)) ? Number(mission.slot) : null,
        level: Number.isFinite(Number(mission?.current_level ?? mission?.level))
          ? Number(mission?.current_level ?? mission?.level)
          : null,
        reward:
          mission?.prize_amount ??
          mission?.prizeAmount ??
          mission?.rewardAmount ??
          mission?.reward_amount ??
          null,
        prize: mission?.prize ?? mission?.prizeToken ?? mission?.rewardToken ?? null,
      };
      const previous = nextLookup[assignedMissionId];
      if (
        !previous ||
        previous.name !== nextEntry.name ||
        previous.slot !== nextEntry.slot ||
        previous.level !== nextEntry.level ||
        previous.reward !== nextEntry.reward ||
        previous.prize !== nextEntry.prize
      ) {
        nextLookup[assignedMissionId] = nextEntry;
        changed = true;
      }
    }
    ctx.lastUserMissionsResult = result;
    ctx.lastUserMissionsFetchedAt = Date.now();
    if (changed || !ctx.lastAssignedMissionLookup) {
      ctx.lastAssignedMissionLookup = nextLookup;
    }
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
      nft?.account ||
      nft?.nftAccount ||
      nft?.nft_account ||
      nft?.tokenAddress ||
      nft?.token_address ||
      nft?.mintAddress ||
      nft?.mint_address ||
      nft?.id;
    return isUsableIdValue(id) ? id.trim() : null;
  }

  function nftDisplayName(nft) {
    return String(
      nft?.name ||
        nft?.nftName ||
        nft?.symbol ||
        nft?.collection ||
        "unknown nft",
    ).trim();
  }

  function nftCollectionText(nft) {
    const values = [
      nft?.collection,
      nft?.collectionName,
      nft?.collection_name,
      nft?.collectionSymbol,
      nft?.collection_symbol,
      nft?.symbol,
      nft?.metadata?.collection,
      nft?.metadata?.collectionName,
      nft?.metadata?.collection_name,
      nft?.DASMetadata?.collection,
      nft?.DASMetadata?.collectionName,
      nft?.offChainMetadata?.metadata?.collection,
      nft?.offChainMetadata?.metadata?.collectionName,
    ];
    return values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");
  }

  function isLevel20ReservedCollectionNft(nft) {
    const text = `${nftCollectionText(nft)} ${nftDisplayName(nft)}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");
    return /\b100k\b/.test(text) || /\b500k\b/.test(text);
  }

  function shouldReserveLevel20CollectionNfts() {
    const resetPolicy = getResetPolicy();
    if (!resetPolicy.enabled) return true;
    const threshold = Number(resetPolicy.threshold);
    return !Number.isFinite(threshold) || threshold > 20;
  }

  function ownedCandidateReservePriority(entry, mission) {
    const reserveLevel20Collections = shouldReserveLevel20CollectionNfts();
    if (!reserveLevel20Collections) return 0;
    const level = Number(missionLevel(mission));
    const level20Mission = Number.isFinite(level) && level >= 20;
    const reserved = isLevel20ReservedCollectionNft(entry.nft);
    if (level20Mission) return reserved ? 0 : 1;
    return reserved ? 1 : 0;
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

  function extractSlotUnlockSummary(result) {
    const sc = result?.structuredContent || {};
    return sc.slotUnlockSummary || sc?.missions?.slotUnlockSummary || null;
  }

  function normalizeSlotUnlockSummary(result) {
    const summary = extractSlotUnlockSummary(result);
    if (!summary || typeof summary !== "object") return null;
    const canUnlockMore = summary.canUnlockMore === true;
    const nextUnlockSlotRaw = Number(summary.nextUnlockSlot);
    const nextUnlockSlot =
      Number.isFinite(nextUnlockSlotRaw) && nextUnlockSlotRaw > 0
        ? Math.floor(nextUnlockSlotRaw)
        : null;
    const unlockCostRaw = Number(
      summary.unlockCost ?? summary.cost ?? summary.price ?? null,
    );
    const unlockCost =
      Number.isFinite(unlockCostRaw) && unlockCostRaw > 0
        ? unlockCostRaw
        : 2500;
    return {
      canUnlockMore,
      nextUnlockSlot,
      unlockCost,
      raw: summary,
    };
  }

  function isRetryableActiveMissionAssignError(message = "") {
    return /NFT is already in an active mission/i.test(String(message || ""));
  }

  function rentalListingId(entry) {
    const id =
      entry?.rentalListingId ||
      entry?.listingId ||
      entry?.listing_id ||
      entry?.id;
    return isUsableIdValue(id) ? String(id).trim() : null;
  }

  function normalizeRentableList(result) {
    const sc = result?.structuredContent || {};
    if (Array.isArray(sc?.data)) return sc.data;
    if (Array.isArray(sc?.nfts)) return sc.nfts;
    if (Array.isArray(sc?.items)) return sc.items;
    return [];
  }

  function rentalNftAccountId(entry) {
    const nested = nftAccountId(entry?.nft || entry?.nftData || null);
    if (nested) return nested;
    const direct =
      entry?.nftAccount ||
      entry?.nft_account ||
      entry?.tokenAddress ||
      entry?.token_address ||
      entry?.mintAddress ||
      entry?.mint_address ||
      entry?.account ||
      entry?.id;
    return isUsableIdValue(direct) ? String(direct).trim() : null;
  }

  function normalizeRentalCandidates(entries, { limit = rentalBatchLimit() } = {}) {
    const seen = new Set();
    const normalized = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        listingId: entry?.listingId || rentalListingId(entry),
        account: rentalNftAccountId(entry),
        nft: entry?.nft || entry,
      }))
      .filter((entry) => entry.listingId)
      .filter((entry) => {
        const key = String(entry.listingId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const safeLimit = Number(limit);
    return Number.isFinite(safeLimit) && safeLimit > 0
      ? normalized.slice(0, Math.floor(safeLimit))
      : normalized;
  }

  function autoNftCooldownResetEnabled() {
    return (
      ctx.debugMode === true &&
      (ctx.missionModeEnabled === true ||
        ctx.config?.missionModeEnabled === true) &&
      (ctx.nftCooldownResetEnabled === true ||
        ctx.config?.nftCooldownResetEnabled === true)
    );
  }

  async function loadOwnedMissionNfts({ forceFresh = false } = {}) {
    const cacheFresh =
      !forceFresh &&
      ownedMissionNftsCache &&
      Date.now() - ownedMissionNftsCacheAt <= OWNED_MISSION_NFTS_CACHE_TTL_MS;
    if (cacheFresh) {
      logDebug("check", "owned_mission_nfts_cache_hit", {
        count: ownedMissionNftsCache.length,
        ageMs: Date.now() - ownedMissionNftsCacheAt,
      });
      return ownedMissionNftsCache.slice();
    }
    if (!forceFresh && ownedMissionNftsPromise) {
      logDebug("check", "owned_mission_nfts_cache_wait", {});
      const pending = await ownedMissionNftsPromise;
      return pending.slice();
    }
    ownedMissionNftsPromise = (async () => {
      const nftResult = await mcp.mcpToolCall("get_mission_nfts", {});
      const nfts = normalizeNftList(nftResult);
      ownedMissionNftsCache = nfts;
      ownedMissionNftsCacheAt = Date.now();
      return nfts;
    })();
    try {
      const loaded = await ownedMissionNftsPromise;
      return loaded.slice();
    } finally {
      ownedMissionNftsPromise = null;
    }
  }

  function autoNftCooldownResetMaxPbp() {
    const raw = Number(ctx.config?.nftCooldownResetMaxPbp);
    return Number.isFinite(raw) && raw >= 0 ? raw : 20;
  }

  function uiNftCooldownResetMaxPbp() {
    const raw = Number(ctx.signerConfig?.maxActionCost?.nft_cooldown_reset);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
  }

  function autoNftCooldownResetProbeLimit() {
    const raw = Number(ctx.config?.nftCooldownResetProbeLimit);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  }

  function rentalBatchLimit() {
    const fallback = 2;
    const raw = Number(ctx.runtimeDefaults?.rentalBatchLimit || fallback);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  }

  function rentalFastRefreshEnabled() {
    return (
      ctx.debugMode === true ||
      ctx.config?.debugMode === true ||
      ctx.config?.rentalFastRefreshEnabled === true
    );
  }
  // tick
  function rentalFastRefreshTickMs() {
    const minMs = ctx.runtimeDefaults?.rentalFastRefreshTickMs || 15000;
    const raw = Number(ctx.config?.rentalFastRefreshTickMs);
    return Number.isFinite(raw) && raw > 0
      ? Math.max(minMs, Math.floor(raw))
      : minMs;
  }

  function stopRentalFastRefresh(reason = "stop") {
    if (rentalFastRefreshResumeTimer) {
      clearTimeout(rentalFastRefreshResumeTimer);
      rentalFastRefreshResumeTimer = null;
    }
    rentalFastRefreshRequested = false;
    rentalFastRefreshRequestMeta = null;
    if (!rentalFastRefreshTimer) return;
    clearInterval(rentalFastRefreshTimer);
    rentalFastRefreshTimer = null;
    rentalFastRefreshRunning = false;
    rentalFastRefreshFailedListings = new Set();
    const reasonLabel =
      reason === "assigned"
        ? "mission assigned"
        : reason === "no_unassigned_target"
          ? "no open target"
          : reason === "disabled"
            ? "disabled"
            : reason === "watch_stopped"
              ? "watch stopped"
              : reason;
    logWithTimestamp(`[RENTAL] ⏹️ Fast refresh stopped (${reasonLabel}).`);
      logDebug("assign", "⏹️ rental_fast_refresh_stopped", { reason });
  }

  function requestRentalFastRefresh({
    reason = "no_rentables",
    missionName = null,
  } = {}) {
    rentalFastRefreshRequested = true;
    rentalFastRefreshRequestMeta = { reason, missionName };
    if (ctx.autoAssignRunning) {
      logDebug("assign", "⏳ rental_fast_refresh_requested_pending_assign", {
        reason,
        missionName,
      });
      return;
    }
    startRentalFastRefresh({ reason, missionName });
  }

  function flushRequestedRentalFastRefresh() {
    if (!rentalFastRefreshRequested || ctx.autoAssignRunning) return;
    const meta = rentalFastRefreshRequestMeta || {};
    rentalFastRefreshRequested = false;
    rentalFastRefreshRequestMeta = null;
    startRentalFastRefresh({
      reason: meta.reason || "no_rentables",
      missionName: meta.missionName || null,
    });
  }

  function startRentalFastRefresh({
    reason = "no_rentables",
    missionName = null,
  } = {}) {
    if (rentalFastRefreshResumeTimer) {
      clearTimeout(rentalFastRefreshResumeTimer);
      rentalFastRefreshResumeTimer = null;
    }
    if (!rentalFastRefreshEnabled()) {
      logWithTimestamp("[RENTAL] ⏭️ Fast refresh not armed (disabled).");
      return;
    }
    if (!ctx.watchLoopEnabled || !ctx.watcherRunning) {
      logWithTimestamp(
        "[RENTAL] ⏭️ Fast refresh not armed (watch is not running).",
      );
      return;
    }
    if (rentalFastRefreshTimer) {
      logWithTimestamp("[RENTAL] ℹ️ Fast refresh already running.");
      return;
    }

    const tickMs = rentalFastRefreshTickMs();
    logWithTimestamp(
      `[RENTAL] ⏱️ Fast refresh armed: checking rentals every ${tickMs}ms.`,
    );
    logDebug("assign", "🚀 rental_fast_refresh_started", {
      reason,
      missionName,
      tickMs,
    });

    const runRentalFastRefreshTick = async () => {
      if (rentalFastRefreshRunning) return;
      if (ctx.autoAssignRunning) {
        logDebug("assign", "⏸️ rental_fast_refresh_skipped_assign_in_progress", {
          reason,
          missionName,
        });
        return;
      }
      if (hasActiveMcpCooldown()) {
        const retryAfterMs = getMcpCooldownRemainingMs();
        logDebug("assign", "⏳ rental_fast_refresh_skipped_rate_limited", {
          retryAfterMs,
          reason,
          missionName,
        });
        if (rentalFastRefreshTimer) {
          clearInterval(rentalFastRefreshTimer);
          rentalFastRefreshTimer = null;
        }
        if (!rentalFastRefreshResumeTimer) {
          logWithTimestamp(
            `[RENTAL] ⏳ Fast refresh paused for ${Math.ceil(retryAfterMs / 1000)}s due to MCP cooldown.`,
          );
          rentalFastRefreshResumeTimer = setTimeout(() => {
            rentalFastRefreshResumeTimer = null;
            requestRentalFastRefresh({ reason, missionName });
          }, Math.max(250, retryAfterMs + MCP_COOLDOWN_RESUME_BUFFER_MS));
        }
        return;
      }
      if (!rentalFastRefreshEnabled()) {
        stopRentalFastRefresh("disabled");
        return;
      }
      if (!ctx.watchLoopEnabled || !ctx.watcherRunning) {
        stopRentalFastRefresh("watch_stopped");
        return;
      }
      rentalFastRefreshRunning = true;
      try {
        const rentableResult = await getRentableNftsSerialized(
          {},
          {
            source: "fast_refresh_tick",
            missionName,
          },
        );
        const rentableCandidates = normalizeRentalCandidates(
          normalizeRentableList(rentableResult),
        ).filter(
          (entry) =>
            !rentalFastRefreshFailedListings.has(String(entry.listingId)),
        );
        logDebug("assign", "rental_fast_refresh_tick", {
          count: rentableCandidates.length,
        });
        logWithTimestamp(
          `[RENTAL] 🔎 Fast refresh: found ${rentableCandidates.length} rentable candidate(s).`,
        );
        if (rentableCandidates.length === 0) return;

        logWithTimestamp(
          `[RENTAL] ⚡ Fast refresh found ${rentableCandidates.length} rentable candidate(s); assigning now...`,
        );
        const assignResult = await autoAssignConfiguredMissions({
          reason: "rental_fast_refresh",
          prefetchedRentalCandidates: rentableCandidates,
        });
        const attempted = Number(assignResult?.attempted || 0);
        const assigned = Number(assignResult?.assigned || 0);
        const skipped = assignResult?.skipped === true;
        if (!skipped) {
          if (attempted === 0) {
            stopRentalFastRefresh("no_unassigned_target");
          } else if (assigned > 0 && assigned >= attempted) {
            stopRentalFastRefresh("assigned");
          }
        }
      } catch (error) {
        logDebug("assign", "❌ rental_fast_refresh_failed", {
          error: error.message,
          stack: error.stack,
        });
        logWithTimestamp(`[RENTAL] ❌ Fast refresh failed: ${error.message}`);
      } finally {
        rentalFastRefreshRunning = false;
      }
    };

    rentalFastRefreshTimer = setInterval(runRentalFastRefreshTick, tickMs);
    runRentalFastRefreshTick();
  }

  async function countAvailableOwnedNftsForAssignments() {
    try {
      const allNfts = await loadOwnedMissionNfts();
      return allNfts
        .map((nft) => ({ nft, account: nftAccountId(nft) }))
        .filter((entry) => entry.account)
        .filter((entry) => nftIsAvailable(entry.nft)).length;
    } catch (error) {
      logDebug("assign", "owned_nft_availability_check_failed", {
        error: error.message,
      });
      return null;
    }
  }

  function parseBalanceNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function extractTokenBalance(entries, matcher) {
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      const symbol = String(
        entry?.symbol ||
          entry?.tokenSymbol ||
          entry?.ticker ||
          entry?.assetSymbol ||
          "",
      )
        .trim()
        .toUpperCase();
      const mint = String(entry?.mint || entry?.mintAddress || "").trim();
      const name = String(entry?.name || entry?.tokenName || "")
        .trim()
        .toUpperCase();
      if (!matcher({ symbol, mint, name, entry })) continue;
      const direct =
        parseBalanceNumber(entry?.uiAmount) ??
        parseBalanceNumber(entry?.ui_amount) ??
        parseBalanceNumber(entry?.balance) ??
        parseBalanceNumber(entry?.amount) ??
        parseBalanceNumber(entry?.tokenBalance);
      if (direct !== null) return direct;
      const nested =
        parseBalanceNumber(entry?.amounts?.ui) ??
        parseBalanceNumber(entry?.amounts?.balance);
      if (nested !== null) return nested;
    }
    return null;
  }

  function parseWalletSummary(result, expectedAddress = "") {
    const sc = result?.structuredContent || {};
    const summary =
      sc.walletSummary || sc.summary || sc.wallet || sc.data || sc;
    const balances =
      summary?.tokenBalances ||
      summary?.balances ||
      summary?.tokens ||
      summary?.assets ||
      sc?.tokenBalances ||
      sc?.balances ||
      [];
    const virtualCurrencies =
      summary?.virtualCurrencies ||
      summary?.virtual_currencies ||
      sc?.virtualCurrencies ||
      sc?.virtual_currencies ||
      {};
    const walletAddress =
      summary?.walletAddress ||
      summary?.wallet_address ||
      summary?.address ||
      summary?.walletId ||
      summary?.wallet_id ||
      expectedAddress ||
      "";
    const sol =
      parseBalanceNumber(summary?.solBalance) ??
      parseBalanceNumber(summary?.sol_balance) ??
      parseBalanceNumber(summary?.sol) ??
      extractTokenBalance(
        balances,
        ({ symbol, name }) => symbol === "SOL" || name === "SOL",
      );
    const pbp = extractTokenBalance(
      balances,
      ({ symbol, name }) => symbol === "PBP" || name === "PBP",
    );
    return {
      address: walletAddress,
      sol,
      pbp,
      balances: mergeTokenBalanceEntries(
        parseTokenBalancesArray(balances),
        parseVirtualCurrencyBalances(virtualCurrencies),
      ),
      walletBalanceSummary: Array.isArray(summary?.walletBalanceSummary)
        ? summary.walletBalanceSummary.slice()
        : Array.isArray(summary?.wallet_balance_summary)
          ? summary.wallet_balance_summary.slice()
          : Array.isArray(sc?.walletBalanceSummary)
            ? sc.walletBalanceSummary.slice()
            : Array.isArray(sc?.wallet_balance_summary)
              ? sc.wallet_balance_summary.slice()
              : [],
    };
  }

  function ensureSessionSpendTotals() {
    if (!ctx.sessionSpendTotals || typeof ctx.sessionSpendTotals !== "object") {
      ctx.sessionSpendTotals = createEmptyRewardTotals();
    }
    for (const key of Object.keys(DEFAULT_REWARD_TOTALS)) {
      if (typeof ctx.sessionSpendTotals[key] !== "number") {
        ctx.sessionSpendTotals[key] = 0;
      }
    }
    return ctx.sessionSpendTotals;
  }

  function ensureSessionRewardTotals() {
    if (
      !ctx.sessionRewardTotals ||
      typeof ctx.sessionRewardTotals !== "object"
    ) {
      ctx.sessionRewardTotals = createEmptyRewardTotals();
    }
    for (const key of Object.keys(DEFAULT_REWARD_TOTALS)) {
      if (typeof ctx.sessionRewardTotals[key] !== "number") {
        ctx.sessionRewardTotals[key] = 0;
      }
    }
    return ctx.sessionRewardTotals;
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
      logDebug("check", "session_reward_totals_updated", {
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

  function addSessionSpendTotals(
    cost,
    { actionName = "prepared_action" } = {},
  ) {
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const totals = ensureSessionSpendTotals();
    totals.pbp += amount;
    logDebug("check", "session_spend_totals_updated", {
      actionName,
      cost: amount,
      totals: { ...totals },
    });
    if (ctx.guiBridge?.sendEvent) {
      ctx.guiBridge.sendEvent("stats_spend", {
        source: "checks",
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

  function scheduleFundingWalletRefresh(reason = "token_change") {
    if (ctx.signerMode !== "app_wallet") return;
    walletRefreshPendingReason = reason;
    if (walletRefreshTimer) return;
    walletRefreshTimer = setTimeout(() => {
      walletRefreshTimer = null;
      const pending = walletRefreshPendingReason || "token_change";
      walletRefreshPendingReason = null;
      refreshFundingWalletSummary().catch((error) =>
        logDebug("check", "funding_wallet_refresh_failed", {
          reason: pending,
          error: error.message,
        }),
      );
    }, 250);
  }

  function mergeTokenBalanceEntries(primary = [], fallback = []) {
    const merged = new Map();
    const upsert = (entry) => {
      if (!entry || typeof entry !== "object") return;
      const key = String(entry.key || entry.symbol || entry.name || "")
        .trim()
        .toLowerCase();
      if (!key) return;
      const existing = merged.get(key) || {};
      merged.set(key, {
        ...existing,
        ...entry,
        balance:
          entry.balance ?? existing.balance ?? existing.displayBalance ?? null,
        displayBalance:
          entry.displayBalance ??
          existing.displayBalance ??
          existing.balance ??
          null,
      });
    };
    for (const entry of Array.isArray(fallback) ? fallback : []) upsert(entry);
    for (const entry of Array.isArray(primary) ? primary : []) upsert(entry);
    return Array.from(merged.values());
  }

  async function fetchCurrentWalletSummary(walletAddress = "") {
    const attempts = [
      {},
      walletAddress ? { walletAddress } : null,
      walletAddress ? { wallet: walletAddress } : null,
    ].filter(Boolean);
    let lastError = null;
    for (const args of attempts) {
      try {
        return await mcp.mcpToolCall("get_wallet_summary", args);
      } catch (error) {
        lastError = error;
        logDebug("check", "current_wallet_summary_attempt_failed", {
          walletAddress,
          argsKeys: Object.keys(args),
          error: error.message,
        });
      }
    }
    if (lastError) {
      logDebug("check", "current_wallet_summary_failed", {
        walletAddress,
        error: lastError.message,
      });
    }
    return null;
  }

  async function fetchOnchainWalletSummary(walletAddress) {
    return await fetchOnchainFundingWalletSummary(walletAddress);
  }

  async function refreshFundingWalletSummary() {
    const walletAddress = String(ctx.signerConfig?.walletAddress || "").trim();
    try {
      if (!walletAddress) {
        // If we previously had a valid summary, keep it instead of flickering.
        ctx.fundingWalletSummary =
          ctx.fundingWalletSummary?.status === "ok"
            ? ctx.fundingWalletSummary
            : null;
        redrawHeaderAndLog(ctx.currentMissionStats);
        return { ok: true, skipped: true, summary: null };
      }
      // Always use on-chain lookup for the generated funding wallet address.
      // MCP get_wallet_summary is identity-based and won't return arbitrary addresses.
      ctx.fundingWalletSummary = await fetchOnchainWalletSummary(walletAddress);
      redrawHeaderAndLog(ctx.currentMissionStats);
      logDebug(
        "check",
        "funding_wallet_summary_rpc_ok",
        ctx.fundingWalletSummary,
      );
      return { ok: true, skipped: false, summary: ctx.fundingWalletSummary };
    } catch (rpcError) {
      const previous = ctx.fundingWalletSummary;
      const keepPrevious =
        previous &&
        typeof previous === "object" &&
        previous.status === "ok" &&
        String(previous.address || "").trim() === walletAddress;
      if (!keepPrevious) {
        ctx.fundingWalletSummary = walletAddress
          ? {
              address: walletAddress,
              sol: null,
              pbp: null,
              status: "error",
              source: "rpc",
            }
          : null;
        redrawHeaderAndLog(ctx.currentMissionStats);
      }
      logDebug("check", "funding_wallet_summary_failed", {
        walletAddress,
        error: rpcError.message,
        keptPrevious: keepPrevious ? "yes" : "no",
      });
      return {
        ok: false,
        skipped: false,
        summary: keepPrevious ? previous : ctx.fundingWalletSummary,
      };
    }
  }

  async function tryResetCooldownNft({
    reason,
    missionName,
    missionId,
    nft,
    maxPbp = null,
    source = "owned",
  }) {
    const nftId = nftAccountId(nft);
    const nftName = nftDisplayName(nft);
    const cooldownSeconds = nftCooldownSeconds(nft);
    const maxCost =
      Number.isFinite(Number(maxPbp)) && Number(maxPbp) >= 0
        ? Number(maxPbp)
        : null;
    logDebug("assign", "cooldown_reset_check", {
      reason,
      missionName,
      missionId,
      nftId,
      nftName,
      cooldownSeconds,
      source,
      maxPbp: maxCost,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      signerReady: ctx.signerReady,
      signerLocked: ctx.signerLocked,
    });
    if (!nftId) {
      logDebug("assign", "cooldown_reset_skipped_missing_nft_id", {
        reason,
        missionName,
        missionId,
        nft: nft || null,
      });
      return {
        ok: false,
        attempted: false,
        reset: false,
        reason: "missing_nft_id",
      };
    }
    if (ctx.signerMode === "manual") {
      logWithTimestamp(
        `[RESET] 🌐 Manual mode: open the missions page and reset cooldown yourself for ${missionName}.`,
      );
      const openResult = await openMissionPlayPage({
        cooldownMs: missionPageCooldownMs(),
      });
      if (openResult?.suppressed) {
        logDebug("assign", "mission_page_open_suppressed", {
          reason: "cooldown_reset_manual",
          cooldownMs:
            openResult?.cooldownMs ?? MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
          nextAllowedInMs: openResult?.nextAllowedInMs ?? null,
        });
      }
      if (!openResult?.ok) {
        logWithTimestamp(
          `[RESET] ❌ Failed to auto-open browser. Open manually: ${MISSION_PLAY_URL}`,
        );
      }
      return { ok: true, attempted: true, reset: false, reason: "manual_mode" };
    }
    if (!signer) {
      logWithTimestamp(
        `[RESET] ⏸️ Cooldown reset unavailable for ${missionName}: signer service missing.`,
      );
      return {
        ok: false,
        attempted: false,
        reset: false,
        reason: "missing_signer",
      };
    }

    try {
      signer.ensureMissionActionSupported("nft_cooldown_reset");
    } catch (error) {
      logWithTimestamp(
        `[RESET] ⏸️ Cooldown reset unavailable for ${missionName}: ${error.message}`,
      );
      logDebug("assign", "cooldown_reset_blocked", {
        reason,
        missionName,
        missionId,
        nftId,
        error: error.message,
      });
      return {
        ok: false,
        attempted: false,
        reset: false,
        reason: "signer_blocked",
      };
    }

    logWithTimestamp(
      `[RESET] 🚀 Attempting cooldown reset: ${missionName} nft=${nftName} cooldown=${cooldownSeconds}s`,
    );
    const resetStartedAt = Date.now();

    try {
      if (source === "rental") {
        logWithTimestamp(
          `[RESET] ⏳ Waiting ${Math.ceil(RENTAL_RESET_PREPARE_DELAY_MS / 1000)}s before rental cooldown reset prepare for ${missionName}.`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, RENTAL_RESET_PREPARE_DELAY_MS),
        );
      }
      logWithTimestamp(
        `[RESET] 🔎 Preparing cooldown reset tx: mission=${missionName} missionId=${missionId} nft=${nftId}`,
      );
      const prepareStartedAt = Date.now();
      logDebug("assign", "cooldown_reset_prepare_start", {
        reason,
        missionName,
        missionId,
        nftId,
        cooldownSeconds,
        source,
        maxPbp: maxCost,
      });
      const resetArgs = {
        nftId,
        ...preparedActionSigningArgs(),
      };
      logDebug("assign", "cooldown_reset_prepare_args", {
        reason,
        missionName,
        missionId,
        nftId,
        signerMode: ctx.signerMode,
        args: resetArgs,
      });
      const prepared = await mcp.mcpToolCall(
        "prepare_nft_cooldown_reset",
        resetArgs,
      );
      logWithTimestamp(
        `[TIMING] reset prepare ${source} ${missionName}: ${timingMs(prepareStartedAt)}ms`,
      );
      const resetCost = Number(prepared?.structuredContent?.resetCost);
      if (maxCost !== null && !Number.isFinite(resetCost)) {
        logWithTimestamp(
          `[RESET] ⏭️ Cooldown reset skipped: ${missionName} nft=${nftName} cost=unknown PBP, max=${maxCost} PBP.`,
        );
        logDebug("assign", "cooldown_reset_cost_unknown", {
          reason,
          missionName,
          missionId,
          nftId,
          nftName,
          source,
          maxPbp: maxCost,
          prepared: compactStructuredSummary(prepared?.structuredContent || prepared),
        });
        return {
          ok: false,
          attempted: true,
          reset: false,
          reason: "unknown_cost",
          resetCost: null,
          maxPbp: maxCost,
        };
      }
      if (
        maxCost !== null &&
        Number.isFinite(resetCost) &&
        resetCost > maxCost
      ) {
        logWithTimestamp(
          `[RESET] ⏭️ Cooldown reset skipped: ${missionName} nft=${nftName} cost=${resetCost} PBP > max=${maxCost} PBP.`,
        );
        logDebug("assign", "cooldown_reset_cost_exceeds_max", {
          reason,
          missionName,
          missionId,
          nftId,
          nftName,
          source,
          resetCost,
          maxPbp: maxCost,
        });
        return {
          ok: false,
          attempted: true,
          reset: false,
          reason: "cost_exceeds_max",
          resetCost,
          maxPbp: maxCost,
        };
      }
      logWithTimestamp(
        `[RESET] 🧾 Prepared cooldown reset tx for ${missionName}; cost=${Number.isFinite(resetCost) ? resetCost : "unknown"} PBP, moving to sign and submit.`,
      );
      const submitStartedAt = Date.now();
      const actionResult = await executePreparedMissionAction({
        actionName: "nft_cooldown_reset",
        prepareResult: prepared,
        expected: { nftId },
        debugScope: "assign",
        submitDebugAction: "cooldown_reset_submit",
        debugMeta: {
          reason,
          missionName,
          missionId,
          nftId,
          cooldownSeconds,
          source,
          resetCost: Number.isFinite(resetCost) ? resetCost : null,
          maxPbp: maxCost,
        },
      });
      if (actionResult?.submitted) {
        addSessionSpendTotals(actionResult?.signed?.cost ?? resetCost, {
          actionName: "cooldown_reset",
        });
        scheduleFundingWalletRefresh("cooldown_reset");
      }
      if (usesBrowserBridgeSigning() && !actionResult?.submitted) {
        const signingUrl =
          actionResult?.signed?.signingUrl || browserBridgeUrlFromPrepared(prepared);
        return {
          ok: true,
          attempted: true,
          reset: false,
          pending: true,
          reason: "browser_signing_required",
          nftId,
          signingUrl,
          bridgeUrl: signingUrl,
        };
      }
      logWithTimestamp(
        `[TIMING] reset submit ${source} ${missionName}: ${timingMs(submitStartedAt)}ms`,
      );
      logWithTimestamp(
        `[RESET] ✅ Cooldown reset complete: ${missionName} nft=${nftName}`,
      );
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("stats_reset", {
          source: "cooldown_reset",
          at: Date.now(),
          resetType: "nft",
          resetSource: source,
          missionName,
          nftName,
          nftId,
        });
      }
      logWithTimestamp(
        `[TIMING] reset total ${source} ${missionName}: ${timingMs(resetStartedAt)}ms`,
      );
      logDebug("assign", "cooldown_reset_ok", {
        reason,
        missionName,
        missionId,
        nftId,
        cooldownSeconds,
      });
      return { ok: true, attempted: true, reset: true, nftId };
    } catch (error) {
      const failureMessage = String(error?.message || "cooldown reset failed");
      logWithTimestamp(
        `[RESET] ❌ Cooldown reset failed for ${missionName} nft=${nftName}: ${failureMessage}`,
      );
      logDebug("assign", "❌ cooldown_reset_failed", {
        reason,
        missionName,
        missionId,
        nftId,
        error: failureMessage,
      });
      return {
        ok: false,
        attempted: true,
        reset: false,
        reason: "reset_failed",
        error: failureMessage,
      };
    }
  }

  async function prepareCooldownResetNftFromUi({
    nft,
    nftId = null,
    nftName = null,
    cooldownSeconds = null,
  } = {}) {
    const targetNft =
      nft && typeof nft === "object"
        ? nft
        : {
            nftAccount: nftId,
            account: nftId,
            name: nftName || "NFT",
            cooldownSeconds,
          };
    const resolvedNftId = nftAccountId(targetNft);
    if (!resolvedNftId) {
      return { ok: false, ready: false, reason: "missing_nft_id" };
    }
    if (ctx.signerMode === "manual") {
      return {
        ok: true,
        ready: true,
        reason: "manual_mode",
        nftId: resolvedNftId,
        nftName: nftDisplayName(targetNft),
        cooldownSeconds: nftCooldownSeconds(targetNft),
        resetCost: null,
        signingMode: "manual_page",
        signingUrl: MISSION_PLAY_URL,
        bridgeUrl: MISSION_PLAY_URL,
        manualUrl: MISSION_PLAY_URL,
      };
    }
    if (!signer) {
      return { ok: false, ready: false, reason: "missing_signer" };
    }
    signer.ensureMissionActionSupported("nft_cooldown_reset");
    const resetArgs = {
      nftId: resolvedNftId,
      ...preparedActionSigningArgs(),
    };
    const prepared = await mcp.mcpToolCall(
      "prepare_nft_cooldown_reset",
      resetArgs,
    );
    if (!toolCallSucceeded(prepared)) {
      return {
        ok: false,
        ready: false,
        reason:
          prepared?.structuredContent?.details?.message ||
          prepared?.content?.[0]?.text ||
          "prepare_failed",
        prepare: prepared,
      };
    }
    const resetCost = Number(prepared?.structuredContent?.resetCost);
    const signingUrl = usesBrowserBridgeSigning()
      ? browserBridgeUrlFromPrepared(prepared)
      : null;
    if (usesBrowserBridgeSigning() && !signingUrl) {
      logDebug("assign", "cooldown_reset_browser_url_missing", {
        nftId: resolvedNftId,
        signerMode: ctx.signerMode,
        structuredContent: compactStructuredSummary(prepared?.structuredContent),
        contentCount: Array.isArray(prepared?.content) ? prepared.content.length : 0,
      });
      return {
        ok: true,
        ready: true,
        reason: "missing_browser_signing_url",
        nftId: resolvedNftId,
        nftName: nftDisplayName(targetNft),
        cooldownSeconds: nftCooldownSeconds(targetNft),
        resetCost: Number.isFinite(resetCost) ? resetCost : null,
        signingMode: "manual_page",
        signingUrl: MISSION_PLAY_URL,
        bridgeUrl: MISSION_PLAY_URL,
        manualUrl: MISSION_PLAY_URL,
        browserFallbackToPlayUrl: true,
        fallbackNotice:
          "Browser signing URL was not returned. Open the PbP missions page and reset the cooldown there.",
        prepare: prepared,
      };
    }
    return {
      ok: true,
      ready: true,
      reason: "prepared",
      nftId: resolvedNftId,
      nftName: nftDisplayName(targetNft),
      cooldownSeconds: nftCooldownSeconds(targetNft),
      resetCost: Number.isFinite(resetCost) ? resetCost : null,
      signingMode: usesBrowserBridgeSigning()
        ? "browser_bridge"
        : "agent_managed",
      signingUrl,
      bridgeUrl: signingUrl,
      prepare: prepared,
    };
  }

  async function resetCooldownNftFromUi({
    nft,
    nftId = null,
    nftName = null,
    cooldownSeconds = null,
  } = {}) {
    const targetNft =
      nft && typeof nft === "object"
        ? nft
        : {
            nftAccount: nftId,
            account: nftId,
            name: nftName || "NFT",
            cooldownSeconds,
          };
    const result = await tryResetCooldownNft({
      reason: "ui_nft_page",
      missionName: "NFT page",
      missionId: null,
      nft: targetNft,
      maxPbp: uiNftCooldownResetMaxPbp(),
      source: "ui",
    });
    if (result?.reset) {
      await refreshMissionHeaderStats({ refreshNftCount: true });
    }
    return result;
  }

  async function tryUnlockNextMissionSlot({ reason, missionsResult }) {
    const summary = extractSlotUnlockSummary(missionsResult);
    const canUnlockMore = summary?.canUnlockMore === true;
    const nextUnlockSlot = Number(summary?.nextUnlockSlot);
    const targetSlotNumber = TARGET_UNLOCK_SLOT;
    logDebug("assign", "slot_unlock_check", {
      reason,
      summary: summary || null,
      targetSlotNumber,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      signerReady: ctx.signerReady,
      signerLocked: ctx.signerLocked,
    });
    if (!canUnlockMore) {
      return {
        ok: false,
        attempted: false,
        unlocked: false,
        reason: "not_unlockable",
      };
    }
    if (ctx.signerMode === "manual") {
      logWithTimestamp(
        `[UNLOCK] 🌐 Manual mode: open the missions page and unlock slot ${targetSlotNumber} yourself.`,
      );
      const openResult = await openMissionPlayPage({
        cooldownMs: missionPageCooldownMs(),
      });
      if (openResult?.suppressed) {
        logDebug("assign", "mission_page_open_suppressed", {
          reason: "slot_unlock_manual",
          cooldownMs:
            openResult?.cooldownMs ?? MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
          nextAllowedInMs: openResult?.nextAllowedInMs ?? null,
        });
      }
      if (!openResult?.ok) {
        logWithTimestamp(
          `[UNLOCK] ❌ Failed to auto-open browser. Open manually: ${MISSION_PLAY_URL}`,
        );
      }
      return {
        ok: true,
        attempted: true,
        unlocked: false,
        reason: "manual_mode",
      };
    }
    if (
      Number.isFinite(nextUnlockSlot) &&
      nextUnlockSlot > 0 &&
      nextUnlockSlot !== targetSlotNumber
    ) {
      logWithTimestamp(
        `[UNLOCK] ⏸️ Slot unlock blocked: MCP nextUnlockSlot=${nextUnlockSlot}, expected slot ${targetSlotNumber}.`,
      );
      logDebug("assign", "slot_unlock_unexpected_target", {
        reason,
        targetSlotNumber,
        nextUnlockSlot,
        summary: summary || null,
      });
      return {
        ok: false,
        attempted: false,
        unlocked: false,
        reason: "unexpected_next_unlock_slot",
      };
    }
    if (!signer) {
      logWithTimestamp(
        "[UNLOCK] ⏸️ Slot unlock unavailable: signer service missing.",
      );
      return {
        ok: false,
        attempted: false,
        unlocked: false,
        reason: "missing_signer",
      };
    }
    try {
      signer.ensureMissionActionSupported("mission_slot_unlock");
    } catch (error) {
      logWithTimestamp(`[UNLOCK] ⏸️ Slot unlock unavailable: ${error.message}`);
      logDebug("assign", "slot_unlock_blocked", {
        reason,
        nextUnlockSlot,
        error: error.message,
      });
      return {
        ok: false,
        attempted: false,
        unlocked: false,
        reason: "signer_blocked",
      };
    }

    logWithTimestamp(
      `[UNLOCK] 🚀 Attempting to unlock mission slot ${targetSlotNumber}...`,
    );
    try {
      logDebug("assign", "slot_unlock_prepare_start", {
        reason,
        targetSlotNumber,
        nextUnlockSlot,
      });
      const unlockArgs = {
        slotNumber: targetSlotNumber,
        ...preparedActionSigningArgs(),
      };
      logDebug("assign", "slot_unlock_prepare_args", {
        reason,
        targetSlotNumber,
        signerMode: ctx.signerMode,
        args: unlockArgs,
      });
      const prepared = await mcp.mcpToolCall("unlock_mission_slot", unlockArgs);
      if (usesBrowserBridgeSigning()) {
        const signingUrl = browserBridgeUrlFromPrepared(prepared);
        if (!signingUrl) {
          logDebug("assign", "slot_unlock_browser_url_missing", {
            reason,
            targetSlotNumber,
            signerMode: ctx.signerMode,
            structuredContent: compactStructuredSummary(prepared?.structuredContent),
            contentCount: Array.isArray(prepared?.content) ? prepared.content.length : 0,
          });
          return {
            ok: false,
            attempted: true,
            unlocked: false,
            reason: "missing_browser_signing_url",
            slotNumber: targetSlotNumber,
            signingMode: "browser_bridge",
            prepare: prepared,
          };
        }
        return {
          ok: true,
          attempted: true,
          unlocked: false,
          pending: true,
          reason: "browser_signing_required",
          slotNumber: targetSlotNumber,
          signingMode: "browser_bridge",
          signingUrl,
          bridgeUrl: signingUrl,
          prepare: prepared,
        };
      }
      const actionResult = await executePreparedMissionAction({
        actionName: "mission_slot_unlock",
        prepareResult: prepared,
        expected: { slotNumber: targetSlotNumber },
        debugScope: "assign",
        submitDebugAction: "slot_unlock_submit",
        debugMeta: {
          reason,
          targetSlotNumber,
          nextUnlockSlot,
        },
      });
      if (actionResult?.submitted) {
        addSessionSpendTotals(
          actionResult?.signed?.cost ?? prepared?.structuredContent?.unlockCost,
          { actionName: "mission_slot_unlock" },
        );
        scheduleFundingWalletRefresh("mission_slot_unlock");
      }
      if (usesBrowserBridgeSigning() && !actionResult?.submitted) {
        const signingUrl =
          actionResult?.signed?.signingUrl || browserBridgeUrlFromPrepared(prepared);
        return {
          ok: true,
          attempted: true,
          unlocked: false,
          pending: true,
          reason: "browser_signing_required",
          slotNumber: targetSlotNumber,
          signingUrl,
          bridgeUrl: signingUrl,
        };
      }
      logWithTimestamp(
        `[UNLOCK] ✅ Mission slot ${targetSlotNumber} unlocked.`,
      );
      logDebug("assign", "slot_unlock_ok", {
        reason,
        targetSlotNumber,
        nextUnlockSlot,
      });
      return {
        ok: true,
        attempted: true,
        unlocked: true,
        slotNumber: targetSlotNumber,
      };
    } catch (error) {
      logWithTimestamp(
        `[UNLOCK] ❌ Mission slot unlock failed for slot ${targetSlotNumber}: ${error.message}`,
      );
      logDebug("assign", "❌ slot_unlock_failed", {
        reason,
        targetSlotNumber,
        nextUnlockSlot,
        error: error.message,
      });
      return {
        ok: false,
        attempted: true,
        unlocked: false,
        reason: "unlock_failed",
      };
    }
  }

  async function prepareUnlockSlot4({ reason = "ui_manual_unlock" } = {}) {
    const missionsResult = await mcp.mcpToolCall("get_user_missions", {});
    if (ctx.signerMode === "manual") {
      const summary = extractSlotUnlockSummary(missionsResult);
      const canUnlockMore = summary?.canUnlockMore === true;
      if (!canUnlockMore) {
        return {
          ok: false,
          attempted: false,
          unlocked: false,
          reason: "not_unlockable",
        };
      }
      return {
        ok: true,
        attempted: true,
        unlocked: false,
        pending: true,
        reason: "manual_mode",
        slotNumber: TARGET_UNLOCK_SLOT,
        signingMode: "manual_page",
        signingUrl: MISSION_PLAY_URL,
        bridgeUrl: MISSION_PLAY_URL,
        manualUrl: MISSION_PLAY_URL,
      };
    }
    const result = await tryUnlockNextMissionSlot({ reason, missionsResult });
    if (result?.unlocked) {
      await refreshMissionHeaderStats({ refreshNftCount: true });
    }
    return result;
  }

  function findCatalogMission({ missionId = "", missionName: wantedName = "" } = {}) {
    const idKey = String(missionId || "").trim().toLowerCase();
    const nameKey = canonicalNameKey(wantedName);
    const catalog = Array.isArray(ctx.missionCatalogEntries)
      ? ctx.missionCatalogEntries
      : [];
    return (
      catalog.find((mission) => {
        const id = String(catalogMissionId(mission) || "").trim().toLowerCase();
        const name = canonicalNameKey(missionName(mission));
        return (idKey && id === idKey) || (nameKey && name === nameKey);
      }) || null
    );
  }

  function buildTargetMissionList(slot, selectedName, missions = []) {
    const slotNumber = Number(slot);
    const currentTargets = Array.isArray(ctx.config.targetMissions)
      ? ctx.config.targetMissions.slice()
      : [];
    const next = [];
    for (let i = 1; i <= 4; i += 1) {
      const configured = String(currentTargets[i - 1] || "").trim();
      const assigned =
        missions.find((mission) => Number(mission?.slot) === i) || null;
      const assignedName = missionName(assigned);
      const value =
        i === slotNumber
          ? selectedName
          : configured || (assignedName ? assignedName : "");
      if (value) next[i - 1] = value;
    }
    return next
      .map((name) => String(name || "").trim())
      .filter(Boolean);
  }

  function syncConfiguredTargetMissionsFromAssigned(missions = [], reason = "") {
    const normalizedMissions = Array.isArray(missions) ? missions : [];
    const nextTargets = [];
    for (let i = 1; i <= 4; i += 1) {
      const assigned =
        normalizedMissions.find((mission) => Number(mission?.slot) === i) || null;
      const assignedName = missionName(assigned);
      if (assignedName) nextTargets.push(assignedName);
    }
    const uniqueTargets = Array.from(
      new Set(
        nextTargets
          .map((name) => String(name || "").trim())
          .filter(Boolean),
      ),
    );
    const currentTargets = Array.isArray(ctx.config.targetMissions)
      ? ctx.config.targetMissions
          .map((name) => String(name || "").trim())
          .filter(Boolean)
      : [];
    if (
      uniqueTargets.length === 0 ||
      JSON.stringify(currentTargets) === JSON.stringify(uniqueTargets)
    ) {
      return currentTargets;
    }
    ctx.config.targetMissions = uniqueTargets;
    flushConfig(ctx, logDebug);
    logWithTimestamp(
      `[CONFIG] Synced target missions from assigned slots${reason ? ` (${reason})` : ""}: ${uniqueTargets.join(", ")}`,
    );
    if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
    return uniqueTargets;
  }

  function applyTargetMissionForSlot(slot, selectedName, missions = []) {
    const cleaned = buildTargetMissionList(slot, selectedName, missions);
    ctx.config.targetMissions = Array.from(new Set(cleaned));
    flushConfig(ctx, logDebug);
    logWithTimestamp(
      `[CONFIG] Mission targets updated: ${ctx.config.targetMissions.join(", ") || "(none)"}`,
    );
    if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
    return ctx.config.targetMissions;
  }

  async function applyMissionSelection({
    slot,
    missionName: selectedMissionName = "",
    missionId: selectedMissionId = "",
    prepareOnly = false,
  } = {}) {
    const slotNumber = Number(slot);
    if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 4) {
      return { ok: false, reason: "invalid_slot" };
    }
    if (!Array.isArray(ctx.missionCatalogEntries) || ctx.missionCatalogEntries.length === 0) {
      await refreshMissionCatalog();
    }

    const missionsResult = await mcp.mcpToolCall("get_user_missions", {});
    const summary = normalizeSlotUnlockSummary(missionsResult);
    ctx.slotUnlockSummary = summary;
    if (missionBlockedByLockedSlot({ slot: slotNumber }, summary)) {
      return { ok: false, reason: "slot_locked", slot: slotNumber, summary };
    }

    const missions = normalizeMissionList(missionsResult);
    const selected = findCatalogMission({
      missionId: selectedMissionId,
      missionName: selectedMissionName,
    });
    if (!selected) {
      return { ok: false, reason: "mission_not_found", slot: slotNumber };
    }
    const selectedName = missionName(selected);
    const chosenMissionId = catalogMissionId(selected);
    if (!selectedName || !chosenMissionId) {
      return { ok: false, reason: "mission_missing_id", slot: slotNumber };
    }

    const currentMission =
      missions.find((mission) => Number(mission?.slot) === slotNumber) || null;
    const currentAssignedMissionId = assignedMissionId(currentMission);
    const currentCatalogMissionId = catalogMissionId(currentMission);
    const previewTargets = Array.from(
      new Set(buildTargetMissionList(slotNumber, selectedName, missions)),
    );

    if (currentCatalogMissionId && currentCatalogMissionId === chosenMissionId) {
      return {
        ok: true,
        changed: false,
        reason: "already_selected",
        slot: slotNumber,
        targetMissions: previewTargets,
      };
    }

    if (currentAssignedMissionId) {
      if (ctx.signerMode === "manual") {
        return {
          ok: true,
          changed: false,
          swapped: false,
          pending: true,
          reason: "manual_mode",
          slot: slotNumber,
          missionName: selectedName,
          targetMissions: previewTargets,
          signingMode: "manual_page",
          signingUrl: MISSION_PLAY_URL,
          bridgeUrl: MISSION_PLAY_URL,
          manualUrl: MISSION_PLAY_URL,
        };
      }
      if (!signer) {
        return { ok: false, reason: "missing_signer", slot: slotNumber };
      }
      signer.ensureMissionActionSupported("mission_swap");
      const swapArgs = {
        assignedMissionId: currentAssignedMissionId,
        chosenMissionId,
        ...preparedActionSigningArgs(),
      };
      logWithTimestamp(
        `[MISSION] 🔁 Changing slot ${slotNumber}: ${missionName(currentMission) || "current mission"} → ${selectedName}`,
      );
      const prepared = await mcp.mcpToolCall("prepare_mission_swap", swapArgs);
      if (usesBrowserBridgeSigning()) {
        const signingUrl = browserBridgeUrlFromPrepared(prepared);
        if (!signingUrl) {
          logDebug("assign", "mission_swap_browser_url_missing", {
            slot: slotNumber,
            fromMissionId: currentCatalogMissionId || null,
            toMissionId: chosenMissionId,
            signerMode: ctx.signerMode,
            structuredContent: compactStructuredSummary(prepared?.structuredContent),
            contentCount: Array.isArray(prepared?.content) ? prepared.content.length : 0,
          });
          return {
            ok: false,
            changed: false,
            swapped: false,
            reason: "missing_browser_signing_url",
            slot: slotNumber,
            missionName: selectedName,
            targetMissions: previewTargets,
            signingMode: "browser_bridge",
            prepare: prepared,
          };
        }
        return {
          ok: true,
          changed: false,
          swapped: false,
          pending: true,
          reason: "browser_signing_required",
          slot: slotNumber,
          missionName: selectedName,
          targetMissions: previewTargets,
          signingMode: "browser_bridge",
          signingUrl,
          bridgeUrl: signingUrl,
          prepare: prepared,
        };
      }
      if (prepareOnly) {
        return {
          ok: true,
          changed: false,
          swapped: false,
          previewOnly: true,
          slot: slotNumber,
          missionName: selectedName,
          targetMissions: previewTargets,
        };
      }
      const actionResult = await executePreparedMissionAction({
        actionName: "mission_swap",
        prepareResult: prepared,
        expected: { assignedMissionId: currentAssignedMissionId, chosenMissionId },
        debugScope: "assign",
        submitDebugAction: "mission_swap_submit",
        debugMeta: {
          slot: slotNumber,
          fromMissionId: currentCatalogMissionId || null,
          toMissionId: chosenMissionId,
        },
      });
      if (actionResult?.submitted) {
        addSessionSpendTotals(
          actionResult?.signed?.cost ?? prepared?.structuredContent?.swapCost,
          { actionName: "mission_swap" },
        );
        scheduleFundingWalletRefresh("mission_swap");
      }
      if (usesBrowserBridgeSigning() && !actionResult?.submitted) {
        const signingUrl =
          actionResult?.signed?.signingUrl || browserBridgeUrlFromPrepared(prepared);
        return {
          ok: true,
        changed: false,
        swapped: false,
        pending: true,
        reason: "browser_signing_required",
        slot: slotNumber,
        missionName: selectedName,
        targetMissions: previewTargets,
        signingUrl,
        bridgeUrl: signingUrl,
      };
    }
      const targets = applyTargetMissionForSlot(slotNumber, selectedName, missions);
      await refreshMissionHeaderStats({ refreshNftCount: true });
      return {
        ok: true,
        changed: true,
        swapped: true,
        slot: slotNumber,
        missionName: selectedName,
        targetMissions: targets,
      };
    }

    const assignResult = await autoAssignConfiguredMissions({
      reason: "ui_mission_selection",
      missionsResult,
    });
    const targets = applyTargetMissionForSlot(slotNumber, selectedName, missions);
    await refreshMissionHeaderStats({ refreshNftCount: true });
    return {
      ok: true,
      changed: true,
      swapped: false,
      assigned: Number(assignResult?.assigned || 0),
      slot: slotNumber,
      missionName: selectedName,
      targetMissions: targets,
    };
  }

  async function previewMissionSelection(payload = {}) {
    return await applyMissionSelection({
      ...payload,
      prepareOnly: true,
    });
  }

  function configuredTargetEntries() {
    if (!Array.isArray(ctx.config.targetMissions)) return [];
    return ctx.config.targetMissions
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }

  function getResetPolicy() {
    return defaultResetPolicy(ctx);
  }

  function missionBlockedByResetThreshold(mission) {
    const resetPolicy = resetPolicyForMission(ctx, mission);
    if (!resetPolicy.enabled) return false;
    const level = Number(parseResetLevel(mission) || 0);
    return Number.isFinite(level) && level >= Number(resetPolicy.threshold);
  }

  function missionBlockedByLockedSlot(mission, slotUnlockSummary = null) {
    const summary = normalizeSlotUnlockSummary({
      structuredContent: { slotUnlockSummary },
    });
    if (!summary?.canUnlockMore) return false;
    const nextUnlockSlot = Number(summary?.nextUnlockSlot);
    if (!Number.isFinite(nextUnlockSlot) || nextUnlockSlot <= 0) return false;
    const slot = Number(mission?.slot);
    if (!Number.isFinite(slot) || slot <= 0) return false;
    return slot >= nextUnlockSlot;
  }

  function buildAssignCandidates(missions, resolved, slotUnlockSummary = null) {
    return missions.filter((m) => {
      const name = missionName(m).toLowerCase();
      const key = canonicalNameKey(name);
      const id = catalogMissionId(m);
      const selectedById = id ? resolved.targetIds.has(id) : false;
      const selectedByName = key ? resolved.targetNames.has(key) : false;
      return (
        (selectedById || selectedByName) &&
        !missionHasAssignedNft(m) &&
        !missionBlockedByResetThreshold(m) &&
        !missionBlockedByLockedSlot(m, slotUnlockSummary)
      );
    });
  }

  function summarizeSelectedMissionState(missions, resolved) {
    return missions
      .filter((m) => {
        const name = canonicalNameKey(missionName(m));
        const id = catalogMissionId(m);
        return (
          (id && resolved.targetIds.has(id)) ||
          (name && resolved.targetNames.has(name))
        );
      })
      .map((m) => ({
        name: missionName(m) || null,
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
        hasAssignedNft: missionHasAssignedNft(m),
        claimable: missionIsClaimable(m),
        resetBlocked: missionBlockedByResetThreshold(m),
      }));
  }

  async function loadAssignableCandidates(
    reason,
    resolved,
    initialMissionResult = null,
  ) {
    let result =
      initialMissionResult || (await mcp.mcpToolCall("get_user_missions", {}));
    let missions = normalizeMissionList(result);
    const slotUnlockSummary = extractSlotUnlockSummary(result);
    let candidates = buildAssignCandidates(
      missions,
      resolved,
      slotUnlockSummary,
    );
    const resetBlocked = missions
      .filter((m) => {
        const name = missionName(m).toLowerCase();
        const key = canonicalNameKey(name);
        const id = catalogMissionId(m);
        const selectedById = id ? resolved.targetIds.has(id) : false;
        const selectedByName = key ? resolved.targetNames.has(key) : false;
        return (
          (selectedById || selectedByName) &&
          !missionHasAssignedNft(m) &&
          missionBlockedByResetThreshold(m)
        );
      })
      .map((m) => ({
        name: missionName(m),
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
      }));
    const lockedSlotBlocked = missions
      .filter((m) => {
        const name = missionName(m).toLowerCase();
        const key = canonicalNameKey(name);
        const id = catalogMissionId(m);
        const selectedById = id ? resolved.targetIds.has(id) : false;
        const selectedByName = key ? resolved.targetNames.has(key) : false;
        return (
          (selectedById || selectedByName) &&
          !missionHasAssignedNft(m) &&
          !missionBlockedByResetThreshold(m) &&
          missionBlockedByLockedSlot(m, slotUnlockSummary)
        );
      })
      .map((m) => ({
        name: missionName(m),
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
      }));
    logDebug("assign", "sync_wait_snapshot", {
      reason,
      attempt: 0,
      selectedCount: summarizeSelectedMissionState(missions, resolved).length,
      resetBlockedCount: resetBlocked.length,
      lockedSlotBlockedCount: lockedSlotBlocked.length,
      availableSlots:
        Number(extractSlotUnlockSummary(result)?.availableSlots || 0) || 0,
      candidates: candidates.map((m) => ({
        name: missionName(m),
        slot: m?.slot ?? null,
        level: missionLevel(m),
      })),
    });
    if (resetBlocked.length > 0) {
      const names = resetBlocked
        .map((m) => `${m.name} lvl=${m.level ?? "?"}`)
        .join(", ");
      logWithTimestamp(
        `[ASSIGN] ⏸️ Holding mission(s) for reset threshold; not assigning NFT: ${names}`,
      );
    }
    if (lockedSlotBlocked.length > 0) {
      const names = lockedSlotBlocked
        .map((m) => `${m.name} slot=${m.slot ?? "?"}`)
        .join(", ");
      logWithTimestamp(
        `[ASSIGN] ⏸️ Holding mission(s) in locked slot(s); not assigning NFT: ${names}`,
      );
    }
    return { result, missions, candidates };
  }

  function resolveConfiguredTargets(
    catalogMissions = ctx.missionCatalogEntries || [],
  ) {
    const configured = configuredTargetEntries();
    if (catalogMissions.length === 0) {
      return {
        configured,
        targetIds: new Set(),
        targetNames: new Set(
          configured.map((x) => canonicalNameKey(x)).filter(Boolean),
        ),
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
    if (resolved.targetIds.size === 0 && resolved.targetNames.size === 0)
      return missions;
    return missions.filter((m) => isConfiguredTargetMission(m, resolved));
  }

  function findMissionByAssignedMissionId(missions = [], assignedId = "") {
    const wanted = String(assignedId || "").trim();
    if (!wanted) return null;
    for (const mission of missions) {
      if (assignedMissionId(mission) === wanted) return mission;
    }
    return null;
  }

  async function refreshMissionCatalog({ force = false } = {}) {
    if (
      !force &&
      Array.isArray(ctx.missionCatalogEntries) &&
      ctx.missionCatalogEntries.length > 0
    ) {
      logDebug("catalog", "cache_hit", {
        total: ctx.missionCatalogEntries.length,
      });
      return {
        ok: true,
        total: ctx.missionCatalogEntries.length,
        cached: true,
      };
    }
    if (!force && missionCatalogRefreshPromise) {
      logDebug("catalog", "cache_wait", {});
      return missionCatalogRefreshPromise;
    }
    missionCatalogRefreshPromise = (async () => {
      const result = await mcp.mcpToolCall("get_mission_catalog", {});
      const missions = normalizeMissionCatalogList(result);
      ctx.missionCatalogEntries = missions;
      logWithTimestamp(`[CATALOG] ✅ Loaded ${missions.length} missions`);
      return { ok: true, total: missions.length, cached: false };
    })();
    try {
      return await missionCatalogRefreshPromise;
    } catch (error) {
      logWithTimestamp(
        `[CATALOG] ❌ Failed to load mission catalog: ${error.message}`,
      );
      logDebug("catalog", "load_failed", { error: error.message });
      return { ok: false, total: 0 };
    } finally {
      missionCatalogRefreshPromise = null;
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
      logWithTimestamp(
        `[CONFIG] ✅ targetMissions resolved: ${validNames.join(", ")}`,
      );
    }
    return resolved;
  }

  function selectedTargetsForDisplay(resolved = resolveConfiguredTargets()) {
    const out = [];
    const added = new Set();
    const catalog = Array.isArray(ctx.missionCatalogEntries)
      ? ctx.missionCatalogEntries
      : [];
    for (const m of catalog) {
      const id = catalogMissionId(m);
      const name = missionName(m);
      const byId = id ? resolved.targetIds.has(id) : false;
      const byName = name
        ? resolved.targetNames.has(name.toLowerCase())
        : false;
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

  async function autoAssignConfiguredMissions({
    reason = "periodic",
    missionsResult = null,
    prefetchedRentalCandidates = null,
  } = {}) {
    const resolved = resolveConfiguredTargets();
    const initialPrefetchedRentalCandidates = normalizeRentalCandidates(
      prefetchedRentalCandidates,
    );
    const usePrefetchedRentalOnly =
      reason === "rental_fast_refresh" &&
      initialPrefetchedRentalCandidates.length > 0;
    const prefetchedRentalCandidateQueue =
      initialPrefetchedRentalCandidates.slice();
    let rentalLookupCache = null;
    logDebug("assign", "check", {
      reason,
      configured: resolved.configured.length,
      targets: resolved.targetIds.size || resolved.targetNames.size,
      prefetchedRentalCandidates: initialPrefetchedRentalCandidates.length,
      usePrefetchedRentalOnly,
    });
    if (hasActiveMcpCooldown()) {
      logDebug("assign", "⏳ check_skipped_rate_limited", {
        reason,
        retryAfterMs: getMcpCooldownRemainingMs(),
      });
      return { ok: true, attempted: 0, assigned: 0, skipped: true };
    }
    if (resolved.targetIds.size === 0 && resolved.targetNames.size === 0) {
      return { ok: true, attempted: 0, assigned: 0 };
    }
    if (ctx.autoAssignRunning) {
      logWithTimestamp(
        `[ASSIGN] ℹ️ Assign check skipped (already running) reason=${reason}`,
      );
      return { ok: true, attempted: 0, assigned: 0, skipped: true };
    }

    ctx.autoAssignRunning = true;
    let assigningStarted = false;
    let assignedCountForEvent = null;
    try {
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("assigning", { state: "start", reason });
        assigningStarted = true;
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      let {
        result: currentMissionResult,
        missions,
        candidates,
      } = await loadAssignableCandidates(reason, resolved, missionsResult);

      if (candidates.length === 0) {
        logDebug("assign", "slot_unlock_skipped_auto", {
          reason,
          summary: compactSlotUnlockSummary(
            extractSlotUnlockSummary(currentMissionResult),
          ),
        });
      }

      if (candidates.length === 0) {
        if (
          reason === "manual" ||
          reason === "post_claim" ||
          String(reason || "").startsWith("post_claim_")
        ) {
          logWithTimestamp(
            "[ASSIGN] ℹ️ No unassigned target mission to start right now.",
          );
        }
        logDebug("assign", "no_candidates", {
          reason,
          configuredTargets: resolved.configured,
          foundTargets: compactMissionStateList(
            summarizeSelectedMissionState(missions, resolved),
          ),
        });
        if (assigningStarted && ctx.guiBridge?.sendEvent) {
          ctx.guiBridge.sendEvent("assigning", {
            state: "done",
            reason,
            assigned: 0,
          });
        }
        if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        return { ok: true, attempted: 0, assigned: 0 };
      }

      logWithTimestamp(
        `[ASSIGN] 🚀 Attempting to start ${candidates.length} mission(s) via NFT assignment...`,
      );
      let assigned = 0;
      const startedMissionNames = [];
      const startedMissionDetails = [];
      let abortedForRateLimit = false;
      const alreadyAssignedNftAccounts = assignedNftAccountSetFromMissions(missions);
      const rentalFallbackEnabled =
        ctx.missionModeEnabled === true ||
        ctx.config?.missionModeEnabled === true ||
        ctx.config?.enableRentals === true;
      logDebug("assign", "assignment_order_policy", {
        reason,
        order: [
          "ready_owned_nft",
          "ready_rental",
          "owned_cooldown_reset",
          "rental_cooldown_reset",
        ],
        rentalFallbackEnabled,
        autoNftCooldownResetEnabled: autoNftCooldownResetEnabled(),
      });
      for (const mission of candidates) {
        if (hasActiveMcpCooldown()) {
          abortedForRateLimit = true;
          logDebug("assign", "mission_loop_aborted_rate_limited", {
            reason,
            retryAfterMs: getMcpCooldownRemainingMs(),
          });
          break;
        }
        const id = assignedMissionId(mission);
        const name = missionName(mission) || "unknown mission";
        const level = missionLevel(mission);
        const levelText = level === null ? "" : ` lvl=${level}`;
        if (!id) {
          logDebug("assign", "candidate_missing_assigned_mission_id", {
            reason,
            name,
            slot: mission?.slot ?? null,
            raw: compactMissionSelection({
              name,
              assignedMissionId: assignedMissionId(mission),
              catalogMissionId: catalogMissionId(mission),
              slot: mission?.slot ?? null,
              level: missionLevel(mission),
              hasAssignedNft: missionHasAssignedNft(mission),
              claimable: missionIsClaimable(mission),
              resetBlocked: missionBlockedByResetThreshold(mission),
            }),
          });
          logDebug("assign", "missing_mission_id", { name });
          continue;
        }

        logWithTimestamp(
          `[ASSIGN] 🔢 ${name}: order=ready owned → ready rental → owned cooldown reset → rental cooldown reset.`,
        );

        const currentMission = findMissionByAssignedMissionId(missions, id);
        if (currentMission && missionBlockedByResetThreshold(currentMission)) {
          const currentLevel = missionLevel(currentMission);
          logWithTimestamp(
            `[ASSIGN] ⏸️ Skipping mission held for reset threshold: ${name}${currentLevel === null ? "" : ` lvl=${currentLevel}`}`,
          );
          logDebug("assign", "assign_blocked_by_reset_threshold", {
            reason,
            missionName: name,
            missionId: id,
            level: currentLevel,
          });
          continue;
        }

        let nfts = [];
        let assignmentOptions = [];
        let assignmentSourceStage = null;
        try {
          const nftResult = await mcp.mcpToolCall("get_mission_nfts", {
            assignedMissionId: id,
          });
          nfts = normalizeNftList(nftResult);
          logDebug("assign", "eligible_nfts_loaded", {
            reason,
            missionName: name,
            missionId: id,
            nftCount: nfts.length,
            eligibleCount: nfts.filter(nftIsAvailable).length,
            cooldownCount: nfts.filter((nft) => !nftIsAvailable(nft)).length,
            assignedElsewhereCount: nfts
              .map((nft) => nftAccountId(nft))
              .filter((account) => account && alreadyAssignedNftAccounts.has(account))
              .length,
          });
        } catch (error) {
          logDebug("assign", "nft_list_failed", {
            missionId: id,
            name,
            error: error.message,
          });
          continue;
        }
        const readyOwnedCandidates = nfts
          .map((nft) => ({ nft, account: nftAccountId(nft) }))
          .filter((entry) => !alreadyAssignedNftAccounts.has(entry.account))
          .filter((entry) => nftIsAvailable(entry.nft))
          .filter((entry) => entry.account)
          .sort(
            (a, b) =>
              ownedCandidateReservePriority(a, mission) -
              ownedCandidateReservePriority(b, mission),
          )
          .slice(0, 3);

        if (readyOwnedCandidates.length > 0) {
          assignmentOptions = readyOwnedCandidates.map((entry) => ({
            ...entry,
            source: "owned",
          }));
          assignmentSourceStage = "ready_owned";
          logWithTimestamp(
            `[ASSIGN] ✅ ${name}: found ${readyOwnedCandidates.length} ready owned NFT candidate(s).`,
          );
        } else {
          const ownedCooldownCandidates = nfts
            .map((nft) => ({ nft, account: nftAccountId(nft) }))
            .filter((entry) => entry.account)
            .filter((entry) => !alreadyAssignedNftAccounts.has(entry.account))
            .filter((entry) => !nftIsAvailable(entry.nft))
            .sort(
              (a, b) =>
                ownedCandidateReservePriority(a, mission) -
                  ownedCandidateReservePriority(b, mission) ||
                nftCooldownSeconds(a.nft) - nftCooldownSeconds(b.nft),
            )
            .slice(0, autoNftCooldownResetProbeLimit());

          logDebug("assign", "owned_ready_empty", {
            reason,
            missionName: name,
            missionId: id,
            cooldownCandidates: ownedCooldownCandidates.map((entry) => ({
              nftId: entry.account,
              nftName: nftDisplayName(entry.nft),
              cooldownSeconds: nftCooldownSeconds(entry.nft),
            })),
          });

          let rentalLookupSucceeded = false;
          let readyRentalCandidates = [];
          let cooledRentalCandidates = [];
          if (rentalFallbackEnabled) {
            try {
              let loadedRentalCandidates = [];
              logWithTimestamp(
                `[RENTAL] 🔎 ${name}: no ready owned NFT; checking rental pool before cooldown resets...`,
              );
              while (prefetchedRentalCandidateQueue.length > 0) {
                loadedRentalCandidates.push(
                  prefetchedRentalCandidateQueue.shift(),
                );
              }
              if (loadedRentalCandidates.length > 0) {
                logDebug("assign", "rental_candidates_prefetched", {
                  reason,
                  missionName: name,
                  missionId: id,
                  count: loadedRentalCandidates.length,
                  remainingPrefetchedRentalCandidates:
                    prefetchedRentalCandidateQueue.length,
                });
              }
              const nowMs = Date.now();
              const cacheAgeMs = rentalLookupCache
                ? nowMs - rentalLookupCache.loadedAt
                : Infinity;
              let rentableEntries = null;
              const rentalLookupStartedAt = Date.now();
              let usedPrefetchedOnly = false;
              if (usePrefetchedRentalOnly) {
                rentableEntries = [];
                usedPrefetchedOnly = true;
                logDebug("assign", "rental_fast_refresh_prefetched_only", {
                  reason,
                  missionName: name,
                  missionId: id,
                  prefetchedCount: loadedRentalCandidates.length,
                });
              } else if (
                rentalLookupCache &&
                cacheAgeMs >= 0 &&
                cacheAgeMs <= 2000
              ) {
                rentableEntries = rentalLookupCache.entries;
                logDebug("assign", "rental_candidates_cache_hit", {
                  reason,
                  missionName: name,
                  missionId: id,
                  ageMs: cacheAgeMs,
                  count: rentableEntries.length,
                });
              } else {
                const rentalPoolResult = await getRentableNftsSerialized(
                  {
                    hideCooldowned: false,
                    showRented: false,
                    showOwned: false,
                    sortOrder: "cooldown_asc",
                    pageSize: 100,
                  },
                  {
                    source: "assignment_pool_lookup",
                    missionName: name,
                    missionId: id,
                  },
                );
                rentableEntries = normalizeRentableList(rentalPoolResult);
                rentalLookupCache = {
                  loadedAt: Date.now(),
                  entries: rentableEntries,
                };
                const readyCount = rentableEntries.filter((entry) =>
                  nftIsAvailable(entry),
                ).length;
                const cooldownCount = rentableEntries.length - readyCount;
                logDebug("assign", "rental_lookup_sources_loaded", {
                  reason,
                  missionName: name,
                  missionId: id,
                  readyCount,
                  cooldownPoolCount: cooldownCount,
                  totalCount: rentableEntries.length,
                  cooldownLookupEnabled: autoNftCooldownResetEnabled(),
                });
              }
              loadedRentalCandidates = normalizeRentalCandidates([
                ...loadedRentalCandidates,
                ...rentableEntries,
              ], { limit: 0 });
              logWithTimestamp(
                `[TIMING] rental lookup ${name}: ${timingMs(rentalLookupStartedAt)}ms${usedPrefetchedOnly ? " (prefetched)" : rentalLookupCache && cacheAgeMs >= 0 && cacheAgeMs <= 2000 ? " (cache)" : ""}`,
              );
              readyRentalCandidates = loadedRentalCandidates
                .filter((entry) => nftIsAvailable(entry.nft))
                .slice(0, rentalBatchLimit());
              cooledRentalCandidates = loadedRentalCandidates
                .filter((entry) => !nftIsAvailable(entry.nft))
                .slice(0, autoNftCooldownResetProbeLimit());
              rentalLookupSucceeded = true;
              logDebug("assign", "rental_candidates_loaded", {
                reason,
                missionName: name,
                missionId: id,
                count: loadedRentalCandidates.length,
                readyCount: readyRentalCandidates.length,
                cooldownCount: cooledRentalCandidates.length,
              });
              logWithTimestamp(
                `[RENTAL] 🔎 ${name}: found ${readyRentalCandidates.length} ready rental candidate(s); ${cooledRentalCandidates.length} cooled rental candidate(s) saved for last resort.`,
              );
              if (
                readyRentalCandidates.length === 0 &&
                cooledRentalCandidates.length === 0
              ) {
                logWithTimestamp(
                  `[RENTAL] ℹ️ ${name}: no ready or cooled rental NFTs returned right now.`,
                );
                if (ownedCooldownCandidates.length === 0) {
                  requestRentalFastRefresh({
                    reason,
                    missionName: name,
                  });
                } else {
                  logWithTimestamp(
                    `[RENTAL] ⏸️ ${name}: deferring fast refresh while owned cooldown fallback is in progress.`,
                  );
                }
              }
            } catch (error) {
              if (isRateLimitError(error)) {
                abortedForRateLimit = true;
                logDebug("assign", "⏳ rental_candidates_rate_limited", {
                  reason,
                  missionName: name,
                  missionId: id,
                  retryAfterMs: getMcpCooldownRemainingMs(),
                });
              }
              logDebug("assign", "❌ rental_candidates_failed", {
                reason,
                missionName: name,
                missionId: id,
                error: error.message,
              });
              logWithTimestamp(
                `[RENTAL] ❌ ${name}: failed to load rentable NFTs: ${error.message}`,
              );
            }
          } else {
            logWithTimestamp(
              `[RENTAL] ⏭️ ${name}: rental fallback disabled; skipping cooldown resets.`,
            );
          }
          if (abortedForRateLimit) break;

          const orderedOptions = [];
          if (rentalFallbackEnabled && readyRentalCandidates.length > 0) {
            orderedOptions.push(
              ...readyRentalCandidates.map((entry) => ({
                ...entry,
                source: "rental",
                stage: "ready_rental",
                skipPreLeaseRefresh: usePrefetchedRentalOnly,
              })),
            );
            assignmentSourceStage = "ready_rental";
          }
          if (autoNftCooldownResetEnabled()) {
            const maxPbp = autoNftCooldownResetMaxPbp();
            if (ownedCooldownCandidates.length > 0) {
              orderedOptions.push(
                ...ownedCooldownCandidates.map((entry) => ({
                  ...entry,
                  source: "owned_cooldown",
                  stage: "owned_cooldown_reset",
                })),
              );
              logWithTimestamp(
                `[RESET] 🔎 ${name}: stage 3/4 queued ${ownedCooldownCandidates.length} owned cooldown NFT candidate(s), max=${maxPbp} PBP.`,
              );
            }
            if (rentalFallbackEnabled && rentalLookupSucceeded) {
              if (cooledRentalCandidates.length > 0) {
                orderedOptions.push(
                  ...cooledRentalCandidates.map((entry) => ({
                    ...entry,
                    source: "rental",
                    stage: "rental_cooldown_reset",
                    skipPreLeaseRefresh: usePrefetchedRentalOnly,
                  })),
                );
                logWithTimestamp(
                  `[RESET] 🔎 ${name}: stage 4/4 queued ${cooledRentalCandidates.length} rental cooldown NFT candidate(s), max=${maxPbp} PBP.`,
                );
              }
            } else if (rentalFallbackEnabled) {
              logWithTimestamp(
                `[RESET] ⏭️ ${name}: skipping rental cooldown fallback because rentals were not successfully checked first.`,
              );
            }
          } else if (
            readyRentalCandidates.length === 0 &&
            (ownedCooldownCandidates.length > 0 ||
              cooledRentalCandidates.length > 0)
          ) {
            logWithTimestamp(
              `[RESET] ⏭️ ${name}: auto NFT cooldown reset is disabled.`,
            );
          }
          assignmentOptions = orderedOptions;
          if (!assignmentSourceStage && orderedOptions.length > 0) {
            assignmentSourceStage = orderedOptions[0].stage || null;
          }
        }

        logDebug("assign", "assignment_stage_selected", {
          reason,
          missionName: name,
          missionId: id,
          stage: assignmentSourceStage,
          optionCount: assignmentOptions.length,
        });
        if (assignmentOptions.length === 0) {
          logWithTimestamp(
            `[ASSIGN] ℹ️ No eligible NFT available for: ${name}`,
          );
          continue;
        }

        const slot = mission?.slot ?? null;
        let missionAssigned = false;
        let lastError = null;
        logWithTimestamp(`[ASSIGN] 🚀 Starting mission: ${name}${levelText}`);
        for (let index = 0; index < assignmentOptions.length; index += 1) {
          if (hasActiveMcpCooldown()) {
            abortedForRateLimit = true;
            logDebug("assign", "attempt_loop_aborted_rate_limited", {
              reason,
              missionName: name,
              missionId: id,
              attempt: index + 1,
              maxAttempts: assignmentOptions.length,
              retryAfterMs: getMcpCooldownRemainingMs(),
            });
            break;
          }
          const option = assignmentOptions[index];
          const nft = option.nft;
          let account = option.account;
          try {
            if (option.source === "owned_cooldown") {
              const maxPbp = autoNftCooldownResetMaxPbp();
              logWithTimestamp(
                `[RESET] 🔎 ${name}: checking owned cooldown NFT before rental cooldown fallback (max=${maxPbp} PBP).`,
              );
              const resetResult = await tryResetCooldownNft({
                reason: `${reason}_owned_auto_cooldown_reset`,
                missionName: name,
                missionId: id,
                nft,
                maxPbp,
                source: "owned",
              });
              if (resetResult?.reset !== true) {
                throw new Error(
                  `Owned NFT cooldown reset was not usable (${resetResult?.reason || "reset_failed"}).`,
                );
              }
              option.nft = {
                ...nft,
                onCooldown: false,
                cooldownSeconds: 0,
                cooldownEndsAt: null,
              };
              option.source = "owned";
              logWithTimestamp(
                `[RESET] ✅ ${name}: owned NFT cooldown reset ready for assignment.`,
              );
            }
            if (option.source === "rental") {
              const shouldUseSelectedRental = Boolean(option.listingId);
              const freshRental = shouldUseSelectedRental ? option : null;
              if (!freshRental) {
                const error = new Error(
                  "Rental listing disappeared before lease; waiting for the next fast refresh tick.",
                );
                error.rentalRefreshEmpty = true;
                throw error;
              }
              logDebug("assign", "rental_candidate_reused", {
                reason,
                missionName: name,
                missionId: id,
                attempt: index + 1,
                maxAttempts: assignmentOptions.length,
                listingId: option.listingId || null,
                sourceStage: option.stage || null,
                prefetched: option.skipPreLeaseRefresh === true,
              });
              option.nft = freshRental.nft || option.nft;
              option.account = freshRental.account || option.account;
              option.listingId = freshRental.listingId || option.listingId;
              account = option.account;
              const freshNft = option.nft;
              if (!nftIsAvailable(freshNft)) {
                if (!autoNftCooldownResetEnabled()) {
                  throw new Error(
                    "Rental NFT is on cooldown and auto NFT cooldown reset is disabled.",
                  );
                }
                if (!account) {
                  throw new Error(
                    "Rental NFT is on cooldown but no nftAccount was available for cooldown reset.",
                  );
                }
                const maxPbp = autoNftCooldownResetMaxPbp();
                logWithTimestamp(
                  `[RESET] 🔎 ${name}: rental NFT is on cooldown; checking reset cost before lease (max=${maxPbp} PBP).`,
                );
                const resetResult = await tryResetCooldownNft({
                  reason: `${reason}_rental_auto_cooldown_reset`,
                  missionName: name,
                  missionId: id,
                  nft: {
                    ...freshNft,
                    account,
                    nftAccount: account,
                  },
                  maxPbp,
                  source: "rental",
                });
                if (resetResult?.reset !== true) {
                  throw new Error(
                    resetResult?.error
                      ? `Rental NFT cooldown reset was not usable: ${resetResult.error}`
                      : `Rental NFT cooldown reset was not usable (${resetResult?.reason || "reset_failed"}).`,
                  );
                }
                option.rentalResetUsed = true;
                option.nft = {
                  ...freshNft,
                  account,
                  nftAccount: account,
                  onCooldown: false,
                  cooldownSeconds: 0,
                  cooldownEndsAt: null,
                };
                logWithTimestamp(
                  `[RESET] ✅ ${name}: rental NFT cooldown reset complete; leasing now.`,
                );
              }
              logWithTimestamp(
                `[RENTAL] 🚀 ${name}: starting lease (listingId=${option.listingId})...`,
              );
              logDebug("assign", "rental_lease_start", {
                reason,
                missionName: name,
                missionId: id,
                listingId: option.listingId,
                signingMode: usesBrowserBridgeSigning()
                  ? "browser_bridge"
                  : "agent_managed",
                attempt: index + 1,
                maxAttempts: assignmentOptions.length,
              });
              const leaseStartedAt = Date.now();
              let leaseResult = await mcp.mcpToolCall("start_rental_lease", {
                listingId: option.listingId,
                ...(usesBrowserBridgeSigning()
                  ? { signingMode: "browser_bridge" }
                  : { signingMode: "agent_managed" }),
              });
              if (!toolCallSucceeded(leaseResult)) {
                const message =
                  leaseResult?.content?.[0]?.text ||
                  leaseResult?.structuredContent?.error ||
                  leaseResult?.structuredContent?.details?.message ||
                  "start_rental_lease failed";
                const looksLikeCooldown = /cooldown/i.test(String(message));
                if (
                  looksLikeCooldown &&
                  autoNftCooldownResetEnabled() &&
                  account
                ) {
                  const maxPbp = autoNftCooldownResetMaxPbp();
                  logWithTimestamp(
                    `[RESET] 🔎 ${name}: lease says rental is on cooldown; trying rental cooldown reset before retry (max=${maxPbp} PBP).`,
                  );
                  const resetResult = await tryResetCooldownNft({
                    reason: `${reason}_rental_lease_cooldown_retry`,
                    missionName: name,
                    missionId: id,
                    nft: {
                      ...(option.nft || nft),
                      account,
                      nftAccount: account,
                    },
                    maxPbp,
                    source: "rental",
                  });
                  if (resetResult?.reset === true) {
                    option.rentalResetUsed = true;
                    logWithTimestamp(
                      `[RENTAL] 🔁 ${name}: retrying lease after rental cooldown reset...`,
                    );
                    const retryLeaseStartedAt = Date.now();
                    leaseResult = await mcp.mcpToolCall("start_rental_lease", {
                      listingId: option.listingId,
                      ...(usesBrowserBridgeSigning()
                        ? { signingMode: "browser_bridge" }
                        : { signingMode: "agent_managed" }),
                    });
                    logWithTimestamp(
                      `[TIMING] rental lease retry ${name}: ${timingMs(retryLeaseStartedAt)}ms`,
                    );
                  }
                }
                if (!toolCallSucceeded(leaseResult)) {
                  const retryMessage =
                    leaseResult?.content?.[0]?.text ||
                    leaseResult?.structuredContent?.error ||
                    leaseResult?.structuredContent?.details?.message ||
                    message;
                  throw new Error(retryMessage);
                }
              }
              logWithTimestamp(
                `[TIMING] rental lease ${name}: ${timingMs(leaseStartedAt)}ms`,
              );
              const lease =
                leaseResult?.structuredContent?.data ||
                leaseResult?.structuredContent?.lease ||
                leaseResult?.structuredContent ||
                {};
              const leaseId = String(
                lease?.leaseId ||
                  lease?.rentalLeaseId ||
                  leaseResult?.structuredContent?.leaseId ||
                  "",
              ).trim();
              const leasedAccount = nftAccountId(lease) || account;
              let resolvedPostLeaseAccount = leasedAccount;
              if (resolvedPostLeaseAccount) {
                logDebug("assign", "rental_post_lease_nft_refresh_skipped", {
                  reason,
                  missionName: name,
                  missionId: id,
                  selectedAccount: resolvedPostLeaseAccount,
                  source: leasedAccount ? "lease_result" : "candidate",
                });
              } else {
                try {
                  const postLeaseRefreshStartedAt = Date.now();
                  const postLeaseMissionNfts = await mcp.mcpToolCall(
                    "get_mission_nfts",
                    {
                      assignedMissionId: id,
                    },
                  );
                  const postLeaseCandidates = normalizeNftList(
                    postLeaseMissionNfts,
                  )
                    .map((item) => ({ item, account: nftAccountId(item) }))
                    .filter((entry) => entry.account)
                    .filter((entry) => nftIsAvailable(entry.item));
                  if (postLeaseCandidates.length > 0) {
                    resolvedPostLeaseAccount = postLeaseCandidates[0].account;
                  }
                  logDebug("assign", "rental_post_lease_nft_refresh", {
                    reason,
                    missionName: name,
                    missionId: id,
                    postLeaseCandidateCount: postLeaseCandidates.length,
                    selectedAccount: resolvedPostLeaseAccount || null,
                  });
                  logWithTimestamp(
                    `[TIMING] rental post-lease refresh ${name}: ${timingMs(postLeaseRefreshStartedAt)}ms`,
                  );
                } catch (postLeaseError) {
                  logDebug("assign", "rental_post_lease_nft_refresh_failed", {
                    reason,
                    missionName: name,
                    missionId: id,
                    error: postLeaseError.message,
                  });
                }
              }
              if (!resolvedPostLeaseAccount) {
                throw new Error(
                  "Rental lease succeeded but no assignable nftAccount was available after lease.",
                );
              }
              account = resolvedPostLeaseAccount;
              logWithTimestamp(
                `[RENTAL] ✅ ${name}: lease started, nftAccount=${account}.`,
              );
              if (ctx.guiBridge?.sendEvent) {
                ctx.guiBridge.sendEvent("stats_rental", {
                  source: "lease_started",
                  at: Date.now(),
                  missionName: name,
                  missionId: id,
                  nftAccount: account,
                });
              }
              logDebug("assign", "rental_lease_done", {
                reason,
                missionName: name,
                missionId: id,
                listingId: option.listingId,
                leaseId: leaseId || null,
                nftAccount: account,
                result: {
                  success: toolCallSucceeded(leaseResult),
                  leaseId: leaseId || null,
                  listingId: option.listingId || null,
                  nftAccount: account || null,
                },
              });
              option.leaseId = leaseId || null;
            }
            logDebug("assign", "assign_call_start", {
              reason,
              missionName: name,
              missionId: id,
              slot,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignmentOptions.length,
              selectedFrom: option.source,
            });
            const assignCallStartedAt = Date.now();
            const assignResult = await mcp.mcpToolCall(
              "assign_nft_to_mission",
              {
                assignedMissionId: id,
                nftAccount: account,
                ...(option.source === "rental"
                  ? {
                      rentalLeaseId: option.leaseId || undefined,
                      nftSource: "rental",
                    }
                  : {}),
                ...(usesBrowserBridgeSigning()
                  ? { signingMode: "browser_bridge" }
                  : { signingMode: "agent_managed" }),
              },
            );
            logWithTimestamp(
              `[TIMING] assign ${option.source} ${name}: ${timingMs(assignCallStartedAt)}ms`,
            );
            logDebug("assign", "assign_call_done", {
              reason,
              missionName: name,
              missionId: id,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignmentOptions.length,
              success: toolCallSucceeded(assignResult),
              selectedFrom: option.source,
              result: compactAssignResultSummary(assignResult),
            });
            if (!toolCallSucceeded(assignResult)) {
              const message = assignFailureMessage(assignResult);
              const details = assignFailureDetails(assignResult);
              throw new Error(
                details
                  ? `${message} details=${JSON.stringify(details)}`
                  : message,
              );
            }
            assigned += 1;
            if (account) alreadyAssignedNftAccounts.add(account);
            missionAssigned = true;
            startedMissionNames.push(name);
            startedMissionDetails.push({ name, level, slot });
            logWithTimestamp(
              `[ASSIGN] ✅ Started mission: ${name}${levelText}`,
            );
            try {
              const slotNumber = Number(slot);
              if (
                Number.isFinite(slotNumber) &&
                slotNumber >= 1 &&
                slotNumber <= 4
              ) {
                const label = nftDisplayName(nft);
                const existing = Array.isArray(ctx.guiMissionSlots)
                  ? ctx.guiMissionSlots
                  : [];
                if (existing.length === 4) {
                  const next = existing.slice();
                  const nftLevel = Number.isFinite(Number(nft?.level))
                    ? Number(nft.level)
                    : null;
                  const nftImage =
                    assignedNftImageFromMission({ nft }) ||
                    assignedNftImageFromMission({ assignedNft: nft }) ||
                    null;
                  next[slotNumber - 1] = {
                    ...next[slotNumber - 1],
                    slot: slotNumber,
                    missionId: id,
                    missionName: name,
                    assignedNft: label,
                    missionLevel: level ?? null,
                    nftLevel,
                    nftImage,
                    progress: 0,
                    total: null,
                    completed: false,
                    statusText: null,
                    startTime: new Date().toISOString(),
                  };
                  ctx.guiMissionSlots = next;
                }
              }
            } catch {}
            if (
              ctx.guiBridge &&
              typeof ctx.guiBridge.sendEvent === "function"
            ) {
              const usedReset =
                option.source === "owned_cooldown" ||
                (option.source === "rental" && option.rentalResetUsed === true);
              if (usedReset) {
                ctx.guiBridge.sendEvent("stats_assignment", {
                  at: Date.now(),
                  missionId: id,
                  missionName: name,
                  slot,
                  nftAccount: account,
                  source: option.source === "rental" ? "rental" : "owned",
                  usedReset: true,
                });
              }
              ctx.guiBridge.sendEvent("assigned", {
                missionId: id,
                missionName: name,
                slot,
                nftAccount: account,
                reason,
                source: option.source,
              });
            }
            if (ctx.guiBridge && typeof ctx.guiBridge.emitNow === "function") {
              ctx.guiBridge.emitNow();
            }
            break;
          } catch (error) {
            lastError = error;
            if (isRateLimitError(error)) {
              abortedForRateLimit = true;
              logDebug("assign", "⏳ assign_rate_limited", {
                missionName: name,
                missionId: id,
                attempt: index + 1,
                maxAttempts: assignmentOptions.length,
                retryAfterMs: getMcpCooldownRemainingMs(),
                selectedFrom: option.source,
              });
            }
            const retryable = isRetryableActiveMissionAssignError(
              error.message,
            );
            const hasNext = index + 1 < assignmentOptions.length;
            const shouldTryNext =
              abortedForRateLimit
                ? false
                : error.rentalRefreshEmpty === true
                ? false
                : option.source === "rental" || option.source === "owned_cooldown"
                  ? hasNext
                  : retryable && hasNext;
            logDebug("assign", "❌ assign_failed", {
              missionName: name,
              missionId: id,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignmentOptions.length,
              error: error.message,
              retryable,
              willRetry: shouldTryNext,
              selectedNft: compactNftSelection(nft),
              selectedFrom: option.source,
            });
            if (option.source === "rental") {
              if (option.listingId) {
                rentalFastRefreshFailedListings.add(String(option.listingId));
              }
              if (error.rentalRefreshEmpty === true) {
                logWithTimestamp(
                  `[RENTAL] ℹ️ ${name}: prefetched rental was gone before lease; staying on fast refresh.`,
                );
              } else {
                logWithTimestamp(
                  `[RENTAL] ❌ ${name}: rental attempt failed: ${error.message}`,
                );
              }
              if (!shouldTryNext) {
                requestRentalFastRefresh({
                  reason: "rental_attempt_failed",
                  missionName: name,
                });
              }
            } else if (option.source === "owned_cooldown") {
              logWithTimestamp(
                `[RESET] ⏭️ ${name}: owned cooldown reset attempt not usable; ${shouldTryNext ? "trying next fallback" : "no fallback left"}.`,
              );
            }
            if (shouldTryNext) {
              continue;
            }
            break;
          }
        }
        if (abortedForRateLimit) break;

        if (!missionAssigned && lastError) {
          if (lastError.rentalRefreshEmpty === true) {
            logWithTimestamp(
              `[ASSIGN] ℹ️ ${name}: rental disappeared before lease; continuing fast refresh.`,
            );
          } else {
            logWithTimestamp(
              `[ASSIGN] ❌ Failed assign for ${name} (missionId=${id}): ${lastError.message}`,
            );
          }
        }
      }
      assignedCountForEvent = assigned;

      if (assigned > 0) {
        if (reason !== "rental_fast_refresh") {
          stopRentalFastRefresh("assigned");
        }
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
      logDebug("assign", "✅ auto_assign_complete", {
        reason,
        attempted: candidates.length,
        assigned,
        abortedForRateLimit,
        startedMissionNames,
        startedMissionDetails,
      });
      if (assigningStarted && ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("assigning", {
          state: "done",
          reason,
          assigned,
        });
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      flushRequestedRentalFastRefresh();
      return {
        ok: true,
        attempted: candidates.length,
        assigned,
        startedMissionNames,
        startedMissionDetails,
      };
    } catch (error) {
      logWithTimestamp(`[ASSIGN] ❌ Assign check failed: ${error.message}`);
      logDebug("assign", "❌ auto_assign_failed", {
        reason,
        error: error.message,
        stack: error.stack,
      });
      if (assigningStarted && ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("assigning", {
          state: "error",
          reason,
          assigned: assignedCountForEvent,
          error: error.message,
        });
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      flushRequestedRentalFastRefresh();
      return { ok: false, attempted: 0, assigned: 0, error: error.message };
    } finally {
      ctx.autoAssignRunning = false;
      flushRequestedRentalFastRefresh();
    }
  }

  async function claimClaimableMissions({
    maxClaims = 10,
    reason = "fallback",
    onlySelected = true,
    missionsResult = null,
  } = {}) {
    const limit = Math.max(1, Number(maxClaims || 10));
    const claimsPaused = () => ctx.watchLoopEnabled === false;
    try {
      if (claimsPaused()) {
        logDebug("watch", "claim_scan_skipped_paused", { reason, limit });
        if (ctx.guiBridge?.sendEvent) {
          ctx.guiBridge.sendEvent("claiming", {
            state: "done",
            reason,
            claimed: 0,
          });
        }
        if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        return { ok: true, claimed: 0, skipped: true, paused: true };
      }
      const result =
        missionsResult || (await mcp.mcpToolCall("get_user_missions", {}));
      const missionsAll = normalizeMissionList(result);
      const missions = onlySelected
        ? filterSelectedMissions(missionsAll)
        : missionsAll;
      const candidates = missions
        .filter((m) => missionIsClaimable(m))
        .map((m) => ({
          id: assignedMissionId(m),
          name: missionName(m) || "unknown mission",
          level: missionLevel(m),
          slot: m?.slot ?? null,
          prize: m?.prize ?? m?.rewardToken ?? m?.reward_token ?? null,
          prizeAmount:
            m?.prize_amount ??
            m?.prizeAmount ??
            m?.rewardAmount ??
            m?.reward_amount ??
            null,
        }))
        .filter((m) => m.id)
        .slice(0, limit);

      if (candidates.length === 0) {
        if (ctx.guiBridge?.sendEvent) {
          ctx.guiBridge.sendEvent("claiming", {
            state: "done",
            reason,
            claimed: 0,
          });
        }
        if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        return { ok: true, claimed: 0 };
      }
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("claiming", {
          state: "start",
          reason,
          maxClaims: limit,
        });
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();

      let claimed = 0;
      for (const mission of candidates) {
        if (claimsPaused()) {
          logDebug("watch", "claim_scan_stopped_paused", {
            reason,
            claimed,
            nextMissionId: mission.id,
          });
          break;
        }
        const claimAbortController = new AbortController();
        ctx.activeClaimAbortController = claimAbortController;
        try {
          const claimResult = await mcp.mcpToolCall(
            "claim_mission_reward",
            {
              assignedMissionId: mission.id,
            },
            { signal: claimAbortController.signal },
          );
          if (!toolCallSucceeded(claimResult)) {
            const message =
              claimResult?.structuredContent?.details?.message ||
              claimResult?.content?.[0]?.text ||
              "claim_mission_reward failed";
            throw new Error(message);
          }
          claimed += 1;
          const levelText =
            mission.level === null ? "" : ` lvl=${mission.level}`;
          const slotText = mission.slot === null ? "" : ` slot=${mission.slot}`;
          if (
            ctx.guiBridge &&
            typeof ctx.guiBridge.sendEvent === "function"
          ) {
            const rewardFromResult = rewardFromClaimToolResult(claimResult);
            const rewardToken =
              rewardFromResult.token || normalizeRewardBucket(mission.prize);
            const rewardAmount =
              rewardFromResult.amount > 0
                ? rewardFromResult.amount
                : Number(mission.prizeAmount ?? 0);
            ctx.guiBridge.sendEvent("stats_claim", {
              source: "fallback_claim",
              at: Date.now(),
              assignedMissionId: mission.id || null,
              missionName: mission.name || "unknown mission",
              slot: mission.slot ?? null,
              level: mission.level ?? null,
              rewardAmount:
                Number.isFinite(rewardAmount) && rewardAmount > 0
                  ? rewardAmount
                  : null,
              rewardToken: rewardToken || mission.prize || null,
            });
          }
          const rewardFromResult = rewardFromClaimToolResult(claimResult);
          const rewardBucket =
            rewardFromResult.token || normalizeRewardBucket(mission.prize);
          const rewardAmount =
            rewardFromResult.amount > 0
              ? rewardFromResult.amount
              : Number(mission.prizeAmount ?? 0);
          if (
            rewardBucket &&
            Number.isFinite(rewardAmount) &&
            rewardAmount > 0
          ) {
            addSessionRewardTotals(
              { [rewardBucket]: rewardAmount },
              { logLabel: "Fallback claimed" },
            );
          }
          logWithTimestamp(
            `[WATCH] ✅ Claimed (fallback): ${mission.name}${slotText}${levelText}`,
          );
        } catch (error) {
          if (
            claimsPaused() ||
            error?.name === "AbortError" ||
            /abort/i.test(String(error?.message || ""))
          ) {
            logDebug("watch", "claim_aborted_paused", {
              reason,
              missionId: mission.id,
              error: String(error?.message || error),
            });
            break;
          }
          const levelText =
            mission.level === null ? "" : ` lvl=${mission.level}`;
          const slotText = mission.slot === null ? "" : ` slot=${mission.slot}`;
          logWithTimestamp(
            `[WATCH] ❌ Claim failed (fallback) for ${mission.name}${slotText}${levelText}: ${error.message}`,
          );
          logDebug("watch", "fallback_claim_failed", {
            reason,
            missionId: mission.id,
            error: error.message,
          });
        } finally {
          if (ctx.activeClaimAbortController === claimAbortController) {
            ctx.activeClaimAbortController = null;
          }
        }
      }
      if (claimed > 0) scheduleFundingWalletRefresh("claim_fallback");
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("claiming", {
          state: "done",
          reason,
          claimed,
        });
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      return { ok: true, claimed };
    } catch (error) {
      logDebug("watch", "fallback_claim_scan_failed", {
        reason,
        error: error.message,
      });
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("claiming", {
          state: "error",
          reason,
          error: error.message,
        });
      }
      if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
      return { ok: false, claimed: 0 };
    }
  }

  async function runWhoAmICheck({ includeWalletSummary = true } = {}) {
    try {
      const json = await mcp.mcpToolCall("who_am_i", {});
      const info = json?.structuredContent || {};
      const displayName =
        info.display_name || info.displayName || info.username || "unknown";
      const walletId = info.wallet_id || info.walletId || "unknown";
      const walletSummaryResult =
        includeWalletSummary && walletId && walletId !== "unknown"
          ? await fetchCurrentWalletSummary(walletId)
          : null;
      const parsedWalletSummary = walletSummaryResult
        ? parseWalletSummary(walletSummaryResult, walletId)
        : null;
      const fallbackBalances = parseTokenBalancesArray(
        info.walletBalances || info.wallet_balances || [],
      );
      const fallbackWalletBalanceSummary = Array.isArray(
        info.walletBalanceSummary,
      )
        ? info.walletBalanceSummary.slice()
        : Array.isArray(info.wallet_balance_summary)
          ? info.wallet_balance_summary.slice()
          : [];
      const walletSummary = {
        walletId,
        displayName,
        balances: mergeTokenBalanceEntries(
          parsedWalletSummary?.balances || [],
          fallbackBalances,
        ),
        walletBalanceSummary: parsedWalletSummary?.walletBalanceSummary?.length
          ? parsedWalletSummary.walletBalanceSummary
          : fallbackWalletBalanceSummary,
      };
      ctx.isAuthenticated = true;
      ctx.currentUserDisplayName = displayName || "unknown";
      ctx.currentUserWalletId = walletId || "unknown";
      if (includeWalletSummary) {
        ctx.currentUserWalletSummary = walletSummary;
      }
      logDebug("check", "whoami_ok", { displayName, walletId });
      return { ok: true, displayName, walletId, walletSummary };
    } catch (error) {
      logDebug("check", "whoami_failed", { error: error.message });
      // Keep the last known wallet summary to avoid UI balance flicker when
      // who_am_i or wallet summary calls fail transiently.
      return { ok: false, displayName: "unknown", walletId: "unknown" };
    }
  }

  async function refreshMissionHeaderStats({
    refreshNftCount = false,
    missionsResult = null,
    syncTargetsFromAssigned = false,
    syncReason = "",
    hydrateAssignedMetadata = true,
  } = {}) {
    try {
      const result =
        missionsResult || (await mcp.mcpToolCall("get_user_missions", {}));
      const missions = normalizeMissionList(result);
      updateMissionLookupCache(result, missions);
      if (syncTargetsFromAssigned) {
        syncConfiguredTargetMissionsFromAssigned(missions, syncReason);
      }
      const progressByAssignedMissionId =
        missionProgressLookupFromResult(result);
      const computed = computeMissionStats(missions, ctx.sessionClaimedCount);

      let nftCount = ctx.currentMissionStats.nfts || 0;
      let nftAvailable = ctx.currentMissionStats.nftsAvailable || 0;
      if (refreshNftCount || missionNftByAccount.size === 0) {
        try {
          const nfts = await loadOwnedMissionNfts({
            forceFresh: refreshNftCount === true,
          });
          missionNftByAccount.clear();
          for (const nft of nfts) {
            const key = nftAccountId(nft);
            if (key) missionNftByAccount.set(key, nft);
          }
          nftCount = nfts.length;
          nftAvailable = nfts.filter(nftIsAvailable).length;
        } catch (error) {
          logDebug("check", "nft_count_failed", { error: error.message });
        }
      }

      if (hydrateAssignedMetadata) {
        try {
          const missingAccounts = missions
            .map((mission) => missionAssignedNftAccount(mission))
            .filter((account) => isUsableIdValue(account))
            .map((account) => String(account).trim())
            .filter((account) => !missionNftByAccount.has(account))
            .filter((account) => !assignedNftMetadataByAccount.has(account));

          const uniqueMissing = Array.from(new Set(missingAccounts)).slice(0, 6);
          for (const account of uniqueMissing) {
            try {
              const nftResult = await mcp.mcpToolCall("get_nft", {
                mintAddress: account,
              });
              const nfts = Array.isArray(nftResult?.structuredContent?.nfts)
                ? nftResult.structuredContent.nfts
                : [];
              const first =
                nfts.find((nft) => nftAccountId(nft) === account) ||
                nfts[0] ||
                null;
              if (first) {
                assignedNftMetadataByAccount.set(account, first);
              }
            } catch (error) {
              logDebug("check", "assigned_nft_metadata_fetch_failed", {
                account,
                error: error.message,
              });
            }
          }
        } catch (error) {
          logDebug("check", "assigned_nft_metadata_batch_failed", {
            error: error.message,
          });
        }
      }

      ctx.guiMissionSlots = computeGuiMissionSlots(
        missions,
        progressByAssignedMissionId,
      );
      ctx.slotUnlockSummary = normalizeSlotUnlockSummary(result);

      ctx.currentMissionStats = {
        ...ctx.currentMissionStats,
        ...computed,
        nfts: nftCount,
        nftsTotal: nftCount,
        nftsAvailable: nftAvailable,
        totalClaimed: Number(ctx.config.totalClaimed || 0),
      };
      redrawHeaderAndLog(ctx.currentMissionStats);
      if (ctx.guiBridge && typeof ctx.guiBridge.emitNow === "function") {
        ctx.guiBridge.emitNow();
      }
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
    const checkStartedAt = Date.now();
    const stepDurations = [];
    const markStep = (name, startedAt) => {
      const ms = Math.max(0, Date.now() - startedAt);
      stepDurations.push({ name, ms });
      logWithTimestamp(`[CHECK] ⏱ ${name}: ${ms}ms`);
    };

    const startupSnapshot = startupAccountSnapshot();
    if (startupSnapshot) {
      seedStartupSnapshotCaches(startupSnapshot);
    }

    let stepStartedAt = Date.now();
    const whoami =
      whoAmIFromSnapshot(startupSnapshot) ||
      (await runWhoAmICheck({ includeWalletSummary: false }));
    markStep("who_am_i", stepStartedAt);
    if (!whoami.ok) {
      logWithTimestamp("[CHECK] ❌ Loading data failed (not authenticated).");
      return false;
    }

    ctx.isAuthenticated = true;
    ctx.currentUserDisplayName = whoami.displayName || "unknown";
    ctx.currentUserWalletId = whoami.walletId || "unknown";

    stepStartedAt = Date.now();
    validateConfiguredTargets();
    markStep("validate_targets", stepStartedAt);

    stepStartedAt = Date.now();
    logSelectedWatchTargetsAtStartup();
    markStep("log_targets", stepStartedAt);

    const totalMs = Math.max(0, Date.now() - checkStartedAt);
    logWithTimestamp(`[CHECK] ⏱ total startup checks: ${totalMs}ms`);
    logDebug("check", "initial_checks_timing", {
      totalMs,
      steps: stepDurations,
    });
    logWithTimestamp("[CHECK] ✅ Loading data complete.");
    return true;
  }

  return {
    runWhoAmICheck,
    refreshMissionCatalog,
    validateConfiguredTargets,
    refreshFundingWalletSummary,
    refreshMissionHeaderStats,
    syncConfiguredTargetMissionsFromAssigned,
    claimClaimableMissions,
    isConfiguredTargetMission,
    filterSelectedMissions,
    logSelectedWatchTargetsAtStartup,
    autoAssignConfiguredMissions,
    stopRentalFastRefresh,
    prepareUnlockSlot4,
    applyMissionSelection,
    previewMissionSelection,
    prepareCooldownResetNftFromUi,
    resetCooldownNftFromUi,
    runInitialChecks,
  };
}

module.exports = {
  createChecksService,
};
