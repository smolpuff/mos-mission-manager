"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthenticationError, authenticationRequired } = require("./auth-errors");

test("auth classification uses transport status, explicit codes, or complete auth failures", () => {
  for (const status of [401]) {
    assert.equal(isAuthenticationError(Object.assign(new Error("Request rejected"), { status })), true);
  }
  for (const code of ["UNAUTHORIZED", "UNAUTHENTICATED", "INVALID_TOKEN", "TOKEN_EXPIRED", "invalid_grant"]) {
    assert.equal(isAuthenticationError(Object.assign(new Error("Request rejected"), { code })), true);
  }
  assert.equal(isAuthenticationError(authenticationRequired("Missing token. Run login.")), true);
  assert.equal(isAuthenticationError(authenticationRequired("Authentication expired. Login required.")), true);
  for (const message of ["Not authenticated", "Unauthorized", "Invalid token.", "Login required!"]) {
    assert.equal(isAuthenticationError(new Error(message)), true, message);
  }
});

test("ordinary tool failures and incidental numbers/auth words are never substring-matched", () => {
  for (const message of [
    "A watch_and_claim request is already active for this authenticated user. Wait for it to finish before starting another.",
    "mission 14013 failed", "NFT 40399 failed", "HTTP 40123", "HTTP 40300",
    "Forbidden", "Authorization failed", "Auth error",
    "Authentication service unavailable", "Authorization endpoint timed out", "Login request timeout",
    "Provider said forbidden mission name", "Missing token metadata for NFT", "tool call failed: HTTP 401",
    "RPC error: {\"code\":-32000,\"message\":\"unauthorized label\"}",
  ]) {
    assert.equal(isAuthenticationError(new Error(message)), false, message);
  }
  for (const status of [200, 400, 403, 404, 429, 500, 503, 40123, 40300]) {
    assert.equal(isAuthenticationError(Object.assign(new Error("server error"), { status })), false);
  }
  for (const code of [-32000, -32001, 40123, "MISSION_401_FAILED"]) {
    assert.equal(isAuthenticationError(Object.assign(new Error("server error"), { code })), false);
  }
  for (const status of [429, 500, 503]) {
    assert.equal(isAuthenticationError(Object.assign(new Error("Not authenticated"), {
      status, code: "INVALID_TOKEN",
    })), false, "Transient transport failures must not force login");
  }
});
