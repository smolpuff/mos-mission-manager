```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

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

- Node.js 25 recommended
- access to the Pixel by Pixel MCP endpoint
- local `config.json` (create from `config.sample.json`)

## Build from Source

### Install deps

```bash
npm install
```

### Desktop App

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

If you are debugging a packaged install, check those locations first.

## First Run Wizard

- Select your funding type you would like for automation
- BE SURE TO WRITE DOWN YOUR RECOVERY KEYS SOMEWHERE SAFE IF YOU USE APP-WALLET. YOU NEED TO KEEP THESE IN A SAFE PLACE INCASE YOU EVER NEED TO IMPORT THE WALLET
- next will pull your currently set up missions from the website as your targetMission. Confirm
- Select your mission mode; normal with level 20 resets on by default, or mission mode with level 11 reset and use rentals by default
- Press the start missionininining button to start automation
- If you chose app-wallet, fund it now to cover transations (0.1sol, whatever pbp)

- find the rest of your own secret sauce because you're not getting mine

## Features

- first-run onboarding wizard
- built-in app-wallet usign secureStorage methods
- wallet import/recovery via 12/24 keys
- missions watch + claim
- target-mission assignment
- low balance warning
- mission level reset
- mission assignment/change mission
- rentals support (lease side)
- NFT cooldown reset
- NFT inventory view with cooldowns, filtering, and sorting
- Mission competition live results from for those who are #notgrinding
- session stats

## Mission Targeting

First start, the wizard will automatically pull your selected missions from your account adn assign them. You can click on a mission card at anytime when a mission is assigned to change missions. You can also manually edit your config.json to target the mission

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
- `mm [off|on|<level>]`
- `pause`
- `resume`
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
- `dapp` mode uses the browser signing bridge returned by the prepare tool.

## License

MIT. See [LICENSE](./LICENSE).
