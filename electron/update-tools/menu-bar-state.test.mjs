// Mac menu bar temporarily disabled; retained for later work.
// import test from "node:test";
// import assert from "node:assert/strict";
// import { missionCards, missionImage, runnerLabel, startFromMenuBar } from "../menu-bar-state.js";
//
// test("four ordered cards retain mission data and distinguish empty and claimable slots", () => {
//   const cards = missionCards({ guiMissionSlots: [
//     { slot: 3, missionName: "Third", missionActive: true, assignedNft: "NFT", progress: 12, goal: 10 },
//     { slot: 1, missionName: "First", progress: null, goal: null },
//   ] });
//   assert.deepEqual(cards.map((card) => card.slot), [1, 2, 3, 4]);
//   assert.equal(cards[0].state, "No NFT assigned");
//   assert.equal(cards[0].progressText, "—");
//   assert.equal(cards[1].state, "Empty");
//   assert.equal(cards[2].state, "Claimable");
//   assert.equal(cards[2].percent, 100);
//   assert.equal(cards[2].progressText, "12 / 10");
// });
//
// test("runner state does not confuse a paused watcher with a stopped process", () => {
//   assert.equal(runnerLabel({ running: false }), "Stopped");
//   assert.equal(runnerLabel({ running: true }), "Starting…");
//   assert.equal(runnerLabel({ running: true, watcherRunning: true }), "Watching missions...");
//   assert.equal(runnerLabel({ running: true, watchLoopEnabled: false }), "Paused");
// });
//
// test("slot four is ghosted as locked only when the main app's unlock state confirms it", () => {
//   const status = {
//     slotUnlockSummary: { canUnlockMore: true, nextUnlockSlot: 4 },
//     guiMissionSlots: [{ slot: 4, missionName: "Old mission", nftImage: "https://example.com/old.png" }],
//   };
//   const cards = missionCards(status);
//   assert.equal(cards[3].locked, true);
//   assert.equal(cards[3].name, "Locked");
//   assert.equal(cards[3].imageSrc, null);
//   assert.ok(cards.slice(0, 3).every((card) => !card.locked));
//   assert.equal(missionCards({ ...status, slotUnlockSummary: { canUnlockMore: false, nextUnlockSlot: 4 } })[3].locked, false);
//   assert.equal(missionCards({ ...status, slotUnlockSummary: { canUnlockMore: true, nextUnlockSlot: 5 } })[3].locked, false);
//   assert.equal(missionCards({})[3].locked, false);
// });
//
// test("NFT artwork takes priority over mission artwork and resolves the app's supported image URLs", () => {
//   assert.equal(missionImage({ nftImage: "https://example.com/nft.png", image: "https://example.com/mission.png" }), "https://example.com/nft.png");
//   assert.equal(missionImage({ assignedNftImage: "ipfs://ipfs/bafyexample/art.png" }), "https://ipfs.io/ipfs/bafyexample/art.png");
//   assert.equal(missionImage({ nftImage: "gateway.irys.xyz/art" }), "https://gateway.irys.xyz/art");
//   assert.equal(missionImage({ assignedNft: { image: "//example.com/art.png" } }), "https://example.com/art.png");
//   assert.equal(missionImage({ nftImage: "invalid", assignedNftImage: "https://example.com/art.png" }), "https://example.com/art.png");
//   assert.equal(missionImage({ nftImage: "javascript:alert(1)" }), null);
//   assert.equal(missionCards({ guiMissionSlots: [{ slot: 1, nftImage: "https://example.com/nft.png" }] })[0].imageSrc, "https://example.com/nft.png");
// });
//
// test("Start applies persisted modes and resumes through the existing backend actions", async () => {
//   for (const [config, expected] of [
//     [{ autoModeEnabled: true }, ["start", "am on", "resume"]],
//     [{ missionModeEnabled: true, missionModeResetLevel: "15" }, ["start", "mm 15", "resume"]],
//     [{ missionModeEnabled: true, missionModeResetLevel: "invalid" }, ["start", "mm 10", "resume"]],
//     [{ level20ResetEnabled: true }, ["start", "mm off", "20r on", "resume"]],
//     [{}, ["start", "mm off", "20r off", "resume"]],
//   ]) {
//     const calls = [];
//     await startFromMenuBar({
//       getConfig: async () => ({ config }),
//       startBackend: async () => { calls.push("start"); return {}; },
//       sendCommand: async (command) => calls.push(command),
//     }, { running: false });
//     assert.deepEqual(calls, expected);
//   }
// });
//
// test("a cancelled start does not send mode or resume commands", async () => {
//   await startFromMenuBar({
//     getConfig: async () => ({ config: {} }),
//     startBackend: async () => ({ startCancelled: true }),
//     sendCommand: async () => assert.fail("command after cancelled start"),
//   }, { running: false });
// });
