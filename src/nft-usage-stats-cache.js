"use strict";

const fs = require("fs");
const path = require("path");
const { loadNftAssignmentRotation } = require("./nft-assignment-rotation");
const { canonicalNftCollectionName } = require("./nft-collection-name");

function normalizeRow(row) {
  if (!(row && typeof row === "object")) return null;
  const account = String(row.account || "").trim();
  if (!account) return null;
  const uses = Number(row.uses);
  const sessionUses = Number(row.sessionUses);
  const level = Number(row.level);
  return {
    account,
    mint: String(row.mint || account).trim() || account,
    name: String(row.name || "Unknown NFT").trim() || "Unknown NFT",
    collection: canonicalNftCollectionName(row.collection) || null,
    imageUrl: String(row.imageUrl || "").trim() || null,
    level: Number.isFinite(level) ? level : -1,
    available:
      row.available === true ? true : row.available === false ? false : null,
    uses: Number.isFinite(uses) && uses >= 0 ? Math.floor(uses) : 0,
    sessionUses:
      Number.isFinite(sessionUses) && sessionUses >= 0
        ? Math.floor(sessionUses)
        : 0,
    lastUsedAt:
      Number.isFinite(Number(row.lastUsedAt)) && Number(row.lastUsedAt) > 0
        ? Number(row.lastUsedAt)
        : null,
  };
}

function loadNftUsageStatsCache(cachePath, rotationPath) {
  let cachedRows = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cachedRows = Array.isArray(parsed?.nfts)
      ? parsed.nfts.map(normalizeRow).filter(Boolean)
      : [];
  } catch {}

  const byAccount = new Map(cachedRows.map((row) => [row.account, row]));
  const usage = loadNftAssignmentRotation(rotationPath);
  for (const [account, uses] of Object.entries(usage)) {
    const cached = byAccount.get(account);
    byAccount.set(
      account,
      normalizeRow({
        ...(cached || { account }),
        uses,
      }),
    );
  }
  return Array.from(byAccount.values())
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.uses - a.uses ||
        b.sessionUses - a.sessionUses ||
        a.name.localeCompare(b.name) ||
        a.account.localeCompare(b.account),
    );
}

function saveNftUsageStatsCache(cachePath, rows) {
  const target = String(cachePath || "").trim();
  if (!target) return;
  const nfts = Array.isArray(rows) ? rows.map(normalizeRow).filter(Boolean) : [];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(
    temp,
    JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), nfts },
      null,
      2,
    ),
  );
  fs.renameSync(temp, target);
}

module.exports = {
  loadNftUsageStatsCache,
  saveNftUsageStatsCache,
};
