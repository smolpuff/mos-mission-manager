"use strict";

// TEMPORARY PBP AUTH DIAGNOSTICS. Remove this module and TEMP_AUTH_DIAGNOSTICS
// call sites after the reported renewal failure has been diagnosed.
// Observational only: never changes credentials, responses, or auth decisions.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const sessions = new Map();
const requests = new WeakMap();
const secrets = new Set();
const runId = crypto.randomBytes(6).toString("hex");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
let sequence = 0;

function fingerprint(value) {
  return value ? crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16) : null;
}

function remember(value) {
  if (typeof value === "string" && value.length >= 8) {
    secrets.add(value);
    if (secrets.size > 256) secrets.delete(secrets.values().next().value);
  }
}

function safeText(value, limit = 16000) {
  let text = String(value ?? "");
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\bBearer\s+[^\s,;"<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(/((?:[?&]|\b)(?:access_token|refresh_token|code|state|code_verifier|code_challenge)=)[^&\s"<>]+/gi, "$1[REDACTED]")
    .replace(/("(?:access_token|refresh_token|id_token|code|state|code_verifier|code_challenge|client_secret|authorization|cookie|set-cookie)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
    .slice(0, limit);
}

function sanitize(value, key = "", depth = 0) {
  if (key === "code" && typeof value === "number") return value;
  if (/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|registration[_-]?access[_-]?token|session[_-]?token|csrf[_-]?token|token|code|state|code[_-]?(?:verifier|challenge)|client[_-]?secret|authorization|cookie|set-cookie|private[_-]?key|secret)$/i.test(key)) {
    remember(value);
    return "[REDACTED]";
  }
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack,
      systemCode: value.code, errno: value.errno, syscall: value.syscall, cause: value.cause }, "", depth + 1);
  }
  if (depth > 8) return "[DEPTH LIMIT]";
  if (typeof value === "string") return safeText(value, key === "rawResponse" ? Infinity : 16000);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k, depth + 1)]));
  }
  return value;
}

function jwtSummary(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
    return {
      // Decode timestamps for diagnosis only; this is not signature validation.
      issuedAt: claims.iat, expiresAt: claims.exp, notBefore: claims.nbf,
      lifetimeSeconds: Number.isFinite(claims.exp) && Number.isFinite(claims.iat) ? claims.exp - claims.iat : null,
      secondsRemaining: Number.isFinite(claims.exp) ? Math.floor(claims.exp - Date.now() / 1000) : null,
      jtiFingerprint: fingerprint(claims.jti), sessionFingerprint: fingerprint(claims.sid || claims.sessionId || claims.session_id),
      clientFingerprint: fingerprint(claims.client_id || claims.clientId || claims.azp),
      fields: Object.keys(claims),
    };
  } catch { return null; }
}

function tokenSummary(record, tokenFile) {
  remember(record?.access_token);
  remember(record?.refresh_token);
  let stat = null;
  try {
    const s = fs.statSync(tokenFile);
    stat = { bytes: s.size, modifiedAt: s.mtime.toISOString(), permissions: (s.mode & 0o777).toString(8) };
  } catch (error) { stat = { errorCode: error.code }; }
  return {
    tokenFile, stat, present: Boolean(record), fields: record && typeof record === "object" ? Object.keys(record) : [],
    hasAccessToken: Boolean(record?.access_token), hasRefreshToken: Boolean(record?.refresh_token),
    accessFingerprint: fingerprint(record?.access_token), refreshFingerprint: fingerprint(record?.refresh_token),
    clientId: record?.client_id || null, scope: record?.scope || null,
    createdAt: record?.created_at, expiresAt: record?.expires_at, expiresIn: record?.expires_in,
    localSecondsRemaining: record?.expires_at ? Math.floor((Date.parse(record.expires_at) - Date.now()) / 1000) : null,
    accessJwt: jwtSummary(record?.access_token), refreshJwt: jwtSummary(record?.refresh_token),
  };
}

function tokenFileSummary(tokenFile) {
  try { return tokenSummary(JSON.parse(fs.readFileSync(tokenFile, "utf8")), tokenFile); }
  catch (error) { return { ...tokenSummary(null, tokenFile), readError: { name: error.name, code: error.code,
    message: error instanceof SyntaxError ? "Token file contains invalid JSON" : error.message } }; }
}

function configureAuthDiagnostics(tokenFile, context = {}) {
  const key = path.resolve(tokenFile);
  const current = sessions.get(key) || { history: [], historyBytes: 0, incident: null, logFile: path.join(path.dirname(key), "pbp-auth-debug.log") };
  Object.assign(current, context);
  sessions.set(key, current);
  return current;
}

function append(session, text) {
  try {
    fs.mkdirSync(path.dirname(session.logFile), { recursive: true });
    if (fs.existsSync(session.logFile) && fs.statSync(session.logFile).size > MAX_LOG_BYTES) {
      try { fs.unlinkSync(`${session.logFile}.2`); } catch {}
      try { fs.renameSync(`${session.logFile}.1`, `${session.logFile}.2`); } catch {}
      try { fs.renameSync(session.logFile, `${session.logFile}.1`); } catch {}
    }
    fs.appendFileSync(session.logFile, text, { mode: 0o600 });
  } catch {} // Diagnostics must never break an authenticated operation.
}

function authEvent(tokenFile, event, details = {}, { failure = false, resolved = false } = {}) {
  try {
    const session = sessions.get(path.resolve(tokenFile)) || configureAuthDiagnostics(tokenFile);
    const entry = sanitize({ at: new Date().toISOString(), uptimeSeconds: process.uptime(), pid: process.pid,
      runId, sequence: ++sequence, role: session.role, version: session.version,
      incident: session.incident, event, ...details });
    if (failure && !session.incident) {
      session.incident = `${runId}-${sequence}`;
      entry.incident = session.incident;
      append(session, `\n===== PBP AUTH INCIDENT ${session.incident} BEGIN =====\n${JSON.stringify({ context: "preceding events from this process", runtime: session.runtime, events: session.history })}\n`);
    }
    const line = JSON.stringify(entry);
    const recoveryStep = /^(?:client\.(?:refresh|login|recovery)\.|(?:refresh|login|oauth)\.|token\.(?:save|clear))/.test(event);
    if (session.incident && (failure || resolved || recoveryStep)) {
      append(session, `${line}\n`);
    }
    session.history.push(entry);
    session.historyBytes += Buffer.byteLength(line);
    while (session.history.length > 120 || session.historyBytes > MAX_CONTEXT_BYTES) {
      session.historyBytes -= Buffer.byteLength(JSON.stringify(session.history.shift()));
    }
    if (resolved && session.incident) {
      append(session, `===== PBP AUTH INCIDENT ${session.incident} END: authenticated request succeeded =====\n\n`);
      session.incident = null;
    }
  } catch {}
}

function requestSummary(options = {}) {
  const headers = new Headers(options.headers || {});
  const bearer = headers.get("authorization");
  if (bearer) remember(bearer.replace(/^Bearer\s+/i, ""));
  let body = {};
  try {
    if (headers.get("content-type")?.includes("x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(options.body));
      for (const key of ["refresh_token", "code", "code_verifier"]) remember(body[key]);
    } else if (options.body) {
      const json = JSON.parse(options.body);
      body = { method: json.method, id: json.id, tool: json.params?.name,
        argumentFields: Object.keys(json.params?.arguments || {}), arguments: json.params?.arguments,
        protocolVersion: json.params?.protocolVersion,
        // Registration contains no user credentials and helps identify grant differences.
        ...(json.grant_types ? json : {}) };
    }
  } catch { body = { bytes: String(options.body || "").length }; }
  return { method: options.method || "GET", hasBearer: Boolean(bearer), bearerFingerprint: fingerprint(bearer?.replace(/^Bearer\s+/i, "")),
    sessionFingerprint: fingerprint(headers.get("mcp-session-id")), body };
}

async function authFetch(url, options, { tokenFile, step }) {
  const requestId = `${runId}-${++sequence}`;
  const startedAt = Date.now();
  const endpoint = new URL(url);
  const summary = { endpoint: `${endpoint.origin}${endpoint.pathname}`, ...requestSummary(options) };
  authEvent(tokenFile, `${step}.request`, { requestId, ...summary });
  try {
    const response = await fetch(url, options);
    requests.set(response, { tokenFile, step, requestId, startedAt, summary });
    authEvent(tokenFile, `${step}.headers`, { requestId, status: response.status,
      durationMs: Date.now() - startedAt, contentType: response.headers.get("content-type"),
      serverDate: response.headers.get("date"), retryAfter: response.headers.get("retry-after"),
      authenticate: response.headers.get("www-authenticate") });
    return response;
  } catch (error) {
    authEvent(tokenFile, `${step}.network_error`, { requestId, request: summary, durationMs: Date.now() - startedAt, error }, { failure: true });
    throw error;
  }
}

function authResponse(response, text) {
  const request = requests.get(response);
  if (!request) return;
  const { tokenFile, step, requestId, startedAt, summary } = request;
  let body;
  const isRpcError = payload => Boolean(payload?.error || payload?.isError === true || payload?.result?.isError === true);
  try {
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const frames = String(text).split(/\r?\n\r?\n/).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        try { return [JSON.parse(data)]; } catch { return []; }
      });
      body = frames.find(isRpcError) || frames.at(-1) || text;
    } else {
      body = JSON.parse(text);
    }
  } catch { body = text; }
  const rpcError = isRpcError(body);
  const invalidPayload = typeof body === "string" && Boolean(String(text).trim());
  const includeBody = !response.ok || rpcError || invalidPayload || /token|register|metadata|discover/.test(step);
  const headers = Object.fromEntries(response.headers);
  // Register all response credentials before sanitizing an error description or nested body.
  for (const key of ["access_token", "refresh_token", "id_token", "registration_access_token", "client_secret", "code", "state"]) remember(body?.[key]);
  const expectedMetadataMiss = /metadata/.test(step) && response.status === 404;
  authEvent(tokenFile, `${step}.response`, { requestId, request: summary, durationMs: Date.now() - startedAt,
    status: response.status, statusText: response.statusText, url: response.url,
    ok: response.ok, redirected: response.redirected, headers,
    responseBytes: Buffer.byteLength(String(text)), body: includeBody ? body : undefined,
    rawResponse: includeBody ? String(text) : undefined },
    { failure: !expectedMetadataMiss && (!response.ok || rpcError || invalidPayload) });
}

function authRuntime(tokenFile, context) {
  const runtime = { platform: process.platform, arch: process.arch, node: process.version,
    osRelease: os.release(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  configureAuthDiagnostics(tokenFile, { ...context, runtime });
  authEvent(tokenFile, "runtime", runtime);
}

module.exports = { authEvent, authFetch, authResponse, authRuntime, tokenSummary, tokenFileSummary, fingerprint, sanitize, configureAuthDiagnostics };
