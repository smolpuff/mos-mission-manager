"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  normalizeMissionList,
  latestMissionResultFromClaims,
} = require("../src/missions/normalize");
const { shouldRetryAssignmentOption } = require("../src/services/checks");

const repoRoot = path.resolve(__dirname, "..");

function mission(id, slot, assignedNft = null) {
  return {
    assigned_mission_id: id,
    slot,
    name: `mission-${slot}`,
    assigned_nft: assignedNft,
  };
}

test("normalizes documented claim and assignment mutation mission shapes", () => {
  const direct = { missions: [mission("a", 1)] };
  const structured = {
    structuredContent: { missions: [mission("b", 2)] },
  };
  const nested = {
    structuredContent: { missions: { missions: [mission("c", 3)] } },
  };

  assert.equal(normalizeMissionList(direct)[0].assigned_mission_id, "a");
  assert.equal(normalizeMissionList(structured)[0].assigned_mission_id, "b");
  assert.equal(normalizeMissionList(nested)[0].assigned_mission_id, "c");
});

test("two claims use the second claim mutation as authoritative state", () => {
  const afterFirstClaim = {
    structuredContent: {
      missions: [mission("replacement-1", 1), mission("old-2", 2, "nft")],
    },
  };
  const afterSecondClaim = {
    structuredContent: {
      missions: [mission("replacement-1", 1), mission("replacement-2", 2)],
    },
  };
  const result = latestMissionResultFromClaims([
    { assignedMissionId: "old-1", claimResult: afterFirstClaim },
    { assignedMissionId: "old-2", response: afterSecondClaim },
  ]);

  assert.equal(result, afterSecondClaim);
  assert.deepEqual(
    normalizeMissionList(result).map((entry) => entry.assigned_mission_id),
    ["replacement-1", "replacement-2"],
  );
});

test("each assignment response is propagated and missing mutation state halts", () => {
  const checksSource = fs.readFileSync(
    path.join(repoRoot, "src/services/checks.js"),
    "utf8",
  );

  assert.match(checksSource, /currentMissionResult = assignResult;\s*missions = responseMissions;/);
  assert.match(
    checksSource,
    /assign_nft_to_mission succeeded without authoritative missions state/,
  );
  assert.doesNotMatch(
    checksSource,
    /patchMissionResultAfterAssignment\(currentMissionResult/,
  );
  assert.equal(
    shouldRetryAssignmentOption({
      abortedForMutationState: true,
      source: "rental",
      hasNext: true,
      retryable: true,
    }),
    false,
  );
  assert.equal(
    shouldRetryAssignmentOption({
      abortedForMutationState: true,
      source: "owned_cooldown",
      hasNext: true,
    }),
    false,
  );
});

test("successful claims and assignments have no confirmation-read fallbacks", () => {
  const watchSource = fs.readFileSync(
    path.join(repoRoot, "src/services/watch.js"),
    "utf8",
  );

  assert.doesNotMatch(watchSource, /post_claim_settle_wait/);
  assert.doesNotMatch(watchSource, /after_assign_legacy_fallback/);
  assert.doesNotMatch(watchSource, /after_fallback_assign/);
  assert.doesNotMatch(watchSource, /claim_followup_refetched_after_assign/);
  assert.match(
    watchSource,
    /fallbackMutationStateMissing = fallback\?\.mutationStateMissing === true;\s*}\s*if \(fallbackMutationStateMissing\)/,
  );
  assert.match(
    watchSource,
    /if \(assignResult\?\.mutationStateMissing === true\) return true;/,
  );
  assert.match(
    watchSource,
    /currentClaimed > 0 && !missionStateAuthoritative[\s\S]*ctx\.missionMutationStateBlockedUntil = Date\.now\(\) \+ 60_000;/,
  );
  assert.match(
    watchSource,
    /!hasClaimActivity &&\s*\(clientPollingEnabled \|\| !postCycleMissionResult\)/,
  );
});
