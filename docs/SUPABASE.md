# Static openGym with Supabase

The current web/PWA build uses Render Static Site + Supabase Auth, Postgres,
Edge Functions and Cron. It does **not** need the legacy Node API or a database
password in the browser. Native (`VITE_MOBILE=1`) and demo (`VITE_DEMO=1`) builds
remain local and do not require Supabase configuration.

## Current deployment

The initial hosted project has been created in **YaCanKa / Frankfurt** on the
Free plan: [`openGym`](https://supabase.com/dashboard/project/esbsmagmcmlkpxmnztwp),
reference `esbsmagmcmlkpxmnztwp`. Its five migrations and three Edge Functions are
already deployed. See [implementation evidence](SUPABASE_IMPLEMENTATION.md) for
completed checks and remaining account-specific setup. The following sections
also describe how to reproduce the setup in a separate project.

Local `frontend/.env.local` already contains this project's URL and modern public
key. `supabase/.env.local` contains newly generated push/scheduler secrets, uses
owner-only file permissions and is ignored by Git. It currently allows
`http://localhost:5173` and `https://opengym-6ci9.onrender.com`.
All five settings and the Vault dispatch secret have been installed and their
fingerprints verified. The live dispatcher accepts its private scheduler key.
Real push delivery still requires an authenticated browser subscription.
Its VAPID contact URL is the operator's repository. Update it to your preferred
public support URL or mailto address if needed.

The allocated Render site address is
[`opengym-6ci9.onrender.com`](https://opengym-6ci9.onrender.com), deployed from
`codex/supabase-static` via the repository Blueprint. Deployment verification
is recorded in the implementation ledger.

## 1. Create and configure a Supabase project

Create a new project in your Supabase account and record its project reference,
URL and **publishable** key. Do not reuse an unrelated populated project. Install
Node 22+ and the [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started).

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Migrations create the app tables, RPCs, access policies, notification jobs and
three Cron tasks. Never apply `supabase/tests/bootstrap.sql` to a hosted project;
it is a fixture for an isolated, empty **stock PostgreSQL test database only**.

Only `public` should be exposed to the Data API. Do not expose `private`, `auth`,
`vault`, or `cron`. App-owned tables in `private` are accessed through narrow,
authorized functions. Users cannot write role/admission/disabled fields. RLS and
RPC gates also check that the JWT's `session_id` still exists in `auth.sessions`.
This preserves immediate application access revocation after global sign-out.
Client-cached data is still readable by its owner while offline; revocation
cannot erase data already downloaded to a device.

## 2. Configure Google and email authentication

In **Authentication → URL Configuration**, set the site URL to the final HTTPS
Render URL (or your custom domain). Allow the exact root callback URL and the
same URL with `?flow=recovery`; add localhost equivalents for development only.
Avoid wildcard production redirects. Hash routes are processed *after* the
callback, so no application server callback endpoint is needed.

Enable **Email** with confirmation required and a minimum password length of 8.
Configure a production SMTP provider in Supabase, with its verified sender and
sending domain. This can be a managed email delivery service (for example,
[Resend's Supabase SMTP integration](https://resend.com/docs/send-with-supabase-smtp));
you do not need to operate a mail server or add an application backend. Supabase's default mail service is intended for testing and
cannot be relied upon for public signups. SMTP credentials belong in Supabase,
never Vite variables, Git, or browser code.

Custom SMTP must be configured before the hosted dashboard allows template
editing. Then configure these verification links (`{{ .SiteURL }}` uses your
configured application origin; avoid a trailing slash in that site URL):

- Confirm signup: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=signup`
- Reset password: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery`

Versioned HTML is in `supabase/templates/confirmation.html` and
`supabase/templates/recovery.html`; local Supabase uses them through
`auth.email.template.*` in `config.toml`. For a hosted project, copy their content
into **Confirm sign up** and **Reset password**, respectively, after SMTP is
active. Changing the local files alone does not update hosted templates.

The client verifies these one-time hashes and immediately removes callback
parameters from the address bar. Unlike a PKCE-only email confirmation, this
works when the user opens the email on another device. Google uses PKCE and must
return to the browser that started the flow. OAuth errors and expired links are
shown with a retryable sign-in form.

In Google Cloud create a **Web application** OAuth client. Enable the Google
provider in Supabase, and copy Supabase's **Auth callback URL** to Google's
Authorized Redirect URIs. Register the app's origin as an authorized JavaScript
origin; request only the identity/email/profile scopes. Store the Google client
secret in Supabase's provider settings. Publish the Google consent screen to the
intended audience before opening registration to the public.

Same verified-email identities follow Supabase's automatic linking rules.
Google users can set a password from Settings; do not try to create a second
email account to add password sign-in.

## 3. Configure managed push notifications

Create fresh keys rather than reusing the legacy tracked `data/` secrets:

```sh
node scripts/generate-push-secrets.mjs https://YOUR_APP mailto:YOUR_CONTACT_ADDRESS
```

This creates `supabase/.env.local` with mode 0600, refuses to overwrite an
existing file and does not print key material. Adjust `APP_ORIGINS` to a
comma-separated list of exact allowed app origins if needed. Never use `VITE_`
variables for these secrets.

```sh
npx supabase secrets set --env-file supabase/.env.local
npx supabase functions deploy admin
npx supabase functions deploy push
npx supabase functions deploy notification-dispatch
```

Keep the `[functions.*] verify_jwt = false` settings in `supabase/config.toml`:
`admin` and `push` explicitly validate the caller's Auth JWT **and active database
session**. The dispatcher uses a different, private scheduler secret and accepts
no user-supplied recipient or payload. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are provided to functions by Supabase; the service
role is used only by the dispatcher, never by the frontend.

In the **Supabase Vault dashboard**, create:

- `opengym_project_url`: your Supabase project URL.
- `opengym_dispatch_secret`: the same `DISPATCH_SECRET` from `.env.local`.

Do not paste secrets into committed SQL or command arguments. Cron is inert for
outbound requests until both Vault values exist. After setup, enable Push in the
app and send a test notification.

The 1-second job wakes the Edge Function only if a due, eligible job exists. A
10-second job produces per-local-day reminders. HTTP delivery runs outside the
SQL transaction. Jobs are claimed with a lease and `SKIP LOCKED`; successful
per-device deliveries are recorded before retrying failed devices. Each worker
handles at most ten subscriptions, then leaves remaining deliveries for another
invocation. Expired reminders are not replayed. A network failure immediately
after provider acceptance can still cause a duplicate; Web Push cannot offer
exactly-once delivery. Notification tags reduce visible duplicates.

Rest start/extend/cancel is ordered by the frontend and invalidates older claims.
Cancellation is checked again just before each send; a notification already
accepted by a push provider cannot be recalled. Only subscriptions bound to live
sessions are eligible. Dead 404/410 subscriptions are removed. Outbound endpoints
are restricted to the supported Google, Mozilla, Apple and Windows push domains;
redirects and internal addresses are rejected.

Use a Supabase configuration that remains active for your availability needs;
a paused project or exhausted quota cannot run Cron/Edge Functions. Schedulers
and function invocations contribute to normal Supabase usage. Browser/OS push
permission, installation and delivery restrictions still apply (including iOS
PWA requirements). A second-based schedule does not guarantee a delivery second.

## 4. Assign the owner and configure optional invitations

Register and verify your own account first. In **Authentication → Users**, obtain
its UUID; then execute the following in the SQL Editor with that UUID:

```sql
update private.accounts set role = 'admin' where user_id = 'YOUR_AUTH_USER_UUID';
```

There is deliberately no automatic first-user admin, email-based admin claim, or
role field writable through profile metadata. Sign in again to refresh the UI.
Admin state/history is available only to authorized admins, matching the legacy
operator dashboard. Explain this operator access in your deployment's privacy
notice if you offer the app publicly.

Registration is open by default. For future accounts to require an invite:

```sql
update private.app_config set invite_only = true;
```

Existing admitted accounts remain admitted. New Google/email users may create
and verify an Auth identity, but cannot access application data until redeeming
a valid code. Admins create and revoke codes in the dashboard. Code consumption
is atomic. Turning the flag off affects newly created accounts; to admit
previously waiting accounts as well, explicitly update their `admitted` fields.

Disabling an account denies all application RPCs and data reads even if an old
JWT has not expired. It also excludes its activity and notifications. Its
external Google identity is unaffected; attempting app access shows a disabled
account screen. Admins cannot disable an admin through the application.

## 5. Run locally and deploy the static site

```sh
# For a fresh checkout only (do not overwrite an existing local configuration):
cp -n frontend/.env.example frontend/.env.local
# Fill only VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY locally.
npm --prefix frontend ci
npm --prefix frontend run dev
```

Render's Node 22 environment uses npm 10. Verify lockfile changes with a clean
npm 10 install (not only a build using existing `node_modules`). Missing optional
peer records generated by another npm version can otherwise fail `npm ci`.

The default Vite port is 5173. Add that exact origin to your Auth redirects and
`APP_ORIGINS` for local Edge Function calls. Vite still supports the existing
media proxy during development; `npm run build:static` packages media for a
self-contained static production preview instead:

```sh
npm --prefix frontend run build:static
npm --prefix frontend run preview
```

For Vite hot reload with media, run `python3 -m http.server 8888 --directory media`
in another terminal. This serves static media only; no application API is used.

Create a Render **Static Site** using the repository's `render.yaml` blueprint.
Set the two public Vite variables in Render. An existing Docker web service may
need to be replaced by a Static Site in the Render dashboard; the blueprint
change alone does not guarantee an in-place service-type conversion. Keep the
old service until you validate the new site, then point the intended domain at
it. Rebuild when changing Vite variables. The publish path is `frontend/dist`;
never publish the repository root or `data/`.

`build:static` copies only regular JPG/GIF files from `media/img` and `media/gif`;
symlinks and other files are excluded. All 1,324 images and 1,324 GIFs currently
in the repo are served from the same origin. Native builds retain their existing
pinned CDN configuration. The Render CSP permits Supabase project domains; if
you later configure a custom Supabase API domain, adjust `connect-src` too.

Do not set `VITE_DEMO=1` or `VITE_MOBILE=1` for the real web site. Those switches
intentionally keep the local-only variants. The legacy Docker/API files are
retained as historical sources and are no longer the default web architecture.

## 6. Data transition, offline use and backups

There is no automatic mapping from the old passkey ID to a new Auth UUID.
Export old profiles first and keep a backup of `data/`. Sign up with Google or
email, then use **Settings → Import backup** with the existing JSON format.
Local pre-migration data is preserved separately and can be exported in Settings.
Local guest data is not silently uploaded; use **Import guest data**, after
exporting any existing account data you want to retain.

Every user has a separate local namespace, dirty flag, version and immutable
pending snapshot. Signing out does not discard unsent account edits. They are
not shown to the next user or to a guest; signing back into the same UUID
recovers them. This is browser storage, not encrypted storage against someone
with device/devtools access. Native file mirroring remains unchanged.

Cloud writes use an atomic version comparison. Conflicts preserve both copies
and require choosing local or cloud explicitly; each can be exported before
choosing. The unchosen copy is kept as a downloadable backup. In-progress
workouts remain device-local. Preserve external JSON exports as an independent
backup; use Supabase database backup facilities appropriate to your project.
Stale edits from another browser tab are detected separately rather than using
the newer shared-cache version to silently overwrite data.

## 7. Verification and operations

```sh
npm --prefix frontend test
node --test scripts/copy-static-media.test.mjs
npm --prefix frontend run build:static
# First browser test run:
cd frontend
npx playwright install chromium
npm run test:e2e
# From repository root, with Deno installed:
deno task --config supabase/deno.json check
deno task --config supabase/deno.json test
```

Browser tests simulate only the Supabase network boundary. Before production,
verify Google consent/return, confirmation and recovery emails (also on a second
device), two real user accounts, revoked sessions, admin gating and real Web
Push on desktop and installed mobile PWA. Run a native/demo build without any
Supabase variables as a regression check.

For SQL tests, use an isolated fresh local PostgreSQL database (never production):
apply `tests/bootstrap.sql`, core/operations/notifications migrations in order,
then `tests/core.sql`, `tests/notifications.sql` and `tests/admin.sql`. Each test
rolls back its fixtures. The Cron extension migration must additionally be
applied and smoke-tested on local/hosted Supabase, where pg_cron, pg_net and Vault
exist; stock PostgreSQL fixture tests do not verify those managed extensions.

For a repeatable full stock-PostgreSQL check, create a fresh database named
`opengym_test_*`, set `PGHOST`, `PGPORT`, and `OPENGYM_TEST_DATABASE`, then run
`node scripts/test-supabase-sql.mjs`. The runner refuses a populated application
schema. It also exercises actual concurrent state writes/invite redemption and
the production scheduler SQL using local Vault/HTTP/Cron contract adapters.

Monitor `cron.job_run_details` for failures, Edge Function request/error rates,
and status/attempt counts in `private.notification_jobs`. Hourly housekeeping
removes old presence, revoked subscriptions, expired jobs, old mutation receipts
and Cron logs. Do not log subscription endpoints, push keys, tokens, email
addresses or full state payloads when investigating failures.

Rollback: retain browser/JSON backups and the prior deployment. Avoid running
old and new writers against the same data. No legacy files are deleted and no
Git history is rewritten by this migration.

## Admin notification management

Open **Settings → Admin → Notifications**. Choose **All eligible users** or
**One user**, enter a title (up to 80 characters) and message (up to 500), then
choose **Send now** or **Schedule**. Scheduled times use the administrator's
browser timezone and are stored as absolute timestamps; the limit is 30 days.
**Review notification** previews the audience/content/time before confirmation.

The audience is a snapshot of enabled, admitted, confirmed users with a push
subscription bound to a live session when the campaign is created. Each user
gets one durable queue job, sent to their currently eligible devices. New users
joining later are not added. Account, subscription, campaign cancellation and
author admin status are checked again before dispatch. The queue processes the
early-expiring jobs first so a broadcast does not block rest timers or reminders.
Campaigns expire 24 hours after their scheduled time; retries/leases use the
existing dispatcher. Creating campaigns is limited to ten per minute per admin
and 10,000 recipients per campaign.

**Notification history** refreshes every 15 seconds, paginates 20 campaigns per
page and retains campaigns/jobs/receipts for 90 days from creation. It shows
pending/completed/failed user jobs, accepted provider requests and expired device
subscriptions separately. A completed job may have no active device at dispatch;
provider acceptance does not prove display or reading. Cancellation stops
remaining work, including invalidating current worker leases, but cannot recall
requests already in flight. For cancellation during sending, interrupted-user
counts explicitly warn that provider acceptance counts may be incomplete.

An uncertain response retains the draft and reuses its request identifier on an
unchanged retry, even if its original due time has passed. Keep that page open
and retry the same draft; reloading or changing the draft starts a new request.
No service-role secret is used in the frontend. Managed actions go through the
admin Edge Function and live-session/admin-gated database functions.

Regression coverage is in `supabase/tests/admin-notifications.sql`, the SQL test
runner's two-connection submission/cancellation cases, Edge input validation and
`frontend/e2e/admin-notifications.e2e.mjs`. The stock PostgreSQL runner supplies
local Cron/Vault/HTTP adapters; its retention assertion is local-only.
