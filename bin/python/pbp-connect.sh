#!/usr/bin/env bash
set -euo pipefail

# Keep Codex MCP server configured for codex-exec-based scripts.
if ! codex mcp get pbp >/dev/null 2>&1; then
  codex mcp add pbp --url https://pixelbypixel.studio/mcp
fi

# For low-token direct polling, authenticate pbp-mcp via OAuth PKCE.
# This flow opens browser and captures callback locally; no manual token copy.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if "${PROJECT_ROOT}/bin/pbp-mcp" whoami >/dev/null 2>&1; then
  echo "pbp-mcp is already authenticated."
  exit 0
fi

exec "${PROJECT_ROOT}/bin/pbp-mcp" login "$@"
