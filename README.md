```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](#requirements-for-source) [![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](package.json) [![Windows](https://img.shields.io/badge/Windows-x64-0078D6)](https://github.com/smolpuff/mos-mission-manager/releases/latest) [![macOS](https://img.shields.io/badge/macOS-Apple_Silicon_%7C_Intel-000000?logo=apple&logoColor=white)](https://github.com/smolpuff/mos-mission-manager/releases/latest) [![Linux](https://img.shields.io/badge/Linux-AppImage-FCC624?logo=linux&logoColor=black)](#desktop-app) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)

##

`missions-v3-mcp` is a an app for Pixel by Pixel mission automation over MCP. it is entirely stand-alone and does not require a gross agent to run.

## SUPER DUPER WONDER WARNING

ONLY USE A BURNER WALLET FOR FUNDING.

USE THIS AT YOUR OWN RISK. ONLY USE A BURNER WALLET. NEVER IMPORT YOUR MAIN WALLET KEYS.

This software is provided as-is, with no warranty of any kind.

By using it, you accept that:

- you are fully responsible for your own setup, wallet usage, and outcomes
- things can break, fail, or behave unexpectedly
- commands can misfire, automation can be wrong, and workflows can change
- use may result in lost time, failed actions, bad state, or other unwanted effects

The author is not responsible for any damage, loss, or issues caused by use of this project.
This project was heavily vibe-coded and is still evolving.

## Requirements for Source

- Node.js 24
- access to the Pixel by Pixel MCP endpoint
- local `config.json` (create from `config.sample.json`)

## Build from Source

### Install deps

```bash
npm install
```

### Desktop App

Development mode with Vite:

```bash
npm run desktop:dev
```

Electron app from local built files:

```bash
npm run desktop
```

Build the renderer only:

```bash
npm run desktop:build
```

## Config / Data Paths

In development, the desktop app reads and writes from the repo root.

- config: `./config.json`
- analytics/data: `./data/`

In packaged builds, Electron uses the platform user-data directory. Typical locations:

- macOS: `~/Library/Application Support/missions-v3-mcp/`
- Windows: `%APPDATA%\\missions-v3-mcp\\`

Important packaged files:

- `config.json`
- `data/stats-analytics.json`
- `data/missions-analytics.json`

If you are debugging a packaged install, check those locations first.

## Dashboard Analytics

The desktop app now reports session telemetry directly to the mission analytics
dashboard backend at `https://missions.lol/missions-analytics/public/track.php`.

Config keys:

- `missionsAnalyticsEnabled`
- `missionsAnalyticsUrl`
- `missionsAnalyticsToken`

The app sends:

- `app_open`
- `session_start`
- `heartbeat`
- `session_end`
- `feature_used` events for claims, resets, spend, rentals, and reset-backed assignments
- `crash` events for uncaught Electron main-process failures

The nickname is taken from the current user's MCP wallet summary display
name, and the wallet id is sent alongside it when available.

## First Run Wizard

1. Choose how resets are handled:
   - **Let the app do it — In-App Wallet:** generates a dedicated wallet inside the app to cover transaction costs without using your main wallet. You own it, with keys stored on your computer. Fund it with PBP and a little SOL for automatic signing.
   - **I’ll approve each reset — Browser Wallet:** opens a signing link for each transaction. Connect your browser wallet and approve it there.
   - **I’ll reset on PBP — Manual:** opens the PBP missions page so you can perform the reset yourself.
2. Wait for your PBP missions to sync, review them, then confirm setup. Confirmation stays disabled until target missions load; use **Retry sync** if loading fails or times out.

The In-App Wallet belongs to you. Its keys are stored on your computer; the developer does not hold them. Copy its address during setup or in Settings, and acknowledge that you need to send SOL and PBP to pay for resets. Back up its recovery phrase using **Settings → View Secret Keys**. Completing setup does not fund it.

After setup, a spotlight guide explains the real mission controls, Finish Target, and optional per-card reset overrides. Its mode previews do not save settings or start the runner. Finish or skip the guide, choose a mission mode, and press **Start**. The wallet choice controls signing; the mission mode controls reset behavior.

## Features

- onboarding wizard
- built-in app-wallet using secureStorage
- wallet import/recovery via 12/24 keys
- missions watch + claim
- target-mission assignment
- low balance warning
- mission level reset
- rentals support (lease)
- NFT cooldown reset
- NFT inventory view with cooldowns
- Mission competition live results from for those who are #notgrinding
- session stats

## Mission Targeting

First start, the wizard will automatically pull your selected missions from your account adn assign them. You can click on a mission card at anytime when a mission is assigned to change missions. Changing a mission in all via clicking on it and submitting will change your targetMission to the newly selected. This only works fopr app-wallet mode. You can also manually edit your config.json to target the mission

Example:

```json
{
  "targetMissions": ["Do it All!", "Race!"]
}
```

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

## Commands

General CLI commands:

- `help`
- `clear`
- `status`
- `login`
- `logout`
- `check`
- `c`
- `r`
- `reset20`
- `20r [on|off]`
- `q`
- `signer`

### Signer commands

Use `signer status` to view the current signer mode/state.

- `signer status`
  - show current signer mode/state summary
- `signer doctor`
  - run signer diagnostics / repair checks
- `signer setup`
  - rerun the CLI signer setup flow
- `signer app_wallet`
  - switch to app-managed wallet mode
- `signer manual`
  - switch to manual/browser mode
- `signer dapp`
  - switch to browser-wallet bridge signing mode
- `signer create`
  - create a new burner app wallet
  - confirms before replacing an existing imported app wallet
- `signer import`
  - open the interactive import prompt
  - accepts pasted private key, recovery phrase, keypair text, or key array
- `signer import [path-or-key]`
  - import directly from a file path or pasted key value
  - if the argument matches a real file path, file import is used
- `signer reveal`
  - reveal the app-wallet address / derivation path / recovery phrase in the terminal after confirmation
- `signer unlock`
  - unlock the app-wallet vault for signing
- `signer lock`
  - lock the app-wallet vault again
- `signer remove`
  - remove the imported app-wallet vault and stored vault key after confirmation

Signer notes:

- `app_wallet` mode is intended for a dedicated burner wallet only
- import/create flows switch signer mode to `app_wallet`
- if you switch to `app_wallet` and no wallet exists yet, the CLI will prompt you to create or import one

## Notes

- Use a dedicated burner wallet if you run `app_wallet` mode.
- `dapp` mode uses the browser signing bridge returned by the prepare tool. Currently funky and nto always working. lol...

## License

MIT. See [LICENSE](./LICENSE).
