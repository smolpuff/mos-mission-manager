# Current Onboarding and MCP Call Flow

Last verified against app version **3.2.14** on **2026-08-08**.

This document describes the onboarding that is implemented now, including the
desktop bootstrap, the two-step first-run wizard, the MCP calls made by each
step, and what happens when the mission runner starts.

## User onboarding

### Before opening the app

- Use a dedicated burner wallet. Do not use a primary wallet.
- The App Wallet option needs a small SOL balance for transactions and enough
  PBP for paid mission actions.
- If using App Wallet, preserve its recovery phrase. The wallet is
  self-custodial; losing its recovery information can permanently lose access.
- Configure the missions you actually want on the Pixel by Pixel Missions page
  before completing Step 2, or select the desired target mission for each slot
  in the wizard.

### Desktop launch

Launching Electron does **not** prefetch mission cards or NFT inventory.

The desktop bootstrap makes one identity/balance request:

```text
get_wallet_summary({})
```

The result supplies the current Pixel by Pixel display name, wallet ID, and
wallet balances. Electron deliberately removes any mission and NFT result from
the startup snapshot. If a funding-wallet address is configured, Electron may
also read that address through the Solana RPC; that is not an MCP call.

The first-run wizard opens when `firstRunOnboardingCompleted !== true`.

### Step 1: Select the funding/signing type

The available choices are:

| UI choice | Stored `signerMode` | Behavior |
| --- | --- | --- |
| App Wallet | `app_wallet` | A dedicated in-app burner wallet signs automated actions. |
| Browse Wallet | `dapp` | Prepared transactions open in the browser and require wallet approval. |
| Manual | `manual` | Actions that require signing direct the user to the web page for manual completion. |

Selecting **App Wallet** checks the already-known signer/funding-wallet state.
If necessary, it refreshes the configured funding address through Solana RPC.
That refresh is not an MCP wallet call.

If no App Wallet exists, the app:

1. Starts a temporary backend in paused/non-runner mode if the backend is
   stopped. This loads the local signer service but cannot start the mission
   watcher.
2. Generates a new 12-word mnemonic locally.
3. Derives the wallet using the application's configured Solana derivation
   path.
4. Stores the secret in the encrypted signer vault, with its vault key in the
   operating system's secure storage.
5. Saves `signerMode: "app_wallet"` and displays the wallet address.
6. Stops the temporary backend after wallet creation. The user must still press
   the normal Start button to run missions.

Wallet creation itself makes no MCP request. Recovery information can be
revealed later from Settings. Back it up before funding the wallet.

Pressing **Continue** requires a selected mode. App Wallet must exist before
the wizard advances.

### Step 2: Synchronize and select target missions

Entering Step 2 invokes `onboarding:fetch-account`. It requests a consolidated
account snapshot and the mission catalog. On a cold, uncached sync, the calls
are sequential:

```text
get_wallet_summary({})
get_user_missions({})
get_mission_nfts({})
get_mission_catalog({})
```

The resulting UI data is:

- account identity and balances from `get_wallet_summary`;
- the four assigned mission rows, levels, activity, NFT assignment, rewards,
  and slot numbers from `get_user_missions`;
- mission names, IDs, descriptions, rewards, and collection requirements from
  `get_mission_catalog`;
- owned collection names used to decorate compatible mission choices from
  `get_mission_nfts`.

If any initial call reports an authentication failure, onboarding opens the MCP
browser login, waits for completion, and retries the account sync.

The four cards are seeded from the missions currently assigned to the account.
Clicking a card changes the **target mission selection** for that slot in the
wizard. It does not immediately swap the live mission on the server.

Step 2 cannot be applied while account data is loading or after a failed or
empty mission-state response. **Apply** becomes available only after real
mission rows have returned and seeded the slot selections. Use **Refresh
mission status** if the sync failed; onboarding cannot save a partial or empty
target list in the meantime.

Each card also has the same small **On/Off** automation toggle used by the live
mission cards. Turning a slot off keeps its selected target in configuration
but prevents claim, reset, restore, and assignment automation for that slot.
The four choices are saved when **Apply** is pressed.

The same target mission cannot be selected for two slots in the picker. Owned
collection highlighting is informational; it does not guarantee that an NFT is
currently available or off cooldown.

#### Refresh mission status

The **Refresh mission status** button invokes the same
`onboarding:fetch-account` handler.

Current implementation detail: the handler reuses the Electron account
snapshot and mission-catalog caches when present. Therefore the button does not
guarantee a new MCP request unless those caches were invalidated by another
operation. This is the exact current behavior, despite the button label.

### Apply

Pressing **Apply** persists:

```json
{
  "signerMode": "app_wallet | dapp | manual",
  "targetMissions": ["one mission name per selected slot"],
  "missionActionEnabledBySlot": {
    "1": true,
    "2": true,
    "3": true,
    "4": true
  },
  "firstRunOnboardingCompleted": true
}
```

Apply makes **no MCP call** and does not swap missions. It writes the desktop
configuration through `config:update` and `onboarding:apply-selection`. If the
runner was already active, it restarts the backend so the new signer mode and
target list are loaded.

After mission state is ready, the target list is chosen in this order:

1. selected slot values, when assigned missions were successfully pulled;
2. the pulled assigned mission names;
3. selected/fallback mission names already seeded from that completed sync.

Closing the wizard with its **X** marks onboarding complete. Pressing Escape
only closes the current modal; it does not write the completion flag.

## What happens when the runner starts

This is adjacent to onboarding but intentionally separate from Electron's
wallet-only bootstrap.

1. The backend loads configuration and signer state.
2. It reuses the wallet-only startup snapshot for authentication and identity,
   avoiding a duplicate startup `get_wallet_summary` when that snapshot is
   available.
3. Because the Electron snapshot contains no mission rows, the watcher performs
   one initial `get_user_missions({})` using reason
   `startup_missing_snapshot_refresh`.
4. That result populates the live mission cards and becomes the state used by
   the normal watcher workflow. It also reconciles the configured target names
   from every assigned MCP slot before assignment begins; the saved per-slot
   On/Off values still decide which slots are automated.
5. The watcher calls `watch_and_claim` with:

   ```json
   {
     "watchSeconds": 5,
     "pollIntervalSeconds": 60,
     "maxClaims": 4
   }
   ```

   Watch duration and poll interval can be configured, but the server-facing
   poll interval is clamped to at least 60 seconds. `maxClaims` is fixed at
   four.
6. Mission and assignment mutations consume updated mission rows returned by
   their mutation responses. The app should not make a confirmation
   `get_user_missions` merely to confirm a successful mutation.

If the initial mission read is rate-limited, the watcher remains running and
schedules a retry for the reported cooldown instead of performing repeated
startup reads.

Before the runner starts, mission cards show **MISSION STATUS NOT SYNCED**
because mission prefetch was intentionally removed. While the runner is active
and waiting for its first authoritative result they show **SYNCING MISSION
DATA...**. Once that result arrives, normal live card rendering takes over.

## Exact call ownership

| Call | Owner and trigger | Input in onboarding/startup | Cache or client limit |
| --- | --- | --- | --- |
| `get_wallet_summary` | Electron launch; onboarding only if the cached launch result is unavailable; backend initial checks only if no wallet snapshot is supplied | `{}` | Client minimum interval: 60 seconds |
| `get_user_missions` | Step 2 account snapshot; watcher initial mission hydration; normal mission polling | `{}` | Client cache/minimum interval: 60 seconds; in-flight reads are coalesced |
| `get_mission_nfts` | Step 2 ownership decoration and the runner's inventory/assignment workflows | `{}` during onboarding | Client window: 10 calls per 60 seconds; responses are `no-store` |
| `get_mission_catalog` | Step 2 catalog; mission picker when catalog is missing | `{}` | Cached in Electron for the process lifetime until invalidated/restarted |
| `watch_and_claim` | Active watcher cycle, not the onboarding wizard | `watchSeconds`, `pollIntervalSeconds`, `maxClaims` | Client window: 1 call per 60 seconds |
| `prepare_mission_swap` | Live mission-card change outside onboarding, when a slot already has a mission | `assignedMissionId`, `chosenMissionId`, signing fields | Mutation workflow |
| `submit_signed_mission_swap` | App Wallet completion of a prepared mission swap | Prepared/signed transaction fields | Returned mission rows are authoritative |
| `assign_nft_to_mission` | Runner assignment after reset/restore policy permits it | Mission ID, NFT account/source, signing fields | Client window: 10 calls per 60 seconds |
| `claim_mission_reward` | Direct claim fallback/manual claim workflow | Assigned mission ID and signing fields | Client window: 10 calls per 60 seconds |

## Calls that onboarding does not make

- No `get_user_missions` or `get_mission_nfts` is made by the Electron launch
  bootstrap.
- App Wallet generation does not call MCP.
- Selecting target mission cards in Step 2 does not call MCP.
- Apply does not call a mission swap, assignment, wallet read, or mission read.
- The funding-wallet display refresh uses Solana RPC and does not call an MCP
  wallet tool.
- The standalone mission picker reuses known mission state and cached NFT
  collection information; opening it does not fetch NFT inventory.
- A successful mutation response is used directly; the app does not add a
  confirmation wallet or mission call solely to verify it.

## Cache and rate-limit behavior

- `get_wallet_summary` and `get_user_missions` each have a 60-second client
  minimum interval.
- `get_user_missions` also has a 60-second client snapshot cache and coalesces
  compatible in-flight requests.
- `watch_and_claim` is limited to one call in a 60-second window.
- `get_mission_nfts`, `claim_mission_reward`, and
  `assign_nft_to_mission` are each limited to ten calls in a 60-second window.
- Electron coalesces an onboarding account sync already in progress.
- Electron retains the consolidated onboarding snapshot without a time-based
  expiry. A mission-picker change and a completed NFT cooldown reset explicitly
  invalidate that snapshot.
- Electron retains the mission catalog for the process lifetime unless its
  cache is explicitly invalidated or the app restarts.

These limits mean repeatedly reopening or refreshing onboarding should reuse
cached data rather than create parallel requests. They also mean a button named
Refresh may display cached data under the current implementation.

## Failure behavior

- Authentication failure: browser login opens, then the sync retries.
- Step 2 renderer timeout: the UI reports an error after 45 seconds.
- Account or catalog failure: the wizard remains on Step 2 and displays the
  returned error.
- App Wallet creation failure: the wizard stays on Step 1 and displays the
  signer error.
- Apply failure: the wizard stays open and does not silently report success.
- Initial watcher mission-read throttle: mission hydration is deferred to the
  cooldown boundary while the watcher stays active.

### Which missing data is retried

| Missing data | Retry behavior |
| --- | --- |
| Desktop identity/wallet bootstrap | There is no tight automatic retry loop. A failed result is not stored as a successful snapshot. The next owner—normally Step 2 onboarding or backend startup—requests `get_wallet_summary` again when its 60-second tool cooldown permits. |
| Step 2 account snapshot | The consolidated snapshot is committed only after its required reads complete. If the sync fails, pressing **Refresh mission status** or entering Step 2 again retries the missing account data. An authentication failure performs browser login and retries automatically in the same action. |
| Mission catalog | A failed catalog request is not cached. The next Step 2 or mission-picker catalog request tries it again. |
| Runner mission cards | The first failed `get_user_missions` schedules `startup_background_mission_refresh` for the reported retry time, or about 60 seconds when no retry time is supplied. If that background attempt fails, it schedules itself again while the runner remains active. A successful result fills the cards. |
| Available NFT count | The count waits until authoritative mission state exists. A rate-limited inventory result is rescheduled for its retry boundary. Other transient failures are attempted again when the next watcher cycle schedules the inventory refresh. |
| Funding-wallet SOL/PBP display | This uses Solana RPC rather than MCP. A failed refresh keeps the last known good value and is tried again by the next explicit or action-triggered funding refresh. |

Retries reuse the existing call owners. They do not add a separate
`get_user_missions`, wallet, or inventory confirmation call.

## Source map

- Wizard state, steps, selections, and Apply:
  [`renderer/src/pages/ControlPage.jsx`](renderer/src/pages/ControlPage.jsx)
- Renderer-to-Electron onboarding bridge:
  [`electron/preload.js`](electron/preload.js)
- Desktop wallet bootstrap, account snapshot, catalog cache, onboarding IPC,
  and configuration Apply:
  [`electron/main.js`](electron/main.js)
- Backend startup and GUI request handlers: [`app.js`](app.js)
- Signer modes and generated App Wallet storage: [`src/signer.js`](src/signer.js)
- MCP cache and call-window enforcement:
  [`src/mcp/client.js`](src/mcp/client.js)
- Mission picker/swap and assignment workflow:
  [`src/services/checks.js`](src/services/checks.js)
- Watcher startup and `watch_and_claim` lifecycle:
  [`src/services/watch.js`](src/services/watch.js)

## Verification checklist for future call changes

When an MCP contract changes, update this document only after verifying all of
the following:

- the live tool name and input schema;
- the response path used by the normalizer;
- which layer owns the call (renderer, Electron, or backend);
- whether Electron and backend caches can both serve it;
- the per-tool client cooldown/window;
- whether a mutation response already contains the updated mission or wallet
  state;
- whether Apply changes local targets or performs a live server mutation;
- whether authentication retry can repeat the original call sequence;
- whether startup, onboarding, and watcher start accidentally request the same
  tool inside one cooldown window.
