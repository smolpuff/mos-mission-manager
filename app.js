#!/usr/bin/env node
"use strict";

/*
 * STYLE CONTRACT (project-wide):
 * - Keep code concise, explicit, and consistent with this file.
 * - Prefer small focused helpers; avoid many competing patterns for same task.
 * - Use early returns and flat control flow where possible.
 * - Keep logging format and command handling style uniform.
 * - Do not introduce new frameworks/patterns unless required and documented in TODO.md.
 * - When features change, update FEATURES.md in the same commit/session.
 */

const { createContext } = require("./src/context");
const { createLogger } = require("./src/logger");
const { loadConfig, saveConfig, flushConfig } = require("./src/config");
const { createSignerService } = require("./src/signer");
const { createMcpClient } = require("./src/mcp/client");
const { createChecksService } = require("./src/services/checks");
const { createWatchService } = require("./src/services/watch");
const { createCommandHandler } = require("./src/commands");
const { startStartupFx } = require("./src/ui/startup-fx");

const ctx = createContext();
const logger = createLogger(ctx);
const signer = createSignerService(ctx, logger);
const mcp = createMcpClient(ctx, logger);
const checks = createChecksService(ctx, logger, mcp, { signer });
const watch = createWatchService(ctx, logger, mcp, checks, { saveConfig }, { signer });
const commands = createCommandHandler(
  ctx,
  logger,
  {
    runLoginFlow: mcp.runLoginFlow,
    logout: mcp.logout,
    runInitialChecks: checks.runInitialChecks,
    startWatchLoop: watch.startWatchLoop,
    runWatchCycle: watch.runWatchCycle,
    runManualProcess: watch.runManualProcess,
    runManualResetCheck: watch.runManualResetCheck,
    stopWatchLoop: watch.stopWatchLoop,
    refreshFundingWalletSummary: checks.refreshFundingWalletSummary,
  },
  { saveConfig, flushConfig },
  { signer },
);

const STARTUP_FX_ENABLED = !ctx.plainOutputMode;
const STARTUP_FX_FRAME_MS = 95;
const STARTUP_PROGRESS_PULSE_MS = 220;

function createGuiStateEmitter(ctx) {
  let last = null;
  let pending = false;
  let lastSentAt = 0;
  const MIN_EMIT_INTERVAL_MS = 120;

  function buildState() {
    if (process.env.PBP_GUI_BRIDGE !== "1") return;
    if (typeof process.send !== "function") return;
    const state = {
      appName: ctx.APP_NAME,
      appVersion: ctx.APP_VERSION,
      isAuthenticated: ctx.isAuthenticated,
      mcpConnection: ctx.mcpConnection,
      watcherRunning: ctx.watcherRunning,
      watchLoopEnabled: ctx.watchLoopEnabled,
      currentUserDisplayName: ctx.currentUserDisplayName,
      currentUserWalletId: ctx.currentUserWalletId,
      currentUserWalletSummary: ctx.currentUserWalletSummary,
      currentMissionStats: ctx.currentMissionStats,
      guiMissionSlots: ctx.guiMissionSlots,
      slotUnlockSummary: ctx.slotUnlockSummary,
      currentMode: ctx.currentMode,
      level20ResetEnabled: ctx.level20ResetEnabled,
      missionModeEnabled: ctx.missionModeEnabled,
      nftCooldownResetEnabled: ctx.nftCooldownResetEnabled,
      nftCooldownResetMaxPbp: ctx.config?.nftCooldownResetMaxPbp ?? 20,
      currentMissionResetLevel: ctx.currentMissionResetLevel,
      sessionRewardTotals: ctx.sessionRewardTotals,
      sessionSpendTotals: ctx.sessionSpendTotals,
      signerLocked: ctx.signerLocked,
      signerReady: ctx.signerReady,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      signerWallet: ctx.signerConfig?.walletAddress || ctx.signerConfig?.walletRef || null,
      fundingWalletSummary: ctx.fundingWalletSummary,
    };
    return state;
  }

  function emitNow() {
    const state = buildState();
    if (!state) return;
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    lastSentAt = Date.now();
    process.send({ type: "pbp_state", state });
  };

  function emitSoon() {
    if (pending) return;
    pending = true;
    const wait = Math.max(0, MIN_EMIT_INTERVAL_MS - (Date.now() - lastSentAt));
    setTimeout(() => {
      pending = false;
      emitNow();
    }, wait);
  }

  return { emitNow, emitSoon };
}

const guiEmitter = createGuiStateEmitter(ctx);
const emitGuiState = guiEmitter.emitNow;
const emitGuiStateSoon = guiEmitter.emitSoon;

function sendGuiEvent(event, payload = {}) {
  if (process.env.PBP_GUI_BRIDGE !== "1") return;
  if (typeof process.send !== "function") return;
  process.send({ type: "pbp_event", event, payload });
}

function sendGuiResponse(requestId, payload = {}) {
  if (process.env.PBP_GUI_BRIDGE !== "1") return;
  if (typeof process.send !== "function") return;
  process.send({ type: "pbp_response", requestId, payload });
}

function wrapAsyncMethod(obj, name) {
  if (!obj || typeof obj[name] !== "function") return;
  const original = obj[name];
  obj[name] = async (...args) => {
    const result = await original(...args);
    emitGuiState();
    return result;
  };
}

function wrapSyncMethod(obj, name) {
  if (!obj || typeof obj[name] !== "function") return;
  const original = obj[name];
  obj[name] = (...args) => {
    const result = original(...args);
    emitGuiState();
    return result;
  };
}

if (process.env.PBP_GUI_BRIDGE === "1" && typeof process.send === "function") {
  ctx.guiBridge = {
    emitNow: emitGuiState,
    emitSoon: emitGuiStateSoon,
    sendEvent: sendGuiEvent,
  };

  process.on("message", async (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type !== "pbp_request") return;
    const requestId = message.requestId;
    const action = String(message.action || "");
    if (!requestId) return;
    try {
      if (action === "signer_reveal_backup") {
        if (!signer || typeof signer.revealWalletBackup !== "function") {
          throw new Error("Signer service unavailable.");
        }
        const backup = await signer.revealWalletBackup();
        sendGuiResponse(requestId, { ok: true, backup });
        return;
      }
      if (action === "signer_create_generated_wallet") {
        if (!signer || typeof signer.createGeneratedWallet !== "function") {
          throw new Error("Signer service unavailable.");
        }
        signer.setSignerMode("app_wallet", "ui_create");
        ctx.config.signerMode = ctx.signerMode;
        flushConfig(ctx, logger.logDebug);
        const created = await signer.createGeneratedWallet();
        flushConfig(ctx, logger.logDebug);
        sendGuiResponse(requestId, { ok: true, created });
        return;
      }
      if (action === "prepare_slot4_unlock") {
        if (!checks || typeof checks.prepareUnlockSlot4 !== "function") {
          throw new Error("Slot unlock service unavailable.");
        }
        const prepared = await checks.prepareUnlockSlot4({
          reason: "ui_slot4_unlock",
        });
        sendGuiResponse(requestId, { ok: true, prepared });
        return;
      }
      if (action === "reset_nft_cooldown") {
        if (!checks || typeof checks.resetCooldownNftFromUi !== "function") {
          throw new Error("NFT cooldown reset service unavailable.");
        }
        const reset = await checks.resetCooldownNftFromUi(message.payload || {});
        sendGuiResponse(requestId, { ok: true, reset });
        return;
      }
      if (action === "prepare_nft_cooldown_reset") {
        if (
          !checks ||
          typeof checks.prepareCooldownResetNftFromUi !== "function"
        ) {
          throw new Error("NFT cooldown reset service unavailable.");
        }
        const prepared = await checks.prepareCooldownResetNftFromUi(
          message.payload || {},
        );
        sendGuiResponse(requestId, { ok: true, prepared });
        return;
      }
      if (action === "update_runtime_config") {
        const payload = message.payload && typeof message.payload === "object"
          ? message.payload
          : {};
        if (typeof payload.nftCooldownResetEnabled === "boolean") {
          ctx.nftCooldownResetEnabled = payload.nftCooldownResetEnabled;
          ctx.config.nftCooldownResetEnabled = payload.nftCooldownResetEnabled;
        }
        if (payload.nftCooldownResetMaxPbp !== undefined) {
          const maxPbp = Number(payload.nftCooldownResetMaxPbp);
          if (Number.isFinite(maxPbp) && maxPbp >= 0) {
            ctx.config.nftCooldownResetMaxPbp = maxPbp;
          }
        }
        flushConfig(ctx, logger.logDebug);
        logger.logWithTimestamp(
          `[CONFIG] Auto NFT cooldown resets ${ctx.nftCooldownResetEnabled ? "enabled" : "disabled"} (max ${Number(ctx.config.nftCooldownResetMaxPbp ?? 20)} PBP).`,
        );
        sendGuiResponse(requestId, {
          ok: true,
          config: {
            nftCooldownResetEnabled: ctx.nftCooldownResetEnabled,
            nftCooldownResetMaxPbp: ctx.config.nftCooldownResetMaxPbp,
          },
        });
        return;
      }
      sendGuiResponse(requestId, {
        ok: false,
        error: `Unknown request action: ${action}`,
      });
    } catch (error) {
      sendGuiResponse(requestId, { ok: false, error: error.message });
    }
  });

  // Mirror the same moments the CLI header updates: whenever we log or redraw,
  // emit a deduped state snapshot for the desktop renderer.
  if (logger && typeof logger.logWithTimestamp === "function") {
    const original = logger.logWithTimestamp;
    logger.logWithTimestamp = (...args) => {
      const result = original(...args);
      sendGuiEvent("tick", { reason: "log" });
      emitGuiStateSoon();
      return result;
    };
  }
  if (logger && typeof logger.redrawHeaderAndLog === "function") {
    const original = logger.redrawHeaderAndLog;
    logger.redrawHeaderAndLog = (...args) => {
      const result = original(...args);
      sendGuiEvent("tick", { reason: "redraw" });
      emitGuiStateSoon();
      return result;
    };
  }

  // Signer actions
  wrapAsyncMethod(signer, "unlock");
  wrapSyncMethod(signer, "lock");
  wrapSyncMethod(signer, "setSignerMode");
  wrapAsyncMethod(signer, "createGeneratedWallet");
  wrapAsyncMethod(signer, "importFromText");
  wrapAsyncMethod(signer, "replaceImportFromFile");
  wrapAsyncMethod(signer, "removeImportedWallet");

  // Auth / checks / stats
  wrapAsyncMethod(mcp, "runLoginFlow");
  wrapAsyncMethod(checks, "runInitialChecks");
  wrapAsyncMethod(checks, "refreshFundingWalletSummary");

  // Watcher loop / state changes
  wrapAsyncMethod(watch, "startWatchLoop");
  wrapAsyncMethod(watch, "stopWatchLoop");
  wrapAsyncMethod(watch, "runWatchCycle");
  wrapAsyncMethod(watch, "runManualProcess");
  wrapAsyncMethod(watch, "runManualResetCheck");
}

async function runWithProgressPulse(
  task,
  ctx,
  { floor = 0, ceiling = 95, step = 1 } = {},
) {
  let timer = null;
  try {
    timer = setInterval(() => {
      const current = Number(ctx.startupFxProgress || 0);
      const next = Math.min(ceiling, Math.max(floor, current + step));
      if (next > current) ctx.startupFxProgress = next;
    }, STARTUP_PROGRESS_PULSE_MS);
    return await task();
  } finally {
    if (timer) clearInterval(timer);
  }
}

async function runStartupSequence() {
  ctx.isIdle = false;
  logger.redrawHeaderAndLog(ctx.currentMissionStats);

  logger.logWithTimestamp("[STARTUP] Booting MCP base app...");
  ctx.startupFxProgress = 5;

  loadConfig(ctx, logger.logWithTimestamp);
  signer.updateSignerState();
  emitGuiState();
  ctx.currentMissionStats.totalClaimed = Number(ctx.config.totalClaimed || 0);
  ctx.startupFxProgress = 20;
  const stopFx = startStartupFx(ctx, {
    enabled: STARTUP_FX_ENABLED && !ctx.debugMode,
    frameMs: STARTUP_FX_FRAME_MS,
    getTargetLines: () => logger.getScreenLines(ctx.currentMissionStats),
  });
  let shouldStartWatch = false;

  try {
    logger.logDebug("startup", "config_loaded", {
      debugMode: ctx.debugMode,
      interactiveAuth: ctx.interactiveAuth,
      watchLoopEnabled: ctx.watchLoopEnabled,
      totalClaimed: ctx.config.totalClaimed,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
    });
    signer.logModeSelected("startup");

    let loginOk = false;

    if (ctx.debugMode) {
      logger.logWithTimestamp(
        "[STARTUP] Debug mode: running interactive login (URL mode)...",
      );
      ctx.startupFxProgress = 35;
      loginOk = await runWithProgressPulse(
        () => mcp.runLoginFlow({ forceInteractive: true }),
        ctx,
        { floor: 35, ceiling: 54, step: 1 },
      );
      if (loginOk) ctx.startupFxProgress = 55;
    } else if (ctx.interactiveAuth) {
      logger.logWithTimestamp("[STARTUP] Running required login...");
      ctx.startupFxProgress = 35;
      loginOk = await runWithProgressPulse(() => mcp.runLoginFlow(), ctx, {
        floor: 35,
        ceiling: 54,
        step: 1,
      });
      if (loginOk) ctx.startupFxProgress = 55;
    }

    if (!ctx.interactiveAuth && !ctx.debugMode) {
      const hasToken = Boolean(mcp.bearerToken());
      logger.logDebug("startup", "token_mode", { hasToken });
      if (!hasToken) {
        logger.logWithTimestamp("[STARTUP] Missing token: running login...");
        ctx.startupFxProgress = 35;
        loginOk = await runWithProgressPulse(
          () => mcp.runLoginFlow({ forceInteractive: true }),
          ctx,
          { floor: 35, ceiling: 54, step: 1 },
        );
        if (loginOk) ctx.startupFxProgress = 55;
      }
    }

    ctx.startupFxProgress = 70;
    await runWithProgressPulse(() => checks.runInitialChecks(), ctx, {
      floor: 70,
      ceiling: 97,
      step: 1,
    });
    ctx.startupFxProgress = 88;

    if (!ctx.isAuthenticated) {
      logger.logWithTimestamp("[STARTUP] Auth unavailable.");
      logger.logWithTimestamp(
        "[STARTUP] Attempting interactive login fallback...",
      );
      ctx.startupFxProgress = 90;
      const fallbackOk = await runWithProgressPulse(
        () => mcp.runLoginFlow({ forceInteractive: true }),
        ctx,
        { floor: 90, ceiling: 96, step: 1 },
      );
      if (fallbackOk) {
        ctx.startupFxProgress = 94;
        await runWithProgressPulse(() => checks.runInitialChecks(), ctx, {
          floor: 94,
          ceiling: 98,
          step: 1,
        });
        ctx.startupFxProgress = 98;
      }
    }
    ctx.isIdle = true;
    ctx.currentMode = ctx.missionModeEnabled
      ? `mission-${ctx.currentMissionResetLevel}`
      : "normal";
    logger.logWithTimestamp("[READY] Startup complete.");
    ctx.startupComplete = true;
    ctx.startupFxProgress = 100;

    if (ctx.isAuthenticated) {
      if (ctx.watchLoopEnabled) {
        logger.logWithTimestamp("[READY] Watcher running.");
        shouldStartWatch = true;
      } else {
        logger.logWithTimestamp("[READY] Ready. Click Start Missions to begin.");
      }
    } else {
      logger.logWithTimestamp("[READY] Type 'login' then 'check'.");
    }
  } finally {
    await stopFx({ transitionMs: 220, fullyVisibleMs: 120, finalRampMs: 220 });
    logger.redrawHeaderAndLog(ctx.currentMissionStats);
  }

  if (shouldStartWatch) {
    await watch.startWatchLoop();
  }
}

async function main() {
  commands.setupCommandHandler();
  logger.redrawHeaderAndLog(ctx.currentMissionStats);
  await runStartupSequence();
  await commands.maybeRunFirstTimeSignerSetup();
}

process.on("SIGINT", () => {
  ctx.watchLoopEnabled = false;
  signer.shutdown();
  flushConfig(ctx, logger.logDebug);
  logger.logWithTimestamp("[INFO] Caught SIGINT, exiting...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  ctx.watchLoopEnabled = false;
  signer.shutdown();
  flushConfig(ctx, logger.logDebug);
  process.exit(0);
});

main().catch((err) => {
  signer.shutdown();
  logger.logWithTimestamp(
    `[ERROR] Fatal startup error: ${err?.message || err}`,
  );
  logger.logDebug("startup", "fatal", {
    error: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});
