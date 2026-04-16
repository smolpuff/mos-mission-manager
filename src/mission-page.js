"use strict";

const { spawn } = require("child_process");

const MISSION_PLAY_URL = "https://pixelbypixel.studio/missions/play";
const MISSION_PAGE_OPEN_COOLDOWN_MS = 60_000;

let lastMissionPageOpenAt = 0;

async function openMissionPlayPage() {
  const now = Date.now();
  if (now - lastMissionPageOpenAt < MISSION_PAGE_OPEN_COOLDOWN_MS) {
    return true;
  }

  const url = MISSION_PLAY_URL;
  const escapedUrl = String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const macChromeScript = [
    `tell application "Google Chrome"`,
    `activate`,
    `if (count of windows) is 0 then`,
    `  make new window`,
    `  set URL of active tab of front window to "${escapedUrl}"`,
    `else`,
    `  tell front window`,
    `    make new tab at end of tabs with properties {URL:"${escapedUrl}"}`,
    `    set active tab index to (count of tabs)`,
    `  end tell`,
    `end if`,
    `end tell`,
  ].join("\n");
  const macEdgeScript = [
    `tell application "Microsoft Edge"`,
    `activate`,
    `if (count of windows) is 0 then`,
    `  make new window`,
    `  set URL of active tab of front window to "${escapedUrl}"`,
    `else`,
    `  tell front window`,
    `    make new tab at end of tabs with properties {URL:"${escapedUrl}"}`,
    `    set active tab index to (count of tabs)`,
    `  end tell`,
    `end if`,
    `end tell`,
  ].join("\n");
  const candidates =
    process.platform === "darwin"
      ? [
          ["osascript", ["-e", macChromeScript]],
          ["osascript", ["-e", macEdgeScript]],
          ["open", ["-a", "Google Chrome", url]],
          ["open", ["-a", "Microsoft Edge", url]],
          ["open", [url]],
        ]
      : process.platform === "win32"
        ? [
            ["cmd", ["/c", "start", "", url]],
          ]
        : [
            ["google-chrome", [url]],
            ["chromium-browser", [url]],
            ["microsoft-edge", [url]],
            ["firefox", [url]],
            ["xdg-open", [url]],
            ["gio", ["open", url]],
          ];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.once("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once("exit", (code) => {
        if (!settled) {
          settled = true;
          resolve(code === 0);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve(true);
        }
      }, 250);
    });
    if (ok) {
      lastMissionPageOpenAt = Date.now();
      return true;
    }
  }
  return false;
}

module.exports = {
  MISSION_PLAY_URL,
  openMissionPlayPage,
};
