"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { importWalletAndVerify } = require("../src/wallet-import");
const { createSignerService } = require("../src/signer");
const { persistSignerConfig, flushConfig } = require("../src/config");

test("unlock verification failures always lock the imported wallet", async () => {
  const calls = [];
  const ctx = { signerMode: "app_wallet", signerConfig: {} };
  const signer = {
    setSignerMode: () => {}, importFromText: async () => calls.push("import"),
    unlock: async () => { calls.push("unlock"); throw new Error("internal secret details"); },
    lock: () => calls.push("lock"),
  };
  await assert.rejects(importWalletAndVerify({ signer, ctx, key: "private test input",
    save: () => calls.push("save") }), /Wallet imported, but verification failed/);
  assert.deepEqual(calls, ["import", "save", "unlock", "lock"]);
});

test("Settings wallet tools create, import and reveal with the runner stopped using real OS encryption", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "missions-wallet-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  let config = { signerMode: "app_wallet", targetMissions: ["Race!"] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const backendStatus = { running: false };
  const logs = [];
  let handler;
  let operate;
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf('  handleTrustedIpc("signer:import-wallet"');
  const end = source.indexOf('  handleTrustedIpc("onboarding:fetch-account"', start);
  const operationStart = source.indexOf("async function runDesktopWalletOperation(");
  const operationEnd = source.indexOf("async function requestBackend(", operationStart);
  vm.runInNewContext(source.slice(operationStart, operationEnd) + source.slice(start, end) + "\nsetOperation(runDesktopWalletOperation);", {
    setOperation: (fn) => { operate = fn; },
    handleTrustedIpc: (_name, fn, options) => { assert.equal(options.controlOnly, true); handler = fn; },
    walletOperationBusy: false, backendStatus, backend: null,
    requestBackend: () => assert.fail("Import must not require or start the runner"),
    readDesktopConfigWithMeta: () => ({ config: structuredClone(config), parseFailed: false }),
    getConfigPath: () => configPath,
    applyDesktopConfigPatch: async (patch) => { config = { ...config, ...patch }; await fs.writeFile(configPath, JSON.stringify(config)); },
    createSignerService, importWalletAndVerify, pushSystemLog: (line) => logs.push(line), publishStatus: () => {},
  });
  // This generated seed belongs only to this disposable test wallet.
  const key = JSON.stringify([...crypto.randomBytes(32)]);
  const pending = handler({}, key);
  await assert.rejects(handler({}, key), /already running/);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.locked, true);
  assert.equal(backendStatus.running, false);
  assert.equal(backendStatus.signerWallet, result.walletAddress);
  assert.equal(backendStatus.signerLocked, true);
  assert(!logs.join("\n").includes(key));
  const disk = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(disk.signer.walletAddress, result.walletAddress);
  assert(!JSON.stringify(disk).includes(key));
  // Reopen from disk in a fresh signer, matching a later runner start.
  const ctx = { config: disk, configPath, signerMode: "app_wallet", signerUnlockFailures: 0, signerUnlockAllowedAt: 0 };
  const signer = createSignerService(ctx, { logWithTimestamp: () => {}, logDebug: () => {} });
  try {
    await signer.unlock();
    assert.equal(ctx.signerReady, true);
    signer.lock("test");
    assert.equal(ctx.signerLocked, true);
    await assert.rejects(handler({}, "not a valid key"), /Import failed/);
    assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).signer.walletAddress, result.walletAddress);
    await signer.unlock();
    assert.equal(ctx.signerReady, true);
  } finally { signer.shutdown(); }

  const generated = await operate("signer_create_generated_wallet");
  assert.equal(generated.ok, true);
  assert(generated.created.mnemonic);
  assert.notEqual(generated.created.walletAddress, result.walletAddress);
  assert.equal(backendStatus.running, false);
  assert.equal(backendStatus.signerWallet, generated.created.walletAddress);
  assert.equal(backendStatus.signerLocked, true);
  const revealed = await operate("signer_reveal_backup");
  assert.equal(revealed.backup.walletAddress, generated.created.walletAddress);
  assert.equal(revealed.backup.mnemonic, generated.created.mnemonic);
  assert(!logs.join("\n").includes(generated.created.mnemonic));
  const generatedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(generatedConfig.signer.walletAddress, generated.created.walletAddress);
  const generatedCtx = { config: generatedConfig, configPath, signerMode: "app_wallet", signerUnlockFailures: 0, signerUnlockAllowedAt: 0 };
  const reopened = createSignerService(generatedCtx, { logWithTimestamp: () => {}, logDebug: () => {} });
  try {
    await reopened.unlock();
    assert.equal(generatedCtx.signerReady, true);
    reopened.lock("test");
    assert.equal(generatedCtx.signerLocked, true);
  } finally { reopened.shutdown(); }
});

test("runner import config survives normal config flush and preserves desktop settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "missions-import-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ signer: { walletAddress: "old" }, signerMode: "manual", autoUpdateCheckEnabled: false }));
  const signerConfig = { walletAddress: "new", walletRef: "test" };
  const ctx = { configPath, config: { signer: signerConfig, autoUpdateCheckEnabled: false }, signerConfig, signerMode: "app_wallet" };
  persistSignerConfig(ctx);
  flushConfig(ctx, () => {});
  const disk = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(disk.signer.walletAddress, "new");
  assert.equal(disk.signerMode, "app_wallet");
  assert.equal(disk.autoUpdateCheckEnabled, false);
});
