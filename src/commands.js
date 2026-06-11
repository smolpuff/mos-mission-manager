"use strict";

const fs = require("fs");
const readline = require("readline");
const { createManualApprovalService } = require("./manual-approval");
const {
  NORMAL_DEFAULTS,
  DEV_DEFAULTS,
  applyRuntimeDefaults,
} = require("./runtime-defaults");

function createCommandHandler(ctx, logger, actions, configApi, services = {}) {
  const { logWithTimestamp, clearLogBuffer } = logger;
  const {
    runLoginFlow,
    logout,
    runInitialChecks,
    startWatchLoop,
    runManualProcess,
    runManualResetCheck,
    stopWatchLoop,
    refreshFundingWalletSummary,
  } = actions;
  const { saveConfig, flushConfig } = configApi;
  const { signer = null } = services;

  function looksLikeSignerImportValue(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 12 || words.length === 24) return true;
    if (/^\s*\[.*\]\s*$/.test(text)) return true;
    if (text.includes(",") && text.split(",").length >= 8) return true;
    if (/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(text)) return true;
    return false;
  }

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
      "[HELP] h/help, clear, status, i, login, logout, check, c, r, reset20, 20r [on|off], mm [off|on|<level>], debug [on|off], pause, resume, q",
    );
    logWithTimestamp(
      "[HELP] signer [status|doctor|setup|create|reveal|app_wallet|manual|dapp|import [path-or-key]|remove|unlock|lock]",
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

  function pushDisplayLines(lines = []) {
    const list = Array.isArray(lines)
      ? lines.map((line) => String(line ?? ""))
      : [String(lines ?? "")];
    if (list.length === 0) return;
    const maxSize = ctx.debugMode ? ctx.LOG_BUFFER_SIZE_DEBUG : ctx.LOG_BUFFER_SIZE;
    for (const line of list) {
      ctx.logBuffer.push(line);
    }
    while (ctx.logBuffer.length > maxSize) ctx.logBuffer.shift();
    if (ctx.plainOutputMode) {
      for (const line of list) {
        process.stdout.write(`${line}\n`);
      }
      return;
    }
    if (ctx.startupFxActive) return;
    if (typeof logger.redrawHeaderAndLog === "function") {
      logger.redrawHeaderAndLog(ctx.currentMissionStats);
    }
  }

  function makeColor(enabled, code, text) {
    return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  function showToggleSettings() {
    const configuredMissionResetLevel = String(
      ctx.currentMissionResetLevel ||
        ctx.config?.missionResetLevel ||
        ctx.runtimeDefaults?.missionResetLevel ||
        "11",
    );
    const nftResetMaxPbp = Number(ctx.config?.nftCooldownResetMaxPbp);
    const normalizedNftResetMaxPbp =
      Number.isFinite(nftResetMaxPbp) && nftResetMaxPbp >= 0
        ? nftResetMaxPbp
        : 20;
    const useColor = !ctx.plainOutputMode && process.stdout.isTTY === true;
    const onOff = (enabled) =>
      enabled
        ? makeColor(useColor, "32;1", "ON")
        : makeColor(useColor, "31;1", "OFF");
    const value = (text) => makeColor(useColor, "36;1", String(text));
    const title = makeColor(useColor, "33;1", "TOGGLES");
    const stripAnsi = (text) =>
      String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
    const padRight = (text, width) => {
      const raw = String(text || "");
      const visibleWidth = stripAnsi(raw).length;
      return raw + " ".repeat(Math.max(0, width - visibleWidth));
    };
    const toggleRow = (leftLabel, leftValue, rightLabel, rightValue) =>
      `│ ${padRight(leftLabel, 18)} ${padRight(leftValue, 8)} ${padRight(rightLabel, 16)} ${rightValue}`;
    pushDisplayLines([
      `┌─ ${title} ${"─".repeat(44)}`,
      toggleRow(
        "Mode",
        value(ctx.missionModeEnabled ? "MISSION" : "NORMAL"),
        "Reset level",
        value(configuredMissionResetLevel),
      ),
      toggleRow(
        "Level 20 reset",
        onOff(ctx.level20ResetEnabled),
        "Per-slot reset",
        onOff(ctx.missionResetPerSlotModeEnabled),
      ),
      toggleRow(
        "NFT reset",
        onOff(ctx.nftCooldownResetEnabled),
        "Max cost",
        value(`${normalizedNftResetMaxPbp} PBP`),
      ),
      toggleRow(
        "Rentals",
        onOff(ctx.config?.enableRentals === true),
        "Fast refresh",
        onOff(ctx.config?.rentalFastRefreshEnabled === true),
      ),
      toggleRow(
        "Debug",
        onOff(ctx.debugMode),
        "Watch loop",
        onOff(ctx.watchLoopEnabled),
      ),
      `└${"─".repeat(57)}`,
    ]);
  }

  async function startWatchLoopWithDelay({ reason = "start" } = {}) {
    if (ctx.watcherRunning || ctx.watchStartPending) return;
    ctx.watchStartPending = true;
    logWithTimestamp(`[WATCH] ▶ Starting now (${reason}).`);
    ctx.watchStartPending = false;
    void startWatchLoop();
  }

  let firstTimeSetupRunner = async () => {};

  async function refreshFundingWalletHeader() {
    if (typeof refreshFundingWalletSummary !== "function") return;
    try {
      await refreshFundingWalletSummary();
    } catch {}
  }

  function logDebugToggleSummary(enabled) {
    const defaults = ctx.runtimeDefaults || applyRuntimeDefaults(ctx);
    const baseline = NORMAL_DEFAULTS;
    const tuned = DEV_DEFAULTS;
    logWithTimestamp(
      `[DEBUG] Debug mode ${enabled ? "enabled" : "disabled"}.`,
    );
    logWithTimestamp(
      `[DEBUG] runtimeDefaults: missionResetLevel ${baseline.missionResetLevel} -> ${defaults.missionResetLevel}, rentalFastRefreshTickMs ${baseline.rentalFastRefreshTickMs} -> ${defaults.rentalFastRefreshTickMs}, rentalBatchLimit ${baseline.rentalBatchLimit} -> ${defaults.rentalBatchLimit}, watchMinCycleSeconds ${baseline.watchMinCycleSeconds} -> ${defaults.watchMinCycleSeconds}, watchDefaultPollSeconds ${baseline.watchDefaultPollSeconds} -> ${defaults.watchDefaultPollSeconds}`,
    );
    logWithTimestamp(
      `[DEBUG] watcher behavior: live mission polling=${enabled ? "enabled" : "disabled unless separately configured"}, verbose debug logs=${enabled ? "enabled" : "disabled"}, startup FX=${enabled ? "disabled" : "enabled"}`,
    );
    logWithTimestamp(
      `[DEBUG] auth behavior: startup interactive login=${enabled ? "enabled when token is missing" : "normal token-first flow"}, browser login prompts=${enabled ? "enabled" : "disabled unless interactiveAuth is enabled"}`,
    );
    logWithTimestamp(
      `[DEBUG] auto NFT cooldown reset gate: debug=${enabled}, missionMode=${ctx.missionModeEnabled === true || ctx.config?.missionModeEnabled === true}, nftCooldownResetEnabled=${ctx.nftCooldownResetEnabled === true || ctx.config?.nftCooldownResetEnabled === true}`,
    );
    logWithTimestamp(
      `[DEBUG] dev-equivalent defaults are now ${enabled ? "active" : "inactive"}; target dev values are missionResetLevel=${tuned.missionResetLevel}, rentalFastRefreshTickMs=${tuned.rentalFastRefreshTickMs}, rentalBatchLimit=${tuned.rentalBatchLimit}, watchMinCycleSeconds=${tuned.watchMinCycleSeconds}, watchDefaultPollSeconds=${tuned.watchDefaultPollSeconds}`,
    );
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

    async function confirmYesOrCaptureImportValue(prompt) {
      const answer = await askQuestion(rl, prompt);
      const normalized = String(answer || "").trim();
      const lowered = normalized.toLowerCase();
      if (lowered === "yes" || lowered === "y") {
        return { ok: true, capturedImportValue: null };
      }
      if (looksLikeSignerImportValue(normalized)) {
        logWithTimestamp(
          "[SIGNER] Detected signer import data pasted into a yes/no prompt. Continuing import flow.",
        );
        return { ok: true, capturedImportValue: normalized };
      }
      return { ok: false, capturedImportValue: null };
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
      const riskResult = await confirmYesOrCaptureImportValue(
        "app_wallet mode is for a dedicated burner wallet only. Continue with key import? This will replace the current imported app wallet if one exists. yes/no ",
      );
      if (!riskResult.ok) {
        logWithTimestamp("[SIGNER] Import cancelled.");
        return;
      }
      const replaceOk =
        !ctx.signerConfig?.walletRef ||
        (await confirmYes(
          rl,
          "Replace the existing imported signer vault + OS-stored vault key if one exists? yes/no ",
        ));
      if (!replaceOk) {
        logWithTimestamp("[SIGNER] Import cancelled.");
        return;
      }
      const pasted =
        riskResult.capturedImportValue ||
        (await askQuestion(
          rl,
          "Paste your private key, recovery phrase, keypair text, or key array, then press enter: ",
        ));
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
      const hasExistingSignerMode = ["app_wallet", "manual", "dapp"].includes(
        String(ctx.config.signerMode || ctx.signerMode || "").trim(),
      );
      const hasExistingAppWallet = Boolean(
        String(ctx.signerConfig?.walletRef || "").trim(),
      );
      const looksAlreadyConfigured =
        ctx.config.signerSetupCompleted === true ||
        hasExistingSignerMode ||
        hasExistingAppWallet;
      if (!force && looksAlreadyConfigured) {
        if (ctx.config.signerSetupCompleted !== true) {
          ctx.config.signerSetupCompleted = true;
          flushConfig(ctx, logger.logDebug);
        }
        return;
      }
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
          "[SIGNER] dapp mode selected. Prepared actions will open the bridge signing URL in your browser wallet.",
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
          await startWatchLoopWithDelay({ reason: "login" });
        }
      },
      logout: async () => {
        ctx.watchLoopEnabled = false;
        ctx.config.watchLoopEnabled = false;
        flushConfig(ctx, logger.logDebug);
        try {
          if (typeof stopWatchLoop === "function") {
            await stopWatchLoop({ persist: false, waitForCycle: true });
          }
        } catch {}
        if (typeof logout === "function") {
          logout();
        }
        logWithTimestamp("[AUTH] Logged out. Saved token cleared.");
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
        ctx.watchStartPending = false;
        if (
          ctx.activeClaimAbortController &&
          typeof ctx.activeClaimAbortController.abort === "function"
        ) {
          try {
            ctx.activeClaimAbortController.abort();
          } catch {}
        }
        ctx.config.watchLoopEnabled = false;
        flushConfig(ctx, logger.logDebug);
        if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        logWithTimestamp("[WATCH] ⏸️ Paused.");
      },
      resume: async () => {
        ctx.watchLoopEnabled = true;
        delete ctx.config.watchLoopEnabled;
        flushConfig(ctx, logger.logDebug);
        if (ctx.guiBridge?.emitNow) ctx.guiBridge.emitNow();
        logWithTimestamp("[WATCH] ▶️ Resumed.");
        await startWatchLoopWithDelay({ reason: "resume" });
      },
      status: async () => showStatus(),
      i: async () => showToggleSettings(),
      settings: async () => showToggleSettings(),
      toggles: async () => showToggleSettings(),
      debug: async (raw) => {
        const parts = String(raw || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const arg = String(parts[1] || "").trim().toLowerCase();
        if (!arg) {
          logWithTimestamp(
            `[DEBUG] Debug mode is ${ctx.debugMode ? "enabled" : "disabled"}.`,
          );
          return;
        }
        if (arg !== "on" && arg !== "off") {
          logWithTimestamp("Usage: debug [on|off]");
          return;
        }
        const nextDebugMode = arg === "on";
        ctx.debugMode = nextDebugMode;
        ctx.config.debugMode = nextDebugMode;
        applyRuntimeDefaults(ctx);
        if (
          typeof ctx.config.missionResetLevel !== "string" ||
          !ctx.config.missionResetLevel.trim()
        ) {
          ctx.currentMissionResetLevel =
            ctx.runtimeDefaults?.missionResetLevel ||
            ctx.currentMissionResetLevel;
        }
        flushConfig(ctx, logger.logDebug);
        logDebugToggleSummary(nextDebugMode);
      },
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
        if (arg === "doctor") {
          try {
            await signer.doctor();
          } catch (error) {
            logWithTimestamp(`[SIGNER] ❌ Doctor failed: ${error.message}`);
          }
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
          const riskResult = await confirmYesOrCaptureImportValue(
            "app_wallet mode is for a dedicated burner wallet only. Continue with import? This will replace the current imported app wallet if one exists. yes/no ",
          );
          if (!riskResult.ok) {
            logWithTimestamp("[SIGNER] Import cancelled.");
            return;
          }
          const replaceOk =
            !ctx.signerConfig?.walletRef ||
            (await confirmYes(
              rl,
              "Replace the existing imported signer vault + OS-stored vault key if one exists? yes/no ",
            ));
          if (!replaceOk) {
            logWithTimestamp("[SIGNER] Import cancelled.");
            return;
          }
          const effectiveImportValue =
            riskResult.capturedImportValue || importValue;
          const importPath =
            effectiveImportValue && fs.existsSync(effectiveImportValue)
              ? effectiveImportValue
              : null;
          if (!importPath) {
            try {
              signer.setSignerMode("app_wallet", "import");
              await signer.importFromText(effectiveImportValue);
              flushConfig(ctx, logger.logDebug);
              await refreshFundingWalletHeader();
            } catch (error) {
              logWithTimestamp(`[SIGNER] ❌ Import failed: ${error.message}`);
            }
            return;
          }
          const fileRiskOk = await confirmYes(
            rl,
            "app_wallet mode is for a dedicated burner wallet only. Continue with file import? This will replace the current imported app wallet if one exists. yes/no ",
          );
          if (!fileRiskOk) {
            logWithTimestamp("[SIGNER] Import cancelled.");
            return;
          }
          const fileReplaceOk =
            !ctx.signerConfig?.walletRef ||
            (await confirmYes(
              rl,
              "Replace the existing imported signer vault + OS-stored vault key if one exists? yes/no ",
            ));
          if (!fileReplaceOk) {
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
            "[SIGNER] ❌ Usage: signer [status|doctor|setup|create|reveal|app_wallet|manual|dapp|import [path-or-key]|remove|unlock|lock]",
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
      if (cmd === "debug" || cmd.startsWith("debug ")) {
        await handlers.debug(raw);
        return;
      }
      if (cmd === "i" || cmd === "settings" || cmd === "toggles") {
        await handlers.i();
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
        ctx.config.missionResetLevel = String(
          ctx.currentMissionResetLevel ||
            process.env.PBP_DEFAULT_MISSION_RESET_LEVEL ||
            ctx.runtimeDefaults?.missionResetLevel ||
            "11",
        );
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
      if (cmd === "mr" || cmd.startsWith("mr ")) {
        const arg = cmd.slice(2).trim();
        if (!arg) {
          if (ctx.debugMode !== true) {
            logWithTimestamp("[MODE] Per-slot mission reset overrides require debug mode.");
            return;
          }
          ctx.missionResetPerSlotModeEnabled =
            ctx.missionResetPerSlotModeEnabled !== true;
        } else if (arg === "off") {
          ctx.missionResetPerSlotModeEnabled = false;
        } else if (arg === "on") {
          if (ctx.debugMode !== true) {
            logWithTimestamp("[MODE] Per-slot mission reset overrides require debug mode.");
            return;
          }
          ctx.missionResetPerSlotModeEnabled = true;
        } else {
          logWithTimestamp("Usage: mr [off|on]");
          return;
        }
        ctx.config.missionResetPerSlotModeEnabled =
          ctx.missionResetPerSlotModeEnabled;
        if (
          !ctx.config.missionResetPerSlotEnabledBySlot ||
          typeof ctx.config.missionResetPerSlotEnabledBySlot !== "object"
        ) {
          ctx.config.missionResetPerSlotEnabledBySlot = {
            1: false,
            2: false,
            3: false,
            4: false,
          };
        }
        if (
          !ctx.config.missionResetPerSlotLevelBySlot ||
          typeof ctx.config.missionResetPerSlotLevelBySlot !== "object"
        ) {
          const fallbackLevel = Number(
            ctx.currentMissionResetLevel ||
              process.env.PBP_DEFAULT_MISSION_RESET_LEVEL ||
              ctx.runtimeDefaults?.missionResetLevel ||
              11,
          );
          ctx.config.missionResetPerSlotLevelBySlot = {
            1: fallbackLevel,
            2: fallbackLevel,
            3: fallbackLevel,
            4: fallbackLevel,
          };
        }
        ctx.missionResetPerSlotEnabledBySlot = {
          ...ctx.config.missionResetPerSlotEnabledBySlot,
        };
        ctx.missionResetPerSlotLevelBySlot = {
          ...ctx.config.missionResetPerSlotLevelBySlot,
        };
        flushConfig(ctx, logger.logDebug);
        logWithTimestamp(
          ctx.missionResetPerSlotModeEnabled
            ? "[MODE] Per-slot mission reset overrides enabled."
            : "[MODE] Per-slot mission reset overrides disabled.",
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
