"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture(fetchBackup) {
  const { createRecoveryPhraseController, emptyRecoveryPhraseState } = await import("../renderer/src/recovery-phrase.mjs");
  let state = emptyRecoveryPhraseState();
  const controller = createRecoveryPhraseController({ fetchBackup, onChange: next => { state = next; } });
  return { controller, state: () => state };
}

test("opening a recovery dialog does not fetch or decrypt; reveal does, hide clears it", async () => {
  let calls = 0;
  const { controller, state } = await fixture(async () => {
    calls++; return { ok: true, backup: { mnemonic: "synthetic recovery phrase" } };
  });
  controller.open();
  assert.equal(calls, 0);
  assert.equal(state().backup, null);
  await controller.toggleReveal();
  assert.equal(calls, 1);
  assert.equal(state().backup.mnemonic, "synthetic recovery phrase");
  await controller.toggleReveal();
  assert.equal(state().revealed, false);
  assert.equal(state().backup, null);
  await controller.toggleReveal();
  assert.equal(calls, 2);
  controller.close();
  assert.equal(state().backup, null);
  assert.equal(state().open, false);
});

test("closing and reopening cannot resurrect an outstanding recovery response", async () => {
  const pending = [];
  const { controller, state } = await fixture(() => new Promise(resolve => pending.push(resolve)));
  controller.open();
  const first = controller.toggleReveal();
  controller.close();
  controller.open();
  const second = controller.toggleReveal();
  pending[0]({ ok: true, backup: { mnemonic: "stale secret" } });
  await first;
  assert.equal(state().backup, null);
  assert.equal(state().busy, true);
  pending[1]({ ok: true, backup: { mnemonic: "current secret" } });
  await second;
  assert.equal(state().backup.mnemonic, "current secret");
  controller.close();
  assert.equal(state().backup, null);
});

test("unmount invalidates a reveal; duplicate clicks cannot start parallel requests", async () => {
  let resolve, calls = 0;
  const { controller, state } = await fixture(() => { calls++; return new Promise(done => { resolve = done; }); });
  controller.open();
  const request = controller.toggleReveal();
  await controller.toggleReveal();
  assert.equal(calls, 1);
  controller.dispose();
  resolve({ ok: true, backup: { mnemonic: "must not arrive" } });
  await request;
  assert.equal(state().backup, null);
});

test("failed reveal keeps the phrase absent and allows retry", async () => {
  const { controller, state } = await fixture(async () => ({ ok: false, error: "Vault unavailable" }));
  controller.open();
  await controller.toggleReveal();
  assert.equal(state().backup, null);
  assert.equal(state().revealed, false);
  assert.equal(state().busy, false);
  assert.equal(state().error, "Vault unavailable");
});
