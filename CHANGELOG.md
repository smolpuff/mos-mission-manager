# Changelog

## 3.2.18 — 2026-10-17

Required updater and desktop security update:

- Create, import, and view app wallet recovery keys while missions are stopped. Import verifies unlock and lock, and includes a dedicated-wallet warning.
- Show existing mission levels and assigned NFTs during setup, match the main mission card styling, and keep setup cards display-only. Reuse the existing sync data without extra MCP calls.
- Use version.json as the only update metadata source, remove the separate release manifest, and restore the original Windows EXE filename.
- Try closing the auth tab immediately, retry after one second, and show “You can close this window now.” when it stays open.
- Fix the Windows PowerShell update helper failing to start, and keep the replacement helper alive after the app exits. Preserve failure logs and include their path in the error.
- Fetch recovery phrases only on Reveal, clear them on Hide or Close, and discard delayed responses after dismissal. Restrict recovery requests to the trusted control window and revalidate it before returning the backup.
- Harden macOS and Windows desktop windows with IPC sender validation, navigation restrictions, sandboxing, and a content security policy.
- Add regression tests and isolated real-application security and portable-update rehearsals.

If an installed Windows build reports that its update helper could not start, download v3.2.18 manually once. Its old updater cannot repair itself through a failed update. Fonts, wallet vaults, and token storage are unchanged.

Changes since v3.2.16:

- Add Season 71–73 statistics ranges using Eastern time boundaries, including daylight saving changes. Apply season filters to totals, NFT usage, CSV exports, and clearing statistics; cap hourly averages at the season end.
- Show seasons after they launch, retain completed seasons, and remove the session option from the statistics selector.
- Add in-app download, verification, replacement, and restart updates for macOS and Windows, with progress feedback and artifact checksums in version.json after all platform uploads succeed. The real Windows portable update lifecycle has been verified locally; release checks also run the native Mac update rehearsal before publication.
- Fix Level 20+ NFT selection to use all mission-eligible collections while retaining reserved NFT priority for lower-level fallback. Enrich eligible NFTs with cached metadata without introducing ineligible accounts.
- Refresh the claim interface immediately after a successful claim to prevent it from appearing stuck.
- Stabilize Linux window dragging on Hyprland and use XWayland when available for local desktop launches to address scaling.
- Synchronize package, lockfile, and updater versions at 3.2.18.

The release workflow provides macOS arm64/x64 ZIPs, a Windows x64 portable executable. Linux fixes are included in the source; this workflow does not publish a Linux binary.
