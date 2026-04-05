// Cross-platform version of missions.js using Puppeteer instead of AppleScript
// Works on Windows, Linux, and macOS

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer");

// Get actual file modification date
const appLastModifiedDate = fs
  .statSync(__filename)
  .mtime.toISOString()
  .slice(0, 10);
const appVersion = "1.0.1";

const MISSIONS_URL = "https://pixelbypixel.studio/missions/play";

// Default values
const DEFAULT_TARGET_MISSIONS = ["Race!"];
const DEFAULT_WATCH_INTERVAL_SECONDS = 121;
const DEFAULT_PAGE_REFRESH_MINUTES = 2.69;
const DEFAULT_MISSION_RESET_LEVEL = "11";
// const FORCE_ALREADY_STARTED = true;

// Mission list selectors (updated for new container)
const MISSION_BUTTON_SELECTOR =
  "main section article div div.flex.flex-col.h-full.gap-6 div.p-6.pt-0 > div > button";
const MISSION_LEVEL_CONTAINER_SELECTOR =
  "div.relative.z-10.flex.h-full.w-full.flex-col.justify-between.px-3.py-3 > div.flex.flex-row.items-center.justify-center.gap-2";
const MISSION_LEVEL_BADGE_SELECTOR =
  "div.relative.z-10.flex.h-full.w-full.flex-col.justify-between.px-3.py-3 > div.flex.flex-row.items-center.justify-center.gap-2 > div.w-8.h-8.rounded-md.flex.flex-shrink-0.items-center.justify-center.text-sm.font-bold > span";
const MISSION_STATUS_TEXT_SELECTOR =
  "div.relative.z-10.flex.h-full.w-full.flex-col.justify-between.px-3.py-3 > div.flex.flex-col.items-center.justify-center.gap-1.py-1 > span";

let refreshInterval = null;
const DEBUG_MODE = process.argv.includes("--debug");

// Log buffer for locked header effect (like original)
const LOG_BUFFER_SIZE = 100;
let logBuffer = [];

// Clear the log buffer and redraw header/log area
function clearLogBuffer() {
  logBuffer = [];
  redrawHeaderAndLog(currentMissionStats);
}

let isRunning = false;
let testMode = false;
let isWatching = false;
let watchInterval = null;
let browser = null;
let page = null;
let level20ResetEnabled = false;
let missionModeEnabled = false;
let temporaryCollectionFlowPauseCount = 0;

// RE-ENABLE ME
// Temporary mission-specific collection routing can be re-enabled by setting this to true.
const TEMP_COLLECTION_REQUIREMENTS_ENABLED = false;

// Load config
let config = {};
const configPath = path.join(__dirname, "config.json");
try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof config.totalClaimed !== "number") config.totalClaimed = 0;
    if (typeof config.level20ResetEnabled === "boolean") {
      level20ResetEnabled = config.level20ResetEnabled;
    }
    if (typeof config.missionModeEnabled === "boolean") {
      missionModeEnabled = config.missionModeEnabled;
    }
    // console.log(`[DEBUG] Config loaded successfully from ${configPath}`);
    if (DEBUG_MODE) {
      console.log(JSON.stringify(config, null, 2));
    }
  } else {
    config = { totalClaimed: 0 };
    console.log(
      `[DEBUG][STARTUP] Config file not found at ${configPath}, using defaults`,
    );
  }
} catch (e) {
  config = { totalClaimed: 0 };
  console.log(
    `[DEBUG][STARTUP] Failed to load config: ${e.message}, using defaults`,
  );
}

const TARGET_MISSIONS = Array.isArray(config.targetMissions)
  ? config.targetMissions
  : DEFAULT_TARGET_MISSIONS;
const WATCH_INTERVAL_SECONDS =
  typeof config.watchIntervalSeconds === "number"
    ? config.watchIntervalSeconds
    : DEFAULT_WATCH_INTERVAL_SECONDS;
const PAGE_REFRESH_MINUTES =
  typeof config.pageRefreshMinutes === "number"
    ? config.pageRefreshMinutes
    : DEFAULT_PAGE_REFRESH_MINUTES;
const MISSION_RESET_LEVEL =
  typeof config.missionResetLevel === "string"
    ? config.missionResetLevel
    : DEFAULT_MISSION_RESET_LEVEL;
let currentMissionResetLevel = MISSION_RESET_LEVEL;

// Debug: Echo the settings being used (like original)
if (DEBUG_MODE) {
  // Use a simple log function that will persist through screen redraws
  const startupLog = (message) => {
    if (!logBuffer) logBuffer = [];
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const line = `[${timestamp}] ${message}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  };

  startupLog(`[DEBUG][STARTUP] Settings applied:`);
  TARGET_MISSIONS.forEach((mission, idx) => {
    startupLog(`[DEBUG][STARTUP] Target Mission ${idx + 1}: ${mission}`);
  });
  startupLog(
    `[DEBUG][STARTUP] Watch Interval: ${WATCH_INTERVAL_SECONDS} seconds`,
  );
  // If user has configured a specific Solflare extension id, show it in debug
  if (config && config.solflareExtensionId) {
    startupLog(
      `[DEBUG][STARTUP] Using configured Solflare extension id: ${config.solflareExtensionId}`,
    );
  }
  // startupLog(`[DEBUG][STARTUP] Page Refresh: ${PAGE_REFRESH_MINUTES}m`);
}

const usingDefaults = {
  targetMissions: !Array.isArray(config.targetMissions),
  watchInterval: typeof config.watchIntervalSeconds !== "number",
  pageRefresh: typeof config.pageRefreshMinutes !== "number",
};
if (
  usingDefaults.targetMissions ||
  usingDefaults.watchInterval ||
  usingDefaults.pageRefresh
) {
  if (DEBUG_MODE) {
    const startupLog = (message) => {
      if (!logBuffer) logBuffer = [];
      const timestamp = new Date().toLocaleTimeString("en-GB", {
        hour12: false,
      });
      const line = `[${timestamp}] ${message}`;
      logBuffer.push(line);
      if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    };

    startupLog(
      `[DEBUG][STARTUP] Using defaults for: ${Object.keys(usingDefaults)
        .filter((k) => usingDefaults[k])
        .join(", ")}`,
    );
  }
}

let currentMissionStats = {
  total: 0,
  claimable: 0,
  available: 0,
  active: 0,
  completed: 0,
  claimed: 0,
  totalClaimed: config.totalClaimed,
  nfts: 0,
};

// Header and display functions (copied from original missions.js)
function getDisplayWidth(str) {
  // Basic: treat emoji (unicode >= 0x1F300 and <= 0x1FAFF) as width 2, others as 1
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0);
    if (
      (code >= 0x1f300 && code <= 0x1faff) || // emoji block
      (code >= 0x2600 && code <= 0x26ff) || // misc symbols
      (code >= 0x2700 && code <= 0x27bf) // dingbats
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function printHeaderArea(
  stats = {
    total: 0,
    claimable: 0,
    available: 0,
    active: 0,
    completed: 0,
    claimed: 0,
    totalClaimed: 0,
  },
) {
  // Determine reset status string
  const resetStatus = level20ResetEnabled ? "ON" : "OFF";
  const modeStatus = missionModeEnabled
    ? `mission (${currentMissionResetLevel} reset)`
    : "normal";
  const termWidth = process.stdout.columns || 78;
  // Minimum width for box to look good
  const boxWidth = Math.max(termWidth, 40);
  const innerWidth = boxWidth - 4; // 2 for borders, 2 for padding
  // Always show totalClaimed from config
  const totalClaimed =
    typeof config.totalClaimed === "number" ? config.totalClaimed : 0;

  // Show session-based claimed and persistent totalClaimed as x(y)
  const lines = [
    "",
    `missions.js ${appVersion} ${appLastModifiedDate}`,
    "",
    `🎯 ${stats.active} active | 🥞 ${stats.available} available | 🤑 ${stats.claimable} claimable | ✅ ${stats.claimed}(${totalClaimed}) claimed`,
    `mode: ${modeStatus} | 20 reset: ${resetStatus}`,
  ];

  while (lines.length < 6) lines.push("");

  console.log("╔" + "═".repeat(boxWidth - 2) + "╗");
  for (const line of lines) {
    // Calculate display width
    const displayWidth = getDisplayWidth(line);
    const padLen = innerWidth - displayWidth;
    const padded = line + " ".repeat(Math.max(0, padLen));
    console.log(`║ ${padded} ║`);
  }
  console.log("╚" + "═".repeat(boxWidth - 2) + "╝");
  console.log("");
}

function getLogAreaLines() {
  const HEADER_LINES = 12;
  const totalRows = process.stdout.rows || 24;
  return Math.max(3, totalRows - HEADER_LINES);
}

// Redraw header and log area, always at the top, fixed size
function redrawHeaderAndLog(stats) {
  process.stdout.write("\x1b[H\x1b[2J");
  printHeaderArea(stats);
  const logLines = getLogAreaLines();
  const start = Math.max(0, logBuffer.length - logLines);
  const visibleLogs = logBuffer.slice(start);
  for (let i = 0; i < logLines; i++) {
    const line = visibleLogs[i] || "";
    process.stdout.write(line.padEnd(78, " ") + "\n");
  }
}

// Helper function to launch Chrome with remote debugging (like AppleScript version)
function launchChromeWithRemoteDebugging() {
  const { spawn } = require("child_process");
  const os = require("os");

  let chromePath;
  const homeDir = os.homedir();
  const userDataDir = path.join(homeDir, "ChromeInstance2");

  // Platform-specific Chrome paths
  switch (os.platform()) {
    case "darwin": // macOS
      chromePath =
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      break;
    case "win32": // Windows
      chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      // Fallback paths for Windows
      if (!require("fs").existsSync(chromePath)) {
        chromePath =
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
      }
      break;
    case "linux": // Linux
      chromePath = "/usr/bin/google-chrome";
      // Fallback paths for Linux
      if (!require("fs").existsSync(chromePath)) {
        chromePath = "/usr/bin/chromium-browser";
      }
      break;
    default:
      chromePath = "google-chrome"; // Hope it's in PATH
  }

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=Profile 1`,
    `--remote-debugging-port=9222`,
    `${MISSIONS_URL}`,
  ];
  // logWithTimestamp(`[DEBUG] Chrome launch path: ${chromePath}`);
  // logWithTimestamp(`[DEBUG] Chrome launch args: ${JSON.stringify(args)}`);
  try {
    const proc = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
    });

    proc.unref();
    logWithTimestamp(
      `[DEBUG][STARTUP] Chrome process spawned. PID: ${proc.pid}`,
    );
    logWithTimestamp(
      `[DEBUG][STARTUP] Chrome launched using ChromeInstance2 user data dir`,
    );
    logWithTimestamp(`[DEBUG][STARTUP] Chrome remote debugging on port 9222`);
    TARGET_MISSIONS.forEach((mission, idx) => {
      logWithTimestamp(
        `[DEBUG][STARTUP] Target Mission ${idx + 1}: ${mission}`,
      );
    });
    //   logWithTimestamp(`[DEBUG][STARTUP] Watch interval: ${WATCH_INTERVAL_SECONDS}s`);
    return true;
  } catch (error) {
    logWithTimestamp(`[ERROR] Failed to launch Chrome: ${error.message}`);
    return false;
  }
}

// Browser management functions - Connect to existing Chrome with remote debugging
async function initializeBrowser() {
  try {
    if (browser) {
      try {
        await browser.disconnect(); // Disconnect instead of close
      } catch (e) {
        // Already disconnected
      }
    }

    // First try to connect to existing Chrome instance with remote debugging
    try {
      browser = await puppeteer.connect({
        browserURL: "http://localhost:9222",
        defaultViewport: null,
      });
      logWithTimestamp("[INFO] ✓ Connected to existing Chrome instance");
    } catch (connectError) {
      logWithTimestamp(
        "[INFO] No existing Chrome found, launching new instance...",
      );

      // Launch Chrome with remote debugging like the original AppleScript version
      const launched = launchChromeWithRemoteDebugging();
      if (!launched) {
        logWithTimestamp("[ERROR] Failed to launch Chrome");
        return false;
      }

      // Wait for Chrome to start and retry connection
      let retries = 10;
      let attempt = 1;
      while (retries > 0) {
        logWithTimestamp(
          `[DEBUG] Waiting for Chrome to start... Attempt ${attempt}/10`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          browser = await puppeteer.connect({
            browserURL: "http://localhost:9222",
            defaultViewport: null,
          });
          logWithTimestamp("[INFO] ✓ Connected to newly launched Chrome");
          break;
        } catch (retryError) {
          retries--;
          attempt++;
        }
      }

      if (retries === 0) {
        logWithTimestamp(
          "[ERROR] Failed to connect to Chrome after multiple attempts",
        );
        return false;
      }
    }

    // Find or create missions page
    const pages = await browser.pages();
    let missionsPage = pages.find((p) =>
      p.url().includes("pixelbypixel.studio/missions"),
    );

    if (!missionsPage) {
      // Create new tab for missions if not found
      page = await browser.newPage();
      await page.goto(MISSIONS_URL, { waitUntil: "networkidle2" });
      logWithTimestamp("[INFO] ✓ Opened missions page in new tab");
    } else {
      page = missionsPage;
      // Ensure we're on the right page
      if (!page.url().includes("missions/play")) {
        await page.goto(MISSIONS_URL, { waitUntil: "networkidle2" });
      }
      logWithTimestamp("[INFO] ✓ Connected to existing missions tab");
    }

    return true;
  } catch (error) {
    logWithTimestamp(`[ERROR] Failed to initialize browser: ${error.message}`);
    return false;
  }
}

async function ensurePage() {
  if (!browser) {
    return await initializeBrowser();
  }

  try {
    // Check if browser connection is still alive
    await browser.version();

    if (!page || page.isClosed()) {
      // Find existing missions page or create new one
      const pages = await browser.pages();
      let missionsPage = pages.find((p) =>
        p.url().includes("pixelbypixel.studio/missions"),
      );

      if (!missionsPage) {
        page = await browser.newPage();
        await page.goto(MISSIONS_URL, { waitUntil: "networkidle2" });
        logWithTimestamp("[INFO] ✓ Created new missions tab");
      } else {
        page = missionsPage;
        logWithTimestamp("[INFO] ✓ Reconnected to existing missions tab");
      }
    }

    // Ensure we're on the correct URL
    const url = await page.url();
    if (!url.includes("pixelbypixel.studio/missions")) {
      await page.goto(MISSIONS_URL, { waitUntil: "networkidle2" });
      logWithTimestamp("[DEBUG] ✓ Navigated to missions page");
    }

    return true;
  } catch (error) {
    logWithTimestamp(
      `[ERROR] Browser connection lost, reconnecting: ${error.message}`,
    );
    return await initializeBrowser();
  }
}

// Core mission functions using Puppeteer
async function getAllMissions() {
  if (!(await ensurePage())) return [];

  try {
    const missions = await page.evaluate(
      (targetMissions, selectors) => {
        try {
          const {
            missionButtonSelector,
            missionLevelBadgeSelector,
            missionLevelContainerSelector,
            missionStatusTextSelector,
          } = selectors;

          const missionButtons = Array.from(
            document.querySelectorAll(missionButtonSelector),
          );
          const missions = [];
          const seenMissions = new Set();

          const extractMissionName = (button) => {
            const levelContainer = button.querySelector(
              missionLevelContainerSelector,
            );
            const statusSpan = button.querySelector(missionStatusTextSelector);
            const textCandidates = Array.from(
              button.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
            )
              .map((el) => ({
                el,
                text: el.textContent?.trim() || "",
              }))
              .filter(({ text }) => text);

            // Prefer candidate that matches a target mission
            if (Array.isArray(targetMissions) && targetMissions.length > 0) {
              const targetMatch = textCandidates.find(
                ({ el, text }) =>
                  (!levelContainer || !levelContainer.contains(el)) &&
                  targetMissions.some((t) => text.includes(t)),
              );
              if (targetMatch) return targetMatch.text;
            }

            // Fallback: first non-level, non-numeric text
            const nonLevel = textCandidates.find(({ el, text }) => {
              if (levelContainer && levelContainer.contains(el)) return false;
              if (statusSpan && statusSpan.contains(el)) return false;
              if (/^(level|lvl)\b/i.test(text)) return false;
              if (/^\d+$/.test(text)) return false;
              return true;
            });
            if (nonLevel) return nonLevel.text;

            // Final fallback: first meaningful line from innerText
            const lines = (button.innerText || "")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .filter((l) => !/^(level|lvl)\b/i.test(l))
              .filter((l) => !/^\d+$/.test(l));
            return lines[0] || "";
          };

          for (const button of missionButtons) {
            const levelBadge = button.querySelector(missionLevelBadgeSelector);
            if (!levelBadge) continue;

            const missionText = extractMissionName(button);
            if (missionText && !seenMissions.has(missionText)) {
              seenMissions.add(missionText);

              let level = "";
              let completed = false;
              let alreadyStarted = false;

              level = levelBadge.textContent?.trim() || "";

              const statusText =
                button.querySelector(missionStatusTextSelector)?.textContent ||
                "";
              const status = statusText
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
              completed = status.includes("completed");
              alreadyStarted = status.includes("in progress");

              missions.push({
                text: missionText,
                level: level,
                completed: completed,
                alreadyStarted: alreadyStarted,
                statusText: statusText,
              });
            }
          }

          return missions;
        } catch (e) {
          return { error: e.message };
        }
      },
      TARGET_MISSIONS,
      {
        missionButtonSelector: MISSION_BUTTON_SELECTOR,
        missionLevelBadgeSelector: MISSION_LEVEL_BADGE_SELECTOR,
        missionLevelContainerSelector: MISSION_LEVEL_CONTAINER_SELECTOR,
        missionStatusTextSelector: MISSION_STATUS_TEXT_SELECTOR,
      },
    );

    if (missions.error) {
      logWithTimestamp(`[ERROR] Error getting missions: ${missions.error}`);
      return [];
    }

    return missions;
  } catch (error) {
    logWithTimestamp(`[ERROR] Failed to get missions: ${error.message}`);
    return [];
  }
}

async function clickMission(missionText) {
  if (!(await ensurePage())) return false;

  try {
    logWithTimestamp(`[DEBUG] clickMission() called for: ${missionText}`);

    const result = await page.evaluate(
      (targetText, selectors) => {
        const {
          missionButtonSelector,
          missionLevelContainerSelector,
          missionStatusTextSelector,
        } = selectors;
        const missionButtons = Array.from(
          document.querySelectorAll(missionButtonSelector),
        );

        const extractMissionName = (button) => {
          const levelContainer = button.querySelector(
            missionLevelContainerSelector,
          );
          const statusSpan = button.querySelector(missionStatusTextSelector);
          const textCandidates = Array.from(
            button.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
          )
            .map((el) => ({
              el,
              text: el.textContent?.trim() || "",
            }))
            .filter(({ text }) => text);

          const nonLevel = textCandidates.find(({ el, text }) => {
            if (levelContainer && levelContainer.contains(el)) return false;
            if (statusSpan && statusSpan.contains(el)) return false;
            if (/^(level|lvl)\b/i.test(text)) return false;
            if (/^\d+$/.test(text)) return false;
            return true;
          });
          if (nonLevel) return nonLevel.text;

          const lines = (button.innerText || "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .filter((l) => !/^(level|lvl)\b/i.test(l))
            .filter((l) => !/^\d+$/.test(l));
          return lines[0] || "";
        };

        for (const button of missionButtons) {
          const text = extractMissionName(button);
          if (text === targetText) {
            button.click();
            return "MISSION_CLICKED";
          }
        }
        return "MISSION_NOT_FOUND";
      },
      missionText,
      {
        missionButtonSelector: MISSION_BUTTON_SELECTOR,
        missionLevelContainerSelector: MISSION_LEVEL_CONTAINER_SELECTOR,
        missionStatusTextSelector: MISSION_STATUS_TEXT_SELECTOR,
      },
    );
    logWithTimestamp(`[DEBUG] clickMission() result: ${result}`);

    if (result === "MISSION_CLICKED") {
      // Don't log here - let the calling function handle step logging
      return true;
    } else {
      logWithTimestamp(`[ERROR] ❌ Failed to click mission: ${missionText}`);
      return false;
    }
  } catch (error) {
    logWithTimestamp(`[ERROR] Error clicking mission: ${error.message}`);
    return false;
  }
}

async function claimReward() {
  if (!(await ensurePage())) return false;

  try {
    const result = await page.evaluate(() => {
      const claimBtn = Array.from(document.querySelectorAll("button")).find(
        (btn) => btn.textContent && btn.textContent.includes("Claim Reward!"),
      );

      if (claimBtn) {
        try {
          claimBtn.scrollIntoView({ behavior: "instant", block: "center" });
          claimBtn.click();
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    });

    if (result) {
      logWithTimestamp("[DEBUG] ✓ Claimed reward successfully");
      return true;
    } else {
      logWithTimestamp("[ERROR] ❌ No claim button found");
      return false;
    }
  } catch (error) {
    logWithTimestamp(`[ERROR] Error claiming reward: ${error.message}`);
    return false;
  }
}

function filterClaimableMissions(missions) {
  return missions.filter((m) => m.completed);
}

function filterAvailableMissions(missions, options) {
  const {
    targetMissions,
    excludeLevel20 = false,
    excludeMissionLevel = false,
    missionResetLevel = currentMissionResetLevel,
  } = options || {};

  return missions.filter(
    (m) =>
      !m.completed &&
      !m.alreadyStarted &&
      !(excludeLevel20 && m.level === "20") &&
      !(
        excludeMissionLevel &&
        parseInt(String(m.level).match(/\d+/)?.[0], 10) >=
          parseInt(String(missionResetLevel).match(/\d+/)?.[0], 10)
      ) &&
      (targetMissions || TARGET_MISSIONS).some((target) =>
        m.text.includes(target),
      ),
  );
}

function filterMissionsToReset(missions, level) {
  return missions.filter(
    (m) =>
      parseInt(String(m.level).match(/\d+/)?.[0], 10) >=
        parseInt(String(level).match(/\d+/)?.[0], 10) &&
      !m.completed &&
      TARGET_MISSIONS.some((target) => m.text.includes(target)),
  );
}

async function getAvailableNftCount() {
  try {
    if (await ensurePage()) {
      const count = await page.evaluate(() => {
        // Look for text like 'Showing x-y of z results'
        const regex = /of (\d+) results/;
        const el = Array.from(document.querySelectorAll("body *")).find(
          function (e) {
            return e.textContent && regex.test(e.textContent);
          },
        );
        if (el) {
          const match = el.textContent.match(regex);
          if (match && match[1]) {
            return parseInt(match[1], 10);
          }
        }
        return 0;
      });
      return count || 0;
    }
  } catch (e) {
    logWithTimestamp(`[DEBUG] NFT count error: ${e.message}`);
  }
  return 0;
}

async function getAvailableNftCountWithRetry(attempts = 8, delayMs = 250) {
  let maxSeen = 0;
  for (let i = 0; i < attempts; i += 1) {
    const count = await getAvailableNftCount();
    if (count > maxSeen) maxSeen = count;
    if (maxSeen > 0) break;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return maxSeen;
}

async function waitForNftResultsToLoad(
  minDelayMs = 600,
  attempts = 8,
  delayMs = 250,
) {
  if (minDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, minDelayMs));
  }
  return await getAvailableNftCountWithRetry(attempts, delayMs);
}

async function performMissionReset(levelLabel, missionText) {
  const resetResult = await page.evaluate(() => {
    const normalize = (value) =>
      (value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const isResetButton = (btn) => {
      if (!btn) return false;
      const text = normalize(btn.textContent);
      const label = normalize(btn.getAttribute("aria-label"));
      return (
        text.includes("reset") ||
        text.includes("level 1") ||
        label.includes("reset")
      );
    };
    const pickFirstMatch = (nodeList) =>
      Array.from(nodeList || []).find((btn) => isResetButton(btn));

    let resetBtn = pickFirstMatch(document.querySelectorAll("button button"));
    if (!resetBtn) {
      const flexContainer = document.querySelector("div.p-4.flex.flex-col");
      if (flexContainer) {
        resetBtn = pickFirstMatch(flexContainer.querySelectorAll("button"));
      }
    }
    if (!resetBtn) {
      resetBtn = pickFirstMatch(document.querySelectorAll("button"));
    }

    if (resetBtn) {
      const isDisabled =
        resetBtn.disabled ||
        resetBtn.hasAttribute("disabled") ||
        resetBtn.classList.contains("disabled") ||
        resetBtn.getAttribute("aria-disabled") === "true" ||
        window.getComputedStyle(resetBtn).pointerEvents === "none";

      if (isDisabled) {
        return { ok: false, alreadyLevel1: true };
      }

      resetBtn.click();
      return { ok: true, buttonText: resetBtn.textContent?.trim() };
    }
    return { ok: false };
  });

  if (resetResult && resetResult.alreadyLevel1) {
    logWithTimestamp("[INFO] Mission already at level 1");
    return true;
  } else if (resetResult && resetResult.ok) {
    logWithTimestamp(
      `[DEBUG] ✓ Reset button clicked: "${resetResult.buttonText}"`,
    );

    // Wait for Solflare popup and approve
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!(await handleSolflarePopup("approve"))) {
      logWithTimestamp("[DEBUG] Retrying Solflare approval...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!(await handleSolflarePopup("approve"))) {
        logWithTimestamp("[ERROR] ❌ Failed to approve Solflare popup");
        return false;
      }
    }

    const resetConfirmed = await waitForMissionReset(missionText, 20000, 1000);
    if (!resetConfirmed) {
      logWithTimestamp(
        `[ERROR] ❌ Reset not confirmed for level ${levelLabel} mission`,
      );
      return false;
    }

    logWithTimestamp(
      `[DEBUG] ✓ Reset complete, mission now at level 1 (${levelLabel})`,
    );
    return true;
  } else {
    logWithTimestamp("[ERROR] ❌ Reset button not found");
    return false;
  }
}

async function autoResetAndStartMissions(missions, levelLabel) {
  for (const mission of missions) {
    logWithTimestamp(
      `[DEBUG] Auto-resetting level ${levelLabel} mission: ${mission.text}`,
    );

    if (await clickMission(mission.text)) {
      logWithTimestamp(
        `[DEBUG] ✓ Level ${levelLabel} mission clicked: ${mission.text}`,
      );

      const missionLoaded = await waitForMissionToLoad(mission.text, 8000);
      if (!missionLoaded) {
        logWithTimestamp(
          `[ERROR] ❌ Mission detail did not load: ${mission.text}`,
        );
        continue;
      }

      const resetSuccess = await selectNFTAndStartMission(
        mission.text,
        levelLabel,
        true,
      );
      if (resetSuccess) {
        logWithTimestamp(
          `[INFO] ✅ Level ${levelLabel} mission auto-reset: ${mission.text}`,
        );
        logWithTimestamp(
          `[DEBUG] Mission reset to level 1, now starting mission...`,
        );

        // Give UI a moment to settle after reset confirmation
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Click the mission again to open it
        if (await clickMission(mission.text)) {
          logWithTimestamp(
            `[DEBUG] ✓ Re-clicked reset mission: ${mission.text}`,
          );

          const missionReloaded = await waitForMissionToLoad(
            mission.text,
            8000,
          );
          if (missionReloaded) {
            // Start the newly reset mission (level should now be 1)
            const startSuccess = await selectNFTAndStartMission(
              mission.text,
              "1",
              false,
            );
            if (startSuccess) {
              logWithTimestamp(
                `[INFO] ✅ Level ${levelLabel} mission reset and started: ${mission.text}`,
              );
            } else {
              logWithTimestamp(
                `[ERROR] ❌ Failed to start reset mission: ${mission.text}`,
              );
            }
          }
        }
      } else {
        logWithTimestamp(`[ERROR] ❌ Failed to auto-reset: ${mission.text}`);
      }
    } else {
      logWithTimestamp(`[ERROR] ❌ Failed to click mission: ${mission.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function attemptSelectAndStartMissionFromCurrentCollection(
  missionText,
  missionLevel,
) {
  // TEMPORARY STABILITY:
  // Give filtered NFT results time to render before selecting.
  await waitForNftResultsToLoad(600, 8, 250);

  // Normal mission start logic - select NFT and start
  const nftResult = await page.evaluate((level) => {
    const nftContainer = document.querySelector(
      'div.grid.grid-cols-2, div[class*="grid-cols-2"]',
    );

    if (!nftContainer) {
      return { status: "NO_CONTAINER", nftName: "" };
    }

    let selectedNFT;

    // For level 5/10/15: prefer TKM, fallback to any available (except 500k)
    if (["5", "10", "15"].includes(level)) {
      selectedNFT = Array.from(nftContainer.children).find((item) => {
        if (item.classList.contains("grayscale")) return false;
        const text = item.textContent || "";
        return text.includes("TKM") || text.includes("100k");
      });

      if (!selectedNFT) {
        selectedNFT = Array.from(nftContainer.children).find((item) => {
          if (item.classList.contains("grayscale")) return false;
          const text = item.textContent || "";
          return !text.includes("500k");
        });
      }
    } else if (level === "20") {
      // For level 20: only 500k or 100k
      selectedNFT = Array.from(nftContainer.children).find((item) => {
        if (item.classList.contains("grayscale")) return false;
        const text = item.textContent || "";
        return text.includes("500k") || text.includes("100k");
      });
    } else {
      // For normal missions: prefer Morbie > TKM > other (never 500k)
      selectedNFT = Array.from(nftContainer.children).find((item) => {
        if (item.classList.contains("grayscale")) return false;
        const text = item.textContent || "";
        return (
          !text.includes("500k") &&
          !text.includes("TKM") &&
          !text.includes("100k")
        );
      });

      if (!selectedNFT) {
        selectedNFT = Array.from(nftContainer.children).find((item) => {
          if (item.classList.contains("grayscale")) return false;
          const text = item.textContent || "";
          return text.includes("TKM") || text.includes("100k");
        });
      }

      if (!selectedNFT) {
        selectedNFT = Array.from(nftContainer.children).find((item) => {
          if (item.classList.contains("grayscale")) return false;
          const text = item.textContent || "";
          return !text.includes("500k");
        });
      }
    }

    if (selectedNFT) {
      let nftName = selectedNFT.querySelector("span")
        ? selectedNFT.querySelector("span").textContent.trim()
        : selectedNFT.textContent.trim();
      selectedNFT.click();
      return { status: "NFT_SELECTED", nftName: nftName };
    }

    return { status: "NO_NFT_FOUND", nftName: "" };
  }, missionLevel);

  if (
    nftResult.status === "NO_NFT_FOUND" ||
    nftResult.status === "NO_CONTAINER"
  ) {
    logWithTimestamp(
      `[DEBUG] No available NFTs, skipping mission start for: ${missionText}`,
    );
    return { ok: false, reason: nftResult.status };
  }

  logWithTimestamp(`[DEBUG] ✓ NFT selected: ${nftResult.nftName}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Click start mission button (with extra diagnostics if missing)
  const startResult = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const startBtn = buttons.find(
      (b) =>
        b.textContent && b.textContent.toLowerCase().includes("start mission"),
    );
    if (startBtn) {
      try {
        startBtn.click();
      } catch (e) {
        // ignore click errors
      }
      return { ok: true };
    }

    // Collect diagnostics: button texts and a small NFT grid snapshot
    const buttonTexts = buttons.map((b) =>
      (b.textContent || "").trim().slice(0, 120),
    );
    const nftGrid = (() => {
      const grid = document.querySelector('div[class*="grid"]');
      return grid ? grid.outerHTML.slice(0, 2000) : "";
    })();

    return { ok: false, buttons: buttonTexts, nftGrid };
  });

  if (startResult && startResult.ok) {
    logWithTimestamp("[DEBUG] ✓ Mission started successfully");
    return { ok: true };
  }

  logWithTimestamp("[ERROR] ❌ Start mission button not found");
  if (startResult && startResult.buttons) {
    logWithTimestamp(
      `[DEBUG] Buttons on page: ${JSON.stringify(startResult.buttons)}`,
    );
  }
  if (startResult && startResult.nftGrid) {
    logWithTimestamp(
      `[DEBUG] NFT grid snapshot (truncated): ${startResult.nftGrid.slice(
        0,
        500,
      )}`,
    );
  }
  return { ok: false, reason: "START_BUTTON_NOT_FOUND" };
}

async function selectNFTAndStartMission(
  missionText = "mission",
  missionLevel = "",
  forceReset = false,
) {
  if (!(await ensurePage())) return false;
  const missionName = String(missionText || "").trim();
  const normalizedMissionName = missionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const isTempDoItAllMission =
    TEMP_COLLECTION_REQUIREMENTS_ENABLED &&
    (missionName === "Do it All!" ||
      normalizedMissionName.includes("do it all"));
  const isTempRaceForPointsMission =
    TEMP_COLLECTION_REQUIREMENTS_ENABLED &&
    (missionName === "Race For Points" ||
      normalizedMissionName.includes("race for points"));
  const isAnyTempCollectionMission =
    isTempDoItAllMission || isTempRaceForPointsMission;
  let shouldRestoreTempCollectionFilter = false;
  let tempRefreshPauseAcquired = false;
  let raceFallbackApplied = false;

  try {
    // If forceReset is true, check if mission is at level 20 and reset it first
    if (forceReset && missionLevel === "20") {
      logWithTimestamp("[DEBUG] Resetting level 20 mission...");
      return await performMissionReset("20", missionText);
    }

    // If forceReset is true and mission is at target level (mission mode), reset it
    if (forceReset && missionLevel === currentMissionResetLevel) {
      logWithTimestamp(
        `[DEBUG] Resetting level ${currentMissionResetLevel} mission (mission mode)...`,
      );
      return await performMissionReset(currentMissionResetLevel, missionText);
    }

    // Enforce reset modes before any NFT selection so we never spend an NFT
    // on a mission that should have been reset first.
    if (!forceReset) {
      const missionLevelNum = parseInt(
        String(missionLevel).match(/\d+/)?.[0],
        10,
      );
      const missionModeLevelNum = parseInt(
        String(currentMissionResetLevel).match(/\d+/)?.[0],
        10,
      );
      const mustReset20 =
        level20ResetEnabled &&
        Number.isFinite(missionLevelNum) &&
        missionLevelNum >= 20;
      const mustResetMissionMode =
        missionModeEnabled &&
        Number.isFinite(missionLevelNum) &&
        Number.isFinite(missionModeLevelNum) &&
        missionLevelNum >= missionModeLevelNum;

      if (mustReset20 || mustResetMissionMode) {
        const resetLevelLabel = mustReset20 ? "20" : currentMissionResetLevel;
        logWithTimestamp(
          `[DEBUG] Pre-start reset required at level ${missionLevel} (${resetLevelLabel}) for: ${missionText}`,
        );

        const resetOk = await selectNFTAndStartMission(
          missionText,
          resetLevelLabel,
          true,
        );
        if (!resetOk) return false;

        // Re-open the mission and start the freshly reset level-1 run.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!(await clickMission(missionText))) {
          logWithTimestamp(
            `[ERROR] ❌ Failed to re-open mission after pre-start reset: ${missionText}`,
          );
          return false;
        }
        const reloaded = await waitForMissionToLoad(missionText, 8000);
        if (!reloaded) {
          logWithTimestamp(
            `[ERROR] ❌ Mission did not reload after pre-start reset: ${missionText}`,
          );
          return false;
        }

        return await selectNFTAndStartMission(missionText, "1", false);
      }
    }

    if (isAnyTempCollectionMission) {
      temporaryCollectionFlowPauseCount += 1;
      tempRefreshPauseAcquired = true;
      logWithTimestamp(
        `[DEBUG][TEMP] Pausing watch/refresh while handling temp collection mission: ${missionText}`,
      );
    }

    // TEMPORARY SECTION:
    // Mission-specific temporary collection handling:
    // - "Do it All!" => Great Goats
    // - "Race For Points" => Morbies, fallback to The Known Marbler if 0 results
    if (isTempDoItAllMission) {
      shouldRestoreTempCollectionFilter = true;
      const collectionSetResult =
        await setCollectionFilterOption("Great Goats");

      if (collectionSetResult && collectionSetResult.ok) {
        logWithTimestamp(
          `[DEBUG][TEMP] Applied collection filter "Great Goats" for: ${missionText}`,
        );
        const goatsCount = await waitForNftResultsToLoad(600, 10, 250);
        logWithTimestamp(
          `[DEBUG][TEMP] Do it All results count with Great Goats: ${goatsCount}`,
        );
      } else {
        logWithTimestamp(
          `[ERROR][TEMP] Failed to apply "Great Goats" collection filter for: ${missionText} (${collectionSetResult?.reason || "UNKNOWN_ERROR"})`,
        );
      }
    } else if (isTempRaceForPointsMission) {
      shouldRestoreTempCollectionFilter = true;
      const morbiesResult = await setCollectionFilterOption("Morbies");
      if (morbiesResult && morbiesResult.ok) {
        logWithTimestamp(
          `[DEBUG][TEMP] Applied collection filter "Morbies" for: ${missionText}`,
        );
        await waitForNftResultsToLoad(600, 8, 250);
      } else {
        logWithTimestamp(
          `[ERROR][TEMP] Failed to apply "Morbies" collection filter for: ${missionText} (${morbiesResult?.reason || "UNKNOWN_ERROR"})`,
        );
      }

      const morbiesResultCount = await getAvailableNftCountWithRetry(10, 250);
      logWithTimestamp(
        `[DEBUG][TEMP] Race For Points result count with Morbies: ${morbiesResultCount}`,
      );
      if (morbiesResultCount === 0) {
        const tkmResult = await setCollectionFilterOption("The Known Marbler");
        raceFallbackApplied = true;
        if (tkmResult && tkmResult.ok) {
          logWithTimestamp(
            `[DEBUG][TEMP] Morbies had 0 results; switched to "The Known Marbler" for: ${missionText}`,
          );
          await waitForNftResultsToLoad(600, 8, 250);
        } else {
          logWithTimestamp(
            `[ERROR][TEMP] Failed to apply "The Known Marbler" fallback filter for: ${missionText} (${tkmResult?.reason || "UNKNOWN_ERROR"})`,
          );
        }
      }
    }

    let startAttempt = await attemptSelectAndStartMissionFromCurrentCollection(
      missionText,
      missionLevel,
    );

    // TEMPORARY SECTION:
    // Race For Points fallback when Morbies had items but none selectable.
    if (
      isTempRaceForPointsMission &&
      !startAttempt.ok &&
      !raceFallbackApplied &&
      (startAttempt.reason === "NO_NFT_FOUND" ||
        startAttempt.reason === "NO_CONTAINER")
    ) {
      const tkmResult = await setCollectionFilterOption("The Known Marbler");
      raceFallbackApplied = true;
      if (tkmResult && tkmResult.ok) {
        logWithTimestamp(
          `[DEBUG][TEMP] Race For Points fallback: switched to "The Known Marbler" after no selectable Morbies NFT`,
        );
        await waitForNftResultsToLoad(600, 8, 250);
        startAttempt = await attemptSelectAndStartMissionFromCurrentCollection(
          missionText,
          missionLevel,
        );
      } else {
        logWithTimestamp(
          `[ERROR][TEMP] Race For Points fallback failed to set "The Known Marbler" (${tkmResult?.reason || "UNKNOWN_ERROR"})`,
        );
      }
    }

    return Boolean(startAttempt && startAttempt.ok);
  } catch (error) {
    logWithTimestamp(
      `[ERROR] Error selecting NFT/starting mission: ${error.message}`,
    );
    return false;
  } finally {
    // TEMPORARY SECTION:
    // Always reset collection filter after temporary mission handling.
    if (isAnyTempCollectionMission && shouldRestoreTempCollectionFilter) {
      try {
        const collectionClearResult = await setCollectionFilterOption(
          "Clear Filter (Collection)",
        );

        if (collectionClearResult && collectionClearResult.ok) {
          logWithTimestamp(
            `[DEBUG][TEMP] Cleared collection filter after: ${missionText}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          logWithTimestamp(
            `[ERROR][TEMP] Failed to clear collection filter after: ${missionText} (${collectionClearResult?.reason || "UNKNOWN_ERROR"})`,
          );
        }
      } catch (clearErr) {
        logWithTimestamp(
          `[ERROR][TEMP] Error clearing temporary collection filter: ${clearErr.message}`,
        );
      }
    }

    if (tempRefreshPauseAcquired) {
      temporaryCollectionFlowPauseCount = Math.max(
        0,
        temporaryCollectionFlowPauseCount - 1,
      );
      logWithTimestamp(
        `[DEBUG][TEMP] Resumed watch/refresh after temp collection mission: ${missionText}`,
      );
    }
  }
}

async function setCollectionFilterOption(optionLabel) {
  if (!(await ensurePage())) {
    return { ok: false, reason: "PAGE_NOT_READY" };
  }

  const attemptSetCollection = async () =>
    await page.evaluate(async (targetLabel) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalizedTarget = String(targetLabel || "")
        .trim()
        .toLowerCase();
      const isClearRequest =
        normalizedTarget === "clear all" ||
        normalizedTarget.startsWith("clear filter");

      const textMatchesTarget = (textValue, label) => {
        const text = String(textValue || "").trim();
        const normalizedText = text.toLowerCase();
        const normalizedLabel = String(label || "")
          .trim()
          .toLowerCase();

        if (!normalizedText) return false;

        if (isClearRequest) {
          if (normalizedText === "clear filter") return true;
          if (normalizedText === "clear all") return true;
          if (normalizedText === "clear filters") return true;
          if (
            normalizedText.includes("clear") &&
            normalizedText.includes("all")
          )
            return true;
          if (
            normalizedText.includes("clear") &&
            normalizedText.includes("filter")
          )
            return true;
          return false;
        }

        return normalizedText === normalizedLabel;
      };

      const collectVisibleOptionTexts = () => {
        const wrappers = Array.from(
          document.querySelectorAll("div[data-radix-popper-content-wrapper]"),
        );
        const values = [];
        for (const wrapper of wrappers) {
          const nodes = Array.from(
            wrapper.querySelectorAll(
              "button, [role='menuitem'], [role='option'], [role='menuitemcheckbox'], [role='button'], label",
            ),
          );
          for (const node of nodes) {
            const text = (node.textContent || "").trim();
            if (text && !values.includes(text)) values.push(text);
          }
        }
        return values.slice(0, 40);
      };

      const isElementVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === "none") return false;
        if (style.visibility === "hidden") return false;
        if (style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const clickCollectionOption = (label) => {
        const wrappers = Array.from(
          document.querySelectorAll("div[data-radix-popper-content-wrapper]"),
        );

        for (const wrapper of wrappers) {
          if (!isElementVisible(wrapper)) continue;
          const optionRows = Array.from(
            wrapper.querySelectorAll(
              "[role='option'][data-radix-collection-item]",
            ),
          );
          const option = optionRows.find((row) => {
            const labelledBy = row.getAttribute("aria-labelledby");
            const labelNode = labelledBy
              ? document.getElementById(labelledBy)
              : null;
            const optionText = (
              labelNode?.textContent ||
              row.textContent ||
              ""
            ).trim();
            return textMatchesTarget(optionText, label);
          });
          if (option) {
            try {
              option.scrollIntoView({ block: "center", inline: "center" });
            } catch (e) {
              // ignore scroll errors
            }
            option.click();
            const labelledBy = option.getAttribute("aria-labelledby");
            const labelNode = labelledBy
              ? document.getElementById(labelledBy)
              : null;
            return {
              ok: true,
              clickedText: (
                labelNode?.textContent ||
                option.textContent ||
                ""
              ).trim(),
              clickedTag: option.tagName,
              clickedRole: option.getAttribute("role") || "",
            };
          }
        }
        return { ok: false };
      };

      const collectionBtn = document.querySelector(
        "button[aria-label='Collection'], [aria-label='Collection']",
      );
      if (!collectionBtn) {
        return { ok: false, reason: "COLLECTION_BUTTON_NOT_FOUND" };
      }

      let visibleOptions = [];
      for (let openAttempt = 0; openAttempt < 2; openAttempt += 1) {
        collectionBtn.click();
        // Give the popper time to mount before scanning options.
        await wait(500);

        for (let i = 0; i < 20; i += 1) {
          const clickResult = clickCollectionOption(targetLabel);
          if (clickResult.ok) {
            return {
              ok: true,
              clickedText: clickResult.clickedText,
              clickedTag: clickResult.clickedTag,
              openAttempt: openAttempt + 1,
            };
          }
          visibleOptions = collectVisibleOptionTexts();
          await wait(100);
        }
      }

      return {
        ok: false,
        reason: "OPTION_NOT_FOUND",
        options: visibleOptions,
        targetLabel,
      };
    }, optionLabel);

  const firstAttempt = await attemptSetCollection();
  if (firstAttempt && firstAttempt.ok) {
    return firstAttempt;
  }

  logWithTimestamp(
    `[DEBUG][TEMP] Collection switch failed for "${optionLabel}", refreshing and retrying once...`,
  );
  await refreshMissionsPage({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const secondAttempt = await attemptSetCollection();
  if (secondAttempt && secondAttempt.ok) {
    return secondAttempt;
  }

  return {
    ...(secondAttempt || {}),
    ok: false,
    reason:
      secondAttempt?.reason ||
      firstAttempt?.reason ||
      "OPTION_NOT_FOUND_AFTER_REFRESH_RETRY",
    firstAttempt,
  };
}

async function handleSolflarePopup(action = "approve") {
  try {
    // If the user has set a specific Solflare extension id in config.json,
    // prefer matching that exact id. Otherwise fall back to generic checks.
    const solflareId =
      config && config.solflareExtensionId ? config.solflareExtensionId : null;
    const pages = await browser.pages();
    const solflarePages = [];
    for (const p of pages) {
      const url = p.url();
      if (solflareId) {
        if (url.includes(solflareId)) {
          solflarePages.push(p);
        }
        continue;
      }
      let title = "";
      try {
        title = await p.title();
      } catch (e) {
        title = "";
      }
      if (
        url.includes("solflare") ||
        url.includes("wallet") ||
        url.includes("chrome-extension://") ||
        (title && title.toLowerCase().includes("solflare"))
      ) {
        solflarePages.push(p);
      }
    }

    if (solflarePages.length === 0) {
      // Also check for popup windows by looking for small viewport sizes
      const popupPages = pages.filter((p) => {
        try {
          const viewport = p.viewport();
          return viewport && (viewport.width < 600 || viewport.height < 400);
        } catch (e) {
          return false;
        }
      });

      if (popupPages.length === 0) {
        logWithTimestamp("[DEBUG] No Solflare popup found");
        return false;
      }
      // If a specific extension id is configured, do not attempt content-based
      // popup detection (too many unrelated extension popups). Require the
      // exact id to be present to proceed.
      if (solflareId) {
        logWithTimestamp(
          "[DEBUG] Configured Solflare id set but no matching extension tab found",
        );
        return false;
      }

      logWithTimestamp(
        "[DEBUG] Found potential popup window, checking for Solflare...",
      );
      const solPage = popupPages[0];

      // Check if it contains Solflare elements without bringing to front
      const isSolflare = await solPage.evaluate(() => {
        return (
          document.body.textContent.toLowerCase().includes("solflare") ||
          document.title.toLowerCase().includes("solflare") ||
          document.querySelector('[data-testid*="solflare"]') !== null
        );
      });

      if (!isSolflare) {
        logWithTimestamp("[DEBUG] Popup found but not Solflare");
        return false;
      }

      logWithTimestamp("[DEBUG] Found Solflare popup by content detection");
      solflarePages.push(solPage);
    }

    const solPage = solflarePages[0];
    // Don't bring to front - work in background like AppleScript

    const buttonText = action === "approve" ? "approve" : "reject";
    const result = await solPage.evaluate((buttonText) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const targetButton = buttons.find((btn) =>
        btn.textContent.toLowerCase().includes(buttonText),
      );

      if (targetButton) {
        targetButton.click();
        return true;
      }
      return false;
    }, buttonText);

    if (result) {
      logWithTimestamp(`[INFO] ✅ Solflare ${action} clicked (background)`);
      return true;
    } else {
      logWithTimestamp(`[ERROR] ❌ Solflare ${action} button not found`);
      return false;
    }
  } catch (error) {
    logWithTimestamp(`[ERROR] Error handling Solflare popup: ${error.message}`);
    return false;
  }
}

// Main mission automation
async function startMissions() {
  try {
    if (isRunning) {
      logWithTimestamp("[DEBUG] startMissions already running, skipping");
      return;
    }
    isRunning = true;
    logWithTimestamp("[INFO] Starting mission automation...");

    const allMissions = await getAllMissions();
    if (allMissions.length === 0) {
      logWithTimestamp("[ERROR] No missions found");
      return;
    }

    // Filter for claimable missions first (using EXACT same logic as original)
    const claimableMissions = filterClaimableMissions(allMissions);

    // Filter for available missions to start (using EXACT same logic as original)
    // EXCLUDE level 20 missions - they must be manually reset with reset20 command
    // EXCLUDE level 11 missions when mission mode is enabled - they must be auto-reset
    const availableToStartMissions = filterAvailableMissions(allMissions, {
      targetMissions: TARGET_MISSIONS,
      excludeLevel20: level20ResetEnabled,
      excludeMissionLevel: missionModeEnabled,
      missionResetLevel: currentMissionResetLevel,
    });

    // Check for level 20 missions when level 20 reset is enabled
    const level20MissionsToReset = level20ResetEnabled
      ? filterMissionsToReset(allMissions, "20")
      : [];

    // Check for missions at target level when in mission mode
    const levelMissionsToReset = missionModeEnabled
      ? filterMissionsToReset(allMissions, currentMissionResetLevel)
      : [];

    // If level 20 reset is on and we found level 20 missions, reset them first
    if (level20ResetEnabled && level20MissionsToReset.length > 0) {
      logWithTimestamp(
        `[INFO] Level 20 reset active: Found ${level20MissionsToReset.length} level 20 mission(s) to reset`,
      );

      await autoResetAndStartMissions(level20MissionsToReset, "20");

      logWithTimestamp("[INFO] Level 20 auto-reset complete, continuing...");
    }

    // If mission mode is on and we found missions at target level, reset them first
    if (missionModeEnabled && levelMissionsToReset.length > 0) {
      logWithTimestamp(
        `[INFO] Mission mode active: Found ${levelMissionsToReset.length} level ${currentMissionResetLevel} mission(s) to reset`,
      );

      await autoResetAndStartMissions(
        levelMissionsToReset,
        currentMissionResetLevel,
      );

      logWithTimestamp(
        `[INFO] Level ${currentMissionResetLevel} auto-reset complete, continuing...`,
      );
    }

    // Get NFT count (like original)
    const totalAvailableNFTs = await getAvailableNftCount();
    if (totalAvailableNFTs > 0) {
      logWithTimestamp(
        `[DEBUG] NFT count from 'of # results' text returned: ${totalAvailableNFTs}`,
      );
    }

    // Update mission stats
    currentMissionStats.total = allMissions.length;
    currentMissionStats.claimable = claimableMissions.length;
    currentMissionStats.available = availableToStartMissions.length;
    currentMissionStats.active = allMissions.filter(
      (m) => m.alreadyStarted,
    ).length;
    currentMissionStats.completed = allMissions.filter(
      (m) => m.completed,
    ).length;
    currentMissionStats.nfts = totalAvailableNFTs;

    // CRITICAL CHECK 1: No missions available to start or claim (like original)
    if (
      availableToStartMissions.length === 0 &&
      claimableMissions.length === 0
    ) {
      logWithTimestamp("[INFO] No missions available to start or claim");
      return;
    }

    // CRITICAL CHECK 2: No NFTs available (like original)
    if (totalAvailableNFTs === 0) {
      logWithTimestamp(
        "[INFO] No NFTs available, skipping all mission starts.",
      );
      return;
    }

    // Process ALL claimable missions first (like original)
    while (claimableMissions.length > 0) {
      const mission = claimableMissions[0];
      logWithTimestamp(`[DEBUG] Claimable mission detected: ${mission.text}`);

      if (await clickMission(mission.text)) {
        logWithTimestamp(
          `[DEBUG] ✓ Step 1: Claimable mission container clicked: ${mission.text}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1250));
        if (await claimReward()) {
          logWithTimestamp(
            `[DEBUG] ✓ Step 2: Claimed reward for: ${mission.text}`,
          );
          currentMissionStats.claimed++;
          currentMissionStats.totalClaimed++;

          // Save updated count to config
          config.totalClaimed = currentMissionStats.totalClaimed;
          fs.writeFileSync(
            path.join(__dirname, "config.json"),
            JSON.stringify(config, null, 2),
          );

          logWithTimestamp(`[INFO] ✅ Mission claimed: ${mission.text}`);

          // Immediately redraw header to reflect updated claimed count (like original)
          redrawHeaderAndLog(currentMissionStats);

          // Wait 7.5 seconds after claim (like original)
          await new Promise((resolve) => setTimeout(resolve, 7500));

          // Refresh mission list after claim to get updated states (like original)
          logWithTimestamp("[DEBUG] Refreshing mission list after claim...");

          // Wait a bit longer for UI to fully update before refreshing
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const refreshedMissions = await getAllMissions();

          // Update arrays with fresh data (like original)
          const newClaimableMissions =
            filterClaimableMissions(refreshedMissions);
          const newAvailableToStartMissions = filterAvailableMissions(
            refreshedMissions,
            {
              targetMissions: TARGET_MISSIONS,
              excludeLevel20: level20ResetEnabled,
              excludeMissionLevel: missionModeEnabled,
              missionResetLevel: currentMissionResetLevel,
            },
          );

          // Clear and repopulate arrays (like original)
          claimableMissions.length = 0;
          availableToStartMissions.length = 0;
          claimableMissions.push(...newClaimableMissions);
          availableToStartMissions.push(...newAvailableToStartMissions);

          // Don't shift here - we already replaced the array with fresh data
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        } else {
          logWithTimestamp(
            `[ERROR] ❌ Failed to claim mission: ${mission.text}`,
          );
        }
      } else {
        logWithTimestamp(
          `[ERROR] ❌ Failed to click claimable mission: ${mission.text}`,
        );
      }

      // Only shift if we didn't refresh the list (failed to claim)
      claimableMissions.shift();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Check again after claiming if there are missions to start (like original)
    if (
      availableToStartMissions.length === 0 &&
      claimableMissions.length === 0
    ) {
      logWithTimestamp("[INFO] No missions available to start or claim");
      return;
    }

    // IMPORTANT: After claiming, check if any missions became level 20 and need reset
    if (level20ResetEnabled) {
      // Re-fetch missions to get updated levels after claims
      const postClaimMissions = await getAllMissions();
      const newLevel20MissionsToReset = filterMissionsToReset(
        postClaimMissions,
        "20",
      );

      if (newLevel20MissionsToReset.length > 0) {
        logWithTimestamp(
          `[INFO] Level 20 reset mode: Found ${newLevel20MissionsToReset.length} level 20 mission(s) after claiming (need reset before starting)`,
        );

        await autoResetAndStartMissions(newLevel20MissionsToReset, "20");

        logWithTimestamp(
          "[INFO] Post-claim level 20 auto-reset and start complete",
        );
      }
    }

    // IMPORTANT: After claiming, check if any missions reached target level and need reset
    if (missionModeEnabled) {
      // Re-fetch missions to get updated levels after claims
      const postClaimMissions = await getAllMissions();
      const newLevelMissionsToReset = filterMissionsToReset(
        postClaimMissions,
        currentMissionResetLevel,
      );

      if (newLevelMissionsToReset.length > 0) {
        logWithTimestamp(
          `[INFO] Mission mode: Found ${newLevelMissionsToReset.length} level ${currentMissionResetLevel} mission(s) after claiming (need reset before starting)`,
        );

        await autoResetAndStartMissions(
          newLevelMissionsToReset,
          currentMissionResetLevel,
        );

        logWithTimestamp(
          `[INFO] Post-claim level ${currentMissionResetLevel} auto-reset and start complete`,
        );
      }
    }

    if (totalAvailableNFTs === 0) {
      logWithTimestamp(
        "[INFO] No NFTs available, skipping all mission starts.",
      );
      return;
    }

    // Process available missions to start (like original)
    for (const mission of availableToStartMissions) {
      logWithTimestamp(`[DEBUG] Starting mission: ${mission.text}`);

      // CRITICAL: Validate mission is in TARGET_MISSIONS before starting (like original)
      const isTargetMission = TARGET_MISSIONS.some((target) =>
        mission.text.includes(target),
      );
      if (!isTargetMission) {
        logWithTimestamp(
          `[ERROR] ❌ Mission "${mission.text}" is NOT in TARGET_MISSIONS array. Skipping start.`,
        );
        continue;
      }

      // Step 1: Click the specific mission (with detailed logging like original)
      if (await clickMission(mission.text)) {
        logWithTimestamp(`[DEBUG] ✓ Step 1: Mission clicked: ${mission.text}`);

        // Wait for mission to load (replace fixed delay with active wait)
        const missionLoaded = await waitForMissionToLoad(mission.text, 8000);
        if (!missionLoaded) {
          logWithTimestamp(
            `[ERROR] ❌ Mission detail did not load in time for: ${mission.text}`,
          );
          continue;
        }

        // Check live mission state (already-started + current level)
        const missionState = await page.evaluate(
          (missionText, selectors) => {
            const {
              missionButtonSelector,
              missionLevelBadgeSelector,
              missionLevelContainerSelector,
              missionStatusTextSelector,
            } = selectors;
            const missionButtons = Array.from(
              document.querySelectorAll(missionButtonSelector),
            );

            const extractMissionName = (button) => {
              const levelContainer = button.querySelector(
                missionLevelContainerSelector,
              );
              const statusSpan = button.querySelector(
                missionStatusTextSelector,
              );
              const textCandidates = Array.from(
                button.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
              )
                .map((el) => ({
                  el,
                  text: el.textContent?.trim() || "",
                }))
                .filter(({ text }) => text);

              const nonLevel = textCandidates.find(({ el, text }) => {
                if (levelContainer && levelContainer.contains(el)) return false;
                if (statusSpan && statusSpan.contains(el)) return false;
                if (/^(level|lvl)\b/i.test(text)) return false;
                if (/^\d+$/.test(text)) return false;
                return true;
              });
              if (nonLevel) return nonLevel.text;

              const lines = (button.innerText || "")
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .filter((l) => !/^(level|lvl)\b/i.test(l))
                .filter((l) => !/^\d+$/.test(l));
              return lines[0] || "";
            };

            for (const button of missionButtons) {
              const text = extractMissionName(button);
              if (text === missionText) {
                const statusText =
                  button.querySelector(missionStatusTextSelector)
                    ?.textContent || "";
                const status = statusText
                  .replace(/\s+/g, " ")
                  .trim()
                  .toLowerCase();
                const levelText =
                  button.querySelector(missionLevelBadgeSelector)
                    ?.textContent || "";
                const level = String(levelText).trim();
                return {
                  alreadyStarted: status.includes("in progress"),
                  level,
                };
              }
            }
            return { alreadyStarted: false, level: "" };
          },
          mission.text,
          {
            missionButtonSelector: MISSION_BUTTON_SELECTOR,
            missionLevelBadgeSelector: MISSION_LEVEL_BADGE_SELECTOR,
            missionLevelContainerSelector: MISSION_LEVEL_CONTAINER_SELECTOR,
            missionStatusTextSelector: MISSION_STATUS_TEXT_SELECTOR,
          },
        );

        const alreadyStarted = Boolean(
          missionState && missionState.alreadyStarted,
        );
        const liveMissionLevel = String(
          missionState?.level || mission.level || "",
        );

        // Enforce reset modes on the live mission level before any mission-specific start logic.
        const liveLevelNum = parseInt(
          String(liveMissionLevel).match(/\d+/)?.[0],
          10,
        );
        const missionModeLevelNum = parseInt(
          String(currentMissionResetLevel).match(/\d+/)?.[0],
          10,
        );
        const shouldResetLevel20 =
          level20ResetEnabled &&
          Number.isFinite(liveLevelNum) &&
          liveLevelNum >= 20;
        const shouldResetMissionMode =
          missionModeEnabled &&
          Number.isFinite(liveLevelNum) &&
          Number.isFinite(missionModeLevelNum) &&
          liveLevelNum >= missionModeLevelNum;

        if (shouldResetLevel20 || shouldResetMissionMode) {
          const resetLabel = shouldResetLevel20
            ? "20"
            : currentMissionResetLevel;
          logWithTimestamp(
            `[DEBUG] Live mission level ${liveMissionLevel} requires reset (${resetLabel}) before start: ${mission.text}`,
          );
          await autoResetAndStartMissions(
            [{ ...mission, level: liveMissionLevel }],
            resetLabel,
          );
          continue;
        }

        if (alreadyStarted) {
          logWithTimestamp(
            `[DEBUG] Mission already started, skipping NFT selection`,
          );
          continue;
        }

        // Step 2: Select NFT and start mission (with detailed logging like original)
        // Don't pass level to avoid triggering reset logic for already-reset missions
        const missionLevel = liveMissionLevel;
        if (await selectNFTAndStartMission(mission.text, missionLevel, false)) {
          logWithTimestamp(
            `[DEBUG] ✓ Step 2: NFT selected for: ${mission.text}`,
          );
          logWithTimestamp(
            `[DEBUG] ✓ Step 3: Mission started successfully: ${mission.text}`,
          );
          logWithTimestamp(`[INFO] ✅ Mission started: ${mission.text}`);
        } else {
          logWithTimestamp(
            `[ERROR] ❌ Failed to select NFT or start mission: ${mission.text}`,
          );
        }
      } else {
        logWithTimestamp(`[ERROR] ❌ Failed to click mission: ${mission.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    logWithTimestamp("[INFO] All missions processed");

    // Start watching mode
    if (!isWatching) {
      logWithTimestamp("[DEBUG] Starting continuous watch mode...");
      await startWatching();
    }
  } catch (error) {
    logWithTimestamp(`[ERROR] Mission automation failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

async function startWatching() {
  if (isWatching) {
    logWithTimestamp("[WATCH] Already watching for mission changes");
    return;
  }

  isWatching = true;
  logWithTimestamp(
    `[INFO] Auto-refreshing mission page on ${PAGE_REFRESH_MINUTES}m tick...`,
  );
  logWithTimestamp(
    `[INFO] Watching missions with ${WATCH_INTERVAL_SECONDS}s tick...`,
  );

  // Wait 3.75 seconds before initial check to allow page to load (like original)
  await new Promise((resolve) => setTimeout(resolve, 3750));
  try {
    await checkAndStartMissions();
  } catch (error) {
    logWithTimestamp(`[ERROR] ❌ Error during initial check: ${error.message}`);
  }

  // Then check at configured interval (use an async loop instead of setInterval
  // to avoid lost ticks or overlapping executions). This logs each tick so it's
  // visible in the UI when a scheduled check fires.
  let _watchLoopActive = true;
  watchInterval = (async function watchLoop() {
    while (_watchLoopActive && isWatching) {
      try {
        if (temporaryCollectionFlowPauseCount > 0) {
          logWithTimestamp(
            "[DEBUG][TEMP] Watch tick skipped while temporary collection flow is active",
          );
        } else {
          await checkAndStartMissions();
        }
      } catch (error) {
        logWithTimestamp(
          `[ERROR] ❌ Error during scheduled check: ${error.message}`,
        );
      }
      // Sleep until next tick (this prevents overlapping executions)
      await new Promise((resolve) =>
        setTimeout(resolve, WATCH_INTERVAL_SECONDS * 1000),
      );
    }
    return true;
  })();

  // Page refresh interval
  refreshInterval = setInterval(
    async () => {
      try {
        if (temporaryCollectionFlowPauseCount > 0) {
          logWithTimestamp(
            "[DEBUG][TEMP] Background refresh skipped while temporary collection flow is active",
          );
          return;
        }
        if (await ensurePage()) {
          // Refresh without changing focus - just reload the page content
          await page.reload({ waitUntil: "networkidle2" });
          logWithTimestamp("[DEBUG] Page refreshed (background)");

          // Check for missions after refresh
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await checkAndStartMissions();
        }
      } catch (error) {
        logWithTimestamp(`[ERROR] Refresh error: ${error.message}`);
      }
    },
    PAGE_REFRESH_MINUTES * 60 * 1000,
  );
}

async function checkAndStartMissions() {
  const missions = await getAllMissions();
  if (missions.length === 0) return;

  // Store previous stats for comparison (like original)
  const prevMissionStats = { ...currentMissionStats };

  // Get NFT count (like original)
  const totalAvailableNFTs = await getAvailableNftCount();

  // Update stats (targets only)
  const targetMissions = missions.filter((m) =>
    TARGET_MISSIONS.some((target) => m.text.includes(target)),
  );
  const claimableMissions = filterClaimableMissions(targetMissions);
  const availableMissions = filterAvailableMissions(targetMissions, {
    targetMissions: TARGET_MISSIONS,
    excludeLevel20: false,
    excludeMissionLevel: false,
  });

  // Check for missions that need resetting
  const level20MissionsToReset = level20ResetEnabled
    ? filterMissionsToReset(missions, "20")
    : [];
  const levelMissionsToReset = missionModeEnabled
    ? filterMissionsToReset(missions, currentMissionResetLevel)
    : [];

  // Debug logging for mission mode
  if (DEBUG_MODE && missionModeEnabled) {
    logWithTimestamp(
      `[DEBUG] Mission mode check: looking for level ${currentMissionResetLevel}+ missions. Found: ${levelMissionsToReset.length}`,
    );
    if (levelMissionsToReset.length > 0) {
      levelMissionsToReset.forEach((m) => {
        logWithTimestamp(
          `[DEBUG] Mission to reset: ${m.text} (Level ${m.level})`,
        );
      });
    }
  }

  const stats = {
    total: targetMissions.length,
    claimable: claimableMissions.length,
    available: availableMissions.length,
    active: targetMissions.filter((m) => m.alreadyStarted).length,
    completed: targetMissions.filter((m) => m.completed).length,
    nfts: totalAvailableNFTs,
  };

  currentMissionStats = {
    ...stats,
    claimed: currentMissionStats.claimed,
    totalClaimed:
      typeof config.totalClaimed === "number" ? config.totalClaimed : 0,
  };

  // Only log the summary if any count has changed (like original)
  if (
    prevMissionStats.total !== stats.total ||
    prevMissionStats.claimable !== stats.claimable ||
    prevMissionStats.available !== stats.available ||
    prevMissionStats.active !== stats.active ||
    prevMissionStats.nfts !== stats.nfts
  ) {
    logWithTimestamp(
      `[INFO] 🎯 ${stats.total} missions found: ` +
        `${stats.active} active, ` +
        `${stats.available} available, ` +
        `${stats.claimable} claimable, ` +
        `${stats.nfts} NFT`,
      currentMissionStats, // always use currentMissionStats for header
    );
  } else {
    // Add debug logging when no changes detected
    logWithTimestamp(
      `[DEBUG] Mission check: ${stats.total} total, ${stats.claimable} claimable, ${stats.available} available (no changes)`,
    );
  }

  if (claimableMissions.length > 0) {
    logWithTimestamp(
      `[INFO] Found ${claimableMissions.length} claimable missions`,
    );
    await startMissions();
  } else if (level20MissionsToReset.length > 0) {
    logWithTimestamp(
      `[INFO] Found ${level20MissionsToReset.length} level 20 missions to reset`,
    );
    await startMissions();
  } else if (levelMissionsToReset.length > 0) {
    logWithTimestamp(
      `[INFO] Found ${levelMissionsToReset.length} level ${currentMissionResetLevel}+ missions to reset`,
    );
    await startMissions();
  } else if (availableMissions.length > 0) {
    logWithTimestamp(
      `[INFO] Found ${availableMissions.length} available missions to start`,
    );
    await startMissions();
  } else {
    logWithTimestamp(
      `[DEBUG] No claimable or available missions found on this check`,
    );
  }
}

// Utility functions
function logWithTimestamp(message, stats) {
  if (message.includes("[DEBUG]") && !DEBUG_MODE) {
    return;
  }
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `[${timestamp}] ${message}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  redrawHeaderAndLog(stats || currentMissionStats);
}

// Wait for mission reset to complete. Confirms via level 1 badge or disabled reset button.
async function waitForMissionReset(
  missionText,
  timeoutMs = 20000,
  pollMs = 1000,
) {
  if (!(await ensurePage())) return false;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await page.evaluate(
        (missionText, selectors) => {
          const {
            missionButtonSelector,
            missionLevelBadgeSelector,
            missionLevelContainerSelector,
          } = selectors;

          const normalize = (value) =>
            (value || "").replace(/\s+/g, " ").trim().toLowerCase();

          const isResetButton = (btn) => {
            if (!btn) return false;
            const text = normalize(btn.textContent);
            const label = normalize(btn.getAttribute("aria-label"));
            return (
              text.includes("reset") ||
              text.includes("level 1") ||
              label.includes("reset")
            );
          };

          const pickFirstMatch = (nodeList) =>
            Array.from(nodeList || []).find((btn) => isResetButton(btn));

          let resetBtn = pickFirstMatch(
            document.querySelectorAll("button button"),
          );
          if (!resetBtn) {
            const flexContainer = document.querySelector(
              "div.p-4.flex.flex-col",
            );
            if (flexContainer) {
              resetBtn = pickFirstMatch(
                flexContainer.querySelectorAll("button"),
              );
            }
          }
          if (!resetBtn) {
            resetBtn = pickFirstMatch(document.querySelectorAll("button"));
          }

          const resetDisabled = (() => {
            if (!resetBtn) return false;
            return (
              resetBtn.disabled ||
              resetBtn.hasAttribute("disabled") ||
              resetBtn.classList.contains("disabled") ||
              resetBtn.getAttribute("aria-disabled") === "true" ||
              window.getComputedStyle(resetBtn).pointerEvents === "none"
            );
          })();

          let isLevel1 = false;
          if (missionText) {
            const missionButtons = Array.from(
              document.querySelectorAll(missionButtonSelector),
            );

            const extractMissionName = (button) => {
              const levelContainer = button.querySelector(
                missionLevelContainerSelector,
              );
              const statusSpan = button.querySelector(
                missionStatusTextSelector,
              );
              const textCandidates = Array.from(
                button.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
              )
                .map((el) => ({
                  el,
                  text: el.textContent?.trim() || "",
                }))
                .filter(({ text }) => text);

              const nonLevel = textCandidates.find(({ el, text }) => {
                if (levelContainer && levelContainer.contains(el)) return false;
                if (statusSpan && statusSpan.contains(el)) return false;
                if (/^(level|lvl)\b/i.test(text)) return false;
                if (/^\d+$/.test(text)) return false;
                return true;
              });
              if (nonLevel) return nonLevel.text;

              const lines = (button.innerText || "")
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .filter((l) => !/^(level|lvl)\b/i.test(l))
                .filter((l) => !/^\d+$/.test(l));
              return lines[0] || "";
            };

            for (const button of missionButtons) {
              const text = extractMissionName(button);
              if (text === missionText) {
                const badge = button.querySelector(missionLevelBadgeSelector);
                const levelText = badge ? badge.textContent.trim() : "";
                const levelMatch = String(levelText).match(/\d+/);
                const levelNum = levelMatch ? parseInt(levelMatch[0], 10) : NaN;
                isLevel1 = levelNum === 1;
                break;
              }
            }
          }

          return { isLevel1, resetDisabled };
        },
        missionText,
        {
          missionButtonSelector: MISSION_BUTTON_SELECTOR,
          missionLevelBadgeSelector: MISSION_LEVEL_BADGE_SELECTOR,
          missionLevelContainerSelector: MISSION_LEVEL_CONTAINER_SELECTOR,
          missionStatusTextSelector: MISSION_STATUS_TEXT_SELECTOR,
        },
      );

      if (status && (status.isLevel1 || status.resetDisabled)) {
        return true;
      }
    } catch (e) {
      // ignore and retry
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return false;
}

// Wait for mission detail to load after clicking a mission. This actively
// polls the DOM (start button, NFT grid, or mission title) up to a timeout
// instead of using a fixed sleep. Returns true if loaded, false on timeout.
async function waitForMissionToLoad(missionText, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const found = await page.evaluate((missionText) => {
        // Check for mission title in the mission detail area
        const titleMatches = Array.from(
          document.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
        ).some((el) => el.textContent && el.textContent.trim() === missionText);

        // Check for start mission button
        const hasStartButton = Array.from(
          document.querySelectorAll("button"),
        ).some(
          (b) =>
            b.textContent &&
            b.textContent.toLowerCase().includes("start mission"),
        );

        // Check for NFT grid container
        const hasNFTGrid =
          document.querySelector('div[class*="grid"] > div') !== null;

        return titleMatches && (hasStartButton || hasNFTGrid);
      }, missionText);

      if (found) return true;
    } catch (e) {
      // ignore and retry
    }
    // Small delay before retrying
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Command handler
function setupCommandHandler() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: lineCompleter,
  });

  // Tab completion for commands and variables (ported from goodboi.js)
  function lineCompleter(line) {
    // List of base commands
    const commands = [
      "clear",
      "h",
      "help",
      "connect",
      "launch",
      "c",
      "claim",
      "tcoll",
      "testcoll",
      "r",
      "refresh",
      "20r on",
      "20r off",
      "reset20",
      "mm",
      "mm on",
      "mm off",
      "reset11",
      "q",
      "quit",
      // Add more as needed
    ];
    // List of variables for 'set' command (if any)
    const variables = [
      // Add variable names if 'set' command is supported
    ];
    const trimmed = line.trim();
    // If user is typing 'set', suggest variables
    if (trimmed.startsWith("set ")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 2) {
        const hits = variables.filter((v) => v.startsWith(parts[1]));
        return [hits.length ? hits : variables, parts[1]];
      } else if (parts.length === 3) {
        const hits = variables.filter((v) => v.startsWith(parts[2]));
        return [hits.length ? hits : variables, parts[2]];
      }
    }
    // Otherwise, suggest base commands
    const hits = commands.filter((c) => c.startsWith(trimmed));
    return [hits.length ? hits : commands, trimmed];
  }

  // Make readline more robust against screen clearing
  rl.on("SIGINT", () => {
    rl.question("Are you sure you want to exit? (y/n) ", async (answer) => {
      if (answer.match(/^y(es)?$/i)) {
        logWithTimestamp(
          "[INFO] Disconnecting from Chrome...",
          currentMissionStats,
        );
        if (browser) {
          try {
            await browser.disconnect();
            logWithTimestamp(
              "[INFO] ✅ Disconnected from Chrome (Chrome stays open)",
              currentMissionStats,
            );
          } catch (e) {
            logWithTimestamp(
              "[DEBUG] Browser already disconnected",
              currentMissionStats,
            );
          }
        }
        logWithTimestamp("[INFO] Goodbye! 👋", currentMissionStats);
        process.exit(0);
      }
    });
  });

  redrawHeaderAndLog(currentMissionStats);

  rl.on("line", async (input) => {
    const rawCommand = input.trim();
    const command = rawCommand.toLowerCase();
    const mmLevelMatch = command.match(/^mm\s+(\d{1,3})$/);

    // Clear the input line and redraw to prevent display issues
    process.stdout.write("\x1b[2K\r");

    if (mmLevelMatch) {
      const nextLevel = mmLevelMatch[1];
      currentMissionResetLevel = String(nextLevel);
      missionModeEnabled = true;
      if (level20ResetEnabled) {
        level20ResetEnabled = false;
        config.level20ResetEnabled = false;
        logWithTimestamp(
          `[INFO] Level 20 reset auto-disabled (mission mode takes priority)`,
          currentMissionStats,
        );
      }
      config.missionModeEnabled = missionModeEnabled;
      config.missionResetLevel = currentMissionResetLevel;
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      } catch (e) {
        logWithTimestamp(
          `[ERROR] Failed to save config: ${e.message}`,
          currentMissionStats,
        );
      }
      logWithTimestamp(
        `[INFO] Mission mode set to level ${currentMissionResetLevel} and enabled`,
        currentMissionStats,
      );
      redrawHeaderAndLog(currentMissionStats);
      return;
    }

    switch (command) {
      case "clear":
        clearLogBuffer();
        logWithTimestamp("[INFO] Log buffer cleared.", currentMissionStats);
        break;
      case "h":
      case "help":
        logWithTimestamp("[HELP]", currentMissionStats);
        logWithTimestamp("[HELP] Available Commands:", currentMissionStats);
        logWithTimestamp(
          "[HELP] [clear] - Clear the log buffer under the header",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [c] claim - Start mission automation",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [connect] - Connect to existing Chrome browser tab",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [t] test - Test find special NFTs",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [tcoll] - TEMP: Test Collection -> Great Goats -> Clear Filter",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [l] levels - Debug print mission levels",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [r] refresh - Refresh missions page",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [20r on/off] - Toggle level 20 mission reset",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [reset20] - Manually reset all level 20 missions",
          currentMissionStats,
        );
        logWithTimestamp(
          `[HELP] [mm on/off] - Toggle mission mode (level ${currentMissionResetLevel} reset)`,
        );
        logWithTimestamp(
          `[HELP] [mm <level>] - Set mission mode level and enable mission mode`,
          currentMissionStats,
        );
        logWithTimestamp(
          `[HELP] [reset11] - Manually reset all level ${currentMissionResetLevel} missions`,
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [clear] - Clear the log buffer under the header",
          currentMissionStats,
        );
        logWithTimestamp(
          "[HELP] [q] quit - Exit the application",
          currentMissionStats,
        );
        logWithTimestamp("[HELP]", currentMissionStats);
        break;

      case "connect":
        await connectToExistingChrome();
        break;

      case "launch":
        logWithTimestamp(
          "[INFO] Launching Chrome with remote debugging...",
          currentMissionStats,
        );
        const launched = launchChromeWithRemoteDebugging();
        if (launched) {
          logWithTimestamp(
            "[INFO] ✅ Chrome launched successfully",
            currentMissionStats,
          );
          logWithTimestamp(
            "[INFO] Use 'connect' command to connect to it",
            currentMissionStats,
          );
        } else {
          logWithTimestamp(
            "[ERROR] ❌ Failed to launch Chrome",
            currentMissionStats,
          );
        }
        break;

      case "c":
        await startMissions();
        break;

      case "t":
      case "test":
        await testFindSpecialNFTs();
        break;

      case "tcoll":
      case "testcoll":
        await testTemporaryCollectionSwitch();
        break;

      case "l":
        await debugPrintMissionLevels();
        break;

      case "sf":
        await handleSolflarePopup("approve");
        break;

      case "r":
      case "refresh":
        await refreshMissionsPage();
        break;

      case "20r":
      case "20r on":
      case "20r off":
        if (command === "20r on") {
          level20ResetEnabled = true;
          // Auto-disable mission mode when level 20 reset is enabled
          if (missionModeEnabled) {
            missionModeEnabled = false;
            config.missionModeEnabled = false;
            logWithTimestamp(
              `[INFO] Mission mode auto-disabled (level 20 reset takes priority)`,
              currentMissionStats,
            );
          }
        } else if (command === "20r off") {
          level20ResetEnabled = false;
        } else {
          // Just "20r" - toggle
          level20ResetEnabled = !level20ResetEnabled;
          if (level20ResetEnabled && missionModeEnabled) {
            missionModeEnabled = false;
            config.missionModeEnabled = false;
            logWithTimestamp(
              `[INFO] Mission mode auto-disabled (level 20 reset takes priority)`,
              currentMissionStats,
            );
          }
        }
        config.level20ResetEnabled = level20ResetEnabled;
        try {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (e) {
          logWithTimestamp(
            `[ERROR] Failed to save config: ${e.message}`,
            currentMissionStats,
          );
        }
        logWithTimestamp(
          `[INFO] Level 20 reset mode: ${level20ResetEnabled ? "ON" : "OFF"}`,
          currentMissionStats,
        );
        break;

      case "reset20":
        await resetAllLevel20Missions();
        break;

      case "mm":
      case "mm on":
      case "mm off":
        if (command === "mm on") {
          missionModeEnabled = true;
          // Auto-disable level 20 reset when mission mode is enabled
          if (level20ResetEnabled) {
            level20ResetEnabled = false;
            config.level20ResetEnabled = false;
            logWithTimestamp(
              `[INFO] Level 20 reset auto-disabled (mission mode takes priority)`,
              currentMissionStats,
            );
          }
        } else if (command === "mm off") {
          missionModeEnabled = false;
        } else {
          // Just "mm" - toggle
          missionModeEnabled = !missionModeEnabled;
          if (missionModeEnabled && level20ResetEnabled) {
            level20ResetEnabled = false;
            config.level20ResetEnabled = false;
            logWithTimestamp(
              `[INFO] Level 20 reset auto-disabled (mission mode takes priority)`,
              currentMissionStats,
            );
          }
        }
        config.missionModeEnabled = missionModeEnabled;
        try {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (e) {
          logWithTimestamp(
            `[ERROR] Failed to save config: ${e.message}`,
            currentMissionStats,
          );
        }
        logWithTimestamp(
          `[INFO] Mission mode (level ${currentMissionResetLevel} reset): ${
            missionModeEnabled ? "ON" : "OFF"
          }`,
          currentMissionStats,
        );
        break;

      case "reset11":
        await resetAllLevel11Missions();
        break;

      case "q":
        logWithTimestamp(
          "[INFO] Disconnecting from Chrome...",
          currentMissionStats,
        );
        if (browser) {
          try {
            await browser.disconnect();
            logWithTimestamp(
              "[INFO] ✅ Disconnected from Chrome (Chrome stays open)",
              currentMissionStats,
            );
          } catch (e) {
            logWithTimestamp(
              "[DEBUG] Browser already disconnected",
              currentMissionStats,
            );
          }
        }
        logWithTimestamp("[INFO] Goodbye! 👋", currentMissionStats);
        process.exit(0);
        break;

      default:
        logWithTimestamp(
          `Unknown command: ${command}. Type 'h' for help.`,
          currentMissionStats,
        );
    }
    redrawHeaderAndLog(currentMissionStats);
  });
}

async function testNFTDetection() {
  if (!(await ensurePage())) {
    logWithTimestamp("[DEBUG] ❌ Not on missions page or Chrome not focused");
    return;
  }

  try {
    const nftCount = await page.evaluate(() => {
      const nftContainers = document.querySelectorAll(
        'div[class*="grid"] > div',
      );
      return nftContainers.length;
    });

    logWithTimestamp(
      `[TEST] Found ${nftCount} NFT containers`,
      currentMissionStats,
    );
  } catch (error) {
    logWithTimestamp(`[TEST] Error: ${error.message}`, currentMissionStats);
  }
}

// Test function to find special NFTs (like original)
async function testFindSpecialNFTs() {
  if (!(await ensurePage())) return;

  try {
    const result = await page.evaluate(() => {
      let nftContainer = document.querySelector(
        "div.w-full.flex.flex-col.gap-5.items-center",
      );
      if (nftContainer) {
        nftContainer = nftContainer.querySelector(
          'div[class*="grid"][class*="grid-cols-2"]',
        );
      }
      if (!nftContainer) {
        nftContainer = document.querySelector(
          'div.grid.grid-cols-2, div[class*="grid-cols-2"]',
        );
      }
      if (!nftContainer) {
        return JSON.stringify({
          found: false,
          reason: "NFT_CONTAINER_NOT_FOUND",
        });
      }

      const nftItems = Array.from(nftContainer.children).filter((item) => {
        if (item.classList.contains("grayscale")) return false;
        return true;
      });

      const specialNFTs = nftItems
        .filter((item) => {
          const text = item.textContent || "";
          return (
            text.includes("TKM") ||
            text.includes("100k") ||
            text.includes("500k")
          );
        })
        .map((item) => item.textContent || "");

      if (specialNFTs.length > 0) {
        return JSON.stringify({
          found: true,
          items: specialNFTs,
          count: specialNFTs.length,
        });
      } else {
        return JSON.stringify({ found: false });
      }
    });

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      logWithTimestamp(
        `[TESTSPECIAL] ❌ JSON parse error: ${result}`,
        currentMissionStats,
      );
      return;
    }

    if (parsed.found && Array.isArray(parsed.items)) {
      logWithTimestamp(
        `[TESTSPECIAL] ✅ Found ${parsed.count} special NFT(s):`,
        currentMissionStats,
      );
      parsed.items.forEach((nftText, idx) => {
        logWithTimestamp(
          `[TESTSPECIAL] #${idx + 1}: ${nftText}`,
          currentMissionStats,
        );
      });
    } else {
      logWithTimestamp(
        "[TESTSPECIAL] ❌ No special NFTs found",
        currentMissionStats,
      );
    }
  } catch (error) {
    logWithTimestamp(
      `[TESTSPECIAL] ❌ Error: ${error.message}`,
      currentMissionStats,
    );
  }
}

// TEMPORARY TEST HELPER:
// Manual command to verify the collection picker flow works.
async function testTemporaryCollectionSwitch() {
  if (!(await ensurePage())) return;

  try {
    logWithTimestamp(
      `[TESTTEMP] Setting collection filter to "Great Goats"...`,
      currentMissionStats,
    );
    const toGoats = await setCollectionFilterOption("Great Goats");
    if (!toGoats || !toGoats.ok) {
      logWithTimestamp(
        `[TESTTEMP] ❌ Could not set "Great Goats" (${toGoats?.reason || "UNKNOWN_ERROR"})`,
        currentMissionStats,
      );
      return;
    }
    logWithTimestamp(
      `[TESTTEMP] ✅ "Great Goats" selected`,
      currentMissionStats,
    );

    await new Promise((resolve) => setTimeout(resolve, 2000));

    logWithTimestamp(
      `[TESTTEMP] Clearing collection filter...`,
      currentMissionStats,
    );
    // TEMPORARY TEST FLOW:
    // Refresh first, then clear, to match current UI behavior.
    await refreshMissionsPage();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const clear = await setCollectionFilterOption("Clear Filter (Collection)");

    if (!clear || !clear.ok) {
      logWithTimestamp(
        `[TESTTEMP] ❌ Could not clear filter (${clear?.reason || "UNKNOWN_ERROR"}) options=${JSON.stringify(clear?.options || [])}`,
        currentMissionStats,
      );
      return;
    }

    logWithTimestamp(
      `[TESTTEMP] ✅ Cleared collection filter`,
      currentMissionStats,
    );
  } catch (error) {
    logWithTimestamp(
      `[TESTTEMP] ❌ Error: ${error.message}`,
      currentMissionStats,
    );
  }
}

// Debug print mission levels (like original)
async function debugPrintMissionLevels() {
  if (!(await ensurePage())) return;

  try {
    const levels = await page.evaluate(
      (selectors) => {
        const { missionButtonSelector, missionLevelBadgeSelector } = selectors;
        const buttons = Array.from(
          document.querySelectorAll(missionButtonSelector),
        );
        return buttons
          .map((button) => {
            const badge = button.querySelector(missionLevelBadgeSelector);
            return badge ? badge.textContent.trim() : "";
          })
          .filter(Boolean);
      },
      {
        missionButtonSelector: MISSION_BUTTON_SELECTOR,
        missionLevelBadgeSelector: MISSION_LEVEL_BADGE_SELECTOR,
      },
    );

    if (Array.isArray(levels) && levels.length > 0) {
      logWithTimestamp(
        `[LEVELS] Found ${levels.length} mission levels:`,
        currentMissionStats,
      );
      levels.forEach((level, idx) => {
        logWithTimestamp(
          `[LEVELS] Mission #${idx + 1}: Level ${level}`,
          currentMissionStats,
        );
      });
    } else {
      logWithTimestamp(`[LEVELS] No mission levels found`, currentMissionStats);
    }
  } catch (error) {
    logWithTimestamp(
      `[LEVELS] ❌ Error: ${error.message}`,
      currentMissionStats,
    );
  }
}

// Mock print NFT selections (like original)
async function mockPrintNFTSelections() {
  if (!(await ensurePage())) return;

  try {
    const selections = await page.evaluate(
      (targetMissions, selectors) => {
        try {
          const {
            missionButtonSelector,
            missionLevelBadgeSelector,
            missionLevelContainerSelector,
            missionStatusTextSelector,
          } = selectors;
          const missionButtons = Array.from(
            document.querySelectorAll(missionButtonSelector),
          );
          const availableMissions = [];
          const seenMissions = new Set();

          const extractMissionName = (button) => {
            const levelContainer = button.querySelector(
              missionLevelContainerSelector,
            );
            const statusSpan = button.querySelector(missionStatusTextSelector);
            const textCandidates = Array.from(
              button.querySelectorAll("h1, h2, h3, h4, h5, p, span, div"),
            )
              .map((el) => ({
                el,
                text: el.textContent?.trim() || "",
              }))
              .filter(({ text }) => text);

            if (Array.isArray(targetMissions) && targetMissions.length > 0) {
              const targetMatch = textCandidates.find(
                ({ el, text }) =>
                  (!levelContainer || !levelContainer.contains(el)) &&
                  (!statusSpan || !statusSpan.contains(el)) &&
                  targetMissions.some((t) => text.includes(t)),
              );
              if (targetMatch) return targetMatch.text;
            }

            const nonLevel = textCandidates.find(({ el, text }) => {
              if (levelContainer && levelContainer.contains(el)) return false;
              if (statusSpan && statusSpan.contains(el)) return false;
              if (/^(level|lvl)\b/i.test(text)) return false;
              if (/^\d+$/.test(text)) return false;
              return true;
            });
            if (nonLevel) return nonLevel.text;

            const lines = (button.innerText || "")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .filter((l) => !/^(level|lvl)\b/i.test(l))
              .filter((l) => !/^\d+$/.test(l));
            return lines[0] || "";
          };

          for (const button of missionButtons) {
            const missionText = extractMissionName(button);
            if (
              missionText &&
              targetMissions.some((target) => missionText.includes(target)) &&
              !seenMissions.has(missionText)
            ) {
              seenMissions.add(missionText);

              let level = "";
              const levelBadge = button.querySelector(
                missionLevelBadgeSelector,
              );
              if (levelBadge) {
                level = levelBadge.textContent?.trim() || "";
              }

              // Find NFT container
              let nftContainer = document.querySelector(
                "div.w-full.flex.flex-col.gap-5.items-center",
              );
              if (nftContainer) {
                nftContainer = nftContainer.querySelector(
                  'div[class*="grid"][class*="grid-cols-2"]',
                );
              }
              if (!nftContainer) {
                nftContainer = document.querySelector(
                  'div.grid.grid-cols-2, div[class*="grid-cols-2"]',
                );
              }

              if (nftContainer) {
                let selectedNFT;

                // For level 5/10/15: prefer special NFTs first
                if (["5", "10", "15"].includes(level)) {
                  selectedNFT = Array.from(nftContainer.children).find(
                    (item) => {
                      if (item.classList.contains("grayscale")) return false;
                      const text = item.textContent || "";
                      return text.includes("TKM") || text.includes("100k");
                    },
                  );

                  if (!selectedNFT) {
                    selectedNFT = Array.from(nftContainer.children).find(
                      (item) => {
                        if (item.classList.contains("grayscale")) return false;
                        const text = item.textContent || "";
                        return !text.includes("500k");
                      },
                    );
                  }
                } else if (level === "20") {
                  // For level 20: only 500k or 100k
                  selectedNFT = Array.from(nftContainer.children).find(
                    (item) => {
                      if (item.classList.contains("grayscale")) return false;
                      const text = item.textContent || "";
                      return text.includes("500k") || text.includes("100k");
                    },
                  );
                } else {
                  // For normal missions: prefer regular NFTs first, fallback to special ones
                  selectedNFT = Array.from(nftContainer.children).find(
                    (item) => {
                      if (item.classList.contains("grayscale")) return false;
                      const text = item.textContent || "";
                      return !text.includes("500k") && !text.includes("TKM");
                    },
                  );

                  if (!selectedNFT) {
                    selectedNFT = Array.from(nftContainer.children).find(
                      (item) => {
                        if (item.classList.contains("grayscale")) return false;
                        const text = item.textContent || "";
                        return !text.includes("666,666");
                      },
                    );
                  }
                }

                if (selectedNFT) {
                  let nftName = selectedNFT.querySelector("span")
                    ? selectedNFT.querySelector("span").textContent.trim()
                    : selectedNFT.textContent.trim();
                  availableMissions.push({
                    mission: missionText,
                    level,
                    nft: nftName,
                  });
                }
              }
            }
          }
          return availableMissions;
        } catch (e) {
          return { error: e.message };
        }
      },
      TARGET_MISSIONS,
      {
        missionButtonSelector: MISSION_BUTTON_SELECTOR,
        missionLevelBadgeSelector: MISSION_LEVEL_BADGE_SELECTOR,
        missionLevelContainerSelector: MISSION_LEVEL_CONTAINER_SELECTOR,
        missionStatusTextSelector: MISSION_STATUS_TEXT_SELECTOR,
      },
    );

    if (Array.isArray(selections)) {
      selections.forEach((sel) => {
        const cleanedMission = String(sel.mission || "")
          .replace(/(in\s*progress|ready\s*to\s*start|completed)/gi, "")
          .replace(/\d+\s*\/\s*\d+/g, "")
          .replace(/\s+/g, " ")
          .trim();
        logWithTimestamp(
          `[DEBUG] Mission: ${cleanedMission} (Level ${sel.level}) | Would select NFT: ${sel.nft}`,
          currentMissionStats,
        );
      });
    } else {
      logWithTimestamp(
        `[DEBUG] No missions found or error.`,
        currentMissionStats,
      );
    }
  } catch (error) {
    logWithTimestamp(`[DEBUG] ❌ Error: ${error.message}`, currentMissionStats);
  }
}

// Manually reset all level 20 missions
async function resetAllLevel20Missions() {
  try {
    logWithTimestamp("[INFO] Manually resetting all level 20 missions...");

    const allMissions = await getAllMissions();
    if (allMissions.length === 0) {
      logWithTimestamp("[ERROR] No missions found");
      return;
    }

    const level20Missions = allMissions.filter(
      (m) =>
        m.level === "20" &&
        !m.alreadyStarted &&
        TARGET_MISSIONS.some((target) => m.text.includes(target)),
    );

    if (level20Missions.length === 0) {
      logWithTimestamp("[INFO] No level 20 missions found");
      return;
    }

    logWithTimestamp(
      `[INFO] Found ${level20Missions.length} level 20 mission(s) to reset`,
    );

    for (const mission of level20Missions) {
      logWithTimestamp(`[DEBUG] Resetting level 20 mission: ${mission.text}`);

      if (await clickMission(mission.text)) {
        logWithTimestamp(`[DEBUG] ✓ Level 20 mission clicked: ${mission.text}`);

        const missionLoaded = await waitForMissionToLoad(mission.text, 8000);
        if (!missionLoaded) {
          logWithTimestamp(
            `[ERROR] ❌ Mission detail did not load: ${mission.text}`,
          );
          continue;
        }

        // Reset the mission (forceReset=true triggers the reset logic)
        const resetSuccess = await selectNFTAndStartMission(
          mission.text,
          "20",
          true,
        );
        if (resetSuccess) {
          logWithTimestamp(`[INFO] ✅ Level 20 mission reset: ${mission.text}`);
          logWithTimestamp(
            `[DEBUG] Mission has been reset to level 1, will start on next cycle`,
          );
        } else {
          logWithTimestamp(`[ERROR] ❌ Failed to reset: ${mission.text}`);
        }
      } else {
        logWithTimestamp(`[ERROR] ❌ Failed to click mission: ${mission.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    logWithTimestamp("[INFO] Level 20 reset process completed");
  } catch (error) {
    logWithTimestamp(
      `[ERROR] Failed to reset level 20 missions: ${error.message}`,
    );
  }
}

// Manually reset all missions at target level (mission mode)
async function resetAllLevel11Missions() {
  try {
    logWithTimestamp(
      `[INFO] Manually resetting all level ${currentMissionResetLevel} missions (mission mode)...`,
    );

    const allMissions = await getAllMissions();
    if (allMissions.length === 0) {
      logWithTimestamp("[ERROR] No missions found");
      return;
    }

    const levelMissions = allMissions.filter(
      (m) =>
        m.level === currentMissionResetLevel &&
        !m.alreadyStarted &&
        TARGET_MISSIONS.some((target) => m.text.includes(target)),
    );

    if (levelMissions.length === 0) {
      logWithTimestamp(
        `[INFO] No level ${currentMissionResetLevel} missions found`,
      );
      return;
    }

    logWithTimestamp(
      `[INFO] Found ${levelMissions.length} level ${currentMissionResetLevel} mission(s) to reset`,
    );

    for (const mission of levelMissions) {
      logWithTimestamp(
        `[DEBUG] Resetting level ${currentMissionResetLevel} mission: ${mission.text}`,
      );

      if (await clickMission(mission.text)) {
        logWithTimestamp(
          `[DEBUG] ✓ Level ${currentMissionResetLevel} mission clicked: ${mission.text}`,
        );

        const missionLoaded = await waitForMissionToLoad(mission.text, 8000);
        if (!missionLoaded) {
          logWithTimestamp(
            `[ERROR] ❌ Mission detail did not load: ${mission.text}`,
          );
          continue;
        }

        // Reset the mission (forceReset=true triggers the reset logic)
        const resetSuccess = await selectNFTAndStartMission(
          mission.text,
          currentMissionResetLevel,
          true,
        );
        if (resetSuccess) {
          logWithTimestamp(
            `[INFO] ✅ Level ${currentMissionResetLevel} mission reset: ${mission.text}`,
          );
          logWithTimestamp(
            `[DEBUG] Mission has been reset to level 1, will start on next cycle`,
          );
        } else {
          logWithTimestamp(`[ERROR] ❌ Failed to reset: ${mission.text}`);
        }
      } else {
        logWithTimestamp(`[ERROR] ❌ Failed to click mission: ${mission.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    logWithTimestamp(
      `[INFO] Level ${currentMissionResetLevel} reset process completed`,
    );
  } catch (error) {
    logWithTimestamp(
      `[ERROR] Failed to reset level 11 missions: ${error.message}`,
    );
  }
}

// Connect to existing Chrome (like original)
async function connectToExistingChrome() {
  try {
    logWithTimestamp(
      "[INFO] Looking for your existing Chrome window...",
      currentMissionStats,
    );
    const connected = await initializeBrowser();
    if (connected) {
      logWithTimestamp(
        "[INFO] ✓ Ready! Connected to Chrome tab",
        currentMissionStats,
      );
      return true;
    } else {
      logWithTimestamp(
        "[INFO] ❌ Could not open missions tab in Chrome",
        currentMissionStats,
      );
      return false;
    }
  } catch (error) {
    logWithTimestamp(`[INFO] ❌ Error: ${error.message}`, currentMissionStats);
    return false;
  }
}

// Refresh missions page (like original)
async function refreshMissionsPage(options = {}) {
  const force = Boolean(options && options.force);
  if (!(await ensurePage())) {
    logWithTimestamp(`[DEBUG] Not on missions page, skipping refresh.`);
    return false;
  }

  try {
    if (temporaryCollectionFlowPauseCount > 0 && !force) {
      logWithTimestamp(
        `[DEBUG][TEMP] Refresh skipped while temporary collection flow is active`,
      );
      return false;
    }
    await page.reload({ waitUntil: "networkidle2" });
    logWithTimestamp(`[DEBUG] Missions page refreshed`);
    return true;
  } catch (error) {
    logWithTimestamp(`[DEBUG] Error refreshing mission page: ${error.message}`);
    logWithTimestamp(
      `[ERROR] Failed to refresh page: ${error.message}`,
      currentMissionStats,
    );
    return false;
  }
}

// Startup function to ensure proper order
async function startup() {
  // Setup command handler first
  setupCommandHandler();

  // Then initialize browser (which will show Chrome launch messages)
  await initializeBrowser();

  // Then start watching (which will show watching messages)
  await startWatching();

  // Print NFT selections after brief delay
  setTimeout(() => {
    mockPrintNFTSelections();
  }, 200);
}

// Initialize (like original)
startup();

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");
  if (browser) {
    try {
      await browser.disconnect(); // Disconnect instead of close
      console.log("✅ Disconnected from Chrome (Chrome stays open)");
    } catch (e) {
      console.log("Browser already disconnected");
    }
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browser) {
    try {
      await browser.disconnect(); // Disconnect instead of close
    } catch (e) {
      // Silent cleanup
    }
  }
  process.exit(0);
});
