# Rehearse the actual Windows portable update

Build the current app, then start the rehearsal:

```powershell
npm run desktop:dist:win
npm run test:win-update
```

To rehearse the current release as the destination instead of the starting
version, use `node electron/update-tools/verify-windows-app.js --from-version=3.2.16` (with an older
version). Both private copies still contain the current fixed updater; this does
not make a historical broken updater able to install its own repair.

The rehearsal builds two private copies of the actual NSIS portable app. The
current copy uses the repository version; the offered copy uses the next patch
number **only as a test label**. For example, a v3.2.18 repository rehearses
v3.2.18 → test v3.2.19. It does not change the repository version or publish a
release. Both copies contain the current updater implementation.

Wait for the `[UPDATE TEST]` window and click **Download and restart** in the
normal update dialog. A localhost server delivers the full portable EXE slowly
enough to see the normal progress indicator. The app then quits, replaces its
portable EXE, and restarts at the same path. The updated private app stays open.

The script reports success only after verifying:

- The complete EXE was downloaded exactly once and passed production SHA-256/MD5 checks.
- The installed EXE matches the offered EXE and differs from the original.
- A different app process starts at the same portable path with the offered version.
- The real renderer acknowledges healthy startup, and the helper completes and removes its backup.
- A marker in the private settings survives the update.

The printed temporary folder retains `result.json`, `launches.jsonl`, `build.log`,
the private settings, both test packages, and the update transaction with its
helper log. The normal app, settings, wallets, and tokens are not copied or used.
Non-update fetches are blocked in the test app. Only the private copies receive
the local release transport and test window title; updater/UI/helper code stays
unchanged, and test tools remain excluded from production packages.

This validates the Windows portable lifecycle with local delivery. It does not
validate public GitHub downloads, historical unfixed installers, or macOS.

Verified on Windows on October 17, 2026: v3.2.18 → test v3.2.19, 439,303,499
bytes downloaded, EXE replaced, new process started, healthy acknowledgement
received, settings preserved, and helper state `complete`.

Final v3.2.18 release rehearsal, October 17, 2026: private v3.2.16 label →
v3.2.18 destination, 439,309,674 bytes downloaded, exact EXE hash verified,
replacement and restart completed, settings preserved, and real renderer healthy
acknowledgement received. Both private packages used the current fixed updater.
