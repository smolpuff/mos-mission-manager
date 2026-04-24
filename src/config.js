"use strict";

const fs = require("fs");
const path = require("path");

const SAVE_DEBOUNCE_MS = 350;
const pendingSaves = new WeakMap();
const DEFAULT_TARGET_MISSIONS = ["Do it All!", "Race!"];

function configBackupPath(configPath) {
  return `${String(configPath || "").trim()}.bak`;
}

function configBrokenPath(configPath) {
  return `${String(configPath || "").trim()}.broken.${Date.now()}`;
}

function ensureConfigDir(configPath) {
  const dir = path.dirname(String(configPath || ""));
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function writeConfigFileAtomic(configPath, config) {
  ensureConfigDir(configPath);
  const file = String(configPath || "").trim();
  if (!file) throw new Error("configPath is required");
  const backup = configBackupPath(file);
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, backup);
    } catch {}
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    if (error && (error.code === "EEXIST" || error.code === "EPERM")) {
      try {
        fs.unlinkSync(file);
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError;
      }
      fs.renameSync(tmp, file);
    } else {
      throw error;
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

function tryReadJsonFile(filePath) {
  const file = String(filePath || "").trim();
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadConfig(ctx, logWithTimestamp) {
  let parseFailed = false;
  try {
    ctx.config = tryReadJsonFile(ctx.configPath) || {};
  } catch (err) {
    parseFailed = true;
    ctx.config = {};
    if (typeof logWithTimestamp === "function") {
      logWithTimestamp(`[ERROR] Failed to parse config.json: ${err.message}`);
    }
    const backupPath = configBackupPath(ctx.configPath);
    try {
      const backup = tryReadJsonFile(backupPath);
      if (backup && typeof backup === "object" && !Array.isArray(backup)) {
        ctx.config = backup;
        if (typeof logWithTimestamp === "function") {
          logWithTimestamp(
            `[CONFIG] Recovered config from backup: ${path.basename(backupPath)}`,
          );
        }
      }
    } catch (backupErr) {
      if (typeof logWithTimestamp === "function") {
        logWithTimestamp(
          `[ERROR] Failed to parse config backup: ${backupErr.message}`,
        );
      }
    }
    try {
      if (fs.existsSync(ctx.configPath)) {
        const brokenPath = configBrokenPath(ctx.configPath);
        fs.copyFileSync(ctx.configPath, brokenPath);
        if (typeof logWithTimestamp === "function") {
          logWithTimestamp(
            `[CONFIG] Preserved broken config as ${path.basename(brokenPath)}`,
          );
        }
      }
    } catch {}
  }

  if (typeof ctx.config.totalClaimed !== "number") ctx.config.totalClaimed = 0;
  if (
    !Array.isArray(ctx.config.targetMissions) ||
    ctx.config.targetMissions.length === 0
  ) {
    ctx.config.targetMissions = [...DEFAULT_TARGET_MISSIONS];
    if (typeof logWithTimestamp === "function") {
      logWithTimestamp(
        `[CONFIG] Seeded default target missions: ${ctx.config.targetMissions.join(", ")}`,
      );
    }
    if (!parseFailed) {
      try {
        writeConfigFileAtomic(ctx.configPath, ctx.config);
      } catch (err) {
        if (typeof logWithTimestamp === "function") {
          logWithTimestamp(
            `[ERROR] Failed to save default targetMissions to config.json: ${err.message}`,
          );
        }
      }
    }
  }
  if (typeof ctx.config.level20ResetEnabled === "boolean") {
    ctx.level20ResetEnabled = ctx.config.level20ResetEnabled;
  }
  if (typeof ctx.config.missionModeEnabled === "boolean") {
    ctx.missionModeEnabled = ctx.config.missionModeEnabled;
  }
  if (typeof ctx.config.nftCooldownResetEnabled === "boolean") {
    ctx.nftCooldownResetEnabled = ctx.config.nftCooldownResetEnabled;
  } else {
    ctx.config.nftCooldownResetEnabled = false;
  }
  if (typeof ctx.config.enableRentals !== "boolean") {
    ctx.config.enableRentals = false;
  }
  if (typeof ctx.config.missionResetLevel === "string") {
    ctx.currentMissionResetLevel = ctx.config.missionResetLevel;
  }
  if (
    ctx.config.signerMode === "app_wallet" ||
    ctx.config.signerMode === "browser_wallet" ||
    ctx.config.signerMode === "signing" ||
    ctx.config.signerMode === "manual" ||
    ctx.config.signerMode === "dapp"
  ) {
    ctx.signerMode =
      ctx.config.signerMode === "signing"
        ? "app_wallet"
        : ctx.config.signerMode === "browser_wallet"
          ? "manual"
          : ctx.config.signerMode;
  }
  if (
    ctx.config.signer &&
    typeof ctx.config.signer === "object" &&
    !Array.isArray(ctx.config.signer)
  ) {
    ctx.signerConfig = ctx.config.signer;
  } else {
    ctx.signerConfig = {};
  }
  if (typeof ctx.config.watchLoopEnabled === "boolean") {
    ctx.watchLoopEnabled = ctx.config.watchLoopEnabled;
  }
  if (ctx.config.watchLoopEnabled === true) {
    delete ctx.config.watchLoopEnabled;
  }
  if (
    typeof ctx.config.interactiveAuth === "boolean" &&
    !process.argv.includes("--interactive-auth")
  ) {
    ctx.interactiveAuth = ctx.config.interactiveAuth;
  }
  if (typeof ctx.config.debugMode === "boolean" && !process.argv.includes("--debug")) {
    ctx.debugMode = ctx.config.debugMode;
  }
  ctx.config.signerMode = ctx.signerMode;
}

function saveConfig(ctx, logDebug) {
  const existing = pendingSaves.get(ctx);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    try {
      writeConfigFileAtomic(ctx.configPath, ctx.config);
    } catch (err) {
      logDebug("config", "save_failed", { error: err.message });
    } finally {
      pendingSaves.delete(ctx);
    }
  }, SAVE_DEBOUNCE_MS);

  pendingSaves.set(ctx, { timer });
}

function flushConfig(ctx, logDebug) {
  const pending = pendingSaves.get(ctx);
  if (pending?.timer) {
    clearTimeout(pending.timer);
    pendingSaves.delete(ctx);
  }
  try {
    writeConfigFileAtomic(ctx.configPath, ctx.config);
  } catch (err) {
    logDebug("config", "save_failed", { error: err.message });
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  flushConfig,
};
