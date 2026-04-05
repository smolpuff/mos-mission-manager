"use strict";

const fs = require("fs");

const SAVE_DEBOUNCE_MS = 350;
const pendingSaves = new WeakMap();

function loadConfig(ctx, logWithTimestamp) {
  try {
    ctx.config = fs.existsSync(ctx.configPath)
      ? JSON.parse(fs.readFileSync(ctx.configPath, "utf8"))
      : {};
  } catch (err) {
    ctx.config = {};
    logWithTimestamp(`[ERROR] Failed to parse config.json: ${err.message}`);
  }

  if (typeof ctx.config.totalClaimed !== "number") ctx.config.totalClaimed = 0;
  if (typeof ctx.config.level20ResetEnabled === "boolean") {
    ctx.level20ResetEnabled = ctx.config.level20ResetEnabled;
  }
  if (typeof ctx.config.missionModeEnabled === "boolean") {
    ctx.missionModeEnabled = ctx.config.missionModeEnabled;
  }
  if (typeof ctx.config.missionResetLevel === "string") {
    ctx.currentMissionResetLevel = ctx.config.missionResetLevel;
  }
  if (typeof ctx.config.watchLoopEnabled === "boolean") {
    ctx.watchLoopEnabled = ctx.config.watchLoopEnabled;
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
}

function saveConfig(ctx, logDebug) {
  const existing = pendingSaves.get(ctx);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    try {
      fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2));
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
    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2));
  } catch (err) {
    logDebug("config", "save_failed", { error: err.message });
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  flushConfig,
};
