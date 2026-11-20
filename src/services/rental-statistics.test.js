"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRentalCoordinator } = require("./rentals");

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rental-statistics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const snapshotPath = path.join(directory, "snapshot.json");
  const options = {
    snapshotPath, clock: () => now,
    searchRentals: async () => ({ structuredContent: { data: [{
      rentalListingId: "listing-1", account: "nft-1", name: "Rental 1", available: undefined,
      rentalStatus: "active", usesRemaining: 2, stats: { level: 1 }, onCooldown: true,
      cooldownEndAt: new Date(now + 60_000).toISOString(),
    }] } }),
    getMissionsNeedingRental: async () => [{ missionKey: "mission-1" }],
    missionStillNeedsRental: async () => true,
    reserveAssignmentBudget: async () => ({ admitted: true }),
    setTimer: () => ({ unref() {} }), clearTimer() {},
    ...overrides,
  };
  return { options, advance: (milliseconds) => { now += milliseconds; } };
}

const run = (coordinator) => coordinator.runAssignmentWorker({
  missions: [{ missionKey: "mission-1" }], allowCoolingReset: true,
});

test("successful reset remains attributed across assignment retries and coordinator restart", async (t) => {
  const attempts = [];
  const { options } = fixture(t, {
    assignCandidate: async ({ candidate }) => {
      attempts.push(candidate);
      return attempts.length === 1
        ? { success: false, kind: "not_ready", message: "not ready after reset", readyAt: 1_800_000_060_000, cooldownResetSucceeded: true }
        : { success: true };
    },
  });
  const first = createRentalCoordinator(options);
  first.load();
  await first.requestSearch({ reason: "seed" });
  await run(first);
  const restarted = createRentalCoordinator(options);
  restarted.load();
  await run(restarted);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].cooldownResetRequested, true);
  assert.equal(attempts[1].cooldownResetRequested, false, "Retry does not charge another reset");
  assert.equal(attempts[1].cooldownResetSucceeded, true, "Assignment analytics keeps the successful prior reset");
});

test("fresh snapshots retain pending reset attribution but never revive removed candidate attribution", async (t) => {
  const attempts = [];
  let terminal = false;
  const { options, advance } = fixture(t, {
    assignCandidate: async ({ candidate }) => {
      attempts.push(candidate);
      return { success: false, kind: terminal ? "terminal" : "not_ready", message: "assignment failed",
        readyAt: 1_800_000_060_000, cooldownResetSucceeded: true };
    },
  });
  const coordinator = createRentalCoordinator(options);
  coordinator.load();
  await coordinator.requestSearch({ reason: "seed" });
  await run(coordinator);
  advance(61_001);
  await coordinator.requestSearch({ reason: "refresh" });
  assert.equal(coordinator.state.candidates[0].cooldownResetSucceeded, true);
  terminal = true;
  await run(coordinator);
  assert.equal(coordinator.state.candidates[0].state, "removed");
  advance(61_001);
  await coordinator.requestSearch({ reason: "new listing snapshot" });
  assert.equal(coordinator.state.candidates[0].cooldownResetSucceeded, false);
});

test("ambiguous reconciliation receives the successful reset marker from the failed response", async (t) => {
  let reconciled = null;
  const { options } = fixture(t, {
    assignCandidate: async () => ({ success: false, kind: "network", message: "response timed out", cooldownResetSucceeded: true }),
    reconcileAmbiguous: async ({ candidate }) => { reconciled = candidate; return { assigned: true }; },
  });
  const coordinator = createRentalCoordinator(options);
  coordinator.load();
  await coordinator.requestSearch({ reason: "seed" });
  const result = await run(coordinator);
  assert.equal(result.successes, 1);
  assert.equal(reconciled.cooldownResetSucceeded, true);
  assert.equal(coordinator.state.candidates.length, 0, "Consumed reset attribution cannot be reused later");
});
