# Self-updater in the existing desktop application

## Required behavior

Use the existing Missions application's update check and update dialog on Mac and Windows. Preserve the dialog's layout, styling, version information, release notes and URL display. Its only buttons are **Cancel** and **Download and restart**. There is no alternate updater interface or additional manual-download button. As subsequently requested, the existing dialog shows a download progress bar and percentage after confirmation, followed by verification/preparation/restart status. The download button also shows progress while disabled.

Clicking Cancel dismisses the offer without downloading. Clicking Download and restart downloads the matching release, verifies its repository-published MD5, SHA-256 and byte count, prepares the replacement, stops the runner safely, quits, replaces the application at its original path, and reopens it. A failed check/download/verification must not replace the application.

## Shared implementation

- Retain `version.json` and the existing startup/manual checks. Use the offered exact version to retrieve `desktop-update.json` from the same tagged GitHub release.
- Generate per-platform release metadata containing artifact URL, size, MD5 and SHA-256. Require all three integrity checks before using the artifact. MD5 supplements SHA-256; neither independently authenticates a compromised publishing account.
- Keep URL validation, version/platform selection, streaming downloads, status IPC and confirmation in the existing application's main/preload/renderer flow. Accept only a previously offered version from the renderer, never arbitrary paths or URLs.
- Keep settings and wallet data outside the replacement. Abort if the runner does not stop cleanly; no updater-triggered forced shutdown.
- Keep backup/recovery state until the new application's real renderer acknowledges its version and transaction. Preserve backups after uncertain startup instead of overwriting a potentially running app.

## Mac

Use the existing ZIP distribution. Stage beside the installed `.app`, safely extract files and internal framework symlinks, and validate the bundle's identity, version and architecture. Reject translocated/read-only/unwritable locations without modifying macOS security settings. A detached shell helper waits for the application to exit, moves the old bundle to backup, moves the new bundle to the original path, and relaunches it. Restore the backup on replacement/launch failure.

## Windows

Use the existing portable EXE distribution and the same dialog/download/hash flow. Resolve the original EXE through `PORTABLE_EXECUTABLE_FILE`; `process.execPath` points into the launcher's temporary extraction directory. A detached Windows helper must wait for both the app and portable launcher, retry bounded file-lock failures, replace the original EXE while retaining its filename, and relaunch it. This requires Windows process and file-lock handling in addition to different paths. Stage/backup on the same volume; refuse unwritable locations without silently elevating.

## Actual-application verification

The separate demo application and synthetic app fixtures have been removed. They are not acceptance evidence.

`npm run test:mac-update` builds the full Missions application from this checkout, including its actual main process, preload, React renderer, update dialog, downloader and replacement helper. It makes isolated current/next-version copies of that application. Only the test copies receive a bootstrap selecting private settings, a local release transport and an inspector port. Production UI and update handlers are not replaced or mocked. No real wallet/session is copied.

The application's normal startup check finds the locally served release and displays its notes. The user clicks **Download and restart in the real dialog**. `--auto` clicks that same rendered button through the inspector. Verification requires a full HTTP ZIP transfer, matching hashes, an installed ASAR identical to the next release, a new process at the original application path, the real renderer's health acknowledgement, and preserved isolated settings. Screenshots and a JSON result record the actual app before/after. `--bad-md5` must reject the file and preserve the original application's ASAR.

Mac execution is verified here: the actual packaged app upgraded from 3.2.16 to 3.2.17, reopened with the new renderer version at the original path, and rejected a separate incorrect-MD5 download without changing its ASAR. Windows implementation must receive the equivalent actual portable-application upgrade, Unicode installation-path, and file-lock tests on Windows before it is claimed to be validated. Intel hardware and downloaded-release Gatekeeper checks remain release gates even when cross-packaging succeeds.

## Publishing

Do not publish a release, change live version metadata, or bump the checkout's version during local verification. Publish complete update metadata only after all platform artifacts upload successfully. Users need one manual download of the first updater-bearing version.

## Review status

This plan supersedes the earlier demo-based verification plan and its acceptance claims. On 2026-09-09, the independent reviewer approved the current local implementation and plan after reviewing the actual Mac success/rejection reports and correcting Windows PowerShell UTF-8 path handling. No remaining concrete code blocker was found. Windows approval is source review only: native portable upgrade, launcher/file locks and Unicode paths remain unverified. Intel hardware and distributed ZIP Gatekeeper checks remain release gates. Actual Mac results are recorded in `MAC_UPDATE_TESTING.md`.
