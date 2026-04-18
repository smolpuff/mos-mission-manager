```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

##

## SUPER WARNING

USE THIS AT YOUR OWN RISK.

THIS TOOL CAN BREAK, FAIL, MISFIRE, OR DO THE WRONG THING.
IT MAY MESS UP YOUR WORKFLOW, MISS ACTIONS, OR CREATE BAD STATE.

YOU ARE 100% RESPONSIBLE FOR EVERYTHING THAT HAPPENS WHEN YOU RUN IT.
THE AUTHOR IS NOT RESPONSIBLE FOR ANY LOSS, DAMAGE, OR ISSUES.

THIS PROJECT WAS ENTIRELY VIBE-CODED AFTER HALF-GRAM DABS. lolol.

`missions-v3-mcp` is a CLI + desktop control app for Pixel by Pixel mission automation over MCP.

- Use a dedicated burner wallet if you run `app_wallet` mode.

Implemented flows:

- auth + startup checks
- watch + claim
- target-mission assignment
- mission reroll
- NFT cooldown reset

## Disclaimer

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

## Usage

### 1) Open Settings

In the desktop app, go to **Settings**.

### 2) Configure wallet mode in the UI

In **Wallet** settings, choose your signer flow:

- `app_wallet`: app-managed burner wallet for supported signing
- `manual`: browser/manual flow
- `dapp`: browser-wallet signing flow

If using `app_wallet`, use the UI to generate or import the wallet and confirm it is active. Use a dedicated burner wallet if you run `app_wallet` mode.

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

Note: a first-launch wizard for this flow is planned, but not live yet.

## Running Missions

After wallet setup and mission config:

1. Open the app.
2. Go to the main missions/control page.
3. Configure missions on PBP site (for now, feature coming soon)
4. Press **Start** to begin processing.
5. Use **Pause/Resume** in the UI as needed.

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
- If expected commands do not appear, restart the app.
- Mission swap is intentionally not wired yet.

## License

MIT. See [LICENSE](./LICENSE).
