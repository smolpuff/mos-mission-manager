"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createResetTelemetryDelivery, MAX_RESET_RETRY_AGE_MS, MAX_RESET_ATTEMPTS } = require("./reset-telemetry-delivery");

function fixture(send) {
  let time = Date.parse("2026-11-15T23:59:59-05:00");
  const timers = [], calls = [];
  const delivery = createResetTelemetryDelivery({
    now: () => time,
    setTimer(callback, delay) { timers.push({ callback, at: time + delay }); },
    async send(payload, remaining) { calls.push({ payload, remaining }); return send(payload, calls.length, value => { time += value; }); },
  });
  return { delivery, timers, calls, async next() { const task = timers.shift(); time = task.at; task.callback(); await new Promise(resolve => setImmediate(resolve)); }, advance(ms) { time += ms; } };
}
const event = { client_id: "client-a", wallet_id: "wallet-a", event_type: "feature_used", event_name: "reset", reset_type: "mission" };

test("a failed upload retries the same event and original date, then stops after success", async () => {
  const f = fixture(async (_, count) => ({ ok: count === 2, retryable: true }));
  const input = { ...event };
  assert.equal(await f.delivery.deliver(input), false);
  input.wallet_id = "changed-wallet";
  assert.equal(f.timers.length, 1);
  await f.next();
  assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  assert.equal(f.calls[1].payload.wallet_id, "wallet-a");
  assert.equal(f.calls[1].payload.timestamp, "2026-11-16T04:59:59.000Z");
  assert.match(f.calls[0].payload.event_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.timers.length, 0);
});

test("network exceptions retry but no event is attempted after the five-minute deadline", async () => {
  const f = fixture(async () => { throw Error("offline"); });
  await f.delivery.deliver(event);
  f.advance(MAX_RESET_RETRY_AGE_MS);
  // Simulate a suspended laptop: the scheduled callback resumes after expiry.
  const task = f.timers.shift(); task.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.length, 0);
});

test("retries stop after five attempts even if every request fails", async () => {
  const f = fixture(async () => ({ ok: false, retryable: true }));
  await f.delivery.deliver(event);
  while (f.timers.length) await f.next();
  assert.equal(f.calls.length, MAX_RESET_ATTEMPTS);
  assert.equal(new Set(f.calls.map(c => c.payload.event_id)).size, 1);
  assert.ok(f.calls.at(-1).remaining > 0);
});

test("permanent server rejection is not retried", async () => {
  const f = fixture(async () => ({ ok: false, retryable: false }));
  await f.delivery.deliver(event);
  assert.equal(f.timers.length, 0);
});

test("an attempt that exhausts the five-minute budget cannot schedule more work", async () => {
  const f = fixture(async (_, count, advance) => { advance(MAX_RESET_RETRY_AGE_MS); return { ok: false, retryable: true }; });
  await f.delivery.deliver(event);
  assert.equal(f.timers.length, 0);
});

test("separate real reset events get separate IDs and a new process has no pending history", async () => {
  const f = fixture(async () => ({ ok: true }));
  await f.delivery.deliver(event); await f.delivery.deliver(event);
  assert.notEqual(f.calls[0].payload.event_id, f.calls[1].payload.event_id);
  const restarted = fixture(async () => ({ ok: true }));
  assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.timers.length, 0);
});

test("delivery preserves the exact timestamp already used for local reset counting", async () => {
  const f = fixture(async () => ({ ok: true }));
  const timestamp = "2026-11-16T04:59:58.999Z";
  await f.delivery.deliver({ ...event, timestamp });
  assert.equal(f.calls[0].payload.timestamp, timestamp);
});

test("the actual HTTP sender retries transient failures but stops on permanent rejections", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const start = source.indexOf("async function postResetTelemetryPayload(");
  assert.ok(start > 0);
  const text = source.slice(start, source.indexOf("\n}\n", start) + 2);
  for (const [status, expected] of [[200, { ok: true }], [503, { ok: false, retryable: true }], [429, { ok: false, retryable: true }], [401, { ok: false, retryable: false }], [422, { ok: false, retryable: false }]]) {
    const send = vm.runInNewContext(`(${text})`, {
      telemetryConfigFromDesktopConfig: () => ({ enabled: true, url: "https://test.invalid", token: "fixture" }),
      externalIpForPayload: async () => "", Date, AbortSignal, MISSIONS_ANALYTICS_TIMEOUT_MS: 8000,
      analyticsTelemetryFailureLogged: false, pushSystemLog() {},
      fetch: async (_, options) => {
        assert.equal(JSON.parse(options.body).wallet_id, "wallet-a");
        return { ok: status === 200, status };
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await send(event, 300_000))), expected);
  }
});
