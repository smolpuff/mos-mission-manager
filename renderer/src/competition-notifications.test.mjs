import assert from "node:assert/strict";
import test from "node:test";

const load = () => import("./competition-notifications.mjs");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("closing without suppression shows the same competition on the next app launch", async () => {
  const { shouldShowCompetitionNotification, closeCompetitionNotificationModal } = await load();
  const config = { missionCompetitionLastObservedNumber: 30 };
  const session = new Set();
  const shouldShow = (shownThisSession) => shouldShowCompetitionNotification({
    competitionNumber: 30,
    active: true,
    suppressedThroughNumber: config.missionCompetitionPopupSuppressedThroughNumber,
    shownThisSession,
  });
  assert.equal(shouldShow(session), true);
  session.add(30);
  let closed = false;
  await closeCompetitionNotificationModal({
    competitionNumber: 30,
    suppressCheckedRef: { current: false },
    updateConfig: () => assert.fail("Unchecked dismissal must not save suppression"),
    setModal: (value) => { closed = value === null; },
  });
  assert.equal(closed, true);
  assert.equal(shouldShow(session), false, "Hourly checks must not reopen a dismissed popup");
  assert.equal(shouldShow(new Set()), true, "Restart must show an already observed competition again");
});

test("explicit suppression survives restart and expires for the next competition", async () => {
  const { shouldShowCompetitionNotification, closeCompetitionNotificationModal } = await load();
  const config = {};
  await closeCompetitionNotificationModal({
    competitionNumber: 30,
    suppressCheckedRef: { current: true },
    updateConfig: async (patch) => Object.assign(config, patch),
    setModal: () => {},
  });
  assert.equal(config.missionCompetitionPopupSuppressedThroughNumber, 30);
  const options = {
    active: true,
    suppressedThroughNumber: config.missionCompetitionPopupSuppressedThroughNumber,
    shownThisSession: new Set(),
  };
  assert.equal(shouldShowCompetitionNotification({ ...options, competitionNumber: 30 }), false);
  assert.equal(shouldShowCompetitionNotification({ ...options, competitionNumber: 31 }), true);
  assert.equal(shouldShowCompetitionNotification({ ...options, competitionNumber: 31, active: false }), false);
});

test("competition API timestamps display readable dates in the user's timezone", async () => {
  const { formatCompetitionDateTime } = await load();
  const options = { locale: "en-US", timeZone: "America/Toronto" };
  assert.equal(
    formatCompetitionDateTime("2026-10-19T22:00:00.000Z", options),
    "Oct 19, 2026, 6:00 PM EDT",
  );
  assert.equal(
    formatCompetitionDateTime("2026-10-25T16:00:00.000Z", options),
    "Oct 25, 2026, 12:00 PM EDT",
  );
  assert.equal(formatCompetitionDateTime(null, options), "Unknown");
  assert.equal(formatCompetitionDateTime("Unknown", options), "Unknown");
});

test("competition checks run at startup and every hour, and stop on cleanup", async (t) => {
  const { startCompetitionChecks } = await load();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = startCompetitionChecks(async () => { calls += 1; });
  t.after(stop);
  t.mock.timers.tick(699);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(60 * 60 * 1000 - 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  stop();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(calls, 2);
});

test("slow competition checks do not overlap or restart after cleanup", async (t) => {
  const { startCompetitionChecks } = await load();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let calls = 0;
  const stop = startCompetitionChecks(() => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  t.after(stop);
  t.mock.timers.tick(700);
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(calls, 1);
  stop();
  finish();
  await flush();
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(calls, 1);
});
