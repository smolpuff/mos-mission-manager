"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createChecksService } = require("./checks");

const nft = (index, ready = false) => ({
  account: `owned-${index}`, name: `Owned ${index}`, level: 5,
  onCooldown: !ready, cooldownSeconds: ready ? 0 : 3600,
});
const coolingPage = Array.from({ length: 200 }, (_, index) => nft(index));

async function assignScenario(t, { offset = 200, pages, failAt, repeatPage = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owned-before-rentals-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scanPath = path.join(directory, "scan.json");
  fs.writeFileSync(scanPath, JSON.stringify({ offset, cycle: 0 }));
  const mission = {
    assigned_mission_id: "mission-1", name: "Race for Points", slot: 1,
    current_level: 5, active: true, completed: false, assigned_nft: null,
  };
  const missionsResult = { structuredContent: { missions: { missions: [mission] } } };
  const calls = [];
  const ctx = {
    config: { targetMissions: [mission.name], enableRentals: true },
    nftAssignmentScanPath: scanPath,
    watchLoopEnabled: true,
    lastUserMissionsResult: missionsResult,
    currentMissionStats: { nftsAvailable: 104 },
  };
  const mcp = {
    async getUserMissions() { return missionsResult; },
    async mcpToolCall(tool, args) {
      if (tool === "get_mission_nfts") {
        calls.push({ tool, offset: args.offset });
        if (args.offset === failAt) throw new Error("Inventory read is rate limited");
        return { structuredContent: { nfts: repeatPage ? coolingPage : pages[args.offset] || [] } };
      }
      if (tool === "assign_nft_to_mission") {
        calls.push({ tool, account: args.nftAccount });
        return { structuredContent: { success: true, missions: { missions: [{ ...mission, assigned_nft: args.nftAccount }] } } };
      }
      throw new Error(`Unexpected MCP call: ${tool}`);
    },
  };
  const rentals = {
    setDemand(needed) { if (needed) calls.push({ tool: "rental_demand" }); },
    async requestSearch() { calls.push({ tool: "rental_search" }); },
    async runAssignmentWorker() {
      calls.push({ tool: "rental_assign" });
      return { successes: 0 };
    },
  };
  const logger = {
    logWithTimestamp() {}, logDebug() {}, redrawHeaderAndLog() {},
    formatTaggedLog(_tag, _icon, text) { return text; },
  };
  const checks = createChecksService(ctx, logger, mcp, { rentals });
  const result = await checks.autoAssignConfiguredMissions({ reason: "post_claim", missionsResult });
  return { result, calls };
}

test("104 ready NFTs on page one prevent any rental demand after a cooling tail page", async (t) => {
  const firstPage = Array.from({ length: 200 }, (_, index) => nft(index, index < 104));
  const tail = Array.from({ length: 37 }, (_, index) => nft(index + 200));
  const { result, calls } = await assignScenario(t, { pages: { 0: firstPage, 200: tail } });
  assert.equal(result.assigned, 1);
  assert.deepEqual(calls.slice(0, 2), [
    { tool: "get_mission_nfts", offset: 200 },
    { tool: "get_mission_nfts", offset: 0 },
  ]);
  assert.equal(calls[2].tool, "assign_nft_to_mission");
  assert.equal(calls.length, 3, "Never search, queue, or assign a rental while owned NFTs are ready");
});

test("ready owned NFTs on a later page are assigned in the same pass", async (t) => {
  const { result, calls } = await assignScenario(t, {
    offset: 0, pages: { 0: coolingPage, 200: [nft(200, true)] },
  });
  assert.equal(result.assigned, 1);
  assert.deepEqual(calls, [
    { tool: "get_mission_nfts", offset: 0 },
    { tool: "get_mission_nfts", offset: 200 },
    { tool: "assign_nft_to_mission", account: "owned-200" },
  ]);
});

test("rentals are considered only after checking earlier and later owned pages", async (t) => {
  const { calls } = await assignScenario(t, {
    pages: { 0: coolingPage, 200: [nft(200)] },
  });
  assert.deepEqual(calls.slice(0, 2), [
    { tool: "get_mission_nfts", offset: 200 },
    { tool: "get_mission_nfts", offset: 0 },
  ]);
  assert.equal(calls[2].tool, "rental_demand");
  assert.ok(calls.some(({ tool }) => tool === "rental_search"));
});

test("a failed owned-page lookup defers instead of using rentals", async (t) => {
  const { result, calls } = await assignScenario(t, {
    pages: { 200: [nft(200)] }, failAt: 0,
  });
  assert.equal(result.assigned, 0);
  assert.deepEqual(calls.map(({ tool }) => tool), ["get_mission_nfts", "get_mission_nfts"]);
});

test("a server that repeats pages cannot falsely exhaust owned inventory", async (t) => {
  const { result, calls } = await assignScenario(t, { offset: 0, pages: {}, repeatPage: true });
  assert.equal(result.assigned, 0);
  assert.deepEqual(calls.map(({ tool }) => tool), ["get_mission_nfts", "get_mission_nfts"]);
});
