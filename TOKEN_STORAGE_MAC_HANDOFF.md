# MCP token storage: Mac handoff

## Goal and firm requirements

Address security finding #2: MCP access and refresh tokens currently persist as plaintext in `~/.pbp-mcp/token.json`.

- No macOS Keychain access prompts. The Mac app is unsigned; keep that constraint for this work.
- Login must persist across app restarts, manual replacement, and automatic updates.
- Do not change wallet storage, recovery phrases, signer vaults, MCP trust, or telemetry.
- Work on this separately from the already published v3.2.18 release. Do not publish another release or move its tag as part of the experiment.
- Never print real tokens, copy them into test fixtures, or send them through logs or command-line arguments.

## Important limitation

Do not implement Electron `safeStorage` on Mac under these requirements: it uses Keychain, and unsigned builds can prompt again after updates. Do not call `/usr/bin/security` as a workaround, broaden Keychain access to all applications, or suppress permission failures by reverting to plaintext.

Encryption needs a secret that survives updates. Without Keychain, a user-entered passphrase, or another protected secret provider, a completely automatic local implementation cannot keep its decryption secret inaccessible to other software running as the same user. A key beside the encrypted token file, an embedded application key, or a key derived from a public machine identifier does not solve that threat.

The immediate prompt-free improvement is restrictive filesystem permissions and safe writes. This reduces exposure to other local users and partial writes, but **does not resolve the plaintext-token finding or protect against malware running as the logged-in user**. Describe it accurately when reporting results. Stronger Mac storage requires a later explicit choice about the secret source; do not silently add a password prompt either.

## Relevant code

- `lib/mcp.js`: `readTokenFile`, `saveTokenFile`, `clearTokenFile`, `getAccessToken`, OAuth login, and refresh persistence. Current writes use `fs.writeFileSync` without an explicit mode or atomic replacement.
- `src/mcp/client.js`: `tokenRecord()` reads and parses the token file directly. Login and refresh delegate to `lib/mcp.js`. Any encrypted format must update all readers, not just the writer.
- `src/context.js`: backend token path is `~/.pbp-mcp/token.json`.
- `electron/main.js`: desktop MCP context uses that same path. The app also forks `app.js` with `ELECTRON_RUN_AS_NODE=1`; a future Electron-only encryption implementation must account for this backend and standalone Node/CLI consumers.

Do not inspect the user's live token contents while investigating. Use a temporary directory with synthetic credentials.

## Fast Mac experiment: permissions and persistence

1. Add a shared token-file storage helper used by both MCP readers. Keep the existing location and record fields, including refresh tokens and expiry timestamps.
2. On POSIX, create the token directory with mode `0700` and token files with mode `0600`. Repair permissions on existing app-owned token paths without recursively changing unrelated home-directory files. Fail clearly if permissions cannot be established.
3. Write using a unique temporary file in the same directory, restrictive permissions at creation, and atomic rename. Clean up temporary files on failure. Preserve the previous valid record if saving fails. Do not leave plaintext backups or print payloads in errors.
4. Check the token directory and target for symlinks and unexpected file types; avoid following them into unrelated files. Account for concurrent desktop/backend writers. Do not claim a simple preflight check eliminates all race conditions.
5. Keep logout and token refresh working through the same helper. Preserve environment-provided bearer-token behavior.
6. Keep normal login through the existing MCP OAuth flow. Do not read Twitch credentials or tokens from another application's credential store.

This is an interim hardening change, not encrypted storage. Do not add cosmetic encryption with a neighboring key to make it look complete.

## Windows follow-up

Windows DPAPI can encrypt the persisted tokens without a Mac-style Keychain prompt. It still permits decryption by software running as the same Windows user. Plan the desktop/backend/CLI interface before choosing an Electron-specific implementation; do not pass secrets in process arguments or environment variables as a shortcut.

For any encryption migration: write a separate candidate, decrypt it, compare the complete record, and only then atomically replace the old record. A denied or unavailable provider must preserve existing data and report a recoverable error. Never automatically downgrade encrypted storage to plaintext.

## Required tests before shipping

Use fake tokens and an isolated home/config directory throughout.

- Existing token records remain readable; new writes and refresh preserve all required fields.
- Directory permissions are `0700`; file and temporary-file permissions are `0600`, including with a permissive process umask.
- Failed writes leave the previous token record intact and clean temporary files.
- Malformed records, symlinks, unexpected file types, and concurrent writes are handled without clobbering unrelated files or logging secrets.
- Logout clears persisted tokens and does not recreate them from stale refresh work.
- Restart a real packaged Mac app and confirm login persistence with **zero Keychain prompts**.
- Replace that app with a different unsigned build, then exercise the actual automatic updater and confirm persistence and zero Keychain prompts again. Use a controlled test account only if a real OAuth check is necessary.
- Verify both the main-process MCP client and forked backend work. Run the existing regression and desktop-security checks.

Report which protections were added and which threat remains. Do not call finding #2 fixed if tokens are still plaintext.
