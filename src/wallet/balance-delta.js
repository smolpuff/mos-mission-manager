"use strict";

function canonicalCurrency(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (["pbp", "pbp_token", "pixel_by_pixel"].includes(normalized)) return "pbp";
  if (["tc", "tc_token", "tournament_coin", "tournament_coins"].includes(normalized)) return "tc";
  if (["cc", "cc_token", "community_coin", "community_coins"].includes(normalized)) return "cc";
  return normalized || null;
}

function numericBalance(value) {
  if (typeof value === "string") value = value.replace(/,/g, "");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyWalletBalanceDeltas(walletSummary, deltas = {}) {
  if (!walletSummary || typeof walletSummary !== "object") return walletSummary;
  const pending = new Map();
  for (const [currency, rawAmount] of Object.entries(deltas || {})) {
    const key = canonicalCurrency(currency);
    const amount = Number(rawAmount);
    if (!key || !Number.isFinite(amount) || amount === 0) continue;
    pending.set(key, Number(pending.get(key) || 0) + amount);
  }
  if (pending.size === 0) return walletSummary;

  const balances = Array.isArray(walletSummary.balances)
    ? walletSummary.balances.map((entry) => ({ ...entry }))
    : [];
  for (const entry of balances) {
    const key = canonicalCurrency(entry?.key || entry?.symbol || entry?.name);
    if (!key || !pending.has(key)) continue;
    const before =
      numericBalance(entry.balance) ?? numericBalance(entry.displayBalance);
    if (before === null) continue;
    const after = before + Number(pending.get(key));
    entry.balance = after;
    entry.displayBalance = after;
    pending.delete(key);
  }
  for (const [key, amount] of pending.entries()) {
    balances.push({
      key,
      symbol: key.toUpperCase(),
      name: key.toUpperCase(),
      balance: amount,
      displayBalance: amount,
    });
  }
  return { ...walletSummary, balances };
}

module.exports = { applyWalletBalanceDeltas, canonicalCurrency };
