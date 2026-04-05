# missions-mcp

`missions-mcp` is a Node.js CLI app for automating Pixel by Pixel mission workflows through MCP tools. It handles authentication, mission checks, reward claims, NFT assignment for selected mission.

## Status

This project is actively in progress. Core watch, claim, assign, auth recovery, and reset-threshold detection flows are implemented.

Signed transaction flows such as mission reset, swap, reroll, and cooldown resets are not fully implemented yet.

## Features

- MCP-first runtime with local token persistence
- Startup checks for auth, mission catalog, mission stats, and NFT counts
- Watch loop for claim detection and reward collection
- Auto-assign for configured target missions
- Immediate reset-threshold detection with browser popup for manual reset handling
- Start/Stop watch and claim controls

## TO DO

- tx singing (a&b)
  - mission selection
  - nft cooldown reset
  - mission level reset

## Requirements

- Node.js 18 or newer
- Access to the Pixel by Pixel MCP endpoint
- A valid local `config.json`

- ------> A BURNER WALLET IF YOU WILDLY TRUST IMPORTING YOUR KEYS <-------

## Installation

Install dependencies:

```bash
npm install
```

Create or update `config.json`. A starter example is available in `config.sample.json`.

## Configuration

The app reads runtime settings from `config.json`.

Common keys:

- `targetMissions`: mission names or mission IDs to manage
- `interactiveAuth`: enables browser-based login flow
- `watchLoopEnabled`: starts the watcher automatically
- `watchPollIntervalSeconds`: polling interval for live checks
- `level20ResetEnabled`: enables level-20 reset detection mode
- `missionModeEnabled`: enables custom reset-threshold mode
- `missionResetLevel`: threshold used when mission mode is enabled
- `totalClaimed`: persisted local claim counter

Example:

```json
{
  "totalClaimed": 0,
  "targetMissions": [
    "Do it All!",
    "Race!",
    "Get Tilted for Points!",
    "Race for Points"
  ],
  "interactiveAuth": true,
  "debugMode": false,
  "watchLoopEnabled": true,
  "watchPollIntervalSeconds": 30,
  "level20ResetEnabled": false,
  "missionModeEnabled": false,
  "missionResetLevel": "6"
}
```

## Usage

Run in normal mode:

```bash
npm start
```

Run with nodemon during development:

```bash
npm run dev
```

## Commands

Available commands:

- `help`
- `clear`
- `login`
- `check`
- `c`
- `20r [on|off]`
- `mm [off|on|<level>]`
- `pause`
- `resume`
- `q`

## Runtime Behavior

Loads config, checks authentication, validates configured target missions against the catalog, refreshes mission stats, performs an initial claim/assign pass, and then enters the watch loop.

During runtime, the watcher:

- checks for claimable mission rewards
- updates local claim counters
- attempts to assign NFTs to matching unassigned target missions
- performs immediate reset-threshold checks at startup, during poll ticks, and during manual processing
- retries token refresh up to three times, then falls back to popup login if refresh fails

## Project Structure

- `app.js`: application bootstrap
- `src/context.js`: shared runtime state
- `src/logger.js`: terminal header and logging
- `src/config.js`: config load and save
- `src/mcp/client.js`: auth and MCP tool client
- `src/missions/normalize.js`: mission and NFT normalization helpers
- `src/services/checks.js`: startup checks, stats, claims, and assignment
- `src/services/watch.js`: watch loop and reset detection
- `src/commands.js`: interactive command handling

## Limitations

- Mission reset, mission swap, reroll, and NFT cooldown reset signed flows are not complete yet.
- Browser popup behavior depends on the local OS and installed browser.
- The app depends on MCP API behavior remaining compatible with current tool names and payload shapes.

## Additional Docs

- [FEATURES.md](./FEATURES.md): current implemented behavior and planned features
- [TODO.md](./TODO.md): active work list and implementation notes

## License

MIT. See [LICENSE](./LICENSE).
