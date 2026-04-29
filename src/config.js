"use strict";

const fs = require("fs");
const path = require("path");

const SAVE_DEBOUNCE_MS = 350;
const pendingSaves = new WeakMap();
const DEFAULT_TARGET_MISSIONS = ["Do it All!", "Race!"];
const SALVAGE_TOP_LEVEL_KEYS = [
  "targetMissions",
  "level20ResetEnabled",
  "missionModeEnabled",
  "nftCooldownResetEnabled",
  "nftCooldownResetMissionModeEnabled",
  "nftCooldownResetMaxPbp",
  "nftCooldownResetProbeLimit",
  "missionResetLevel",
  "signerMode",
  "signer",
  "totalClaimed",
  "firstRunOnboardingCompleted",
  "enableRentals",
  "rentalFastRefreshEnabled",
  "rentalFastRefreshTickMs",
  "interactiveAuth",
  "debugMode",
  "watchLoopEnabled",
  "lowBalanceThresholds",
  "lowBalancePbpThreshold",
  "lowBalanceSolThreshold",
  "signerSetupCompleted",
];

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
  const json = JSON.stringify(config, null, 2);
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8");
      if (existing === json) return;
    }
  } catch {}
  const backup = configBackupPath(file);
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, backup);
    } catch {}
  }
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
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

function extractJsonValueText(rawText, key) {
  const raw = String(rawText || "");
  const matcher = new RegExp(`"${String(key)}"\\s*:`, "g");
  const match = matcher.exec(raw);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length) return null;

  const start = i;
  const first = raw[i];
  if (first === "{") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
    return null;
  }
  if (first === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) return raw.slice(start, i + 1);
      }
    }
    return null;
  }
  for (; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\n" || ch === "\r" || ch === "," || ch === "}") {
      return raw.slice(start, i).trim();
    }
  }
  return raw.slice(start).trim();
}

function salvageConfigFromBrokenText(rawText) {
  const salvaged = {};
  const raw = String(rawText || "");
  if (!raw.trim()) return salvaged;

  for (const key of SALVAGE_TOP_LEVEL_KEYS) {
    const valueText = extractJsonValueText(raw, key);
    if (!valueText) continue;
    try {
      salvaged[key] = JSON.parse(valueText);
    } catch {}
  }

  if (!Array.isArray(salvaged.targetMissions)) {
    const arrText = extractJsonValueText(raw, "targetMissions");
    if (arrText) {
      const missions = [];
      const stringMatcher = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
      let match;
      while ((match = stringMatcher.exec(arrText))) {
        try {
          missions.push(JSON.parse(`"${match[1]}"`));
        } catch {}
      }
      if (missions.length > 0) salvaged.targetMissions = missions;
    }
  }

  return salvaged;
}

function loadConfig(ctx, logWithTimestamp) {
  let parseFailed = false;
  ctx.configLoadParseFailed = false;
  try {
    ctx.config = tryReadJsonFile(ctx.configPath) || {};
  } catch (err) {
    parseFailed = true;
    ctx.configLoadParseFailed = true;
    ctx.config = {};
    const rawBrokenConfig = (() => {
      try {
        return fs.readFileSync(ctx.configPath, "utf8");
      } catch {
        return "";
      }
    })();
    if (typeof logWithTimestamp === "function") {
      logWithTimestamp(`[ERROR] Failed to parse config.json: ${err.message}`);
    }

    let brokenPath = null;
    try {
      if (fs.existsSync(ctx.configPath)) {
        brokenPath = configBrokenPath(ctx.configPath);
        fs.copyFileSync(ctx.configPath, brokenPath);
        if (typeof logWithTimestamp === "function") {
          logWithTimestamp(
            `[CONFIG] Preserved broken config as ${path.basename(brokenPath)}`,
          );
        }
      }
    } catch {}

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
      const salvaged = salvageConfigFromBrokenText(rawBrokenConfig);
      const salvagedKeys = Object.keys(salvaged);
      if (salvagedKeys.length > 0) {
        ctx.config = { ...ctx.config, ...salvaged };
        if (typeof logWithTimestamp === "function") {
          logWithTimestamp(
            `[CONFIG] Salvaged readable keys from broken config: ${salvagedKeys.join(", ")}`,
          );
        }
      }
    } catch {}

    if (typeof logWithTimestamp === "function") {
      logWithTimestamp(
        "[CONFIG] Parse recovery loaded in-memory only. Existing config.json was left untouched.",
      );
    }
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
    try {
      if (!parseFailed) {
        writeConfigFileAtomic(ctx.configPath, ctx.config);
      }
    } catch (err) {
      if (typeof logWithTimestamp === "function") {
        logWithTimestamp(
          `[ERROR] Failed to save default targetMissions to config.json: ${err.message}`,
        );
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
    ctx.nftCooldownResetEnabled = false;
  }
  const nftCooldownResetMaxPbp = Number(ctx.config.nftCooldownResetMaxPbp);
  ctx.config.nftCooldownResetMaxPbp =
    Number.isFinite(nftCooldownResetMaxPbp) && nftCooldownResetMaxPbp >= 0
      ? nftCooldownResetMaxPbp
      : 20;
  if (typeof ctx.config.enableRentals !== "boolean") {
    ctx.config.enableRentals = false;
  }
  // Internal fast rental
  if (typeof ctx.config.rentalFastRefreshEnabled !== "boolean") {
    ctx.config.rentalFastRefreshEnabled = false;
  }
  const rentalFastRefreshMinMs =
    ctx.runtimeDefaults?.rentalFastRefreshTickMs || 15000;
  const rentalFastRefreshTickMs = Number(ctx.config.rentalFastRefreshTickMs);
  ctx.config.rentalFastRefreshTickMs =
    Number.isFinite(rentalFastRefreshTickMs) && rentalFastRefreshTickMs > 0
      ? Math.max(rentalFastRefreshMinMs, Math.floor(rentalFastRefreshTickMs))
      : rentalFastRefreshMinMs;
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
  if (
    typeof ctx.config.debugMode === "boolean" &&
    !process.argv.includes("--debug")
  ) {
    ctx.debugMode = ctx.config.debugMode;
  }
  ctx.config.signerMode = ctx.signerMode;
}

function saveConfig(ctx, logDebug) {
  if (ctx?.configLoadParseFailed) {
    try {
      logDebug("config", "save_skipped_parse_failed", {
        reason: "config_load_parse_failed",
      });
    } catch {}
    return;
  }
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
  if (ctx?.configLoadParseFailed) {
    try {
      logDebug("config", "flush_skipped_parse_failed", {
        reason: "config_load_parse_failed",
      });
    } catch {}
    return;
  }
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
