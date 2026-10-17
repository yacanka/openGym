# Supabase implementation ledger

Approved scope: static Render frontend; Supabase Auth (Google and email/password),
Postgres with RLS, admin/invites/presence, persistent scheduled Web Push. Web/PWA
only; native and demo remain local. Existing files are retained. The hosted
Supabase project and production static hosting are live. The owner completed
Google sign-in; production SMTP and remaining device acceptance checks are pending.

## Work packages

- [x] Schema, atomic state writes, session/role gates, SQL acceptance tests.
- [x] Auth callbacks, signup/login/recovery and account settings.
- [x] Account-isolated local persistence, conflict resolution and offline retry.
- [x] Admin, invites, presence, Web Push, durable scheduling and dispatch.
- [x] Static media build, Render configuration, deployment documentation.
- [x] Tests, build, independent review and limitation report.

## Decisions and evidence

- Work in the existing checkout on `codex/supabase-static`; retain existing
  Finder metadata modifications. No source/data deletion or history rewriting.
- Keep the current JSON state format and device-local active workout. Use one
  versioned JSONB state per user instead of remodeling workout domain entities.
- Docker CLI is present but its daemon is unavailable at baseline. Database
  verification will use a local PostgreSQL runtime if available; hosted-provider
  acceptance checks require account setup and must be reported separately.

## Verification evidence

- Original baseline: 192 Vitest tests passed before implementation.
- Final frontend suite: 213 Vitest tests passed, including native local/custom
  exercise preservation, stale-tab conflicts, lost-response retries, rejected
  state repair, account isolation, callback cleanup, timeouts and push binding.
- Chromium: four account/guest/Google-PKCE contract tests passed. Hosted services
  are replaced only at the network boundary; this is not a real Google login.
- Deno: three Edge entrypoints type checked; eight tests passed, including real
  Web Push encryption with runtime-generated keys and a simulated outbound HTTP
  boundary (no private key material printed).
- Real temporary PostgreSQL 14: fresh core/operations/notification migrations,
  RLS/RPC/admin/disable/revocation/invite/presence/reminder assertions passed.
  Two independent connections prove first-write CAS and single-use invite races.
  Scheduler function SQL passed with local Vault/HTTP/Cron adapters; installing
  the managed extensions themselves remains a hosted/local-Supabase smoke test.
- Static, mobile and demo builds passed without Supabase configuration for the
  local-only variants. Static output contains 1,324 JPG and 1,324 GIF files, with
  no data/, environment files or legacy API. The media allowlist test passed.
- Production dependency audit: zero known vulnerabilities. Existing large
  instruction/bundle warning remains; no unrelated bundle refactor performed.

- Full dependency audit also reports 19 pre-existing development/native-tool
  findings (5 moderate, 10 high, 4 critical). Auditing the original HEAD lockfile
  produces exactly the same counts and package names; no new finding was added.
  These need separate toolchain maintenance and do not affect the production
  dependency audit result above.

## Independent review

Four findings were reproduced with failing regression tests and fixed:

1. Push binding lifecycle: remove direct signed-in relogin, detach for local and
   global logout, reconcile bindings on account transition, verify the current
   session before showing notifications as enabled.
2. Definitive validation failures: retain the failed snapshot as a backup but
   permit valid replacement data; ambiguous network errors retain mutation ids.
3. Cross-tab provenance: never combine stale displayed data with a newer shared
   version. Both snapshots survive an explicit local/other-tab conflict choice.
4. Fourth notification retry: another worker cannot invalidate an unexpired
   final-attempt lease. The SQL regression failed before the fix and passed after.

## Hosted deployment evidence

User-selected organization **YaCanKa**, Frankfurt (`eu-central-1`), Free plan;
project creation quoted **$0/month**. Project reference: `esbsmagmcmlkpxmnztwp`.
[Project dashboard](https://supabase.com/dashboard/project/esbsmagmcmlkpxmnztwp).

- All five migrations applied successfully. Local initial migration filenames
  were aligned with the versions actually assigned by the MCP deployment, so
  future CLI deployments see the same history instead of reapplying the schema.
- Real pg_cron 1.6.4, pg_net 0.20.4 and supabase_vault 0.3.1 are installed.
  The 1-second dispatcher, 10-second reminder producer and hourly housekeeping
  are active; zero failed Cron runs at verification.
- `admin`, `push` and `notification-dispatch` deployed and report ACTIVE.
- Hosted transactional core, admin and notification SQL suites passed with all
  fixtures rolled back. No accounts or workout data were left behind.
- Actual Data API requests with the modern publishable key return no anonymous
  rows and reject anonymous writes (401). Deployed admin/push functions reject
  unauthenticated callers (401).
- Gitignored frontend config points at the real project using only its URL and
  modern publishable key. Both local configuration files have mode 0600.
- Auth site URL is the Render HTTPS origin. Exact root/recovery redirects are
  allowed for Render and localhost port 5173; public signup and email
  confirmation remain enabled. Minimum password length is 8.
- The user installed all five function settings and the Vault dispatch secret.
  Stored SHA-256 digests match the protected local configuration for every
  setting; Vault and Edge use the same dispatch secret. Values were not printed.
  An authenticated live dispatcher call returns HTTP 200 with zero pending jobs.
  This verifies handler authentication and its service-role database access,
  not delivery to a real push subscription.
- New foreign-key indexes removed both missing-index notices. Remaining
  performance notices are unused new indexes on an empty database.
- Security advisor flags 16 intentionally authenticated SECURITY DEFINER RPCs.
  These are narrow application APIs with explicit execute grants, fixed empty
  search paths and live-session/account/admin checks, needed to keep private
  authorization tables inaccessible. Anonymous execute is revoked. Do not
  silence the warnings by removing these gates or granting private table access.
  [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
- Re-ran 213 frontend tests, static production build with the real project config,
  fresh PostgreSQL migration/concurrency/scheduler tests, and production audit
  (zero known vulnerabilities) after hosted deployment alignment.

## External setup still required

The user has no SMTP service or owned DNS domain yet. Render Static Site
`srv-db9vnp6q1p3s739p72e0` is LIVE at
[`opengym-6ci9.onrender.com`](https://opengym-6ci9.onrender.com), serving commit
`a27d4ee`. The first deployment's npm lock issue was corrected and redeployed;
the dashboard confirms "Deploy succeeded|Live".
The user signed into Render. Source commit `73ef928` is pushed on
`codex/supabase-static`; `main` remains at the original base. Only implementation
files were committed; local configuration, data and pre-existing Finder changes
were excluded. Render Blueprint `exs-db9vngmq1p3s739p65jg` has started creating the
static site with the versioned build, publish, headers and rewrite settings.
Its first build failed before compilation: npm 10 found missing optional peer
records in the lockfile generated with npm 11. The exact failure was reproduced
in a fresh directory using npm 10. Regenerating the lock with npm 10 added only
`@emnapi/core` and `@emnapi/runtime`, with no existing package version changes;
both dry-run and actual clean npm 10 installation now pass. After that clean
install, all 213 frontend tests, four browser contract tests and static build
passed again. Hosted npm installation, Vite build and upload then succeeded.

Production smoke checks passed for index/security headers, real JPG/GIF assets,
service worker, bundled Supabase project configuration, and private file/API
paths returning only the SPA shell. The public JS contains none of the generated
server private values. Supabase's site URL and exact root/recovery redirects now
include the Render HTTPS origin; both local and production origins pass Edge
Function CORS preflight checks. The owner completed the real Google consent/return
flow on Render and confirmed reaching the app. Aggregate database checks confirm
one Google identity, its profile and a confirmed live session; personal identity
and workout details were excluded from verification output.
The owner explicitly nominated that account as the initial administrator. A
one-time SQL operation selected its UUID only after checking that the selection
was unambiguous; exactly one admin account and the app's Admin dashboard entry
were verified. The live dashboard then loaded its one-user list successfully.
New signups still receive the ordinary user role.
Manual Sync now on the unchanged empty account completed without an error;
no state row is created until a change needs uploading. This is not evidence of
a real-device cloud write yet. The owner approved a real Web Push test and
allowed browser notifications. The in-app browser's subscription was rejected
by the Edge provider allowlist with "Unsupported push service"; no subscription
or test job was stored. Do not weaken the SSRF allowlist to accept an unidentified
provider. A Chrome/Safari/Firefox sign-in, genuine state change and push test
have been handed to the owner for actual browser/device acceptance.
The owner subsequently tested on Mac/Chrome: after resolving the initial browser
permission error, one valid FCM subscription and four test jobs were recorded.
All four jobs completed on their first attempt, each with a receipt linked to
the still-valid subscription (the dispatch path records this for a 2xx provider
response). This proves provider acceptance, not display on the Mac; the owner
reports no visible notification. The owner confirmed macOS Chrome notification
permission is on and Do Not Disturb is off. Native settings inspection and direct
Chrome control are unavailable; only the in-app browser is connected. Chrome's
GCM connection state and decryption failure log were requested to distinguish
transport from browser-side processing. The Deno test now independently decrypts
the outgoing RFC 8291 payload using Web Crypto, including Unicode content, and
rejects tampering and an incorrect authentication secret. All eight Edge tests
pass. This fixture check does not prove receipt on the owner's Chrome. A real cloud state row at
version 1 is now present and contains no device-local active workout field.
The owner's Chrome GCM diagnostic reports CONNECTED, no decryption failure and
a received data message. The subsequent worker console exposed a separate fetch
cache race: `Response.clone()` ran after the page consumed the body while
`caches.open()` was pending. A delayed-cache test reproduced the failure before
the fix. The worker now clones before returning the response and registers the
cache write with `waitUntil()` synchronously; a storage failure logs only its
error name and does not replace a good network response. Delayed writes, quota
failure and offline fallback are covered; all 216 frontend tests and the static
build pass. Render deployed worker fix `3c84136` successfully; the live HTTP 200
`sw.js` exactly matches the fixed source and is served with `Cache-Control:
no-cache`. The owner was asked to update the worker and repeat the console and
visible notification checks. Fixing this cache error does not by itself
establish the notification display failure's cause.
No paid service was enabled. A custom app domain is not required for Render hosting; a
managed sender such as Resend separately requires a verified sending domain.
Email confirmation and public signup remain enabled. The user clarified that
no SMTP service is available yet; custom SMTP is disabled. A managed sender
service can provide SMTP without running an application or mail server.
Versioned confirmation/recovery HTML and local template config are prepared;
the HTML callback contract checks and four callback tests pass. Managed email
sender setup and hosted template installation, visible desktop/mobile push
delivery and email end-to-end checks
remain required before production readiness. Do not send secrets in chat; use
provider dashboards and managed secret stores. Source implementation and hosted
schema/functions are ready; the full production acceptance checklist is not yet
complete.
