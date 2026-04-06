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
const { createMcpClient } = require("./src/mcp/client");
const { createChecksService } = require("./src/services/checks");
const { createWatchService } = require("./src/services/watch");
const { createCommandHandler } = require("./src/commands");
const { startStartupFx } = require("./src/ui/startup-fx");

const ctx = createContext();
const logger = createLogger(ctx);
const mcp = createMcpClient(ctx, logger);
const checks = createChecksService(ctx, logger, mcp);
const watch = createWatchService(ctx, logger, mcp, checks, { saveConfig });
const commands = createCommandHandler(
  ctx,
  logger,
  {
    runLoginFlow: mcp.runLoginFlow,
    runInitialChecks: checks.runInitialChecks,
    startWatchLoop: watch.startWatchLoop,
    runWatchCycle: watch.runWatchCycle,
    runManualProcess: watch.runManualProcess,
    stopWatchLoop: watch.stopWatchLoop,
  },
  { saveConfig },
);

const STARTUP_FX_ENABLED = true;
const STARTUP_FX_FRAME_MS = 95;
const STARTUP_PROGRESS_PULSE_MS = 220;

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
    });

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
        logger.logWithTimestamp(
          "[READY] Watcher is disabled (`watchLoopEnabled=false`).",
        );
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
}

process.on("SIGINT", () => {
  ctx.watchLoopEnabled = false;
  flushConfig(ctx, logger.logDebug);
  logger.logWithTimestamp("[INFO] Caught SIGINT, exiting...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  ctx.watchLoopEnabled = false;
  flushConfig(ctx, logger.logDebug);
  process.exit(0);
});

main().catch((err) => {
  logger.logWithTimestamp(
    `[ERROR] Fatal startup error: ${err?.message || err}`,
  );
  logger.logDebug("startup", "fatal", {
    error: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});
