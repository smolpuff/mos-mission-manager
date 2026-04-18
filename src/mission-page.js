"use strict";

const { spawn } = require("child_process");

const MISSION_PLAY_URL = "https://pixelbypixel.studio/missions/play";
const MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT = 60_000;

let lastMissionPageOpenAt = 0;

function normalizeCooldownMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT;
  // Clamp to a sane upper bound (1h) to avoid accidental "never open again".
  return Math.min(Math.floor(n), 60 * 60 * 1000);
}

async function openMissionPlayPage({ cooldownMs, targetUrl } = {}) {
  const now = Date.now();
  const effectiveCooldownMs = normalizeCooldownMs(cooldownMs);
  const elapsedMs = now - lastMissionPageOpenAt;
  if (elapsedMs < effectiveCooldownMs) {
    return {
      ok: true,
      opened: false,
      suppressed: true,
      cooldownMs: effectiveCooldownMs,
      nextAllowedInMs: Math.max(0, effectiveCooldownMs - elapsedMs),
    };
  }

  const target = String(targetUrl || MISSION_PLAY_URL || "").trim();
  if (!target) return { ok: false, opened: false, suppressed: false };
  const candidates =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? [
            ['rundll32', ['url.dll,FileProtocolHandler', target]],
            [
              'powershell',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'Start-Process -FilePath $args[0]',
                target,
              ],
            ],
            ['cmd', ['/c', 'start', '', target]],
          ]
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
      return { ok: true, opened: true, suppressed: false };
    }
  }
  return { ok: false, opened: false, suppressed: false };
}

module.exports = {
  MISSION_PLAY_URL,
  openMissionPlayPage,
  MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
};
