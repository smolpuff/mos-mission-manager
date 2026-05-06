# Electron App Update Checker

## Goal

Implement a lightweight update checker system for the Electron app.

This is **NOT** a full auto-updater.

The app should:

- silently check for updates on startup
- compare against a remote GitHub JSON file
- show an update modal if a newer version exists
- allow the user to manually open/download the update
- allow enabling/disabling update checks in settings

Do NOT implement:

- automatic downloads
- automatic installs
- release channels
- background updater services

Keep everything lightweight and simple.

---

# Update Source

Fetch this JSON file:

```txt
https://raw.githubusercontent.com/smolpuff/mos-mission-manager/main/version.json
```

Example structure:

```json
{
  "version": "3.2.2",
  "downloadUrl": "https://github.com/smolpuff/mos-mission-manager/releases/latest",
  "notes": "Fixed bugs and improved mission mode"
}
```

---

# Settings Page

Add a new settings option.

## Label

Automatically check for updates on startup

## Description

Checks GitHub for newer versions when the app launches.

## Behavior

- enabled by default
- stored persistently
- if disabled:
  - app never checks for updates automatically

Use the existing switch/toggle component style already used throughout the app.

-include a manual check bnutton under the option

---

# Startup Flow

After the app UI initializes:

```txt
load settings
→ update checks enabled?
→ fetch update.json
→ compare versions
→ if newer version exists:
→ open update modal
```

The update check should happen silently in the background.

If fetch fails:

- fail silently
- no popup
- no user-facing error
- only log errors in development mode

---

# Version Comparison

Use Electron:

```js
app.getVersion();
```

Compare:

- installed version
- remote version from update.json

If versions differ:

- show update modal

If same:

- do nothing

---

# Update Modal

Use the app's existing modal component/system.

The modal should visually match the style of all existing app modals.

---

## Modal Title

```txt
Update Available
```

---

## Modal Content

```txt
A newer version of the app is available.
```

Show:

- latest version number
- update notes from JSON

Example:

```txt
Version 1.0.1 is available

Fixed bugs and improved mission mode
```

---

# Modal Buttons

## Download Update

Opens:

```txt
downloadUrl
```

---

-clicking the acncel or open url (wahtever text)Button shoudl close the modal

---

# Suggested Files

## New Files

```txt
src/utils/updateChecker.ts
src/components/modals/UpdateModal.tsx
```

---

## Existing Areas To Update

- settings state/store
- startup/init flow
- modal system

---

# Suggested Update Checker Logic

```ts
async function checkForUpdates() {
  // load update.json
  // compare versions
  // open modal if newer version exists
}
```

---

# Important Notes

This should be:

- lightweight
- non-invasive
- simple to maintain

The user should always manually choose to download/install updates.

No background installer behavior.

No forced updates.

No auto-download system.

Only:

- check JSON
- compare version
- show modal
- open external download page

---

# Expected UX

```txt
app launches
→ app UI loads normally
→ silent update check runs
→ if update exists:
→ modal appears
→ user clicks:
   - Download Update
   - or Later
```
