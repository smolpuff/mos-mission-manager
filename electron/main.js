"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { fork, execFile } = require("child_process");
const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  ipcMain,
  clipboard,
  shell,
} = require("electron");
const {
  fetchOnchainFundingWalletSummary,
} = require("../src/wallet/onchain-summary");
const { scrapeLatestCompetition } = require("./scrapeCompetitions");
const { checkForUpdates } = require("./update-checker");
const { createMcpClient } = require("../src/mcp/client");
const {
  normalizeMissionList,
  normalizeMissionCatalogList,
  normalizeNftList,
  missionHasAssignedNft,
  missionIsActive,
} = require("../src/missions/normalize");
const {
  computeGuiMissionSlots: computeGuiMissionSlotsShared,
} = require("../src/missions/gui-slots");
const {
  NORMAL_DEFAULTS,
  DEV_DEFAULTS,
  runtimeDefaultsForFlags,
} = require("../src/runtime-defaults");

const ROOT_DIR = path.resolve(__dirname, "..");
const RENDERER_DEV_URL =
  process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const rendererIndexPath = path.join(ROOT_DIR, "dist", "index.html");
const DESKTOP_DEVTOOLS_ENABLED = process.env.PBP_DESKTOP_DEVTOOLS === "1";

function isDesktopDevMode() {
  if (process.env.PBP_DESKTOP_DEV_MODE === "1") return true;
  if (process.env.NODE_ENV === "development") return true;
  if (!app.isPackaged) return true;
  const lifecycle = String(process.env.npm_lifecycle_event || "").trim();
  return lifecycle === "desktop:dev";
}

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

function defaultMissionResetLevelForConfig(config = {}) {
  return runtimeDefaultsForFlags({
    debugMode: config?.debugMode === true,
    devMode: isDesktopDevMode(),
  }).missionResetLevel;
}

function desktopWindowFrameOptions() {
  return {
    frame: false,
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: -100, y: -100 } }
      : {}),
  };
}

let controlWindow = null;
let cliWindow = null;
let splashWindow = null;
let backend = null;
let splashProgressCurrent = 0;
let splashProgressTarget = 0;
let splashProgressTimer = null;
let stopTimer = null;
let logHistory = [];
const pendingBackendRequests = new Map();
const maxLogHistory = 1200;
let fundingWalletSummaryRefreshPromise = null;
let fundingWalletSummaryLastAttemptAt = 0;
let bootstrapWalletSummaryPromise = null;
let bootstrapWalletSummaryLastAttemptAt = 0;
let startupMissionBootstrapPromise = null;
let competitionRangeLockTimer = null;
let competitionRangeLockRunning = false;
let competitionRangeLockRefreshPending = false;
let competitionRangeLockLastSummary = "";
let competitionRangeLockPauseApplied = false;
let competitionRangeLockLiveEnabled = null;
let missionCatalogResultCache = null;
let missionCatalogResultPromise = null;
let rentalsPreviewCache = null;
let rentalsPreviewCacheAt = 0;
let rentalsPreviewPromise = null;
let accountSnapshotCache = null;
let accountSnapshotCacheAt = 0;
let accountSnapshotPromise = null;
let nftListCache = null;
let nftListCacheAt = 0;
let nftListPromise = null;
let analyticsTelemetryHeartbeatTimer = null;
let analyticsTelemetrySessionId = null;
let analyticsTelemetryFailureLogged = false;
let analyticsTelemetryEndTimer = null;
let telemetryQuitInProgress = false;
let analyticsTelemetrySessionReusableUntil = 0;
let appQuitInFlight = false;
const FUNDING_WALLET_REFRESH_MIN_INTERVAL_MS = 30000;
const BOOTSTRAP_WALLET_REFRESH_MIN_INTERVAL_MS = 30000;
const PAGE_PREVIEW_CACHE_TTL_MS = 2000;
const RENTALS_PREVIEW_CACHE_TTL_MS = 120000;
const NFT_LIST_CACHE_TTL_MS = 60000;
const COMPETITION_RANGE_LOCK_MIN_POLL_SECONDS = 60;
const COMPETITION_RANGE_LOCK_DEFAULT_POLL_SECONDS = 150;
const MISSIONS_ANALYTICS_TRACK_URL =
  "https://missions.lol/missions-analytics/public/track.php";
const MISSIONS_ANALYTICS_TRACK_TOKEN =
  "c8957cffc9fc68d35a886c14a6ca9d48aefbfdd564b3eef0c89de03efa5c056f";
const MISSIONS_ANALYTICS_HEARTBEAT_MS = 120000;
const MISSIONS_ANALYTICS_TIMEOUT_MS = 8000;
const MISSIONS_ANALYTICS_SESSION_END_GRACE_MS = 180000;
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
  missionActionEnabledBySlot: null,
  missionResetPerSlotModeEnabled: null,
  missionResetPerSlotEnabledBySlot: null,
  missionResetPerSlotLevelBySlot: null,
  debugMode: null,
  nftCooldownResetEnabled: null,
  nftCooldownResetMaxPbp: null,
  currentMissionResetLevel: null,
  sessionTotalsEpoch: null,
  sessionRewardTotals: null,
  sessionSpendTotals: null,
  fundingWalletSummary: null,
  guiMissionSlots: null,
  startupMissionSlotsLoading: false,
  cliWindowOpen: false,
  analytics: null,
};

const ANALYTICS_VERSION = 1;
const OUTPUT_LINE_BUFFER = { stdout: "", stderr: "", system: "", stdin: "" };
const desktopMcpCtx = {
  APP_VERSION: app.getVersion(),
  MCP_URL: "https://pixelbypixel.studio/mcp",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  tokenFilePath: path.join(os.homedir(), ".pbp-mcp", "token.json"),
  interactiveAuth: true,
  debugMode: isDesktopDevMode(),
  isAuthenticated: false,
  authRefreshSignal: 0,
  onAuthRefresh: null,
  mcpConnection: {
    state: "disconnected",
    lastError: null,
    updatedAt: 0,
  },
  mcpRateLimitedUntil: 0,
  mcpRateLimitReason: null,
  lastAssignedMissionLookup: {},
  lastUserMissionsResult: null,
  lastUserMissionsFetchedAt: 0,
  currentUserDisplayName: "unknown",
  currentUserWalletId: "unknown",
  currentUserWalletSummary: null,
};
const desktopMcpLogger = {
  logWithTimestamp(message) {
    pushSystemLog(String(message || ""));
  },
  logDebug(scope, event, meta = {}) {
    if (!isDesktopDevMode()) return;
    const detail =
      meta && typeof meta === "object" && Object.keys(meta).length > 0
        ? ` ${JSON.stringify(meta)}`
        : "";
    pushSystemLog(`[DEBUG:${String(scope || "mcp")}] ${String(event || "event")}${detail}`);
  },
};
const desktopMcp = createMcpClient(desktopMcpCtx, desktopMcpLogger);
async function mcpCallTool(toolName, args = {}, opts = {}) {
  return desktopMcp.mcpToolCall(toolName, args, opts);
}

async function getMissionCatalogCached() {
  if (missionCatalogResultCache) {
    pushSystemLog("Mission catalog cache hit.");
    return missionCatalogResultCache;
  }
  if (missionCatalogResultPromise) {
    pushSystemLog("Mission catalog cache wait: lookup already running.");
    return missionCatalogResultPromise;
  }
  missionCatalogResultPromise = mcpCallTool(
    "get_mission_catalog",
    {},
    {
      url: "https://pixelbypixel.studio/mcp",
    },
  )
    .then((result) => {
      missionCatalogResultCache = result;
      return result;
    })
    .finally(() => {
      missionCatalogResultPromise = null;
    });
  return missionCatalogResultPromise;
}

function createEmptyAnalytics() {
  const emptyBucket = {
    startedAt: null,
    totalClaims: 0,
    totalResets: 0,
    totalResetCostPbp: 0,
    totalLeased: 0,
    currencyEarned: { pbp: 0, tc: 0, cc: 0 },
    missionClaims: {},
    claimHistory: [],
    spendHistory: [],
    resetHistory: [],
    rentalHistory: [],
    assignmentHistory: [],
    resetTypes: { mission: 0, nft: 0 },
    nftResetUsage: {
      owned: { resets: 0, assigned: 0 },
      rental: { resets: 0, assigned: 0 },
    },
    spendByAction: {},
    nftsUsed: [],
  };
  return {
    version: ANALYTICS_VERSION,
    lifetime: { ...emptyBucket },
    session: { ...emptyBucket },
  };
}

function normalizeNftResetUsage(raw) {
  const owned = raw?.owned && typeof raw.owned === "object" ? raw.owned : {};
  const rental =
    raw?.rental && typeof raw.rental === "object" ? raw.rental : {};
  return {
    owned: {
      resets: Number(owned.resets || 0) || 0,
      assigned: Number(owned.assigned || 0) || 0,
    },
    rental: {
      resets: Number(rental.resets || 0) || 0,
      assigned: Number(rental.assigned || 0) || 0,
    },
  };
}

function normalizeCounterObject(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    const n = Number(value);
    out[normalizedKey] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

function normalizeClaimHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const at = Number(entry?.at);
      const claims = Number(entry?.claims);
      const assignedMissionId = String(entry?.assignedMissionId || "").trim();
      const slot = Number(entry?.slot);
      const rewardAmount = Number(entry?.rewardAmount);
      const rewardToken = normalizeRewardToken(entry?.rewardToken);
      return {
        at: Number.isFinite(at) ? at : null,
        claims: Number.isFinite(claims) ? Math.max(0, claims) : 0,
        mission: String(entry?.mission || "").trim(),
        assignedMissionId: assignedMissionId || null,
        slot: Number.isFinite(slot) ? slot : null,
        rewardAmount:
          Number.isFinite(rewardAmount) && rewardAmount > 0
            ? rewardAmount
            : null,
        rewardToken: rewardToken || null,
      };
    })
    .filter((entry) => entry.at && entry.claims > 0)
    .slice(-1000);
}

function normalizeSpendHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const at = Number(entry?.at);
      const amount = Number(entry?.amount);
      const action = String(entry?.action || "").trim() || "other";
      return {
        at: Number.isFinite(at) ? at : null,
        amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
        action,
      };
    })
    .filter((entry) => entry.at && entry.amount > 0)
    .slice(-2000);
}

function normalizeResetHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const at = Number(entry?.at);
      const kind = String(entry?.kind || entry?.resetType || "")
        .trim()
        .toLowerCase();
      const source = String(entry?.source || entry?.resetSource || "")
        .trim()
        .toLowerCase();
      return {
        at: Number.isFinite(at) ? at : null,
        kind: kind === "nft" ? "nft" : "mission",
        source: source === "rental" ? "rental" : "owned",
      };
    })
    .filter((entry) => entry.at)
    .slice(-2000);
}

function normalizeRentalHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const at = Number(entry?.at);
      const source = String(entry?.source || "")
        .trim()
        .toLowerCase();
      return {
        at: Number.isFinite(at) ? at : null,
        source: source || null,
      };
    })
    .filter((entry) => entry.at)
    .slice(-2000);
}

function normalizeAssignmentHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const at = Number(entry?.at);
      const source = String(entry?.source || "")
        .trim()
        .toLowerCase();
      const nft = String(entry?.nft || "").trim() || null;
      return {
        at: Number.isFinite(at) ? at : null,
        source: source === "rental" ? "rental" : "owned",
        nft,
      };
    })
    .filter((entry) => entry.at)
    .slice(-2000);
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
        src?.lifetime?.missionClaims &&
        typeof src.lifetime.missionClaims === "object"
          ? src.lifetime.missionClaims
          : {},
      claimHistory: normalizeClaimHistory(src?.lifetime?.claimHistory),
      spendHistory: normalizeSpendHistory(src?.lifetime?.spendHistory),
      resetHistory: normalizeResetHistory(src?.lifetime?.resetHistory),
      rentalHistory: normalizeRentalHistory(src?.lifetime?.rentalHistory),
      assignmentHistory: normalizeAssignmentHistory(
        src?.lifetime?.assignmentHistory,
      ),
      resetTypes: {
        mission: Number(src?.lifetime?.resetTypes?.mission || 0) || 0,
        nft: Number(src?.lifetime?.resetTypes?.nft || 0) || 0,
      },
      nftResetUsage: normalizeNftResetUsage(src?.lifetime?.nftResetUsage),
      spendByAction: normalizeCounterObject(src?.lifetime?.spendByAction),
      nftsUsed: Array.isArray(src?.lifetime?.nftsUsed)
        ? src.lifetime.nftsUsed
            .map((v) => String(v || "").trim())
            .filter(Boolean)
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
        src?.session?.missionClaims &&
        typeof src.session.missionClaims === "object"
          ? src.session.missionClaims
          : {},
      claimHistory: normalizeClaimHistory(src?.session?.claimHistory),
      spendHistory: normalizeSpendHistory(src?.session?.spendHistory),
      resetHistory: normalizeResetHistory(src?.session?.resetHistory),
      rentalHistory: normalizeRentalHistory(src?.session?.rentalHistory),
      assignmentHistory: normalizeAssignmentHistory(
        src?.session?.assignmentHistory,
      ),
      resetTypes: {
        mission: Number(src?.session?.resetTypes?.mission || 0) || 0,
        nft: Number(src?.session?.resetTypes?.nft || 0) || 0,
      },
      nftResetUsage: normalizeNftResetUsage(src?.session?.nftResetUsage),
      spendByAction: normalizeCounterObject(src?.session?.spendByAction),
      nftsUsed: Array.isArray(src?.session?.nftsUsed)
        ? src.session.nftsUsed
            .map((v) => String(v || "").trim())
            .filter(Boolean)
        : [],
    },
  };
  return { ...empty, ...norm };
}

function isDev() {
  return !app.isPackaged;
}

function canConnectToUrl(targetUrl, timeoutMs = 250) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const socket = net.createConnection({
        host: parsed.hostname,
        port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {}
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    } catch {
      resolve(false);
    }
  });
}

function getRendererUrl(hash = "") {
  return `${RENDERER_DEV_URL}/${hash ? `#${hash}` : ""}`;
}

async function loadWindow(win, hash = "") {
  const devTarget = getRendererUrl(hash);
  const builtRendererExists = fs.existsSync(rendererIndexPath);
  if (isDesktopDevMode() && (await canConnectToUrl(RENDERER_DEV_URL))) {
    await win.loadURL(devTarget);
    return;
  }
  if (!builtRendererExists) {
    throw new Error(
      `Renderer build not found at ${rendererIndexPath}. Run "npm run desktop:build" or use "npm run desktop:dev".`,
    );
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
    const preview = value
      .slice(0, 6)
      .map((entry) => formatConfigValueForLog(entry));
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

function sendSplashProgressToWindow(progress) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  splashWindow.webContents
    .executeJavaScript(
      `window.__updateSplashProgress__ && window.__updateSplashProgress__(${JSON.stringify({ progress: safeProgress })});`,
      true,
    )
    .catch(() => {});
}

function stopSplashProgressTimer() {
  if (!splashProgressTimer) return;
  clearInterval(splashProgressTimer);
  splashProgressTimer = null;
}

function ensureSplashProgressTimer() {
  if (splashProgressTimer) return;
  splashProgressTimer = setInterval(() => {
    if (!splashWindow || splashWindow.isDestroyed()) {
      stopSplashProgressTimer();
      return;
    }
    if (splashProgressCurrent >= splashProgressTarget) {
      if (splashProgressCurrent >= 100) {
        stopSplashProgressTimer();
      }
      return;
    }
    const gap = splashProgressTarget - splashProgressCurrent;
    const step = gap > 20 ? 4 : gap > 10 ? 3 : gap > 4 ? 2 : 1;
    splashProgressCurrent = Math.min(
      splashProgressTarget,
      splashProgressCurrent + step,
    );
    sendSplashProgressToWindow(splashProgressCurrent);
    if (splashProgressCurrent >= 100 && splashProgressTarget >= 100) {
      stopSplashProgressTimer();
    }
  }, 40);
}

function setSplashProgress(target) {
  splashProgressTarget = Math.max(0, Math.min(100, Number(target) || 0));
  if (splashProgressTarget <= splashProgressCurrent) {
    sendSplashProgressToWindow(splashProgressCurrent);
    return;
  }
  ensureSplashProgressTimer();
}

function missionNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function looksLikeOpaqueMissionId(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    text,
  );
}

function hydrateMissionListWithCachedCatalog(missions = []) {
  const missionList = Array.isArray(missions) ? missions : [];
  if (!missionCatalogResultCache) {
    return {
      missions: missionList,
      hydrated: false,
      source: "no_catalog_cache",
    };
  }
  const catalogList = normalizeMissionCatalogList(missionCatalogResultCache);
  if (!catalogList.length) {
    return {
      missions: missionList,
      hydrated: false,
      source: "empty_catalog_cache",
    };
  }
  const catalogByName = new Map();
  for (const entry of catalogList) {
    const key = missionNameKey(
      entry?.missionName || entry?.name || entry?.title || entry?.mission,
    );
    if (key && !catalogByName.has(key)) {
      catalogByName.set(key, entry);
    }
  }
  let hydratedCount = 0;
  const next = missionList.map((mission) => {
    if (!mission || typeof mission !== "object") return mission;
    const key = missionNameKey(missionDisplayName(mission));
    const catalogMission = key ? catalogByName.get(key) || null : null;
    if (!catalogMission) return mission;
    const merged = { ...catalogMission, ...mission };
    const hadImage = Boolean(
      mission?.image ||
      mission?.imageUrl ||
      mission?.image_url ||
      mission?.thumbnail ||
      mission?.thumbnailUrl ||
      mission?.thumbnail_url,
    );
    if (!hadImage) {
      if (catalogMission?.image && !merged.image)
        merged.image = catalogMission.image;
      if (catalogMission?.imageUrl && !merged.imageUrl)
        merged.imageUrl = catalogMission.imageUrl;
      if (catalogMission?.image_url && !merged.image_url) {
        merged.image_url = catalogMission.image_url;
      }
      if (catalogMission?.thumbnail && !merged.thumbnail) {
        merged.thumbnail = catalogMission.thumbnail;
      }
    }
    hydratedCount += 1;
    return merged;
  });
  return {
    missions: next,
    hydrated: hydratedCount > 0,
    hydratedCount,
    source: "catalog_cache",
  };
}

async function bootstrapStartupMissionSlots() {
  if (backendStatus.running) return { ok: true, skipped: "backend_running" };
  if (startupMissionBootstrapPromise) return startupMissionBootstrapPromise;
  startupMissionBootstrapPromise = (async () => {
    pushSystemLog("Startup wallet bootstrap: fetching wallet summary.");
    backendStatus.startupMissionSlotsLoading = true;
    publishStatus();

    try {
      let walletSummaryResult = null;
      try {
        walletSummaryResult = await mcpCallTool(
          "get_wallet_summary",
          {},
          { url: "https://pixelbypixel.studio/mcp" },
        );
      } catch (error) {
        if (!isAuthFailureMessage(error?.message)) throw error;
        pushSystemLog("Startup mission sync skipped until login is available.");
        backendStatus.isAuthenticated = false;
        return { ok: false, skipped: "auth_required" };
      }

      const walletSummary = summarizeWalletPayload(walletSummaryResult || {});
      backendStatus.isAuthenticated = true;
      backendStatus.currentUserDisplayName = walletSummary.displayName || null;
      backendStatus.currentUserWalletId = walletSummary.walletId || null;
      if (walletSummary.currentUserWalletSummary) {
        backendStatus.currentUserWalletSummary =
          walletSummary.currentUserWalletSummary;
      }
      accountSnapshotCache = {
        ...(accountSnapshotCache && typeof accountSnapshotCache === "object"
          ? accountSnapshotCache
          : {}),
        walletSummaryResult,
      };
      accountSnapshotCacheAt = Date.now();
      publishStatus();
      if (analyticsTelemetrySessionId) {
        trackTelemetryEvent("heartbeat", { event_name: "identity_refresh" });
      }

      pushSystemLog("Startup mission sync: fetching user missions.");
      try {
        const missionsResult = await mcpCallTool(
          "get_user_missions",
          {},
          { url: "https://pixelbypixel.studio/mcp" },
        );
        const hydratedMissions = hydrateMissionListWithCachedCatalog(
          normalizeMissionList(missionsResult || {}),
        );
        const missionList = hydratedMissions.missions;
        accountSnapshotCache = {
          ...(accountSnapshotCache && typeof accountSnapshotCache === "object"
            ? accountSnapshotCache
            : {}),
          missionsResult,
        };
        accountSnapshotCacheAt = Date.now();
        syncDesktopTargetMissionsFromAssignedMissions(
          missionList,
          "Startup mission sync",
        );
        backendStatus.guiMissionSlots =
          computeGuiMissionSlotsShared(missionList);
        if (hydratedMissions.hydrated) {
          pushSystemLog(
            `Startup mission metadata hydration complete (${Number(hydratedMissions.hydratedCount || 0)}).`,
          );
        } else {
          pushSystemLog("Startup mission metadata hydration skipped.");
        }
        backendStatus.startupMissionSlotsLoading = false;
        publishStatus();
        pushSystemLog("Startup mission sync complete.");
        return { ok: true };
      } catch (error) {
        backendStatus.startupMissionSlotsLoading = false;
        publishStatus();
        pushSystemLog(
          `Startup mission sync failed: ${String(error?.message || error)}`,
        );
        return { ok: false, error: String(error?.message || error) };
      }
    } catch (error) {
      backendStatus.startupMissionSlotsLoading = false;
      publishStatus();
      pushSystemLog(
        `Startup mission sync failed: ${String(error?.message || error)}`,
      );
      return { ok: false, error: String(error?.message || error) };
    } finally {
      backendStatus.startupMissionSlotsLoading = false;
      startupMissionBootstrapPromise = null;
      publishStatus();
    }
  })();
  return startupMissionBootstrapPromise;
}

function updateBackendStateFromIpc(payload) {
  if (!payload || payload.type !== "pbp_state") return;
  const next = payload.state || {};
  let changed = false;
  let identityChanged = false;
  const hasUsableBalances = (summary) =>
    Array.isArray(summary?.balances) &&
    summary.balances.some((entry) => {
      const amount = Number(entry?.balance ?? entry?.displayBalance ?? NaN);
      return Number.isFinite(amount);
    });
  const hasUsableFundingSummary = (summary) =>
    summary &&
    typeof summary === "object" &&
    String(summary.status || "")
      .trim()
      .toLowerCase() === "ok" &&
    (Number.isFinite(Number(summary.sol)) ||
      Number.isFinite(Number(summary.pbp)) ||
      String(summary.address || "").trim().length > 0);
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
      if (key === "currentUserWalletSummary") {
        const currentSummary = backendStatus.currentUserWalletSummary;
        const nextSummary = next[key];
        if (
          hasUsableBalances(currentSummary) &&
          !hasUsableBalances(nextSummary)
        ) {
          continue;
        }
      }
      if (key === "fundingWalletSummary") {
        const currentSummary = backendStatus.fundingWalletSummary;
        const nextSummary = next[key];
        if (
          hasUsableFundingSummary(currentSummary) &&
          !hasUsableFundingSummary(nextSummary)
        ) {
          continue;
        }
      }
      backendStatus[key] = next[key];
      changed = true;
      if (key === "currentUserDisplayName" || key === "currentUserWalletId") {
        identityChanged = true;
      }
    }
  }
  if (changed) publishStatus();
  if (identityChanged && analyticsTelemetrySessionId) {
    trackTelemetryEvent("heartbeat", { event_name: "identity_refresh" });
  }
  if (identityChanged && shouldRunCompetitionRangeLock()) {
    triggerCompetitionRangeLockImmediateCheck(
      "identity_refresh",
    );
  }
}

function publishEvent(payload) {
  publish("backend:event", payload);
}

function parseRetrySecondsFromMessage(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const match = text.match(/retry (?:in|after) (\d+)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function publishThrottleNotice({
  source = "unknown",
  trigger = "unknown",
  message = "",
  waitSeconds = null,
  detail = null,
} = {}) {
  const retrySeconds =
    Number.isFinite(Number(waitSeconds)) && Number(waitSeconds) > 0
      ? Math.ceil(Number(waitSeconds))
      : parseRetrySecondsFromMessage(message);
  publishEvent({
    type: "throttle_notice",
    source,
    trigger,
    message: String(message || "The app was rate limited.").trim(),
    waitSeconds: retrySeconds,
    retryAt: retrySeconds ? Date.now() + retrySeconds * 1000 : null,
    detail: detail ? String(detail).trim() : null,
    at: Date.now(),
  });
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
  return path.join(
    getBackendWorkingDirectory(),
    "data",
    "stats-analytics.json",
  );
}

function getAnalyticsTelemetryStatePath() {
  return path.join(
    getBackendWorkingDirectory(),
    "data",
    "missions-analytics.json",
  );
}

function getStartupSnapshotPath() {
  return path.join(
    getBackendWorkingDirectory(),
    "data",
    "startup-account-snapshot.json",
  );
}

function readAnalyticsTelemetryState() {
  try {
    const raw = fs.readFileSync(getAnalyticsTelemetryStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAnalyticsTelemetryState(nextState = {}) {
  try {
    const target = getAnalyticsTelemetryStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(nextState, null, 2));
  } catch {}
}

function telemetryConfigFromDesktopConfig(config = readDesktopConfig()) {
  const configuredEnabled = config?.missionsAnalyticsEnabled;
  const enabled =
    typeof configuredEnabled === "boolean" ? configuredEnabled : true;
  const url = String(
    config?.missionsAnalyticsUrl ||
      process.env.MISSIONS_ANALYTICS_URL ||
      MISSIONS_ANALYTICS_TRACK_URL,
  ).trim();
  const token = String(
    config?.missionsAnalyticsToken ||
      process.env.MISSIONS_ANALYTICS_TOKEN ||
      MISSIONS_ANALYTICS_TRACK_TOKEN,
  ).trim();
  return {
    enabled: enabled && Boolean(url) && Boolean(token),
    url,
    token,
  };
}

function normalizeTelemetryIdentityValue(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (
    text.toLowerCase() === "unknown" ||
    text.toLowerCase() === "null" ||
    text.toLowerCase() === "undefined"
  ) {
    return null;
  }
  return text;
}

function getOrCreateAnalyticsTelemetryClientId() {
  const current = readAnalyticsTelemetryState();
  const existing = String(current.clientId || "").trim();
  if (existing) return existing;
  const next = crypto.randomUUID();
  writeAnalyticsTelemetryState({ ...current, clientId: next });
  return next;
}

function currentAnalyticsIdentity() {
  const summary =
    backendStatus.currentUserWalletSummary &&
    typeof backendStatus.currentUserWalletSummary === "object"
      ? backendStatus.currentUserWalletSummary
      : {};
  return {
    walletId: normalizeTelemetryIdentityValue(
      backendStatus.currentUserWalletId ||
        summary.walletId ||
        summary.wallet_id ||
        null,
    ),
    nickname: normalizeTelemetryIdentityValue(
      backendStatus.currentUserDisplayName ||
        summary.displayName ||
        summary.display_name ||
        summary.username ||
        null,
    ),
  };
}

function buildTelemetryPayload(eventType, extra = {}) {
  const identity = currentAnalyticsIdentity();
  return {
    client_id: getOrCreateAnalyticsTelemetryClientId(),
    session_id: analyticsTelemetrySessionId || undefined,
    event_type: String(eventType || "").trim(),
    wallet_id: identity.walletId || undefined,
    nickname: identity.nickname || undefined,
    app_version: app.getVersion(),
    platform: process.platform,
    os_version:
      typeof process.getSystemVersion === "function"
        ? process.getSystemVersion()
        : process.version,
    dev_mode: isDesktopDevMode(),
    ...extra,
  };
}

async function postTelemetryEvent(eventType, extra = {}) {
  const config = telemetryConfigFromDesktopConfig();
  if (!config.enabled) return false;
  const payload = buildTelemetryPayload(eventType, extra);
  if (!payload.event_type || !payload.client_id) return false;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MISSIONS_ANALYTICS_TIMEOUT_MS,
  );
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Missions-Track-Token": config.token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Telemetry HTTP ${response.status}`);
    }
    analyticsTelemetryFailureLogged = false;
    return true;
  } catch (error) {
    if (!analyticsTelemetryFailureLogged) {
      analyticsTelemetryFailureLogged = true;
      pushSystemLog(
        `Mission analytics reporting failed: ${String(error?.message || error)}`,
      );
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function trackTelemetryEvent(eventType, extra = {}) {
  postTelemetryEvent(eventType, extra).catch(() => {});
}

function resetTelemetryHeartbeat() {
  if (analyticsTelemetryHeartbeatTimer) {
    clearInterval(analyticsTelemetryHeartbeatTimer);
    analyticsTelemetryHeartbeatTimer = null;
  }
}

function resetTelemetryEndTimer() {
  if (analyticsTelemetryEndTimer) {
    clearTimeout(analyticsTelemetryEndTimer);
    analyticsTelemetryEndTimer = null;
  }
}

function ensureTelemetrySession() {
  if (
    analyticsTelemetrySessionId &&
    analyticsTelemetrySessionReusableUntil > Date.now()
  ) {
    return analyticsTelemetrySessionId;
  }
  analyticsTelemetrySessionId = crypto.randomUUID();
  analyticsTelemetrySessionReusableUntil = 0;
  return analyticsTelemetrySessionId;
}

function startTelemetrySession() {
  const config = telemetryConfigFromDesktopConfig();
  if (!config.enabled) return;
  const wasPendingClose = Boolean(analyticsTelemetryEndTimer);
  const hadReusableSession =
    Boolean(analyticsTelemetrySessionId) &&
    analyticsTelemetrySessionReusableUntil > Date.now();
  resetTelemetryEndTimer();
  ensureTelemetrySession();
  analyticsTelemetrySessionReusableUntil = 0;
  if (!hadReusableSession) {
    trackTelemetryEvent("app_open", {
      event_name: "desktop_open",
    });
    trackTelemetryEvent("session_start", {
      event_name: "runner_start",
    });
    trackTelemetryEvent("heartbeat", {
      event_name: "runner_start",
    });
  } else if (wasPendingClose) {
    trackTelemetryEvent("session_start", {
      event_name: "runner_resume",
    });
    trackTelemetryEvent("heartbeat", {
      event_name: "runner_resume",
    });
  } else {
    trackTelemetryEvent("heartbeat", {
      event_name: "runner_active",
    });
  }
  resetTelemetryHeartbeat();
  analyticsTelemetryHeartbeatTimer = setInterval(() => {
    trackTelemetryEvent("heartbeat");
  }, MISSIONS_ANALYTICS_HEARTBEAT_MS);
}

function stopTelemetrySession(
  reason = "runner_stop",
  { immediate = false } = {},
) {
  if (!analyticsTelemetrySessionId) return Promise.resolve(false);
  resetTelemetryHeartbeat();
  resetTelemetryEndTimer();
  const closeSession = () => {
    if (!analyticsTelemetrySessionId) return Promise.resolve(false);
    const sessionId = analyticsTelemetrySessionId;
    return postTelemetryEvent("session_end", {
      session_id: sessionId,
      event_name: reason,
    });
  };
  if (immediate) {
    analyticsTelemetrySessionReusableUntil =
      reason === "runner_stop"
        ? Date.now() + MISSIONS_ANALYTICS_SESSION_END_GRACE_MS
        : 0;
    const closePromise = closeSession();
    if (reason === "runner_stop") {
      analyticsTelemetryEndTimer = setTimeout(() => {
        analyticsTelemetryEndTimer = null;
        if (analyticsTelemetrySessionReusableUntil <= Date.now()) {
          analyticsTelemetrySessionId = null;
          analyticsTelemetrySessionReusableUntil = 0;
        }
      }, MISSIONS_ANALYTICS_SESSION_END_GRACE_MS);
    } else {
      analyticsTelemetrySessionId = null;
      analyticsTelemetrySessionReusableUntil = 0;
    }
    return closePromise;
  }
  return stopTelemetrySession(reason, { immediate: true });
}

function trackFeatureUsage(eventName, payload = {}) {
  if (!eventName) return;
  trackTelemetryEvent("feature_used", {
    event_name: String(eventName || "").trim(),
    ...payload,
  });
}

function trackTelemetryCrash(error, context = {}) {
  const message = String(error?.message || error || "Unknown error").trim();
  const stack = String(error?.stack || "").trim();
  trackTelemetryEvent("crash", {
    message,
    stack_trace: stack || undefined,
    context,
  });
}

function requestAppQuit(reason = "user") {
  if (appQuitInFlight) return;
  appQuitInFlight = true;
  try {
    stopBackend();
  } catch {}
  Promise.resolve(stopTelemetrySession(reason, { immediate: true }))
    .catch(() => {})
    .finally(() => {
      try {
        app.exit(0);
      } catch {}
    });
}

function walletSummaryResultFromBackendStatus() {
  const summary =
    backendStatus.currentUserWalletSummary &&
    typeof backendStatus.currentUserWalletSummary === "object"
      ? backendStatus.currentUserWalletSummary
      : null;
  if (!summary) return null;
  return {
    structuredContent: {
      success: true,
      walletId: summary.walletId || backendStatus.currentUserWalletId || null,
      displayName:
        summary.displayName || backendStatus.currentUserDisplayName || null,
      balances: Array.isArray(summary.balances) ? summary.balances : [],
      walletBalanceSummary: Array.isArray(summary.walletBalanceSummary)
        ? summary.walletBalanceSummary
        : [],
    },
  };
}

function writeStartupSnapshotFile() {
  const snapshotBase =
    accountSnapshotCache && typeof accountSnapshotCache === "object"
      ? { ...accountSnapshotCache }
      : {};
  const synthesizedWalletSummary = walletSummaryResultFromBackendStatus();
  if (!snapshotBase.walletSummaryResult && synthesizedWalletSummary) {
    snapshotBase.walletSummaryResult = synthesizedWalletSummary;
  }
  if (!Object.keys(snapshotBase).length) {
    return null;
  }
  try {
    const target = getStartupSnapshotPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          cachedAt: accountSnapshotCacheAt || Date.now(),
          snapshot: snapshotBase,
        },
        null,
        2,
      ),
    );
    return target;
  } catch {
    return null;
  }
}

function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function autoUpdateCheckEnabledFromConfig(config = {}) {
  if (typeof config?.autoUpdateCheckEnabled === "boolean") {
    return config.autoUpdateCheckEnabled;
  }
  return true;
}

function readDesktopConfigWithMeta() {
  const file = getConfigPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { config: JSON.parse(raw), parseFailed: false };
  } catch {
    return { config: {}, parseFailed: fs.existsSync(file) };
  }
}

function normalizeCompetitionRowKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function competitionRangeLockConfigFrom(config = {}) {
  const minRank = Number(config?.competitionRangeLockMinRank);
  const maxRank = Number(config?.competitionRangeLockMaxRank);
  const pollSeconds = Number(config?.competitionRangeLockPollSeconds);
  const enabled =
    typeof competitionRangeLockLiveEnabled === "boolean"
      ? competitionRangeLockLiveEnabled
      : config?.competitionRangeLockEnabled === true;
  return {
    enabled,
    minRank: Number.isFinite(minRank) && minRank > 0 ? Math.floor(minRank) : 11,
    maxRank: Number.isFinite(maxRank) && maxRank > 0 ? Math.floor(maxRank) : 13,
    pollSeconds:
      Number.isFinite(pollSeconds) &&
      pollSeconds >= COMPETITION_RANGE_LOCK_MIN_POLL_SECONDS
        ? Math.floor(pollSeconds)
        : COMPETITION_RANGE_LOCK_DEFAULT_POLL_SECONDS,
  };
}

function competitionRangeLockRuntimeState(config = readDesktopConfig()) {
  const lockConfig = competitionRangeLockConfigFrom(config);
  const reasons = [];
  if (lockConfig.enabled !== true) reasons.push("disabled");
  if (config?.debugMode !== true) reasons.push("debug_mode_off");
  if (config?.missionModeEnabled !== true) reasons.push("mission_mode_off");
  return {
    enabled:
      lockConfig.enabled === true &&
      config?.debugMode === true &&
      config?.missionModeEnabled === true,
    lockConfig,
    reasons,
  };
}

function shouldRunCompetitionRangeLock(config = readDesktopConfig()) {
  return competitionRangeLockRuntimeState(config).enabled;
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
    backendStatus.sessionRewardTotals = mergeTotalsPeak(
      backendStatus.sessionRewardTotals,
      rewardTotalsFromAnalyticsSession(next),
    );
    backendStatus.sessionSpendTotals = mergeTotalsPeak(
      backendStatus.sessionSpendTotals,
      spendTotalsFromAnalyticsSession(next),
    );
  } catch {}
}

function beginAnalyticsSession({ force = false } = {}) {
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  if (
    !force &&
    Number.isFinite(Number(current?.session?.startedAt)) &&
    Number(current.session.startedAt) > 0
  ) {
    backendStatus.analytics = current;
    return current;
  }
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
    claimHistory: [],
    spendHistory: [],
    resetHistory: [],
    rentalHistory: [],
    assignmentHistory: [],
    resetTypes: { mission: 0, nft: 0 },
    nftResetUsage: {
      owned: { resets: 0, assigned: 0 },
      rental: { resets: 0, assigned: 0 },
    },
    spendByAction: {},
    nftsUsed: [],
  };
  saveAnalytics(current);
  return current;
}

function shouldServeCachedRentalsPreview(cachedAt) {
  return (
    Number.isFinite(Number(cachedAt)) &&
    Date.now() - Number(cachedAt) <= RENTALS_PREVIEW_CACHE_TTL_MS
  );
}

function shouldServeCachedNftList(cachedAt) {
  return (
    Number.isFinite(Number(cachedAt)) &&
    Date.now() - Number(cachedAt) <= NFT_LIST_CACHE_TTL_MS
  );
}

function invalidateAccountSnapshotCache() {
  accountSnapshotCache = null;
  accountSnapshotCacheAt = 0;
}

function invalidateNftListCache() {
  nftListCache = null;
  nftListCacheAt = 0;
}

function invalidateRentalsPreviewCache() {
  rentalsPreviewCache = null;
  rentalsPreviewCacheAt = 0;
}

function invalidateMissionRelatedCaches() {
  invalidateAccountSnapshotCache();
  invalidateNftListCache();
  invalidateRentalsPreviewCache();
}

async function getAccountSnapshotCached({ includeNfts = false } = {}) {
  if (
    accountSnapshotCache &&
    (!includeNfts || accountSnapshotCache?.nftResult)
  ) {
    pushSystemLog("Account snapshot cache hit.");
    return accountSnapshotCache;
  }
  if (accountSnapshotPromise) {
    pushSystemLog("Account snapshot cache wait: refresh already running.");
    return accountSnapshotPromise;
  }
  accountSnapshotPromise = (async () => {
    const snapshot = {
      walletSummaryResult: await mcpCallTool(
        "get_wallet_summary",
        {},
        { url: "https://pixelbypixel.studio/mcp" },
      ),
      missionsResult: await mcpCallTool(
        "get_user_missions",
        {},
        { url: "https://pixelbypixel.studio/mcp" },
      ),
      ...(includeNfts
        ? {
            nftResult: await mcpCallTool(
              "get_mission_nfts",
              {},
              { url: "https://pixelbypixel.studio/mcp" },
            ),
          }
        : {}),
    };
    accountSnapshotCache = snapshot;
    accountSnapshotCacheAt = Date.now();
    return snapshot;
  })().finally(() => {
    accountSnapshotPromise = null;
  });
  return accountSnapshotPromise;
}

function hydrateCachedNftList(result, cachedAt) {
  if (!result || !Array.isArray(result?.nfts)) return result;
  const nowMs = Date.now();
  const fetchedAtMs = Number(cachedAt);
  const elapsedSeconds = Number.isFinite(fetchedAtMs)
    ? Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000))
    : 0;
  const nfts = result.nfts.map((entry) => {
    const next = entry && typeof entry === "object" ? { ...entry } : entry;
    if (!next || typeof next !== "object") return next;
    const endsAtMs = next.cooldownEndsAt
      ? new Date(next.cooldownEndsAt).getTime()
      : NaN;
    let cooldownSeconds = Math.max(0, Number(next.cooldownSeconds || 0));
    if (Number.isFinite(endsAtMs)) {
      cooldownSeconds = Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
    } else if (elapsedSeconds > 0) {
      cooldownSeconds = Math.max(0, cooldownSeconds - elapsedSeconds);
    }
    const onCooldown = cooldownSeconds > 0;
    next.cooldownSeconds = cooldownSeconds;
    next.onCooldown = onCooldown;
    next.available = !onCooldown;
    return next;
  });
  return {
    ...result,
    nfts,
  };
}

function addUniqueValue(list, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return list;
  const set = new Set(Array.isArray(list) ? list : []);
  set.add(normalized);
  return Array.from(set);
}

function normalizeRewardToken(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (token === "pbp" || token === "pbp_token" || token === "pixel_by_pixel") {
    return "pbp";
  }
  if (
    token === "tc" ||
    token === "tc_token" ||
    token === "tournament_coin" ||
    token === "tournament_coins"
  ) {
    return "tc";
  }
  if (
    token === "cc" ||
    token === "cc_token" ||
    token === "community_coin" ||
    token === "community_coins"
  ) {
    return "cc";
  }
  return null;
}

function rewardFromStatsPayload(payload = {}) {
  const reward =
    payload?.reward && typeof payload.reward === "object" ? payload.reward : {};
  const directAmount =
    payload?.rewardAmount ??
    payload?.amount ??
    reward?.amount ??
    reward?.value ??
    null;
  const directToken =
    payload?.rewardToken ??
    payload?.token ??
    payload?.prize ??
    reward?.token ??
    reward?.symbol ??
    reward?.currency ??
    null;
  const text = String(payload?.rewardText || payload?.reward || "").trim();
  const textMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([A-Z_]{2,20})/i);
  const amount = Number(directAmount ?? textMatch?.[1] ?? 0);
  const token = normalizeRewardToken(directToken ?? textMatch?.[2] ?? "");
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    token,
  };
}

function rewardTotalsFromAnalyticsSession(analytics = {}) {
  const session =
    analytics?.session && typeof analytics.session === "object"
      ? analytics.session
      : {};
  const earned =
    session?.currencyEarned && typeof session.currencyEarned === "object"
      ? session.currencyEarned
      : {};
  return {
    pbp: Number(earned.pbp || 0) || 0,
    tc: Number(earned.tc || 0) || 0,
    cc: Number(earned.cc || 0) || 0,
  };
}

function spendTotalsFromAnalyticsSession(analytics = {}) {
  const session =
    analytics?.session && typeof analytics.session === "object"
      ? analytics.session
      : {};
  return {
    pbp: Number(session.totalResetCostPbp || 0) || 0,
    tc: 0,
    cc: 0,
  };
}

function normalizeTotals(raw = {}) {
  return {
    pbp: Number(raw?.pbp || 0) || 0,
    tc: Number(raw?.tc || 0) || 0,
    cc: Number(raw?.cc || 0) || 0,
  };
}

function mergeTotalsPeak(...sources) {
  const merged = normalizeTotals();
  for (const source of sources) {
    const next = normalizeTotals(source);
    merged.pbp = Math.max(merged.pbp, next.pbp);
    merged.tc = Math.max(merged.tc, next.tc);
    merged.cc = Math.max(merged.cc, next.cc);
  }
  return merged;
}

function applyAnalyticsClaimEvent(payload = {}) {
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  const mission = resolveMissionLabelFromPayload(payload);
  const at = Number(payload?.at || Date.now());
  const reward = rewardFromStatsPayload(payload);

  current.lifetime.totalClaims += 1;
  current.session.totalClaims += 1;
  current.lifetime.missionClaims[mission] =
    Number(current.lifetime.missionClaims[mission] || 0) + 1;
  current.session.missionClaims[mission] =
    Number(current.session.missionClaims[mission] || 0) + 1;
  current.lifetime.claimHistory = normalizeClaimHistory([
    ...(current.lifetime.claimHistory || []),
    {
      at: Number.isFinite(at) ? at : Date.now(),
      claims: current.lifetime.totalClaims,
      mission,
      assignedMissionId:
        String(payload?.assignedMissionId || "").trim() || null,
      slot: Number.isFinite(Number(payload?.slot))
        ? Number(payload.slot)
        : null,
      rewardAmount:
        reward.amount > 0 && Number.isFinite(reward.amount)
          ? reward.amount
          : null,
      rewardToken: reward.token || null,
    },
  ]);
  current.session.claimHistory = normalizeClaimHistory([
    ...(current.session.claimHistory || []),
    {
      at: Number.isFinite(at) ? at : Date.now(),
      claims: current.session.totalClaims,
      mission,
      assignedMissionId:
        String(payload?.assignedMissionId || "").trim() || null,
      slot: Number.isFinite(Number(payload?.slot))
        ? Number(payload.slot)
        : null,
      rewardAmount:
        reward.amount > 0 && Number.isFinite(reward.amount)
          ? reward.amount
          : null,
      rewardToken: reward.token || null,
    },
  ]);
  if (reward.token && reward.amount > 0) {
    current.lifetime.currencyEarned[reward.token] += reward.amount;
    current.session.currencyEarned[reward.token] += reward.amount;
  }
  saveAnalytics(current);
  trackFeatureUsage("mission_claim", {
    mission_name: mission,
    reward_token: reward.token || undefined,
    reward_amount: reward.amount > 0 ? reward.amount : undefined,
  });
  publishStatus();
  return true;
}

function applyAnalyticsSpendEvent(payload = {}) {
  const amount = Number(payload?.amount ?? payload?.cost ?? payload?.pbp ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const action =
    String(payload?.actionName || payload?.action || "other").trim() || "other";
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  current.lifetime.totalResetCostPbp += amount;
  current.session.totalResetCostPbp += amount;
  current.lifetime.spendByAction[action] =
    Number(current.lifetime.spendByAction[action] || 0) + amount;
  current.session.spendByAction[action] =
    Number(current.session.spendByAction[action] || 0) + amount;
  current.lifetime.spendHistory = normalizeSpendHistory([
    ...(current.lifetime.spendHistory || []),
    { at: Date.now(), amount, action },
  ]);
  current.session.spendHistory = normalizeSpendHistory([
    ...(current.session.spendHistory || []),
    { at: Date.now(), amount, action },
  ]);
  saveAnalytics(current);
  trackFeatureUsage("spend", {
    action_name: action,
    amount,
    currency: "pbp",
  });
  publishStatus();
  return true;
}

function applyAnalyticsResetEvent(payload = {}) {
  const kind = String(
    payload?.resetType || payload?.kind || payload?.type || "mission",
  )
    .trim()
    .toLowerCase();
  const bucket =
    kind.includes("nft") || kind.includes("cooldown") ? "nft" : "mission";
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  current.lifetime.totalResets += 1;
  current.session.totalResets += 1;
  current.lifetime.resetTypes[bucket] += 1;
  current.session.resetTypes[bucket] += 1;
  current.lifetime.resetHistory = normalizeResetHistory([
    ...(current.lifetime.resetHistory || []),
    {
      at: Date.now(),
      kind: bucket,
      source: String(payload?.resetSource || payload?.source || "").trim(),
    },
  ]);
  current.session.resetHistory = normalizeResetHistory([
    ...(current.session.resetHistory || []),
    {
      at: Date.now(),
      kind: bucket,
      source: String(payload?.resetSource || payload?.source || "").trim(),
    },
  ]);
  if (bucket === "nft") {
    const source = String(payload?.resetSource || payload?.source || "")
      .trim()
      .toLowerCase();
    const usageBucket = source === "rental" ? "rental" : "owned";
    current.lifetime.nftResetUsage[usageBucket].resets += 1;
    current.session.nftResetUsage[usageBucket].resets += 1;
  }
  saveAnalytics(current);
  trackFeatureUsage("reset", {
    reset_type: bucket,
    reset_source:
      String(payload?.resetSource || payload?.source || "").trim() || undefined,
  });
  publishStatus();
  return true;
}

function applyAnalyticsRentalEvent() {
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  current.lifetime.totalLeased += 1;
  current.session.totalLeased += 1;
  current.lifetime.rentalHistory = normalizeRentalHistory([
    ...(current.lifetime.rentalHistory || []),
    { at: Date.now() },
  ]);
  current.session.rentalHistory = normalizeRentalHistory([
    ...(current.session.rentalHistory || []),
    { at: Date.now() },
  ]);
  saveAnalytics(current);
  trackFeatureUsage("rental_started");
  publishStatus();
  return true;
}

function applyAnalyticsAssignmentEvent(payload = {}) {
  if (payload?.usedReset !== true) return false;
  const source = String(payload?.source || "")
    .trim()
    .toLowerCase();
  const usageBucket = source === "rental" ? "rental" : "owned";
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  current.lifetime.nftResetUsage[usageBucket].assigned += 1;
  current.session.nftResetUsage[usageBucket].assigned += 1;
  current.lifetime.assignmentHistory = normalizeAssignmentHistory([
    ...(current.lifetime.assignmentHistory || []),
    {
      at: Date.now(),
      source: usageBucket,
      nft: payload?.nft || payload?.nftName,
    },
  ]);
  current.session.assignmentHistory = normalizeAssignmentHistory([
    ...(current.session.assignmentHistory || []),
    {
      at: Date.now(),
      source: usageBucket,
      nft: payload?.nft || payload?.nftName,
    },
  ]);
  saveAnalytics(current);
  trackFeatureUsage("nft_reset_assignment", {
    source: usageBucket,
  });
  publishStatus();
  return true;
}

function analyticsBucketFromRange(bucket = {}, rangeKey = "session") {
  const src = bucket && typeof bucket === "object" ? bucket : {};
  if (rangeKey === "session") {
    return {
      startedAt: Number.isFinite(Number(src.startedAt))
        ? Number(src.startedAt)
        : Date.now(),
      totalClaims: Number(src.totalClaims || 0) || 0,
      totalResets: Number(src.totalResets || 0) || 0,
      totalResetCostPbp: Number(src.totalResetCostPbp || 0) || 0,
      totalLeased: Number(src.totalLeased || 0) || 0,
      currencyEarned: normalizeTotals(src.currencyEarned),
      missionClaims: normalizeCounterObject(src.missionClaims),
      claimHistory: normalizeClaimHistory(src.claimHistory),
      spendHistory: normalizeSpendHistory(src.spendHistory),
      resetHistory: normalizeResetHistory(src.resetHistory),
      rentalHistory: normalizeRentalHistory(src.rentalHistory),
      assignmentHistory: normalizeAssignmentHistory(src.assignmentHistory),
      resetTypes: {
        mission: Number(src?.resetTypes?.mission || 0) || 0,
        nft: Number(src?.resetTypes?.nft || 0) || 0,
      },
      nftResetUsage: normalizeNftResetUsage(src.nftResetUsage),
      spendByAction: normalizeCounterObject(src.spendByAction),
      nftsUsed: Array.isArray(src.nftsUsed) ? src.nftsUsed.slice() : [],
    };
  }

  const rangeMs =
    rangeKey === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - rangeMs;
  const claimHistory = normalizeClaimHistory(src.claimHistory).filter(
    (entry) => Number(entry.at) >= cutoff,
  );
  const spendHistory = normalizeSpendHistory(src.spendHistory).filter(
    (entry) => Number(entry.at) >= cutoff,
  );
  const resetHistory = normalizeResetHistory(src.resetHistory).filter(
    (entry) => Number(entry.at) >= cutoff,
  );
  const rentalHistory = normalizeRentalHistory(src.rentalHistory).filter(
    (entry) => Number(entry.at) >= cutoff,
  );
  const assignmentHistory = normalizeAssignmentHistory(
    src.assignmentHistory,
  ).filter((entry) => Number(entry.at) >= cutoff);
  const currencyEarned = { pbp: 0, tc: 0, cc: 0 };
  const missionClaims = {};
  for (const entry of claimHistory) {
    const mission = String(entry?.mission || "").trim() || "unknown mission";
    missionClaims[mission] = Number(missionClaims[mission] || 0) + 1;
    const token = normalizeRewardToken(entry?.rewardToken);
    const amount = Number(entry?.rewardAmount || 0);
    if (token && Number.isFinite(amount) && amount > 0) {
      currencyEarned[token] += amount;
    }
  }
  const spendByAction = {};
  for (const entry of spendHistory) {
    spendByAction[entry.action] =
      Number(spendByAction[entry.action] || 0) + Number(entry.amount || 0);
  }
  const resetTypes = { mission: 0, nft: 0 };
  const nftResetUsage = {
    owned: { resets: 0, assigned: 0 },
    rental: { resets: 0, assigned: 0 },
  };
  for (const entry of resetHistory) {
    if (entry.kind === "nft") {
      resetTypes.nft += 1;
      nftResetUsage[entry.source === "rental" ? "rental" : "owned"].resets += 1;
    } else {
      resetTypes.mission += 1;
    }
  }
  for (const entry of assignmentHistory) {
    nftResetUsage[entry.source === "rental" ? "rental" : "owned"].assigned += 1;
  }
  const nftsUsed = Array.from(
    new Set(
      assignmentHistory
        .map((entry) => String(entry?.nft || "").trim())
        .filter(Boolean),
    ),
  );
  return {
    startedAt: cutoff,
    totalClaims: claimHistory.length,
    totalResets: resetHistory.length,
    totalResetCostPbp: spendHistory.reduce(
      (sum, entry) => sum + Number(entry.amount || 0),
      0,
    ),
    totalLeased: rentalHistory.length,
    currencyEarned,
    missionClaims,
    claimHistory,
    spendHistory,
    resetHistory,
    rentalHistory,
    assignmentHistory,
    resetTypes,
    nftResetUsage,
    spendByAction,
    nftsUsed,
  };
}

function rebuildAnalyticsBucketFromHistories(bucket = {}) {
  const claimHistory = normalizeClaimHistory(bucket.claimHistory);
  const spendHistory = normalizeSpendHistory(bucket.spendHistory);
  const resetHistory = normalizeResetHistory(bucket.resetHistory);
  const rentalHistory = normalizeRentalHistory(bucket.rentalHistory);
  const assignmentHistory = normalizeAssignmentHistory(
    bucket.assignmentHistory,
  );
  const currencyEarned = { pbp: 0, tc: 0, cc: 0 };
  const missionClaims = {};
  for (const entry of claimHistory) {
    const mission = String(entry?.mission || "").trim() || "unknown mission";
    missionClaims[mission] = Number(missionClaims[mission] || 0) + 1;
    const token = normalizeRewardToken(entry?.rewardToken);
    const amount = Number(entry?.rewardAmount || 0);
    if (token && Number.isFinite(amount) && amount > 0) {
      currencyEarned[token] += amount;
    }
  }
  const spendByAction = {};
  for (const entry of spendHistory) {
    spendByAction[entry.action] =
      Number(spendByAction[entry.action] || 0) + Number(entry.amount || 0);
  }
  const resetTypes = { mission: 0, nft: 0 };
  const nftResetUsage = {
    owned: { resets: 0, assigned: 0 },
    rental: { resets: 0, assigned: 0 },
  };
  for (const entry of resetHistory) {
    if (entry.kind === "nft") {
      resetTypes.nft += 1;
      nftResetUsage[entry.source === "rental" ? "rental" : "owned"].resets += 1;
    } else {
      resetTypes.mission += 1;
    }
  }
  for (const entry of assignmentHistory) {
    nftResetUsage[entry.source === "rental" ? "rental" : "owned"].assigned += 1;
  }
  return {
    ...bucket,
    totalClaims: claimHistory.length,
    totalResets: resetHistory.length,
    totalResetCostPbp: spendHistory.reduce(
      (sum, entry) => sum + Number(entry.amount || 0),
      0,
    ),
    totalLeased: rentalHistory.length,
    currencyEarned,
    missionClaims,
    claimHistory,
    spendHistory,
    resetHistory,
    rentalHistory,
    assignmentHistory,
    resetTypes,
    nftResetUsage,
    spendByAction,
    nftsUsed: Array.from(
      new Set(
        assignmentHistory
          .map((entry) => String(entry?.nft || "").trim())
          .filter(Boolean),
      ),
    ),
  };
}

function analyticsView(rangeKey = "session") {
  const analytics = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  const key = ["session", "24h", "7d", "all"].includes(rangeKey)
    ? rangeKey
    : "session";
  const bucket =
    key === "session"
      ? analytics.session
      : key === "all"
        ? analytics.lifetime
        : analyticsBucketFromRange(analytics.lifetime, key);
  return {
    rangeKey: key,
    analytics: bucket,
    sourcePath: getAnalyticsPath(),
  };
}

function resetAnalyticsRange(rangeKey = "session") {
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  const key = ["session", "24h", "7d", "all"].includes(rangeKey)
    ? rangeKey
    : "session";
  const emptySession = {
    startedAt: Date.now(),
    totalClaims: 0,
    totalResets: 0,
    totalResetCostPbp: 0,
    totalLeased: 0,
    currencyEarned: { pbp: 0, tc: 0, cc: 0 },
    missionClaims: {},
    claimHistory: [],
    spendHistory: [],
    resetHistory: [],
    rentalHistory: [],
    assignmentHistory: [],
    resetTypes: { mission: 0, nft: 0 },
    nftResetUsage: {
      owned: { resets: 0, assigned: 0 },
      rental: { resets: 0, assigned: 0 },
    },
    spendByAction: {},
    nftsUsed: [],
  };

  if (key === "all") {
    current.lifetime = {
      ...emptySession,
      startedAt: current.lifetime?.startedAt || Date.now(),
    };
    current.session = {
      ...emptySession,
      startedAt: Date.now(),
    };
  } else if (key === "session") {
    current.session = emptySession;
  } else {
    const cutoff = Date.now() - (key === "24h" ? 24 : 7 * 24) * 60 * 60 * 1000;
    const keepRecent = (entry) => Number(entry?.at) < cutoff;
    current.lifetime.claimHistory = normalizeClaimHistory(
      (current.lifetime.claimHistory || []).filter(keepRecent),
    );
    current.lifetime.spendHistory = normalizeSpendHistory(
      (current.lifetime.spendHistory || []).filter(keepRecent),
    );
    current.lifetime.resetHistory = normalizeResetHistory(
      (current.lifetime.resetHistory || []).filter(keepRecent),
    );
    current.lifetime.rentalHistory = normalizeRentalHistory(
      (current.lifetime.rentalHistory || []).filter(keepRecent),
    );
    current.lifetime.assignmentHistory = normalizeAssignmentHistory(
      (current.lifetime.assignmentHistory || []).filter(keepRecent),
    );
    current.lifetime = rebuildAnalyticsBucketFromHistories({
      ...current.lifetime,
      startedAt: current.lifetime?.startedAt || Date.now(),
    });
  }
  saveAnalytics(current);
  publishStatus();
  return analyticsView(key);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildAnalyticsCsv(rangeKey = "session") {
  const view = analyticsView(rangeKey);
  const bucket = view.analytics || {};
  const lines = [
    ["Range", view.rangeKey],
    [
      "Started At",
      Number(bucket.startedAt) > 0
        ? new Date(bucket.startedAt).toISOString()
        : "",
    ],
    ["Claims", Number(bucket.totalClaims || 0)],
    ["Mission Resets", Number(bucket?.resetTypes?.mission || 0)],
    ["NFT Resets", Number(bucket?.resetTypes?.nft || 0)],
    ["Total Resets", Number(bucket.totalResets || 0)],
    ["Leases", Number(bucket.totalLeased || 0)],
    ["PBP Earned", Number(bucket?.currencyEarned?.pbp || 0)],
    ["TC Earned", Number(bucket?.currencyEarned?.tc || 0)],
    ["CC Earned", Number(bucket?.currencyEarned?.cc || 0)],
    ["PBP Spent", Number(bucket.totalResetCostPbp || 0)],
    [],
    ["Mission", "Claims"],
    ...Object.entries(bucket.missionClaims || {}).map(([mission, claims]) => [
      mission,
      Number(claims || 0),
    ]),
    [],
    [
      "Claim At",
      "Mission",
      "Assigned Mission ID",
      "Slot",
      "Reward Amount",
      "Reward Token",
    ],
    ...normalizeClaimHistory(bucket.claimHistory).map((entry) => [
      new Date(entry.at).toISOString(),
      entry.mission,
      entry.assignedMissionId || "",
      entry.slot ?? "",
      entry.rewardAmount ?? "",
      entry.rewardToken || "",
    ]),
  ];
  return lines
    .map((row) => row.map((value) => csvEscape(value)).join(","))
    .join("\n");
}

async function exportAnalyticsCsv(rangeKey = "session") {
  const key = ["session", "24h", "7d", "all"].includes(rangeKey)
    ? rangeKey
    : "session";
  const defaultName = `missions-stats-${key}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  const result = await dialog.showSaveDialog(controlWindow || undefined, {
    title: "Export Stats CSV",
    defaultPath: path.join(getBackendWorkingDirectory(), "data", defaultName),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  fs.writeFileSync(result.filePath, buildAnalyticsCsv(key), "utf8");
  return { ok: true, filePath: result.filePath };
}

function applyAnalyticsLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  const current = normalizeAnalytics(
    backendStatus.analytics || loadAnalytics(),
  );
  let changed = false;

  const nftMatches = [];
  const nftEq = text.match(/nft=([^\s,]+)/i);
  if (nftEq && nftEq[1]) nftMatches.push(String(nftEq[1]).trim());
  const nftAccountEq = text.match(/nftAccount=([^\s,]+)/i);
  if (nftAccountEq && nftAccountEq[1])
    nftMatches.push(String(nftAccountEq[1]).trim());
  const assignedText = text.match(/Assigned NFT\s+([A-Za-z0-9]+)/i);
  if (assignedText && assignedText[1])
    nftMatches.push(String(assignedText[1]).trim());

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
  const { config: current, parseFailed } = readDesktopConfigWithMeta();
  if (parseFailed) {
    throw new Error(
      "Refusing to overwrite config.json because it is not valid JSON. Fix syntax first.",
    );
  }
  const next = {
    ...current,
    ...patch,
  };
  const file = getConfigPath();
  const json = JSON.stringify(next, null, 2);
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8");
      if (existing === json) {
        if (typeof next.competitionRangeLockEnabled === "boolean") {
          competitionRangeLockLiveEnabled = next.competitionRangeLockEnabled;
        }
        return next;
      }
    }
  } catch {}
  fs.writeFileSync(file, json);
  if (typeof next.competitionRangeLockEnabled === "boolean") {
    competitionRangeLockLiveEnabled = next.competitionRangeLockEnabled;
  }
  return next;
}

function syncDesktopTargetMissionsFromAssignedMissions(
  missions = [],
  source = "startup",
) {
  const missionList = Array.isArray(missions) ? missions : [];
  const nextTargets = [];
  for (let i = 1; i <= 4; i += 1) {
    const mission =
      missionList.find((entry) => Number(entry?.slot) === i) || null;
    const name = String(mission?.name || mission?.missionName || "").trim();
    if (name) nextTargets.push(name);
  }
  const uniqueTargets = Array.from(new Set(nextTargets));
  if (uniqueTargets.length === 0) return [];
  const currentConfig = readDesktopConfig();
  const currentTargets = Array.isArray(currentConfig?.targetMissions)
    ? currentConfig.targetMissions
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    : [];
  if (JSON.stringify(currentTargets) === JSON.stringify(uniqueTargets)) {
    return uniqueTargets;
  }
  applyDesktopConfigPatch({ targetMissions: uniqueTargets });
  pushSystemLog(
    `${source}: synced target missions -> ${uniqueTargets.join(", ")}`,
  );
  return uniqueTargets;
}

function normalizedDesktopSignerMode(value) {
  const mode = String(value || "").trim();
  if (mode === "browser_wallet") return "dapp";
  if (mode === "signing") return "app_wallet";
  if (mode === "manual" || mode === "dapp" || mode === "app_wallet") {
    return mode;
  }
  return "";
}

function hydrateBackendStatusFromConfig() {
  const config = readDesktopConfig();
  if (typeof config?.competitionRangeLockEnabled === "boolean") {
    competitionRangeLockLiveEnabled = config.competitionRangeLockEnabled;
  }
  backendStatus.analytics = loadAnalytics();
  beginAnalyticsSession({ force: true });
  backendStatus.defaultMissionResetLevel =
    defaultMissionResetLevelForConfig(config);
  backendStatus.debugMode = config.debugMode === true;
  if (typeof config.level20ResetEnabled === "boolean") {
    backendStatus.level20ResetEnabled = config.level20ResetEnabled;
  }
  if (typeof config.missionModeEnabled === "boolean") {
    backendStatus.missionModeEnabled = config.missionModeEnabled;
  }
  if (
    config.missionActionEnabledBySlot &&
    typeof config.missionActionEnabledBySlot === "object"
  ) {
    backendStatus.missionActionEnabledBySlot = {
      ...config.missionActionEnabledBySlot,
    };
  } else {
    backendStatus.missionActionEnabledBySlot = {
      1: true,
      2: true,
      3: true,
      4: true,
    };
  }
  if (typeof config.missionResetPerSlotModeEnabled === "boolean") {
    backendStatus.missionResetPerSlotModeEnabled =
      config.missionResetPerSlotModeEnabled;
  } else {
    backendStatus.missionResetPerSlotModeEnabled = false;
  }
  if (
    config.missionResetPerSlotEnabledBySlot &&
    typeof config.missionResetPerSlotEnabledBySlot === "object"
  ) {
    backendStatus.missionResetPerSlotEnabledBySlot = {
      ...config.missionResetPerSlotEnabledBySlot,
    };
  } else {
    backendStatus.missionResetPerSlotEnabledBySlot = {
      1: false,
      2: false,
      3: false,
      4: false,
    };
  }
  if (
    config.missionResetPerSlotLevelBySlot &&
    typeof config.missionResetPerSlotLevelBySlot === "object"
  ) {
    backendStatus.missionResetPerSlotLevelBySlot = {
      ...config.missionResetPerSlotLevelBySlot,
    };
  } else {
    const fallbackLevel =
      Number(config.missionResetLevel || defaultMissionResetLevelForConfig(config)) ||
      11;
    backendStatus.missionResetPerSlotLevelBySlot = {
      1: fallbackLevel,
      2: fallbackLevel,
      3: fallbackLevel,
      4: fallbackLevel,
    };
  }
  if (typeof config.nftCooldownResetEnabled === "boolean") {
    backendStatus.nftCooldownResetEnabled = config.nftCooldownResetEnabled;
  } else {
    backendStatus.nftCooldownResetEnabled = false;
  }
  if (config.nftCooldownResetMaxPbp !== undefined) {
    const maxPbp = Number(config.nftCooldownResetMaxPbp);
    backendStatus.nftCooldownResetMaxPbp =
      Number.isFinite(maxPbp) && maxPbp >= 0 ? maxPbp : 20;
  } else {
    backendStatus.nftCooldownResetMaxPbp = 20;
  }
  if (typeof config.missionResetLevel === "string") {
    backendStatus.currentMissionResetLevel = config.missionResetLevel;
  }
  if (!backendStatus.currentMissionResetLevel) {
    backendStatus.currentMissionResetLevel =
      defaultMissionResetLevelForConfig(config);
  }
  backendStatus.currentMode = backendStatus.missionModeEnabled
    ? `mission-${backendStatus.currentMissionResetLevel || defaultMissionResetLevelForConfig(config)}`
    : "normal";
  syncCompetitionRangeLockScheduler();
}

async function runDesktopUpdateCheck({ manual = false } = {}) {
  const currentVersion = app.getVersion();
  const result = await checkForUpdates({
    currentVersion,
    logger: isDesktopDevMode()
      ? (message) =>
          pushSystemLog(`Update check failed: ${String(message || "unknown")}`)
      : null,
  });
  return {
    ok: result.ok === true,
    manual: manual === true,
    currentVersion: String(
      result.currentVersion || currentVersion || "",
    ).trim(),
    latestVersion: String(result.latestVersion || "").trim() || null,
    downloadUrl: String(result.downloadUrl || "").trim() || null,
    notes: Array.isArray(result.notes)
      ? result.notes.map((note) => String(note).trim()).filter(Boolean)
      : String(result.notes || "")
          .split(/\r?\n|,/)
          .map((note) => note.trim())
          .filter(Boolean),
    updateAvailable: result.updateAvailable === true,
    reason: result.reason || null,
  };
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
    return raw
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const amount = Number(
          entry.balance ?? entry.displayBalance ?? entry.amount ?? NaN,
        );
        const symbolSource =
          entry.symbol || entry.code || entry.key || entry.name || "";
        const nameSource =
          entry.name || entry.symbol || entry.code || entry.key || "";
        return {
          ...entry,
          key: String(
            entry.key || entry.code || entry.symbol || entry.name || "",
          )
            .trim()
            .toLowerCase(),
          symbol: String(symbolSource || "")
            .trim()
            .toUpperCase(),
          name: String(nameSource || "").trim(),
          balance: Number.isFinite(amount) ? amount : null,
          displayBalance: Number.isFinite(amount)
            ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : (entry.displayBalance ?? null),
        };
      });
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
  const parseMaybeNumber = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const n = Number(value.replace(/[, _]/g, "").trim());
    return Number.isFinite(n) ? n : null;
  };
  const upsertBalanceEntry = (list, { key, symbol, name, balance }) => {
    const normalizedKey = String(key || symbol || name || "")
      .trim()
      .toLowerCase();
    const amount = Number(balance);
    if (!normalizedKey || !Number.isFinite(amount)) return list;
    const next = Array.isArray(list) ? list.slice() : [];
    const index = next.findIndex((entry) => {
      const entryKey = String(entry?.key || entry?.symbol || entry?.name || "")
        .trim()
        .toLowerCase();
      return entryKey === normalizedKey;
    });
    const patch = {
      key: normalizedKey,
      symbol: String(symbol || key || "")
        .trim()
        .toUpperCase(),
      name: String(name || symbol || key || "")
        .trim()
        .toUpperCase(),
      mint: null,
      balance: amount,
      displayBalance: amount.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      }),
    };
    if (index >= 0) next[index] = { ...next[index], ...patch };
    else next.push(patch);
    return next;
  };
  const sc = payload?.structuredContent || {};
  const walletId = sc.walletId || sc.wallet_id || null;
  const displayName = sc.displayName || sc.display_name || null;
  const baseBalances = normalizeWalletBalanceEntries(
    sc.balances || sc.walletBalances || sc.wallet_balances || [],
  );
  const virtualCurrencies = sc.virtualCurrencies || sc.virtual_currencies || {};
  const virtualCurrencyBalances =
    normalizeWalletBalanceEntries(virtualCurrencies);
  let mergedBalances = [...baseBalances, ...virtualCurrencyBalances];
  const solFromPayload =
    parseMaybeNumber(sc.solBalance) ??
    parseMaybeNumber(sc.sol_balance) ??
    parseMaybeNumber(sc.sol);
  const pbpFromPayload =
    parseMaybeNumber(sc.pbpBalance) ??
    parseMaybeNumber(sc.pbp_balance) ??
    parseMaybeNumber(sc.pbp);
  if (solFromPayload !== null) {
    mergedBalances = upsertBalanceEntry(mergedBalances, {
      key: "sol",
      symbol: "SOL",
      name: "SOL",
      balance: solFromPayload,
    });
  }
  if (pbpFromPayload !== null) {
    mergedBalances = upsertBalanceEntry(mergedBalances, {
      key: "pbp",
      symbol: "PBP",
      name: "PBP",
      balance: pbpFromPayload,
    });
  }
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

function resolveMissionLabelFromPayload(payload = {}) {
  const directName = String(
    payload?.missionName ||
      payload?.name ||
      payload?.mission_name ||
      payload?.title ||
      payload?.mission ||
      payload?.label ||
      "",
  ).trim();
  if (directName && !looksLikeOpaqueMissionId(directName)) {
    return directName;
  }

  const assignedMissionId = String(payload?.assignedMissionId || "").trim();
  const slot = Number(payload?.slot);
  const guiSlots = Array.isArray(backendStatus.guiMissionSlots)
    ? backendStatus.guiMissionSlots
    : [];

  if (assignedMissionId) {
    const byId =
      guiSlots.find(
        (entry) =>
          String(entry?.missionId || "").trim() === assignedMissionId ||
          String(entry?.id || "").trim() === assignedMissionId ||
          String(entry?.assignedMissionId || "").trim() === assignedMissionId,
      ) || null;
    const byIdName = String(missionDisplayName(byId)).trim();
    if (byIdName && !looksLikeOpaqueMissionId(byIdName)) {
      return byIdName;
    }
  }

  if (Number.isFinite(slot) && slot >= 1) {
    const bySlot =
      guiSlots.find((entry) => Number(entry?.slot) === Math.floor(slot)) ||
      null;
    const bySlotName = String(missionDisplayName(bySlot)).trim();
    if (bySlotName && !looksLikeOpaqueMissionId(bySlotName)) {
      return bySlotName;
    }
  }

  if (directName) {
    return directName;
  }

  const fallbackId = String(payload?.assignedMissionId || "").trim();
  if (fallbackId) {
    return fallbackId;
  }

  return "unknown mission";
}

function missionAssignedNftAccount(mission = {}) {
  const directId = String(
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
  if (directId && directId !== "[object Object]") return directId;

  const directObject =
    mission?.currentAssignedNft &&
    typeof mission.currentAssignedNft === "object"
      ? mission.currentAssignedNft
      : mission?.current_assigned_nft &&
          typeof mission.current_assigned_nft === "object"
        ? mission.current_assigned_nft
        : mission?.assigned_nft && typeof mission.assigned_nft === "object"
          ? mission.assigned_nft
          : mission?.assignedNft && typeof mission.assignedNft === "object"
            ? mission.assignedNft
            : mission?.nft && typeof mission.nft === "object"
              ? mission.nft
              : null;
  return (
    mission?.currentAssignedNftAccount ||
    mission?.current_assigned_nft_account ||
    mission?.assigned_nft_account ||
    mission?.assignedNftAccount ||
    mission?.nft_account ||
    mission?.nftAccount ||
    directObject?.account ||
    directObject?.nftAccount ||
    directObject?.nft_account ||
    directObject?.tokenAddress ||
    directObject?.token_address ||
    null
  );
}

function assignedNftImageFromMission(mission = {}) {
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

  const nft =
    mission?.currentAssignedNft &&
    typeof mission.currentAssignedNft === "object"
      ? mission.currentAssignedNft
      : mission?.current_assigned_nft &&
          typeof mission.current_assigned_nft === "object"
        ? mission.current_assigned_nft
        : mission?.assigned_nft && typeof mission.assigned_nft === "object"
          ? mission.assigned_nft
          : mission?.assignedNft && typeof mission.assignedNft === "object"
            ? mission.assignedNft
            : mission?.nft && typeof mission.nft === "object"
              ? mission.nft
              : null;

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
} = {}) {
  const ok = await desktopMcp.runLoginFlow({
    forceInteractive: true,
    forceBrowser: true,
  });
  if (!ok) throw new Error("login_failed");
}

function installMinimalApplicationMenu() {
  const template = isDesktopDevMode()
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
  const hideMenuBar = !isDesktopDevMode();
  if (typeof win.setMenuBarVisibility === "function") {
    win.setMenuBarVisibility(!hideMenuBar);
  }
  if (typeof win.setAutoHideMenuBar === "function") {
    win.setAutoHideMenuBar(hideMenuBar);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (!isDesktopDevMode()) {
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
  const currentConfig = readDesktopConfig();
  if (typeof currentConfig?.competitionRangeLockEnabled === "boolean") {
    competitionRangeLockLiveEnabled = currentConfig.competitionRangeLockEnabled;
  }
  const startPausedForCompLock =
    shouldRunCompetitionRangeLock(currentConfig) &&
    currentConfig?.watchLoopEnabled === true;
  const startupSnapshotPath = writeStartupSnapshotFile();
  backend = fork(path.join(ROOT_DIR, "app.js"), ["--plain-output"], {
    cwd: getBackendWorkingDirectory(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PBP_GUI_BRIDGE: "1",
      PBP_DEV_MODE: isDesktopDevMode() ? "1" : "0",
      PBP_CONFIG_DIR: getBackendWorkingDirectory(),
      PBP_DEFAULT_MISSION_RESET_LEVEL:
        defaultMissionResetLevelForConfig(currentConfig),
      ...(startPausedForCompLock
        ? { PBP_START_PAUSED_FOR_COMP_LOCK: "1" }
        : {}),
      ...(startupSnapshotPath
        ? { PBP_STARTUP_SNAPSHOT_PATH: startupSnapshotPath }
        : {}),
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
  backendStatus.currentMissionStats = null;
  backendStatus.currentMode = null;
  backendStatus.level20ResetEnabled = null;
  backendStatus.missionModeEnabled = null;
  backendStatus.missionActionEnabledBySlot = null;
  backendStatus.missionResetPerSlotModeEnabled = null;
  backendStatus.missionResetPerSlotEnabledBySlot = null;
  backendStatus.missionResetPerSlotLevelBySlot = null;
  backendStatus.nftCooldownResetEnabled = null;
  backendStatus.nftCooldownResetMaxPbp = null;
  backendStatus.currentMissionResetLevel = null;
  backendStatus.sessionTotalsEpoch = null;
  backendStatus.sessionRewardTotals = null;
  backendStatus.sessionSpendTotals = null;
  backendStatus.guiMissionSlots = null;
  backendStatus.slotUnlockSummary = null;
  syncCompetitionRangeLockScheduler();
  publishStatus();
  pushOutput("system", "[GUI] Backend started.\n");
  startTelemetrySession();

  backend.stdout.on("data", (chunk) => {
    pushOutput("stdout", chunk.toString("utf8"));
  });

  backend.stderr.on("data", (chunk) => {
    pushOutput("stderr", chunk.toString("utf8"));
  });

  backend.on("message", (message) => {
    updateBackendStateFromIpc(message);
    if (message && message.type === "pbp_event") {
      if (message.event === "stats_claim") {
        applyAnalyticsClaimEvent(message.payload || {});
        triggerCompetitionRangeLockImmediateCheck("post_claim");
      } else if (message.event === "stats_spend") {
        applyAnalyticsSpendEvent(message.payload || {});
      } else if (message.event === "stats_reset") {
        applyAnalyticsResetEvent(message.payload || {});
      } else if (message.event === "stats_assignment") {
        applyAnalyticsAssignmentEvent(message.payload || {});
      } else if (message.event === "stats_rental") {
        applyAnalyticsRentalEvent(message.payload || {});
      }
      if (message.event === "app_quit") {
        requestAppQuit("app_quit");
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
    stopTelemetrySession("runner_stop");
    syncCompetitionRangeLockScheduler();
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
  syncCompetitionRangeLockScheduler();
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

async function waitForBackendStopped(timeoutMs = 7000) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 7000);
  while (Date.now() < deadline) {
    if (!backend || backendStatus.running !== true) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !backend || backendStatus.running !== true;
}

async function restartBackend() {
  if (!backend || backendStatus.running !== true) {
    startBackend();
    return { ...backendStatus };
  }
  stopBackend();
  const stopped = await waitForBackendStopped(7000);
  if (!stopped) {
    throw new Error("Failed to stop backend for restart.");
  }
  startBackend();
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

  if (cmd === "mr") {
    if (parts.length === 1) return { type: "mr", mode: "toggle" };
    if (arg === "on" || arg === "off") return { type: "mr", mode: arg };
    return { type: "invalidMr" };
  }

  if (cmd === "debug") {
    if (parts.length === 1) return { type: "debug_status" };
    if (arg === "on" || arg === "off") return { type: "debug", mode: arg };
    return { type: "invalidDebug" };
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
        current.missionResetLevel || defaultMissionResetLevelForConfig(current),
      );
    }
  }

  if (parsed.type === "debug") {
    patch.debugMode = parsed.mode === "on";
  }

  if (parsed.type === "mr") {
    if (parsed.mode === "off") {
      patch.missionResetPerSlotModeEnabled = false;
    } else {
      if (current.debugMode !== true) return current;
      patch.missionResetPerSlotModeEnabled =
        parsed.mode === "toggle"
          ? current.missionResetPerSlotModeEnabled !== true
          : true;
    }
  }

  const next = applyDesktopConfigPatch(patch);
  if (typeof next.level20ResetEnabled === "boolean") {
    backendStatus.level20ResetEnabled = next.level20ResetEnabled;
  }
  if (typeof next.missionModeEnabled === "boolean") {
    backendStatus.missionModeEnabled = next.missionModeEnabled;
  }
  if (typeof next.missionResetPerSlotModeEnabled === "boolean") {
    backendStatus.missionResetPerSlotModeEnabled =
      next.missionResetPerSlotModeEnabled;
  }
  if (typeof next.debugMode === "boolean") {
    backendStatus.debugMode = next.debugMode;
  }
  backendStatus.defaultMissionResetLevel =
    defaultMissionResetLevelForConfig(next);
  if (
    patch.debugMode !== undefined &&
    (typeof next.missionResetLevel !== "string" ||
      !next.missionResetLevel.trim())
  ) {
    backendStatus.currentMissionResetLevel =
      backendStatus.defaultMissionResetLevel;
  }
  if (typeof next.missionResetLevel === "string") {
    backendStatus.currentMissionResetLevel = next.missionResetLevel;
  }
  if (
    next.missionResetPerSlotEnabledBySlot &&
    typeof next.missionResetPerSlotEnabledBySlot === "object"
  ) {
    backendStatus.missionResetPerSlotEnabledBySlot = {
      ...next.missionResetPerSlotEnabledBySlot,
    };
  }
  if (
    next.missionResetPerSlotLevelBySlot &&
    typeof next.missionResetPerSlotLevelBySlot === "object"
  ) {
    backendStatus.missionResetPerSlotLevelBySlot = {
      ...next.missionResetPerSlotLevelBySlot,
    };
  }
  backendStatus.currentMode = backendStatus.missionModeEnabled
    ? `mission-${backendStatus.currentMissionResetLevel || backendStatus.defaultMissionResetLevel}`
    : "normal";
  syncCompetitionRangeLockScheduler();
  publishStatus();
  return next;
}

function debugToggleSummaryLines(config = {}) {
  const enabled = config?.debugMode === true;
  const defaults = runtimeDefaultsForFlags({
    debugMode: enabled,
    devMode: isDesktopDevMode(),
  });
  return [
    `[DEBUG] Debug mode ${enabled ? "enabled" : "disabled"}.`,
    `[DEBUG] runtimeDefaults: missionResetLevel ${NORMAL_DEFAULTS.missionResetLevel} -> ${defaults.missionResetLevel}, rentalFastRefreshTickMs ${NORMAL_DEFAULTS.rentalFastRefreshTickMs} -> ${defaults.rentalFastRefreshTickMs}, rentalBatchLimit ${NORMAL_DEFAULTS.rentalBatchLimit} -> ${defaults.rentalBatchLimit}, watchMinCycleSeconds ${NORMAL_DEFAULTS.watchMinCycleSeconds} -> ${defaults.watchMinCycleSeconds}, watchDefaultPollSeconds ${NORMAL_DEFAULTS.watchDefaultPollSeconds} -> ${defaults.watchDefaultPollSeconds}`,
    `[DEBUG] watcher behavior: live mission polling=${enabled ? "enabled" : "disabled unless separately configured"}, verbose debug logs=${enabled ? "enabled" : "disabled"}, startup FX=${enabled ? "disabled" : "enabled"}`,
    `[DEBUG] auth behavior: startup interactive login=${enabled ? "enabled when token is missing" : "normal token-first flow"}, browser login prompts=${enabled ? "enabled" : "disabled unless interactiveAuth is enabled"}`,
    `[DEBUG] auto NFT cooldown reset gate: debug=${enabled}, missionMode=${config?.missionModeEnabled === true}, nftCooldownResetEnabled=${config?.nftCooldownResetEnabled === true}`,
    `[DEBUG] dev-equivalent defaults are now ${enabled ? "active" : "inactive"}; target dev values are missionResetLevel=${DEV_DEFAULTS.missionResetLevel}, rentalFastRefreshTickMs=${DEV_DEFAULTS.rentalFastRefreshTickMs}, rentalBatchLimit=${DEV_DEFAULTS.rentalBatchLimit}, watchMinCycleSeconds=${DEV_DEFAULTS.watchMinCycleSeconds}, watchDefaultPollSeconds=${DEV_DEFAULTS.watchDefaultPollSeconds}`,
  ];
}

function toggleSettingsSummaryLines(config = {}, runtimeStatus = {}) {
  const configuredMissionResetLevel = String(
    runtimeStatus?.currentMissionResetLevel ||
      config?.missionResetLevel ||
      defaultMissionResetLevelForConfig(config) ||
      "11",
  );
  const nftResetMaxPbp = Number(config?.nftCooldownResetMaxPbp);
  const normalizedNftResetMaxPbp =
    Number.isFinite(nftResetMaxPbp) && nftResetMaxPbp >= 0 ? nftResetMaxPbp : 20;
  const onOff = (enabled) => (enabled ? "ON" : "OFF");
  return [
    `┌─ TOGGLES ${"─".repeat(44)}`,
    `│ Mode              ${config?.missionModeEnabled === true ? "MISSION" : "NORMAL"}    Reset level ${configuredMissionResetLevel}`,
    `│ Level 20 reset    ${onOff(config?.level20ResetEnabled === true)}        Per-slot reset ${onOff(config?.missionResetPerSlotModeEnabled === true)}`,
    `│ NFT reset         ${onOff(config?.nftCooldownResetEnabled === true)}        Max cost ${normalizedNftResetMaxPbp} PBP`,
    `│ Rentals           ${onOff(config?.enableRentals === true)}        Fast refresh ${onOff(config?.rentalFastRefreshEnabled === true)}`,
    `│ Debug             ${onOff(config?.debugMode === true)}        Watch loop ${onOff(config?.watchLoopEnabled !== false)}`,
    `└${"─".repeat(57)}`,
  ];
}

async function sendBackendCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) {
    throw new Error("Command is empty.");
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "i" || normalized === "settings" || normalized === "toggles") {
    if (!backend || !backendStatus.running) {
      const current = readDesktopConfig();
      pushOutput("stdin", `> ${trimmed}\n`);
      for (const line of toggleSettingsSummaryLines(current, backendStatus)) {
        pushOutput("system", `${line}\n`);
      }
      return true;
    }
  }
  if (normalized === "resume" && shouldRunCompetitionRangeLock()) {
    pushOutput("stdin", `> ${trimmed}\n`);
    pushSystemLog(
      "[COMP LOCK] Resume requested while finish target is armed; checking rank before allowing watcher start.",
    );
    triggerCompetitionRangeLockImmediateCheck("resume_gate");
    return true;
  }
  if (!backend || !backendStatus.running) {
    const parsed = parseStoppedModeCommand(trimmed);
    if (parsed.type === "mr") {
      const current = readDesktopConfig();
      const wouldEnable =
        parsed.mode === "on" ||
        (parsed.mode === "toggle" &&
          current.missionResetPerSlotModeEnabled !== true);
      if (wouldEnable && current.debugMode !== true) {
        throw new Error("mr requires debug mode to be enabled.");
      }
    }
    if (parsed.type === "start") {
      startBackend();
    } else if (
      parsed.type === "20r" ||
      parsed.type === "mm" ||
      parsed.type === "mr" ||
      parsed.type === "debug"
    ) {
      const next = applyStoppedModeConfig(parsed);
      pushOutput("stdin", `> ${trimmed}\n`);
      pushOutput(
        "system",
        `[GUI] Saved mode setting while runner is stopped.\n`,
      );
      if (parsed.type === "debug") {
        for (const line of debugToggleSummaryLines(next)) {
          pushOutput("system", `${line}\n`);
        }
      }
      return true;
    } else if (parsed.type === "debug_status") {
      const current = readDesktopConfig();
      pushOutput("stdin", `> ${trimmed}\n`);
      for (const line of debugToggleSummaryLines(current)) {
        pushOutput("system", `${line}\n`);
      }
      return true;
    } else if (parsed.type === "invalid20r") {
      throw new Error("Usage: 20r [on|off]");
    } else if (parsed.type === "invalidMm") {
      throw new Error("Usage: mm [off|on|<level>]");
    } else if (parsed.type === "invalidDebug") {
      throw new Error("Usage: debug [on|off]");
    } else if (parsed.type === "invalidMr") {
      throw new Error("Usage: mr [on|off]");
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
    pushSystemLog(
      `Backend request failed: ${action} -> backend is not running.`,
    );
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
    const currentConfig = readDesktopConfig();
    const signerMode = normalizedDesktopSignerMode(currentConfig?.signerMode);
    backend.send({
      type: "pbp_request",
      requestId,
      action,
      payload: {
        ...(payload && typeof payload === "object" ? payload : {}),
        ...(signerMode ? { __signerMode: signerMode } : {}),
      },
    });
  });
}

function clearCompetitionRangeLockTimer() {
  if (competitionRangeLockTimer) {
    clearTimeout(competitionRangeLockTimer);
    competitionRangeLockTimer = null;
  }
}

function scheduleCompetitionRangeLockTick(delayMs = 0) {
  clearCompetitionRangeLockTimer();
  competitionRangeLockTimer = setTimeout(
    () => {
      competitionRangeLockTimer = null;
      void runCompetitionRangeLockCycle();
    },
    Math.max(0, Number(delayMs) || 0),
  );
}

function competitionRangeLockTopRank(lockConfig = {}) {
  return Math.min(
    Number(lockConfig?.minRank) || 0,
    Number(lockConfig?.maxRank) || 0,
  );
}

function competitionLockDateMs(value) {
  const text = String(value || "").trim();
  if (!text || /^unknown$/i.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function competitionLifecycleState(competition = {}) {
  const startMs = competitionLockDateMs(
    competition?.start || competition?.datesText || "",
  );
  const endMs = competitionLockDateMs(
    competition?.end || competition?.datesText || "",
  );
  const now = Date.now();
  const hasRows = Array.isArray(competition?.userRows) && competition.userRows.length > 0;
  if (Number.isFinite(startMs) && now < startMs) {
    return { state: "upcoming", hasRows, startMs, endMs };
  }
  if (Number.isFinite(endMs) && now > endMs) {
    return { state: "ended", hasRows, startMs, endMs };
  }
  if (Number.isFinite(startMs) || Number.isFinite(endMs) || hasRows) {
    return { state: "active", hasRows, startMs, endMs };
  }
  return { state: "unknown", hasRows, startMs, endMs };
}

function selectCompetitionForRangeLock(scraped = {}) {
  const rawList = Array.isArray(scraped?.competitions) && scraped.competitions.length
    ? scraped.competitions
    : scraped
      ? [scraped]
      : [];
  const competitions = rawList.filter(
    (competition) => competition && typeof competition === "object",
  );
  if (!competitions.length) {
    return {
      selected: null,
      summary: [],
      reason: "no_competitions",
    };
  }
  const ranked = competitions.map((competition, index) => {
    const lifecycle = competitionLifecycleState(competition);
    const rows = Array.isArray(competition?.userRows) ? competition.userRows.length : 0;
    const number = String(competition?.competitionNumber || "").trim() || `index_${index}`;
    let score = 0;
    if (lifecycle.state === "active") score += 100;
    if (rows > 0) score += 50;
    if (lifecycle.state === "unknown" && rows > 0) score += 20;
    if (lifecycle.state === "ended") score -= 25;
    if (lifecycle.state === "upcoming") score -= 50;
    score -= index;
    return {
      competition,
      index,
      number,
      rows,
      lifecycle,
      score,
    };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    selected: ranked[0]?.competition || null,
    reason: ranked[0]?.lifecycle?.state || "unknown",
    summary: ranked.map((entry) => ({
      number: entry.number,
      rows: entry.rows,
      state: entry.lifecycle.state,
      score: entry.score,
    })),
  };
}

function triggerCompetitionRangeLockImmediateCheck(reason = "manual") {
  const config = readDesktopConfig();
  const state = competitionRangeLockRuntimeState(config);
  if (!state.enabled) {
    if (state.lockConfig.enabled === true) {
      pushSystemLog(
        `[COMP LOCK] Immediate recheck skipped (${String(reason || "manual").trim() || "manual"}): ${state.reasons.join(", ") || "inactive"}.`,
      );
    }
    return;
  }
  const detail = String(reason || "").trim();
  if (detail) {
    pushSystemLog(`[COMP LOCK] Immediate recheck requested (${detail}).`);
  }
  scheduleCompetitionRangeLockTick(0);
}

async function applyCompetitionRangeLockAction(action, detail) {
  const desired = String(action || "").trim();
  if (desired !== "pause" && desired !== "resume") return;
  if (desired === "pause") {
    const latestConfig = readDesktopConfig();
    if (!shouldRunCompetitionRangeLock(latestConfig)) {
      pushSystemLog(
        "[COMP LOCK] Toggle/config inactive at action time; skipping pause.",
      );
      return;
    }
  }
  if (!backendStatus.running) {
    pushSystemLog(
      `[COMP LOCK] ${detail}; backend is stopped, skipping ${desired}.`,
    );
    return;
  }
  const currentlyPaused = backendStatus.watchLoopEnabled === false;
  const currentlyRunning = backendStatus.watchLoopEnabled !== false;
  if (
    (desired === "pause" && currentlyPaused) ||
    (desired === "resume" && currentlyRunning)
  ) {
    const summary = `${desired}:${detail}`;
    if (competitionRangeLockLastSummary !== summary) {
      competitionRangeLockLastSummary = summary;
      pushSystemLog(`[COMP LOCK] ${detail}; already ${desired}d.`);
    }
    return;
  }
  const command = desired === "pause" ? "pause" : "resume";
  pushSystemLog(`[COMP LOCK] ${detail}; sending ${command}.`);
  await sendBackendCommand(command);
  competitionRangeLockLastSummary = `${desired}:${detail}`;
  competitionRangeLockPauseApplied = desired === "pause";
}

async function runCompetitionRangeLockCycle() {
  const config = readDesktopConfig();
  const state = competitionRangeLockRuntimeState(config);
  const { lockConfig } = state;
  if (!state.enabled) {
    competitionRangeLockLastSummary = "";
    competitionRangeLockRefreshPending = false;
    return;
  }
  if (competitionRangeLockRunning) {
    competitionRangeLockRefreshPending = true;
    return;
  }
  competitionRangeLockRunning = true;
  try {
    const topRank = competitionRangeLockTopRank(lockConfig);
    const userKeys = [
      normalizeCompetitionRowKey(backendStatus.currentUserDisplayName),
      normalizeCompetitionRowKey(backendStatus.currentUserWalletId),
    ].filter(Boolean);
    if (!userKeys.length) {
      pushSystemLog(
        "[COMP LOCK] Missing current user identity; waiting for whoami.",
      );
      return;
    }

    const scrapedCompetition = await scrapeLatestCompetition({
      competitionPick: "active",
    });
    if (scrapedCompetition?.debug?.challenge) {
      pushSystemLog(
        `[COMP LOCK] Competition scrape blocked (${scrapedCompetition.debug.challenge}).`,
      );
      return;
    }
    const competitionSelection =
      selectCompetitionForRangeLock(scrapedCompetition);
    const competition = competitionSelection.selected;
    if (!competition) {
      pushSystemLog("[COMP LOCK] No competition data available; no action.");
      return;
    }
    const rows = Array.isArray(competition?.userRows)
      ? competition.userRows
      : [];
    if (!rows.length) {
      const selectedNumber = String(
        competition?.competitionNumber || "unknown",
      ).trim();
      const candidates = competitionSelection.summary
        .map((entry) => `${entry.number}:${entry.state}:rows=${entry.rows}`)
        .join(", ");
      pushSystemLog(
        `[COMP LOCK] Competition rows unavailable; selected=${selectedNumber} reason=${competitionSelection.reason} candidates=[${candidates}]`,
      );
      return;
    }
    const currentRow =
      rows.find((row) => {
        const rowKey = normalizeCompetitionRowKey(row?.player);
        if (!rowKey) return false;
        return userKeys.some(
          (key) =>
            rowKey === key || rowKey.includes(key) || key.includes(rowKey),
        );
      }) || null;
    if (!currentRow || !Number.isFinite(Number(currentRow.rank))) {
      pushSystemLog("[COMP LOCK] Current user row not found; no action.");
      return;
    }

    const latestConfig = readDesktopConfig();
    if (!shouldRunCompetitionRangeLock(latestConfig)) {
      pushSystemLog("[COMP LOCK] Disabled during active check; skipping action.");
      return;
    }

    const rank = Number(currentRow.rank);
    const detail = `rank=${rank} threshold<=${topRank} player=${String(currentRow.player || "unknown").trim() || "unknown"}`;
    if (rank <= topRank) {
      await applyCompetitionRangeLockAction(
        "pause",
        `${detail} at/above lock threshold`,
      );
      return;
    }
    await applyCompetitionRangeLockAction(
      "resume",
      `${detail} below lock threshold`,
    );
  } catch (error) {
    pushSystemLog(
      `[COMP LOCK] Poll failed: ${String(error?.message || error)}`,
    );
  } finally {
    competitionRangeLockRunning = false;
    const pending = competitionRangeLockRefreshPending === true;
    competitionRangeLockRefreshPending = false;
    const nextRawConfig = readDesktopConfig();
    if (pending && shouldRunCompetitionRangeLock(nextRawConfig)) {
      scheduleCompetitionRangeLockTick(0);
      return;
    }
    const nextLockConfig = competitionRangeLockConfigFrom(nextRawConfig);
    if (shouldRunCompetitionRangeLock(nextRawConfig)) {
      scheduleCompetitionRangeLockTick(nextLockConfig.pollSeconds * 1000);
    }
  }
}

function syncCompetitionRangeLockScheduler() {
  const config = readDesktopConfig();
  const state = competitionRangeLockRuntimeState(config);
  const { lockConfig } = state;
  if (!state.enabled) {
    clearCompetitionRangeLockTimer();
    competitionRangeLockLastSummary = "";
    competitionRangeLockRefreshPending = false;
    if (competitionRangeLockPauseApplied) {
      competitionRangeLockPauseApplied = false;
      void applyCompetitionRangeLockAction(
        "resume",
        "finish target disabled; releasing competition lock pause",
      ).catch((error) => {
        pushSystemLog(
          `[COMP LOCK] Failed to resume after disable: ${String(error?.message || error)}`,
        );
      });
    } else if (lockConfig.enabled === true) {
      pushSystemLog(
        `[COMP LOCK] Finish target armed but inactive: ${state.reasons.join(", ") || "inactive"}.`,
      );
    }
    return;
  }
  scheduleCompetitionRangeLockTick(0);
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
    ...desktopWindowFrameOptions(),
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

  controlWindow.webContents.on("did-start-loading", () => {
    setSplashProgress(22);
  });
  controlWindow.webContents.on("dom-ready", () => {
    setSplashProgress(56);
  });
  controlWindow.webContents.on("did-frame-finish-load", () => {
    setSplashProgress(76);
  });
  controlWindow.webContents.on("did-stop-loading", () => {
    setSplashProgress(88);
  });
  controlWindow.once("ready-to-show", () => {
    setSplashProgress(100);
  });

  hardenWindow(controlWindow);
  await loadWindow(controlWindow);
}

function createSplashWindow() {
  splashProgressCurrent = 0;
  splashProgressTarget = 0;
  stopSplashProgressTimer();
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
      .stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
        opacity: 0.92;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 0;
      }
      .track {
        width: 200px;
        height: 14px;
        overflow: hidden;
        position: relative;
        border-radius: 999px;
        background: rgba(24, 24, 27, 0.92);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
      }
      .fill {
        position: absolute;
        inset: 0;
        height: 100%;
        border-radius: inherit;
        background-image: linear-gradient(
          90deg,
          #82E9AB 0%,
          #7FBFE9 25%,
          #9C87DB 50%,
          #D496EB 75%,
          #E3BFF1 100%
        );
      }
      .fill-mask {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 2;
        width: 100%;
        height: 100%;
        border-radius: 0 999px 999px 0;
        background: rgba(24, 24, 27, 0.92);
        transition: width 220ms ease-out;
      }
      .track-percent {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 3;
        font-size: 10px;
        line-height: 1;
        color: rgba(241, 241, 241, 0.95);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        font-variant-numeric: tabular-nums;
        pointer-events: none;
        mix-blend-mode: screen;
      }
      .message {
        color: #cfe6f5;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="stack">
        <div class="row">
          <div class="message">Draining pixel's wallets...</div>
        </div>
        <div class="track" aria-hidden="true">
          <div class="fill" id="splash-fill"></div>
          <div class="fill-mask" id="splash-fill-mask"></div>
          <div class="track-percent" id="splash-percent">0%</div>
        </div>
      </div>
    </div>
    <script>
      window.__updateSplashProgress__ = function updateSplashProgress(payload) {
        var state = payload && typeof payload === "object" ? payload : {};
        var progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
        var mask = document.getElementById("splash-fill-mask");
        var percent = document.getElementById("splash-percent");
        if (mask) mask.style.width = (100 - progress) + "%";
        if (percent) percent.textContent = Math.round(progress) + "%";
      };
    </script>
  </body>
</html>`;

  splashWindow.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`,
  );
  splashWindow.webContents.once("did-finish-load", () => {
    setSplashProgress(8);
  });
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
    ...desktopWindowFrameOptions(),
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
  ipcMain.handle("backend:restart", async () => restartBackend());
  ipcMain.handle("backend:send-command", async (_event, command) =>
    sendBackendCommand(command),
  );
  ipcMain.handle("backend:get-state", async () => ({
    status: { ...backendStatus },
    logs: logHistory,
  }));
  ipcMain.handle("analytics:get-view", async (_event, rangeKey = "session") =>
    analyticsView(rangeKey),
  );
  ipcMain.handle(
    "analytics:reset-range",
    async (_event, rangeKey = "session") => resetAnalyticsRange(rangeKey),
  );
  ipcMain.handle("analytics:export-csv", async (_event, rangeKey = "session") =>
    exportAnalyticsCsv(rangeKey),
  );
  ipcMain.handle("config:get", async () => {
    const config = readDesktopConfig();
    if (typeof config.autoUpdateCheckEnabled !== "boolean") {
      config.autoUpdateCheckEnabled = true;
      try {
        applyDesktopConfigPatch({ autoUpdateCheckEnabled: true });
      } catch {}
    }
    return { config };
  });
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
    if (
      next.missionActionEnabledBySlot &&
      typeof next.missionActionEnabledBySlot === "object"
    ) {
      backendStatus.missionActionEnabledBySlot = {
        ...next.missionActionEnabledBySlot,
      };
    }
    if (typeof next.missionResetPerSlotModeEnabled === "boolean") {
      backendStatus.missionResetPerSlotModeEnabled =
        next.missionResetPerSlotModeEnabled;
    }
    if (typeof next.nftCooldownResetEnabled === "boolean") {
      backendStatus.nftCooldownResetEnabled = next.nftCooldownResetEnabled;
    }
    if (typeof next.debugMode === "boolean") {
      backendStatus.debugMode = next.debugMode;
    }
    backendStatus.defaultMissionResetLevel =
      defaultMissionResetLevelForConfig(next);
    if (next.nftCooldownResetMaxPbp !== undefined) {
      const maxPbp = Number(next.nftCooldownResetMaxPbp);
      backendStatus.nftCooldownResetMaxPbp =
        Number.isFinite(maxPbp) && maxPbp >= 0 ? maxPbp : 20;
    }
    if (typeof next.missionResetLevel === "string") {
      backendStatus.currentMissionResetLevel = next.missionResetLevel;
    }
    if (
      next.missionResetPerSlotEnabledBySlot &&
      typeof next.missionResetPerSlotEnabledBySlot === "object"
    ) {
      backendStatus.missionResetPerSlotEnabledBySlot = {
        ...next.missionResetPerSlotEnabledBySlot,
      };
    }
    if (
      next.missionResetPerSlotLevelBySlot &&
      typeof next.missionResetPerSlotLevelBySlot === "object"
    ) {
      backendStatus.missionResetPerSlotLevelBySlot = {
        ...next.missionResetPerSlotLevelBySlot,
      };
    }
    if (typeof next.signerMode === "string") {
      const signerMode = normalizedDesktopSignerMode(next.signerMode);
      if (signerMode) backendStatus.signerMode = signerMode;
    }
    const previousSessionTotalsEpoch = backendStatus.sessionTotalsEpoch;
    if (next.sessionTotalsEpoch !== undefined) {
      backendStatus.sessionTotalsEpoch = next.sessionTotalsEpoch;
    }
    const sessionTotalsEpochChanged =
      next.sessionTotalsEpoch !== undefined &&
      next.sessionTotalsEpoch !== previousSessionTotalsEpoch;
    if (next.currentUserWalletSummary !== undefined) {
      backendStatus.currentUserWalletSummary = next.currentUserWalletSummary;
    }
    if (next.sessionRewardTotals !== undefined) {
      const analyticsTotals = rewardTotalsFromAnalyticsSession(
        backendStatus.analytics,
      );
      const nextTotals =
        next.sessionRewardTotals && typeof next.sessionRewardTotals === "object"
          ? next.sessionRewardTotals
          : null;
      backendStatus.sessionRewardTotals = sessionTotalsEpochChanged
        ? mergeTotalsPeak(nextTotals, analyticsTotals)
        : mergeTotalsPeak(
            backendStatus.sessionRewardTotals,
            nextTotals,
            analyticsTotals,
          );
    }
    if (next.sessionSpendTotals !== undefined) {
      const analyticsTotals = spendTotalsFromAnalyticsSession(
        backendStatus.analytics,
      );
      const nextTotals =
        next.sessionSpendTotals && typeof next.sessionSpendTotals === "object"
          ? next.sessionSpendTotals
          : null;
      backendStatus.sessionSpendTotals = sessionTotalsEpochChanged
        ? mergeTotalsPeak(nextTotals, analyticsTotals)
        : mergeTotalsPeak(
            backendStatus.sessionSpendTotals,
            nextTotals,
            analyticsTotals,
          );
    }
    backendStatus.currentMode = backendStatus.missionModeEnabled
      ? `mission-${backendStatus.currentMissionResetLevel || backendStatus.defaultMissionResetLevel}`
      : "normal";
    logConfigPatch("Desktop", requestedPatch);
    syncCompetitionRangeLockScheduler();
    publishStatus();
    if (
      backend &&
      backendStatus.running &&
      (Object.prototype.hasOwnProperty.call(requestedPatch, "debugMode") ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "missionActionEnabledBySlot",
        ) ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "missionResetPerSlotModeEnabled",
        ) ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "missionResetPerSlotEnabledBySlot",
        ) ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "missionResetPerSlotLevelBySlot",
        ) ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "nftCooldownResetEnabled",
        ) ||
        Object.prototype.hasOwnProperty.call(
          requestedPatch,
          "nftCooldownResetMaxPbp",
        ))
    ) {
      requestBackend("update_runtime_config", {
        debugMode: next.debugMode,
        missionActionEnabledBySlot: next.missionActionEnabledBySlot,
        missionResetPerSlotModeEnabled: next.missionResetPerSlotModeEnabled,
        missionResetPerSlotEnabledBySlot: next.missionResetPerSlotEnabledBySlot,
        missionResetPerSlotLevelBySlot: next.missionResetPerSlotLevelBySlot,
        nftCooldownResetEnabled: next.nftCooldownResetEnabled,
        nftCooldownResetMaxPbp: next.nftCooldownResetMaxPbp,
      }).catch((error) => {
        pushSystemLog(
          `Runtime config sync failed: ${String(error?.message || error)}`,
        );
      });
    }
    return { config: next, status: { ...backendStatus } };
  });
  ipcMain.handle("updates:check", async (_event, payload = {}) => {
    const config = readDesktopConfig();
    const manual = payload?.manual === true;
    if (!manual && !autoUpdateCheckEnabledFromConfig(config)) {
      return {
        ok: true,
        skipped: true,
        reason: "disabled",
        currentVersion: app.getVersion(),
        updateAvailable: false,
      };
    }
    return await runDesktopUpdateCheck({ manual });
  });
  ipcMain.handle("wallet:refresh-summary", async () => {
    const now = Date.now();
    if (fundingWalletSummaryRefreshPromise) {
      return fundingWalletSummaryRefreshPromise;
    }
    if (
      backendStatus.fundingWalletSummary &&
      now - fundingWalletSummaryLastAttemptAt <
        FUNDING_WALLET_REFRESH_MIN_INTERVAL_MS
    ) {
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
      backendStatus.fundingWalletSummary = null;
      backendStatus.signerMode = config.signerMode || backendStatus.signerMode;
      publishStatus();
      return { walletId: null, displayName: null, fundingWalletSummary: null };
    }
    fundingWalletSummaryRefreshPromise = (async () => {
      try {
        const rpcSummary =
          await fetchOnchainFundingWalletSummary(walletAddress);
        const summary = {
          walletId: null,
          displayName: null,
          fundingWalletSummary: rpcSummary,
        };
        backendStatus.signerMode =
          config.signerMode || backendStatus.signerMode;
        backendStatus.fundingWalletSummary = summary.fundingWalletSummary;
        pushSystemLog("Funding wallet summary refresh complete.");
        publishStatus();
        return summary;
      } catch (error) {
        // Don't crash the renderer on RPC rate limits; keep the last known good summary.
        const message = String(error?.message || error);
        pushSystemLog(`Funding wallet summary refresh failed: ${message}`);
        if (
          /rate limited|http 429|too many requests|retry after|retry in/i.test(
            message,
          )
        ) {
          publishThrottleNotice({
            source: "rpc",
            trigger: "funding_wallet_refresh",
            message,
          });
        }
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
    const now = Date.now();
    if (bootstrapWalletSummaryPromise) {
      return bootstrapWalletSummaryPromise;
    }
    if (
      backendStatus.currentUserWalletSummary &&
      now - bootstrapWalletSummaryLastAttemptAt <
        BOOTSTRAP_WALLET_REFRESH_MIN_INTERVAL_MS
    ) {
      return {
        ok: true,
        summary: {
          currentUserWalletSummary:
            backendStatus.currentUserWalletSummary || null,
          fundingWalletSummary: backendStatus.fundingWalletSummary || null,
        },
        skipped: true,
      };
    }
    bootstrapWalletSummaryLastAttemptAt = now;
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
    bootstrapWalletSummaryPromise = (async () => {
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
        pushSystemLog(
          "Bootstrap wallet summary skipped until login is available.",
        );
        return {
          ok: false,
          skipped: "auth_required",
          summary: {
            currentUserWalletSummary:
              backendStatus.currentUserWalletSummary || null,
            fundingWalletSummary: backendStatus.fundingWalletSummary || null,
          },
        };
      } finally {
        bootstrapWalletSummaryPromise = null;
      }
    })();
    return bootstrapWalletSummaryPromise;
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
      const snapshot = await getAccountSnapshotCached({ includeNfts: true });
      pushSystemLog("Onboarding sync: fetching get_user_missions.");
      emitProgress(45, "missions", "Fetching missions");
      const missionsResult = snapshot?.missionsResult || null;
      pushSystemLog("Onboarding sync: fetching get_mission_catalog.");
      emitProgress(75, "catalog", "Fetching mission catalog");
      const catalogResult = await getMissionCatalogCached();
      pushSystemLog("Onboarding sync: fetching get_mission_nfts.");
      emitProgress(92, "nfts", "Fetching wallet collections");
      const nftResult = snapshot?.nftResult || null;
      const walletSummaryResult = snapshot?.walletSummaryResult || null;
      return { walletSummaryResult, missionsResult, catalogResult, nftResult };
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

    const walletSummary = summarizeWalletPayload(
      loaded?.walletSummaryResult || {},
    );
    const displayName =
      walletSummary?.displayName ||
      backendStatus.currentUserDisplayName ||
      "unknown";
    const walletId =
      walletSummary?.walletId || backendStatus.currentUserWalletId || "unknown";

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
        description: String(
          mission?.description ||
            mission?.summary ||
            mission?.taskDescription ||
            mission?.task_description ||
            "",
        ).trim(),
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
  ipcMain.handle("missions:apply-selection", async (_event, payload = {}) => {
    const slot = Number(payload?.slot);
    const missionName = String(
      payload?.missionName || payload?.name || "",
    ).trim();
    const missionId = String(payload?.missionId || "").trim();
    if (!Number.isFinite(slot) || slot < 1 || slot > 4) {
      return { ok: false, error: "Invalid mission slot." };
    }
    if (!missionName && !missionId) {
      return { ok: false, error: "Select a mission first." };
    }
    const response = await requestBackend(
      "apply_mission_selection",
      { slot: Math.floor(slot), missionName, missionId },
      {
        ensureRunning: true,
        timeoutMs: 90000,
      },
    );
    if (response?.ok) invalidateMissionRelatedCaches();
    return response;
  });
  ipcMain.handle("missions:preview-selection", async (_event, payload = {}) => {
    const slot = Number(payload?.slot);
    const missionName = String(
      payload?.missionName || payload?.name || "",
    ).trim();
    const missionId = String(payload?.missionId || "").trim();
    if (!Number.isFinite(slot) || slot < 1 || slot > 4) {
      return { ok: false, error: "Invalid mission slot." };
    }
    if (!missionName && !missionId) {
      return { ok: false, error: "Select a mission first." };
    }
    const response = await requestBackend(
      "preview_mission_selection",
      { slot: Math.floor(slot), missionName, missionId },
      {
        ensureRunning: true,
        timeoutMs: 90000,
      },
    );
    return response;
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
      const liveGuiSlots = Array.isArray(backendStatus.guiMissionSlots)
        ? backendStatus.guiMissionSlots
        : [];
      const slotSummary = missionList
        .map((mission, index) => ({
          id:
            mission?.assignedMissionId ||
            mission?.assigned_mission_id ||
            `slot-${index}`,
          slot: Number.isFinite(Number(mission?.slot))
            ? Number(mission.slot)
            : null,
          missionName: missionDisplayName(mission),
          assignedNft: mission?.assigned_nft || mission?.assignedNft || null,
          nftSource: mission?.nft_source || mission?.nftSource || null,
          rentalLeaseId:
            mission?.rental_lease_id || mission?.rentalLeaseId || null,
          currentLevel: Number.isFinite(Number(mission?.current_level))
            ? Number(mission.current_level)
            : Number.isFinite(Number(mission?.level))
              ? Number(mission.level)
              : null,
        }))
        .sort((a, b) => Number(a.slot || 99) - Number(b.slot || 99));
      const activeRentals = missionList
        .filter(
          (mission) =>
            String(
              mission?.nft_source || mission?.nftSource || "",
            ).toLowerCase() === "rental",
        )
        .map((mission, index) => {
          const missionId = String(
            mission?.assignedMissionId || mission?.assigned_mission_id || "",
          ).trim();
          const slot = Number.isFinite(Number(mission?.slot))
            ? Number(mission.slot)
            : null;
          const matchedGuiSlot =
            liveGuiSlots.find(
              (entry) =>
                (missionId &&
                  (String(entry?.missionId || "").trim() === missionId ||
                    String(entry?.id || "").trim() === missionId ||
                    String(entry?.assignedMissionId || "").trim() ===
                      missionId)) ||
                (Number.isFinite(slot) && Number(entry?.slot) === slot),
            ) || null;
          return {
            id: missionId || `mission-rental-${index}`,
            slot,
            missionName:
              matchedGuiSlot?.missionName || missionDisplayName(mission),
            assignedNft:
              matchedGuiSlot?.assignedNft ||
              mission?.assigned_nft ||
              mission?.assignedNft ||
              null,
            image:
              matchedGuiSlot?.assignedNftImage ||
              matchedGuiSlot?.image ||
              assignedNftImageFromMission(mission) ||
              mission?.image ||
              null,
            rentalLeaseId:
              mission?.rental_lease_id || mission?.rentalLeaseId || null,
            currentLevel: Number.isFinite(Number(mission?.current_level))
              ? Number(mission.current_level)
              : Number.isFinite(Number(mission?.level))
                ? Number(mission.level)
                : Number.isFinite(Number(matchedGuiSlot?.missionLevel))
                  ? Number(matchedGuiSlot.missionLevel)
                  : null,
          };
        });

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
        rentableCount: Number(
          rentableResult?.structuredContent?.count || rentableRaw.length || 0,
        ),
        rentable,
        activeRentals,
        slotSummary,
        poolByCollection,
      };
    };

    if (rentalsPreviewPromise) {
      pushSystemLog("Rentals preview wait: refresh already running.");
      return rentalsPreviewPromise;
    }
    if (
      rentalsPreviewCache &&
      shouldServeCachedRentalsPreview(rentalsPreviewCacheAt)
    ) {
      pushSystemLog("Rentals preview cache hit.");
      return rentalsPreviewCache;
    }

    rentalsPreviewPromise = (async () => {
      try {
        const result = await loadPreview();
        rentalsPreviewCache = result;
        rentalsPreviewCacheAt = Date.now();
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
        rentalsPreviewCache = result;
        rentalsPreviewCacheAt = Date.now();
        pushSystemLog(
          `Rentals page refresh complete after login. Pool=${Number(result?.rentableCount || 0)}, active rentals=${Array.isArray(result?.activeRentals) ? result.activeRentals.length : 0}.`,
        );
        return result;
      } finally {
        rentalsPreviewPromise = null;
      }
    })();
    return rentalsPreviewPromise;
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
            entry?.account || entry?.nftAccount || entry?.tokenAddress || null,
          mint:
            entry?.mint || entry?.mintAddress || entry?.mint_address || null,
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

    if (nftListPromise) {
      pushSystemLog("NFT page refresh wait: refresh already running.");
      return nftListPromise;
    }
    if (nftListCache && shouldServeCachedNftList(nftListCacheAt)) {
      pushSystemLog("NFT page refresh cache hit.");
      return hydrateCachedNftList(nftListCache, nftListCacheAt);
    }

    nftListPromise = (async () => {
      try {
        const result = await loadNfts();
        nftListCache = result;
        nftListCacheAt = Date.now();
        pushSystemLog(
          `NFT page refresh complete. NFTs=${Number(result?.total || 0)}.`,
        );
        return result;
      } catch (error) {
        if (!isAuthFailureMessage(error?.message)) {
          pushSystemLog(
            `NFT page refresh failed: ${String(error?.message || error)}`,
          );
          return { ok: false, error: String(error?.message || error) };
        }
        pushSystemLog(
          "NFT page refresh requires login. Opening browser login.",
        );
        await runOnboardingPopupLogin({
          url: "https://pixelbypixel.studio/mcp",
          timeoutMs: 30000,
          loginTimeoutMs: 180000,
        });
        const result = await loadNfts();
        nftListCache = result;
        nftListCacheAt = Date.now();
        pushSystemLog(
          `NFT page refresh complete after login. NFTs=${Number(result?.total || 0)}.`,
        );
        return result;
      } finally {
        nftListPromise = null;
      }
    })();
    return nftListPromise;
  });
  ipcMain.handle("nfts:reset-cooldown", async (_event, payload = {}) => {
    const nftId = String(
      payload?.nftId || payload?.nftAccount || payload?.account || "",
    ).trim();
    if (!nftId) {
      return { ok: false, error: "Missing NFT id." };
    }
    pushSystemLog(`NFT cooldown reset requested: ${nftId}.`);
    const response = await requestBackend(
      "reset_nft_cooldown",
      {
        nftId,
        nftName: String(payload?.nftName || payload?.name || "NFT").trim(),
        cooldownSeconds: Number(payload?.cooldownSeconds || 0),
        nft:
          payload?.nft && typeof payload.nft === "object"
            ? payload.nft
            : undefined,
      },
      {
        ensureRunning: true,
        timeoutMs: 180000,
      },
    );
    if (response?.ok) {
      invalidateMissionRelatedCaches();
    }
    return response;
  });
  ipcMain.handle(
    "nfts:prepare-cooldown-reset",
    async (_event, payload = {}) => {
      const nftId = String(
        payload?.nftId || payload?.nftAccount || payload?.account || "",
      ).trim();
      if (!nftId) {
        return { ok: false, error: "Missing NFT id." };
      }
      pushSystemLog(`NFT cooldown reset prepare requested: ${nftId}.`);
      const response = await requestBackend(
        "prepare_nft_cooldown_reset",
        {
          nftId,
          nftName: String(payload?.nftName || payload?.name || "NFT").trim(),
          cooldownSeconds: Number(payload?.cooldownSeconds || 0),
          nft:
            payload?.nft && typeof payload.nft === "object"
              ? payload.nft
              : undefined,
        },
        {
          ensureRunning: true,
          timeoutMs: 45000,
        },
      );
      return response;
    },
  );
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
        requestAppQuit("window_close");
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
  await bootstrapStartupMissionSlots();
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
    splashProgressCurrent = 100;
    splashProgressTarget = 100;
    sendSplashProgressToWindow(100);
    stopSplashProgressTimer();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();
  };
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.once("ready-to-show", closeSplash);
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

app.on("before-quit", (event) => {
  if (telemetryQuitInProgress) {
    return;
  }
  telemetryQuitInProgress = true;
  event.preventDefault();
  requestAppQuit("before_quit");
});

process.on("uncaughtException", (error) => {
  trackTelemetryCrash(error, { source: "uncaughtException" });
});

process.on("unhandledRejection", (reason) => {
  trackTelemetryCrash(reason, { source: "unhandledRejection" });
});
