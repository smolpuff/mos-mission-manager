# Features Tracker

Purpose: single source of truth for implemented and planned features, used for README/release update notes.

## Process Rule

- Every feature add/remove/change must update this file in the same change.
- Keep entries concise and user-facing (what it does, not deep internals).

## Implemented

- Modularized app architecture (no single-file blob):
  - `app.js` is bootstrap/orchestration only.
  - `src/context.js` shared runtime state/constants.
  - `src/logger.js` terminal UI + normal/debug logging.
  - `src/config.js` config load/save.
  - `src/mcp/client.js` MCP auth/session/tool-call client.
  - `src/missions/normalize.js` mission model normalization helpers.
  - `src/services/checks.js` startup/status data checks.
  - `src/services/watch.js` watch/claim loop runtime.
  - `src/commands.js` readline command handling.
- JS-only runtime app (`app.js`) with MCP-based auth + tool calls.
- OAuth login flow with token persistence (`~/.pbp-mcp/token.json`).
  - auth callback page auto-closes after successful login.
  - interactive login auto-opens browser and attempts compact window sizing on macOS/Windows/Linux where supported.
- Token-first startup behavior with fallback login when token is missing.
- Debug mode support (`--debug`) with structured debug logging.
- Startup mission catalog validation:
  - fetches full mission catalog via `get_mission_catalog`
  - validates `targetMissions` entries against catalog names/IDs in memory and logs mismatches
- Mission header counters from `get_user_missions`:
  - `active` (assigned NFT + active mission)
  - `available` (no assigned NFT)
  - `claimable`
  - `claimed` (session-local)
- `watch_and_claim` loop:
  - poll interval default 30s
  - cycle duration defaults to `watchMaxLimitSeconds - 6 minutes` (minimum 60s)
  - optional override via `watchCycleSeconds` (capped by `watchMaxLimitSeconds`)
  - direct claim scan runs before watch polling so claim attempts do not depend only on `watch_and_claim`
  - per-cycle mission/header refresh
  - session + persisted claimed tracking updates
  - normal mode stays concise; payload/counter internals are debug-only logs
  - per-claim success lines + claimed counter update lines are emitted when claims are detected
  - immediate post-claim assign check runs, with short retry windows for state sync
  - reset-threshold detection checks run immediately (startup, manual process, and poll ticks), so manual reset popup is not delayed to cycle end
  - duplicate popup suppression avoids reopening the same manual-reset prompt repeatedly for unchanged mission hits
- Auto-assign for selected missions:
  - reads `targetMissions` from `config.json` (array of mission names or mission IDs)
  - runs at startup and at cycle boundaries for unassigned matching missions; does not blindly spam assignment every tick
  - startup order is: startup claim sweep -> startup assign check -> start watch loop
  - normal-mode assign success lines are compact; debug includes missionId/slot/nft details
- Runtime watch controls:
  - `pause`
  - `resume`
- Optional startup ASCII FX overlay:
  - static/noise "hacked" screen animation before normal UI.
  - source-controlled in `app.js` (not user-configurable via `config.json`).
- Error handling coverage across startup, auth, tool calls, watch loop, and config writes.
  - watch loop emits explicit `[AUTH]` error lines on session/token/auth failures.
  - auth failure recovery: auto re-login and retry watch cycle after successful reauth.
  - normal auth logs stay concise (`✅` success / `❌` errors); login mode details are debug-only.
- Rental automation was intentionally removed from runtime code pending a confirmed renter-side MCP/API flow.

## Config Keys In Use

- `totalClaimed`
- `level20ResetEnabled`
- `missionModeEnabled`
- `missionResetLevel`
- `interactiveAuth`
- `debugMode`
- `watchLoopEnabled`
- `watchPollIntervalSeconds` (default 30)
- `targetMissions` (array of mission names or mission IDs for auto-assign)

## Planned (Next)

- Mission reset/restart signed-tx pipeline integration.
- Wallet signing mode options (key vault mode + dapp/extension mode).
- Full parity with legacy mission automation flows from `v2-missions.js`.
