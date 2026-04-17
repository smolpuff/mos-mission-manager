"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DEFAULT_URL = "https://pixelbypixel.studio/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_CLIENT_ID = "pbp_mcp_65d544c5a639e953590e09c3c12db4a5";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LOGIN_TIMEOUT_MS = 180000;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".pbp-mcp", "token.json");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseJson(text, fallback = null) {
  const raw = String(text ?? "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readTokenFile(tokenFile = DEFAULT_TOKEN_FILE) {
  if (!fs.existsSync(tokenFile)) return null;
  return parseJson(fs.readFileSync(tokenFile, "utf8"), null);
}

function saveTokenFile(payload, tokenFile = DEFAULT_TOKEN_FILE) {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const created = new Date();
  const record = { ...payload, created_at: created.toISOString() };
  if (typeof record.expires_in === "number") {
    record.expires_at = new Date(
      created.getTime() + record.expires_in * 1000,
    ).toISOString();
  }
  fs.writeFileSync(tokenFile, JSON.stringify(record, null, 2));
}

function clearTokenFile(tokenFile = DEFAULT_TOKEN_FILE) {
  if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
}

function getAccessToken({ token, tokenFile = DEFAULT_TOKEN_FILE } = {}) {
  if (token) return token;
  if (process.env.PBP_BEARER_TOKEN) return process.env.PBP_BEARER_TOKEN;
  const saved = readTokenFile(tokenFile);
  return saved && typeof saved.access_token === "string"
    ? saved.access_token
    : null;
}

function pkcePair() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

async function openBrowser(url) {
  const target = String(url || '').trim();
  if (!target) return false;
  const windowsTarget = `"${target.replace(/"/g, '\\"')}"`;
  const candidates =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? [['rundll32', ['url.dll,FileProtocolHandler', target]]]
        : [
            ['xdg-open', [target]],
            ['gio', ['open', target]],
          ];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once('exit', (code) => {
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

function normalizeBaseUrl(url = DEFAULT_URL) {

  try {
    return new URL(url).toString();
  } catch {
    throw new Error(`Invalid MCP URL: ${url}`);
  }
}

function resolveEndpoint(raw, baseUrl) {
  if (!isNonEmptyString(raw)) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    throw new Error(`Invalid endpoint URL: ${raw}`);
  }
}

function formatFetchFailure(error, requestUrl, method) {
  const cause = error?.cause || {};
  const parts = [`${method} ${requestUrl}`];
  if (cause?.code) parts.push(`cause=${cause.code}`);
  if (cause?.errno) parts.push(`errno=${cause.errno}`);
  if (cause?.message) parts.push(`causeMessage=${cause.message}`);
  return parts.join(" ");
}

async function discover({
  url = DEFAULT_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const requestUrl = normalizeBaseUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(requestUrl, { method: "GET", signal: controller.signal });
    const json = parseJson(await res.text(), {});
    if (!res.ok) throw new Error(`discover failed: HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson({
  url = DEFAULT_URL,
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const requestUrl = normalizeBaseUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = parseJson(await res.text(), {});
    return { ok: res.ok, status: res.status, headers: res.headers, json };
  } catch (error) {
    const message = formatFetchFailure(error, requestUrl, "POST");
    const wrapped = new Error(`fetch failed: ${message}`);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

async function initialize({
  url = DEFAULT_URL,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const init = await postJson({
    url,
    timeoutMs,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pbp-mcp-js", version: "0.1.0" },
      },
    },
  });

  if (!init.ok || init.json?.error) {
    throw new Error(
      `initialize failed: HTTP ${init.status} ${JSON.stringify(init.json?.error || {})}`,
    );
  }

  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize failed: missing mcp-session-id");

  await postJson({
    url,
    timeoutMs,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  return sessionId;
}

async function toolsList({
  url = DEFAULT_URL,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sessionId = await initialize({ url, token, timeoutMs });
  const res = await postJson({
    url,
    timeoutMs,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });

  if (!res.ok || res.json?.error) {
    throw new Error(
      `tools/list failed: HTTP ${res.status} ${JSON.stringify(res.json?.error || {})}`,
    );
  }
  return res.json?.result || {};
}

async function callTool(name, args = {}, opts = {}) {
  const {
    url = DEFAULT_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tokenFile = DEFAULT_TOKEN_FILE,
  } = opts;
  const token = getAccessToken({ token: opts.token, tokenFile });
  if (!token)
    throw new Error(
      "Missing token. Run `pbp-mcp login` or set PBP_BEARER_TOKEN.",
    );

  const sessionId = await initialize({ url, token, timeoutMs });
  const res = await postJson({
    url,
    timeoutMs,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
      Authorization: `Bearer ${token}`,
    },
    body: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args || {} },
    },
  });

  if (!res.ok || res.json?.error) {
    throw new Error(
      `tools/call failed: HTTP ${res.status} ${JSON.stringify(res.json?.error || {})}`,
    );
  }

  return res.json?.result || {};
}

async function discoverRegistrationEndpoint(issuer, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!isNonEmptyString(issuer)) return null;
  const wellKnown = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(wellKnown, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = parseJson(await res.text(), {});
    return isNonEmptyString(payload?.registration_endpoint)
      ? payload.registration_endpoint
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function dynamicRegisterClient({
  registrationEndpoint,
  baseUrl = DEFAULT_URL,
  redirectUri,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const endpoint = resolveEndpoint(registrationEndpoint, baseUrl);
  if (!endpoint) throw new Error("Missing registration endpoint");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "pbp-mcp-js",
      }),
      signal: controller.signal,
    });
    const payload = parseJson(await res.text(), {});
    if (!res.ok) {
      throw new Error(
        `dynamic client registration failed: HTTP ${res.status} ${JSON.stringify(payload)}`,
      );
    }
    const clientId = payload?.client_id;
    if (!isNonEmptyString(clientId)) {
      throw new Error("dynamic client registration missing client_id");
    }
    return clientId;
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeCodeForToken({
  tokenEndpoint,
  clientId = DEFAULT_CLIENT_ID,
  code,
  redirectUri,
  verifier,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: controller.signal,
    });
    const payload = parseJson(await res.text(), {});
    if (!res.ok)
      throw new Error(
        `token exchange failed: HTTP ${res.status} ${JSON.stringify(payload)}`,
      );
    if (!payload.access_token)
      throw new Error("token exchange failed: missing access_token");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeRefreshTokenForToken({
  tokenEndpoint,
  clientId = DEFAULT_CLIENT_ID,
  refreshToken,
  timeoutMs,
}) {
  if (!isNonEmptyString(refreshToken)) {
    throw new Error("refresh token missing");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      signal: controller.signal,
    });
    const payload = parseJson(await res.text(), {});
    if (!res.ok) {
      throw new Error(
        `token refresh failed: HTTP ${res.status} ${JSON.stringify(payload)}`,
      );
    }
    if (!payload.access_token) {
      throw new Error("token refresh failed: missing access_token");
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function login({
  url = DEFAULT_URL,
  tokenFile = DEFAULT_TOKEN_FILE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  noBrowser = false,
  printAuthUrl = true,
  onAuthUrl = null,
  onOpenBrowserFailed = null,
} = {}) {
  const baseUrl = normalizeBaseUrl(url);
  const baseOrigin = new URL(baseUrl).origin;
  const discovered = await discover({ url, timeoutMs });
  const auth = discovered?.auth || {};
  const authorizationEndpoint =
    resolveEndpoint(auth.authorizationEndpoint, baseUrl) ||
    new URL("/oauth/authorize", baseOrigin).toString();
  const tokenEndpoint =
    resolveEndpoint(auth.tokenEndpoint, baseUrl) ||
    new URL("/oauth/token", baseOrigin).toString();
  let registrationEndpoint =
    resolveEndpoint(auth.registrationEndpoint, baseUrl) || null;
  if (!registrationEndpoint && isNonEmptyString(auth?.issuer)) {
    registrationEndpoint = await discoverRegistrationEndpoint(auth.issuer, timeoutMs);
  }
  if (!registrationEndpoint && tokenEndpoint.endsWith("/token")) {
    registrationEndpoint = tokenEndpoint.slice(0, -"/token".length) + "/register";
  }

  const state = crypto.randomBytes(24).toString("hex");
  const { verifier, challenge } = pkcePair();

  let server;
  let callbackResolve;
  let callbackReject;
  const callbackPromise = new Promise((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });

  server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Auth Complete</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 20px; }
      .ok { font-weight: 600; }
      .muted { color: #555; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div class="ok">Authentication complete.</div>
    <div class="muted">This window will close automatically.</div>
    <script>
      setTimeout(function () { window.close(); }, 700);
    </script>
  </body>
</html>`);
      if (error) return callbackReject(new Error(`oauth error: ${error}`));
      if (returnedState !== state)
        return callbackReject(new Error("oauth state mismatch"));
      if (!code)
        return callbackReject(new Error("oauth callback missing code"));
      callbackResolve(code);
    } catch (error) {
      callbackReject(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address()?.port;
  if (!port) throw new Error("failed to bind oauth callback port");
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  let clientId = DEFAULT_CLIENT_ID;
  if (registrationEndpoint) {
    try {
      clientId = await dynamicRegisterClient({
        registrationEndpoint,
        baseUrl,
        redirectUri,
        timeoutMs,
      });
    } catch {
      clientId = DEFAULT_CLIENT_ID;
    }
  }

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", redirectUri);

  const authUrlText = authUrl.toString();
  if (typeof onAuthUrl === "function") onAuthUrl(authUrlText);

  if (!noBrowser) {
    const opened = await openBrowser(authUrl.toString());
    if (!opened) {
      if (typeof onOpenBrowserFailed === "function") {
        onOpenBrowserFailed(authUrlText);
      } else {
        console.warn(
          "warning: failed to open browser automatically; copy/paste the URL manually.",
        );
      }
    }
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error("login timeout waiting for callback")),
      loginTimeoutMs,
    );
  });

  if (printAuthUrl) {
    console.log(`Open this URL to authenticate:\n${authUrlText}`);
  }

  try {
    const code = await Promise.race([callbackPromise, timeoutPromise]);
    const tokenPayload = await exchangeCodeForToken({
      tokenEndpoint,
      clientId,
      code,
      redirectUri,
      verifier,
      timeoutMs,
    });
    saveTokenFile({ ...tokenPayload, client_id: clientId }, tokenFile);
    return { tokenFile };
  } finally {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function refreshAccessToken({
  url = DEFAULT_URL,
  tokenFile = DEFAULT_TOKEN_FILE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const saved = readTokenFile(tokenFile);
  if (!saved) throw new Error("no saved token");
  const refreshToken = saved.refresh_token;
  if (!isNonEmptyString(refreshToken)) throw new Error("no refresh token available");

  const baseUrl = normalizeBaseUrl(url);
  const baseOrigin = new URL(baseUrl).origin;
  const discovered = await discover({ url, timeoutMs });
  const auth = discovered?.auth || {};
  const tokenEndpoint =
    resolveEndpoint(auth.tokenEndpoint, baseUrl) ||
    new URL("/oauth/token", baseOrigin).toString();
  const clientId = isNonEmptyString(saved.client_id) ? saved.client_id : DEFAULT_CLIENT_ID;

  const refreshed = await exchangeRefreshTokenForToken({
    tokenEndpoint,
    clientId,
    refreshToken,
    timeoutMs,
  });
  const nextPayload = {
    ...saved,
    ...refreshed,
    client_id: clientId,
    refresh_token: isNonEmptyString(refreshed.refresh_token)
      ? refreshed.refresh_token
      : refreshToken,
  };
  saveTokenFile(nextPayload, tokenFile);
  return { tokenFile };
}

async function audit({
  url = DEFAULT_URL,
  tokenFile = DEFAULT_TOKEN_FILE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const report = {
    url,
    discover: { ok: false, error: null },
    initialize: { ok: false, error: null },
    tools_list: { ok: false, error: null },
    who_am_i: { ok: false, error: null },
    token_file: tokenFile,
    notes: [],
  };

  try {
    const d = await discover({ url, timeoutMs });
    report.discover.ok = true;
    report.discover.tool_count = Array.isArray(d?.tools)
      ? d.tools.length
      : undefined;
  } catch (error) {
    report.discover.error = String(error.message || error);
  }

  const token = getAccessToken({ tokenFile });
  if (!token) {
    report.notes.push(
      "No bearer token provided or saved; initialize/calls skipped.",
    );
    return report;
  }

  try {
    await initialize({ url, token, timeoutMs });
    report.initialize.ok = true;
  } catch (error) {
    report.initialize.error = String(error.message || error);
    return report;
  }

  try {
    const list = await toolsList({ url, token, timeoutMs });
    report.tools_list.ok = true;
    report.tools_list.count = Array.isArray(list?.tools)
      ? list.tools.length
      : 0;
  } catch (error) {
    report.tools_list.error = String(error.message || error);
  }

  try {
    const who = await callTool("who_am_i", {}, { url, timeoutMs, tokenFile });
    report.who_am_i.ok = true;
    report.who_am_i.result = who;
  } catch (error) {
    report.who_am_i.error = String(error.message || error);
  }

  return report;
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_TOKEN_FILE,
  parseJson,
  readTokenFile,
  saveTokenFile,
  clearTokenFile,
  getAccessToken,
  discover,
  toolsList,
  callTool,
  login,
  refreshAccessToken,
  audit,
};
