"use strict";

const fs = require("fs");
const path = require("path");

function normalizeScan(raw) {
  const offset = Number(raw?.offset);
  const cycle = Number(raw?.cycle);
  return {
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
    cycle: Number.isFinite(cycle) && cycle >= 0 ? Math.floor(cycle) : 0,
  };
}

function loadNftAssignmentScan(filePath) {
  try {
    return normalizeScan(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return normalizeScan(null);
  }
}

function saveNftAssignmentScan(filePath, scan) {
  const target = String(filePath || "").trim();
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(
    temp,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        ...normalizeScan(scan),
      },
      null,
      2,
    ),
  );
  fs.renameSync(temp, target);
}

module.exports = {
  loadNftAssignmentScan,
  normalizeScan,
  saveNftAssignmentScan,
};
