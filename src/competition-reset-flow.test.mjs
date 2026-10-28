import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { parseSync } from "rolldown/experimental";

const require = createRequire(import.meta.url);
const { createMissionActionExecutor } = require("./mission-actions.js");

function actualFunction(file, name) {
  const path = new URL(file, import.meta.url).pathname;
  const source = fs.readFileSync(path, "utf8");
  const { program, errors } = parseSync(path, source);
  assert.equal(errors.length, 0);
  let found;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration" && node.id.name === name) found = node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(program);
  assert.ok(found, name);
  return source.slice(found.start, found.end);
}

const signerGuard = actualFunction("./signer.js", "ensureMissionActionSupported");
const flows = [
  ["watch", actualFunction("./services/watch.js", "performMissionReroll")],
  ["assignment fallback", actualFunction("./services/checks.js", "performAutoModeMissionReroll")],
];

function fixture(mode, failSubmission = false) {
  const events = [], calls = [];
  const ctx = { signerMode: mode, signerConfig: { walletRef: "test-wallet" }, guiBridge: { sendEvent: (name, payload) => events.push({ name, payload }) } };
  const logger = { logWithTimestamp() {}, logDebug() {} };
  const ensureMissionActionSupported = vm.runInNewContext(`(${signerGuard})`, {
    ctx, logDebug() {}, normalizeActionName: value => value,
    SUPPORTED_MISSION_ACTIONS: new Set(["mission_reroll"]), assertSignerEnabled() {},
  });
  const signer = {
    ensureMissionActionSupported,
    async signPreparedMissionActionPayload() {
      ensureMissionActionSupported("mission_reroll");
      return { submitTool: "submit_signed_mission_reroll", submitArgs: {}, cost: 500 };
    },
  };
  const mcp = { async mcpToolCall(tool) {
    calls.push(tool);
    if (tool === "submit_signed_mission_reroll" && failSubmission) throw Error("Simulated rejected submission");
    return { structuredContent: { success: true, rerollCost: 500 } };
  } };
  const { executePreparedMissionAction } = createMissionActionExecutor(logger, mcp, signer);
  const globals = {
    ctx, signer, mcp, executePreparedMissionAction, Date,
    logDebug() {}, logWithTimestamp() {},
    missionAutomationEnabled: () => true,
    usesBrowserBridgeSigning: () => ctx.signerMode === "dapp",
    preparedActionSigningArgs: () => ({}),
    browserBridgeUrlFromPrepared: () => "https://example.invalid/signing",
    compactStructuredSummary: value => value,
    normalizeMissionList: () => [],
    assignedMissionId: mission => mission.assignedMissionId,
    missionName: mission => mission.name,
    missionLevel: mission => mission.level,
    addSessionSpendTotals() {}, scheduleFundingWalletRefresh() {},
    openMissionPlayPage: async () => ({ ok: true }),
    missionPageCooldownMs: () => 0, MISSION_PLAY_URL: "https://example.invalid/missions",
  };
  return { globals, signer, events, calls };
}

for (const [name, source] of flows) {
  for (const mode of ["app_wallet", "dapp", "manual"]) test(`${name}: only app-wallet submission emits a counted mission reset (${mode})`, async () => {
    const f = fixture(mode);
    const run = vm.runInNewContext(`(${source})`, f.globals);
    const mission = { assignedMissionId: "test-mission", name: "Race!", level: 5, slot: 1 };
    const invoke = async () => {
      // The watch caller checks the signer before entering its reset function.
      if (name === "watch") f.signer.ensureMissionActionSupported("mission_reroll");
      return run(mission);
    };
    if (name === "watch" && mode !== "app_wallet") await assert.rejects(invoke(), mode === "dapp" ? /Browser wallet signing is required/ : /manual mode selected/);
    else await invoke();
    const counted = f.events.filter(event => event.name === "stats_reset" && event.payload.resetType === "mission");
    assert.equal(counted.length, mode === "app_wallet" ? 1 : 0);
    assert.equal(f.calls.includes("submit_signed_mission_reroll"), mode === "app_wallet");
  });

  test(`${name}: a failed app-wallet submission never emits a counted reset`, async () => {
    const f = fixture("app_wallet", true);
    const run = vm.runInNewContext(`(${source})`, f.globals);
    await assert.rejects(run({ assignedMissionId: "test-mission", name: "Race!", level: 5, slot: 1 }), /Simulated rejected submission/);
    assert.equal(f.events.some(event => event.name === "stats_reset"), false);
  });
}
