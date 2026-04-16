# Dapp Reroll/Reset Handoff

Updated: 2026-04-12

## Current status

- `mission_swap` browser-bridge flow works because `prepare_mission_swap` returns:
  - `signingBridgeUrl`
  - `signingBridgePath`
  - `signingMethods.browserBridge.signingUrl`
  - `missionSwapId`
- `mission_reroll`, `prepare_nft_cooldown_reset`, and `unlock_mission_slot` do **not** return equivalent bridge fields in live MCP responses tested from this repo.
- Because of that, the app cannot open a real MCP signing bridge URL for reroll/reset the same way it can for swap.

## Verified live MCP behavior

### `prepare_mission_reroll`

Tested with:

```json
{
  "assignedMissionId": "eb95df8f-e45f-410d-a2fb-129131826755",
  "signingMode": "browser_bridge"
}
```

Returned keys:

- `success`
- `assignedMissionId`
- `rerollCost`
- `transaction`
- `rerollToken`
- `note`
- `agentWalletGuide`

Missing:

- `signingBridgeUrl`
- `signingBridgePath`
- `signingMethods.browserBridge.signingUrl`
- any reroll-specific bridge id

Same result when trying:

- `signingMode: "browser_bridge"`
- `signingMode: "browserBridge"`
- `signingMode: "url"`

### `prepare_mission_swap`

Swap does return the bridge fields and a working URL shaped like:

```text
https://pixelbypixel.studio/mcp/sign-mission-swap?missionSwapId=msw_...
```

This was captured in `debug-mission-swap-log.md`.

## Verified frontend behavior

From the live PbP missions page bundle:

- reroll/reset is handled by the missions UI flow using:
  - `POST /api/user/missions/reset`
  - wallet sign in-browser
  - `PUT /api/user/missions/reset`
- I did **not** find a public `sign-mission-reroll` bridge route string in the fetched mission page JS bundle.

## Local code state

### `src/signer.js`

- `dapp` mode no longer runs local cooldown/replay/funding/cost/manual-approval gates before opening a browser URL.
- Right now it falls back to opening:

```text
https://pixelbypixel.studio/missions/play
```

for:

- `mission_reroll`
- `nft_cooldown_reset`
- `mission_slot_unlock`

This fallback was only added to avoid hard-failing when MCP omits bridge fields.

## Important conclusion

The blocker is **not** local signing code anymore.

The blocker is that reroll/reset prepare payloads currently do not expose the bridge URL or bridge id needed to reproduce the swap-style MCP signing flow.

## Next sensible options

1. Remove the `/missions/play` fallback and fail hard unless a real bridge URL exists.
2. Get one real working reroll MCP signing URL from PbP and replicate its exact parameter format.
3. Escalate upstream: reroll/reset/unlock should return bridge metadata the same way swap does.

## Useful files

- `debug-mission-swap-log.md`
- `debug-race-reroll-attempt.json`
- `debug-burner-env-reroll-proof.json`
- `scripts/debug-reroll-browser-bridge.js`
- `src/signer.js`
- `src/services/watch.js`
- `src/services/checks.js`
