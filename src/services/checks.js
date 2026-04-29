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
const { parseResetLevel } = require("./reset");
const {
  openMissionPlayPage,
  MISSION_PLAY_URL,
  MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
} = require("../mission-page");
const { createMissionActionExecutor } = require("../mission-actions");
const {
  fetchOnchainFundingWalletSummary,
} = require("../wallet/onchain-summary");

function createChecksService(ctx, logger, mcp, services = {}) {
  const { logWithTimestamp, logDebug, redrawHeaderAndLog } = logger;
  const { signer = null } = services;
  const { executePreparedMissionAction } = createMissionActionExecutor(
    logger,
    mcp,
    signer,
  );
  let rentalFastRefreshTimer = null;
  let rentalFastRefreshRunning = false;
  let rentalFastRefreshFailedListings = new Set();
  let walletRefreshTimer = null;
  let walletRefreshPendingReason = null;

  function missionPageCooldownMs() {
    const sec = Number(ctx.config?.missionPageOpenCooldownSeconds);
    if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);
    const ms = Number(ctx.config?.missionPageOpenCooldownMs);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
    return MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT;
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

  function computeGuiMissionSlots(
    missions,
    progressByAssignedMissionId = null,
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
        missionId:
          mission?.assignedMissionId || mission?.assigned_mission_id || null,
        missionName: missionName(mission) || null,
        missionLevel: missionLvl,
        progress,
        goal,
        missionImage,
        image: missionImage,
        assignedNft: nftLabel,
        nftLevel,
        nftImage,
      });
    }
    return slots;
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
      mission?.name || mission?.missionName || mission?.mission_name || "",
    ).trim();
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
      })
      .sort((a, b) => {
        const aAvailable = nftIsAvailable(a.nft) ? 0 : 1;
        const bAvailable = nftIsAvailable(b.nft) ? 0 : 1;
        if (aAvailable !== bAvailable) return aAvailable - bAvailable;
        return nftCooldownSeconds(a.nft) - nftCooldownSeconds(b.nft);
      });
    const safeLimit = Number(limit);
    return Number.isFinite(safeLimit) && safeLimit > 0
      ? normalized.slice(0, Math.floor(safeLimit))
      : normalized;
  }

  function autoNftCooldownResetEnabled() {
    return (
      (ctx.missionModeEnabled === true ||
        ctx.config?.missionModeEnabled === true) &&
      (ctx.nftCooldownResetEnabled === true ||
        ctx.config?.nftCooldownResetEnabled === true)
    );
  }

  function autoNftCooldownResetMaxPbp() {
    const raw = Number(ctx.config?.nftCooldownResetMaxPbp);
    return Number.isFinite(raw) && raw >= 0 ? raw : 20;
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
    return ctx.config?.rentalFastRefreshEnabled === true;
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
    logDebug("assign", "rental_fast_refresh_stopped", { reason });
  }

  function startRentalFastRefresh({
    reason = "no_rentables",
    missionName = null,
  } = {}) {
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
    logDebug("assign", "rental_fast_refresh_started", {
      reason,
      missionName,
      tickMs,
    });

    const runRentalFastRefreshTick = async () => {
      if (rentalFastRefreshRunning) return;
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
        const rentableResult = await mcp.mcpToolCall("get_rentable_nfts", {});
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
        logDebug("assign", "rental_fast_refresh_failed", {
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
      const allNftsResult = await mcp.mcpToolCall("get_mission_nfts", {});
      const allNfts = normalizeNftList(allNftsResult);
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
        ...(ctx.signerMode === "dapp"
          ? { signingMode: "browser_bridge" }
          : {
              signingMode: "agent_managed",
              ...(String(ctx.signerConfig?.walletAddress || "").trim()
                ? {
                    payerWallet: String(ctx.signerConfig.walletAddress).trim(),
                  }
                : {}),
            }),
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
          prepared: prepared?.structuredContent || prepared,
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
      logWithTimestamp(
        `[TIMING] reset submit ${source} ${missionName}: ${timingMs(submitStartedAt)}ms`,
      );
      logWithTimestamp(
        `[RESET] ✅ Cooldown reset complete: ${missionName} nft=${nftName}`,
      );
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
      logWithTimestamp(
        `[RESET] ❌ Cooldown reset failed for ${missionName} nft=${nftName}: ${error.message}`,
      );
      logDebug("assign", "cooldown_reset_failed", {
        reason,
        missionName,
        missionId,
        nftId,
        error: error.message,
      });
      return {
        ok: false,
        attempted: true,
        reset: false,
        reason: "reset_failed",
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
      return { ok: false, ready: false, reason: "manual_mode" };
    }
    if (!signer) {
      return { ok: false, ready: false, reason: "missing_signer" };
    }
    signer.ensureMissionActionSupported("nft_cooldown_reset");
    const resetArgs = {
      nftId: resolvedNftId,
      ...(ctx.signerMode === "dapp"
        ? { signingMode: "browser_bridge" }
        : {
            signingMode: "agent_managed",
            ...(String(ctx.signerConfig?.walletAddress || "").trim()
              ? {
                  payerWallet: String(ctx.signerConfig.walletAddress).trim(),
                }
              : {}),
          }),
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
    return {
      ok: true,
      ready: true,
      reason: "prepared",
      nftId: resolvedNftId,
      nftName: nftDisplayName(targetNft),
      cooldownSeconds: nftCooldownSeconds(targetNft),
      resetCost: Number.isFinite(resetCost) ? resetCost : null,
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
        ...(ctx.signerMode === "dapp"
          ? { signingMode: "browser_bridge" }
          : {
              signingMode: "agent_managed",
              ...(String(ctx.signerConfig?.walletAddress || "").trim()
                ? {
                    payerWallet: String(ctx.signerConfig.walletAddress).trim(),
                  }
                : {}),
            }),
      };
      logDebug("assign", "slot_unlock_prepare_args", {
        reason,
        targetSlotNumber,
        signerMode: ctx.signerMode,
        args: unlockArgs,
      });
      const prepared = await mcp.mcpToolCall("unlock_mission_slot", unlockArgs);
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
      logDebug("assign", "slot_unlock_failed", {
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
    const targetSlotNumber = TARGET_UNLOCK_SLOT;
    const missionsResult = await mcp.mcpToolCall("get_user_missions", {});
    const summary = normalizeSlotUnlockSummary(missionsResult);
    ctx.slotUnlockSummary = summary;

    if (!summary?.canUnlockMore) {
      return {
        ok: true,
        ready: false,
        unlocked: false,
        reason: "no_more_to_unlock",
        summary,
      };
    }
    if (
      Number.isFinite(summary?.nextUnlockSlot) &&
      Number(summary.nextUnlockSlot) !== targetSlotNumber
    ) {
      return {
        ok: false,
        ready: false,
        unlocked: false,
        reason: "unexpected_next_unlock_slot",
        summary,
      };
    }
    if (ctx.signerMode === "manual") {
      const openResult = await openMissionPlayPage({
        cooldownMs: missionPageCooldownMs(),
      });
      return {
        ok: true,
        ready: false,
        unlocked: false,
        reason: "manual_mode",
        openedMissionPage: openResult?.ok === true,
        summary,
      };
    }
    if (!signer) {
      return {
        ok: false,
        ready: false,
        unlocked: false,
        reason: "missing_signer",
        summary,
      };
    }
    signer.ensureMissionActionSupported("mission_slot_unlock");
    const unlockArgs = {
      slotNumber: targetSlotNumber,
      ...(ctx.signerMode === "dapp"
        ? { signingMode: "browser_bridge" }
        : {
            signingMode: "agent_managed",
            ...(String(ctx.signerConfig?.walletAddress || "").trim()
              ? {
                  payerWallet: String(ctx.signerConfig.walletAddress).trim(),
                }
              : {}),
          }),
    };
    const prepared = await mcp.mcpToolCall("unlock_mission_slot", unlockArgs);
    return {
      ok: true,
      ready: true,
      unlocked: false,
      reason,
      slotNumber: targetSlotNumber,
      summary,
      prepare: prepared,
    };
  }

  function configuredTargetEntries() {
    if (!Array.isArray(ctx.config.targetMissions)) return [];
    return ctx.config.targetMissions
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }

  function getResetPolicy() {
    const mmEnabled =
      ctx.missionModeEnabled || ctx.config.missionModeEnabled === true;
    if (mmEnabled) {
      const rawLevel =
        ctx.currentMissionResetLevel ||
        ctx.config.missionResetLevel ||
        String(
          process.env.PBP_DEFAULT_MISSION_RESET_LEVEL ||
            ctx.runtimeDefaults?.missionResetLevel ||
            "11",
        );
      const threshold = Number(rawLevel);
      if (Number.isFinite(threshold) && threshold > 0) {
        return { enabled: true, threshold };
      }
      return { enabled: true, threshold: 11 };
    }
    if (ctx.level20ResetEnabled || ctx.config.level20ResetEnabled === true) {
      return { enabled: true, threshold: 20 };
    }
    return { enabled: false, threshold: null };
  }

  function missionBlockedByResetThreshold(mission) {
    const resetPolicy = getResetPolicy();
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
      selected: summarizeSelectedMissionState(missions, resolved),
      resetBlocked,
      lockedSlotBlocked,
      slotUnlockSummary,
      candidates: candidates.map((m) => ({
        name: missionName(m),
        assignedMissionId: assignedMissionId(m),
        catalogMissionId: catalogMissionId(m),
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

  async function refreshMissionCatalog() {
    try {
      const result = await mcp.mcpToolCall("get_mission_catalog", {});
      const missions = normalizeMissionCatalogList(result);
      ctx.missionCatalogEntries = missions;
      logWithTimestamp(`[CATALOG] ✅ Loaded ${missions.length} missions`);
      return { ok: true, total: missions.length };
    } catch (error) {
      logWithTimestamp(
        `[CATALOG] ❌ Failed to load mission catalog: ${error.message}`,
      );
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
    const prefetchedRentalCandidateQueue =
      initialPrefetchedRentalCandidates.slice();
    let rentalLookupCache = null;
    logDebug("assign", "check", {
      reason,
      configured: resolved.configured.length,
      targets: resolved.targetIds.size || resolved.targetNames.size,
      prefetchedRentalCandidates: initialPrefetchedRentalCandidates.length,
    });
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
      logDebug("assign", "candidates_built", {
        reason,
        candidates: candidates.map((m) => ({
          name: missionName(m),
          assignedMissionId: assignedMissionId(m),
          catalogMissionId: catalogMissionId(m),
          slot: m?.slot ?? null,
        })),
      });
      logDebug("assign", "check_result", {
        reason,
        candidates: candidates.length,
      });

      if (candidates.length === 0) {
        logDebug("assign", "slot_unlock_skipped_auto", {
          reason,
          summary: extractSlotUnlockSummary(currentMissionResult) || null,
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
          targetCount: resolved.targetIds.size || resolved.targetNames.size,
          configuredTargets: resolved.configured,
          selectedMissionState: summarizeSelectedMissionState(
            missions,
            resolved,
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

        logWithTimestamp(
          `[ASSIGN] 🔢 ${name}: order=ready owned → ready rental → owned cooldown reset → rental cooldown reset.`,
        );

        try {
          const freshMissionResult = await mcp.mcpToolCall(
            "get_user_missions",
            {},
          );
          const freshMission = findMissionByAssignedMissionId(
            normalizeMissionList(freshMissionResult),
            id,
          );
          if (freshMission && missionBlockedByResetThreshold(freshMission)) {
            const freshLevel = missionLevel(freshMission);
            logWithTimestamp(
              `[ASSIGN] ⏸️ Skipping mission held for reset threshold: ${name}${freshLevel === null ? "" : ` lvl=${freshLevel}`}`,
            );
            logDebug("assign", "assign_blocked_by_fresh_reset_threshold", {
              reason,
              missionName: name,
              missionId: id,
              level: freshLevel,
            });
            continue;
          }
        } catch (error) {
          logDebug("assign", "fresh_mission_recheck_failed", {
            reason,
            missionName: name,
            missionId: id,
            error: error.message,
          });
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
          .filter((entry) => nftIsAvailable(entry.nft))
          .filter((entry) => entry.account)
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
            .filter((entry) => !nftIsAvailable(entry.nft))
            .sort(
              (a, b) => nftCooldownSeconds(a.nft) - nftCooldownSeconds(b.nft),
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
              if (prefetchedRentalCandidateQueue.length > 0) {
                loadedRentalCandidates.push(
                  prefetchedRentalCandidateQueue.shift(),
                );
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
              if (rentalLookupCache && cacheAgeMs >= 0 && cacheAgeMs <= 2000) {
                rentableEntries = rentalLookupCache.entries;
                logDebug("assign", "rental_candidates_cache_hit", {
                  reason,
                  missionName: name,
                  missionId: id,
                  ageMs: cacheAgeMs,
                  count: rentableEntries.length,
                });
              } else {
                const rentableResult = await mcp.mcpToolCall(
                  "get_rentable_nfts",
                  {},
                );
                rentableEntries = normalizeRentableList(rentableResult);
                rentalLookupCache = {
                  loadedAt: Date.now(),
                  entries: rentableEntries,
                };
              }
              loadedRentalCandidates = normalizeRentalCandidates([
                ...loadedRentalCandidates,
                ...rentableEntries,
              ], { limit: 0 });
              logWithTimestamp(
                `[TIMING] rental lookup ${name}: ${timingMs(rentalLookupStartedAt)}ms${rentalLookupCache && cacheAgeMs >= 0 && cacheAgeMs <= 2000 ? " (cache)" : ""}`,
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
                startRentalFastRefresh({
                  reason,
                  missionName: name,
                });
              }
            } catch (error) {
              logDebug("assign", "rental_candidates_failed", {
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

          if (readyRentalCandidates.length > 0) {
            assignmentOptions = readyRentalCandidates.map((entry) => ({
              ...entry,
              source: "rental",
            }));
            assignmentSourceStage = "ready_rental";
          } else if (!rentalFallbackEnabled || !rentalLookupSucceeded) {
            logWithTimestamp(
              `[RESET] ⏭️ ${name}: skipping cooldown resets because rentals were not successfully checked first.`,
            );
          } else if (!autoNftCooldownResetEnabled()) {
            logWithTimestamp(
              `[RESET] ⏭️ ${name}: auto NFT cooldown reset is disabled.`,
            );
          } else {
            const maxPbp = autoNftCooldownResetMaxPbp();
            if (ownedCooldownCandidates.length > 0) {
              logWithTimestamp(
                `[RESET] 🔎 ${name}: no ready owned/rental NFT found; checking ${ownedCooldownCandidates.length} owned cooldown NFT candidate(s), max=${maxPbp} PBP.`,
              );
              for (const candidate of ownedCooldownCandidates) {
                const resetResult = await tryResetCooldownNft({
                  reason: `${reason}_owned_auto_cooldown_reset`,
                  missionName: name,
                  missionId: id,
                  nft: candidate.nft,
                  maxPbp,
                  source: "owned",
                });
                if (resetResult?.reset === true) {
                  assignmentOptions = [
                    {
                      nft: {
                        ...candidate.nft,
                        onCooldown: false,
                        cooldownSeconds: 0,
                        cooldownEndsAt: null,
                      },
                      account: candidate.account,
                      source: "owned",
                    },
                  ];
                  assignmentSourceStage = "owned_cooldown_reset";
                  logWithTimestamp(
                    `[RESET] ✅ ${name}: owned NFT cooldown reset ready for assignment.`,
                  );
                  break;
                }
              }
            }
            if (
              assignmentOptions.length === 0 &&
              cooledRentalCandidates.length > 0
            ) {
              assignmentOptions = cooledRentalCandidates.map((entry) => ({
                ...entry,
                source: "rental",
              }));
              assignmentSourceStage = "rental_cooldown_reset";
              logWithTimestamp(
                `[RESET] 🔎 ${name}: stage 4/4, no owned cooldown reset usable; trying ${cooledRentalCandidates.length} rental cooldown NFT candidate(s), max=${maxPbp} PBP.`,
              );
            }
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
          const option = assignmentOptions[index];
          const nft = option.nft;
          let account = option.account;
          try {
            if (option.source === "rental") {
              if (!nftIsAvailable(nft)) {
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
                    ...nft,
                    account,
                    nftAccount: account,
                  },
                  maxPbp,
                  source: "rental",
                });
                if (resetResult?.reset !== true) {
                  throw new Error(
                    `Rental NFT cooldown reset was not usable (${resetResult?.reason || "reset_failed"}).`,
                  );
                }
                option.nft = {
                  ...nft,
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
                signingMode:
                  ctx.signerMode === "dapp"
                    ? "browser_bridge"
                    : "agent_managed",
                attempt: index + 1,
                maxAttempts: assignmentOptions.length,
              });
              const leaseStartedAt = Date.now();
              let leaseResult = await mcp.mcpToolCall("start_rental_lease", {
                listingId: option.listingId,
                ...(ctx.signerMode === "dapp"
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
                      ...nft,
                      account,
                      nftAccount: account,
                    },
                    maxPbp,
                    source: "rental",
                  });
                  if (resetResult?.reset === true) {
                    logWithTimestamp(
                      `[RENTAL] 🔁 ${name}: retrying lease after rental cooldown reset...`,
                    );
                    const retryLeaseStartedAt = Date.now();
                    leaseResult = await mcp.mcpToolCall("start_rental_lease", {
                      listingId: option.listingId,
                      ...(ctx.signerMode === "dapp"
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
              logDebug("assign", "rental_lease_done", {
                reason,
                missionName: name,
                missionId: id,
                listingId: option.listingId,
                leaseId: leaseId || null,
                nftAccount: account,
                result: leaseResult?.structuredContent || leaseResult,
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
                ...(ctx.signerMode === "dapp"
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
              result: assignResult?.structuredContent || assignResult,
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
                  };
                  ctx.guiMissionSlots = next;
                }
              }
            } catch {}
            if (
              ctx.guiBridge &&
              typeof ctx.guiBridge.sendEvent === "function"
            ) {
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
            const retryable = isRetryableActiveMissionAssignError(
              error.message,
            );
            const hasNext = index + 1 < assignmentOptions.length;
            const shouldTryNext =
              option.source === "rental" ? hasNext : retryable && hasNext;
            logDebug("assign", "assign_failed", {
              missionName: name,
              missionId: id,
              nftAccount: account,
              attempt: index + 1,
              maxAttempts: assignmentOptions.length,
              error: error.message,
              retryable,
              willRetry: shouldTryNext,
              selectedNft: nft || null,
              selectedFrom: option.source,
            });
            if (option.source === "rental") {
              if (option.listingId) {
                rentalFastRefreshFailedListings.add(String(option.listingId));
              }
              logWithTimestamp(
                `[RENTAL] ❌ ${name}: rental attempt failed: ${error.message}`,
              );
              if (!shouldTryNext) {
                startRentalFastRefresh({
                  reason: "rental_attempt_failed",
                  missionName: name,
                });
              }
            }
            if (shouldTryNext) {
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
      logDebug("assign", "auto_assign_complete", {
        reason,
        attempted: candidates.length,
        assigned,
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
      return {
        ok: true,
        attempted: candidates.length,
        assigned,
        startedMissionNames,
        startedMissionDetails,
      };
    } catch (error) {
      logWithTimestamp(`[ASSIGN] ❌ Assign check failed: ${error.message}`);
      logDebug("assign", "auto_assign_failed", {
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
      return { ok: false, attempted: 0, assigned: 0, error: error.message };
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
          const levelText =
            mission.level === null ? "" : ` lvl=${mission.level}`;
          const slotText = mission.slot === null ? "" : ` slot=${mission.slot}`;
          logWithTimestamp(
            `[WATCH] ✅ Claimed (fallback): ${mission.name}${slotText}${levelText}`,
          );
        } catch (error) {
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

  async function runWhoAmICheck() {
    try {
      const json = await mcp.mcpToolCall("who_am_i", {});
      const info = json?.structuredContent || {};
      const displayName =
        info.display_name || info.displayName || info.username || "unknown";
      const walletId = info.wallet_id || info.walletId || "unknown";
      const walletSummaryResult =
        walletId && walletId !== "unknown"
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
      ctx.currentUserWalletSummary = walletSummary;
      logDebug("check", "whoami_ok", { displayName, walletId });
      return { ok: true, displayName, walletId, walletSummary };
    } catch (error) {
      logDebug("check", "whoami_failed", { error: error.message });
      // Keep the last known wallet summary to avoid UI balance flicker when
      // who_am_i or wallet summary calls fail transiently.
      return { ok: false, displayName: "unknown", walletId: "unknown" };
    }
  }

  async function runMcpHealthCheck() {
    try {
      const json = await mcp.mcpToolCall("mcp_health", {});
      const healthOk =
        json?.structuredContent?.success ?? json?.structuredContent?.ok ?? true;
      logDebug("check", "mcp_health_ok", { healthOk });
      return { ok: true, healthOk };
    } catch (error) {
      logDebug("check", "mcp_health_failed", { error: error.message });
      return { ok: false, healthOk: false };
    }
  }

  async function refreshMissionHeaderStats({
    refreshNftCount = false,
    missionsResult = null,
  } = {}) {
    try {
      const result =
        missionsResult || (await mcp.mcpToolCall("get_user_missions", {}));
      const missions = normalizeMissionList(result);
      const progressByAssignedMissionId =
        missionProgressLookupFromResult(result);
      const computed = computeMissionStats(missions, ctx.sessionClaimedCount);

      let nftCount = ctx.currentMissionStats.nfts || 0;
      let nftAvailable = ctx.currentMissionStats.nftsAvailable || 0;
      if (refreshNftCount || missionNftByAccount.size === 0) {
        try {
          const nftResult = await mcp.mcpToolCall("get_mission_nfts", {});
          const nfts = normalizeNftList(nftResult);
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

    let stepStartedAt = Date.now();
    const whoami = await runWhoAmICheck();
    markStep("who_am_i", stepStartedAt);
    if (!whoami.ok) {
      logWithTimestamp("[CHECK] ❌ Loading data failed (not authenticated).");
      return false;
    }

    ctx.isAuthenticated = true;
    ctx.currentUserDisplayName = whoami.displayName || "unknown";
    ctx.currentUserWalletId = whoami.walletId || "unknown";

    stepStartedAt = Date.now();
    await refreshFundingWalletSummary();
    markStep("funding_wallet_summary", stepStartedAt);

    stepStartedAt = Date.now();
    await refreshMissionCatalog();
    markStep("mission_catalog", stepStartedAt);

    stepStartedAt = Date.now();
    validateConfiguredTargets();
    markStep("validate_targets", stepStartedAt);

    stepStartedAt = Date.now();
    logSelectedWatchTargetsAtStartup();
    markStep("log_targets", stepStartedAt);

    stepStartedAt = Date.now();
    const health = await runMcpHealthCheck();
    markStep("mcp_health", stepStartedAt);

    stepStartedAt = Date.now();
    const missions = await refreshMissionHeaderStats({ refreshNftCount: true });
    markStep("mission_header_stats", stepStartedAt);

    if (!health.ok || !missions.ok) {
      logWithTimestamp("[CHECK] ❌ Loading data failed.");
      return false;
    }

    const totalMs = Math.max(0, Date.now() - checkStartedAt);
    logWithTimestamp(`[CHECK] ⏱ total startup checks: ${totalMs}ms`);
    logDebug("check", "initial_checks_timing", {
      totalMs,
      steps: stepDurations,
    });
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
    refreshFundingWalletSummary,
    refreshMissionHeaderStats,
    claimClaimableMissions,
    isConfiguredTargetMission,
    filterSelectedMissions,
    logSelectedWatchTargetsAtStartup,
    autoAssignConfiguredMissions,
    stopRentalFastRefresh,
    prepareUnlockSlot4,
    prepareCooldownResetNftFromUi,
    resetCooldownNftFromUi,
    runInitialChecks,
  };
}

module.exports = {
  createChecksService,
};
