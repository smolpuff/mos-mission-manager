# macOS Instructions

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
