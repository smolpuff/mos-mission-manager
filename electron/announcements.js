"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { ANNOUNCEMENTS_URL, CHECK_INTERVAL_MS, MAX_FEED_BYTES, normalizeFeed, isActive } = require("../lib/announcements");

function createAnnouncementService({ userData, fetchImpl = globalThis.fetch, now = Date.now }) {
  const stateFile = path.join(userData, "announcement-history.json");
  let feed = [], lastChecked = -Infinity, pending, history, automaticHistory, historyPending, writePending = Promise.resolve();
  async function readHistory() {
    if (!historyPending) historyPending = fs.readFile(stateFile, "utf8").then(JSON.parse).then(value => {
      history = new Set(Array.isArray(value?.seen) ? value.seen.filter(id => typeof id === "string") : []);
      automaticHistory = new Set(Array.isArray(value?.automaticSeen) ? value.automaticSeen.filter(id => typeof id === "string") : []);
    }).catch(error => {
      // A damaged history must not turn every launch into repeated announcements.
      if (error.code !== "ENOENT") throw error;
      history = new Set();
      automaticHistory = new Set();
    });
    await historyPending;
  }
  async function refresh() {
    // A unique URL avoids replaying a deleted message from a raw GitHub/CDN cache.
    const url = new URL(ANNOUNCEMENTS_URL);
    url.searchParams.set("check", String(now()));
    const response = await fetchImpl(url.href, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (response.status === 404) { feed = []; return; }
    if (!response.ok) throw new Error("Announcement feed unavailable.");
    let size = 0; const chunks = [];
    if (!response.body) throw new Error("Empty announcement feed.");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_FEED_BYTES) throw new Error("Announcement feed too large.");
      chunks.push(Buffer.from(chunk));
    }
    feed = normalizeFeed(JSON.parse(Buffer.concat(chunks).toString("utf8"))).announcements;
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
      return feed.filter(item => item.enabled && Date.parse(item.endsAt) > now() && !history.has(item.id))
        .map(item => ({ ...item, automaticSeen: automaticHistory.has(item.id) }));
    } catch { feed = []; return []; } // Never reuse a stale feed after a failed refresh.
  }
  async function markSeen(id, automatic = false) {
    await readHistory();
    if (!feed.some(item => item.id === id && isActive(item, now()))) return false;
    (automatic === true ? automaticHistory : history).add(id);
    writePending = writePending.catch(() => {}).then(async () => {
      await fs.mkdir(userData, { recursive: true });
      await fs.writeFile(stateFile + ".next", JSON.stringify({ seen: [...history], automaticSeen: [...automaticHistory] }), { mode: 0o600 });
      await fs.rename(stateFile + ".next", stateFile);
    });
    await writePending;
    return true;
  }
  return { check, markSeen };
}
module.exports = { createAnnouncementService };
