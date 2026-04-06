"use strict";

const readline = require("readline");

function createCommandHandler(ctx, logger, actions, configApi) {
  const { logWithTimestamp, clearLogBuffer } = logger;
  const { runLoginFlow, runInitialChecks, startWatchLoop, runManualProcess, stopWatchLoop } = actions;
  const { saveConfig } = configApi;

  function showHelp() {
    logWithTimestamp(
      "[HELP] h/help, clear, status, login, check, c, 20r [on|off], mm [off|on|<level>], pause, resume, q",
    );
    logWithTimestamp(
      `[HELP] auth mode: ${ctx.interactiveAuth ? "interactive headless URL" : "token-only"}`,
    );
  }

  function showStatus() {
    logWithTimestamp(
      `[INFO] idle=${ctx.isIdle} auth=${ctx.isAuthenticated} debug=${ctx.debugMode} interactiveAuth=${ctx.interactiveAuth} watch=${ctx.watchLoopEnabled}`,
    );
  }

  function setupCommandHandler() {
    let manualOverrideInFlight = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const handlers = {
      clear: async () => {
        clearLogBuffer();
        logWithTimestamp("[INFO] Log buffer cleared.");
      },
      h: async () => showHelp(),
      help: async () => showHelp(),
      login: async () => {
        if (
          await runLoginFlow({ forceInteractive: true })
        ) {
          await runInitialChecks();
          void startWatchLoop();
        }
      },
      check: async () => {
        await runInitialChecks();
      },
      c: async () => {
        if (manualOverrideInFlight) {
          logWithTimestamp("[WATCH] ℹ️ Manual override already running; ignoring duplicate 'c'.");
          return;
        }
        if (!ctx.isAuthenticated) {
          logWithTimestamp("[WATCH] ❌ Not authenticated. Run 'login' or 'check' first.");
          return;
        }
        manualOverrideInFlight = true;
        if (ctx.watcherRunning) {
          try {
            logWithTimestamp("[WATCH] ⏸️ Manual override: pausing watcher and forcing cycle now...");
            await stopWatchLoop({ persist: false, waitForCycle: false });
            const { claimed, assigned } = await runManualProcess({ waitForCycle: false });
            logWithTimestamp(`[WATCH] ✅ Manual process complete: claimed=${claimed} assigned=${assigned}.`);
          } catch (error) {
            logWithTimestamp(`[WATCH] ❌ Manual process failed: ${error.message}`);
          } finally {
            ctx.watchLoopEnabled = true;
            manualOverrideInFlight = false;
            logWithTimestamp("[WATCH] ▶️ Resuming watcher after manual override...");
            void startWatchLoop();
          }
          return;
        }
        try {
          const { claimed, assigned } = await runManualProcess();
          logWithTimestamp(`[WATCH] ✅ Manual process complete: claimed=${claimed} assigned=${assigned}.`);
        } catch (error) {
          logWithTimestamp(`[WATCH] ❌ Manual process failed: ${error.message}`);
        } finally {
          manualOverrideInFlight = false;
        }
      },
      pause: async () => {
        ctx.watchLoopEnabled = false;
        ctx.config.watchLoopEnabled = false;
        saveConfig(ctx, logger.logDebug);
        logWithTimestamp("[WATCH] ⏸️ Paused.");
      },
      resume: async () => {
        ctx.watchLoopEnabled = true;
        ctx.config.watchLoopEnabled = true;
        saveConfig(ctx, logger.logDebug);
        logWithTimestamp("[WATCH] ▶️ Resumed.");
        void startWatchLoop();
      },
      status: async () => showStatus(),
      q: async () => {
        logWithTimestamp("[KILL -9] 🦒 Korea loves you! Goodbye! 👋");
        process.exit(0);
      },
      quit: async () => {
        logWithTimestamp("[KILL -9] 🦒 Korea loves you! Goodbye! 👋");
        process.exit(0);
      },
    };

    rl.on("line", async (input) => {
      const raw = String(input || "").trim();
      const cmd = raw.toLowerCase();
      process.stdout.write("\x1b[2K\r");
      if (!cmd) return;
      if (cmd === "xc" || cmd === "claim" || /^c+$/.test(cmd)) {
        await handlers.c();
        return;
      }
      if (cmd === "20r" || cmd.startsWith("20r ")) {
        const arg = cmd.slice(3).trim();
        if (!arg) {
          ctx.level20ResetEnabled = !ctx.level20ResetEnabled;
        } else if (arg === "on") {
          ctx.level20ResetEnabled = true;
        } else if (arg === "off") {
          ctx.level20ResetEnabled = false;
        } else {
          logWithTimestamp("Usage: 20r [on|off]");
          return;
        }
        if (ctx.level20ResetEnabled) {
          ctx.missionModeEnabled = false;
        }
        ctx.config.level20ResetEnabled = ctx.level20ResetEnabled;
        ctx.config.missionModeEnabled = ctx.missionModeEnabled;
        saveConfig(ctx, logger.logDebug);
        logWithTimestamp(
          `[MODE] 20r ${ctx.level20ResetEnabled ? "ON" : "OFF"} (level20ResetEnabled=${ctx.level20ResetEnabled})`,
        );
        return;
      }
      if (cmd === "mm" || cmd.startsWith("mm ")) {
        const arg = cmd.slice(2).trim();
        if (!arg || arg === "on") {
          ctx.missionModeEnabled = true;
        } else if (arg === "off") {
          ctx.missionModeEnabled = false;
        } else {
          const n = Number(arg);
          if (!Number.isFinite(n) || n <= 0) {
            logWithTimestamp("Usage: mm [off|on|<level>]");
            return;
          }
          ctx.currentMissionResetLevel = String(Math.floor(n));
          ctx.missionModeEnabled = true;
        }
        if (ctx.missionModeEnabled) {
          ctx.level20ResetEnabled = false;
        }
        ctx.config.missionModeEnabled = ctx.missionModeEnabled;
        ctx.config.missionResetLevel = String(ctx.currentMissionResetLevel || "11");
        ctx.config.level20ResetEnabled = ctx.level20ResetEnabled;
        saveConfig(ctx, logger.logDebug);
        logWithTimestamp(
          `[MODE] mm ${ctx.missionModeEnabled ? "ON" : "OFF"} level=${ctx.currentMissionResetLevel} (missionModeEnabled=${ctx.missionModeEnabled})`,
        );
        return;
      }
      const handler = handlers[cmd];
      if (handler) {
        await handler();
        return;
      }
      logWithTimestamp(`Unknown command: ${cmd}. Type 'help'.`);
    });
  }

  return {
    setupCommandHandler,
    showHelp,
    showStatus,
  };
}

module.exports = {
  createCommandHandler,
};
