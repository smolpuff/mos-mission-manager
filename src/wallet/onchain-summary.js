"use strict";

const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const PBP_MINT = "3f7wfg9yHLtGKvy75MmqsVT1ueTFoqyySQbusrX1YAQ4";

async function rpcJsonCall(method, params) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && !payload?.error) return payload.result;

    const status = response.status;
    const retryAfter = response.headers?.get?.("retry-after");
    const err = payload?.error
      ? new Error(`RPC ${method} failed: ${JSON.stringify(payload.error)}`)
      : new Error(`RPC ${method} failed: HTTP ${status}`);
    lastError = err;

    const isRateLimited = status === 429;
    if (!isRateLimited || attempt === 3) break;

    const headerDelayMs = retryAfter ? Math.floor(Number(retryAfter) * 1000) : 0;
    const backoffMs = Math.min(4000, 350 * 2 ** (attempt - 1));
    const jitterMs = Math.floor(Math.random() * 150);
    const delayMs = Math.max(headerDelayMs, backoffMs + jitterMs);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastError || new Error(`RPC ${method} failed`);
}

function parseBalanceNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[, _]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function fetchOnchainFundingWalletSummary(walletAddress) {
  const address = String(walletAddress || "").trim();
  if (!address) throw new Error("walletAddress is required");
  const [solResult, tokenResult] = await Promise.all([
    rpcJsonCall("getBalance", [address, { commitment: "confirmed" }]),
    rpcJsonCall("getTokenAccountsByOwner", [
      address,
      { mint: PBP_MINT },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  const lamports = typeof solResult?.value === "number" ? solResult.value : null;
  let pbp = 0;
  const tokenAccounts = Array.isArray(tokenResult?.value) ? tokenResult.value : [];
  for (const entry of tokenAccounts) {
    const amount =
      entry?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ??
      entry?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString;
    const parsed = parseBalanceNumber(amount);
    if (parsed !== null) pbp += parsed;
  }
  return {
    address,
    sol: lamports === null ? null : lamports / 1_000_000_000,
    pbp,
    status: "ok",
    source: "rpc",
  };
}

module.exports = {
  SOLANA_RPC_URL,
  PBP_MINT,
  fetchOnchainFundingWalletSummary,
};
