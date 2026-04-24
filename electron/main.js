"use strict";

const fs = require("fs");
const path = require("path");
const { fork, execFile } = require("child_process");
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  clipboard,
  shell,
} = require("electron");
const {
  fetchOnchainFundingWalletSummary,
} = require("../src/wallet/onchain-summary");
const { scrapeLatestCompetition } = require("./scrapeCompetitions");
const { login: mcpLogin, callTool: mcpCallTool } = require("../lib/mcp");
const {
  normalizeMissionList,
  normalizeMissionCatalogList,
  normalizeNftList,
  missionHasAssignedNft,
  missionIsActive,
} = require("../src/missions/normalize");

const ROOT_DIR = path.resolve(__dirname, "..");
const RENDERER_DEV_URL =
  process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const rendererIndexPath = path.join(ROOT_DIR, "dist", "index.html");
const DESKTOP_DEVTOOLS_ENABLED = process.env.PBP_DESKTOP_DEVTOOLS === "1";

// Force Chromium cache/session storage to a stable, writable per-user location
// on Windows to avoid "Unable to move/create cache (0x5)" startup errors.
if (process.platform === "win32") {
  try {
    const appData = app.getPath("appData");
    const stableUserData = path.join(appData, "missions-v3-mcp");
    const stableSessionData = path.join(stableUserData, "session");
    fs.mkdirSync(stableUserData, { recursive: true });
    fs.mkdirSync(stableSessionData, { recursive: true });
    app.setPath("userData", stableUserData);
    app.setPath("sessionData", stableSessionData);
  } catch {}
}

function defaultMissionResetLevel() {
  return app.isPackaged ? "11" : "6";
}

let controlWindow = null;
let cliWindow = null;
let splashWindow = null;
let backend = null;
let stopTimer = null;
let logHistory = [];
const pendingBackendRequests = new Map();
const maxLogHistory = 1200;
let fundingWalletSummaryRefreshPromise = null;
let fundingWalletSummaryLastAttemptAt = 0;
const FUNDING_WALLET_REFRESH_MIN_INTERVAL_MS = 30000;
const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
const backendStatus = {
  running: false,
  pid: null,
  exitCode: null,
  exitSignal: null,
  signerLocked: null,
  signerReady: null,
  signerMode: null,
  signerWallet: null,
  signerStatus: null,
  isAuthenticated: null,
  watcherRunning: null,
  watchLoopEnabled: null,
  currentUserDisplayName: null,
  currentUserWalletId: null,
  currentUserWalletSummary: null,
  currentMissionStats: null,
  slotUnlockSummary: null,
  currentMode: null,
  defaultMissionResetLevel: null,
  level20ResetEnabled: null,
  missionModeEnabled: null,
  currentMissionResetLevel: null,
  sessionRewardTotals: null,
  sessionSpendTotals: null,
  fundingWalletSummary: null,
  guiMissionSlots: null,
  cliWindowOpen: false,
  analytics: null,
};

const ANALYTICS_VERSION = 1;
const OUTPUT_LINE_BUFFER = { stdout: "", stderr: "", system: "", stdin: "" };

function createEmptyAnalytics() {
  return {
    version: ANALYTICS_VERSION,
    lifetime: {
      startedAt: null,
      totalClaims: 0,
      totalResets: 0,
      totalResetCostPbp: 0,
      totalLeased: 0,
      currencyEarned: { pbp: 0, tc: 0, cc: 0 },
      missionClaims: {},
      nftsUsed: [],
    },
    session: {
      startedAt: null,
      totalClaims: 0,
      totalResets: 0,
      totalResetCostPbp: 0,
      totalLeased: 0,
      currencyEarned: { pbp: 0, tc: 0, cc: 0 },
      missionClaims: {},
      nftsUsed: [],
    },
  };
}

function normalizeAnalytics(raw) {
  const empty = createEmptyAnalytics();
  const src = raw && typeof raw === "object" ? raw : {};
  const norm = {
    version: ANALYTICS_VERSION,
    lifetime: {
      startedAt:
        typeof src?.lifetime?.startedAt === "number" &&
        Number.isFinite(src.lifetime.startedAt)
          ? src.lifetime.startedAt
          : null,
      totalClaims: Number(src?.lifetime?.totalClaims || 0) || 0,
      totalResets: Number(src?.lifetime?.totalResets || 0) || 0,
      totalResetCostPbp: Number(src?.lifetime?.totalResetCostPbp || 0) || 0,
      totalLeased: Number(src?.lifetime?.totalLeased || 0) || 0,
      currencyEarned: {
        pbp: Number(src?.lifetime?.currencyEarned?.pbp || 0) || 0,
        tc: Number(src?.lifetime?.currencyEarned?.tc || 0) || 0,
        cc: Number(src?.lifetime?.currencyEarned?.cc || 0) || 0,
      },
      missionClaims:
        src?.lifetime?.missionClaims && typeof src.lifetime.missionClaims === "object"
          ? src.lifetime.missionClaims
          : {},
      nftsUsed: Array.isArray(src?.lifetime?.nftsUsed)
        ? src.lifetime.nftsUsed.map((v) => String(v || "").trim()).filter(Boolean)
        : [],
    },
    session: {
      startedAt:
        typeof src?.session?.startedAt === "number" &&
        Number.isFinite(src.session.startedAt)
          ? src.session.startedAt
          : null,
      totalClaims: Number(src?.session?.totalClaims || 0) || 0,
      totalResets: Number(src?.session?.totalResets || 0) || 0,
      totalResetCostPbp: Number(src?.session?.totalResetCostPbp || 0) || 0,
      totalLeased: Number(src?.session?.totalLeased || 0) || 0,
      currencyEarned: {
        pbp: Number(src?.session?.currencyEarned?.pbp || 0) || 0,
        tc: Number(src?.session?.currencyEarned?.tc || 0) || 0,
        cc: Number(src?.session?.currencyEarned?.cc || 0) || 0,
      },
      missionClaims:
        src?.session?.missionClaims && typeof src.session.missionClaims === "object"
          ? src.session.missionClaims
          : {},
      nftsUsed: Array.isArray(src?.session?.nftsUsed)
        ? src.session.nftsUsed.map((v) => String(v || "").trim()).filter(Boolean)
        : [],
    },
  };
  return { ...empty, ...norm };
}

function isDev() {
  return !app.isPackaged;
}

function getRendererUrl(hash = "") {
  if (isDev()) {
    return `${RENDERER_DEV_URL}/${hash ? `#${hash}` : ""}`;
  }
  return `${rendererIndexPath}${hash ? `#${hash}` : ""}`;
}

async function loadWindow(win, hash = "") {
  const target = getRendererUrl(hash);
  if (isDev()) {
    await win.loadURL(target);
    return;
  }
  await win.loadFile(rendererIndexPath, { hash });
}

function publish(channel, payload) {
  for (const win of [controlWindow, cliWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function pushOutput(stream, text) {
  const payload = {
    stream,
    text,
    at: Date.now(),
  };
  logHistory.push(payload);
  if (logHistory.length > maxLogHistory) {
    logHistory = logHistory.slice(-maxLogHistory);
  }
  publish("backend:output", payload);
  if (stream === "stdout" || stream === "stderr") {
    applyAnalyticsFromChunk(stream, text);
  }
}

function pushSystemLog(message) {
  const text = String(message || "").trim();
  if (!text) return;
  pushOutput("system", `[GUI] ${text}\n`);
}

function formatConfigValueForLog(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const preview = value.slice(0, 6).map((entry) => formatConfigValueForLog(entry));
    const suffix = value.length > 6 ? `, ... +${value.length - 6} more` : "";
    return `[${preview.join(", ")}${suffix}]`;
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      return json.length > 220 ? `${json.slice(0, 220)}...` : json;
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

function logConfigPatch(source, patch = {}) {
  const entries = Object.entries(patch || {});
  if (!entries.length) {
    pushSystemLog(`${source}: config update with no fields.`);
    return;
  }
  const summary = entries
    .map(([key, value]) => `${key}=${formatConfigValueForLog(value)}`)
    .join(", ");
  pushSystemLog(`${source}: config updated -> ${summary}`);
}

function publishStatus() {
  publish("backend:status", { ...backendStatus });
}

function updateBackendStateFromIpc(payload) {
  if (!payload || payload.type !== "pbp_state") return;
  const next = payload.state || {};
  let changed = false;
  for (const key of Object.keys(backendStatus)) {
    if (
      key === "running" ||
      key === "pid" ||
      key === "exitCode" ||
      key === "exitSignal"
    ) {
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(next, key) &&
      backendStatus[key] !== next[key]
    ) {
      backendStatus[key] = next[key];
      changed = true;
    }
  }
  if (changed) publishStatus();
}

function publishEvent(payload) {
  publish("backend:event", payload);
}

function clearStopTimer() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function getBackendWorkingDirectory() {
  return app.isPackaged ? app.getPath("userData") : ROOT_DIR;
}

function getConfigPath() {
  return path.join(getBackendWorkingDirectory(), "config.json");
}

function getAnalyticsPath() {
  return path.join(getBackendWorkingDirectory(), "data", "stats-analytics.json");
}

function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadAnalytics() {
  try {
    const raw = fs.readFileSync(getAnalyticsPath(), "utf8");
    return normalizeAnalytics(JSON.parse(raw));
  } catch {
    return createEmptyAnalytics();
  }
}

function saveAnalytics(analytics) {
  try {
    const next = normalizeAnalytics(analytics);
    const target = getAnalyticsPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(next, null, 2));
    backendStatus.analytics = next;
  } catch {}
}

function beginAnalyticsSession() {
  const current = normalizeAnalytics(backendStatus.analytics || loadAnalytics());
  if (!Number.isFinite(Number(current?.lifetime?.startedAt))) {
    current.lifetime.startedAt = Date.now();
  }
  current.session = {
    startedAt: Date.now(),
    totalClaims: 0,
    totalResets: 0,
    totalResetCostPbp: 0,
    totalLeased: 0,
    currencyEarned: { pbp: 0, tc: 0, cc: 0 },
    missionClaims: {},
    nftsUsed: [],
  };
  saveAnalytics(current);
}

function addUniqueValue(list, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return list;
  const set = new Set(Array.isArray(list) ? list : []);
  set.add(normalized);
  return Array.from(set);
}

function applyAnalyticsLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  const current = normalizeAnalytics(backendStatus.analytics || loadAnalytics());
  let changed = false;

  const claimMatch = text.match(/\[WATCH\]\s+✅\s+Claimed:\s*(.+)$/i);
  if (claimMatch) {
    const body = String(claimMatch[1] || "").trim();
    const mission = String(body.split(" slot=")[0] || "unknown mission").trim() || "unknown mission";
    const rewardMatch = body.match(/([0-9]+(?:\.[0-9]+)?)\s+([A-Z]{2,4})/);
    const amount = Number(rewardMatch?.[1] || 0);
    const token = String(rewardMatch?.[2] || "").toLowerCase();
    current.lifetime.totalClaims += 1;
    current.session.totalClaims += 1;
    current.lifetime.missionClaims[mission] =
      Number(current.lifetime.missionClaims[mission] || 0) + 1;
    current.session.missionClaims[mission] =
      Number(current.session.missionClaims[mission] || 0) + 1;
    if (Number.isFinite(amount) && amount > 0 && ["pbp", "tc", "cc"].includes(token)) {
      current.lifetime.currencyEarned[token] += amount;
      current.session.currencyEarned[token] += amount;
    }
    changed = true;
  }

  if (
    /\[RESET\]\s+✅\s+Rerolled:/i.test(text) ||
    /\[RESET\]\s+✅\s+Cooldown reset complete:/i.test(text)
  ) {
    current.lifetime.totalResets += 1;
    current.session.totalResets += 1;
    changed = true;
  }

  const spendMatch = text.match(/\[SPEND\].*-\s*([0-9]+(?:\.[0-9]+)?)\s+PBP/i);
  if (spendMatch) {
    const amount = Number(spendMatch[1] || 0);
    if (Number.isFinite(amount) && amount > 0) {
      current.lifetime.totalResetCostPbp += amount;
      current.session.totalResetCostPbp += amount;
      changed = true;
    }
  }

  if (/started rental lease/i.test(text)) {
    current.lifetime.totalLeased += 1;
    current.session.totalLeased += 1;
    changed = true;
  }

  const nftMatches = [];
  const nftEq = text.match(/nft=([^\s,]+)/i);
  if (nftEq && nftEq[1]) nftMatches.push(String(nftEq[1]).trim());
  const nftAccountEq = text.match(/nftAccount=([^\s,]+)/i);
  if (nftAccountEq && nftAccountEq[1]) nftMatches.push(String(nftAccountEq[1]).trim());
  const assignedText = text.match(/Assigned NFT\s+([A-Za-z0-9]+)/i);
  if (assignedText && assignedText[1]) nftMatches.push(String(assignedText[1]).trim());

  for (const nft of nftMatches) {
    if (!nft) continue;
    const nextLifetime = addUniqueValue(current.lifetime.nftsUsed, nft);
    const nextSession = addUniqueValue(current.session.nftsUsed, nft);
    if (
      nextLifetime.length !== current.lifetime.nftsUsed.length ||
      nextSession.length !== current.session.nftsUsed.length
    ) {
      current.lifetime.nftsUsed = nextLifetime;
      current.session.nftsUsed = nextSession;
      changed = true;
    }
  }

  if (changed) {
    saveAnalytics(current);
    publishStatus();
  }
  return changed;
}

function applyAnalyticsFromChunk(stream, chunkText) {
  const key = String(stream || "stdout");
  const prefix = String(OUTPUT_LINE_BUFFER[key] || "");
  const merged = `${prefix}${String(chunkText || "")}`;
  const lines = merged.split(/\r?\n/);
  OUTPUT_LINE_BUFFER[key] = lines.pop() || "";
  for (const line of lines) {
    applyAnalyticsLine(line);
  }
}

function flushAnalyticsBuffers() {
  for (const key of Object.keys(OUTPUT_LINE_BUFFER)) {
    const pending = String(OUTPUT_LINE_BUFFER[key] || "").trim();
    if (pending) applyAnalyticsLine(pending);
    OUTPUT_LINE_BUFFER[key] = "";
  }
}

function applyDesktopConfigPatch(patch = {}) {
  const next = {
    ...readDesktopConfig(),
    ...patch,
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2));
  return next;
}

function hydrateBackendStatusFromConfig() {
  const config = readDesktopConfig();
  backendStatus.analytics = loadAnalytics();
  backendStatus.defaultMissionResetLevel = defaultMissionResetLevel();
  if (typeof config.level20ResetEnabled === "boolean") {
    backendStatus.level20ResetEnabled = config.level20ResetEnabled;
  }
  if (typeof config.missionModeEnabled === "boolean") {
    backendStatus.missionModeEnabled = config.missionModeEnabled;
  }
  if (typeof config.missionResetLevel === "string") {
    backendStatus.currentMissionResetLevel = config.missionResetLevel;
  }
  if (!backendStatus.currentMissionResetLevel) {
    backendStatus.currentMissionResetLevel = defaultMissionResetLevel();
  }
  backendStatus.currentMode = backendStatus.missionModeEnabled
    ? `mission-${backendStatus.currentMissionResetLevel || defaultMissionResetLevel()}`
    : "normal";
}

// Note: MCP `get_wallet_summary` is identity-based (no args) and returns the
// authenticated wallet. For the generated app-wallet funding address we always
// use an on-chain lookup via `fetchOnchainFundingWalletSummary`.

function extractBalanceNumber(balances, matcher) {
  const entries = Array.isArray(balances) ? balances : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const symbol = String(entry.symbol || entry.key || "")
      .trim()
      .toUpperCase();
    const name = String(entry.name || "")
      .trim()
      .toUpperCase();
    if (!matcher({ symbol, name, entry })) continue;
    const raw = entry.displayBalance ?? entry.balance ?? null;
    const n =
      typeof raw === "string" ? Number(raw.replace(/[, _]/g, "")) : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeRemoteImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^data:image\//i.test(value)) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  if (/^gateway\.irys\.xyz\//i.test(value)) return `https://${value}`;
  if (/^ipfs:\/\//i.test(value)) {
    return `https://ipfs.io/ipfs/${value.replace(/^ipfs:\/\//i, "")}`;
  }
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[0-9a-z]{20,})$/i.test(value)) {
    return `https://ipfs.io/ipfs/${value}`;
  }
  return null;
}

function deepFindRemoteImageUrl(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (typeof node === "string") return normalizeRemoteImageUrl(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindRemoteImageUrl(item, depth + 1);
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
    "media",
    "uri",
  ];
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const found = deepFindRemoteImageUrl(node[key], depth + 1);
    if (found) return found;
  }

  for (const [key, value] of Object.entries(node)) {
    if (/image|thumbnail|media|cdn|uri/i.test(String(key))) {
      const found = deepFindRemoteImageUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function deriveCooldownSeconds(entry) {
  const direct = Number(
    entry?.cooldownSeconds ?? entry?.cooldown_seconds ?? entry?.cooldown ?? NaN,
  );
  if (Number.isFinite(direct)) return Math.max(0, direct);

  const endsAtRaw =
    entry?.cooldownEndsAt ??
    entry?.cooldown_ends_at ??
    entry?.cooldownEndAt ??
    entry?.cooldown_end_at ??
    null;
  const endsAtMs = endsAtRaw ? new Date(endsAtRaw).getTime() : NaN;
  if (Number.isFinite(endsAtMs)) {
    return Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
  }
  return 0;
}

function normalizeWalletBalanceEntries(raw = []) {
  if (Array.isArray(raw)) {
    return raw.filter((entry) => entry && typeof entry === "object");
  }
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([symbol, balance]) => {
    const amount = Number(balance);
    return {
      key: String(symbol || "")
        .trim()
        .toLowerCase(),
      symbol: String(symbol || "")
        .trim()
        .toUpperCase(),
      name: String(symbol || "")
        .trim()
        .toUpperCase(),
      mint: null,
      balance: Number.isFinite(amount) ? amount : null,
      displayBalance: Number.isFinite(amount)
        ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : null,
    };
  });
}

function summarizeWalletPayload(payload) {
  const sc = payload?.structuredContent || {};
  const walletId = sc.walletId || sc.wallet_id || null;
  const displayName = sc.displayName || sc.display_name || null;
  const baseBalances = normalizeWalletBalanceEntries(
    sc.balances || sc.walletBalances || sc.wallet_balances || [],
  );
  const virtualCurrencies = sc.virtualCurrencies || sc.virtual_currencies || {};
  const virtualCurrencyBalances = Object.entries(virtualCurrencies)
    .map(([symbol, balance]) => ({
      key: String(symbol || "")
        .trim()
        .toLowerCase(),
      symbol: String(symbol || "")
        .trim()
        .toUpperCase(),
      name: String(symbol || "")
        .trim()
        .toUpperCase(),
      mint: null,
      balance: Number(balance),
      displayBalance: Number(balance).toLocaleString(undefined, {
        maximumFractionDigits: 2,
      }),
    }))
    .filter((entry) => entry.key && Number.isFinite(entry.balance));
  const mergedBalances = [...baseBalances, ...virtualCurrencyBalances];
  const sol = extractBalanceNumber(
    mergedBalances,
    ({ symbol, name }) => symbol === "SOL" || name === "SOL",
  );
  const pbp = extractBalanceNumber(
    mergedBalances,
    ({ symbol, name }) => symbol === "PBP" || name === "PBP",
  );
  return {
    walletId,
    displayName,
    currentUserWalletSummary: {
      walletId,
      displayName,
      balances: mergedBalances,
      walletBalanceSummary: Array.isArray(sc.walletBalanceSummary)
        ? sc.walletBalanceSummary
        : Array.isArray(sc.wallet_balance_summary)
          ? sc.wallet_balance_summary
          : [],
    },
    fundingWalletSummary: {
      address: sc.walletAddress || sc.wallet_address || null,
      sol,
      pbp,
      status: "ok",
      source: "mcp",
    },
  };
}

function missionDisplayName(mission = {}) {
  return (
    mission?.missionName ||
    mission?.name ||
    mission?.title ||
    mission?.mission ||
    mission?.label ||
    "Unknown mission"
  );
}

function missionRewardLabel(mission = {}) {
  const direct = mission?.reward || mission?.rewards || mission?.rewardText;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object") {
    const nestedAmount =
      direct?.amount ??
      direct?.value ??
      direct?.rewardAmount ??
      direct?.prizeAmount ??
      null;
    const nestedSymbol =
      direct?.symbol ??
      direct?.token ??
      direct?.currency ??
      direct?.rewardSymbol ??
      direct?.prize ??
      null;
    const nestedN = Number(nestedAmount);
    const nestedS = String(nestedSymbol || "").trim();
    if (Number.isFinite(nestedN) && nestedS) {
      return `${nestedN.toLocaleString()} ${nestedS}`;
    }
    if (Number.isFinite(nestedN)) return nestedN.toLocaleString();
  }
  if (Array.isArray(mission?.rewards)) {
    const rewardText = mission.rewards
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string" && entry.trim()) return entry.trim();
        if (typeof entry !== "object") return null;
        const amount =
          entry?.amount ??
          entry?.value ??
          entry?.rewardAmount ??
          entry?.prizeAmount ??
          null;
        const symbol =
          entry?.symbol ??
          entry?.token ??
          entry?.currency ??
          entry?.rewardSymbol ??
          entry?.prize ??
          null;
        const n = Number(amount);
        const s = String(symbol || "").trim();
        if (Number.isFinite(n) && s) return `${n.toLocaleString()} ${s}`;
        if (Number.isFinite(n)) return n.toLocaleString();
        return null;
      })
      .filter(Boolean)
      .join(" + ");
    if (rewardText) return rewardText;
  }
  const amount =
    mission?.rewardAmount ??
    mission?.reward_amount ??
    mission?.tokenReward ??
    mission?.token_reward ??
    mission?.prizeAmount ??
    mission?.prize_amount ??
    mission?.amount ??
    null;
  const symbol =
    mission?.rewardSymbol ??
    mission?.reward_symbol ??
    mission?.tokenSymbol ??
    mission?.token_symbol ??
    mission?.prize ??
    mission?.rewardToken ??
    mission?.prizeToken ??
    mission?.currency ??
    mission?.currencySymbol ??
    null;
  const n = Number(amount);
  const s = String(symbol || "").trim();
  if (Number.isFinite(n) && s) {
    return `${n.toLocaleString()} ${s}`;
  }
  if (Number.isFinite(n)) return n.toLocaleString();
  return null;
}

function missionCollectionEntries(mission = {}) {
  const rawCandidates = [
    mission?.collections,
    mission?.collection,
    mission?.validCollections,
    mission?.valid_collections,
    mission?.allowedCollections,
    mission?.allowed_collections,
    mission?.eligibleCollections,
    mission?.eligible_collections,
    mission?.supportedCollections,
    mission?.supported_collections,
    mission?.nftCollections,
    mission?.nft_collections,
    mission?.requirements?.collections,
    mission?.requirements?.allowedCollections,
    mission?.requirements?.allowed_collections,
    mission?.meta?.collections,
    mission?.meta?.allowedCollections,
    Array.isArray(mission?.levels)
      ? mission.levels.map(
          (level) =>
            level?.validCollections ||
            level?.valid_collections ||
            level?.collections ||
            null,
        )
      : null,
  ];
  const out = [];
  const seen = new Set();
  const pushOne = (entry) => {
    if (!entry) return;
    const name =
      typeof entry === "string"
        ? entry
        : entry?.name || entry?.title || entry?.collection || entry?.symbol;
    const s = String(name || "").trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const image =
      typeof entry === "object"
        ? entry?.image ||
          entry?.imageUrl ||
          entry?.image_url ||
          entry?.logo ||
          entry?.icon ||
          null
        : null;
    out.push({ name: s, image: image ? String(image) : null });
  };
  const flatten = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const v of value) flatten(v);
      return;
    }
    if (typeof value === "string") {
      const parts = value
        .split(/[,|/]/g)
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) pushOne(p);
      } else {
        pushOne(value);
      }
      return;
    }
    if (typeof value === "object") {
      pushOne(value);
      return;
    }
  };
  for (const candidate of rawCandidates) flatten(candidate);
  return out;
}

function isAuthFailureMessage(message) {
  return /401|403|unauthorized|forbidden|missing token|invalid token/i.test(
    String(message || ""),
  );
}

async function runOnboardingPopupLogin({
  url = "https://pixelbypixel.studio/mcp",
  timeoutMs = 30000,
  loginTimeoutMs = 180000,
} = {}) {
  await mcpLogin({
    url,
    noBrowser: false,
    printAuthUrl: false,
    timeoutMs,
    loginTimeoutMs,
  });
}

function installMinimalApplicationMenu() {
  const template = isDev()
    ? [
        ...(process.platform === "darwin"
          ? [
              {
                label: app.name,
                submenu: [
                  { role: "about" },
                  { type: "separator" },
                  { role: "services" },
                  { type: "separator" },
                  { role: "hide" },
                  { role: "hideOthers" },
                  { role: "unhide" },
                  { type: "separator" },
                  { role: "quit" },
                ],
              },
            ]
          : []),
        {
          label: "File",
          submenu: [
            ...(process.platform === "darwin"
              ? [{ role: "close" }]
              : [{ role: "quit" }]),
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { type: "separator" },
            { role: "toggleDevTools" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            ...(process.platform === "darwin"
              ? [{ type: "separator" }, { role: "front" }, { role: "window" }]
              : [{ role: "close" }]),
          ],
        },
      ]
    : process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "File",
            submenu: [{ role: "close" }],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Window",
            submenu: [
              { role: "minimize" },
              { role: "close" },
              { type: "separator" },
              { role: "front" },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [{ role: "quit" }],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
          },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenWindow(win) {
  const hideMenuBar = !isDev();
  if (typeof win.setMenuBarVisibility === "function") {
    win.setMenuBarVisibility(!hideMenuBar);
  }
  if (typeof win.setAutoHideMenuBar === "function") {
    win.setAutoHideMenuBar(hideMenuBar);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (!isDev()) {
    win.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      const blockedDevtools =
        key === "f12" ||
        ((input.control || input.meta) &&
          input.shift &&
          (key === "i" || key === "j" || key === "c"));
      const blockedReload =
        key === "f5" || ((input.control || input.meta) && key === "r");
      if (blockedDevtools || blockedReload) {
        event.preventDefault();
      }
    });
    win.webContents.on("context-menu", (event) => {
      event.preventDefault();
    });
  }
}

function startBackend() {
  if (backendStatus.running && backend) {
    return { ...backendStatus };
  }

  logHistory = [];
  backend = fork(path.join(ROOT_DIR, "app.js"), ["--plain-output"], {
    cwd: getBackendWorkingDirectory(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PBP_GUI_BRIDGE: "1",
      PBP_CONFIG_DIR: getBackendWorkingDirectory(),
      PBP_DEFAULT_MISSION_RESET_LEVEL: defaultMissionResetLevel(),
      FORCE_COLOR: "0",
    },
    silent: true,
  });

  backendStatus.running = true;
  backendStatus.pid = backend.pid;
  backendStatus.exitCode = null;
  backendStatus.exitSignal = null;
  backendStatus.signerLocked = null;
  backendStatus.signerReady = null;
  backendStatus.signerMode = null;
  backendStatus.signerWallet = null;
  backendStatus.signerStatus = null;
  backendStatus.isAuthenticated = null;
  backendStatus.watcherRunning = null;
  backendStatus.watchLoopEnabled = null;
  backendStatus.currentUserDisplayName = null;
  backendStatus.currentUserWalletId = null;
  backendStatus.currentUserWalletSummary = null;
  backendStatus.currentMissionStats = null;
  backendStatus.currentMode = null;
  backendStatus.level20ResetEnabled = null;
  backendStatus.missionModeEnabled = null;
  backendStatus.currentMissionResetLevel = null;
  backendStatus.sessionRewardTotals = null;
  backendStatus.sessionSpendTotals = null;
  backendStatus.fundingWalletSummary = null;
  backendStatus.guiMissionSlots = null;
  backendStatus.slotUnlockSummary = null;
  beginAnalyticsSession();
  publishStatus();
  pushOutput("system", "[GUI] Backend started.\n");

  backend.stdout.on("data", (chunk) => {
    pushOutput("stdout", chunk.toString("utf8"));
  });

  backend.stderr.on("data", (chunk) => {
    pushOutput("stderr", chunk.toString("utf8"));
  });

  backend.on("message", (message) => {
    updateBackendStateFromIpc(message);
    if (message && message.type === "pbp_event") {
      if (message.event === "app_quit") {
        try {
          stopBackend();
        } catch {}
        // Quit the entire desktop app (not just the backend runner).
        setTimeout(() => {
          try {
            app.quit();
          } catch {}
        }, 50);
        return;
      }
      publishEvent(message);
    }
    if (message && message.type === "pbp_response") {
      const requestId = String(message.requestId || "");
      const pending = requestId ? pendingBackendRequests.get(requestId) : null;
      if (pending) {
        pendingBackendRequests.delete(requestId);
        try {
          pending.resolve(message.payload);
        } catch {}
      }
    }
  });

  backend.on("exit", (code, signal) => {
    flushAnalyticsBuffers();
    clearStopTimer();
    backendStatus.running = false;
    backendStatus.pid = null;
    backendStatus.exitCode = code;
    backendStatus.exitSignal = signal;
    backendStatus.currentMissionStats = null;
    backendStatus.guiMissionSlots = null;
    backendStatus.slotUnlockSummary = null;
    backend = null;
    pushOutput(
      "system",
      `[GUI] Backend exited (code=${code ?? "null"}, signal=${signal ?? "null"}).\n`,
    );
    publishStatus();
  });

  backend.on("error", (error) => {
    pushOutput("stderr", `[GUI] Backend error: ${error.message}\n`);
  });

  return { ...backendStatus };
}

function stopBackend() {
  if (!backend || !backendStatus.running) {
    return { ...backendStatus };
  }

  pushOutput("system", "[GUI] Stopping backend...\n");
  flushAnalyticsBuffers();
  backendStatus.currentMissionStats = null;
  backendStatus.guiMissionSlots = null;
  backendStatus.slotUnlockSummary = null;
  publishStatus();
  backend.kill("SIGTERM");
  clearStopTimer();
  stopTimer = setTimeout(() => {
    if (backend && backendStatus.running) {
      pushOutput(
        "system",
        "[GUI] Backend did not exit in time; forcing stop.\n",
      );
      backend.kill("SIGKILL");
    }
  }, 4000);
  return { ...backendStatus };
}

async function waitForBackendStdinWritable(timeoutMs = 1500) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 1500);
  while (Date.now() < deadline) {
    if (
      backend &&
      backendStatus.running &&
      backend.stdin &&
      backend.stdin.writable &&
      !backend.stdin.destroyed
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Boolean(
    backend &&
    backendStatus.running &&
    backend.stdin &&
    backend.stdin.writable &&
    !backend.stdin.destroyed,
  );
}

function parseStoppedModeCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return { type: "none" };
  const parts = trimmed.split(/\s+/);
  const cmd = String(parts[0] || "").toLowerCase();
  const arg = String(parts[1] || "").toLowerCase();

  if (cmd === "start") {
    return { type: "start" };
  }

  if (cmd === "20r") {
    if (parts.length === 1) return { type: "20r", mode: "toggle" };
    if (arg === "on" || arg === "off") return { type: "20r", mode: arg };
    return { type: "invalid20r" };
  }

  if (cmd === "mm") {
    if (parts.length === 1) return { type: "mm", mode: "toggle" };
    if (arg === "on" || arg === "off") return { type: "mm", mode: arg };
    const level = Number(parts[1]);
    if (Number.isFinite(level) && level > 0) {
      return { type: "mm", mode: "level", level: Math.floor(level) };
    }
    return { type: "invalidMm" };
  }

  return { type: "other" };
}

function applyStoppedModeConfig(parsed) {
  const current = readDesktopConfig();
  const patch = {};

  if (parsed.type === "20r") {
    const previous = current.level20ResetEnabled === true;
    const nextEnabled =
      parsed.mode === "toggle" ? !previous : parsed.mode === "on";
    patch.level20ResetEnabled = nextEnabled;
    patch.missionModeEnabled = nextEnabled
      ? false
      : current.missionModeEnabled === true;
  }

  if (parsed.type === "mm") {
    const previous = current.missionModeEnabled === true;
    let nextMissionEnabled = previous;
    if (parsed.mode === "toggle") nextMissionEnabled = !previous;
    if (parsed.mode === "on") nextMissionEnabled = true;
    if (parsed.mode === "off") nextMissionEnabled = false;
    if (parsed.mode === "level") {
      nextMissionEnabled = true;
      patch.missionResetLevel = String(parsed.level);
    }
    patch.missionModeEnabled = nextMissionEnabled;
    patch.level20ResetEnabled = nextMissionEnabled
      ? false
      : current.level20ResetEnabled === true;
    if (nextMissionEnabled && typeof patch.missionResetLevel !== "string") {
      patch.missionResetLevel = String(
        current.missionResetLevel || defaultMissionResetLevel(),
      );
    }
  }

  const next = applyDesktopConfigPatch(patch);
  if (typeof next.level20ResetEnabled === "boolean") {
    backendStatus.level20ResetEnabled = next.level20ResetEnabled;
  }
  if (typeof next.missionModeEnabled === "boolean") {
    backendStatus.missionModeEnabled = next.missionModeEnabled;
  }
  if (typeof next.missionResetLevel === "string") {
    backendStatus.currentMissionResetLevel = next.missionResetLevel;
  }
  backendStatus.currentMode = backendStatus.missionModeEnabled
    ? `mission-${backendStatus.currentMissionResetLevel || defaultMissionResetLevel()}`
    : "normal";
  publishStatus();
}

async function sendBackendCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) {
    throw new Error("Command is empty.");
  }
  if (!backend || !backendStatus.running) {
    const parsed = parseStoppedModeCommand(trimmed);
    if (parsed.type === "start") {
      startBackend();
    } else if (parsed.type === "20r" || parsed.type === "mm") {
      applyStoppedModeConfig(parsed);
      pushOutput("stdin", `> ${trimmed}\n`);
      pushOutput(
        "system",
        `[GUI] Saved mode setting while runner is stopped.\n`,
      );
      return true;
    } else if (parsed.type === "invalid20r") {
      throw new Error("Usage: 20r [on|off]");
    } else if (parsed.type === "invalidMm") {
      throw new Error("Usage: mm [off|on|<level>]");
    } else {
      throw new Error("Backend is not running. Use 'start' to launch it.");
    }
  }
  const ready = await waitForBackendStdinWritable();
  if (!ready) {
    throw new Error("Backend is not running.");
  }
  backend.stdin.write(`${trimmed}\n`);
  pushOutput("stdin", `> ${trimmed}\n`);
  return true;
}

async function requestBackend(action, payload = {}, options = {}) {
  const ensureRunning = options?.ensureRunning === true;
  pushSystemLog(
    `Backend request: ${action}${ensureRunning ? " (auto-start allowed)" : ""}.`,
  );
  if ((!backend || !backendStatus.running) && ensureRunning) {
    startBackend();
  }
  if (!backend || !backendStatus.running) {
    pushSystemLog(`Backend request failed: ${action} -> backend is not running.`);
    throw new Error("Backend is not running.");
  }
  const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const timeoutMs =
    Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBackendRequests.delete(requestId);
      pushSystemLog(`Backend request timed out: ${action}.`);
      reject(new Error(`backend request timeout: ${action}`));
    }, timeoutMs);
    pendingBackendRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        pushSystemLog(`Backend request complete: ${action}.`);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        pushSystemLog(
          `Backend request failed: ${action} -> ${String(err?.message || err)}`,
        );
        reject(err);
      },
    });
    backend.send({ type: "pbp_request", requestId, action, payload });
  });
}

async function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 800,
    height: 800,
    minWidth: 800,
    minHeight: 800,
    maxWidth: 800,
    maxHeight: 800,
    title: "missions-v3-mcp",
    backgroundColor: "#0b1116",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -100, y: -100 },
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DESKTOP_DEVTOOLS_ENABLED,
    },
  });

  controlWindow.on("closed", () => {
    controlWindow = null;
  });

  hardenWindow(controlWindow);
  await loadWindow(controlWindow);
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 800,
    height: 800,
    // above resized from 8x8
    minWidth: 800,
    minHeight: 800,
    maxWidth: 800,
    maxHeight: 800,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#0b1116",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashBgCandidates = [
    path.join(ROOT_DIR, "renderer", "src", "img", "back.png"),
    ...(() => {
      const assetsDir = path.join(ROOT_DIR, "dist", "assets");
      if (!fs.existsSync(assetsDir)) return [];
      try {
        return fs
          .readdirSync(assetsDir)
          .filter((name) => /^back-.*\.png$/i.test(name))
          .map((name) => path.join(assetsDir, name));
      } catch {
        return [];
      }
    })(),
  ];
  let splashBgDataUrl = "";
  for (const candidate of splashBgCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const b64 = fs.readFileSync(candidate).toString("base64");
      splashBgDataUrl = `data:image/png;base64,${b64}`;
      break;
    } catch {}
  }

  const splashHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background-color: #0b1116;
        ${splashBgDataUrl ? `background-image: url("${splashBgDataUrl}");` : ""}
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        color: #cfe6f5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wrap {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        opacity: 0.92;
      }
      .spinner {
        width: 20px;
        height: 20px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.18);
        border-top-color: rgba(127, 191, 233, 0.95);
        animation: spin 700ms linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="row">
        <div class="spinner"></div>
        <div>Draining pixel's wallets...</div>
      </div>
    </div>
  </body>
</html>`;

  splashWindow.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`,
  );
}

async function createCliWindow() {
  if (cliWindow && !cliWindow.isDestroyed()) {
    backendStatus.cliWindowOpen = true;
    publishStatus();
    publishEvent({ type: "cli_window_state", open: true });
    cliWindow.focus();
    return;
  }

  cliWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 720,
    minHeight: 520,
    title: "missions-v3-mcp CLI",
    backgroundColor: "#061017",
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: -100, y: -100 },
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DESKTOP_DEVTOOLS_ENABLED,
    },
  });

  cliWindow.on("closed", () => {
    cliWindow = null;
    backendStatus.cliWindowOpen = false;
    publishStatus();
    publishEvent({ type: "cli_window_state", open: false });
  });

  hardenWindow(cliWindow);
  backendStatus.cliWindowOpen = true;
  publishStatus();
  publishEvent({ type: "cli_window_state", open: true });
  await loadWindow(cliWindow, "/cli");
}

app.whenReady().then(async () => {
  installMinimalApplicationMenu();
  ipcMain.handle("backend:start", async () => startBackend());
  ipcMain.handle("backend:stop", async () => stopBackend());
  ipcMain.handle("backend:send-command", async (_event, command) =>
    sendBackendCommand(command),
  );
  ipcMain.handle("backend:get-state", async () => ({
    status: { ...backendStatus },
    logs: logHistory,
  }));
  ipcMain.handle("config:get", async () => ({
    config: readDesktopConfig(),
  }));
  ipcMain.handle("config:update", async (_event, patch) => {
    const requestedPatch =
      patch && typeof patch === "object" ? { ...patch } : {};
    const next = applyDesktopConfigPatch(patch || {});
    if (typeof next.level20ResetEnabled === "boolean") {
      backendStatus.level20ResetEnabled = next.level20ResetEnabled;
    }
    if (typeof next.missionModeEnabled === "boolean") {
      backendStatus.missionModeEnabled = next.missionModeEnabled;
    }
    if (typeof next.missionResetLevel === "string") {
      backendStatus.currentMissionResetLevel = next.missionResetLevel;
    }
    if (next.currentUserWalletSummary !== undefined) {
      backendStatus.currentUserWalletSummary = next.currentUserWalletSummary;
    }
    if (next.sessionRewardTotals !== undefined) {
      backendStatus.sessionRewardTotals = next.sessionRewardTotals;
    }
    backendStatus.currentMode = backendStatus.missionModeEnabled
      ? `mission-${backendStatus.currentMissionResetLevel || defaultMissionResetLevel()}`
      : "normal";
    logConfigPatch("Desktop", requestedPatch);
    publishStatus();
    return { config: next, status: { ...backendStatus } };
  });
  ipcMain.handle("wallet:refresh-summary", async () => {
    const now = Date.now();
    if (fundingWalletSummaryRefreshPromise) {
      pushSystemLog("Funding wallet summary refresh coalesced: request already in flight.");
      return fundingWalletSummaryRefreshPromise;
    }
    if (
      backendStatus.fundingWalletSummary &&
      now - fundingWalletSummaryLastAttemptAt <
        FUNDING_WALLET_REFRESH_MIN_INTERVAL_MS
    ) {
      pushSystemLog("Funding wallet summary refresh skipped: recent summary already available.");
      return {
        walletId: null,
        displayName: null,
        fundingWalletSummary: backendStatus.fundingWalletSummary,
        skipped: true,
      };
    }
    fundingWalletSummaryLastAttemptAt = now;
    pushSystemLog("Funding wallet summary refresh requested.");
    const config = readDesktopConfig();
    const walletAddress =
      String(
        config?.signer?.walletAddress || config?.signer?.wallet || "",
      ).trim() ||
      String(config?.walletAddress || "").trim() ||
      null;
    if (!walletAddress) {
      pushSystemLog("Funding wallet summary refresh skipped: no wallet address set.");
      backendStatus.fundingWalletSummary = null;
      backendStatus.signerMode = config.signerMode || backendStatus.signerMode;
      publishStatus();
      return { walletId: null, displayName: null, fundingWalletSummary: null };
    }
    fundingWalletSummaryRefreshPromise = (async () => {
      try {
        const rpcSummary = await fetchOnchainFundingWalletSummary(walletAddress);
        const summary = {
          walletId: null,
          displayName: null,
          fundingWalletSummary: rpcSummary,
        };
        backendStatus.signerMode = config.signerMode || backendStatus.signerMode;
        backendStatus.fundingWalletSummary = summary.fundingWalletSummary;
        pushSystemLog("Funding wallet summary refresh complete.");
        publishStatus();
        return summary;
      } catch (error) {
        // Don't crash the renderer on RPC rate limits; keep the last known good summary.
        pushSystemLog(
          `Funding wallet summary refresh failed: ${String(error?.message || error)}`,
        );
        publishStatus();
        return {
          walletId: null,
          displayName: null,
          fundingWalletSummary: backendStatus.fundingWalletSummary || null,
          error: String(error?.message || error),
        };
      } finally {
        fundingWalletSummaryRefreshPromise = null;
      }
    })();
    return fundingWalletSummaryRefreshPromise;
  });
  ipcMain.handle("wallet:bootstrap-summary", async () => {
    pushSystemLog("Bootstrap wallet summary requested.");
    const fetchBootstrap = async () => {
      const config = readDesktopConfig();
      const configuredFundingAddress = String(
        config?.signer?.walletAddress ||
          config?.signer?.wallet ||
          config?.walletAddress ||
          "",
      )
        .trim()
        .toLowerCase();
      const walletSummaryResult = await mcpCallTool(
        "get_wallet_summary",
        {},
        {
          url: "https://pixelbypixel.studio/mcp",
        },
      );
      const summary = summarizeWalletPayload(walletSummaryResult);
      const summaryWalletId = String(summary?.walletId || "")
        .trim()
        .toLowerCase();
      const looksLikeFundingWallet =
        Boolean(configuredFundingAddress) &&
        Boolean(summaryWalletId) &&
        configuredFundingAddress === summaryWalletId;
      if (summary?.currentUserWalletSummary && !looksLikeFundingWallet) {
        backendStatus.currentUserWalletSummary =
          summary.currentUserWalletSummary;
      }
      publishStatus();
      return {
        ok: true,
        summary,
        skippedMainWalletUpdate: looksLikeFundingWallet,
      };
    };
    try {
      const result = await fetchBootstrap();
      pushSystemLog("Bootstrap wallet summary complete.");
      return result;
    } catch (error) {
      if (!isAuthFailureMessage(error?.message)) {
        pushSystemLog(
          `Bootstrap wallet summary failed: ${String(error?.message || error)}`,
        );
        return {
          ok: false,
          error: String(error?.message || error),
          summary: {
            currentUserWalletSummary:
              backendStatus.currentUserWalletSummary || null,
            fundingWalletSummary: backendStatus.fundingWalletSummary || null,
          },
        };
      }
      pushSystemLog("Bootstrap wallet summary requires login. Opening browser login.");
      await runOnboardingPopupLogin({
        url: "https://pixelbypixel.studio/mcp",
        timeoutMs: 30000,
        loginTimeoutMs: 180000,
      });
      const result = await fetchBootstrap();
      pushSystemLog("Bootstrap wallet summary complete after login.");
      return result;
    }
  });
  ipcMain.handle("signer:reveal-backup", async () => {
    pushSystemLog("Reveal app wallet backup requested.");
    const payload = await requestBackend(
      "signer_reveal_backup",
      {},
      {
        ensureRunning: true,
        timeoutMs: 12000,
      },
    );
    return payload;
  });
  ipcMain.handle("signer:create-generated-wallet", async () => {
    pushSystemLog("Create generated app wallet requested.");
    const payload = await requestBackend("signer_create_generated_wallet", {});
    return payload;
  });
  ipcMain.handle("onboarding:fetch-account", async () => {
    pushSystemLog("Onboarding account sync started.");
    const emitProgress = (progress, phase, message) => {
      publishEvent({
        type: "onboarding_progress",
        progress: Math.max(0, Math.min(100, Number(progress) || 0)),
        phase: String(phase || "").trim() || "unknown",
        message: String(message || "").trim() || null,
      });
    };

    emitProgress(5, "start", "Starting account sync");
    const loadAccount = async () => {
      pushSystemLog("Onboarding sync: fetching who_am_i.");
      emitProgress(35, "whoami", "Fetching profile");
      const who = await mcpCallTool(
        "who_am_i",
        {},
        {
          url: "https://pixelbypixel.studio/mcp",
        },
      );
      pushSystemLog("Onboarding sync: fetching get_user_missions.");
      emitProgress(65, "missions", "Fetching missions");
      const missionsResult = await mcpCallTool(
        "get_user_missions",
        {},
        {
          url: "https://pixelbypixel.studio/mcp",
        },
      );
      pushSystemLog("Onboarding sync: fetching get_mission_catalog.");
      emitProgress(85, "catalog", "Fetching mission catalog");
      const catalogResult = await mcpCallTool(
        "get_mission_catalog",
        {},
        {
          url: "https://pixelbypixel.studio/mcp",
        },
      );
      pushSystemLog("Onboarding sync: fetching get_mission_nfts.");
      emitProgress(92, "nfts", "Fetching wallet collections");
      const nftResult = await mcpCallTool(
        "get_mission_nfts",
        {},
        {
          url: "https://pixelbypixel.studio/mcp",
        },
      );
      return { who, missionsResult, catalogResult, nftResult };
    };

    let loaded = null;
    try {
      loaded = await loadAccount();
    } catch (error) {
      if (!isAuthFailureMessage(error?.message)) throw error;
      pushSystemLog("Onboarding sync requires login. Opening browser login.");
      emitProgress(20, "login", "Login required");
      await runOnboardingPopupLogin({
        url: "https://pixelbypixel.studio/mcp",
        timeoutMs: 30000,
        loginTimeoutMs: 180000,
      });
      emitProgress(30, "login_complete", "Login complete");
      pushSystemLog("Onboarding login complete. Resuming account sync.");
      loaded = await loadAccount();
    }

    const who = loaded?.who || {};
    const whoInfo = who?.structuredContent || {};
    const displayName =
      whoInfo.display_name ||
      whoInfo.displayName ||
      whoInfo.username ||
      "unknown";
    const walletId = whoInfo.wallet_id || whoInfo.walletId || "unknown";

    const missions = normalizeMissionList(loaded?.missionsResult || {}).map(
      (mission, index) => ({
        id:
          mission?.assignedMissionId ||
          mission?.assigned_mission_id ||
          mission?.id ||
          mission?.missionId ||
          `${index}`,
        catalogMissionId:
          mission?.missionId ||
          mission?.mission_id ||
          mission?.catalogMissionId ||
          mission?.catalog_mission_id ||
          null,
        name: missionDisplayName(mission),
        currentLevel: Number.isFinite(Number(mission?.current_level))
          ? Number(mission.current_level)
          : Number.isFinite(Number(mission?.level))
            ? Number(mission.level)
            : null,
        slot: Number.isFinite(Number(mission?.slot))
          ? Number(mission.slot)
          : null,
        hasAssignedNft: missionHasAssignedNft(mission),
        isActive: missionIsActive(mission),
        image:
          mission?.assignedNftImage ||
          mission?.nftImage ||
          mission?.imageUrl ||
          mission?.image ||
          null,
        reward: missionRewardLabel(mission),
        collections: missionCollectionEntries(mission),
      }),
    );

    const rawCatalog = normalizeMissionCatalogList(loaded?.catalogResult || {});
    const dedup = new Map();
    for (let index = 0; index < rawCatalog.length; index += 1) {
      const mission = rawCatalog[index] || {};
      const name = missionDisplayName(mission);
      const key = name.toLowerCase().trim();
      if (!key || dedup.has(key)) continue;
      dedup.set(key, {
        id:
          mission?.id ||
          mission?.missionId ||
          mission?.mission_id ||
          mission?.name ||
          mission?.title ||
          `${index}`,
        name,
        reward: missionRewardLabel(mission),
        collections: missionCollectionEntries(mission),
      });
    }
    const missionCatalog = Array.from(dedup.values());
    const ownedCollectionKeys = new Set();
    const walletNfts = normalizeNftList(loaded?.nftResult || {});
    for (const nft of walletNfts) {
      const c =
        nft?.collection ||
        nft?.collectionName ||
        nft?.collection_name ||
        nft?.collectionSymbol ||
        nft?.collection_symbol ||
        nft?.symbol ||
        null;
      const key = String(c || "")
        .trim()
        .toLowerCase();
      if (key) ownedCollectionKeys.add(key);
    }

    emitProgress(100, "done", "Sync complete");
    pushSystemLog("Onboarding account sync complete.");
    return {
      ok: true,
      whoami: { displayName, walletId },
      missions,
      missionCatalog,
      ownedCollections: Array.from(ownedCollectionKeys),
    };
  });
  ipcMain.handle("onboarding:apply-selection", async (_event, payload = {}) => {
    const nextTargets = Array.isArray(payload?.targetMissions)
      ? Array.from(
          new Set(
            payload.targetMissions
              .map((entry) => String(entry || "").trim())
              .filter(Boolean),
          ),
        )
      : undefined;
    const configPatch = {
      signerMode: String(payload?.signerMode || "").trim() || undefined,
      targetMissions: nextTargets,
      firstRunOnboardingCompleted: true,
    };
    const next = applyDesktopConfigPatch(configPatch);
    if (typeof next.signerMode === "string") {
      backendStatus.signerMode = next.signerMode;
    }
    logConfigPatch("Onboarding", configPatch);
    publishStatus();
    return { ok: true, config: next };
  });
  ipcMain.handle("rentals:preview", async () => {
    const loadPreview = async () => {
      pushSystemLog("Rentals page refresh started.");
      pushSystemLog("Rentals refresh: fetching get_rentable_nfts.");
      const rentableResult = await mcpCallTool(
        "get_rentable_nfts",
        {},
        { url: "https://pixelbypixel.studio/mcp" },
      );
      pushSystemLog("Rentals refresh: fetching get_user_missions.");
      const missionsResult = await mcpCallTool(
        "get_user_missions",
        {},
        { url: "https://pixelbypixel.studio/mcp" },
      );

      const rentableRaw = Array.isArray(rentableResult?.structuredContent?.data)
        ? rentableResult.structuredContent.data
        : [];
      const rentable = rentableRaw.slice(0, 24).map((entry, index) => ({
        id:
          entry?.rentalListingId ||
          entry?.listingId ||
          entry?.id ||
          `listing-${index}`,
        rentalListingId: entry?.rentalListingId || entry?.listingId || null,
        account: entry?.account || entry?.nftAccount || null,
        name:
          entry?.offChainMetadata?.metadata?.name ||
          entry?.DASMetadata?.name ||
          entry?.name ||
          "Unknown NFT",
        image:
          entry?.offChainMetadata?.metadata?.image ||
          entry?.DASMetadata?.image ||
          null,
        collection:
          entry?.offChainMetadata?.metadata?.symbol ||
          entry?.DASMetadata?.symbol ||
          null,
        level: Number.isFinite(Number(entry?.stats?.level))
          ? Number(entry.stats.level)
          : null,
        rentalStatus: entry?.rentalStatus || null,
      }));

      const missionList = normalizeMissionList(missionsResult || {});
      const slotSummary = missionList
        .map((mission, index) => ({
          id:
            mission?.assignedMissionId ||
            mission?.assigned_mission_id ||
            `slot-${index}`,
          slot: Number.isFinite(Number(mission?.slot)) ? Number(mission.slot) : null,
          missionName: missionDisplayName(mission),
          assignedNft: mission?.assigned_nft || mission?.assignedNft || null,
          nftSource: mission?.nft_source || mission?.nftSource || null,
          rentalLeaseId: mission?.rental_lease_id || mission?.rentalLeaseId || null,
          currentLevel: Number.isFinite(Number(mission?.current_level))
            ? Number(mission.current_level)
            : Number.isFinite(Number(mission?.level))
              ? Number(mission.level)
              : null,
        }))
        .sort((a, b) => Number(a.slot || 99) - Number(b.slot || 99));
      const activeRentals = missionList
        .filter((mission) => String(mission?.nft_source || mission?.nftSource || "").toLowerCase() === "rental")
        .map((mission, index) => ({
          id:
            mission?.assignedMissionId ||
            mission?.assigned_mission_id ||
            `mission-rental-${index}`,
          slot: Number.isFinite(Number(mission?.slot)) ? Number(mission.slot) : null,
          missionName: missionDisplayName(mission),
          assignedNft:
            mission?.assigned_nft ||
            mission?.assignedNft ||
            null,
          image:
            mission?.assignedNftImage ||
            mission?.assigned_nft_image ||
            mission?.nftImage ||
            mission?.image ||
            null,
          rentalLeaseId:
            mission?.rental_lease_id ||
            mission?.rentalLeaseId ||
            null,
          currentLevel: Number.isFinite(Number(mission?.current_level))
            ? Number(mission.current_level)
            : Number.isFinite(Number(mission?.level))
              ? Number(mission.level)
            : null,
        }));

      const rentableByCollection = new Map();
      for (const row of rentable) {
        const key = String(row.collection || "unknown").trim() || "unknown";
        rentableByCollection.set(key, (rentableByCollection.get(key) || 0) + 1);
      }
      const poolByCollection = Array.from(rentableByCollection.entries())
        .map(([collection, count]) => ({ collection, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return {
        ok: true,
        rentableCount: Number(rentableResult?.structuredContent?.count || rentableRaw.length || 0),
        rentable,
        activeRentals,
        slotSummary,
        poolByCollection,
      };
    };

    try {
      const result = await loadPreview();
      pushSystemLog(
        `Rentals page refresh complete. Pool=${Number(result?.rentableCount || 0)}, active rentals=${Array.isArray(result?.activeRentals) ? result.activeRentals.length : 0}.`,
      );
      return result;
    } catch (error) {
      if (!isAuthFailureMessage(error?.message)) {
        pushSystemLog(
          `Rentals page refresh failed: ${String(error?.message || error)}`,
        );
        return { ok: false, error: String(error?.message || error) };
      }
      pushSystemLog("Rentals refresh requires login. Opening browser login.");
      await runOnboardingPopupLogin({
        url: "https://pixelbypixel.studio/mcp",
        timeoutMs: 30000,
        loginTimeoutMs: 180000,
      });
      const result = await loadPreview();
      pushSystemLog(
        `Rentals page refresh complete after login. Pool=${Number(result?.rentableCount || 0)}, active rentals=${Array.isArray(result?.activeRentals) ? result.activeRentals.length : 0}.`,
      );
      return result;
    }
  });
  ipcMain.handle("nfts:list", async () => {
    const loadNfts = async () => {
      pushSystemLog("NFT page refresh started.");
      pushSystemLog("NFT page refresh: fetching get_mission_nfts.");
      const nftResult = await mcpCallTool(
        "get_mission_nfts",
        {},
        { url: "https://pixelbypixel.studio/mcp" },
      );
      const nfts = normalizeNftList(nftResult || {}).map((entry, index) => {
        const cooldownSeconds = deriveCooldownSeconds(entry);
        const onCooldown =
          entry?.onCooldown === true ||
          entry?.on_cooldown === true ||
          cooldownSeconds > 0;
        const available = !onCooldown && cooldownSeconds <= 0;

        return {
        id:
          entry?.account ||
          entry?.nftAccount ||
          entry?.mint ||
          entry?.mintAddress ||
          entry?.id ||
          `nft-${index}`,
        account:
          entry?.account ||
          entry?.nftAccount ||
          entry?.tokenAddress ||
          null,
        mint:
          entry?.mint ||
          entry?.mintAddress ||
          entry?.mint_address ||
          null,
        name:
          entry?.offChainMetadata?.metadata?.name ||
          entry?.DASMetadata?.name ||
          entry?.metadata?.name ||
          entry?.name ||
          "Unknown NFT",
        image: (() => {
          const candidates = [
            entry?.offChainMetadata?.metadata?.image,
            entry?.offChainMetadata?.metadata?.imageUrl,
            entry?.offChainMetadata?.metadata?.image_url,
            entry?.DASMetadata?.image,
            entry?.DASMetadata?.content?.files,
            entry?.metadata?.image,
            entry?.metadata?.imageUrl,
            entry?.metadata?.image_url,
            entry?.image,
            entry?.imageUrl,
            entry?.image_url,
            entry?.thumbnail,
            entry?.thumbnailUrl,
            entry?.thumbnail_url,
            entry,
          ];
          for (const candidate of candidates) {
            const resolved = deepFindRemoteImageUrl(candidate);
            if (resolved) return resolved;
          }
          return null;
        })(),
        collection:
          entry?.collection ||
          entry?.collectionName ||
          entry?.collection_name ||
          entry?.offChainMetadata?.metadata?.symbol ||
          entry?.DASMetadata?.symbol ||
          entry?.symbol ||
          null,
        level: Number.isFinite(Number(entry?.stats?.level))
          ? Number(entry.stats.level)
          : Number.isFinite(Number(entry?.level))
            ? Number(entry.level)
            : null,
        cooldownSeconds,
        cooldownEndsAt:
          entry?.cooldownEndsAt ??
          entry?.cooldown_ends_at ??
          entry?.cooldownEndAt ??
          entry?.cooldown_end_at ??
          null,
        onCooldown,
        available,
      };
      });
      return {
        ok: true,
        total: nfts.length,
        nfts,
      };
    };

    try {
      const result = await loadNfts();
      pushSystemLog(`NFT page refresh complete. NFTs=${Number(result?.total || 0)}.`);
      return result;
    } catch (error) {
      if (!isAuthFailureMessage(error?.message)) {
        pushSystemLog(`NFT page refresh failed: ${String(error?.message || error)}`);
        return { ok: false, error: String(error?.message || error) };
      }
      pushSystemLog("NFT page refresh requires login. Opening browser login.");
      await runOnboardingPopupLogin({
        url: "https://pixelbypixel.studio/mcp",
        timeoutMs: 30000,
        loginTimeoutMs: 180000,
      });
      const result = await loadNfts();
      pushSystemLog(
        `NFT page refresh complete after login. NFTs=${Number(result?.total || 0)}.`,
      );
      return result;
    }
  });
  ipcMain.handle("slot:prepare-unlock4", async () => {
    pushSystemLog("Slot 4 unlock requested.");
    const payload = await requestBackend(
      "prepare_slot4_unlock",
      {},
      {
        ensureRunning: true,
        timeoutMs: 15000,
      },
    );
    return payload;
  });
  ipcMain.handle("clipboard:copy", async (_event, text) => {
    const value = String(text || "");
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle("external:open", async (_event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("Invalid external URL.");
    }
    await shell.openExternal(target);
    return true;
  });
  ipcMain.handle("window:open-cli", async () => {
    await createCliWindow();
    return true;
  });
  ipcMain.handle("window:is-cli-open", async () => {
    return Boolean(cliWindow && !cliWindow.isDestroyed());
  });
  ipcMain.handle("window:get-position", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return [0, 0];
    return win.getPosition();
  });
  ipcMain.handle("window:set-position", async (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    win.setPosition(Math.round(x), Math.round(y));
    return true;
  });
  ipcMain.handle("window:minimize", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
    return true;
  });
  ipcMain.handle("window:close", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      if (
        controlWindow &&
        !controlWindow.isDestroyed() &&
        win === controlWindow
      ) {
        app.quit();
      } else {
        win.close();
      }
    }
    return true;
  });

  ipcMain.handle("pbp:get-latest-competition", async (_event, opts = {}) => {
    try {
      const competition = await scrapeLatestCompetition(opts || {});
      return { ok: true, competition };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  createSplashWindow();
  hydrateBackendStatusFromConfig();
  publishStatus();
  await createControlWindow();
  try {
    const launchConfig = readDesktopConfig();
    const walletAddress =
      String(
        launchConfig?.signer?.walletAddress ||
          launchConfig?.signer?.wallet ||
          "",
      ).trim() ||
      String(launchConfig?.walletAddress || "").trim() ||
      null;
    if (launchConfig.signerMode) {
      backendStatus.signerMode = launchConfig.signerMode;
    }
    // One-time funding wallet load at desktop startup (do not poll).
    if (walletAddress) {
      try {
        backendStatus.fundingWalletSummary =
          await fetchOnchainFundingWalletSummary(walletAddress);
      } catch {
        // Keep it null; the user can trigger refresh later (or it will refresh
        // after token-affecting actions).
        backendStatus.fundingWalletSummary = null;
      }
    } else {
      backendStatus.fundingWalletSummary = null;
    }
    publishStatus();
  } catch {}
  const closeSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();
  };
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.once("ready-to-show", closeSplash);
    controlWindow.webContents.once("dom-ready", closeSplash);
    setTimeout(closeSplash, 1800);
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createControlWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
