"use strict";

const fs = require("fs");
const { login: mcpLogin, refreshAccessToken } = require("../../lib/mcp");

function createMcpClient(ctx, logger) {
  const { logWithTimestamp, logDebug } = logger;
  const LOGIN_TIMEOUT_MS = 180000;
  const AUTH_REQUEST_TIMEOUT_MS = 30000;
  const MCP_REQUEST_TIMEOUT_MS = 30000;
  const REFRESH_RETRY_ATTEMPTS = 3;
  const REFRESH_RETRY_DELAY_MS = 1000;

  function parseJsonOutput(raw, fallback = null) {
    const text = String(raw ?? "").trim();
    if (!text) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
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

  async function tryRefresh(reason = "proactive") {
    const record = tokenRecord();
    if (!record?.refresh_token) return false;
    try {
      logDebug("auth", "refresh_start", { reason });
      await refreshAccessToken({
        url: ctx.MCP_URL,
        tokenFile: ctx.tokenFilePath,
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      });
      ctx.authRefreshSignal = Number(ctx.authRefreshSignal || 0) + 1;
      logWithTimestamp("[AUTH] ✅ Token refreshed.");
      logDebug("auth", "refresh_ok", { reason });
      if (typeof ctx.onAuthRefresh === "function") {
        setTimeout(() => {
          try {
            ctx.onAuthRefresh({ reason, signal: Number(ctx.authRefreshSignal || 0) });
          } catch (callbackError) {
            logDebug("auth", "refresh_callback_failed", { error: callbackError.message });
          }
        }, 0);
      }
      return true;
    } catch (error) {
      logDebug("auth", "refresh_failed", { reason, error: error.message });
      return false;
    }
  }

  async function recoverAuthAfterRefreshFailure(reason = "proactive") {
    for (let attempt = 1; attempt <= REFRESH_RETRY_ATTEMPTS; attempt += 1) {
      const refreshed = await tryRefresh(`${reason}_retry_${attempt}`);
      if (refreshed) return true;
      logWithTimestamp(
        `[AUTH] ❌ Token refresh failed (${attempt}/${REFRESH_RETRY_ATTEMPTS}).`,
      );
      if (attempt < REFRESH_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
      }
    }

    logWithTimestamp("[AUTH] 🔄 Refresh failed 3 times. Starting popup login...");
    const loginOk = await runLoginFlow({
      forceInteractive: true,
      forceBrowser: true,
    });
    if (!loginOk) return false;
    return Boolean(bearerToken());
  }

  async function mcpPost({ token, sessionId, body, timeoutMs }) {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": ctx.MCP_PROTOCOL_VERSION,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const effectiveTimeoutMs = Number(timeoutMs ?? MCP_REQUEST_TIMEOUT_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      const response = await fetch(ctx.MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const json = parseJsonOutput(text, {});
      const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
      return {
        ok: response.ok,
        status: response.status,
        json,
        sessionId: nextSessionId,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`request timeout after ${effectiveTimeoutMs}ms`);
      }
      throw error;
    } finally {
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
          clientInfo: { name: "missions-mcp", version: ctx.APP_VERSION },
        },
      },
    });

    if (!init.ok) throw new Error(`initialize failed: HTTP ${init.status}`);

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
    if (!record?.access_token) throw new Error("Missing token. Run login.");
    if (tokenExpiresSoon(record)) {
      const refreshed = await recoverAuthAfterRefreshFailure("expires_soon");
      if (!refreshed) {
        throw new Error("Authentication expired. Login required.");
      }
    }

    const runOnce = async () => {
      const token = bearerToken();
      if (!token) throw new Error("Missing token. Run login.");
      const sessionId = await mcpInitialize(token);
      const call = await mcpPost({
        token,
        sessionId,
        timeoutMs: opts.timeoutMs,
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        },
      });
      if (!call.ok) throw new Error(`tool call failed: HTTP ${call.status}`);
      if (call.json?.error)
        throw new Error(`RPC error: ${JSON.stringify(call.json.error)}`);
      return call.json?.result || {};
    };

    try {
      const result = await runOnce();
      logDebug("tool", "call_ok", { toolName });
      return result;
    } catch (error) {
      if (!isAuthHttpError(error?.message || "")) throw error;
      const refreshed = await recoverAuthAfterRefreshFailure("auth_failure");
      if (!refreshed) throw error;
      const result = await runOnce();
      logDebug("tool", "call_ok_after_refresh", { toolName });
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
      return true;
    } catch (error) {
      logWithTimestamp(`[AUTH] ❌ Login failed: ${error.message}`);
      logDebug("auth", "login_failed", {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  return {
    bearerToken,
    mcpToolCall,
    runLoginFlow,
  };
}

module.exports = {
  createMcpClient,
};
