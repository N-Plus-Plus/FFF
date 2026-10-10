# Wire Wednesday deployment and access runbook

## Prepared topology and boundaries

Existing `fff-api` serves the canonical HTTPS origin `https://wirewednesday.nissen.nexus`: Static Assets via `ASSETS`, `/auth/*` and `/v1/*` via existing D1 `fff`, and authenticated `/artwork/*` via existing R2 `fff-artwork`. Both production bindings are confirmed by the operator. No replacement resources or imports are required. Prepared config disables workers.dev and cross-origin API access. GitHub Pages is not a fallback after cutover.

Google completely replaces participant links. Migration `0004_google_auth.sql` only adds mapping, request, challenge and session tables plus invalidation triggers; it does not change participant IDs, nominations, rankings or history. Historical link columns remain inert and are never read for authentication or confirmation. Retained Supabase source is historical, not a second login route. Cloudflare D1 migrations own the current backend; never run resets or replay import SQL.

## Google and environment setup

Use the existing configured Web application OAuth client. Confirm Google's authorised JavaScript origins include `https://wirewednesday.nissen.nexus` and any exact loopback origins used for real local sign-in. Google Identity Services uses popup mode, server-verified credentials and a single-use browser-bound nonce; no OAuth callback route or client secret is needed. Google's stable `sub` is the identity key, never an email alone ([Google verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)). Confirm OAuth consent/audience restrictions and test-user status permit every intended participant.

The root `.env.vars` is ignored and contains local Google and fanart.tv configuration. Do not print it, publish it, pass its values on command lines, or copy it into assets. `GOOGLE_CLIENT_ID` and `FANART_TV` are used; any client secret already there remains untouched and unused. Local Wrangler needs `--env-file .env.vars`; it does not automatically select this custom filename. `--local-upstream` also keeps the Worker request origin aligned with the loopback browser instead of the configured production domain. Start:

```powershell
node cloudflare/scripts/prepare-assets.mjs
npx.cmd wrangler d1 migrations apply DB --local --persist-to .wrangler/hosting-local
npx.cmd wrangler dev --local --local-upstream 127.0.0.1:3000 --env-file .env.vars --port 3000 --var APP_ORIGIN:http://127.0.0.1:3000 --var LOCAL_DEMO:true --persist-to .wrangler/hosting-local --log-level warn
```

Use the exact `127.0.0.1` origin above. `LOCAL_DEMO` works only on the explicitly configured loopback origin, never production. Real local sign-in additionally needs synthetic local mappings; automated tests mock Google and use disposable data. Do not use `--remote`, production snapshots, or real participant records in tests. Local HTTP uses a separately named cookie; production always uses `__Host-ww-session` with Secure, HttpOnly, Path=/, no Domain and SameSite=Lax.

Production Wrangler secrets are separate from local files. After separate approval, `node scripts/set-google-client-id.mjs --apply` reads the ID from `.env.vars` and passes only that ID through stdin to `wrangler secret put GOOGLE_CLIENT_ID --name fff-api`, without printing it. That command changes the live Worker and may create a deployment; never run it during preparation. Do not pass `.env.vars` to production deployment, and do not upload its unused client secret. Confirm secret names rather than values. The public `/auth/config` deliberately returns the client ID needed by GIS, never credentials or mappings.

## fanart.tv banner deployment

Local `.env.vars` must contain `FANART_TV`, a fanart.tv project API key. The local command above already loads it explicitly. Never put the key in `wrangler.jsonc`, frontend config, request URLs, logs or public assets. No fanart.tv SDK or additional dependency is needed. The implementation follows the [official v3.2 API](https://api.fanart.tv/) and [TV response types](https://github.com/fanart-tv/fanart.tv-api/blob/main/src/index.d.ts): television lookup uses TheTVDB ID, `tvbanner` dimensions must be 1000×185, and authentication uses the `api-key` header.

Migration `0005_fanart_banners.sql` adds `shows.card_art_manual`, `shows.fanart_banner_id` and the `fanart_cache` table. It changes no existing nominations, ranking positions or participant records. Apply all pending forward migrations locally for development. Tests apply them to disposable D1/R2 and mock providers; run `node cloudflare/tests/fanart.test.mjs` after asset preparation.

For a separately approved production release, apply pending D1 migrations, configure the secret, then deploy the reviewed Worker/assets. `node scripts/set-fanart-key.mjs --apply` reads only `FANART_TV` from ignored `.env.vars` and passes it via stdin to `wrangler secret put FANART_TV --name fff-api`; this modifies the live Worker and must not run during preparation. Alternatively configure that secret in the trusted Cloudflare dashboard. Do not pass the environment file to production deployment. Existing Google, origin, D1, R2 and Cron deployment gates still apply. Confirm production secret names without printing values.

Existing shows adopt preferred banners through the existing authenticated background audit or weekly refresh; no bulk backfill is required. No banner, missing TheTVDB ID, missing key or provider failure keeps existing artwork. Discovery/empty results cache for 24 hours; failures cache for at least five minutes with bounded `Retry-After` (at most one day). The Worker retains downloaded artwork and modal previews in R2; browser responses stay private/no-store. Manual selections persist independently of metadata JSON and provider cache expiry. Immutable source-derived keys prevent automatic refreshes from overwriting selected image bytes. Do not purge referenced R2 assets. The selector uses `/v1/admin/artwork` with session admin authorization; preview and canonical reads require participant authentication. Save validates the banner against server-side discovery and accepts no arbitrary URL or uploaded bytes.

Provide fanart.tv attribution and CC BY 3.0 links in the picker, plus source/credit on displayed cards identifying cropping for display. Retained originals are unedited. The key must be approved for this application’s usage; project-key access may delay new uploads according to the provider’s access tier. No personal-key settings are added to this private participant application.

## Establishing and maintaining participant mappings

Only an operator with trusted D1 access can establish approvals. There is no application/API approval endpoint, and app administrator status cannot manage identities. Being listed in the Google OAuth consent application's **Test Users** permits Google's test-mode sign-in; it does not grant Wire Wednesday access or prove which FFF participant owns the account.

### Initial pre-approval for the four known participants

1. In a separately approved production setup, apply forward migration `0006_google_preapprovals.sql` before deploying this authentication code. It adds only the `participant_google_preapprovals` table and guards/consumption triggers. It neither changes participant IDs, nominations or rankings nor recreates existing mapping/session tables. Local tests apply it to disposable D1 only. Review all pending migrations and existing tracking; never reset/import/replay baseline data.
2. Privately inspect `SELECT id,display_name,is_active,is_admin FROM app_users` in the trusted D1 console. Confirm each known person, current Google account and **existing participant ID** out of band. Inspect `participant_google_auth` for existing mappings first. Existing subjects must use the recovery procedure below, not another pre-approval. Do not match by display-name similarity or create participants.
3. Enter the following single INSERT directly in the trusted D1 console, replacing **all fictional values there** with the four confirmed IDs, exact display names and exact Google emails. Use this as an operator-reviewed template; do not run it unchanged. It is atomic: a missing/inactive participant, mismatched name or duplicate email/participant fails the whole statement. Existing mapped participants/emails are rejected. Trim/lowercase only; do not rewrite Gmail dots, plus aliases or hosted-domain names. Escape SQL literal single quotes by doubling them.

```sql
INSERT INTO participant_google_preapprovals
  (user_id, approved_email, enabled, approved_at, approval_note)
VALUES
  ((SELECT id FROM app_users WHERE id='fictional-participant-1' AND display_name='Fictional One' AND is_active=1),
   lower(trim('one@example.test')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Operator confirmed initial account'),
  ((SELECT id FROM app_users WHERE id='fictional-participant-2' AND display_name='Fictional Two' AND is_active=1),
   lower(trim('two@example.test')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Operator confirmed initial account'),
  ((SELECT id FROM app_users WHERE id='fictional-participant-3' AND display_name='Fictional Three' AND is_active=1),
   lower(trim('three@example.test')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Operator confirmed initial account'),
  ((SELECT id FROM app_users WHERE id='fictional-participant-4' AND display_name='Fictional Four' AND is_active=1),
   lower(trim('four@example.test')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Operator confirmed initial account')
RETURNING user_id, enabled;
```

4. Require four returned participant IDs and privately verify the D1 associations. Real addresses and mappings belong only in D1: do not put them in chat, source, migrations, `.env.vars`, frontend configuration, command-line arguments, local JSON/SQL files, logs or public query results. No real mappings ship with this repository. The existing private SQL generator remains useful for fictional local fixtures; use the trusted D1 console for real operator approvals/recovery.
5. No sign-in request or Google `sub` is needed in advance. At first sign-in, the Worker verifies Google's signature, issuer, audience, expiry, verified email and browser-bound single-use nonce before matching the exact pre-approved email. Automatic email claiming requires Google to be authoritative: `@gmail.com`, or a verified Workspace account with a signed nonempty `hd` claim. Four fictional `example.test` Workspace accounts are used in tests; those addresses alone are not real Google-hosted accounts. [Google explains why third-party mailbox accounts need additional identity review](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token). The Worker detects this from the signed token; Test User status does not establish account type.
6. The single INSERT binds the existing participant to the verified stable `sub`. Its D1 trigger marks the pre-approval consumed in the same atomic operation. Simultaneous first attempts cannot claim the email twice. No existing subject, email or participant mapping is overwritten, including disabled mappings. Future logins use only the established `sub`, so a changed email cannot reassign identity or take over another participant. Unknown accounts stay denied. The normal session response contains no email, subject or pre-approval data.

The table reserves first-use access; only bound enabled subject mappings count toward the existing Board active-user/confirmation denominator. Claiming approvals changes authentication/revision state only, not any participant's ballot or nominations. A disabled/inactive participant cannot claim access.

### Pending corrections, revocation and privacy decision

Before first use, an operator can correct an unclaimed email or disable its pending approval in D1. For example, `UPDATE participant_google_preapprovals SET enabled=0 WHERE user_id='fictional-participant-1' AND claimed_at IS NULL;`. Claimed emails/participant IDs cannot be rewritten or reset to unclaimed. Deleting a bound mapping does not reopen its consumed pre-approval.

After binding, revoke access by setting `participant_google_auth.enabled=0` for the exact participant ID; changing the pre-approval's enabled flag has no effect on established access. Existing mapping triggers invalidate sessions and advance Board revision. Deactivation also blocks sessions. Retained ballots still contribute; only the confirmation denominator changes. Do not delete/recreate participant records or alter rankings to recover an account.

Approval emails remain plaintext **only in protected D1 tables**, as in the existing subject approval/request mechanism. Keyed hashing of only the pre-approval table would leave emails in the existing mapping/request tables, provide little additional protection and introduce another secret with rotation/recovery requirements. No additional hashing secret is introduced. Sessions remain opaque and hashed as before; credentials are not stored or logged. Protect database access, backups and provider/account logging with the existing deployment privacy gates.

### Third-party Google accounts and explicit account recovery

For a Google account whose email is neither Gmail nor covered by Google's signed Workspace `hd`, automatic email-only claiming is refused even with `email_verified=true`. Have the intended person sign in during the controlled setup window: the valid but denied account is recorded in `auth_requests` only in D1. Independently confirm their current account ownership and exact request `google_sub` out of band. Then create the subject mapping in the trusted D1 console using the verified request (no prior mapping may exist):

```sql
INSERT INTO participant_google_auth
  (user_id, google_sub, approved_email, enabled, approved_at, approval_note)
VALUES
  ((SELECT id FROM app_users WHERE id='fictional-participant-1' AND display_name='Fictional One' AND is_active=1),
   (SELECT google_sub FROM auth_requests WHERE id='fictional-request-id'
      AND verified_email=lower(trim('one@example.test'))
      AND requested_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')),
   lower(trim('one@example.test')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'Operator independently verified account ownership')
RETURNING user_id, enabled;
```

Require exactly one returned participant ID. Invalid participants/requests fail through NOT NULL/FK constraints; unique subject/email constraints prevent cross-participant assignments. First insertion also consumes any pending pre-approval for this participant, including disabled pending rows. The person can then sign in using their bound subject. Unknown accounts are never approved merely because they submitted a request. Requests older than 30 days are ineligible and cleaned on subsequent denied sign-ins.

For recovery/replacement or re-enabling a bound account, verify a fresh request and explicitly compare its participant's **current subject**. Use this guarded console update, replacing fictional values after operator review:

```sql
UPDATE participant_google_auth
SET google_sub=(SELECT google_sub FROM auth_requests WHERE id='fictional-new-request-id'
      AND verified_email=lower(trim('replacement@example.test'))
      AND requested_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')),
    approved_email=lower(trim('replacement@example.test')), enabled=1,
    approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), approval_note='Operator verified account recovery'
WHERE user_id=(SELECT id FROM app_users WHERE id='fictional-participant-1' AND display_name='Fictional One')
  AND google_sub='fictional-expected-current-sub'
RETURNING user_id, enabled;
```

Require exactly one returned participant ID; zero rows means no change. A missing/mismatched verified request fails, and unique constraints still prevent assigning another participant's subject/email. An update invalidates old sessions. The consumed original pre-approval stays consumed. Never reset it or let ordinary login replace the subject. Human verification remains the deployment gate for all initial mappings and account recovery.

## Local verification

Run syntax checks, `node scripts/verify-contracts.mjs`, `node cloudflare/tests/session-hash.test.mjs`, `node cloudflare/tests/hosting.test.mjs`, `node cloudflare/tests/auth-browser.test.mjs`, and `node cloudflare/tests/preapproval.test.mjs`. With local Wrangler running, run `node scripts/hosting-browser-test.mjs` and `node scripts/placement-browser-test.mjs`. Finally run `npx.cmd wrangler deploy --dry-run --outdir .wrangler/hosting-dry-run` without the local environment file.

Mock tests also cover four pre-approved fictional identities, atomic first-use binding, concurrent claims, Gmail/Workspace authority, third-party review, stable-sub login after email change, consumed/disabled approvals, existing-data preservation and approval privacy. Existing mock tests cover signed Google claims, denied approval, incorrect/duplicate mappings, impersonation attempts, same-origin protection, remembered and short sessions, expiry/revocation/logout, private assets/artwork, nominations and rankings. Optional `node scripts/review-google-button.mjs` follows CanBan's current review script using local bytes and the public SDK in anonymous Chromium, checking official `outline_dark` presentation/resizing. It never contacts the deployed Worker or signs in. Personalised Google rendering and a real approved sign-in require manual acceptance after setup.

Browser tests also cover logout across tabs; `X-WW-Participant` only detects a stale displayed identity and never selects an actor. A mismatch returns `409 SESSION_CHANGED` before writes. Only one sign-in challenge is pending per browser; if another sign-in tab replaces it, retry obtains a fresh nonce. Google popup cancellation leaves the user on the sign-in page to retry.

## Security and operational review

Only the anonymous login document allows the exact Google GIS SDK, Google sign-in frames/connections, and popup-compatible COOP. Authenticated `/login.html` redirects to the application; app documents allow only same-origin scripts and connections. Lucide 1.55.0 and Lexend Deca 5.3.0 are packaged locally with licenses; `jose` 6.2.12 validates Google credentials in the Worker. No unpkg/latest, third-party analytics or Google fonts requests remain. Login, application, API and R2 responses enforce private/no-store, no-referrer, nosniff and frame restrictions. Authenticated content is never put in browser localStorage; demo state is synthetic and loopback-only. Session credentials are opaque and hashed in D1; GIS credentials are neither stored nor logged.

Prepared configuration disables Workers observability ingestion; code does not log request URLs, bodies, headers, credentials, subjects or emails. This cannot control account-level Logpush, HTTP logging, tracing, DNS analytics, external collectors or previous CDN caches. Before cutover, inspect and disable/redact sensitive request fields, cookie/body capture and query strings, including old bearer-link URLs. Never tail real login requests into shared output. Verify no cache rule overrides private/no-store. Check R2 has no public r2.dev/custom-domain exposure; the Worker gate cannot make an independently public bucket private. Privately purge any old cached artwork responses if needed. These live reviews/changes are separately approved work.

The Google SDK is an intentional identity-provider trust dependency; it is not vendorable. Its execution is restricted to sign-in. Rate-limiting/WAF rules for public auth endpoints should be considered during the approved account review to protect D1 and Google verification capacity; no live rules are added here.

## Cron purpose and deployment implication

`wrangler.jsonc` retains `0 2 * * 3`. The `scheduled` handler calls `refreshDueShows`: up to 25 active, non-removed shows whose last metadata success is at least seven days old are processed sequentially through TVmaze. It updates D1 metadata/revisions and can retain changed artwork in R2; upstream failures record a sanitized category. It is independent of interactive authentication and is not a weekly email reminder.

The trigger is not currently visible in Cloudflare; do not describe it as deployed or firing. Possible causes include deployment/config drift or looking at a different Worker/account. Confirm the actual `fff-api` triggers before cutover. A normal approved `wrangler deploy` can register/update the configured Cron, enabling future live writes; that implication needs explicit approval. Cron uses UTC: Wednesday 02:00 is 12:00 AEST / 13:00 AEDT in Sydney. Changes may take up to 15 minutes to propagate ([Cloudflare Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). Do not manually invoke a production scheduled event as a smoke test. Review its next execution and output privately after approval.

## Production cutover â€” separate approval required

1. Agree on a controlled access window. Record current deployment/settings, DNS, triggers and resource bindings; establish an approved private D1 recovery/export point. Confirm the existing `fff` database ID, `fff-artwork` bucket, zone ownership and certificate readiness. Stop on conflicting DNS rather than replacing it implicitly. Complete logging/cache/R2-public-access review and confirm the Cron decision.
2. Confirm Google origin/consent configuration and set the client ID through the approved helper above. Review migration history read-only. If existing baseline schema is present but `0001`â€“`0003` appear pending, stop and reconcile tracking under separate approval rather than replaying their SQL. Once the baseline is confirmed, approve and apply the pending forward migrations (including `0004` authentication and `0006` pre-approvals) with `npx.cmd wrangler d1 migrations apply DB --remote`; verify participant/data counts and IDs are unchanged. Never import/reset/recreate resources.
3. Re-run local verification and dry-run, then, with deployment/DNS/Cron approval, run `npx.cmd wrangler deploy`. This updates the existing Worker/assets and domain, disables workers.dev, and can register the configured Cron. During this controlled setup window, all unmapped identities are denied. No old participant link is accepted.
4. Establish the four reviewed D1 pre-approvals before announcing general sign-in availability, as described above. Confirm the administrator is associated with the existing admin participant ID. Gmail/Workspace accounts bind their subject on first sign-in. For third-party email accounts, collect and independently review verified subject requests during the controlled setup window. Existing mappings require explicit recovery, not pre-approval or automatic reassignment.
5. Verify HTTPS, anonymous login, official button/popup, authenticated root/modules, invalid credentials/denied accounts, session persistence, logout and private artwork; confirm old links and actor overrides cannot authenticate. Privately verify each participant sees their existing order/history. Production mutation tests require specific approval and controlled cleanup. Confirm scheduled settings without firing metadata refresh manually.
6. Retire GitHub Pages during the approved cutover or publish an approved plain canonical-URL landing page. Do not preserve `u` query parameters in any redirect. Remove obsolete participant links from messages/bookmarks and historical reminder configuration. Retire old public Supabase bearer RPC/Edge access if still reachable; this requires explicit separate Supabase approval and must preserve its data. No production backend may remain advertised as an alternate login path.

## Rollback

Use an approved maintenance/closed-access state if deployment or mapping fails. Preserve all D1/R2 data and the additive tables; fix mappings or restore a reviewed Google-capable Worker version. A pre-migration Worker rollback re-enables legacy bearer access and is incompatible with the confirmed Google-only decision, so do not use it as an automatic fallback. DNS/domain/secret/trigger rollback requires separate approval. Supabase has diverged from D1 and is not a lossless runtime rollback target without separately approved reconciliation. Never overwrite participant history with an old snapshot.
