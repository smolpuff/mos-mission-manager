# Rental Snapshot and Scheduled Assignment Plan

## Goal

Use the one-per-60-seconds `get_rentable_nfts` allowance efficiently:

1. Search once and request a useful page of rental candidates.
2. Cache a bounded snapshot containing listing IDs, NFT accounts, cooldown data, and listing state.
3. Predict when each cached NFT should become usable.
4. Wake locally at those times and attempt assignment without searching again.
5. If one cached candidate fails, immediately try the next due candidate.
6. Refresh the rental snapshot only when the server cooldown safely permits it.

This replaces rapid rental polling. It does not change owned-NFT assignment, mission reset policy, or Auto level-20 behavior.

## Confirmed server contract

The authenticated live MCP schema for `get_rentable_nfts` states:

- At most one `tools/call` request every 60 seconds per authenticated user.
- An early rejected retry restarts the cooldown.
- The client must honor the HTTP `Retry-After` value.
- The tool supports `hideCooldowned`, `showRented`, `showOwned`, `sortOrder`, `page`, and `pageSize` up to 100.

The current 5.25/7.5-second rental fast-refresh loop must therefore be removed or replaced. The rental search cadence will be 61 seconds from the last actual rental-search attempt, with a server-provided `Retry-After` deadline taking precedence when it is later.

## Available response data

The live response currently provides fields including:

- `rentalListingId`
- NFT `account`
- `rentalStatus`
- `rentalLeaseId`
- `listingExpiresAt`
- `effectiveLeaseEndsAt`
- `usesRemaining`
- NFT level metadata
- `cooldown.cooldown_end_date`
- `cooldown.created_at`
- `cooldown.cooldown`

Cooldown readiness must prefer an explicit timestamp such as `cooldown_end_date`. The numeric `cooldown.cooldown` field must not be assumed to be seconds without validation; it may represent a duration in another unit. If no trustworthy end timestamp exists, mark readiness as unknown and defer that candidate to the next snapshot rather than inventing an unsafe timer.

## Proposed architecture

### 1. Rental search scheduler

Create one owner for `get_rentable_nfts`. No other assignment, UI, or refresh path may call the tool directly.

Responsibilities:

- Serialize every rental search.
- Record `lastAttemptAt`, `lastSuccessAt`, `nextAllowedAt`, and any server `Retry-After` deadline.
- Never call before `nextAllowedAt`.
- Coalesce simultaneous search requests into one pending refresh.
- Request up to 100 entries using:

```json
{
  "hideCooldowned": false,
  "showRented": false,
  "showOwned": false,
  "sortOrder": "cooldown_asc",
  "pageSize": 100
}
```

- Refresh immediately when rentals become needed if allowed; otherwise schedule exactly one wake-up for `nextAllowedAt`.
- Use exactly one second of client headroom beyond the 60-second boundary.

### 2. Normalized rental snapshot

Extend `normalizeRentalCandidates` to retain scheduling fields instead of reducing entries to only `listingId`, `account`, and `nft`.

Each cached candidate should contain:

```text
listingId
nftAccount
nftName
nftLevel
rentalStatus
rentalLeaseId
usesRemaining
listingExpiresAt
effectiveLeaseEndsAt
cooldownEndAt
readyAt
readinessSource
snapshotAt
snapshotGeneration
attemptCount
lastAttemptAt
lastFailureCode
quarantinedUntil
raw (optional, memory only)
```

Readiness rules:

1. Explicit active/ready flags from the response win when present.
2. Otherwise use a valid explicit cooldown-end timestamp.
3. If the timestamp is already past, set `readyAt = snapshotAt`.
4. If cooldown is explicitly absent, set `readyAt = snapshotAt`.
5. If cooldown timing is ambiguous, set `readyAt = null` and wait for the next permitted snapshot.

Filter out candidates that are already rented, have no listing ID/account, have no remaining uses, or are explicitly expired/paused/unavailable. Do not rely solely on `listingExpiresAt` if the server still reports the listing as usable; log inconsistencies and let assignment provide the final authority.

### 3. Bounded candidate cache

Keep between five and ten useful candidates from each snapshot, with a default target of five and a hard maximum of ten:

- Ready candidates first.
- Then earliest trustworthy `readyAt`.
- Then higher NFT level or the configured NFT-order policy.
- Deduplicate by both listing ID and NFT account.

Persist the normalized cache to `data/rental-candidate-snapshot.json` using atomic writes so a restart does not immediately waste a search. Persist only normalized non-secret data, not the entire raw MCP response.

On startup:

- Load the persisted snapshot.
- Discard structurally invalid entries.
- Recalculate due times against the current clock.
- Treat cached listings as hints, never as proof that a listing is still valid.
- Respect persisted `nextAllowedAt` before refreshing.

### 4. One local due-time scheduler

Use one timer/min-heap rather than one timer per NFT.

The scheduler wakes at the earliest of:

- The next candidate `readyAt` plus a small readiness buffer (for example 1–2 seconds).
- The next permitted rental snapshot time when more candidates are needed.
- A mission becoming unassigned and needing a rental.

When the system clock changes or the app resumes from sleep, recompute all due candidates instead of trusting an old timer delay.

### 5. Cached assignment worker

The assignment worker must be serialized with existing auto-assignment work.

When one or more target missions need NFTs:

1. Try owned ready NFTs according to existing policy.
2. Obtain all cached rental candidates whose `readyAt <= now` and are not quarantined.
3. Pass those candidates into the existing `autoAssignConfiguredMissions` prefetched-rental path.
4. Call `assign_nft_to_mission` directly with cached `rentalListingId`, NFT account, and `nftSource: "rental"`.
5. Do not call `get_rentable_nfts` immediately before assignment.
6. After a successful assignment, remove that listing/account from the cache and continue filling other open slots from the remaining due candidates.

If multiple rentals become ready together, try them in deterministic order. If candidate 1 fails, candidate 2 should be attempted immediately as long as assignment-tool rate limits permit it.

### 6. Failure classification

Do not treat every assignment failure the same way.

| Failure | Action |
| --- | --- |
| Listing gone, leased, paused, expired, or no uses | Remove candidate until the next snapshot; immediately try the next due candidate. |
| NFT still on cooldown / not ready yet | Preserve the candidate. On the first such response after its due-time attempt, retry that same NFT once after 1 second, before trying another candidate. If the second response is still cooldown, defer it until the next permitted snapshot and immediately try the next due cached candidate. If a trustworthy remaining time is supplied, schedule the same candidate for that time plus 1 second instead. |
| NFT incompatible with mission | Mark candidate incompatible with that mission/catalog ID for this snapshot generation; try it for other compatible missions if appropriate. |
| Mission already assigned or no longer active | Stop attempts for that mission and update from the returned authoritative mission state. |
| Assignment rate limit | Stop assignment attempts and resume at its `Retry-After`; do not invalidate the rental snapshot. |
| Authentication/network failure | Preserve the snapshot, apply bounded backoff, and do not repeatedly consume the rental-search allowance. |
| Unknown permanent-looking failure | Quarantine candidate for the current snapshot generation and try the next candidate. |

Maintain a per-snapshot failed-listing set, expanding the existing `rentalFastRefreshFailedListings` idea into structured failure records.

The live assignment test confirmed that a cooldown rejection can be plain text only:

```text
Error Starting Mission. NFT is on cooldown.
```

It did not include a remaining-time field. Treat that exact message (and compatible `not ready yet` wording) as the bounded same-candidate retry case above. A rate-limit response remains different: it stops every assignment attempt until its `Retry-After` deadline.

### 7. Snapshot refresh policy

Refresh when any of these are true and `nextAllowedAt` has arrived:

- A target mission is unassigned and there are no due cached candidates.
- Every cached candidate has failed or been consumed.
- All remaining candidates have unknown readiness.
- The current snapshot is at least 61 seconds old and rentals are still needed.
- The server explicitly tells us cached listing data is stale.

Do not refresh merely because a local timer ticks. If no mission needs a rental, retain the snapshot and make no call.

### 7.1 Batch cooldown-reset reconciliation

Other users or server processes may clear cooldowns for a large batch of rental NFTs without providing this app an event or predictable timestamp. The local scheduler cannot detect that immediately and must not poll early trying to discover it.

On every permitted 61-second snapshot refresh:

- Reconcile fresh rows against cached candidates by listing ID and NFT account.
- Replace predicted cooldown state with the newly returned authoritative cooldown state.
- Promote any candidate that became ready earlier than predicted into the ready queue immediately.
- Cancel or move its old local wake-up.
- Run the cached assignment worker immediately when an open mission needs a rental.
- Add newly ready candidates from the refreshed page even when they were not in the prior 5–10 candidate cache, then re-rank and retain at most ten.
- Remove listings that disappeared, became rented, expired, paused, or lost all remaining uses.

Missing a batch reset between searches is expected under the server contract. The next allowed snapshot is the recovery mechanism; the app must not compensate with an early search that would restart the 60-second cooldown.

### 8. UI and logging

Expose useful state without adding MCP calls:

- Last rental snapshot time.
- Next rental search allowed time.
- Number of cached ready/cooling/unknown candidates.
- Earliest predicted ready candidate.
- Current cached assignment attempt.
- Last failure and whether the next candidate is being tried.

Example logs:

```text
[RENTAL] Snapshot loaded: 8 cached, 1 ready, 7 cooling.
[RENTAL] Next cached candidate expected ready in 17s.
[RENTAL] Trying cached listing 1/3 for slot 2.
[RENTAL] Listing unavailable; trying cached listing 2/3.
[RENTAL] Rental search available in 41s; no early retry will be made.
```

## Implementation phases

### Phase 1: enforce the real tool limit

- Add `get_rentable_nfts` to the MCP client cooldown policy with a safe minimum interval greater than 60 seconds.
- Persist/honor `Retry-After` using the existing shared cooldown file.
- Replace the fast-refresh interval with the single rental search scheduler.
- Route the Rentals page preview through the same scheduler/cache so UI refreshes cannot consume or reset the runner's cooldown.

### Phase 2: snapshot normalization and persistence

- Preserve cooldown end timestamps and listing validity fields.
- Select and persist the best 5–10 snapshot candidates, never more than ten.
- Add startup restoration and validation.

### Phase 3: due-time assignment queue

- Add the single local due timer.
- Feed due cached candidates into the existing prefetched-rental assignment path.
- Continue through multiple candidates and multiple open mission slots in one pass.
- Remove the assumption that a rental must be freshly searched immediately before use.

### Phase 4: failure intelligence and UI

- Add failure classification/quarantine.
- Add snapshot/scheduler status to backend state and rental UI.
- Add concise operational logs and debug traces.

### Phase 5: remove obsolete behavior

- Remove `rentalFastRefreshTickMs` and rapid `setInterval` polling.
- Migrate or ignore old fast-refresh configuration safely.
- Update onboarding/docs to state the one-per-60-seconds rental-search contract.

## Tests required before release

### Cooldown ownership

- Multiple rental requests inside 60 seconds coalesce into one call.
- Early timers never call the tool.
- A 429 `Retry-After` moves `nextAllowedAt` and no retry occurs before it.
- A Rentals-page refresh cannot bypass the runner's scheduler.

### Cooldown parsing

- Explicit future `cooldown_end_date` schedules correctly.
- Past timestamps become ready immediately.
- Missing/invalid timestamps become unknown rather than guessed.
- Clock resume/rebase recalculates due candidates.

### Candidate queue

- Candidate 1 fails and candidate 2 succeeds without another rental search.
- Several candidates becoming ready together are tried in stable order.
- One snapshot fills multiple open slots without reusing a listing or NFT.
- A consumed/failed listing is not retried again in the same snapshot generation.
- An incompatible rental can be skipped for one mission without corrupting other mission attempts.
- A batch cooldown reset discovered on the next 61-second snapshot promotes newly ready rentals and triggers assignment immediately.
- Batch-reset reconciliation cancels obsolete predicted wake-ups and still retains no more than ten candidates.

### State and restart

- Snapshot persistence survives restart without an immediate search.
- Persisted `nextAllowedAt` prevents a restart from bypassing cooldown.
- Corrupt snapshot data is discarded safely.
- Successful assignment removes the cached candidate atomically.

### Regression coverage

- Owned-NFT priority remains unchanged.
- Normal/Mission/Auto reset policies remain unchanged.
- Auto level 20 still uses local owned NFTs only and rerolls when none are available, unless product policy explicitly changes.
- Mission cards never roll back from stale rental or mission snapshots.
- Assignment-tool and mission-tool cooldowns remain independent from the rental-search cooldown.

## Acceptance criteria

- `get_rentable_nfts` is never called more often than the server permits.
- No rejected early rental retry can restart the 60-second cooldown.
- A cached candidate is attempted near its predicted ready time without a new search.
- Failure of one cached candidate immediately advances to the next eligible due candidate.
- One snapshot can service several mission slots safely.
- UI rental browsing and background assignment share the same snapshot and cooldown owner.
- The scheduler remains correct across restart, sleep/wake, network failure, and stale listings.
