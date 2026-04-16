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

  const target = String(MISSION_PLAY_URL || '').trim();
  if (!target) return false;
  const windowsTarget = `"${target.replace(/"/g, '\\"')}"`;
  const candidates =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', windowsTarget]]]
        : [
            ['xdg-open', [target]],
            ['gio', ['open', target]],
          ];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise((resolve) => {
      let settled = false;
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.once('exit', (code) => {
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
