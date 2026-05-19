"use strict";

const UPDATE_JSON_URL =
  "https://raw.githubusercontent.com/smolpuff/mos-mission-manager/main/version.json";
const UPDATE_CHECK_TIMEOUT_MS = 8000;

function normalizeVersionParts(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  return text
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const match = String(part || "").match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    });
}

function compareVersions(a, b) {
  const left = normalizeVersionParts(a);
  const right = normalizeVersionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number(left[i] || 0);
    const bv = Number(right[i] || 0);
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function checkForUpdates({
  currentVersion = "",
  fetchImpl = globalThis.fetch,
  logger = null,
  url = UPDATE_JSON_URL,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
} = {}) {
  const installedVersion = String(currentVersion || "").trim();
  if (!installedVersion) {
    return {
      ok: false,
      updateAvailable: false,
      reason: "missing_current_version",
      currentVersion: "",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      updateAvailable: false,
      reason: "missing_fetch",
      currentVersion: installedVersion,
    };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetchImpl(String(url), {
      method: "GET",
      cache: "no-store",
      signal: abort.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        updateAvailable: false,
        reason: `http_${response.status}`,
        currentVersion: installedVersion,
      };
    }
    const payload = await response.json();
    const latestVersion = String(payload?.version || "").trim();
    const downloadUrl = String(payload?.downloadUrl || "").trim();
    const notes = Array.isArray(payload?.notes)
      ? payload.notes.map((note) => String(note).trim()).filter(Boolean)
      : String(payload?.notes || "")
          .split(/\r?\n/)
          .map((note) => note.trim())
          .filter(Boolean);
    if (!latestVersion || !downloadUrl) {
      return {
        ok: false,
        updateAvailable: false,
        reason: "invalid_payload",
        currentVersion: installedVersion,
      };
    }
    const updateAvailable =
      compareVersions(latestVersion, installedVersion) > 0;
    return {
      ok: true,
      updateAvailable,
      currentVersion: installedVersion,
      latestVersion,
      downloadUrl,
      notes,
      sourceUrl: String(url),
    };
  } catch (error) {
    if (logger && typeof logger === "function") {
      logger(String(error?.message || error));
    }
    return {
      ok: false,
      updateAvailable: false,
      reason: String(error?.name || error?.message || "fetch_failed"),
      currentVersion: installedVersion,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  UPDATE_JSON_URL,
  checkForUpdates,
  compareVersions,
};
