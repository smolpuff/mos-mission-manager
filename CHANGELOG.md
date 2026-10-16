# Changelog

## 3.2.18 — 2026-10-16

Changes since v3.2.16:

- Add Season 71–73 statistics ranges using Eastern time boundaries, including daylight saving changes. Apply season filters to totals, NFT usage, CSV exports, and clearing statistics; cap hourly averages at the season end.
- Show seasons after they launch, retain completed seasons, and remove the session option from the statistics selector.
- Add in-app download, verification, replacement, and restart updates for macOS and Windows, with progress feedback and a complete update manifest published after all platform uploads succeed. macOS application replacement has been verified locally; Windows replacement still needs validation on Windows.
- Fix Level 20+ NFT selection to use all mission-eligible collections while retaining reserved NFT priority for lower-level fallback. Enrich eligible NFTs with cached metadata without introducing ineligible accounts.
- Refresh the claim interface immediately after a successful claim to prevent it from appearing stuck.
- Stabilize Linux window dragging on Hyprland and use XWayland when available for local desktop launches to address scaling.
- Synchronize package, lockfile, and updater versions at 3.2.18.

The release workflow provides macOS arm64/x64 ZIPs, a Windows x64 portable executable, and desktop-update.json. Linux fixes are included in the source; this workflow does not publish a Linux binary.
