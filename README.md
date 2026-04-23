```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

##

`missions-v3-mcp` is a CLI + desktop app for Pixel by Pixel mission automation over MCP. IT IS ENTIRELY STAND ALONE AND DOES NOT REQUIRE AN AGENT (bc thats gross)

## SUPER DUPER WONDER WARNING

ONLY USE A BURNER WALLET FOR FUNDING.

## Current state

Implemented flows:

- auth + startup checks
- watch + claim
- target-mission assignment
- mission reroll
- NFT cooldown reset
- rental fallback assignment
- desktop first-run onboarding
- desktop stats / rentals / NFT views

## Disclaimer

USE THIS AT YOUR OWN RISK.

THIS TOOL CAN BREAK, FAIL, MISFIRE, OR DO THE WRONG THING.
IT MAY MESS UP YOUR WORKFLOW, MISS ACTIONS, OR CREATE BAD STATE.

YOU ARE 100% RESPONSIBLE FOR EVERYTHING THAT HAPPENS WHEN YOU RUN IT.
THE AUTHOR IS NOT RESPONSIBLE FOR ANY LOSS, DAMAGE, OR ISSUES.

This software is provided as-is, with no warranty of any kind.

By using it, you accept that:

- you are fully responsible for your own setup, wallet usage, and outcomes
- things can break, fail, or behave unexpectedly
- commands can misfire, automation can be wrong, and workflows can change
- use may result in lost time, failed actions, bad state, or other unwanted effects

The author is not responsible for any damage, loss, or issues caused by use of this project.
This project was heavily vibe-coded and is still evolving.

## Requirements for working on

- Node.js 25 recommended
- access to the Pixel by Pixel MCP endpoint
- local `config.json` (create from `config.sample.json`)

## Desktop Usage FIRST USE

### 1) First-run wizard

On first open, the wizard walks you through:

- funding mode (`app_wallet`, `manual`, `dapp`)
- login + account/mission sync
- assigned mission review

Important:

- this onboarding flow does not start the runner
- it only does sign-in/session init plus read operations like account + mission fetch

If you choose `app_wallet`, the wizard can generate the burner wallet and show the funding address directly in the selection card.

Wizard only saves signer mode when you click **Done/Apply**.  
If you close the wizard, existing settings stay unchanged.

The wizard auto-opens based on this config flag:

```json
{
  "firstRunOnboardingCompleted": true
}
```

Set/delete this flag to retrigger wizard behavior.

### 2) Configure wallet mode in Settings (any time)

In **Settings > Wallet**, choose your signer flow:

- `app_wallet`: app-managed burner wallet for supported signing
- `manual`: browser/manual flow
- `dapp`: browser-wallet signing flow

If using `app_wallet`, use the UI to generate or import the wallet and confirm it is active. Use a dedicated burner wallet if you run `app_wallet` mode.
If signer vault/keychain state becomes corrupted or inaccessible, the current recovery path is to re-import your wallet.

## Configure Target Missions (Required for now)

For now, mission targeting is configured manually in `config.json`.
Edit `targetMissions` to add the mission names you want the bot to prioritize.

Example:

```json
{
  "targetMissions": ["Do it All!", "Race!"]
}
```

After editing `config.json`, restart the app if it is already running.

Note: mission swap in wizard is intentionally not wired yet. Mission choices should be set on the Pixel by Pixel site, then refreshed in-app.

## Running Missions

After wallet setup and mission config:

1. Open the app.
2. Go to the main missions pane.
3. Configure missions on PBP site (for now, feature coming soon)
4. Press **Start** to begin processing.
5. Use **Pause/Resume** in the UI as needed.

## Desktop Pages

The desktop app also includes:

- **My NFTs**: wallet NFT inventory, cooldown/level display, collection filters, and sorting
- **My Rentals**: rental pool totals plus active rental-backed mission view
- **Stats**: session earnings, claims, resets, leased totals, and mission claim breakdown

## Low Balance Warning

The app shows a warning dialog when funding balance drops below thresholds.

Default thresholds:

- PBP: `1000`
- SOL: `0.01`

You can customize in `config.json`:

```json
{
  "lowBalanceThresholds": {
    "pbp": 1000,
    "sol": 0.01
  }
}
```

Alert behavior is one-shot per threshold:

- it only triggers after balance was previously above threshold
- it triggers once when balance falls below
- it will not re-trigger until balance goes above threshold again

## Bridge Link Signing (dapp/manual)

Bridge URLs need a wallet-enabled browser context.

- Do **not** open in plain Chrome with no wallet provider.
- Use wallet browser options (Phantom/Solflare) or a browser with wallet extension connected.

The app provides bridge-link actions in dialog:

- open in wallet browser option
- open normally
- copy link

## Command Reference

General CLI COommands:

- `help`
- `clear`
- `status`
- `login`
- `check`
- `signer <action>`
- `c`
- `r`
- `reset20`
- `20r [on|off]`
- `mm [off|on|<level>]`
- `pause`
- `resume`
- `q`

## Notes

- Use a dedicated burner wallet if you run `app_wallet` mode.
- `dapp` mode uses the browser signing bridge returned by the prepare tool.

## License

MIT. See [LICENSE](./LICENSE).
