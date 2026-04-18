```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

##

`missions-v3-mcp` is a Node.js CLI app for Pixel by Pixel mission automation over MCP.

Current implemented flows:
- auth + startup checks
- watch + claim
- target-mission assignment
- mission reroll
- NFT cooldown reset
- mission slot unlock
- three reset execution modes:
  - `app_wallet`
  - `manual`
  - `dapp`

## Requirements

- Node.js 25 recommended
- access to the Pixel by Pixel MCP endpoint
- a valid local `config.json`

## Install

```bash
npm install
```

Create `config.json` from `config.sample.json`.

## Desktop Skeleton

An Electron wrapper now sits beside the existing CLI app.

Available scripts:

```bash
npm run desktop:dev
npm run desktop
npm run desktop:build
```

Current desktop scope:
- 800x800 control window
- start/stop backend buttons
- separate CLI window
- raw command input bridged into the existing CLI backend

The desktop shell does not replace the current Node CLI. It starts the same app in a plain-output bridge mode so you can build the UI in React/Tailwind/daisyUI while keeping the existing automation logic intact.

### Desktop Release Builds

Desktop packaging uses Electron Builder and outputs release artifacts to `release/`.

Available commands:

```bash
npm run desktop:dist
npm run desktop:dist:mac
npm run desktop:dist:win
npm run desktop:dist:linux
```

Notes:
- packaged desktop builds store `config.json` in the app data directory instead of inside the app bundle
- macOS release builds can be produced on macOS
- Windows `.exe` output is configured, but the most reliable way to produce it is on Windows or in CI

## First Start

1. Start the app:

```bash
npm start
```

2. On first run, the app prompts you to choose a mode:
- `app_wallet`
- `manual`
- `dapp`

Pressing enter defaults to `app_wallet`.

If you want to rerun that setup later, use:

```text
signer setup
```

3. Pick the mode you want:
- `app_wallet`
  - default mode
  - setup defaults to creating a new burner funding wallet for the app
  - the app signs supported resets itself
- `manual`
  - the app opens the missions page and you reset or approve it yourself
- `dapp`
  - opens the prepare payload bridge signing URL in your browser wallet
  - you approve/sign in browser manually

## App Wallet Setup

Use a dedicated burner wallet only.

Fund it with a small amount of:
- SOL
- PBP

Do not use your main wallet.

If you choose `app_wallet` on first run and no wallet is set up yet, the app prompts you to either create a new burner wallet or import an existing one.
Pressing enter in that sub-step defaults to `create`.

If you create a new app wallet:
- the app generates a fresh Solana wallet for you
- it shows the wallet address and recovery phrase in the terminal
- it stores the signer encrypted in the vault and OS secure storage
- you can reveal the saved recovery phrase later with `signer reveal`

The header always shows the funding wallet:
- generated or imported app-wallet address in `app_wallet` mode
- SOL and PBP balances for that funding wallet when MCP wallet summary is available
- `MANUAL` in manual mode
- `DAPP` in dapp mode

Recovery phrase import uses the standard Solana derivation path by default (`m/44'/501'/0'/0'`).
The connected payout wallet from MCP is not used for this.

You can rerun that same guided setup any time with:

```text
signer setup
```

### Easiest Setup

Create a brand-new burner wallet in the app:

```text
signer create
signer unlock
signer status
```

Or import an existing wallet:

Use:

```text
signer import
```

Then paste your wallet private key or recovery phrase directly.

Accepted pasted formats:
- 12/24-word recovery phrase
- base58 private key string
- base64 private key string
- byte array
- JSON object containing `privateKey`, `secretKey`, `mnemonic`, `seedPhrase`, or `recoveryPhrase`

Examples:

```text
5J7n...yourPrivateKeyHere...
twelve word recovery phrase goes here ...
[12,34,56,78,...]
{"privateKey":"5J7n...yourPrivateKeyHere..."}
```

Supported import forms:

```text
signer import
signer import [12,34,56,...]
signer import /full/path/to/keypair.json
```

`signer setup` is the guided paste flow.
`signer create` generates a brand-new burner wallet and stores it encrypted.
`signer reveal` shows the stored wallet address and recovery phrase again after confirmation.

For recovery phrases, the app verifies the derived wallet against the expected app-wallet address so it will not silently import the wrong derived account.

`signer import /full/path/to/keypair.json` is only for manual file import if you already have a local key file.

After import:

```text
signer unlock
```

Then verify:

```text
signer status
```

Full shortest path:

```text
npm start
signer setup
signer unlock
20r on
r
```

Or, for mission-mode threshold resets:

```text
mm 68
r
```

## How Keys Are Stored

Generated or imported app-wallet keys are not kept as plaintext app config.

Storage model:
- encrypted vault blob on disk
- vault key in OS secure storage

OS secure storage backends:
- macOS Keychain
- Windows DPAPI
- Linux Secret Service

## Change or Remove Wallet

To replace the wallet with a new one:

```text
signer setup
```

or

```text
signer create
```

or

```text
signer import
```

or

```text
signer import /path/to/new-wallet.json
```

If a wallet already exists, the app asks for confirmation before replacing it.

To remove the imported wallet entirely:

```text
signer remove
```

That removes:
- the encrypted vault file
- the OS-stored vault key

## Reset Modes

### Level 20 Reset Mode

Enable:

```text
20r on
```

Disable:

```text
20r off
```

### Mission Mode Reset

Enable with current configured threshold:

```text
mm on
```

Disable:

```text
mm off
```

Set a threshold directly:

```text
mm 68
```

## Triggering Work

Run immediate claim + assign + reset handling:

```text
c
```

Run reset check only:

```text
r
```

Run one-off level 20 reset check:

```text
reset20
```

Behavior by mode:
- `app_wallet`
  - prepare -> terminal approval prompt -> sign -> submit
- `manual`
  - opens the missions page for you to handle it yourself
- `dapp`
  - opens the prepare payload bridge signing URL in your browser wallet
  - complete approval/signing in browser, then return to the app

## Commands

General:
- `help`
- `clear`
- `status`
- `login`
- `check`
- `c`
- `r`
- `reset20`
- `20r [on|off]`
- `mm [off|on|<level>]`
- `pause`
- `resume`
- `q`

Signer:
- `signer status`
- `signer setup`
- `signer create`
- `signer reveal`
- `signer app_wallet`
- `signer manual`
- `signer dapp`
- `signer import`
- `signer import [path-or-key]`
- `signer unlock`
- `signer lock`
- `signer remove`

## Config

Common keys in `config.json`:
- `targetMissions`
- `watchLoopEnabled`
- `watchPollIntervalSeconds`
- `level20ResetEnabled`
- `missionModeEnabled`
- `missionResetLevel`
- `totalClaimed`
- `signerMode`
- `signer`

Example:

```json
{
  "totalClaimed": 710,
  "targetMissions": ["Do it All!", "Race!"],
  "watchPollIntervalSeconds": 30,
  "level20ResetEnabled": false,
  "missionModeEnabled": false,
  "missionResetLevel": "68",
  "watchCycleSeconds": 0,
  "signerMode": "app_wallet",
  "signer": {
    "enabled": true,
    "vaultFile": "data/signer-vault.json",
    "auditFile": "data/signer-audit.log"
  }
}
```

## Notes

- If commands you expect are not recognized, restart the app so the latest command handler is loaded.
- `dapp` mode opens the PbP signing-bridge URL returned by the prepare tool (on pixelbypixel.studio) so you can approve in your already-connected browser wallet.
- Mission swap is intentionally not wired yet.

## License

MIT. See [LICENSE](./LICENSE).
