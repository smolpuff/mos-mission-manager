# macOS Instructions

## Updating the Desktop App

Updater-enabled builds keep the existing update notice. Choose **Download and restart** to download and verify the matching Mac release, stop the runner safely, replace the app, and reopen it. **Cancel** dismisses the offer; these are the only two buttons. Settings and wallet data stay in their existing location.

The first version containing this updater must be downloaded manually. Subsequent releases must include `desktop-update.json`; the release workflow generates it after both Mac ZIPs and the Windows release upload successfully. Existing releases without that metadata can still be downloaded manually. Windows portable replacement is implemented but still requires testing on Windows.

Run the app from a writable folder, such as your user Applications folder. Updating is disabled for source/development runs and refused for translocated apps, mounted volumes, or unwritable locations. This does not bypass macOS signing, notarization, or Gatekeeper.

If an update fails before replacement, the old app stays in place. If the replacement cannot open, the helper restores the old app. If startup confirmation is missing, it retains the backup and reports its location on the next launch. Quit all app copies before restoring a backup. A hidden sibling directory named `.missions-v3-mcp.app.update-…` (or using your renamed app's name) contains `RECOVERY.txt`, `state`, and `helper.log`. A stale `.app.update-lock` after an interrupted update must be removed only after all app copies and its `helper.sh` process have exited; the next attempt can then clean the abandoned staging directory. Do not delete a directory containing `backup.app` until you have recovered or verified the new app.

The release workflow publishes each ZIP's MD5, SHA-256, and byte size in the repository's tagged `desktop-update.json` release asset. The updater requires all three to match before extraction or replacement. It trusts this project's GitHub release publishing access and HTTPS; these checksums are not independent publisher signatures. MD5 is supplemental because SHA-256 provides stronger tamper detection.

To try the full download and replacement without publishing a release, run `npm run test:mac-update` from this checkout. An isolated copy of the actual Missions application opens and performs its normal update check; click **Download and restart** in its existing dialog. See [MAC_UPDATE_TESTING.md](MAC_UPDATE_TESTING.md) for the proof report and the deliberately incorrect-MD5 test.

## Recommended: Build It Yourself

The packaged mac app is not Apple-signed or notarized right now. macOS may block it or make opening it annoying.

The easiest reliable path is to build the app locally on your own Mac.

From the project folder:

```bash
npm install
npm run desktop:dist:mac
```

That will create the mac build output in:

```text
./release/
```

Then open the generated `.app` from the build output on your own Mac. You can move it to your Applications folder once you have built it.

This is usually smoother than using the downloaded prebuilt release because the app is being built locally on the same machine.

## Option 2: Run from Source Without Building a Packaged App

If you do not want to build the full mac app bundle, run the desktop app directly from the project files:

```bash
npm install
npm run desktop:build
npm run desktop
```

## Basic Setup

You will need to:

1. Install Node.js 24+
2. Download or clone this repo
3. Open Terminal in the project folder

## If You Download the Packaged mac App

macOS may block the app because it is not signed/notarized by Apple.

If that happens:

1. Unzip the download
2. Open Terminal
3. Run:

```bash
xattr -dr com.apple.quarantine "/path/to/missions-v3-mcp.app"
```

4. Then launch it:

```bash
open "/path/to/missions-v3-mcp.app"
```

Replace `"/path/to/missions-v3-mcp.app"` with the real path to the app on your Mac.
