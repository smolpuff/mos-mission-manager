"use strict";

const path = require("path");
const os = require("os");

const APP_VERSION = "3.0.3";
const APP_NAME = "missions-v3-mcp";
const DEFAULT_MISSION_RESET_LEVEL = "20";
const MCP_URL = "https://pixelbypixel.studio/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const LOG_BUFFER_SIZE = 100;
const LOG_BUFFER_SIZE_DEBUG = 400;

function createContext() {
  return {
    APP_VERSION,
    APP_NAME,
    MCP_URL,
    MCP_PROTOCOL_VERSION,
    configPath: path.join(process.cwd(), "config.json"),
    tokenFilePath: path.join(os.homedir(), ".pbp-mcp", "token.json"),
    LOG_BUFFER_SIZE,
    LOG_BUFFER_SIZE_DEBUG,

    logBuffer: [],
    config: {},
    isIdle: true,
    isAuthenticated: false,
    currentUserDisplayName: "unknown",
    currentUserWalletId: "unknown",
    currentMode: "normal",
    level20ResetEnabled: false,
    missionModeEnabled: false,
    currentMissionResetLevel: DEFAULT_MISSION_RESET_LEVEL,
    debugMode: process.argv.includes("--debug"),
    interactiveAuth: process.argv.includes("--interactive-auth"),
    watchLoopEnabled: true,
    watcherRunning: false,
    authRefreshSignal: 0,
    onAuthRefresh: null,
    autoAssignRunning: false,
    missionCatalogEntries: [],
    sessionClaimedCount: 0,
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
  };
}

module.exports = {
  createContext,
};
