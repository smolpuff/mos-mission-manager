"use strict";

const fs = require("fs");
const readline = require("readline");
const { createManualApprovalService } = require("./manual-approval");

function createCommandHandler(ctx, logger, actions, configApi, services = {}) {
  const { logWithTimestamp, clearLogBuffer } = logger;
  const {
    runLoginFlow,
    runInitialChecks,
    startWatchLoop,
    runManualProcess,
    runManualResetCheck,
    stopWatchLoop,
    refreshFundingWalletSummary,
  } = actions;
  const { saveConfig, flushConfig } = configApi;
  const { signer = null } = services;

  async function quitWholeApp({ reason = "user" } = {}) {
    logWithTimestamp("[KILL -9] 🦒 Korea loves you! Goodbye! 👋");
    try {
      ctx.watchLoopEnabled = false;
      ctx.config.watchLoopEnabled = false;
      flushConfig(ctx, logger.logDebug);
    } catch {}
    try {
      if (typeof stopWatchLoop === "function") {
        await stopWatchLoop({ persist: false, waitForCycle: false });
      }
    } catch {}

    // In the desktop app, the CLI is controlling a forked backend. Exiting the
    // backend alone isn't enough; ask the Electron host to quit too.
    try {
      if (ctx.guiBridge?.sendEvent) {
        ctx.guiBridge.sendEvent("app_quit", { reason });
        return;
      }
    } catch {}

    process.exit(0);
  }

  function showHelp() {
    logWithTimestamp(
      "[HELP] h/help, clear, status, login, check, c, r, reset20, 20r [on|off], mm [off|on|<level>], pause, resume, q",
    );
    logWithTimestamp(
      "[HELP] signer [status|setup|create|reveal|app_wallet|manual|dapp|import [path-or-key]|remove|unlock|lock]",
    );
    logWithTimestamp(
      `[HELP] auth mode: ${ctx.interactiveAuth ? "interactive headless URL" : "token-only"}`,
    );
  }

  function showStatus() {
    logWithTimestamp(
      `[INFO] idle=${ctx.isIdle} auth=${ctx.isAuthenticated} debug=${ctx.debugMode} interactiveAuth=${ctx.interactiveAuth} watch=${ctx.watchLoopEnabled}`,
    );
    if (signer) {
      logWithTimestamp(`[INFO] signer ${signer.modeSummary()}`);
    }
  }

  let firstTimeSetupRunner = async () => {};

  async function refreshFundingWalletHeader() {
    if (typeof refreshFundingWalletSummary !== "function") return;
    try {
      await refreshFundingWalletSummary();
    } catch {}
  }

  function setupCommandHandler() {
    let manualOverrideInFlight = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !ctx.plainOutputMode,
    });
    const manualApproval = createManualApprovalService(logger);
    const { askQuestion, confirmYes, confirmSignerApproval } = manualApproval;

    if (typeof logger.setInputRenderer === "function") {
      logger.setInputRenderer(() => {
        if (!rl.terminal) return;
        const prompt = rl.getPrompt ? rl.getPrompt() : "";
        const currentLine = typeof rl.line === "string" ? rl.line : "";
        process.stdout.write(`${prompt}${currentLine}`);
        readline.cursorTo(process.stdout, (prompt || "").length + currentLine.length);
      });
    }

    if (signer && typeof signer.setManualApprovalHandler === "function") {
      signer.setManualApprovalHandler((payload) =>
        confirmSignerApproval(rl, payload),
      );
    }

    async function runAppWalletOnboardingPrompt() {
      if (!signer || ctx.signerConfig?.walletRef) return;
      logWithTimestamp(
        "[SIGNER] No app_wallet is set up yet. Default is to create a new burner funding wallet.",
      );
      const action = (
        await askQuestion(
          rl,
          "Type create / import / skip (press enter for create): ",
        )
      )
        .trim()
        .toLowerCase();
      if (!action || action === "create") {
        await runSignerCreatePrompt();
        return;
      }
      if (action === "skip") {
        logWithTimestamp("[SIGNER] Setup skipped.");
        return;
      }
      if (action === "import") {
        await runSignerImportPrompt();
        return;
      }
      logWithTimestamp("[SIGNER] Invalid choice. Use create, import, or skip.");
    }

    async function runSignerCreatePrompt() {
      const riskOk = await confirmYes(
        rl,
        "Create a new burner app wallet now? yes/no ",
      );
      if (!riskOk) {
        logWithTimestamp("[SIGNER] Wallet creation cancelled.");
        return;
      }
      const replaceOk =
        !ctx.signerConfig?.walletRef ||
        (await confirmYes(
          rl,
          "Replace the existing imported signer vault if one exists? yes/no ",
        ));
      if (!replaceOk) {
        logWithTimestamp("[SIGNER] Wallet creation cancelled.");
        return;
      }
      try {
        signer.setSignerMode("app_wallet", "create");
        const created = await signer.createGeneratedWallet();
        flushConfig(ctx, logger.logDebug);
        await refreshFundingWalletHeader();
        logWithTimestamp(`[SIGNER] Address: ${created.walletAddress}`);
        logWithTimestamp(`[SIGNER] Recovery phrase: ${created.mnemonic}`);
        logWithTimestamp(
          "[SIGNER] Save that recovery phrase securely. You can show it again later with 'signer reveal'.",
        );
      } catch (error) {
        logWithTimestamp(`[SIGNER] ❌ Wallet creation failed: ${error.message}`);
      }
    }

    async function runSignerImportPrompt() {
      const riskOk = await confirmYes(
        rl,
        "app_wallet mode is for a dedicated burner wallet only. Continue with key import? yes/no ",
      );
      if (!riskOk) {
        logWithTimestamp("[SIGNER] Import cancelled.");
        return;
      }
      const replaceOk =
        !ctx.signerConfig?.walletRef ||
        (await confirmYes(
          rl,
          "Replace the existing imported signer vault if one exists? yes/no ",
        ));
      if (!replaceOk) {
        logWithTimestamp("[SIGNER] Import cancelled.");
        return;
      }
      const pasted = await askQuestion(
        rl,
        "Paste your private key, recovery phrase, keypair text, or key array, then press enter: ",
      );
      if (!pasted) {
        logWithTimestamp("[SIGNER] Import cancelled.");
        return;
      }
      try {
        signer.setSignerMode("app_wallet", "import");
        await signer.importFromText(pasted);
        flushConfig(ctx, logger.logDebug);
        await refreshFundingWalletHeader();
      } catch (error) {
        logWithTimestamp(`[SIGNER] ❌ Import failed: ${error.message}`);
      }
    }
    async function runFirstTimeSignerSetup({ force = false } = {}) {
      if (!force && ctx.config.signerSetupCompleted === true) return;
      logWithTimestamp(
        "[SIGNER] First run setup: choose app_wallet, manual, or dapp.",
      );
      const choice = (
        await askQuestion(
          rl,
          "Select mode: app_wallet / manual / dapp (press enter for app_wallet): ",
        )
      )
        .trim()
        .toLowerCase();
      const selected = choice || "app_wallet";
      if (!["app_wallet", "manual", "dapp"].includes(selected)) {
        logWithTimestamp(
          "[SIGNER] Invalid mode. Use app_wallet, manual, or dapp.",
        );
        return;
      }
      signer.setSignerMode(selected, "first_run");
      ctx.config.signerMode = ctx.signerMode;
      ctx.config.signerSetupCompleted = true;
      flushConfig(ctx, logger.logDebug);
      await refreshFundingWalletHeader();
      if (selected === "app_wallet" && !ctx.signerConfig?.walletRef) {
        await runAppWalletOnboardingPrompt();
        return;
      }
      if (selected === "manual") {
        logWithTimestamp(
          "[SIGNER] Manual mode selected. When a tx/reset needs approval, the missions page will open for you to handle it yourself.",
        );
        return;
      }
      if (selected === "dapp") {
        logWithTimestamp(
          "[SIGNER] dapp mode selected. Browser approval flow is planned but not wired yet.",
        );
      }
    }
    firstTimeSetupRunner = runFirstTimeSignerSetup;

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
            logWithTimestamp("[WATCH] ⏸️ Manual override: pausing watcher and waiting for current cycle...");
            await stopWatchLoop({ persist: false, waitForCycle: true });
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
      r: async () => {
        if (!ctx.isAuthenticated) {
          logWithTimestamp("[RESET] ❌ Not authenticated. Run 'login' or 'check' first.");
          return;
        }
        try {
          const { triggered } = await runManualResetCheck();
          logWithTimestamp(
            triggered
              ? "[RESET] ✅ Manual reset check completed."
              : "[RESET] ℹ️ Manual reset check found nothing to do.",
          );
        } catch (error) {
          logWithTimestamp(`[RESET] ❌ Manual reset check failed: ${error.message}`);
        }
      },
      reset20: async () => {
        if (!ctx.isAuthenticated) {
          logWithTimestamp("[RESET] ❌ Not authenticated. Run 'login' or 'check' first.");
          return;
        }
        const previousLevel20 = ctx.level20ResetEnabled;
        const previousMissionMode = ctx.missionModeEnabled;
        try {
          ctx.level20ResetEnabled = true;
          ctx.missionModeEnabled = false;
          ctx.config.level20ResetEnabled = true;
          ctx.config.missionModeEnabled = false;
          flushConfig(ctx, logger.logDebug);
          const { triggered } = await runManualResetCheck();
          logWithTimestamp(
            triggered
              ? "[RESET] ✅ reset20 check completed."
              : "[RESET] ℹ️ reset20 found nothing to do.",
          );
        } catch (error) {
          logWithTimestamp(`[RESET] ❌ reset20 failed: ${error.message}`);
        } finally {
          ctx.level20ResetEnabled = previousLevel20;
          ctx.missionModeEnabled = previousMissionMode;
          ctx.config.level20ResetEnabled = previousLevel20;
          ctx.config.missionModeEnabled = previousMissionMode;
          flushConfig(ctx, logger.logDebug);
        }
      },
      pause: async () => {
        ctx.watchLoopEnabled = false;
        ctx.config.watchLoopEnabled = false;
        flushConfig(ctx, logger.logDebug);
        logWithTimestamp("[WATCH] ⏸️ Paused.");
      },
      resume: async () => {
        ctx.watchLoopEnabled = true;
        delete ctx.config.watchLoopEnabled;
        flushConfig(ctx, logger.logDebug);
        logWithTimestamp("[WATCH] ▶️ Resumed.");
        void startWatchLoop();
      },
      status: async () => showStatus(),
      signer: async (raw) => {
        if (!signer) {
          logWithTimestamp("[SIGNER] ❌ Signer service unavailable.");
          return;
        }
        const parts = String(raw || "")
          .trim()
          .split(/\s+/);
        const arg = parts[1];
        if (!arg) {
          logWithTimestamp(`[SIGNER] ${signer.modeSummary()}`);
          return;
        }
        if (arg === "status") {
          logWithTimestamp(`[SIGNER] ${signer.modeSummary()}`);
          return;
        }
        if (arg === "setup") {
          await runFirstTimeSignerSetup({ force: true });
          return;
        }
        if (arg === "create") {
          await runSignerCreatePrompt();
          return;
        }
        if (arg === "reveal") {
          const ok = await confirmYes(
            rl,
            "Reveal the app wallet recovery details in this terminal? yes/no ",
          );
          if (!ok) {
            logWithTimestamp("[SIGNER] Reveal cancelled.");
            return;
          }
          try {
            const backup = await signer.revealWalletBackup();
            logWithTimestamp(`[SIGNER] Address: ${backup.walletAddress || "unknown"}`);
            if (backup.derivationPath) {
              logWithTimestamp(
                `[SIGNER] Derivation path: ${backup.derivationPath}`,
              );
            }
            if (backup.mnemonic) {
              logWithTimestamp(`[SIGNER] Recovery phrase: ${backup.mnemonic}`);
            } else {
              logWithTimestamp(
                "[SIGNER] Recovery phrase backup is not available for this wallet.",
              );
            }
          } catch (error) {
            logWithTimestamp(`[SIGNER] ❌ Reveal failed: ${error.message}`);
          }
          return;
        }
        if (arg === "remove") {
          const ok = await confirmYes(
            rl,
            "Remove the imported app wallet vault and OS-stored vault key? yes/no ",
          );
          if (!ok) {
            logWithTimestamp("[SIGNER] Remove cancelled.");
            return;
          }
          try {
            await signer.removeImportedWallet();
            flushConfig(ctx, logger.logDebug);
          } catch (error) {
            logWithTimestamp(`[SIGNER] ❌ Remove failed: ${error.message}`);
          }
          return;
        }
        if (arg === "import") {
          const importValue = parts.slice(2).join(" ").trim();
          if (!importValue) {
            await runSignerImportPrompt();
            return;
          }
          const importPath = importValue && fs.existsSync(importValue) ? importValue : null;
          if (!importPath) {
            try {
              signer.setSignerMode("app_wallet", "import");
              await signer.importFromText(importValue);
              flushConfig(ctx, logger.logDebug);
              await refreshFundingWalletHeader();
            } catch (error) {
              logWithTimestamp(`[SIGNER] ❌ Import failed: ${error.message}`);
            }
            return;
          }
          const riskOk = await confirmYes(
            rl,
            "app_wallet mode is for a dedicated burner wallet only. Continue with file import? yes/no ",
          );
          if (!riskOk) {
            logWithTimestamp("[SIGNER] Import cancelled.");
            return;
          }
          const replaceOk =
            !ctx.signerConfig?.walletRef ||
            (await confirmYes(
              rl,
              "Replace the existing imported signer vault if one exists? yes/no ",
            ));
          if (!replaceOk) {
            logWithTimestamp("[SIGNER] Import cancelled.");
            return;
          }
          try {
            signer.setSignerMode("app_wallet", "import");
            await signer.replaceImportFromFile(importPath);
            flushConfig(ctx, logger.logDebug);
            await refreshFundingWalletHeader();
          } catch (error) {
            logWithTimestamp(`[SIGNER] ❌ Import failed: ${error.message}`);
          }
          return;
        }
        if (arg === "unlock") {
          try {
            await signer.unlock();
          } catch (error) {
            logWithTimestamp(`[SIGNER] ❌ Unlock failed: ${error.message}`);
          }
          return;
        }
        if (arg === "lock") {
          signer.lock("console");
          return;
        }
        if (
          arg !== "create" &&
          arg !== "reveal" &&
          arg !== "app_wallet" &&
          arg !== "manual" &&
          arg !== "dapp"
        ) {
          logWithTimestamp(
            "[SIGNER] ❌ Usage: signer [status|setup|create|reveal|app_wallet|manual|dapp|import [path-or-key]|remove|unlock|lock]",
          );
          return;
        }
        signer.setSignerMode(arg, "console");
        flushConfig(ctx, logger.logDebug);
        await refreshFundingWalletHeader();
        if (arg === "app_wallet" && !ctx.signerConfig?.walletRef) {
          await runAppWalletOnboardingPrompt();
        }
      },
      q: async () => {
        await quitWholeApp({ reason: "q" });
      },
      quit: async () => {
        await quitWholeApp({ reason: "quit" });
      },
      exit: async () => {
        await quitWholeApp({ reason: "exit" });
      },
    };

    rl.on("line", async (input) => {
      const raw = String(input || "").trim();
      const cmd = raw.toLowerCase();
      if (!ctx.plainOutputMode) {
        process.stdout.write("\x1b[2K\r");
      }
      if (!cmd) return;
      if (cmd === "xc" || cmd === "claim" || /^c+$/.test(cmd)) {
        await handlers.c();
        return;
      }
      if (cmd === "r") {
        await handlers.r();
        return;
      }
      if (cmd === "reset20") {
        await handlers.reset20();
        return;
      }
      if (cmd === "exit") {
        await handlers.exit();
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
        ctx.currentMode = ctx.missionModeEnabled
          ? `mission-${ctx.currentMissionResetLevel}`
          : "normal";
        flushConfig(ctx, logger.logDebug);
        logWithTimestamp(
          `[MODE] Mission level resets ${ctx.level20ResetEnabled ? "enabled" : "disabled"}.`,
        );
        logWithTimestamp(
          ctx.level20ResetEnabled
            ? `[MODE] Normal mode enabled (mission resets at level 20).`
            : `[MODE] Normal mode disabled.`,
        );
        return;
      }
      if (cmd === "mm" || cmd.startsWith("mm ")) {
        const arg = cmd.slice(2).trim();
        if (!arg) {
          ctx.missionModeEnabled = !ctx.missionModeEnabled;
        } else if (arg === "on") {
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
        ctx.currentMode = ctx.missionModeEnabled
          ? `mission-${ctx.currentMissionResetLevel}`
          : "normal";
        flushConfig(ctx, logger.logDebug);
        logWithTimestamp(
          ctx.missionModeEnabled
            ? `[MODE] Mission mode enabled (mission resets at level ${ctx.currentMissionResetLevel}).`
            : `[MODE] Mission mode disabled.`,
        );
        return;
      }
      const handler = handlers[cmd];
      if (handler) {
        await handler();
        return;
      }
      if (cmd === "signer" || cmd.startsWith("signer ")) {
        await handlers.signer(raw);
        return;
      }
      logWithTimestamp(`Unknown command: ${cmd}. Type 'help'.`);
    });
  }

  return {
    setupCommandHandler,
    maybeRunFirstTimeSignerSetup: async () => firstTimeSetupRunner(),
    showHelp,
    showStatus,
  };
}

module.exports = {
  createCommandHandler,
};

