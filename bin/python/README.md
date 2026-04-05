# PbP MCP Lulz Starter

Tiny starter to play with the new Pixel by Pixel MCP endpoint:

- Endpoint: `https://pixelbypixel.studio/mcp`
- Post referenced: `PbP Meets MCP` (published March 27, 2026)

## 1) Connect PbP MCP in Codex CLI

```bash
codex mcp add pbp --url https://pixelbypixel.studio/mcp
codex mcp login pbp
```

## 2) Run a fast sanity check

Use the prompt in [`prompts/00-smoke-test.md`](./prompts/00-smoke-test.md).

## 3) Do the lulz build

Use [`prompts/10-lulz-operator.md`](./prompts/10-lulz-operator.md) as your operator prompt.
It asks the agent to:

- scan missions
- identify near-finish / claimable rewards
- suggest best loadout moves
- optionally execute safe account actions only with explicit confirmation

## CLI v1

Run:

```bash
./bin/pbp status
./bin/pbp suggest
./bin/pbp-status-all
./bin/pbp-get-mission-nfts
./bin/pbp-live-reset-candidates --collection "<COLLECTION_NAME>" --top 5 --interval 30
./bin/pbp-mcp tools
./bin/pbp-mcp audit
```

Low-credit live polling path:

- Authenticate once: `./bin/pbp-connect.sh`
- Then use direct MCP polling watcher: `./bin/pbp-live-reset-candidates ...`
- This avoids `codex exec` loops and uses `pbp-mcp` direct calls (`llm_tokens=0`).

Optional JSON output:

```bash
./bin/pbp --json status
./bin/pbp --json suggest
```

Current provider defaults to `mock`. `pbp-mcp` is scaffolded but not yet wired.

`pbp-status-all` uses your configured Codex MCP `pbp` server and asks it for a consolidated
read-only account snapshot (missions, wallet, orders, NFT context where available).

## Direct MCP Client (No LLM Loop Overhead)

`bin/pbp-mcp` talks to `https://pixelbypixel.studio/mcp` directly via HTTP JSON-RPC.

List tools (no auth needed):

```bash
./bin/pbp-mcp tools
./bin/pbp-mcp tools --json
```

Connectivity/auth audit:

```bash
./bin/pbp-mcp audit
```

Login once (PKCE + local callback capture, saves token to `~/.pbp-mcp/token.json`):

```bash
./bin/pbp-mcp login
```

Call `who_am_i` (uses saved token automatically):

```bash
./bin/pbp-mcp whoami
```

Generic tool call:

```bash
./bin/pbp-mcp call get_user_orders --args '{"page":1}'
```

Logout (remove saved token):

```bash
./bin/pbp-mcp logout
```

Manual token import (bypass login):

```bash
./bin/pbp-mcp token-set "<access_token>"
./bin/pbp-mcp token-show
./bin/pbp-mcp token-show --reveal
./bin/pbp-mcp token-clear
```

Notes:
- Direct calls avoid Codex agent startup token overhead for routine polling/status checks.
- Discovery works without auth; tool calls require a valid OAuth bearer token.
- Override token file location with `--token-file` or env `PBP_TOKEN_FILE`.

## Optional helper

```bash
./bin/pbp-connect.sh
```

That just runs the two Codex MCP setup commands above.

## Suggested next tiny projects

1. `mission-watch`: poll + summarize + suggest next best actions.
2. `claim-coach`: detect claimable rewards and ask for one-click approval.
3. `shop-sniper`: watch target items and prep checkout steps.
