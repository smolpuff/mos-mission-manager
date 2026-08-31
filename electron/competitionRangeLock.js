"use strict";

function normalizeCompetitionRowKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function normalizeCompetitionRangeTarget({ minRank, maxRank } = {}) {
  const first = Number(minRank) || 0;
  const second = Number(maxRank) || 0;
  return {
    minRank: Math.min(first, second),
    maxRank: Math.max(first, second),
  };
}

function findCompetitionUserRow(rows, userIdentityValues) {
  const userKeys = (Array.isArray(userIdentityValues)
    ? userIdentityValues
    : []
  )
    .map(normalizeCompetitionRowKey)
    .filter(Boolean);
  if (!userKeys.length) return null;

  return (
    (Array.isArray(rows) ? rows : []).find((row) => {
      const rowKeys = [row?.player, row?.walletId]
        .map(normalizeCompetitionRowKey)
        .filter(Boolean);
      return rowKeys.some((rowKey) =>
        userKeys.some(
          (userKey) =>
            rowKey === userKey ||
            rowKey.includes(userKey) ||
            userKey.includes(rowKey),
        ),
      );
    }) || null
  );
}

function competitionRangeLockDecision({
  rows,
  userIdentityValues,
  minRank,
  maxRank,
} = {}) {
  const target = normalizeCompetitionRangeTarget({ minRank, maxRank });
  const row = findCompetitionUserRow(rows, userIdentityValues);
  const rank = Number(row?.rank);
  if (!row || !Number.isFinite(rank)) {
    return { action: null, reason: "user_row_unavailable", row, target };
  }
  const targetReached = rank <= target.maxRank;
  return {
    // Reaching the configured finish range (or doing even better) must pause
    // claims. Resume only after the rank falls below the range's lower edge.
    action: targetReached ? "pause" : "resume",
    reason: targetReached ? "target_reached" : "below_target",
    rank,
    row,
    target,
  };
}

module.exports = {
  normalizeCompetitionRowKey,
  normalizeCompetitionRangeTarget,
  findCompetitionUserRow,
  competitionRangeLockDecision,
};
