# Supabase implementation ledger

Approved scope: static Render frontend; Supabase Auth (Google and email/password),
Postgres with RLS, admin/invites/presence, persistent scheduled Web Push. Web/PWA
only; native and demo remain local. Existing files are retained. The hosted
Supabase project is now provisioned; production hosting, Google OAuth and SMTP
setup remain separate deployment requirements.

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
- Auth site URL and exact local root/recovery redirects configured for port
  5173; public signup and email confirmation are enabled. Minimum password
  length set to 8. Production URLs await the Render site address.
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

The user has no SMTP service or owned DNS domain yet. Render now contains
Static Site `srv-db9vnp6q1p3s739p72e0`, assigned
`https://opengym-6ci9.onrender.com`.
The user signed into Render. Source commit `73ef928` is pushed on
`codex/supabase-static`; `main` remains at the original base. Only implementation
files were committed; local configuration, data and pre-existing Finder changes
were excluded. Render Blueprint `exs-db9vngmq1p3s739p65jg` has started creating the
static site using the versioned build, publish, headers and rewrite settings.
Its first build failed before compilation: npm 10 found missing optional peer
records in the lockfile generated with npm 11. The exact failure was reproduced
in a fresh directory using npm 10. Regenerating the lock with npm 10 added only
`@emnapi/core` and `@emnapi/runtime`, with no existing package version changes;
both dry-run and actual clean npm 10 installation now pass.
No paid service was enabled. A custom app domain is not required for Render hosting; a
managed sender such as Resend separately requires a verified sending domain.
Google is now enabled in public
Auth settings; an actual PKCE authorization request returns a Google redirect
with the correct Supabase callback. This is not a completed Google user login.
Email confirmation and public signup remain enabled. The user clarified that
no SMTP service is available yet; custom SMTP is disabled. A managed sender
service can provide SMTP without running an application or mail server.
Versioned confirmation/recovery HTML and local template config are prepared;
the HTML callback contract checks and four callback tests pass. Managed email
sender setup and hosted template installation, final HTTPS redirects, initial
verified owner/admin and real desktop/mobile push/email/Google end-to-end checks
remain required before production readiness. Do not send secrets in chat; use
provider dashboards and managed secret stores. Source implementation and hosted
schema/functions are ready; the full production acceptance checklist is not yet
complete.
