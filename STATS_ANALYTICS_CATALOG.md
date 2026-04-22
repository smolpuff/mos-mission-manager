# Stats / Analytics Catalog

This is the current list of stats we already collect (or can directly derive), plus gaps for a future stats page.

## Already Collected (Live Runtime State)

Source: backend state emitted to desktop (`app.js` gui state)

- `currentMissionStats`
  - `total`
  - `available` (ready)
  - `active`
  - `claimable`
  - `claimed` (session)
  - `nfts`
  - `nftsAvailable`
- `sessionRewardTotals`
  - `pbp`
  - `tc`
  - `cc`
- `sessionSpendTotals`
  - `pbp` (reset/reroll/swap/unlock spend tracked as spend)
- `sessionClaimedCount`
- `config.totalClaimed` (lifetime local counter)
- `guiMissionSlots` (slot mission/name/level/progress metadata)
- `currentUserWalletSummary` (main wallet balances/snapshots)
- `fundingWalletSummary` (funding wallet balances)
- signer state:
  - `signerMode`
  - `signerStatus`
  - `signerReady`
  - `signerLocked`

## Already Logged (Text/Debug/Event Level)

Source: watch/check/signer logging and debug traces

- Claim event lines (success/failure) with mission/slot/level/reward/message.
- Claim counter updates with session and lifetime deltas.
- Session reward total updates.
- Session spend total updates.
- Mission-state transitions (start/restart/claim transition patterns).
- Reset error events (`reset_error`) and clear events (`reset_error_cleared`).
- Assign cycle events (`assigning`, `assigned`).
- Claiming cycle events (`claiming`).
- Watch cycle traces (start, parse, payload, followup, complete).

## Persisted File Telemetry Already Present

Source: signer audit file (`data/signer-audit.log` by default)

- Signer audit events including:
  - `sign_prepare_validated`
  - `sign_ok`
  - `sign_failed`
  - `sign_blocked_*` (cooldown, funds, replay, cost, disabled)
  - `dapp_sign_opened`
- Includes action context (action name, tool, cost, identifiers, token preview, errors).

## Stats Page Metrics You Can Show Immediately

- Mission claims:
  - session claims
  - lifetime claims (`totalClaimed`)
  - claim success rate (successful claim events / total claim events)
- Rewards:
  - session earned totals (`PBP`, `TC`, `CC`)
  - net PBP session (`sessionRewardTotals.pbp - sessionSpendTotals.pbp`)
- Spend:
  - session spend total in PBP
  - spend by action type (from signer audit/watch logs)
- Missions:
  - currently active/claimable/available mission counts
  - slot-level mission name + current level + progress
- Wallet:
  - main wallet balances
  - funding wallet balances
- Reliability:
  - reset error count
  - signer submit/sign failures vs successes
  - action block reasons (cooldown/funds/replay/cost)

## Requested Items and Mapping

- "how many NFTs used"
  - Currently available as current snapshot counts (`nfts`, `nftsAvailable`).
  - Historical unique NFT usage over time is not fully persisted yet.
- "what missions were claimed"
  - Available from claim event logs/traces during runtime.
  - Not yet persisted as a durable per-claim history table.
- "how many resets"
  - Can be counted from signer audit/watch action events (`nft_cooldown_reset`).
- "how much it made overall in tokens"
  - Session totals are already tracked.
  - Lifetime token totals are not fully persisted yet (only lifetime claim count is persisted).
- "cost in resets"
  - Session PBP spend already tracked.
  - Per-action historical spend can be derived from signer audit logs.
- "success rates"
  - Can be computed from claim and signer action success/failure events.

## Gaps (If You Want Full Historical Analytics)

- Durable per-claim event history (timestamp, mission id/name, slot, level, token, amount).
- Durable per-reset/per-reroll/per-swap history with cost and outcome.
- Lifetime reward totals by token (PBP/TC/CC), not just session.
- Unique NFT usage history over time (not just current snapshot).
- Daily/weekly rollups for trends.
