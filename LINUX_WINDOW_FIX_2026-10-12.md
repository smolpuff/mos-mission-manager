# Linux window compatibility fix — 2026-10-12

This change fixes title-bar shaking on Linux and incorrectly scaled Electron
content observed on Hyprland with a 2× display. It does not change app version
numbers or publish new release binaries.

## Exact changes

- `renderer/src/components/WindowChrome/app.jsx`: on Linux only, disable the
  custom mouse-driven `getWindowPosition` / `setWindowPosition` drag loop and
  add the `window-chrome--native-drag` CSS class.
- `renderer/src/styles.css`: make that Linux-only class and its title area
  native Electron drag regions. Existing buttons remain `no-drag`.
- `renderer/src/pages/CliPage.jsx`: on Linux only, disable the second custom
  top-bar drag handler; the title bar and existing drag strip handle dragging.
- `electron/launch.js`: add a development/local desktop launcher. On Linux,
  select `--ozone-platform=x11` only when both `HYPRLAND_INSTANCE_SIGNATURE`
  and `DISPLAY` are present, unless an explicit `--ozone-platform` argument
  is supplied. Remove `ELECTRON_RUN_AS_NODE` only from the Linux child
  environment, forward signals, and propagate its exit status.
- `package.json`: route only `desktop` and `desktop:dev` through this launcher.

## Platform scope and limits

- All Linux desktops receive native title-bar dragging.
- Only Hyprland sessions with XWayland available receive the automatic X11
  backend selection. Other Linux desktops retain Electron's normal backend.
- Mac and Windows pass through to the original `electron/cli.js` with the
  original `.` app argument, extra arguments, environment, and CLI behavior.
  Their custom dragging behavior remains unchanged.
- The backend workaround applies to `npm run desktop` and `npm run desktop:dev`.
  Packaged applications still enter `electron/main.js` directly, so a directly
  launched AppImage does not automatically receive the backend workaround.
  Packaged Linux renderers do receive the native dragging change.
- Build/distribution scripts, updater code, dependency versions, application
  logic, and desktop configuration are unchanged by this commit.

## Diagnosis and verification

The native Wayland renderer reported an 800×800 viewport but a pixel ratio of
0.90625 on a display configured at scale 2. The screenshot showed unused strips
along the right and bottom. An explicit XWayland test reported pixel ratio 2
and filled the window. The final launcher was confirmed by Hyprland to use
XWayland with an 800×800 window. The user confirmed the dragging fix stopped
shaking.

`npm run desktop:build`, JavaScript syntax checks, and `git diff --check` passed.
Mocked Mac/Windows launcher checks confirmed delegation to the original CLI
with arguments and environment preserved. Native Mac and Windows execution
was not tested on this Linux machine.

## Local installation repair and excluded changes

The initial Electron installation lacked its executable and `path.txt`.
The Electron 41.2.0 Linux archive was downloaded and unpacked locally, then
`node_modules/electron/path.txt` was restored. This repair is not committed;
other computers install their own platform-specific Electron binary.

The existing `package-lock.json` edits and `package.json` `allowScripts` block
were already present before this work and are excluded from this commit.

## Revert

Find this commit with:

```sh
git log --oneline --grep="fix(linux): stabilize Electron windows on Hyprland"
```

Then revert the hash shown:

```sh
git revert <commit-hash>
git push origin main
```

This restores the original desktop scripts and custom dragging, removes the
launcher and this note, and keeps unrelated commits. Close the app and restart
`npm run desktop:dev` after reverting. Preserve or stash unrelated uncommitted
work first if Git reports overlapping changes.

To test native Wayland without reverting:

```sh
npm run desktop -- --ozone-platform=wayland
```
