"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeMissionList, extractMissionReward } = require("../missions/normalize");
const {
  login: mcpLogin,
  refreshAccessToken,
  clearTokenFile,
} = require("../../lib/mcp");

function createMcpClient(ctx, logger) {
  const { logWithTimestamp, logDebug } = logger;
  const LOGIN_TIMEOUT_MS = 180000;
  const AUTH_REQUEST_TIMEOUT_MS = 30000;
  const MCP_REQUEST_TIMEOUT_MS = 30000;
  const REFRESH_RETRY_ATTEMPTS = 3;
  const REFRESH_RETRY_DELAY_MS = 1000;
  // The deployed service refreshes passive mission data once per minute.
  const USER_MISSIONS_CACHE_TTL_MS = 60_000;
  const THROTTLE_DEBUG_WINDOW_MS = 5000;
  const THROTTLE_DEBUG_MAX_EVENTS = 200;
  const THROTTLE_DEBUG_BEFORE_COUNT = 5;
  const RAW_DEBUG_TOOL_NAMES = new Set([
    "get_user_missions",
    "watch_and_claim",
    "claim_mission_reward",
  ]);
  const TOOL_MIN_INTERVAL_MS = new Map([
    ["get_wallet_summary", 60_000],
    ["get_user_missions", 60_000],
  ]);
  const TOOL_WINDOW_LIMITS = new Map([
    ["get_mission_nfts", { limit: 10, windowMs: 60_000 }],
    ["claim_mission_reward", { limit: 10, windowMs: 60_000 }],
    ["assign_nft_to_mission", { limit: 10, windowMs: 60_000 }],
  ]);
  const toolWindowCalls = new Map();
  let throttleDebugSequence = 0;
  let logicalToolCallSequence = 0;
  const recentToolCalls = [];
  let userMissionsInflight = null;
  let userMissionsInflightForceFresh = false;
  let userMissionsGeneration = 0;

  function throttleDebugEnabled() {
    return ctx.debugMode === true;
  }

  function throttleDebugLogPath() {
    const configDir = path.dirname(String(ctx.configPath || process.cwd()));
    return path.join(configDir, "mcp-throttle-debug.log");
  }

  function rawPayloadDebugEnabled() {
    return ctx.debugMode === true || ctx.config?.mcpRawDebug === true;
  }

  function rawPayloadDebugLogPath() {
    const configDir = path.dirname(String(ctx.configPath || process.cwd()));
    return path.join(configDir, "mcp-raw-debug.log");
  }

  function trimText(value, maxLen = 320) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function safeJson(value, maxLen = 320) {
    if (value === undefined) return "";
    try {
      return trimText(JSON.stringify(value), maxLen);
    } catch {
      return trimText(String(value), maxLen);
    }
  }

  function hasOwn(obj, key) {
    return Boolean(
      obj &&
        typeof obj === "object" &&
        Object.prototype.hasOwnProperty.call(obj, key),
    );
  }

  function summarizeShape(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array(len=${value.length})`;
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return typeof value;
    const keys = Object.keys(value);
    return `object(keys=${keys.slice(0, 12).join(",")}${keys.length > 12 ? ",..." : ""})`;
  }

  function shouldLogRawPayload(toolName) {
    return rawPayloadDebugEnabled() && RAW_DEBUG_TOOL_NAMES.has(String(toolName || ""));
  }

  function writeRawPayloadDebugLog(event = {}) {
    if (!shouldLogRawPayload(event.toolName)) return;
    const now = Date.now();
    const lines = [
      "",
      "=".repeat(88),
      `timestamp: ${new Date(now).toISOString()}`,
      `tool: ${event.toolName || "unknown"}`,
      `phase: ${event.phase || "unknown"}`,
      `status: ${event.status ?? "n/a"}`,
      `contentType: ${event.contentType || "n/a"}`,
      `hasResultKey: ${event.hasResultKey === true ? "true" : event.hasResultKey === false ? "false" : "n/a"}`,
      `resultSource: ${event.resultSource || "n/a"}`,
      `jsonShape: ${event.jsonShape || "n/a"}`,
      `resultShape: ${event.resultShape || "n/a"}`,
      `args: ${safeJson(event.args, 2000) || "{}"}`,
      `reason: ${event.reason || "n/a"}`,
      `rawText: ${trimText(event.rawText, 12000) || "(empty)"}`,
      `parsedJson: ${safeJson(event.parsedJson, 12000) || "(empty)"}`,
      `extractedResult: ${safeJson(event.extractedResult, 12000) || "(empty)"}`,
      "=".repeat(88),
      "",
    ];
    try {
      fs.appendFileSync(rawPayloadDebugLogPath(), `${lines.join("\n")}\n`);
    } catch (error) {
      logDebug("mcp", "raw_debug_write_failed", {
        error: error.message,
        file: rawPayloadDebugLogPath(),
      });
    }
  }

  function extractToolResultPayload(callJson) {
    if (!callJson || typeof callJson !== "object") {
      return {
        result: {},
        hasResultKey: false,
        source: "missing_json",
      };
    }
    if (hasOwn(callJson, "result")) {
      const result = callJson.result;
      if (result !== null && result !== undefined) {
        return {
          result,
          hasResultKey: true,
          source: "json.result",
        };
      }
    }
    if (
      hasOwn(callJson, "structuredContent") ||
      hasOwn(callJson, "content") ||
      hasOwn(callJson, "isError")
    ) {
      return {
        result: callJson,
        hasResultKey: hasOwn(callJson, "result"),
        source: "json_direct_tool_payload",
      };
    }
    return {
      result: {},
      hasResultKey: hasOwn(callJson, "result"),
      source: hasOwn(callJson, "result") ? "null_result_fallback_empty_object" : "missing_result_fallback_empty_object",
    };
  }

  function captureStack(skipLines = 2) {
    const stack = String(new Error().stack || "")
      .split("\n")
      .slice(skipLines)
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
    return trimText(stack, 4000);
  }

  function compactStack(stackText, maxFrames = 6) {
    const lines = String(stackText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];
    return lines
      .map((line) => {
        const stripped = line.replace(/^at\s+/, "");
        const match =
          stripped.match(/^(.+?)\s+\((.+)\)$/) ||
          stripped.match(/^(.+?)\s+(.+)$/);
        const rawName = match ? match[1] : stripped;
        const name = String(rawName || "")
          .replace(/^async\s+/, "")
          .replace(/^Object\./, "")
          .replace(/^Module\./, "")
          .replace(/^new\s+/, "")
          .trim();
        return name || stripped;
      })
      .filter((name, index, arr) => Boolean(name) && arr.indexOf(name) === index)
      .slice(0, maxFrames);
  }

  function formatCallerChain(stackText, maxFrames = 6) {
    const frames = compactStack(stackText, maxFrames);
    if (frames.length === 0) return "(unknown)";
    return frames.join(" <- ");
  }

  function pruneRecentToolCalls(now = Date.now()) {
    while (
      recentToolCalls.length > THROTTLE_DEBUG_MAX_EVENTS ||
      (recentToolCalls.length > 0 &&
        now - Number(recentToolCalls[0]?.startedAt || 0) >
          THROTTLE_DEBUG_WINDOW_MS * 6)
    ) {
      recentToolCalls.shift();
    }
  }

  function recordToolCallStart(toolName, args) {
    if (!throttleDebugEnabled()) return null;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      toolName: String(toolName || "unknown"),
      argsSummary: safeJson(args, 500),
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: "started",
      errorMessage: null,
      stack: captureStack(3),
    };
    recentToolCalls.push(entry);
    pruneRecentToolCalls(entry.startedAt);
    return entry;
  }

  function finalizeToolCallEntry(entry, status, error = null) {
    if (!entry) return;
    entry.endedAt = Date.now();
    entry.durationMs = Math.max(0, entry.endedAt - Number(entry.startedAt || 0));
    entry.status = status;
    entry.errorMessage = error ? trimText(error.message || error, 500) : null;
    pruneRecentToolCalls(entry.endedAt);
  }

  function writeThrottleDebugLog(event = {}) {
    if (!throttleDebugEnabled()) return;
    const now = Date.now();
    pruneRecentToolCalls(now);
    const seq = ++throttleDebugSequence;
    if (!ctx.throttleDebug || typeof ctx.throttleDebug !== "object") {
      ctx.throttleDebug = {
        count: 0,
        lastRequestedTool: null,
        lastTriggerTool: null,
        lastType: null,
        lastWaitSeconds: null,
        lastRetryAt: null,
        lastAt: 0,
        logPath: throttleDebugLogPath(),
      };
    }
    ctx.throttleDebug = {
      ...ctx.throttleDebug,
      count: Number(ctx.throttleDebug.count || 0) + 1,
      lastRequestedTool: event.requestedTool || null,
      lastTriggerTool: event.triggerTool || null,
      lastType: event.type || null,
      lastWaitSeconds: Number(event.waitSeconds || 0) || null,
      lastRetryAt: Number(event.retryAt || 0) || null,
      lastAt: now,
      logPath: throttleDebugLogPath(),
    };
    const recent = recentToolCalls.filter(
      (entry) => now - Number(entry.startedAt || 0) <= THROTTLE_DEBUG_WINDOW_MS,
    );
    const trace = recent.slice(-THROTTLE_DEBUG_BEFORE_COUNT);
    const lines = [
      "",
      "=".repeat(88),
      `THROTTLE EVENT #${seq}`,
      "=".repeat(88),
      `timestamp: ${new Date(now).toISOString()}`,
      `type: ${event.type || "unknown"}`,
      `requestedTool: ${event.requestedTool || "unknown"}`,
      `triggerTool: ${event.triggerTool || "unknown"}`,
      `waitSeconds: ${Number(event.waitSeconds || 0) || 0}`,
      `retryAt: ${event.retryAt ? new Date(event.retryAt).toISOString() : "n/a"}`,
      `reason: ${event.reason || "n/a"}`,
      `detail: ${event.detail || "n/a"}`,
      "",
      `Throttle caller chain: ${formatCallerChain(event.stack, 8)}`,
      "",
      `Trace calls shown: ${trace.length} of ${recent.length} seen in last ${Math.floor(THROTTLE_DEBUG_WINDOW_MS / 1000)}s`,
    ];

    if (trace.length === 0) {
      lines.push("(none)");
    } else {
      trace.forEach((entry, index) => {
        lines.push("-".repeat(88));
        lines.push(
          `${index + 1}. ${new Date(entry.startedAt).toISOString()} | ${entry.toolName} | status=${entry.status}${entry.durationMs !== null ? ` | durationMs=${entry.durationMs}` : ""}`,
        );
        lines.push(`args: ${entry.argsSummary || "{}"}`);
        if (entry.errorMessage) lines.push(`error: ${entry.errorMessage}`);
        lines.push(`callers: ${formatCallerChain(entry.stack, 6)}`);
      });
    }

    lines.push("=".repeat(88));
    lines.push("");

    try {
      fs.appendFileSync(throttleDebugLogPath(), `${lines.join("\n")}\n`);
      if (ctx.guiBridge?.emitSoon) ctx.guiBridge.emitSoon();
    } catch (error) {
      logDebug("mcp", "throttle_debug_write_failed", {
        error: error.message,
        file: throttleDebugLogPath(),
      });
    }
  }

  function setMcpConnection(state, { error = null } = {}) {
    if (!ctx.mcpConnection || typeof ctx.mcpConnection !== "object") {
      ctx.mcpConnection = { state: "disconnected", lastError: null, updatedAt: 0 };
    }
    ctx.mcpConnection.state = state;
    ctx.mcpConnection.lastError = error ? String(error) : null;
    ctx.mcpConnection.updatedAt = Date.now();
    if (ctx.guiBridge?.emitSoon) ctx.guiBridge.emitSoon();
  }

  function parseJsonOutput(raw, fallback = null) {
    const text = String(raw ?? "").trim();
    if (!text) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function parseSseJsonOutput(raw, fallback = null) {
    const text = String(raw ?? "");
    if (!text.trim()) return fallback;
    const lines = text.split(/\r?\n/);
    const dataParts = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      dataParts.push(line.slice(5).trimStart());
    }
    if (dataParts.length === 0) return fallback;
    return parseJsonOutput(dataParts.join("\n"), fallback);
  }

  function tokenRecord() {
    if (!fs.existsSync(ctx.tokenFilePath)) return null;
    return parseJsonOutput(fs.readFileSync(ctx.tokenFilePath, "utf8"));
  }

  function bearerToken() {
    const record = tokenRecord();
    return record && typeof record.access_token === "string"
      ? record.access_token
      : null;
  }

  function tokenExpiresSoon(record, skewMs = 90000) {
    const exp = record?.expires_at;
    if (typeof exp !== "string" || !exp) return false;
    const ts = Date.parse(exp);
    if (!Number.isFinite(ts)) return false;
    return ts - Date.now() <= skewMs;
  }

  function isAuthHttpError(message) {
    const msg = String(message || "");
    return /HTTP 401|HTTP 403|unauthorized|forbidden|invalid token|missing token/i.test(
      msg,
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
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

  function updateMissionLookupCache(result) {
    const missions = normalizeMissionList(result);
    const nextLookup = {
      ...(ctx.lastAssignedMissionLookup &&
      typeof ctx.lastAssignedMissionLookup === "object"
        ? ctx.lastAssignedMissionLookup
        : {}),
    };
    let changed = false;
    for (const mission of missions) {
      const assignedMissionId = String(
        mission?.assignedMissionId || mission?.assigned_mission_id || "",
      ).trim();
      if (!assignedMissionId) continue;
      const reward = extractMissionReward(mission);
      const nextEntry = {
        name: missionName(mission) || null,
        slot: Number.isFinite(Number(mission?.slot)) ? Number(mission.slot) : null,
        level: Number.isFinite(Number(mission?.current_level ?? mission?.level))
          ? Number(mission?.current_level ?? mission?.level)
          : null,
        reward: reward.amount,
        prize: reward.token,
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

  function hasFreshUserMissionsSnapshot() {
    return (
      ctx.lastUserMissionsResult &&
      typeof ctx.lastUserMissionsResult === "object" &&
      Number.isFinite(Number(ctx.lastUserMissionsFetchedAt || 0)) &&
      Date.now() - Number(ctx.lastUserMissionsFetchedAt || 0) <=
        USER_MISSIONS_CACHE_TTL_MS
    );
  }

  function userMissionsSnapshotAgeMs() {
    const fetchedAt = Number(ctx.lastUserMissionsFetchedAt || 0);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
    return Math.max(0, Date.now() - fetchedAt);
  }

  function invalidateUserMissionsSnapshot(reason = "unknown") {
    userMissionsGeneration += 1;
    ctx.lastUserMissionsResult = null;
    ctx.lastUserMissionsFetchedAt = 0;
    if (userMissionsInflight && !userMissionsInflightForceFresh) {
      userMissionsInflight = null;
    }
    logDebug("mcp", "user_missions_snapshot_invalidated", { reason });
  }

  function shouldInvalidateUserMissionsSnapshot(toolName) {
    return new Set([
      "assign_nft_to_mission",
      "claim_mission_reward",
      "submit_signed_mission_reroll",
      "submit_signed_mission_slot_unlock",
      "submit_signed_mission_swap",
      "submit_signed_nft_cooldown_reset",
    ]).has(String(toolName || "").trim());
  }

  function mutationIncludesMissionState(result) {
    return normalizeMissionList(result).length > 0;
  }

  function adoptMutationMissionState(result, toolName) {
    if (!mutationIncludesMissionState(result)) return false;
    // Prevent an older in-flight passive read from overwriting this newer
    // mutation response when it eventually resolves.
    userMissionsGeneration += 1;
    userMissionsInflight = null;
    userMissionsInflightForceFresh = false;
    updateMissionLookupCache(result);
    logDebug("mcp", "mutation_mission_snapshot_adopted", {
      toolName,
      missionCount: normalizeMissionList(result).length,
    });
    return true;
  }

  function toolWindowWaitMs(toolName, now = Date.now()) {
    const normalizedToolName = String(toolName || "").trim();
    const config = TOOL_WINDOW_LIMITS.get(normalizedToolName);
    if (!config) return 0;
    const cutoff = now - config.windowMs;
    const recent = (toolWindowCalls.get(normalizedToolName) || []).filter(
      (timestamp) => timestamp > cutoff,
    );
    toolWindowCalls.set(normalizedToolName, recent);
    if (recent.length < config.limit) return 0;
    return Math.max(0, recent[0] + config.windowMs - now);
  }

  function recordToolWindowCall(toolName, now = Date.now()) {
    const normalizedToolName = String(toolName || "").trim();
    if (!TOOL_WINDOW_LIMITS.has(normalizedToolName)) return;
    const recent = toolWindowCalls.get(normalizedToolName) || [];
    recent.push(now);
    toolWindowCalls.set(normalizedToolName, recent);
  }

  function shouldUseUserMissionsSnapshot(toolName, args) {
    if (String(toolName || "").trim() !== "get_user_missions") return false;
    if (args && typeof args === "object" && Object.keys(args).length > 0) {
      return false;
    }
    return true;
  }

  function parseRetryAfterSeconds(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.max(0, Math.ceil(numeric));
    }
    const when = Date.parse(text);
    if (!Number.isFinite(when)) return null;
    return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  }

  function cooldownStatePath() {
    if (ctx.mcpCooldownStatePath) return String(ctx.mcpCooldownStatePath);
    const configDir = path.dirname(String(ctx.configPath || process.cwd()));
    return path.join(configDir, "data", "mcp-cooldowns.json");
  }

  function readSharedCooldowns() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cooldownStatePath(), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function sharedToolCooldownWaitMs(toolName) {
    const retryAt = Number(readSharedCooldowns()?.tools?.[toolName] || 0);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
  }

  function persistToolCooldown(toolName, retryAt) {
    const name = String(toolName || "unknown_tool").trim() || "unknown_tool";
    const current = readSharedCooldowns();
    const next = {
      ...current,
      updatedAt: Date.now(),
      tools: {
        ...(current.tools && typeof current.tools === "object"
          ? current.tools
          : {}),
        [name]: Number(retryAt || 0),
      },
    };
    try {
      fs.mkdirSync(path.dirname(cooldownStatePath()), { recursive: true });
      const tempPath = `${cooldownStatePath()}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
      fs.renameSync(tempPath, cooldownStatePath());
    } catch (error) {
      logDebug("mcp", "cooldown_state_write_failed", {
        error: error.message,
        file: cooldownStatePath(),
      });
    }
  }

  function rateLimitWaitMs(toolName = null) {
    const requestedTool = String(toolName || "").trim();
    if (requestedTool) {
      const sharedWaitMs = sharedToolCooldownWaitMs(requestedTool);
      const localWaitMs =
        String(ctx.mcpRateLimitReason || "") === requestedTool
          ? Math.max(0, Number(ctx.mcpRateLimitedUntil || 0) - Date.now())
          : 0;
      return Math.max(sharedWaitMs, localWaitMs);
    }
    const until = Number(ctx.mcpRateLimitedUntil || 0);
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }

  function buildActiveRateLimitError(
    reason = "pre_call",
    toolName = null,
    waitMsOverride = null,
  ) {
    const waitMs = Number.isFinite(Number(waitMsOverride))
      ? Math.max(0, Number(waitMsOverride))
      : rateLimitWaitMs(toolName);
    const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    const error = new Error(
      `rate limited; retry in ${waitSeconds}s`,
    );
    error.rateLimited = true;
    error.retryAfterSeconds = waitSeconds;
    error.retryAt = Date.now() + waitMs;
    error.toolName = toolName || ctx.mcpRateLimitReason || null;
    error.cooldownActive = true;
    error.reason = reason;
    return error;
  }

  function buildRateLimitError({ status = 429, retryAfterSeconds = 30, toolName = null, bodyError = null } = {}) {
    const waitSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 30));
    const retryAt = Date.now() + waitSeconds * 1000;
    // The server reports cooldowns for a specific tool. Only watch_and_claim
    // controls the watch loop's global wait; a read-tool cooldown must not
    // prevent assignment/signing tools from running with data already loaded.
    if (!toolName || toolName === "watch_and_claim") {
      ctx.mcpRateLimitedUntil = retryAt;
      ctx.mcpRateLimitReason = toolName || "unknown_tool";
    }
    persistToolCooldown(toolName, retryAt);
    const error = new Error(
      `tool call failed: HTTP ${status} (rate limited, retry in ${waitSeconds}s)`,
    );
    error.rateLimited = true;
    error.retryAfterSeconds = waitSeconds;
    error.retryAt = retryAt;
    error.toolName = toolName || null;
    error.bodyError = bodyError || null;
    return error;
  }

  function emitThrottleNotice(payload = {}) {
    if (!ctx.guiBridge || typeof ctx.guiBridge.sendEvent !== "function") return;
    try {
      ctx.guiBridge.sendEvent("throttle_notice", {
        source: "mcp",
        at: Date.now(),
        ...payload,
      });
    } catch {}
  }

  async function tryRefresh(reason = "proactive") {
    const record = tokenRecord();
    if (!record?.refresh_token) return false;
    try {
      setMcpConnection("reconnecting");
      logDebug("auth", "refresh_start", { reason });
      await refreshAccessToken({
        url: ctx.MCP_URL,
        tokenFile: ctx.tokenFilePath,
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      });
      ctx.authRefreshSignal = Number(ctx.authRefreshSignal || 0) + 1;
      logWithTimestamp("[AUTH] 🔐 Token refreshed.");
      logDebug("auth", "refresh_ok", { reason });
      setMcpConnection("connected");
      if (typeof ctx.onAuthRefresh === "function") {
        setTimeout(() => {
          try {
            ctx.onAuthRefresh({
              reason,
              signal: Number(ctx.authRefreshSignal || 0),
            });
          } catch (callbackError) {
            logDebug("auth", "refresh_callback_failed", {
              error: callbackError.message,
            });
          }
        }, 0);
      }
      return true;
    } catch (error) {
      logDebug("auth", "refresh_failed", { reason, error: error.message });
      setMcpConnection("expired", { error: error.message });
      return false;
    }
  }

  async function recoverAuthAfterRefreshFailure(reason = "proactive") {
    setMcpConnection("reconnecting");
    for (let attempt = 1; attempt <= REFRESH_RETRY_ATTEMPTS; attempt += 1) {
      const refreshed = await tryRefresh(`${reason}_retry_${attempt}`);
      if (refreshed) return true;
      logWithTimestamp(
        `[AUTH] ❌ Token refresh failed (${attempt}/${REFRESH_RETRY_ATTEMPTS}).`,
      );
      if (attempt < REFRESH_RETRY_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, REFRESH_RETRY_DELAY_MS),
        );
      }
    }

    logWithTimestamp(
      "[AUTH] 🔄 Refresh failed 3 times. Starting popup login...",
    );
    const loginOk = await runLoginFlow({
      forceInteractive: true,
      forceBrowser: true,
    });
    if (!loginOk) {
      setMcpConnection("expired", { error: "login_failed" });
      return false;
    }
    const ok = Boolean(bearerToken());
    setMcpConnection(ok ? "connected" : "expired", {
      error: ok ? null : "missing_token_after_login",
    });
    return ok;
  }

  async function mcpPost({
    token,
    sessionId,
    body,
    timeoutMs,
    signal: externalSignal = null,
    noStore = false,
  }) {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": ctx.MCP_PROTOCOL_VERSION,
    };
    if (noStore) {
      headers["Cache-Control"] = "no-cache, no-store, max-age=0";
      headers.Pragma = "no-cache";
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const effectiveTimeoutMs = Number(timeoutMs ?? MCP_REQUEST_TIMEOUT_MS);
    const controller = new AbortController();
    let externalAbortHandler = null;
    if (
      externalSignal &&
      typeof externalSignal.addEventListener === "function"
    ) {
      if (externalSignal.aborted) controller.abort();
      else {
        externalAbortHandler = () => controller.abort();
        externalSignal.addEventListener("abort", externalAbortHandler, {
          once: true,
        });
      }
    }
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      const response = await fetch(ctx.MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        ...(noStore ? { cache: "no-store" } : {}),
      });
      const text = await response.text();
      const contentType = String(response.headers.get("content-type") || "")
        .trim()
        .toLowerCase();
      const json = contentType.includes("text/event-stream")
        ? parseSseJsonOutput(text, {})
        : parseJsonOutput(text, {});
      const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
      return {
        ok: response.ok,
        status: response.status,
        json,
        rawText: text,
        contentType,
        sessionId: nextSessionId,
        retryAfter: response.headers.get("retry-after") || null,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new Error("request aborted");
        }
        throw new Error(`request timeout after ${effectiveTimeoutMs}ms`);
      }
      throw error;
    } finally {
      if (externalAbortHandler && externalSignal?.removeEventListener) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
      clearTimeout(timeout);
    }
  }

  async function mcpInitialize(token, callTrace = null) {
    if (callTrace) callTrace.httpRequests += 1;
    logDebug("mcp", "initialize_start", {
      callId: callTrace?.callId || null,
      toolName: callTrace?.toolName || null,
      httpRequest: callTrace?.httpRequests || 1,
    });
    const init = await mcpPost({
      token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: ctx.MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "missions-v3-mcp", version: ctx.APP_VERSION },
        },
      },
    });

    if (!init.ok) {
      if (Number(init.status) === 429) {
        const retryAfterSeconds =
          parseRetryAfterSeconds(init.retryAfter) ||
          Number(init.json?.error?.data?.retryAfterSeconds || 0) ||
          30;
        throw buildRateLimitError({
          status: init.status,
          retryAfterSeconds,
          toolName: "initialize",
          bodyError: init.json?.error || null,
        });
      }
      throw new Error(`initialize failed: HTTP ${init.status}`);
    }

    if (!init.sessionId) {
      logDebug("mcp", "initialize_ok", {
        callId: callTrace?.callId || null,
        toolName: callTrace?.toolName || null,
        sessionId: null,
        streamableHttp: true,
        httpRequests: callTrace?.httpRequests || 1,
      });
      return null;
    }

    if (callTrace) callTrace.httpRequests += 1;
    await mcpPost({
      token,
      sessionId: init.sessionId,
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
    });

    logDebug("mcp", "initialize_ok", {
      callId: callTrace?.callId || null,
      toolName: callTrace?.toolName || null,
      sessionId: init.sessionId,
      httpRequests: callTrace?.httpRequests || 2,
    });
    return init.sessionId;
  }

  async function mcpToolCall(toolName, args = {}, opts = {}) {
    const missionSnapshotEligible = shouldUseUserMissionsSnapshot(toolName, args);
    const userMissionsAgeMs = missionSnapshotEligible
      ? userMissionsSnapshotAgeMs()
      : null;
    const hasFreshUserMissions =
      missionSnapshotEligible && hasFreshUserMissionsSnapshot();

    if (
      missionSnapshotEligible &&
      opts?.forceFresh !== true &&
      hasFreshUserMissions
    ) {
      logDebug("tool", "call_cached", {
        toolName,
        ttlMs: USER_MISSIONS_CACHE_TTL_MS,
        ageMs: userMissionsAgeMs,
        reason: String(opts?.reason || "").trim() || null,
      });
      return ctx.lastUserMissionsResult;
    }
    if (
      missionSnapshotEligible &&
      opts?.forceFresh !== true &&
      !hasFreshUserMissions
    ) {
      logDebug("tool", "call_cache_expired", {
        toolName,
        ttlMs: USER_MISSIONS_CACHE_TTL_MS,
        ageMs: userMissionsAgeMs,
        reason: String(opts?.reason || "").trim() || null,
      });
    }
    if (missionSnapshotEligible && opts?.forceFresh === true) {
      logDebug("tool", "call_force_fresh", {
        toolName,
        ttlMs: USER_MISSIONS_CACHE_TTL_MS,
        ageMs: userMissionsAgeMs,
        reason: String(opts?.reason || "").trim() || null,
      });
    }
    if (missionSnapshotEligible && userMissionsInflight) {
      if (opts?.forceFresh !== true || userMissionsInflightForceFresh) {
        logDebug("tool", "call_inflight_reused", {
          toolName,
          forceFresh: opts?.forceFresh === true,
          inflightForceFresh: userMissionsInflightForceFresh,
          reason: String(opts?.reason || "").trim() || null,
        });
        return userMissionsInflight;
      }
      logDebug("tool", "call_inflight_bypassed_for_force_fresh", {
        toolName,
        ttlMs: USER_MISSIONS_CACHE_TTL_MS,
        ageMs: userMissionsAgeMs,
        reason: String(opts?.reason || "").trim() || null,
      });
    }

    const callTrace = {
      callId: ++logicalToolCallSequence,
      toolName,
      reason: String(opts?.reason || "").trim() || "unspecified",
      forceFresh: opts?.forceFresh === true,
      httpRequests: 0,
      startedAt: Date.now(),
    };
    logDebug("tool", "call_start", {
      callId: callTrace.callId,
      toolName,
      reason: callTrace.reason,
      forceFresh: callTrace.forceFresh,
      args,
    });
    const toolCallEntry = recordToolCallStart(toolName, args);
    const record = tokenRecord();
    if (!record?.access_token) {
      finalizeToolCallEntry(toolCallEntry, "missing_token");
      setMcpConnection("expired", { error: "missing_token" });
      throw new Error("Missing token. Run login.");
    }
    if (tokenExpiresSoon(record)) {
      const refreshed = await recoverAuthAfterRefreshFailure("expires_soon");
      if (!refreshed) {
        finalizeToolCallEntry(toolCallEntry, "auth_expired");
        setMcpConnection("expired", { error: "refresh_failed" });
        throw new Error("Authentication expired. Login required.");
      }
    }

    const runOnce = async () => {
      const sharedWaitMs = sharedToolCooldownWaitMs(toolName);
      if (sharedWaitMs > 0) {
        throw buildActiveRateLimitError(
          "shared_per_tool_cooldown",
          toolName,
          sharedWaitMs,
        );
      }
      if (rateLimitWaitMs(toolName) > 0) {
        throw buildActiveRateLimitError("per_tool_cooldown", toolName);
      }
      const windowWaitMs = toolWindowWaitMs(toolName);
      if (windowWaitMs > 0) {
        throw buildActiveRateLimitError(
          "local_per_tool_window",
          toolName,
          windowWaitMs,
        );
      }
      const token = bearerToken();
      if (!token) {
        setMcpConnection("expired", { error: "missing_token" });
        throw new Error("Missing token. Run login.");
      }
      const sessionId = await mcpInitialize(token, callTrace);
      callTrace.httpRequests += 1;
      recordToolWindowCall(toolName);
      logDebug("mcp", "tool_http_start", {
        callId: callTrace.callId,
        toolName,
        reason: callTrace.reason,
        httpRequest: callTrace.httpRequests,
      });
      const call = await mcpPost({
        token,
        sessionId,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        noStore: String(toolName || "").trim() === "get_mission_nfts",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        },
      });
      if (!call.ok) {
        if (Number(call.status) === 429) {
          const retryAfterSeconds =
            parseRetryAfterSeconds(call.retryAfter) ||
            Number(call.json?.error?.data?.retryAfterSeconds || 0) ||
            30;
          throw buildRateLimitError({
            status: call.status,
            retryAfterSeconds,
            toolName,
            bodyError: call.json?.error || null,
          });
        }
        throw new Error(`tool call failed: HTTP ${call.status}`);
      }
      if (call.json?.error)
        throw new Error(`RPC error: ${JSON.stringify(call.json.error)}`);
      const extracted = extractToolResultPayload(call.json);
      if (
        extracted.result?.isError === true ||
        call.json?.result?.isError === true
      ) {
        const errorPayload = extracted.result || call.json.result;
        const text = Array.isArray(errorPayload?.content)
          ? errorPayload.content
              .filter((item) => item?.type === "text")
              .map((item) => String(item.text || "").trim())
              .filter(Boolean)
              .join("\n")
          : "";
        throw new Error(
          text || `MCP tool ${toolName} returned an error result`,
        );
      }
      writeRawPayloadDebugLog({
        toolName,
        phase: "tool_call_response",
        status: call.status,
        contentType: call.contentType,
        hasResultKey: extracted.hasResultKey,
        resultSource: extracted.source,
        jsonShape: summarizeShape(call.json),
        resultShape: summarizeShape(extracted.result),
        args,
        reason: String(opts?.reason || "").trim() || null,
        rawText: call.rawText,
        parsedJson: call.json,
        extractedResult: extracted.result,
      });
      return extracted.result;
    };

    const userMissionsGenerationAtStart = missionSnapshotEligible
      ? userMissionsGeneration
      : 0;

    if (missionSnapshotEligible) {
      logDebug("tool", "call_snapshot_fetch_start", {
        toolName,
        ttlMs: USER_MISSIONS_CACHE_TTL_MS,
        ageMs: userMissionsAgeMs,
        forceFresh: opts?.forceFresh === true,
        reason: String(opts?.reason || "").trim() || null,
      });
    }

    const executeToolCall = async () => {
      try {
        const result = await runOnce();
        if (
          toolName === "get_user_missions" &&
          result &&
          typeof result === "object"
        ) {
          if (userMissionsGenerationAtStart === userMissionsGeneration) {
            try {
              updateMissionLookupCache(result);
            } catch (cacheError) {
              logDebug("mcp", "mission_cache_update_failed", {
                error: cacheError.message,
              });
            }
          } else {
            logDebug("mcp", "mission_cache_update_skipped_stale", {
              toolName,
              generationAtStart: userMissionsGenerationAtStart,
              generationNow: userMissionsGeneration,
            });
          }
          logDebug("tool", "call_snapshot_stored", {
            toolName,
            ttlMs: USER_MISSIONS_CACHE_TTL_MS,
            ageMs: userMissionsSnapshotAgeMs(),
            reason: String(opts?.reason || "").trim() || null,
          });
        } else if (shouldInvalidateUserMissionsSnapshot(toolName)) {
          if (!adoptMutationMissionState(result, toolName)) {
            invalidateUserMissionsSnapshot(toolName);
          }
        }
        finalizeToolCallEntry(toolCallEntry, "ok");
        const minIntervalMs = Number(TOOL_MIN_INTERVAL_MS.get(toolName) || 0);
        if (minIntervalMs > 0) {
          persistToolCooldown(toolName, Date.now() + minIntervalMs);
        }
        logDebug("tool", "call_ok", {
          callId: callTrace.callId,
          toolName,
          reason: callTrace.reason,
          httpRequests: callTrace.httpRequests,
          durationMs: Math.max(0, Date.now() - callTrace.startedAt),
        });
        ctx.mcpRateLimitReason = null;
        setMcpConnection("connected");
        return result;
      } catch (error) {
        if (error?.rateLimited) {
          finalizeToolCallEntry(
            toolCallEntry,
            error.cooldownActive === true ? "cooldown_blocked" : "rate_limited",
            error,
          );
          if (error.cooldownActive !== true) {
            setMcpConnection("disconnected", { error: error.message });
          }
          if (error.cooldownActive === true) {
            logDebug("tool", "call_rate_limited_active", {
              toolName,
              retryAfterSeconds: error.retryAfterSeconds,
              retryAt: error.retryAt,
            });
            writeThrottleDebugLog({
              type: "active_cooldown",
              requestedTool: toolName,
              triggerTool: error.toolName || toolName,
              waitSeconds: error.retryAfterSeconds,
              retryAt: error.retryAt,
              reason: error.reason || "pre_call",
              detail: "Call skipped because an MCP cooldown was already active.",
              stack: captureStack(3),
            });
            emitThrottleNotice({
              trigger: error.toolName || toolName,
              message: error.message,
              waitSeconds: Number(error.retryAfterSeconds || 0) || null,
              retryAt: Number(error.retryAt || 0) || null,
              detail: `Triggered by: ${String(error.reason || "pre_call")}`,
            });
          } else {
            logWithTimestamp(
              `[MCP] ⏳ ${toolName} rate limited. Retry after ${error.retryAfterSeconds}s.`,
            );
            logDebug("tool", "call_rate_limited", {
              toolName,
              retryAfterSeconds: error.retryAfterSeconds,
              retryAt: error.retryAt,
            });
            writeThrottleDebugLog({
              type: "http_429",
              requestedTool: toolName,
              triggerTool: error.toolName || toolName,
              waitSeconds: error.retryAfterSeconds,
              retryAt: error.retryAt,
              reason: "server_429",
              detail:
                error?.bodyError && typeof error.bodyError === "object"
                  ? safeJson(error.bodyError, 2000)
                  : trimText(error?.bodyError || "", 2000) || "n/a",
              stack: captureStack(3),
            });
            emitThrottleNotice({
              trigger: toolName,
              message: error.message,
              waitSeconds: Number(error.retryAfterSeconds || 0) || null,
              retryAt: Number(error.retryAt || 0) || null,
              detail:
                error?.bodyError && typeof error.bodyError === "object"
                  ? JSON.stringify(error.bodyError)
                  : null,
            });
          }
          logDebug("tool", "call_failed_summary", {
            callId: callTrace.callId,
            toolName,
            reason: callTrace.reason,
            httpRequests: callTrace.httpRequests,
            durationMs: Math.max(0, Date.now() - callTrace.startedAt),
            error: error.message,
          });
          throw error;
        }
        finalizeToolCallEntry(toolCallEntry, "error", error);
        logDebug("tool", "call_failed_summary", {
          callId: callTrace.callId,
          toolName,
          reason: callTrace.reason,
          httpRequests: callTrace.httpRequests,
          durationMs: Math.max(0, Date.now() - callTrace.startedAt),
          error: error.message,
        });
        if (!isAuthHttpError(error?.message || "")) {
          setMcpConnection("disconnected", { error: error.message });
          throw error;
        }
        const refreshed = await recoverAuthAfterRefreshFailure("auth_failure");
        if (!refreshed) throw error;
        const result = await runOnce();
        if (
          toolName === "get_user_missions" &&
          result &&
          typeof result === "object"
        ) {
          if (userMissionsGenerationAtStart === userMissionsGeneration) {
            try {
              updateMissionLookupCache(result);
            } catch (cacheError) {
              logDebug("mcp", "mission_cache_update_failed", {
                error: cacheError.message,
              });
            }
          } else {
            logDebug("mcp", "mission_cache_update_skipped_stale", {
              toolName,
              generationAtStart: userMissionsGenerationAtStart,
              generationNow: userMissionsGeneration,
            });
          }
        } else if (shouldInvalidateUserMissionsSnapshot(toolName)) {
          if (!adoptMutationMissionState(result, toolName)) {
            invalidateUserMissionsSnapshot(`${toolName}:auth_refresh`);
          }
        }
        finalizeToolCallEntry(toolCallEntry, "ok_after_refresh");
        logDebug("tool", "call_ok_after_refresh", { toolName });
        setMcpConnection("connected");
        return result;
      }
    };

    try {
      if (shouldUseUserMissionsSnapshot(toolName, args)) {
        const request = executeToolCall().finally(() => {
          if (userMissionsInflight === request) {
            userMissionsInflight = null;
            userMissionsInflightForceFresh = false;
          }
        });
        userMissionsInflight = request;
        userMissionsInflightForceFresh = opts?.forceFresh === true;
        return await request;
      }
      return await executeToolCall();
    } catch (error) {
      throw error;
    }
  }

  async function getUserMissions(opts = {}) {
    return await mcpToolCall("get_user_missions", {}, opts);
  }

  async function runLoginFlow(opts = {}) {
    const { forceInteractive = false, forceBrowser = false } = opts;
    const canInteractive = ctx.interactiveAuth || forceInteractive;

    logWithTimestamp("[AUTH] Starting login flow...");
    if (!canInteractive) {
      logWithTimestamp("[AUTH] Interactive auth disabled (token-only mode).");
      return false;
    }

    const loginTimeoutMs = LOGIN_TIMEOUT_MS;
    const openBrowser = Boolean(
      forceBrowser || ctx.interactiveAuth || ctx.debugMode,
    );
    logDebug("auth", "login_mode", {
      mode: openBrowser ? "popup" : "headless_url_only",
      timeoutSeconds: Math.floor(loginTimeoutMs / 1000),
    });

    try {
      setMcpConnection("reconnecting");
      await mcpLogin({
        url: ctx.MCP_URL,
        tokenFile: ctx.tokenFilePath,
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
        loginTimeoutMs,
        noBrowser: !openBrowser,
        printAuthUrl: false,
        onAuthUrl: (url) => {
          logDebug("auth", "oauth_url", { url });
        },
        onOpenBrowserFailed: (url) => {
          logWithTimestamp("[AUTH] ❌ Failed to open browser automatically.");
          logDebug("auth", "browser_open_failed", { url });
        },
      });
      logWithTimestamp("[AUTH] ✅ Login completed.");
      ctx.isAuthenticated = true;
      setMcpConnection("connected");
      return true;
    } catch (error) {
      logWithTimestamp(`[AUTH] ❌ Login failed: ${error.message}`);
      logDebug("auth", "login_failed", {
        error: error.message,
        stack: error.stack,
      });
      ctx.isAuthenticated = false;
      setMcpConnection("expired", { error: error.message });
      return false;
    }
  }

  function logout() {
    clearTokenFile(ctx.tokenFilePath);
    invalidateUserMissionsSnapshot("logout");
    ctx.isAuthenticated = false;
    ctx.authRefreshSignal = 0;
    ctx.currentUserDisplayName = "unknown";
    ctx.currentUserWalletId = "unknown";
    ctx.currentUserWalletSummary = null;
    setMcpConnection("disconnected");
  }

  return {
    bearerToken,
    getUserMissions,
    invalidateUserMissionsSnapshot,
    mcpToolCall,
    runLoginFlow,
    logout,
  };
}

module.exports = {
  createMcpClient,
};
