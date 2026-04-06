# Rental Reimplementation Notes

Purpose: preserve the removed rental automation work so it can be re-added later without re-discovering the same dead ends.

## Status

Rental automation was removed from runtime code on 2026-04-05.

Reason:
- the implemented flow broke normal mission assignment by falling back to owned NFTs
- the currently exposed MCP rental tools do not match the renter-side workflow you actually use
- `mm` must remain safe and usable for mission reset behavior

Current rule:
- no rental mode exists in code
- `mm` is mission-reset only again
- no header, command, config, or assign path contains rental logic

## What Was Implemented Before Removal

Rental runtime/config state had been added in:
- `src/context.js`
- `src/config.js`

Rental commands had been added in:
- `src/commands.js`
- `normal`
- `troll`
- `7day`
- `mm` auto-enabled rental mission mode

Rental header display had been added in:
- `src/logger.js`
- showed `Rentals <count>` when rental mode was active

Rental assignment logic had been added in:
- `src/services/checks.js`
- rental mode normalization
- mission-to-rental preference rules
- rental pool loading
- rental-first selection with owned fallback

## Exact Removed Logic

The removed `checks.js` implementation did all of the following:

1. Normalized rental mode from config/runtime:
- `off`
- `cooldown`
- `mission`
- `troll`

2. Chose when rentals should be preferred:
- `mission`: while mission mode was enabled
- `cooldown`: levels `5`, `10`, `15`
- `troll`: always

3. Built a rental pool by calling:
- `get_rental_dashboard`
- then extracting mints from `structuredContent.alreadyListed`
- then calling `list_rental_nfts({ nftMints })`

4. Parsed successful `list_rental_nfts` results into assignable `nftAccount` values

5. In `autoAssignConfiguredMissions()`:
- tried rental first
- if no rental account existed and mode was `mission`, fell back to owned NFT

6. Added rental count to header refresh

## Why That Logic Failed

The central mistake was assuming the exposed rental MCP tools described renter-side inventory.

Observed tool set:
- `get_rental_dashboard`
- `list_rental_nfts`
- `get_rental_lease_history`

Observed descriptions:
- `get_rental_dashboard`: authenticated user rental dashboard buckets and counts
- `list_rental_nfts`: list one or more owned NFTs for rent
- `get_rental_lease_history`: lease history for authenticated user's NFTs

Observed live dashboard shape:
- `eligibleToList`
- `alreadyListed`
- `notEligible`
- `counts`

Observed sample entries looked owner-side, not renter-side:
- contained `ownerWalletId` matching the authenticated wallet
- contained reasons like `not_frozen`
- contained `rentalListingId: null`
- contained `rentalLeaseId: null`

Observed `assign_nft_to_mission` request shape:
- `assignedMissionId`
- `nftAccount`

Observed successful assign response hints:
- returned `nft_source`
- returned `rental_lease_id`

Observed actual success payloads in logs:
- `nft_source: "owned"`
- `rental_lease_id: null`

Conclusion:
- the removed code was wired to owner-side rental tools
- your actual renter workflow happens when starting a mission on the website
- there was no confirmed MCP renter-side discovery/start flow available to this app

## Real Workflow Constraint

Important user clarification:
- there is no pool of pre-rented NFTs waiting in your account
- rental happens at mission start time on the website
- therefore `assign_nft_to_mission` alone is probably not the renter-side start flow

That means the future solution likely needs one of these:
- a renter-side MCP tool that discovers and starts a rental-backed mission
- a different website/API-backed action that both rents and starts in one step
- a confirmed post-rental account source if the website creates a rented `nftAccount` before assignment

## User-Visible Failure Mode That Occurred

Because rental pool resolution returned zero, the old code did this:
- `mm` turned on rental mission mode automatically
- rental selection found nothing
- assignment silently fell back to owned NFT
- normal mission flow was affected even though renter automation was not actually working

That is the primary reason the code was removed instead of merely hidden.

## Files That Previously Changed

Removed rental-related changes had touched:
- `src/context.js`
- `src/config.js`
- `src/commands.js`
- `src/logger.js`
- `src/services/checks.js`
- `config.sample.json`

## Safe Reimplementation Plan

When re-adding this later, do it in this order:

1. Confirm the true renter-side source
- identify the exact MCP tool or website/API call that starts a mission with a rental from another user

2. Prove the data model with one real success example
- capture a successful rental-backed mission start
- verify whether mission payload shows:
- `nft_source: "rental"`
- non-null `rental_lease_id`
- any returned rental account/mint identifiers

3. Keep renter and owner flows separate
- do not reuse owner-side dashboard/listing tools for renter-side assignment
- do not infer renter availability from `eligibleToList`, `alreadyListed`, or `notEligible`

4. Add one dedicated helper only
- preferred future shape:
- `resolveRentalCandidateForMission(mission)`
- or `startMissionWithRental(mission)`

5. Fail closed
- if rental mode is enabled and no renter-side rental candidate is available, do not consume owned NFTs unless there is an explicit user setting allowing fallback

6. Only after renter path is proven, add UI extras
- header count
- commands
- config persistence

## Guardrails For Future Re-add

Do not re-add any of the following without a confirmed renter-side tool:
- rental-first fallback to owned inside mission mode
- header rental counts derived from owner dashboard buckets
- command toggles that alter assignment behavior
- auto-enabling rental behavior from `mm`

## Useful Debug Markers For Future Work

If rental support is reintroduced later, log these in debug:
- source tool name used to discover renter candidate
- mission id and mission name
- selected rental account or rental mint
- final `assign_nft_to_mission` request args
- returned `nft_source`
- returned `rental_lease_id`
- whether fallback to owned was allowed or blocked
