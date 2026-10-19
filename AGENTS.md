## Desktop update metadata

- Use the repository's `version.json` as the only remote update metadata source, including version, release notes, artifact URLs, and checksums.
- Never create, publish, or request `update.json` or `desktop-update.json` in a release directory or as a release asset.
- Keep intermediate build metadata in the runner's temporary directory, outside release output.
- Preserve the original published Windows EXE naming: `missions-v3-mcp.<version>.exe`. Do not add an architecture or portable suffix.

## Wallet tools

- Wallet creation, import, and recovery-key viewing must work while the runner is stopped. Never start the runner or require missions to run for local wallet operations, including first-time setup.
