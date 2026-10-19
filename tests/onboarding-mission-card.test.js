"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("selected account mission keeps its level and NFT when catalog metadata exists", async () => {
  const { resolveOnboardingMissionCard } = await import("../renderer/src/onboarding-mission-card.mjs");
  const assigned = { name: "Race!", slot: 1, currentLevel: 23, hasAssignedNft: true,
    assignedNft: "My NFT", assignedNftImage: "https://example.com/nft.png" };
  const card = resolveOnboardingMissionCard("Race!", { name: "Race!", description: "Catalog description" }, assigned);
  assert.equal(card.currentLevel, 23);
  assert.equal(card.assignedNft, "My NFT");
  assert.equal(card.assignedNftImage, assigned.assignedNftImage);
  assert.equal(card.description, "Catalog description");
});

test("a different mission selection cannot inherit the old assignment or level", async () => {
  const { resolveOnboardingMissionCard } = await import("../renderer/src/onboarding-mission-card.mjs");
  const assigned = { name: "Race!", currentLevel: 23, hasAssignedNft: true, assignedNft: "Old NFT" };
  const catalog = { name: "Do it All!" };
  assert.deepEqual(resolveOnboardingMissionCard("Do it All!", catalog, assigned), catalog);
  assert.equal(resolveOnboardingMissionCard("Unknown mission", null, assigned), null);
  assert.deepEqual(resolveOnboardingMissionCard("", null, assigned), assigned);
});
