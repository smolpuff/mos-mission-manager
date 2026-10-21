"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Limit browser windows only. Token renewal and mission requests never wait
// on this policy. The timestamp is claimed immediately before browser launch.
function createAuthPopupPolicy(ctx) {
  const file = `${ctx.tokenFilePath}.auth-popup.json`;
  const lock = `${file}.lock`;
  let localOpenedAt = null;
  function intervalMs() { return ctx.missionModeEnabled === true ? 120000 : 300000; }
  function openedAt() {
    let value = localOpenedAt;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(saved.openedAt)) value = Math.max(value ?? 0, saved.openedAt);
    } catch {}
    return value;
  }
  function remainingMs() {
    const last = openedAt();
    return last === null ? 0 : Math.max(0, last + intervalMs() - Date.now());
  }
  function claimWindow() {
    const owner = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
    let held = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (let attempt = 0; attempt < 2 && !held; attempt++) {
        try {
          const descriptor = fs.openSync(lock, "wx", 0o600);
          try { fs.writeFileSync(descriptor, JSON.stringify({ owner, pid: process.pid })); }
          finally { fs.closeSync(descriptor); }
          held = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          let abandoned = false;
          try {
            const previous = JSON.parse(fs.readFileSync(lock, "utf8"));
            if (Number.isInteger(previous.pid)) {
              try { process.kill(previous.pid, 0); } catch (e) { abandoned = e.code === "ESRCH"; }
            }
          } catch {
            try { abandoned = Date.now() - fs.statSync(lock).mtimeMs > 5000; } catch {}
          }
          if (abandoned) { try { fs.unlinkSync(lock); } catch {} }
          else return { allowed: false, reason: "another_process_claiming_window", waitMs: Math.max(1000, remainingMs()) };
        }
      }
      if (!held) return { allowed: false, reason: "window_claim_busy", waitMs: 1000 };
      const waitMs = remainingMs();
      if (waitMs > 0) return { allowed: false, reason: "window_cooldown", waitMs };
      const now = Date.now();
      const temporary = `${file}.${owner.replace(":", "-")}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ openedAt: now, pid: process.pid }), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { try { fs.unlinkSync(temporary); } catch {} }
      localOpenedAt = now;
      return { allowed: true, openedAt: now, intervalMs: intervalMs() };
    } catch (error) {
      return { allowed: false, reason: "window_claim_failed", error, waitMs: 1000 };
    } finally {
      if (held) {
        try {
          if (JSON.parse(fs.readFileSync(lock, "utf8")).owner === owner) fs.unlinkSync(lock);
        } catch {}
      }
    }
  }
  return { remainingMs, claimWindow, intervalMs };
}

module.exports = { createAuthPopupPolicy };
