"use strict";

const fs = require("fs");
const { normalizeMissionList } = require("../missions/normalize");
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

  function rateLimitWaitMs() {
    const until = Number(ctx.mcpRateLimitedUntil || 0);
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }

  function buildActiveRateLimitError(reason = "pre_call") {
    const waitMs = rateLimitWaitMs();
    const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    const error = new Error(
      `rate limited; retry in ${waitSeconds}s`,
    );
    error.rateLimited = true;
    error.retryAfterSeconds = waitSeconds;
    error.retryAt = Number(ctx.mcpRateLimitedUntil || 0);
    error.toolName = ctx.mcpRateLimitReason || null;
    error.cooldownActive = true;
    error.reason = reason;
    return error;
  }

  function buildRateLimitError({ status = 429, retryAfterSeconds = 30, toolName = null, bodyError = null } = {}) {
    const waitSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 30));
    const retryAt = Date.now() + waitSeconds * 1000;
    ctx.mcpRateLimitedUntil = retryAt;
    ctx.mcpRateLimitReason = toolName || "unknown_tool";
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
  }) {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": ctx.MCP_PROTOCOL_VERSION,
    };
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

  async function mcpInitialize(token) {
    logDebug("mcp", "initialize_start");
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
      logDebug("mcp", "initialize_ok", { sessionId: null, streamableHttp: true });
      return null;
    }

    await mcpPost({
      token,
      sessionId: init.sessionId,
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
    });

    logDebug("mcp", "initialize_ok", { sessionId: init.sessionId });
    return init.sessionId;
  }

  async function mcpToolCall(toolName, args = {}, opts = {}) {
    logDebug("tool", "call_start", { toolName, args });
    const record = tokenRecord();
    if (!record?.access_token) {
      setMcpConnection("expired", { error: "missing_token" });
      throw new Error("Missing token. Run login.");
    }
    if (tokenExpiresSoon(record)) {
      const refreshed = await recoverAuthAfterRefreshFailure("expires_soon");
      if (!refreshed) {
        setMcpConnection("expired", { error: "refresh_failed" });
        throw new Error("Authentication expired. Login required.");
      }
    }

    const runOnce = async () => {
      if (rateLimitWaitMs() > 0) {
        throw buildActiveRateLimitError(toolName);
      }
      const token = bearerToken();
      if (!token) {
        setMcpConnection("expired", { error: "missing_token" });
        throw new Error("Missing token. Run login.");
      }
      const sessionId = await mcpInitialize(token);
      const call = await mcpPost({
        token,
        sessionId,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
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
      return call.json?.result || {};
    };

    try {
      const result = await runOnce();
      if (toolName === "get_user_missions" && result && typeof result === "object") {
        try {
          updateMissionLookupCache(result);
        } catch (cacheError) {
          logDebug("mcp", "mission_cache_update_failed", {
            error: cacheError.message,
          });
        }
      }
      logDebug("tool", "call_ok", { toolName });
      ctx.mcpRateLimitReason = null;
      setMcpConnection("connected");
      return result;
    } catch (error) {
      if (error?.rateLimited) {
        setMcpConnection("disconnected", { error: error.message });
        if (error.cooldownActive === true) {
          logDebug("tool", "call_rate_limited_active", {
            toolName,
            retryAfterSeconds: error.retryAfterSeconds,
            retryAt: error.retryAt,
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
        }
        throw error;
      }
      if (!isAuthHttpError(error?.message || "")) {
        setMcpConnection("disconnected", { error: error.message });
        throw error;
      }
      const refreshed = await recoverAuthAfterRefreshFailure("auth_failure");
      if (!refreshed) throw error;
      const result = await runOnce();
      if (toolName === "get_user_missions" && result && typeof result === "object") {
        try {
          updateMissionLookupCache(result);
        } catch (cacheError) {
          logDebug("mcp", "mission_cache_update_failed", {
            error: cacheError.message,
          });
        }
      }
      logDebug("tool", "call_ok_after_refresh", { toolName });
      setMcpConnection("connected");
      return result;
    }
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
      setMcpConnection("connected");
      return true;
    } catch (error) {
      logWithTimestamp(`[AUTH] ❌ Login failed: ${error.message}`);
      logDebug("auth", "login_failed", {
        error: error.message,
        stack: error.stack,
      });
      setMcpConnection("expired", { error: error.message });
      return false;
    }
  }

  function logout() {
    clearTokenFile(ctx.tokenFilePath);
    ctx.isAuthenticated = false;
    ctx.authRefreshSignal = 0;
    ctx.currentUserDisplayName = "unknown";
    ctx.currentUserWalletId = "unknown";
    ctx.currentUserWalletSummary = null;
    setMcpConnection("disconnected");
  }

  return {
    bearerToken,
    mcpToolCall,
    runLoginFlow,
    logout,
  };
}

module.exports = {
  createMcpClient,
};
