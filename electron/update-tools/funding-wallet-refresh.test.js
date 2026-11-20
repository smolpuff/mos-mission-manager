"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fetchOnchainFundingWalletSummary } = require("../../src/wallet/onchain-summary");

function stateFixture() {
  const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const start = source.indexOf("function updateBackendStateFromIpc(payload)");
  const end = source.indexOf("function publishEvent(", start);
  const backendStatus = { fundingWalletSummary: null };
  const published = [];
  const context = { backendStatus, publishStatus: () => published.push(backendStatus.fundingWalletSummary) };
  vm.runInNewContext(source.slice(start, end), context);
  return { backendStatus, published, update: summary => context.updateBackendStateFromIpc({
    type: "pbp_state", state: { fundingWalletSummary: summary },
  }) };
}

const summary = (checkedAt, pbp, address = "funding-wallet") => ({
  address, checkedAt, pbp, sol: 1, status: "ok", source: "rpc",
});

test("a manually refreshed balance stays visible across stale runner snapshots", () => {
  const f = stateFixture();
  const manual = summary(2000, 200);
  f.backendStatus.fundingWalletSummary = manual;
  f.update(summary(1000, 100));
  assert.equal(f.backendStatus.fundingWalletSummary, manual);
  f.update({ ...summary(undefined, 100) });
  assert.equal(f.backendStatus.fundingWalletSummary, manual);
  assert.equal(f.published.length, 0);
  const newer = summary(3000, 150);
  f.update(newer);
  assert.equal(f.backendStatus.fundingWalletSummary, newer);
  assert.equal(f.published.at(-1), newer);
});

test("fresh wallet data still publishes on first load and when switching wallets", () => {
  const f = stateFixture();
  const first = summary(2000, 200);
  f.update(first);
  assert.equal(f.published.at(-1), first);
  const otherWallet = summary(1000, 100, "another-wallet");
  f.update(otherWallet);
  assert.equal(f.published.at(-1), otherWallet);
});

test("wallet checks carry their request-start time so an older in-flight check cannot look newer", async t => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { method } = JSON.parse(options.body);
    now = 5000;
    return Response.json({ result: method === "getBalance"
      ? { value: 2_000_000_000 }
      : { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 200 } } } } } }] } });
  });
  const result = await fetchOnchainFundingWalletSummary("funding-wallet");
  assert.equal(result.checkedAt, 2000);
  assert.equal(result.sol, 2);
  assert.equal(result.pbp, 200);
  assert.equal(now, 5000);
});
