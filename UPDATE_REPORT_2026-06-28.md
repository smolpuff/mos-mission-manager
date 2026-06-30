# Update Report

Date: 2026-06-28

## What Changed

- Added the external IP to the `missions.lol` telemetry payload.
- Increased the NFT page cache TTL to 5 minutes.
- Removed the automatic NFT list fetch on page open and replaced it with an explicit `Load NFTs` button.
- Changed the mission assignment status so it only shows `Assigning...` after the assignment process actually starts.
- Added a new NFT assignment order setting:
  - `normal`
  - `highest_level_first`
- Wired the new assignment order through config, backend status, and the Settings UI.

## Payload Fields

The website/server should expect this additional field on the telemetry POST:

- `external_ip`

For `mission_claim` telemetry events, the payload now also includes:

- `level` and `currentLevel` - duplicate mission level aliases
- `reward_token` - normalized lowercase token key: `pbp`, `tc`, or `cc`
- `rewardToken` and `token` - direct token aliases
- `reward_token_code` - uppercase token code: `PBP`, `TC`, or `CC`
- `reward_token_name` - human-readable name: `Pixel By Pixel`, `Tournament Coin`, or `Community Coin`
- `reward`, `reward_amount`, and `prize_amount` - duplicate reward amount aliases
- `prize` - token alias for reward parsing on older consumers

Browser-wallet link resolution now also recognizes `nft_cooldown_reset` via `cooldownId` and `sign-nft-cooldown-reset`, instead of falling back to the mission play page.

## Notes

- I did not add fake payload encryption.
- HTTPS already encrypts the transport.
- If you want real hardening beyond transport encryption, the next step is a signed payload or HMAC with a server-known secret. That needs matching server-side support.

## Verification

- `node --check` passed for:
  - `app.js`
  - `src/config.js`
  - `src/context.js`
  - `src/services/checks.js`
  - `electron/main.js`
- `esbuild` passed for:
  - `renderer/src/pages/ControlPage.jsx`
  - `renderer/src/pages/SettingsPage.jsx`
  - `renderer/src/pages/NftsPage.jsx`
- Full `npm run build` could not complete because the repo’s build chain references a missing script file:
  - `scripts/build-sea.js`
