# (NOT PROJECT RELATED) MAKE NEW DEPHLECT WEBSITE.

## Coding Standards (project-wide)

- Keep code concise, explicit, and consistent across files.
- Prefer small focused helpers and shared utilities over repeated logic.
- Use early returns and flat control flow where possible.
- Keep logging format and command handling style uniform.
- Avoid introducing multiple patterns for the same operation.
- Only introduce new frameworks/patterns when required and documented in this TODO.

## Recently Completed

- [x] Mission level reset detection now checks immediately during runtime (startup/manual/poll), not only at cycle end.
- [x] Fixed delay where reset popup could wait until after claim cycle completion.
- [x] Normal auth logging reduced to concise success/error lines; mode/detail lines moved to debug logs.

## TODO 04/5/26

- [x] If token refresh fails; retry 3 times, then login again with popup
- [ ] See if get_wallet_summary will work better for knowing when claimed and not?
- [-] Mission level detection for reset triggering
  - [x] Fix delay waiting until end of cycle to popup
- [ ] Full Mission level reset flow (reset to level 1, sign, confirm)
  - [ ] A
  - [ ] B

## TODO POST SINGING

- [ ] Mission Swap (prepare_mission_swap, sign, confirm)
- [ ] NFT cooldown reset (prepare_nft_cooldown_reset,sign, confirm)

## TOP PRIORITY: Dual Signing Modes (must support BOTH, but only required for signed tx actions)

- [ ] Sequence enforcement:
  - [ ] Phase 1 must ship watch/claim/status/assign/reset flows first (no signer required).
  - [ ] Signing mode requirements apply when implementing reset/reroll/swap/unlock/checkout signed transactions.

### Solana SDK usage map

- [ ] Prefer `@solana/kit` as the primary transaction/signing abstraction for this project:
  - use it for tx decode/encode, signer abstraction, simulation, send/confirm, and RPC helpers
  - use it to avoid hand-rolling base64 transaction parsing, blockhash handling, signature extraction, and confirmation polling
- [ ] Keep `@solana/web3.js` only as a compatibility fallback:
  - use it only if wallet adapter examples or MCP payload formats are easier to bridge with `VersionedTransaction` / `TransactionMessage`
  - do not build two parallel transaction stacks unless blocked by library gaps
- [ ] Do not manually implement low-level Solana message serialization, signature slot wiring, recent blockhash refresh, or confirmation loops unless a library/API gap forces it.
- [ ] Keep manual code for app-specific policy only:
  - tool allowlists
  - mission/NFT validation
  - spend/rate limits
  - vault lifecycle and redaction
  - callback/session anti-replay rules

- [ ] Implement two user-selectable signing modes:
  - [ ] `Mode A: Encrypted Local Key` (headless auto-sign; user can manually paste/import key once, then encrypted-at-rest)
  - [ ] `Mode B: Dapp Wallet Sign` (external browser wallet/extension approval flow)
- [ ] Add first-run setup wizard where user explicitly chooses signing mode.
- [ ] Add runtime toggle in settings so users can switch modes later.

### Mode A: Encrypted Local Key Storage (auto-sign)

- [ ] Use `@solana/kit` signer primitives for local signing if possible; avoid custom ed25519 signing glue.
- [ ] Only store/import the secret locally yourself; do not manually implement transaction signing bytes if the SDK can sign the prepared payload directly.

- [ ] Protect local signer vault at rest with OS-secured unlock by default:
  - [ ] Generate a random 256-bit vault key on signer import
  - [ ] Encrypt signer material with XChaCha20-Poly1305 (preferred) or AES-256-GCM
  - [ ] Use a random nonce/IV per encryption operation
  - [ ] Persist vault metadata: version, algorithm, nonce, createdAt
  - [ ] Store the vault key in OS secure storage where available:
    - [ ] macOS Keychain
    - [ ] Windows DPAPI / Credential Manager
    - [ ] Linux libsecret / Secret Service
- [ ] Store encrypted key blob only (never plaintext key in config, files, logs, crash dumps, or telemetry).
- [ ] Keep decrypted key material in memory only for active signing windows.
- [ ] Zeroize / clear signer material from memory on shutdown, logout, lock, or signer mode switch.
- [ ] Support optional passphrase-based vault unlock as an advanced mode:
  - [ ] Argon2id KDF from user passphrase (preferred; scrypt only as fallback if platform/library constraints require it)
  - [ ] Random salt per vault
  - [ ] Persist KDF metadata when passphrase mode is used
- [ ] If OS secure storage is unavailable:
  - [ ] require explicit reduced-security confirmation or passphrase mode
  - [ ] surface clear warning in setup/UI/logs
- [ ] Add explicit risk warning + user confirmation before enabling local-key mode. IMPORTANT
- [ ] Restrict local-key mode to dedicated burner wallets; warn against importing primary wallets.
- [ ] Add vault lock/unlock state in UI/logs without ever exposing secret material.
- [ ] Ensure signing mode never prints secret bytes, vault keys, derived keys, decrypted payloads, or full seed/private key strings in debug output.
- [ ] Add signer replacement / re-import flow so user can import a new signer and replace the old local vault cleanly.
- [ ] Add failure handling:
  - [ ] OS secure storage read/write failures surface clear recovery guidance
  - [ ] passphrase mode failures do not leak whether key material is valid beyond generic auth failure
  - [ ] repeated unlock failures trigger backoff
  - [ ] corrupted vault surfaces clear recovery guidance
- [ ] Document threat model clearly:
  - [ ] protects keys at rest
  - [ ] does not protect against full runtime compromise of unlocked machine/app/user session

### Mode B: Dapp Wallet Sign Flow (no key import)

- [ ] Support signing via external browser wallet flow (Phantom/Solflare-compatible path).
- [ ] Explicitly support non-embedded flow: open system browser for extension-based signing.
- [ ] Treat browser-wallet signing as interactive per-action approval unless wallet-specific auto-approve/auto-confirm is enabled by user.
- [ ] Use wallet-standard / adapter-compatible request flow plus `@solana/kit` or `web3.js` transaction objects for browser-wallet interoperability; do not hand-build wallet payloads if avoidable.
- [ ] For each signed action:
  - [ ] call `prepare_*`
  - [ ] validate returned payload/tool/action matches expected allowlist before presenting for signature
  - [ ] decode prepared tx with `@solana/kit` first; fall back to `web3.js VersionedTransaction.deserialize(...)` only if needed
  - [ ] send SDK transaction object to wallet for signature
  - [ ] receive signed payload back in app
  - [ ] re-serialize with the SDK and call matching `submit_signed_*`
  - [ ] verify submit result and log action outcome
- [ ] Implement callback bridge (localhost callback URL or equivalent) to return signed payload to app.
- [ ] Bind callback requests to a short-lived session token/state value to prevent spoofed callback submissions.
- [ ] Add timeout / cancellation handling for abandoned browser signing flows.
- [ ] Add replay protection:
  - [ ] reject duplicate callback submissions
  - [ ] invalidate one-time signing session after success/failure/timeout
- [ ] Validate signed payload shape before submit:
  - [ ] expected wallet/account
  - [ ] expected action/tool mapping
  - [ ] expected nft/mission identifiers when applicable
- [ ] Surface clear UX/logging for browser-wallet flow states:
  - [ ] opening browser
  - [ ] awaiting wallet approval
  - [ ] signature received
  - [ ] submit success/failure
  - [ ] user rejected / expired / callback failed
- [ ] Do not rely on embedded extension support as primary path; use system browser as default.
- [ ] Document wallet behavior differences clearly:
  - [ ] auto-approve / auto-confirm depends on wallet capabilities and user settings
  - [ ] some wallets will require approval for every signed action
  - [ ] Solflare-compatible auto-approve behavior should be treated as wallet-specific, not guaranteed
- [ ] Add local dev support notes for localhost origins and extension-based signing.
- [ ] Ensure no signed payloads, tokens, or callback secrets are written to logs in full.

### Shared Signing Safety Controls (both modes)

### Shared Signing Safety Controls (both modes)

- [ ] Per-action allowlist (only expected tools/actions may prepare, sign, submit, or confirm).
- [ ] Validate prepare/sign/submit mapping strictly:
  - [ ] only approved `prepare_*` may feed matching `submit_signed_*`
  - [ ] reject mismatched tool/action pairs
  - [ ] reject unexpected payload shapes or missing required identifiers
- [ ] Validate signed action context before submit:
  - [ ] expected wallet/account
  - [ ] expected mission/nft/cooldown identifiers when applicable
  - [ ] expected cost/spend bounds when applicable
- [ ] Max spend/usage guardrails per period.
- [ ] Add per-action rate limits / cooldowns to prevent rapid accidental repeats.
- [ ] Kill switch / pause automation.
- [ ] Add replay protection:
  - [ ] reject duplicate submissions for same prepared action/session
  - [ ] expire one-time signing sessions/tokens after success, failure, or timeout
- [ ] Full audit log for every `prepare/sign/submit` cycle.
- [ ] Redact sensitive material from logs:
  - [ ] never log plaintext keys, seed phrases, private keys, vault keys, full signed payloads, callback secrets, or full auth tokens
  - [ ] truncate tx blobs, signatures, and tokens in logs/debug output
- [ ] Clear UX prompts describing what is being signed and why.
- [ ] Surface explicit rejection/error states:
  - [ ] user rejected signature
  - [ ] wallet unavailable
  - [ ] callback/session expired
  - [ ] submit failed / chain rejected
- [ ] Require explicit confirmation before enabling unattended local-key automation mode.
- [ ] Add safe startup behavior:
  - [ ] signer mode status shown clearly
  - [ ] automation remains paused if signer is unavailable, locked, or misconfigured
- [ ] Use SDK simulation / message inspection before submit when possible; do not trust opaque prepared payloads blindly.

## Auth & Token Lifecycle (required)

- [x] Implement centralized token manager for MCP auth state.
- [x] Persist token metadata (`access_token`, `refresh_token`, `expires_at`, refresh-related fields when provided).
- [x] Proactively refresh before expiry (for example at ~80-90% of token lifetime).
- [x] On MCP auth failures (`401`, `invalid_grant`, refresh revoked/expired):
  - [x] trigger reauth flow (interactive browser OAuth fallback)
  - [] pause watch/automation loops immediately
  - [x] mark app state as `Reauth Needed`
  - [x] silent refresh path before browser fallback
- [ ] After successful reauth:
  - [ ] update stored token record atomically
  - [x] resume/retry watch loop safely after successful reauth
- [ ] If reauth fails:
  - [ ] keep automation paused
  - [ ] surface clear user action message in UI/logs
- [ ] Add visible auth status in UI:
  - [ ] `Connected`
  - [ ] `Reauth in progress`
  - [ ] `Reauth needed`
- [ ] Add retry/backoff policy for transient auth/network errors.
- [ ] Add integration tests for token expiry + recovery path.

## MCP Tool Mapping (replace browser tasks)

- [ ] Solana SDK boundary:
  - no SDK needed for `get_user_missions`, `watch_and_claim`, `claim_mission_reward`, `get_mission_nfts`, `assign_nft_to_mission`, `mcp_health`, `who_am_i`
  - SDK recommended for every `prepare_*` -> sign -> `submit_signed_*` path
  - keep mission selection/accounting rules manual in app code; keep chain/tx mechanics in SDK code

- Fetch missions:
  - `get_user_missions`
- Claim:
  - `watch_and_claim` (bounded watcher) and/or `claim_mission_reward`
- Assign NFT:
  - `get_mission_nfts` + `assign_nft_to_mission`
- Reset cooldown:
  - `prepare_nft_cooldown_reset` + `submit_signed_nft_cooldown_reset`
- Mission reset/reroll/swap (signed tx flows):
  - `prepare_mission_reroll` + `submit_signed_mission_reroll`
  - `prepare_mission_swap` + `submit_signed_mission_swap`
- Slot unlock (if needed):
  - `unlock_mission_slot` + `submit_signed_mission_slot_unlock`
- Health/auth:
  - `mcp_health`, `who_am_i`

## Implementation Plan

## 1) Project structure cleanup

- [x] Create `src/` modules (no giant single file):
  - [x] `src/config.js`
  - [x] `src/mcp/client.js`
  - [x] `src/services/missions.js`
  - [x] `src/services/claim.js`
  - [x] `src/services/reset.js`
  - [x] `src/services/watch.js`
  - [x] `src/ui/terminal.js`
  - [x] `src/commands.js`
  - [x] `src/index.js`
- [x] Keep `config.json` schema backward compatible.

## 2) MCP client foundation

- [ ] Implement typed wrapper for all used tools with retries/backoff.
- [x] Centralize auth/token handling.
- [ ] Centralize error normalization (surface concise reason in UI logs).
- [ ] Add one shared Solana transaction helper module:
  - decode prepared tx payload
  - inspect fee payer / recent blockhash / required signers when available
  - sign via local signer or wallet bridge
  - serialize for matching `submit_signed_*`
  - confirm/fetch status via SDK helper when MCP submit response is thin

## 3) Mission model normalization

- [x] Build one adapter that maps `get_user_missions` payload to internal mission model:
  - `name`, `slot`, `assignedMissionId`, `level`, `completed`, `alreadyStarted`, `claimable`, progress fields.
- [ ] Build one adapter for `get_mission_nfts` payload:
  - `nftAccount`, `onCooldown`, `cooldownEndsAt`, collection/name/symbol.

## 3.5) Local Session Accounting (no wallet-summary dependency)

- [x] Track claim/currency/session history locally in app state + config JSON.
- [x] Do not depend on `get_wallet_summary` for claimed totals/session history.
- [ ] Persist:
  - [x] session claim count
  - [ ] session claimed currency total
  - [ ] per-claim event history (`timestamp`, mission id/name, token, amount, source)
- [x] Keep existing `totalClaimed` behavior as lifetime local counter.

## 4) Replace mission claim flow

- [ ] Implement `claimAllClaimable()` using MCP mission data + `claim_mission_reward`.
- [x] Preferred path: implement bounded `watch_and_claim` command loop as primary runtime flow:
  - configurable `watchSeconds`, `pollIntervalSeconds`, `maxClaims`.
- [ ] Keep direct `claim_mission_reward` path as fallback/recovery only.
- [x] Keep direct `claim_mission_reward` fallback path for recovery when watch returns zero claims but claimable missions exist.
- [x] Keep claimed counters and `totalClaimed` persistence behavior.
- [x] Confirm this phase has zero dependency on local key storage or dapp signing.

## 5) Replace mission start flow

- [ ] Implement `assignForMission(slot/mission)`:
  - fetch valid NFTs via `get_mission_nfts`
  - choose NFT by parity rules
  - skip cooldown NFTs
  - call `assign_nft_to_mission`
- [x] Preserve target-mission filtering from `targetMissions`.

## 6) Replace reset flow

- [ ] Implement mode checks (`20r`, `mm`, `mm <level>`), mutual exclusion preserved.
- [ ] Implement reset operation(s) using MCP equivalents decided above.
- [ ] Add manual command `reset20`.
- [ ] Gate this phase behind signing mode support (Mode A or Mode B), since reset-related MCP actions are signed-tx flows.
- [ ] Use SDK helpers for the signed reset path:
  - deserialize `prepare_mission_reroll` / `prepare_mission_swap` / `prepare_nft_cooldown_reset` payloads
  - sign and reserialize
  - confirm submitted transaction / signature status without custom polling logic
- [ ] Enforce `no-reset-while-active` rule in all reset paths (manual + automatic).
- [ ] Add pre-reset state check:
  - [ ] if mission is active/in-progress: skip reset and mark as deferred
  - [ ] reset only after mission transitions to completed and claim succeeds
- [ ] Add tests for this exact sequence to prevent NFT-wasting regressions.

## 7) Watch loop parity

- [x] Recreate loop semantics:
  - watch tick interval (`watchIntervalSeconds`) driven primarily by `watch_and_claim`
  - periodic refresh/check tick (`pageRefreshMinutes`) mapped to mission refresh call
- [x] Ensure no overlapping runs (`isRunning` lock behavior parity).
- [x] Define canonical cycle:
  - [x] run `watch_and_claim` (bounded)
  - [x] read fresh mission status
  - [ ] if mission is active/in-progress above reset threshold: defer reset
  - [ ] if mission is completed and claim succeeded: perform reset (signed flow) when threshold rule matches
  - [ ] assign/start next mission as needed
  - [x] sleep and repeat

## 8) Command handler parity

- [ ] Recreate readline command parser and help text.
- [ ] Support existing aliases and behavior:
  - `c`, `r`, `20r on/off`, `mm on/off`, `mm <level>`, `reset20`, `q`, `clear`, `help`.
- [ ] Remove obsolete browser-only commands (`connect`, `launch`, `sf`) or keep as no-op compatibility.

## 9) UI parity (look and feel)

- [x] Keep locked header box style.
- [x] Keep timestamped log buffer with redraw behavior.
- [x] Keep same stat fields and mode badges.

## 10) Cleanup and hardening

- [x] Remove dead browser code and selectors.
- [x] Add structured debug logging toggled by `--debug`.
- [ ] Add rate-limit friendly backoff and jitter.
- [x] Add graceful shutdown and state-safe persistence.

## Acceptance Criteria

- [ ] Running app requires no Chrome/Puppeteer.
- [ ] Mission claim/start/reset workflows run via MCP tools only.
- [x] Mode toggles and config persistence behave identically.
- [ ] Runtime stable for multi-hour loop without memory/log corruption.

## Open Questions (blockers)

- [ ] Final mapping policy between old UI reset behavior and signed MCP flows (when to use reroll vs swap vs cooldown reset).
- [ ] Signature handling path for `prepare_*`/`submit_signed_*` tools in unattended mode.
- [ ] Exact parity for special NFT priority (`TKM`, `100k`, `500k`) from MCP metadata.
- [ ] Confirm whether MCP `prepare_*` returns base64-encoded serialized `VersionedTransaction`, unsigned message bytes, or another envelope; this determines whether `@solana/kit` alone is enough or if `web3.js` fallback is needed.

## Optional Ideas

- [ ] Add pretty Electron frontend UI wrapper w/ tailwind
- [ ] Add generic giveaway/product-fulfillment flow (if feasible) for rewards distribution.

## Exhaustive Function Parity Checklist (every function in `v2-missions.js`)

Legend:

- `KEEP`: same logic/UX in new app.
- `REPLACE`: browser/DOM action replaced by MCP call(s).
- `REMOVE/NO-OP`: browser-only behavior not needed in MCP app, or kept only as compatibility alias.

- [x] `clearLogBuffer` (`KEEP`) log buffer reset + redraw.
- [x] `getDisplayWidth` (`KEEP`) emoji-safe header width.
- [x] `printHeaderArea` (`KEEP`) exact header look and mode badges.
- [x] `getLogAreaLines` (`KEEP`) dynamic terminal sizing.
- [x] `redrawHeaderAndLog` (`KEEP`) locked header + log viewport redraw.
- [ ] `launchChromeWithRemoteDebugging` (`REMOVE/NO-OP`) browser launcher; replace command path with MCP auth check/help.
- [ ] `initializeBrowser` (`REPLACE`) becomes MCP/session bootstrap (`who_am_i`/`mcp_health` readiness).
- [ ] `ensurePage` (`REPLACE`) becomes MCP connectivity/auth guard.
- [x] `getAllMissions` (`REPLACE`) use `get_user_missions` + normalization adapter.
- [ ] `clickMission` (`REPLACE`) no DOM click; mission targeting by `assignedMissionId`/slot in normalized data.
- [ ] `claimReward` (`REPLACE`) use `claim_mission_reward` (or `watch_and_claim` path).
- [ ] `filterClaimableMissions` (`KEEP`) operate on normalized mission objects.
- [ ] `filterAvailableMissions` (`KEEP`) preserve target + reset exclusions.
- [ ] `filterMissionsToReset` (`KEEP`) preserve threshold logic.
- [ ] `getAvailableNftCount` (`REPLACE`) use `get_mission_nfts` count.
- [ ] `getAvailableNftCountWithRetry` (`KEEP`) retry/backoff policy around MCP reads.
- [ ] `waitForNftResultsToLoad` (`REPLACE`) no UI wait; becomes stabilized MCP polling helper.
- [ ] `performMissionReset` (`REPLACE`) map to MCP reset equivalent (reroll/swap/cooldown reset flow).
- [ ] `autoResetAndStartMissions` (`KEEP+REPLACE`) orchestration stays, internals use MCP.
- [ ] `attemptSelectAndStartMissionFromCurrentCollection` (`REPLACE`) selection from MCP NFT list + `assign_nft_to_mission`.
- [ ] `selectNFTAndStartMission` (`KEEP+REPLACE`) preserve policy/mode gating; remove DOM and collection picker code.
- [ ] `setCollectionFilterOption` (`REPLACE`) map to MCP-side filtering strategy (`get_mission_nfts` args/local filters).
- [ ] `handleSolflarePopup` (`REPLACE/REMOVE`) replace with MCP signed-flow abstraction; no extension popup handling.
- [ ] `startMissions` (`KEEP+REPLACE`) exact sequencing (claim -> reset -> start) with MCP calls.
- [x] `startWatching` (`KEEP+REPLACE`) same watch loop semantics, MCP polling/claim.
- [ ] `checkAndStartMissions` (`KEEP+REPLACE`) same stat delta detection and trigger behavior.
- [x] `logWithTimestamp` (`KEEP`) same logging behavior + debug filtering.
- [ ] `waitForMissionReset` (`REPLACE`) confirm by mission data state, not DOM/button disabled state.
- [ ] `waitForMissionToLoad` (`REMOVE/NO-OP`) no mission detail page load in MCP mode.
- [x] `setupCommandHandler` (`KEEP`) preserve command parser and aliases.
- [ ] `testNFTDetection` (`REPLACE`) debug command reads MCP NFT counts.
- [ ] `testFindSpecialNFTs` (`REPLACE`) debug command reads MCP NFTs and prints special matches.
- [ ] `testTemporaryCollectionSwitch` (`REPLACE/REMOVE`) depends on UI picker; replace with MCP filter simulation test.
- [ ] `debugPrintMissionLevels` (`REPLACE`) print normalized mission levels from MCP missions.
- [ ] `mockPrintNFTSelections` (`REPLACE`) compute would-select from MCP NFT data.
- [ ] `resetAllLevel20Missions` (`KEEP+REPLACE`) same command behavior via MCP reset equivalents.
- [ ] `resetAllLevel11Missions` (`REPLACE`) fold into unified `mm <level>` reset handler (no standalone `reset11` command).
- [ ] `connectToExistingChrome` (`REMOVE/NO-OP`) replace with MCP connect/auth status check.
- [ ] `refreshMissionsPage` (`REPLACE`) becomes forced mission refresh call sequence.
- [ ] `startup` (`KEEP+REPLACE`) same startup ordering with MCP bootstrap.

## Exhaustive Non-Function Behavior Checklist

- [x] Keep startup side effects:
  - load config
  - init runtime state
  - start command handler
  - start watch loop
  - print initial mock selections (or equivalent dry-run summary)
- [x] Keep signal handling:
  - SIGINT confirmation flow
  - graceful cleanup/shutdown
  - SIGTERM cleanup
- [x] Keep counters/state:
  - `claimed` (session)
  - `totalClaimed` (persisted in config)
  - mode flags and reset level persistence
- [ ] Keep mutual exclusion:
  - enabling `20r` disables `mm`
  - enabling `mm` disables `20r`

## Exhaustive Command Parity Checklist

- [ ] `clear`
- [ ] `h` / `help`
- [ ] `connect` (compat alias; now MCP auth/status)
- [ ] `launch` (compat alias; no-op/help in MCP mode)
- [ ] `c` (run automation cycle)
- [ ] `t` / `test`
- [ ] `tcoll` / `testcoll`
- [ ] `l`
- [ ] `sf` (compat alias or signed-flow test hook)
- [ ] `r` / `refresh`
- [ ] `20r`, `20r on`, `20r off`
- [ ] `reset20`
- [ ] `mm`, `mm on`, `mm off`, `mm <level>`
- [ ] `q`

## Exhaustive Config Parity Checklist

- [ ] Preserve currently-used keys:
  - `targetMissions`
  - `watchIntervalSeconds`
  - `pageRefreshMinutes`
  - `totalClaimed`
  - `level20ResetEnabled`
  - `missionModeEnabled`
  - `missionResetLevel`
  - `solflareExtensionId` (only for backward compatibility/migration note)
- [ ] Preserve legacy/unused keys without breaking load:
  - `streamCheckIntervalMinutes`
  - `categoryFilter`
  - `watchModeQuitHours`
  - `profiles`
  - `level20reset`
  - `pid`

## Definition of Done (strict)

- [ ] Every function listed above is explicitly implemented/replaced/removed with compatibility note.
- [ ] Every command listed above works (or prints intentional compatibility message).
- [ ] Every config key listed above is parsed safely (used or ignored with migration note).
- [ ] No Puppeteer/Chrome/DOM/Solflare popup dependency remains in runtime path.
