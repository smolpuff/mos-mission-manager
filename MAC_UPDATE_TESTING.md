# Verify the self-updater in the actual Mac application

The separate demo and synthetic app tests have been removed. This command builds and opens the full Missions application, using its real React update dialog and its existing main/preload updater path.

```bash
npm run test:mac-update
```

Wait for the app's normal update check to display the offered version and notes. Click **Download and restart** in that dialog. The dialog shows download progress and a percentage, then verification and restart status. The terminal verifies the transfer, replacement and restart. **Cancel** dismisses the offer without downloading. No other update buttons or alternate test window are added.

The command builds isolated current/next-version copies of the actual app. Private test settings and a private home directory start without copied wallets or login tokens. Manual tests retain normal network/authentication behavior, so you can log in yourself. Automated unattended tests block non-update requests. Only these copies receive a local release transport and inspector configuration; the production updater URL policy is unchanged. The server transfers the complete next-version ZIP over loopback HTTP. Local test support is excluded from production packages.

To execute the click automatically in the same real dialog:

```bash
npm run test:mac-update -- --auto
```

To verify that a bad repository MD5 prevents replacement inside the actual application:

```bash
npm run test:mac-update -- --auto --bad-md5
```

The printed `/private/tmp/missions-actual-app-update-…` directory holds `result.json`, screenshots, build/app logs, release metadata, the ZIP and both application copies. The successful test requires the entire installed `app.asar` to match the downloaded release's ASAR, a new process running the offered version at the original path, successful acknowledgement from the real renderer, and retained settings. The incorrect-MD5 case must leave the original ASAR untouched. The automated check does not start the runner against an account.

Use a normal Mac terminal; app launch, localhost serving and inspector access may require execution outside the Codex sandbox. Automated runs close their own app copies when done. Manual runs leave the verified app open for inspection; quit it before deleting the printed temporary folder.

No release is published or production version changed. This verifies the actual app against a local release transport; public GitHub delivery, Intel hardware, and browser-download Gatekeeper behavior still need release validation. Windows must be tested using the real portable application on Windows.

## Results

Verified on an Apple Silicon Mac on 2026-09-09:

- Actual application upgrade, 3.2.16 → 3.2.17: passed. The existing dialog had exactly Cancel / Download and restart, downloaded 134,509,557 bytes after confirmation, replaced the complete ASAR, and reopened at the same path. The real renderer displayed the new version, acknowledged startup, and retained private settings.
- Incorrect MD5, with the correct SHA-256: passed. The actual application rejected the complete download and the original ASAR remained unchanged.
- Existing repository tests: 46 passed.

The first actual-app run exposed Electron's ASAR-aware filesystem treating the output `app.asar` as a package during extraction. The extractor now uses Electron's `original-fs` for raw archive writes. Both successful cases above were run after that fix.

Local proof directories (temporary, not committed):

- Upgrade: `/private/tmp/missions-actual-app-update-GdGlwR`
- Incorrect MD5: `/private/tmp/missions-actual-app-update-6BDBRS`

Each contains `result.json` and screenshots from the actual Missions application. These runs use local release transport; they do not establish public GitHub delivery or native Windows behavior.
