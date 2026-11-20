"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWalletRefreshScheduler } = require("../wallet-refresh-scheduler");

function setup() {
  const pending = new Map();
  const reasons = [];
  let id = 0;
  const scheduler = createWalletRefreshScheduler({
    refresh: (reason) => reasons.push(reason),
    setTimer: (callback, delay) => { const key = ++id; pending.set(key, { callback, delay }); return key; },
    clearTimer: (key) => pending.delete(key),
  });
  const next = () => { assert.equal(pending.size, 1); return [...pending.values()][0]; };
  const fire = () => { const task = next(); pending.clear(); task.callback(); };
  return { scheduler, pending, reasons, next, fire };
}

test("the first failure retries in five minutes, then continued failures use thirty minutes", () => {
  const { scheduler, next, fire, reasons } = setup();
  scheduler.schedule(true);
  assert.equal(next().delay, 5 * 60 * 1000);
  fire();
  assert.deepEqual(reasons, ["retry_5m"]);
  scheduler.schedule(true);
  assert.equal(next().delay, 30 * 60 * 1000);
  fire();
  scheduler.schedule(true);
  assert.equal(next().delay, 30 * 60 * 1000);
  assert.deepEqual(reasons, ["retry_5m", "periodic_30m"]);
});

test("another failed attempt before the retry runs preserves the original five-minute timer", () => {
  const { scheduler, next, pending } = setup();
  scheduler.schedule(true);
  const original = next();
  scheduler.schedule(true);
  assert.equal(next(), original);
  assert.equal(pending.size, 1);
});

test("success cancels a pending retry and restores the normal delay; a later failure gets one retry", () => {
  const { scheduler, next, fire } = setup();
  scheduler.schedule(true);
  scheduler.schedule(false);
  assert.equal(next().delay, 30 * 60 * 1000);
  scheduler.schedule(true);
  assert.equal(next().delay, 5 * 60 * 1000);
  fire();
  scheduler.schedule(false);
  assert.equal(next().delay, 30 * 60 * 1000);
  scheduler.schedule(true);
  assert.equal(next().delay, 5 * 60 * 1000);
});

test("stopping clears the scheduled refresh", () => {
  const { scheduler, pending } = setup();
  scheduler.schedule(true);
  scheduler.stop();
  assert.equal(pending.size, 0);
});
