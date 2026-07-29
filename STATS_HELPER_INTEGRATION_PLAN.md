# My Stats Helper Integration Plan

## Goal

Add a dedicated **My Stats Helper** pane to this Electron app.

The feature will:

```text
Watch the live Marbles result file(s)
  → parse Battle Royale, Race, or Tilt results locally
  → normalize players and scoring fields
  → accumulate results across rounds/races/levels
  → update the local JSON payload
  → regenerate local HTML and CSV leaderboards
  → optionally upload the result to an authenticated website
```

The app performs the parsing and leaderboard work that the Tilt x Tilt website
currently performs. A website is optional and is not required for local events.

## Final Scope

### Included

- Battle Royale, Race, and Tilt event types.
- One or multiple live result files per event type.
- Configurable filenames/file patterns.
- Native file watching plus polling fallback.
- Local parsing and normalization.
- Local accumulation across multiple result files and rounds.
- Simple configurable leaderboard rules.
- Canonical local JSON payloads.
- Self-contained local HTML leaderboard.
- Local CSV exports.
- Optional website upload using a saved authentication token.
- Durable retry queue for failed uploads.
- A dedicated in-app pane for configuration, status, results, and activity.

### Not included

- Tilt x Tilt mode or branding.
- Invitations.
- Pairing codes.
- Website event/Tracker discovery.
- `send_to_app`.
- App/device-token discovery.
- Multiple discovered upload tokens.
- Event-token selection.
- Token-info or helper-version polling.
- Website-controlled deadlines or upload gates.
- Prize configuration or prize delivery.
- MCP prize actions.
- Twitch bot functionality.
- Tauri.
- A localhost helper server.

## Source Projects

Use the current working trees as references:

| Concern | Source |
|---|---|
| Watch, debounce, polling, lifecycle | `../tilxtilt-helper-app/src/lib/collector.mjs` |
| Existing Tilt decode and payload | `../tilxtilt-helper-app/src/lib/pipeline.mjs` |
| Flexible CSV aliases and diagnostics | `../tiltxtilt/src/lib/csvParser.ts` |
| Scoring rule definitions | `../tiltxtilt/src/lib/event-types.ts` |
| Website normalization and aggregation | `../tiltxtilt/src/lib/uploads.server.ts` and the latest `recompute_event_standings` migration |
| Payload normalization and CSV export | `../MoS-stats/src/core/normalize.js`, `payload.js`, and `export.js` |

Do not copy the website database or Supabase dependency into the app. Translate
the required parsing and scoring into deterministic local modules.

## Required Input Samples

Before completing each event parser, obtain representative live output files
for:

- Battle Royale;
- Race;
- Tilt.

Multiple files per event type are expected and supported.

For each file/profile, record:

- exact filename or safe filename pattern;
- encoding and line endings;
- header/settings rows;
- columns and aliases;
- whether the game edits or replaces the file;
- how a complete write is detected;
- whether the file is one round or cumulative;
- round/race/level identifiers;
- reset/truncation behavior;
- fields required for its leaderboard rule.

Each supported source format gets a sanitized fixture and parser test. The UI
can allow the host to add or adjust source profiles when a game version uses a
different but similar filename or column label.

## Local Event Configuration

Each My Stats event stores:

- event ID and name;
- type: Battle Royale, Race, or Tilt;
- status: draft, live, stopped, archived;
- save folder;
- one or more watched filenames/file patterns;
- parser/source profile;
- scoring rule;
- ordered tie-break rules;
- expected round count or open-ended mode;
- participant identity rule;
- duplicate handling;
- output folder;
- HTML/CSV output preferences;
- optional website upload settings;
- parser, payload, and scoring-rules versions.

## File Watch Engine

- Default Windows save root:
  `%LOCALAPPDATA%\MarblesOnStream\Saved\SaveGames`.
- Provide a folder picker and persist overrides.
- Watch the directory so file replacement/rename is detected.
- Watch all exact files/patterns configured for the selected event profile.
- Ignore unrelated files.
- Preserve the working helper behavior:
  - native `fs.watch`;
  - 3-second modification-time polling fallback;
  - 250 ms debounce;
  - boot scan;
  - modification-time and content-hash deduplication;
  - one in-flight ingest per source;
  - one coalesced pending change;
  - idempotent start/stop.
- Before parsing, require stable size and modification time across short reads.
- Retry a bounded number of times when the game still has the file open or is
  actively writing it.
- A missing folder/file is a visible **Waiting** state, not a crash.
- Manual **Process now** can re-read an unchanged file, subject to result-level
  duplicate rules.
- The service remains active when the user navigates to another pane.
- Electron quit stops every watcher/timer cleanly.

## Shared CSV Parser

Port the flexible Tilt x Tilt-style parser locally:

- UTF-8, UTF-16LE, and UTF-16BE BOM handling.
- CRLF/LF support.
- Quoted values and escaped quotes.
- Normalized header matching that ignores case, spaces, underscores, hyphens,
  periods, and slashes.
- Parse diagnostics:
  - detected columns;
  - mapped columns;
  - unmapped columns;
  - total/parsed rows;
  - skipped rows and reasons;
  - detected scoring fields;
  - missing fields required by the chosen rule.

Canonical normalized fields:

```text
username
display_name
rank
points_earned_per_run
points_earned_per_level
time_on_board
completion_time
elapsed_time
finished
eliminated
last_level_reached
levels_finished
total_expertise
marbles_finished
map
mission
external_run_id
top_tiltee
```

Retain unknown original columns in raw result evidence.

Participant identity should prefer a stable Twitch/login username, normalized
case-insensitively. Keep the display name separately. Do not silently merge
ambiguous identities.

## Event-Type Parsers

Implement a parser adapter registry. Each adapter defines:

```text
matched filenames/patterns
required and optional columns
settings/header extraction
round/run identity
completion checks
normalized row mapping
default scoring rule
eligible tie-break fields
payload construction
```

### Battle Royale

Use verified live columns such as:

- placement/rank;
- survived/finished/eliminated;
- survival/completion time;
- points;
- round identity.

Do not infer the winner from file row order.

### Race

Use verified live columns such as:

- placement/rank;
- finish/DNF state;
- completion time;
- points;
- map/race/heat identity.

DNF and missing-time behavior must be explicit in the event rules.

### Tilt

Port the existing fields and flexible aliases:

- points per run/level;
- time on board;
- last level;
- finished state;
- top tiltee;
- run/level identity.

## Result Ledger and Duplicate Rules

Every stable file snapshot becomes an immutable result record:

- result ID;
- event ID;
- source filename/path;
- source content hash;
- captured timestamp;
- parser/source-profile version;
- detected round/race/level identity;
- normalized participant rows;
- parse diagnostics;
- canonical JSON payload;
- accepted, ignored, duplicate, or voided state.

The ledger, not the HTML file, is authoritative.

Required behavior:

- exact content hashes do not count twice;
- repeated watcher events create one result;
- different files for the same round are resolved by the configured source
  profile and replacement rules;
- duplicate observations remain visible for audit;
- results can be voided/unvoided;
- standings are recomputed deterministically from accepted results;
- restart reproduces the same standings from stored records.

## Local Leaderboard Engine

Support transparent simple rules backed by available columns:

- sum points across accepted results;
- best placement;
- placement-points table, then sum;
- fastest eligible completion;
- best level reached;
- most levels finished;
- survival/checkpoint result;
- manual score adjustments with an audit record.

The host selects one primary rule and ordered tie-breaks.

Requirements:

- add numeric values, never formatted display strings;
- show all counted rounds and intermediate totals;
- support open-ended or fixed-round events;
- optionally support best-N/drop-lowest only when configured;
- resolve identities consistently across files;
- keep unresolved ties as ties;
- never use alphabetical order as an invisible scoring tie-break;
- block a rule when its required columns are missing;
- persist the scoring-rules version with the event and each standings snapshot.

The local implementation should reproduce relevant Tilt x Tilt website
aggregation using golden fixtures. It must not require database RPC calls.

## Canonical JSON Payload

Preserve the useful helper payload structure:

- `source_file_name`;
- uploader fields when available;
- `parse_report`;
- `settings`;
- `runs`;
- nested `levels`;
- nested `viewers`;
- `raw`.

For multi-file/multi-round events, also generate a versioned event snapshot:

```json
{
  "schema_version": 1,
  "event": {},
  "results": [],
  "standings": [],
  "generated_at": ""
}
```

Write result payloads and the current event snapshot before optional upload.

## Local HTML and CSV

Default storage:

```text
<app.getPath("userData")>/my-stats-helper/events/<event-id>/
```

Layout:

```text
event.json
results/<result-id>.json
standings.json
publish/latest.html
publish/standings.csv
publish/raw-results.csv
outbox.json
upload-history.json
```

### HTML

Regenerate a self-contained `latest.html` after each accepted result:

- event name, type, and status;
- last updated time;
- scoring and tie-break description;
- podium and full leaderboard;
- participant totals;
- counted rounds/races/levels;
- score breakdown;
- parse warnings;
- source/result summary.

The HTML must:

- work directly from disk;
- use no remote scripts, styles, fonts, or assets;
- escape all source-controlled values;
- remain usable for large leaderboards that should not all be displayed inside
  the Electron pane.

### CSV

Generate:

- `standings.csv`: one participant per row with rank, score, tie-break values,
  counted results, and eligibility;
- `raw-results.csv`: flattened normalized rows with source/result/round IDs.

Use:

- stable headers;
- correct comma/quote/newline escaping;
- UTF-8;
- spreadsheet formula-injection protection for cells beginning with
  `=`, `+`, `-`, or `@`.

All mutable files use atomic temporary-write plus rename.

## Optional Website Upload and Token Authentication

Local parsing/output always works without a website.

### Website settings

- **Upload to website** toggle, default off.
- Website base URL or exact upload endpoint.
- Authentication token.
- Token transport:
  - bearer token: `Authorization: Bearer <token>`;
  - configurable API token header if the website contract requires one.
- Optional validated static headers.
- Request timeout.
- Upload content:
  - individual parsed result payload;
  - current event/standings snapshot;
  - or both.
- **Test connection**.
- Save, replace, and clear token actions.

This is one configured website/token profile. There are:

- no invites;
- no website event discovery;
- no remote token discovery;
- no token selection list;
- no helper-version polling;
- no pairing.

The token authenticates direct requests to the configured website.

### Token security

- Store the token separately from renderer-visible settings.
- Use Electron `safeStorage` when available.
- If protected storage is unavailable, clearly report the fallback rather than
  silently saving plaintext.
- Renderer status exposes only:
  - `hasToken`;
  - optional last-four suffix.
- Never include the token in logs, HTML/CSV, diagnostics, errors, or exported
  configuration.
- Never accept credentials embedded in the URL.

### Upload behavior

- POST JSON with `Content-Type: application/json`.
- Add the configured token header.
- Apply a timeout with `AbortController`.
- Treat non-2xx responses as failures.
- Cap and sanitize response/error bodies.
- Local result/leaderboard success never depends on upload success.
- Version and document the request body.

Suggested envelope:

```json
{
  "schema_version": 1,
  "kind": "result|standings",
  "event": {},
  "payload": {}
}
```

### Durable retry queue

- Queue a failed upload after local persistence succeeds.
- Key queue items by event ID, payload/result ID, body hash, and upload-profile
  ID.
- Never send queued data to a different website after settings change.
- Deduplicate identical queued requests.
- Retain attempts, timestamps, and sanitized errors.
- Retry:
  - when the helper starts;
  - after a successful connection test;
  - on explicit **Retry uploads**.
- Process sequentially.
- Remove successes and preserve failures.
- Serialize queue mutations so a concurrent file result cannot be lost.
- Retain the last 200 upload-history records.

## App Pane

Add a new main navigation item named **My Stats Helper**. Do not replace the
existing Stats analytics page.

### Events

- create, duplicate, select, stop, and archive local events;
- choose BR, Race, or Tilt;
- configure source files/profile;
- choose scoring/tie-break rules;
- set fixed or open-ended rounds;
- configure output;
- configure optional website upload/token.

### Live

- helper enabled/running/waiting/stopped;
- watched folder and files;
- native+poll or polling-only status;
- detected columns;
- last result and parse warnings;
- round/result count;
- compact leading standings;
- Process now;
- Open full HTML leaderboard.

### Results

- accepted/ignored/duplicate/voided result ledger;
- parsed row preview;
- scoring breakdown;
- identity warnings;
- recompute standings;
- void/unvoid;
- HTML and CSV output actions.

### Upload

- enabled/disabled state;
- website URL/endpoint;
- token-present status;
- Test connection;
- last upload;
- queue and retry;
- sanitized errors/history.

### Activity

- bounded structured logs;
- parser diagnostics;
- file events;
- redacted support bundle.

## Architecture

```text
MyStatsHelperPage
  ↕ narrow preload IPC
Electron main
  ├─ EventController
  ├─ MultiFileCollector
  ├─ ParserRegistry
  │   ├─ BattleRoyaleParser
  │   ├─ RaceParser
  │   └─ TiltParser
  ├─ ResultLedger
  ├─ LeaderboardEngine
  ├─ HtmlCsvPublisher
  ├─ WebsiteUploader
  ├─ AtomicStore
  └─ StructuredLogger
```

- Filesystem, credentials, network, and parsing run in Electron main.
- Renderer receives sanitized DTOs.
- Expose explicit validated IPC only.
- Do not expose raw filesystem, fetch, token, or generic IPC access.
- Keep the service independent of the mission backend.
- Use isolated CommonJS modules under `electron/my-stats-helper/`.

## Planned Files

```text
electron/my-stats-helper/controller.js
electron/my-stats-helper/source-profiles.js
electron/my-stats-helper/collector.js
electron/my-stats-helper/csv.js
electron/my-stats-helper/parsers/battle-royale.js
electron/my-stats-helper/parsers/race.js
electron/my-stats-helper/parsers/tilt.js
electron/my-stats-helper/payload.js
electron/my-stats-helper/result-ledger.js
electron/my-stats-helper/leaderboard.js
electron/my-stats-helper/publisher.js
electron/my-stats-helper/uploader.js
electron/my-stats-helper/store.js
electron/my-stats-helper/logger.js
renderer/src/pages/MyStatsHelperPage.jsx
renderer/src/components/my-stats-helper/*
```

Integration edits:

- `electron/main.js`: create singleton, register IPC, restore enabled events,
  stop during quit, publish sanitized status/log events.
- `electron/preload.js`: expose narrow methods/subscriptions.
- `renderer/src/components/nav/app.jsx`: add navigation.
- `renderer/src/pages/ControlPage.jsx`: mount the page.
- `package.json`: add test scripts if needed; `electron/**/*` is already in the
  packaged file list.
- `README.md`: supported files, rules, outputs, token setup, and troubleshooting.

## Implementation Order

### Phase 1 — Live-file fixtures

Collect representative BR, Race, and Tilt files, including every file used by
each event type. Record filenames, columns, write behavior, and round boundaries.

### Phase 2 — Parser parity

Port the flexible website parser, build three verified adapters, and compare
normalized rows/payloads against golden fixtures.

### Phase 3 — Local event engine

Implement event configuration, immutable result ledger, duplicate rules,
identity normalization, aggregation, ties, and deterministic recomputation.

### Phase 4 — HTML/CSV publishing

Implement canonical event snapshots, full self-contained leaderboard HTML, and
standings/raw CSV exports.

### Phase 5 — Watch service

Implement multiple watched files/patterns, stable reads, native watch plus poll,
background lifecycle, persistent enabled state, and quit cleanup.

### Phase 6 — Website token upload

Implement secure token storage, direct authenticated POST, versioned request
envelope, timeout/error handling, durable queue, destination pinning, and retry.

### Phase 7 — Pane and packaging

Build Events, Live, Results, Upload, and Activity views. Package and test on a
clean Windows profile with real Marbles write behavior.

## Acceptance Criteria

### Files and parsing

1. Verified BR, Race, and Tilt profiles support all required live files.
2. Multiple files for one event type are watched correctly.
3. In-place and atomic-replace writes are detected.
4. Partially written files are not scored.
5. UTF encodings, quoted fields, aliases, and diagnostics work.
6. Missing required scoring columns block the affected rule clearly.
7. Duplicate watcher events create one logical result.

### Local standings

8. Points and other configured values accumulate across accepted results.
9. BR, Race, and Tilt golden fixtures produce expected standings.
10. Identities remain stable across case/display-name changes.
11. Ambiguous identities are not silently merged.
12. Ties follow configured rules and remain tied when unresolved.
13. Void/unvoid and restart produce deterministic recomputation.

### Output

14. JSON is canonical and persisted before upload.
15. HTML works offline and shows the complete leaderboard.
16. Standings and raw CSVs are escaped, formula-safe, and complete.
17. Each accepted result updates local outputs with upload disabled.

### Website authentication/upload

18. Upload-off makes no network request.
19. A configured website token authenticates the direct upload.
20. No invitations, discovery, pairing, or token-list flow exists.
21. The full token never enters ordinary renderer state, logs, or output files.
22. Upload failure does not affect local parsing/leaderboards.
23. Failed requests queue and survive restart.
24. Queued requests cannot move to a changed website profile.
25. Retry removes successes without losing failures or concurrent additions.

### App/release

26. The helper remains active across renderer navigation.
27. It is independent of mission-backend start/stop.
28. Repeated enable/disable leaks no watchers or timers.
29. Electron quits cleanly.
30. Existing panes and mission workflows still work.
31. The packaged Windows app needs no sibling repo, `.env`, website, database,
    or external Node for local events.

## Definition of Complete

The feature is complete when a user can:

1. Create a local BR, Race, or Tilt event.
2. Point it at the required live result file(s).
3. Start tracking.
4. See results accumulate into a correct local leaderboard.
5. Open the complete local HTML or CSV.
6. Optionally configure a website URL and authentication token.
7. Upload the same locally generated results without any invite, discovery, or
   pairing workflow.
