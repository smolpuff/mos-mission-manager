```text
    /)/)
   ( ..\
   /'-._)
  /#/
 /#/
```

##

`missions-v3-mcp` is a Node.js CLI app for automating Pixel by Pixel mission workflows through MCP tools. It handles authentication, mission checks, reward claims, NFT assignment for selected mission.

## Status

This project is actively in development. Core watch, claim, assign, auth recovery, and reset-threshold detection flows are implemented.

Auto-assign now trusts the MCP mission state directly. The old post-claim assignment sync-wait fallback has been removed, so assign checks no longer do delayed `1200ms / 2500ms / 5000ms` rechecks before deciding whether a target mission is available.

CURRENTLY IMMEDIATELY OPENS UP A BROWSER TAB FOR ANY RESET USER INTERACTIONS, UNTIL SINGING IS ADDED. YOU WILL BE SPAMMED WITH TABS EVERY TICK IF YOU HAVE RESETS ENABLED AND THE THRESHOLD IS MET.

Signed transaction flows like mission reset, swap, reroll, and cooldown resets are not implemented yet.

Entirely vibe-coded after .5g dabs because why not. My dead grandmother probably has less slop in her grave.

## Features

- MCP-first runtime with local token persistence
- Startup checks for auth, mission catalog, mission stats, and NFT counts
- Auto-assign for configured target missions
- Immediate reset-threshold detection with browser popup for manual reset handling
- Start/Stop watch and claim controls

## TO DO

- 'get*wallet*\*' to pull related balances to header
- signed tx flows
- mission reroll
- nft cooldown reset
- mission level reset
- unlock mission slot
- rental support when payload returns a way
- rental modes: mmX, 7day, troll
- electron wraper for the lulz

## Limitations

- anything requiring wallet_singing because i'm lazy

## Requirements

- Node.js 24 or newer.
- Access to the Pixel by Pixel MCP endpoint
- A valid local `config.json`

## Installation

Install deps:

```bash
npm install
```

Create or update `config.json`. A starter example is available in `config.sample.json`.

## Configuration

The app reads runtime settings from `config.json`.

Common keys:

- `targetMissions`: mission names or mission IDs to manage
- `watchLoopEnabled`: optional; set to `false` to start with the watcher disabled
- `watchPollIntervalSeconds`: polling interval for live checks
- `level20ResetEnabled`: enables level-20 reset detection mode
- `missionModeEnabled`: enables custom reset-threshold mode
- `missionResetLevel`: threshold used when mission mode is enabled
- `totalClaimed`: persisted local claim counter

Example:

```json
{
  "totalClaimed": 710,
  "targetMissions": ["Do it All!", "Race for Points"],
  "watchPollIntervalSeconds": 30,
  "level20ResetEnabled": false,
  "missionModeEnabled": false,
  "missionResetLevel": "20"
}
```

## Usage

Run in normal mode:

```bash
npm start
```

Run with nodemon for development:

```bash
npm run dev
```

## Pre-compiled Binaries

Download them from the /binaries folder... but really just use the sr

- run `node app.js` from your terminal. Node 24+ required.

## Commands

| Command                 | Description                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`                  | Shows the available commands and their usage.                                                                                                                                                 |
| `clear`                 | Clears the terminal output/header for a cleaner view.                                                                                                                                         |
| `login`                 | Starts the login flow to refresh or restore authentication.                                                                                                                                   |
| `c`                     | Runs a manual forced check/claim loop immediately.                                                                                                                                            |
| `20r [on\|off]`         | Enables or disables level-20 reset detection mode.                                                                                                                                            |
| `mm [off\|on\|<level>]` | Controls mission mode reset level-threshold handling. Use `on` to enable with the current configured threshold, `off` to disable it, or pass a level value to set a custom level reset level. |
| `pause`                 | Pauses the active watch/claim loop.                                                                                                                                                           |
| `resume`                | Resumes the active watch/claim loop.                                                                                                                                                          |
| `q`                     | Quits the application.                                                                                                                                                                        |

## License

MIT. See [LICENSE](./LICENSE).
