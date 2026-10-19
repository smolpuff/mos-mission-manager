"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWalletGenerationRequest, WALLET_GENERATION_TIMEOUT_MS, WALLET_GENERATION_SLOW_MS } = require("../electron/wallet-generation");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("slow wallet generation keeps its result and joins retries after 30 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backend = deferred();
  let calls = 0, slow = 0;
  const generate = createWalletGenerationRequest(() => {
    calls++;
    return backend.promise;
  }, { onSlow: () => { slow++; } });
  const first = generate();
  await Promise.resolve();
  t.mock.timers.tick(WALLET_GENERATION_SLOW_MS - 1);
  assert.equal(slow, 0);
  t.mock.timers.tick(1);
  assert.equal(slow, 1);
  const retry = generate();
  assert.equal(retry, first);
  assert.equal(calls, 1);
  const result = { ok: true, created: { walletAddress: "test-address", mnemonic: "test phrase" } };
  backend.resolve(result);
  assert.equal(await first, result);
  assert.equal(await retry, result);
});

test("60-second timeout stops waiting, blocks another write, and Retry retrieves late success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backend = deferred();
  let calls = 0;
  const generate = createWalletGenerationRequest(() => { calls++; return backend.promise; });
  const first = generate();
  await Promise.resolve();
  const timeout = assert.rejects(first, /did not finish within 60 seconds/);
  t.mock.timers.tick(WALLET_GENERATION_TIMEOUT_MS);
  await timeout;
  assert.equal(generate(), first);
  await assert.rejects(generate(), /Retry will check the original operation/);
  assert.equal(calls, 1);
  const result = { ok: true, created: { walletAddress: "late-wallet", mnemonic: "late phrase" } };
  backend.resolve(result);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await generate(), result);
  assert.equal(calls, 1);
});

test("a definitive backend error after timeout permits a fresh retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backend = deferred();
  let calls = 0;
  const generate = createWalletGenerationRequest(() => ++calls === 1 ? backend.promise : { ok: true });
  const first = generate();
  await Promise.resolve();
  const timeout = assert.rejects(first, /60 seconds/);
  t.mock.timers.tick(WALLET_GENERATION_TIMEOUT_MS);
  await timeout;
  backend.reject(new Error("Vault write failed and rolled back"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await generate(), { ok: true });
  assert.equal(calls, 2);
});

test("concurrent generation requests make one write; completion allows an intentional new wallet", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, slow = 0;
  const generate = createWalletGenerationRequest(async () => ({ wallet: ++calls }), {
    onSlow: () => { slow++; },
  });
  const first = generate();
  assert.equal(generate(), first);
  assert.deepEqual(await first, { wallet: 1 });
  t.mock.timers.tick(WALLET_GENERATION_TIMEOUT_MS);
  assert.equal(slow, 0);
  assert.deepEqual(await generate(), { wallet: 2 });
});

test("backend exit rejects every waiter and permits retry without retaining an old result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backend = deferred();
  let calls = 0, slow = 0;
  const generate = createWalletGenerationRequest(() => {
    calls++;
    return calls === 1 ? backend.promise : { ok: true };
  }, { onSlow: () => { slow++; } });
  const first = generate();
  const second = generate();
  backend.reject(new Error("Backend exited before completing the request"));
  await assert.rejects(first, /Backend exited/);
  await assert.rejects(second, /Backend exited/);
  t.mock.timers.tick(WALLET_GENERATION_TIMEOUT_MS);
  assert.equal(slow, 0);
  assert.deepEqual(await generate(), { ok: true });
});

test("a synchronous generation error also clears the in-flight operation", async () => {
  let calls = 0;
  const generate = createWalletGenerationRequest(() => {
    if (++calls === 1) throw new Error("Backend is not running");
    return { ok: true };
  });
  await assert.rejects(generate(), /Backend is not running/);
  assert.deepEqual(await generate(), { ok: true });
});
