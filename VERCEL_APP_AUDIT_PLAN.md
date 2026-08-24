# Vercel App Migration Audit and Plan

## Decision

This can be hosted on Vercel as a **web app**, but it is not a lift-and-shift
deployment. The repository is currently an Electron desktop application with a
long-running Node worker. A safe first Vercel version should be a per-user,
wallet-connected dashboard with explicit actions. It should **not** import or
retain user private keys, and it should **not** run the existing continuous
mission watcher on Vercel.

For a fun/private test, the recommended target is:

```text
Browser (React UI + Phantom/Solflare) ── HTTPS ──> Vercel API routes
                                                   ├─ OAuth/MCP proxy
                                                   ├─ Postgres (per-user settings, OAuth tokens, audit)
                                                   └─ Redis (rate limits, locks, short-lived state)
                                                           │
                                                           └─ Pixel by Pixel MCP + its signing bridge
```

The desktop app remains the appropriate product for unattended automation with
an app-managed burner wallet. Vercel is appropriate for the UI, user-initiated
checks, and browser-wallet signing.

## Current-state findings

| Area | What the repository does now | Vercel consequence |
| --- | --- | --- |
| UI/runtime | Vite React renderer runs inside Electron; Electron owns the backend and IPC bridge. | Replace Electron IPC with authenticated HTTP API routes or direct browser calls where safe. |
| Backend lifecycle | `electron/main.js` forks `app.js`; `app.js` starts a persistent watcher and timers. | Serverless functions can be recycled and end at a configured duration. Do not depend on process memory, timers, or a forked child process. |
| Persistence | `config.json`, analytics, caches, cooldowns, logs, and token files are read/written under local user directories. | Move durable state to a database/object storage; use Redis for transient locks/rate limits. Never treat function disk or memory as storage. |
| OAuth | `lib/mcp.js` opens a browser and binds an ephemeral `127.0.0.1` callback server, then saves refresh tokens locally. | Replace with a public HTTPS callback route and a per-user web session. Confirm the PbP OAuth/dynamic-client flow accepts the Vercel callback before building. |
| App wallet | `src/signer.js` encrypts a software wallet vault and relies on macOS Keychain, Windows DPAPI, or Linux Secret Service. | This model cannot safely transfer to Vercel: there is no user OS keychain, and storing/importing private keys on a shared web service creates custodial-key risk. |
| Reset/transaction signing | The app validates a prepared transaction, signs it with the app wallet, and submits it; `dapp` mode opens the PbP signing bridge. | Use a connected browser wallet and the PbP signing bridge. The browser signs; the server must never receive seed phrases or raw private keys. |
| Rate limits | The MCP client enforces in-memory per-tool windows and cooldowns. | Enforce them atomically in Redis keyed by PbP user/wallet + tool, so concurrent function instances cannot exceed limits. |
| Security | A telemetry token is present in `config.sample.json` and in `electron/main.js`. Debug paths can write raw MCP payloads to disk. | Treat the committed token as exposed: rotate/revoke it, move replacement secrets to deployment environment variables, and do not port raw-payload logging. |

Relevant implementation locations: `electron/main.js`, `app.js`, `src/context.js`,
`src/config.js`, `src/mcp/client.js`, `lib/mcp.js`, `src/signer.js`,
`src/signer-prepare.js`, and `src/services/watch.js`.

## Wallet and cooldown-reset recommendation

### Recommended: non-custodial browser wallet

1. The user connects a burner wallet in Phantom, Solflare, or another supported
   browser wallet. The app only receives the public address and connection
   state.
2. The UI asks the authenticated backend to call PbP's
   `prepare_nft_cooldown_reset` tool. The backend verifies the returned wallet,
   NFT ID, cost cap, replay token, and transaction fields. It must also
   allowlist the expected Solana program IDs, instruction semantics, accounts,
   and value movements; decoding/presence checks alone are not a sufficient
   hosted signing boundary.
3. The UI hands the prepared transaction to the wallet/signing bridge. The
   wallet extension displays and signs it locally.
4. The signed transaction and the short-lived PbP reset token are sent to a
   backend submit route. The backend verifies ownership, consumes a one-time
   action record, calls `submit_signed_nft_cooldown_reset`, and writes an audit
   event.
5. Display the MCP result and refresh the user snapshot.

This preserves the useful existing prepare/validate/submit boundary without
turning the deployment into a wallet custodian. The existing `dapp` path already
shows the intended product behavior: PbP provides a signing URL, and the user
completes signing in a wallet-enabled browser.

### Do not use for the web version

- Do not ask users to paste a seed phrase/private key into the website.
- Do not put a shared `PBP_BEARER_TOKEN`, wallet key, or a customer refresh
  token in `NEXT_PUBLIC_*` variables or browser storage.
- Do not use one Vercel environment wallet to execute actions for multiple
  users. It breaks wallet identity, creates custody liability, and makes cost
  attribution/auditing unsafe.
- Do not silently auto-reset. Each reset is a cost-bearing transaction and
  needs a visible confirmation with wallet, NFT, amount, and network details.

### Unresolved compatibility check (must be proven first)

The current code does not sign a transaction in a browser wallet directly; it
opens a PbP-provided signing bridge. Before committing to the build, use a
burner account to establish all of the following:

- whether the bridge supports the desired browser wallets and returns control
  to the Vercel app after signing;
- whether the prepared payload can be submitted by the app after wallet signing
  (and which exact signed payload format is required);
- whether the signer address embedded in the prepared transaction equals the
  connected wallet address; and
- the expiry, single-use semantics, and retry behavior of reset tokens.

If the bridge cannot return a signed payload to the web app, the fallback is a
clear **"Open PbP to sign"** action and a manual refresh/poll of the resulting
state. That is a valid first release and is much safer than inventing a custody
wallet service.

## Proposed web architecture

### Frontend

- Reuse the renderer's visual components and domain formatting, but remove
  Electron window controls, `window.desktopBridge`, preload calls, and desktop
  update/CSV/file APIs.
- Convert each backend bridge action into a typed HTTPS endpoint. Keep tokens
  and MCP calls off the client unless PbP explicitly supports the browser flow
  with appropriate CORS and OAuth controls.
- Add connected-wallet state, per-action confirmation screens, pending/failed
  transaction recovery, and a limited activity/audit view.

### API and authentication

- Implement PbP OAuth Authorization Code + PKCE with a stable public callback
  such as `/api/pbp/oauth/callback`; validate state and PKCE verifier server
  side. Do not retain the desktop localhost callback model.
- Create an app session after PbP authentication. Store the PbP access/refresh
  tokens encrypted at rest in a per-user database record; expose only an opaque
  secure, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie to the browser.
- Make each MCP API call execute in the authenticated user's token context;
  refresh tokens only inside the server route/worker.
- Use CSRF protection for cookie-authenticated mutating routes, strict request
  schemas, origin checks, per-user authorization, and structured/redacted logs.

### Data stores

- **Postgres**: users, encrypted OAuth credentials, app settings, mission/NFT
  snapshots, action records, and audit entries.
- **Redis**: PKCE state, one-time prepared-action tokens, distributed locks,
  idempotency keys, rate-limit counters, and short-lived cached MCP responses.
- **Object storage (optional)**: user-requested exports only; use signed URLs
  and expiration. Do not store logs containing bearer tokens or transactions by
  default.

### API surface for the first release

| Route group | Purpose | Mutating? |
| --- | --- | --- |
| `/api/pbp/oauth/*` | Start/complete OAuth and logout | Yes |
| `/api/me`, `/api/snapshot` | Session/user summary, missions/NFTs | No |
| `/api/missions/*`, `/api/nfts/*` | Explicit refresh, catalog, rental preview | Some cache updates |
| `/api/actions/reset/prepare` | Validate user selection, request and persist short-lived prepared action | Yes |
| `/api/actions/reset/submit` | Verify one-time action + signed payload, submit to PbP, audit result | Yes |
| `/api/actions/*` | Same pattern for reroll, swap, and slot unlock | Yes |

Every mutating route needs an idempotency key and a durable action state
(`prepared`, `signing`, `submitted`, `succeeded`, `failed`, `expired`). A retry
must return the prior result rather than charge/reset twice.

## What does not fit Vercel alone

The existing watcher is intentionally continuous and runs mission cycles,
delays, auto-claims, and reset/assignment work. Vercel Functions have a maximum
invocation duration, can be recycled, and do not provide a reliable forever
process. Vercel also advises keeping shared state outside instance memory.
[Function duration docs](https://vercel.com/docs/functions/configuring-functions/duration)
and [Fluid Compute guidance](https://vercel.com/kb/guide/vercel-services-fluid-compute)
describe these constraints.

Vercel Cron is also not a replacement for this loop. On Hobby it can run only
once per day; on paid plans its minimum schedule is once per minute and Vercel
does not retry failed invocations. That is incompatible with the app's
sub-minute/continuous behavior and MCP rate-sensitive coordination.
[Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and
[Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Choose one of these explicitly:

1. **Recommended test scope:** no background automation. Provide "refresh now",
   manual claim, and manual browser-wallet reset actions only.
2. **Later production scope:** Vercel hosts the UI/API; a separate durable
   worker platform runs one queue-backed, per-user job at a time. It must use
   Postgres/Redis leases, checkpoints, cancellation, backoff, idempotency, and
   the same no-custody wallet policy. A user must explicitly enable it.
3. **Not recommended:** emulate the watcher with long-running Vercel requests
   or in-memory intervals. It will duplicate work or stop unexpectedly.

## Delivery plan

### Phase 0 — discovery and guardrails (no public launch)

- Confirm PbP OAuth supports a Vercel HTTPS callback and document the exact
  redirect URI/client registration policy.
- Run the browser-wallet/reset compatibility check above with a funded burner
  wallet and an expendable NFT.
- Rotate the exposed analytics token and audit the git history/deployment
  environment for other credentials. Define a secret-rotation procedure.
- Decide whether this is a private single-user experiment or a multi-user app;
  the latter needs a privacy policy, abuse controls, support, and clear
  transaction-risk disclosures.
- Write acceptance cases for authorization, transaction validation, duplicate
  submission, expiration, rate limits, and recovery after a function restart.

**Exit:** a written PbP flow proof and no known production secret committed to
the repository.

### Phase 1 — read-only Vercel app

- Add a web framework/runtime and Vercel project configuration.
- Extract pure mission/NFT normalization and presentation logic from desktop
  dependencies; preserve the Electron build separately.
- Build OAuth/session storage, MCP proxy, database schema, Redis controls, and
  read-only dashboard routes.
- Add observability with redaction, request IDs, alerting for MCP failures, and
  security headers/CSP.

**Exit:** a logged-in user can view only their mission/NFT/account data after
multiple cold starts and concurrent browser tabs without credential leakage or
rate-limit violations.

### Phase 2 — explicit non-custodial actions

- Implement a generic persisted prepared-action workflow, starting with NFT
  cooldown reset.
- Require wallet-address match, server-side decoded-transaction checks, cost
  caps, strict expected program/instruction/account allowlists, action expiry,
  one-time submission, idempotency, and an approval UI. A signer mismatch must
  be a hard failure, never a warning that permits signing.
- Add reroll/swap/slot unlock only after the reset workflow has real burner
  wallet test coverage.
- Provide a manual PbP signing-bridge fallback for any wallet integration
  failure; never fall back to a server-held key.

**Exit:** the reset has end-to-end tests plus a real burner test showing exactly
one correct PbP action under success, double-click, expired-token, and timeout
conditions.

### Phase 3 — optional automation worker

- Only if required, introduce the external worker/queue architecture rather
  than scheduling a Vercel loop.
- Start with non-transactional refresh/notification jobs. Keep transaction
  execution user-initiated unless PbP supports a delegated, revocable signing
  authorization designed for automation.
- Add kill switches per user and globally, budget limits, webhook/notification
  observability, and operational runbooks.

**Exit:** deterministic recovery from worker crash/redeploy and a reviewed
threat model for any automation authority.

## Deployment checklist

- Separate Preview and Production OAuth redirect URIs and databases; preview
  deployments must not reach real funded wallets by default.
- Configure server-only environment variables for database/Redis, encryption
  key, session secret, OAuth configuration, `CRON_SECRET` (only if cron is
  used), and telemetry token. Scope and rotate them.
- Set a deliberate Node runtime, region close to PbP/database, function timeout,
  and deployment protection for the test app.
- Verify MCP CORS, outbound network access, OAuth redirect allowlist, and the
  exact Node version before choosing direct-client versus API-proxy calls.
- Set CSP, HSTS, `frame-ancestors 'none'`, no-store responses for authenticated
  API data, audit-log redaction, and database backups/retention.
- Test with two users, two browser tabs, multiple Vercel instances, expired
  access token, expired prepare token, PbP 429, submit timeout, and user logout.
- Add a clear "burner wallet only / no warranty / transaction cost" notice;
  users must confirm the exact action and cost before signing.

## Estimated scope

The read-only web dashboard is a moderate migration. Secure OAuth, per-user
persistence, non-custodial reset signing, and reliable background automation
are separate projects; the last one should not be bundled into a casual Vercel
experiment. Build Phase 1 first, then decide whether Phase 2's browser signing
experience is good enough to justify continuing.

## Independent review

An independent implementation/security review was completed against the
repository. It agrees that this is a redesign from Electron, not a deployable
web app as-is, and confirms these non-negotiable points:

- The renderer currently depends on `window.missionsDesktop` and Electron's
  broad IPC bridge; it needs a typed HTTPS/SSE adapter.
- The watcher, local OAuth callback, OS secure-storage vault, local files, and
  browser/OS launch calls cannot be carried to Vercel unchanged.
- Browser-wallet signing is the only sensible hosted pilot. The current `dapp`
  behavior merely opens a PbP signing bridge, so a post-sign return/poll flow
  must be verified with PbP.
- Current prepared-transaction validation checks payload shape and signer
  address but does not allowlist transaction programs/instructions/accounts;
  add that validation or use a verified PbP bridge as the signing boundary.
- Treat the existing committed telemetry token as exposed and do not transfer
  raw MCP debug logs or sensitive transaction/authentication values to hosted
  logs or analytics.

The reviewer also confirmed the worktree was already dirty only in
`package.json`; this audit adds only this Markdown plan and does not alter
application code.
