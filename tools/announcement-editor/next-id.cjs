"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

function createIdAllocator(dataDir) {
  let pending = Promise.resolve();
  async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  return function nextId(items) {
    const allocation = pending.catch(() => {}).then(async () => {
      const sequence = await readJson("id-sequence.json", { lastId: "0" });
      const draft = await readJson("draft.json", { announcements: [] });
      let lastId = BigInt(sequence.lastId);
      for (const item of [...draft.announcements, ...items]) {
        for (const value of [item.id, item.publishedId]) {
          const match = String(value || "").match(/^(?:announcement-)?(\d+)$/);
          if (match && BigInt(match[1]) > lastId) lastId = BigInt(match[1]);
        }
      }
      const next = String(lastId + 1n);
      await fs.mkdir(dataDir, { recursive: true });
      const file = path.join(dataDir, "id-sequence.json");
      await fs.writeFile(file + ".next", JSON.stringify({ lastId: next }), { mode: 0o600 });
      await fs.rename(file + ".next", file);
      return "announcement-" + next;
    });
    pending = allocation;
    return allocation;
  };
}
module.exports = { createIdAllocator };
