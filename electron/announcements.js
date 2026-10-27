"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { ANNOUNCEMENTS_URL, CHECK_INTERVAL_MS, MAX_FEED_BYTES, normalizeFeed, isActive } = require("../lib/announcements");

function createAnnouncementService({ userData, fetchImpl = globalThis.fetch, now = Date.now }) {
  const stateFile = path.join(userData, "announcement-history.json");
  let feed = [], etag = "", lastChecked = -Infinity, pending, history, historyPending, writePending = Promise.resolve();
  async function readHistory() {
    if (!historyPending) historyPending = fs.readFile(stateFile, "utf8").then(JSON.parse).then(value => {
      history = new Set(Array.isArray(value?.seen) ? value.seen.filter(id => typeof id === "string") : []);
    }).catch(error => {
      // A damaged history must not turn every launch into repeated announcements.
      if (error.code !== "ENOENT") throw error;
      history = new Set();
    });
    await historyPending;
  }
  async function refresh() {
    const response = await fetchImpl(ANNOUNCEMENTS_URL, { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(8000), cache: "no-cache" });
    if (response.status === 304) return;
    if (response.status === 404) { feed = []; etag = ""; return; }
    if (!response.ok) throw new Error("Announcement feed unavailable.");
    let size = 0; const chunks = [];
    if (!response.body) throw new Error("Empty announcement feed.");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_FEED_BYTES) throw new Error("Announcement feed too large.");
      chunks.push(Buffer.from(chunk));
    }
    feed = normalizeFeed(JSON.parse(Buffer.concat(chunks).toString("utf8"))).announcements;
    etag = response.headers.get("etag") || "";
  }
  async function check() {
    try {
      await readHistory();
      if (pending) await pending;
      else if (now() - lastChecked >= CHECK_INTERVAL_MS) {
        lastChecked = now();
        pending = refresh();
        try { await pending; } finally { pending = null; }
      }
      return feed.filter(item => item.enabled && Date.parse(item.endsAt) > now() && !history.has(item.id));
    } catch { return []; } // Announcements never block startup or missions.
  }
  async function markSeen(id) {
    await readHistory();
    if (!feed.some(item => item.id === id && isActive(item, now()))) return false;
    history.add(id);
    writePending = writePending.catch(() => {}).then(async () => {
      await fs.mkdir(userData, { recursive: true });
      await fs.writeFile(stateFile + ".next", JSON.stringify({ seen: [...history] }), { mode: 0o600 });
      await fs.rename(stateFile + ".next", stateFile);
    });
    await writePending;
    return true;
  }
  return { check, markSeen };
}
module.exports = { createAnnouncementService };
