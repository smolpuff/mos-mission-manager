"use strict";

const os = require("node:os");

function debugLogContext(ctx = {}) {
  const summary = ctx.currentUserWalletSummary || {};
  const value = (...values) => values.find(item => item && item !== "unknown") || "unknown";
  const cpu = process.cpuUsage();
  return {
    user: {
      name: value(ctx.currentUserDisplayName, summary.displayName, summary.display_name, summary.username),
      id: value(summary.userId, summary.user_id),
    },
    wallet: {
      id: value(ctx.currentUserWalletId, summary.walletId, summary.wallet_id),
      address: value(ctx.signerWallet, ctx.signerConfig?.walletAddress, ctx.signerConfig?.wallet_address, ctx.fundingWalletSummary?.address),
    },
    resourceUsage: ctx.resourceUsage || {
      sampledAt: Date.now(),
      process: {
        pid: process.pid,
        uptimeSeconds: process.uptime(),
        memoryBytes: process.memoryUsage(),
        cpuTimeMicroseconds: { user: cpu.user, system: cpu.system },
      },
      system: { totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() },
    },
  };
}

function formatDebugLogContext(context) {
  return [
    `user: ${JSON.stringify(context.user)}`,
    `wallet: ${JSON.stringify(context.wallet)}`,
    `resourceUsage: ${JSON.stringify(context.resourceUsage)}`,
  ];
}

module.exports = { debugLogContext, formatDebugLogContext };
