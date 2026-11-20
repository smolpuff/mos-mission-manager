"use strict";

const AUTH_CODES = new Set([
  "MCP_AUTH_REQUIRED",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "INVALID_TOKEN",
  "INVALID_GRANT",
  "TOKEN_EXPIRED",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
]);

// Some MCP tool failures have no status/code. Accept only complete, explicit
// auth failures; identifiers and incidental mentions must never force login.
const AUTH_MESSAGE = /^(?:not authenticated|unauthenticated|unauthorized|invalid token|missing token|token expired|authentication (?:expired|required|failed)|login required)[.!]?$/i;

function isAuthenticationError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.status === 401) return true;
  if (error.status === 429 || error.status >= 500) return false;
  if (typeof error.code === "string" && AUTH_CODES.has(error.code.toUpperCase())) return true;
  return AUTH_MESSAGE.test(String(error.authMessage || error.message || "").trim());
}

function authenticationRequired(message) {
  return Object.assign(new Error(message), { code: "MCP_AUTH_REQUIRED" });
}

module.exports = { isAuthenticationError, authenticationRequired };
