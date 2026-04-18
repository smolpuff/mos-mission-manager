"use strict";

const path = require("path");
const os = require("os");

const APP_VERSION = "3.0.5";
const APP_NAME = "missions-v3-mcp";
const DEFAULT_MISSION_RESET_LEVEL = "20";
const DEFAULT_SIGNER_MODE = "app_wallet";
const MCP_URL = "https://pixelbypixel.studio/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const LOG_BUFFER_SIZE = 100;
const LOG_BUFFER_SIZE_DEBUG = 400;

function createContext() {
  const configDir = process.env.PBP_CONFIG_DIR || process.cwd();
  return {
    APP_VERSION,
    APP_NAME,
    MCP_URL,
    MCP_PROTOCOL_VERSION,
    configPath: path.join(configDir, "config.json"),
    tokenFilePath: path.join(os.homedir(), ".pbp-mcp", "token.json"),
    LOG_BUFFER_SIZE,
    LOG_BUFFER_SIZE_DEBUG,

    logBuffer: [],
    config: {},
    isIdle: true,
    isAuthenticated: false,
    mcpConnection: {
      state: "disconnected", // connected | reconnecting | expired | disconnected
      lastError: null,
      updatedAt: 0,
    },
    currentUserDisplayName: "unknown",
    currentUserWalletId: "unknown",
    currentUserWalletSummary: null,
    currentMode: "normal",
    level20ResetEnabled: false,
    missionModeEnabled: false,
    nftCooldownResetEnabled: false,
    currentMissionResetLevel: DEFAULT_MISSION_RESET_LEVEL,
    signerMode: DEFAULT_SIGNER_MODE,
    signerStatus: "uninitialized",
    signerReady: false,
    signerLocked: true,
    signerConfig: {},
    fundingWalletSummary: {
      address: "",
      sol: null,
      pbp: null,
      status: "unknown",
    },
    signerSessionSecretKey: null,
    signerUnlockFailures: 0,
    signerUnlockAllowedAt: 0,
    signerRecentActionFingerprints: {},
    signerActionLastAt: {},
    debugMode: process.argv.includes("--debug"),
    interactiveAuth: process.argv.includes("--interactive-auth"),
    plainOutputMode:
      process.env.PBP_GUI_BRIDGE === "1" ||
      process.argv.includes("--plain-output"),
    watchLoopEnabled: true,
    watcherRunning: false,
    authRefreshSignal: 0,
    onAuthRefresh: null,
    autoAssignRunning: false,
    lastResetPromptKey: "",
    lastResetPromptAt: 0,
    missionCatalogEntries: [],
    sessionClaimedCount: 0,
    sessionRewardTotals: {
      pbp: 0,
      tc: 0,
      cc: 0,
    },
    sessionSpendTotals: {
      pbp: 0,
      tc: 0,
      cc: 0,
    },
    startupComplete: false,
    startupFxActive: false,
    startupFxProgress: 0,

    currentMissionStats: {
      total: 0,
      claimable: 0,
      available: 0,
      active: 0,
      completed: 0,
      claimed: 0,
      totalClaimed: 0,
      nfts: 0,
      nftsTotal: 0,
      nftsAvailable: 0,
    },

    guiMissionSlots: [],
  };
}

module.exports = {
  createContext,
};
