"use strict";

const { randomUUID } = require("node:crypto");
const MAX_RESET_RETRY_AGE_MS = 5 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;

// Pending deliveries exist only in this process. Never replay saved analytics.
function createResetTelemetryDelivery({ send, now = Date.now, setTimer = setTimeout }) {
  function deliver(payload) {
    const startedAt = now();
    const body = JSON.stringify({ ...payload, event_id: randomUUID(), timestamp: payload.timestamp || new Date(startedAt).toISOString() });
    let attempts = 0;
    async function attempt() {
      const remainingMs = MAX_RESET_RETRY_AGE_MS - (now() - startedAt);
      if (remainingMs <= 0) return false;
      attempts++;
      let result;
      try { result = await send(JSON.parse(body), remainingMs); }
      catch { result = { ok: false, retryable: true }; }
      if (result?.ok) return true;
      const delay = Math.min(15_000 * 2 ** (attempts - 1), 120_000);
      if (result?.retryable && attempts < MAX_RESET_ATTEMPTS && now() + delay < startedAt + MAX_RESET_RETRY_AGE_MS) {
        const timer = setTimer(() => { void attempt(); }, delay);
        timer?.unref?.();
      }
      return false;
    }
    return attempt();
  }
  return { deliver };
}

module.exports = { createResetTelemetryDelivery, MAX_RESET_RETRY_AGE_MS, MAX_RESET_ATTEMPTS };
