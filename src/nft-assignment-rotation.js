"use strict";

const fs = require("fs");
const path = require("path");

function normalizeUsage(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([account, count]) => [String(account || "").trim(), Number(count)])
      .filter(
        ([account, count]) =>
          account && Number.isFinite(count) && count >= 0,
      )
      .map(([account, count]) => [account, Math.floor(count)]),
  );
}

function loadNftAssignmentRotation(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeUsage(parsed?.usage);
  } catch {
    return {};
  }
}

function saveNftAssignmentRotation(filePath, usage) {
  const target = String(filePath || "").trim();
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(
    temp,
    JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), usage: normalizeUsage(usage) },
      null,
      2,
    ),
  );
  fs.renameSync(temp, target);
}

module.exports = {
  loadNftAssignmentRotation,
  normalizeUsage,
  saveNftAssignmentRotation,
};
