# FFF TV Ranking

FFF TV Ranking is a static, mobile-first GitHub Pages app for a known group to nominate television series, keep private personal orders, and view a strict aggregate Board sequence.

## Access and Privacy

Users are manually created outside the ordinary app and receive a permanent secret URL containing `?u=<link_token>`. The token is a bearer credential. The database stores only SHA-256 token hashes, and browser RPCs never return raw tokens or token hashes.

Every ordinary screen, including the Board, requires a valid active user link. Browser code uses narrow Supabase RPCs only; direct anonymous table access to application data is not granted. Users can see their own ranking sequence, their own nomination state, and aggregate Board results. They cannot retrieve another user's personal ranking. Nominator display names are not exposed through browser RPCs or the UI.

The administrator is also an ordinary participant and may nominate and rank shows. Active users count toward Board confirmation. Deactivated users and revoked link tokens cannot resolve the app link, read app data, nominate, reorder, or access the Board, but their retained explicit rankings continue contributing to aggregate order unless another lifecycle rule clears them. The Board displays only active-user ranking participation.

Service-role-only user helpers:

```sql
select public.admin_activate_known_user('USER_UUID');
select public.admin_deactivate_known_user('USER_UUID');
select public.admin_revoke_user_link('USER_UUID');
select public.admin_rotate_user_link('USER_UUID', 'https://your-org.github.io/fff');
```

These helpers are not callable through the browser anon role.

## Product Rules

Canonical shows are deduplicated by normalized IMDb title ID. A valid canonical IMDb title ID is mandatory for every enrolled show. The app accepts television series, miniseries, reality series, animation series, and documentary series. It rejects individual episodes, television movies, and one-off television specials.

Multiple users may nominate the same canonical IMDb show. A valid nomination by an active user makes the show active immediately; there is no pending, moderation, or approval queue. A user can have only one active nomination for a show; duplicate active nominations return an already-nominated result. Withdrawing a nomination affects only that user, removes that show from that user's current ranking, resequences their remaining ranked shows, and preserves canonical show rows plus historical nomination timestamps.

Shows remain active while at least one nomination is active. When the final active nomination is withdrawn, the show leaves Add, Order, and Board responses automatically and all current ranking rows for that show are cleared. If nominated again later, the existing canonical row is reused and reactivated, but prior ranking positions are not restored; every user sees it as unranked until they rank it again.

Administrators can remove an active show from the ordinary app. Removal is reversible, records who removed it and when, and hides the show from Add, Order, Board, and search-as-catalogue results. There is no in-app removed-show history or restore UI.

Database-only restoration helper:

```sql
select public.admin_restore_show(p_show_id => 'SHOW_UUID');
select public.admin_restore_show(p_imdb_id => 'tt14452776');
```

Run restoration only from an administrator-controlled database or service-role context. Restoration clears the administrative removal marker on the canonical record only. It does not restore prior active nominations or prior current rankings, so the show remains inactive until a user nominates it again.

## Ordering and Board

The Order screen has separate Ranked and Unranked sections. Newly nominated active shows appear as Unranked for every user and do not create ranking rows for users who have not expressed an opinion. A user ranks a show only by moving it into Ranked, either with the add control, by tapping an Unranked card to append it, or by tap-holding a card for 0.25 seconds and dragging it into a Ranked insertion slot. Quick swipes before the hold completes remain normal page scrolling, and long-press card context menus are suppressed so slow drag starts are not interrupted. Ranked positions are strict, unique, contiguous, and transactionally replaced through `replace_user_ranking`.

The app persistently reminds valid users when they have active unranked shows: the Order tab shows a count and a non-blocking banner remains visible across Add, Order, and Board with a direct Order action. The banner has a dismiss control, and dismissal lasts only for the current browser session through `sessionStorage`. The reminder returns in a new browser session or when session state is cleared.

The current aggregate strategy is `sequential-irv-v1`, implemented in `ranking.js` and SQL `calculate_provisional_board`. Each user's ranked queue is a partial ranked-choice ballot. Unranked shows are absent from that user's ballot and never count as a synthetic last-place preference.

The Board candidate set contains active, non-removed shows with at least one retained explicit ranking. Rankings retained from inactive users continue contributing to the election, but inactive users do not count toward confirmation and are not included in the displayed "ranked by" count.

The Board sequence is produced by repeated instant-runoff elections. The first election chooses first place from all eligible candidates. That winner is removed, the original ballots are filtered to the remaining candidates, and a fresh instant-runoff election chooses the next position. This repeats until every eligible candidate has a strict position. Exhausted ballots are ignored for the current election.

The ordinary Board displays the aggregate sequence without per-card vote counts. Entries that do not yet have one vote from every active user remain in their aggregate position but render at reduced opacity. It does not display aggregate numeric scores or algorithm explanation.

Confirmation is dynamic. For every Board calculation:

```text
activeUserCount = users where is_active = true and token_revoked_at is null
confirmed = activeUserCount > 0 and rankedActiveUserCount >= activeUserCount
```

Inactive users' historical rankings contribute to aggregate order, but not to the active-user confirmation denominator or displayed participation count. Reactivating a user may make previously confirmed shows unconfirmed until that user ranks them; deactivating a user may make shows confirmed without deleting that user's retained ranking contribution.

Aggregate ties are broken deterministically by canonical IMDb numeric value. Remove every non-numeric character from the IMDb ID and compare the remaining numeric strings without floating-point conversion. The higher numeric IMDb value wins winner ties, and the lower numeric IMDb value loses elimination ties first. Matching numeric components across distinct records are a data-integrity failure.

## Metadata and Cards

Canonical identity is always IMDb. The browser calls the `imdb` Edge Function for search, lookup, and enrolment. TVmaze is the primary television metadata provider and requires no API key. The Edge Function searches `https://api.tvmaze.com/search/shows?q={query}`, resolves exact canonical IMDb IDs with `https://api.tvmaze.com/lookup/shows?imdb={imdbId}`, retains the numeric TVmaze show ID, retrieves episodes from `https://api.tvmaze.com/shows/{tvmazeId}/episodes`, and retrieves card artwork from `https://api.tvmaze.com/shows/{tvmazeId}/images`. Card artwork selection prefers `type = background` with `resolutions.original.url`, then `type = banner` with original then medium URL, then the normal portrait poster, then the local placeholder. Within a type, `main: true` wins, otherwise the first valid result wins.

Canonical identity comes from TVmaze's `externals.imdb` field. Search results without an IMDb ID are rejected. Supported normalized metadata fields are canonical IMDb ID, title, premiered year, ended year, TVmaze type, series status, season count when available, episode count, cumulative runtime when every TVmaze episode has an explicit runtime, poster source URL, selected card artwork URL/type/dimensions, background URL and dimensions when horizontal artwork exists, source provider identity, TVmaze record ID, and retrieval timestamp. The app does not store or display synopsis, genre, or estimated cumulative runtime.

TVDB is only a fallback enrichment source after TVmaze successfully resolves canonical IMDb identity. It must not appear in the Add input UI, search choices, duplicate detection, canonical identity logic, show URLs, user-entered references, or ordinary provider status labels. TVDB may fill only missing supported metadata: series status, ended year, season count, total episode count, exact provider-supplied total runtime, poster source when TVmaze has no usable poster, background metadata when TVmaze has no usable background, and TVDB record ID. TVDB output is discarded unless it includes an explicit IMDb cross-reference that normalizes exactly to the canonical IMDb ID. TVDB is not used when the TVmaze request fails, and it never overwrites valid TVmaze values.

TVmaze data is licensed under CC BY-SA. The current app shell does not render provider attribution copy in the Add UI.

Show cards stay restrained: stored card artwork when available, title linked to IMDb when available, commenced year or ended year range, season and episode count when known, exact total runtime when known, rank or aggregate position, and required actions. Runtime is labelled "Total Runtime" and is displayed only when exact/provider-supplied; estimated cumulative runtime is not derived or shown. Background and banner artwork render as card backgrounds with a dark text overlay; poster fallback behaviour remains intact when no horizontal artwork exists. On load, rendered card backgrounds are checked against TVmaze's selected card-art dimensions and stale persisted artwork is refreshed through the metadata Edge Function when a mismatch is detected.

## Poster Storage

Stored poster assets use the Supabase Storage bucket:

```text
show-posters
```

The bucket is configured as public-read because poster images themselves are non-secret, while application data still requires a valid user link. Browser code has no upload policy. Trusted server-side code, normally the IMDb or metadata-refresh Edge Function with `SUPABASE_SERVICE_ROLE_KEY`, creates or replaces poster objects at deterministic paths such as `posters/tt14452776.jpg`.

Before storing an upstream poster or selected card artwork, trusted code validates HTTP/HTTPS URL schemes, uses bounded timeouts, limits redirects, enforces a 5 MB maximum, accepts only JPEG/PNG/WebP content types, rejects HTML or unexpected payloads, and never uses remote filenames or browser-supplied destination paths. Poster or card-art copy failure records a status when possible and does not block nomination or metadata refresh.

## Realtime Invalidation

Board updates use Supabase Realtime invalidation through `public.board_revision_public`, a single-row source containing only:

```text
revision
updated_at
```

No user IDs, display names, show IDs, titles, nominations, ranking positions, tokens, or administrative state are exposed through Realtime. Receiving a newer revision only causes the client to call token-authenticated RPCs. The app also refreshes when the Board opens, on focus/visibility return, and through a one-minute fallback poll if Realtime is unavailable.

Revisions advance when catalogue activity, nomination counts, personal rankings, Board confirmation state, user activation or deactivation, administrative removal or restoration, card metadata, or stored poster availability changes.

## Local Setup

Serve the static files with any local web server:

```bash
.\start-local-server.bat
```

Demo mode is explicit and local only:

```text
http://localhost:3000/?demo=1
```

The batch file serves the repository on `0.0.0.0:3000`, prints the local URL, and shows the LAN URL pattern for testing from another device on the same network. If Windows Firewall prompts for Python, allow private-network access for device testing.

When testing live Supabase Edge Function calls from another device, the LAN origin printed by the batch file, such as `http://192.168.1.23:3000`, must also be present in the deployed `ALLOWED_ORIGINS` secret. Localhost and `127.0.0.1` testing on this computer are covered by the Edge Function's built-in loopback-origin allowance, regardless of the local server port.

Production mode does not fall back to demo data. `config.js` must contain only:

```js
export const APP_CONFIG = {
  supabaseUrl: "https://PROJECT_REF.supabase.co",
  supabaseAnonKey: "PUBLISHABLE_OR_ANON_KEY"
};
```

## Supabase Setup

Supabase deployment uses the local migrations, Edge Functions, Storage bucket configuration, and Realtime publication changes in `supabase/`. Do not run linked resets. Before remote changes, confirm the linked project reference, inspect remote migration history and existing data, and stop if the remote project contains unexpected unrelated application data.

Initial deployment steps:

```bash
npx.cmd supabase login
npx.cmd supabase link --project-ref PROJECT_REF
npx.cmd supabase migration list
npx.cmd supabase db push --dry-run --linked --yes
npx.cmd supabase db push --linked --yes
npx.cmd supabase functions deploy imdb metadata-refresh --project-ref PROJECT_REF --no-verify-jwt --use-api
```

Do not run `supabase db reset` against a linked remote project. Migration files under `supabase/migrations/` are authoritative. `supabase-schema.sql` is only a historical pointer.

## Edge Function and Provider Secrets

The browser calls `supabase/functions/imdb` for search, lookup, and enrolment. Enrolment validates the user link, resolves canonical metadata through TVmaze, optionally enriches safely through TVDB, creates or reuses the canonical show through RPC, attempts poster copy into Storage, records poster status, and completes nomination even if poster copy fails safely.

Required or supported secrets:

```bash
supabase secrets set ALLOWED_ORIGINS="https://n-plus-plus.github.io,http://<LAN_IP>:3000"
supabase secrets set IMDB_TIMEOUT_MS="8000"
supabase secrets set TVDB_IMDB_URL_TEMPLATE="https://tvdb-provider.example/by-imdb/{imdbId}"
supabase secrets set TVDB_API_KEY="..."
supabase secrets set TVDB_API_KEY_HEADER="Authorization"
supabase secrets set TVDB_TIMEOUT_MS="8000"
supabase secrets set METADATA_REFRESH_SECRET="..."
supabase secrets set ORDER_REMINDER_SECRET="..."
supabase secrets set ORDER_REMINDER_RECIPIENTS_JSON='[{"name":"Troy","email":"...","link":"https://..."},{"name":"Shane","email":"...","link":"https://..."},{"name":"Aislinn","email":"...","link":"https://..."},{"name":"Jess","email":"...","link":"https://..."}]'
supabase secrets set ORDER_REMINDER_RECIPIENTS_B64="BASE64_ENCODED_JSON_RECIPIENT_ARRAY"
supabase secrets set RESEND_API_KEY="..."
supabase secrets set ORDER_REMINDER_FROM="FFF <notifications@example.com>"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="..."
```

TVmaze is the active primary provider. It is public HTTPS, needs no API key, and remains behind the Edge Function boundary. `IMDB_TIMEOUT_MS` is retained as the shared primary-provider timeout knob despite the historical prefix.

## Weekly Metadata Refresh

The repository includes a schedule-ready weekly metadata refresh workflow:

- Edge Function: `supabase/functions/metadata-refresh`
- Migration helpers: `admin_list_metadata_refresh_candidates` and `admin_update_show_metadata`
- Schedule template: `supabase/schedules/metadata-refresh-weekly.sql`

The refresh function is trusted-schedule-only, rejects ordinary browser invocation, accepts either service-role authorization or `METADATA_REFRESH_SECRET`, processes active canonical shows that are not administratively removed, refreshes records whose last successful metadata refresh is at least seven days old, uses TVmaze first, invokes TVDB only as strict fallback enrichment with an explicit matching IMDb cross-reference, retains existing values when upstream temporarily fails, updates metadata atomically per show, refreshes posters only when needed, limits concurrency by processing sequentially with a bounded batch size, uses bounded timeouts, and logs only sanitized summary counts.

After Supabase is linked and secrets are configured, apply scheduling deliberately. Replace placeholders in `supabase/schedules/metadata-refresh-weekly.sql`; do not commit real schedule secrets or service-role keys.

## Weekly Order Reminders

The repository includes a schedule-ready weekly ordering reminder workflow:

- Edge Function: `supabase/functions/weekly-order-reminders`
- Migration helper: `admin_list_order_reminder_recipients`
- Schedule template: `supabase/schedules/weekly-order-reminders.sql`

The reminder function is trusted-schedule-only, rejects ordinary browser invocation, accepts either service-role authorization or `ORDER_REMINDER_SECRET`, reads recipient names, email addresses, and personal bearer links from `ORDER_REMINDER_RECIPIENTS_B64` or the `ORDER_REMINDER_RECIPIENTS_JSON` Supabase secret, and sends through Resend using `RESEND_API_KEY` and `ORDER_REMINDER_FROM`. It queries active users and skips any user who has ranked every active, non-removed show that has at least one active nomination. The template deliberately sends no email when there is nothing for that user to order.

The schedule template runs at `02:00 UTC` every Wednesday, which is `12:00 AEST`. During Sydney daylight saving time, this fixed AEST schedule fires at `13:00 AEDT`.

## RPC Contract

Browser-callable RPCs all accept `p_link_token` and validate it internally:

- `resolve_current_user(text)`
- `list_catalogue(text)`
- `nominate_imdb_show(text, text, text, integer, text, text, text, jsonb)`
- `withdraw_nomination(text, uuid)`
- `admin_remove_show(text, uuid)`
- `get_user_order(text)`
- `replace_user_ranking(text, uuid[])`
- `get_board(text)`
- `get_board_revision(text)`

Administrator/database helpers are not granted to `anon`:

- `admin_create_known_user(text, boolean, text)`
- `admin_rotate_user_link(uuid, text)`
- `admin_revoke_user_link(uuid)`
- `admin_activate_known_user(uuid)`
- `admin_deactivate_known_user(uuid)`
- `admin_restore_show(uuid, text)`
- `admin_record_show_poster_result(uuid, text, text, text)`
- `admin_list_metadata_refresh_candidates(integer)`
- `admin_update_show_metadata(uuid, jsonb)`
- `admin_list_order_reminder_recipients()`

## Current Remote Deployment Status

The local repository is linked to Supabase project `ckzarkkjosckoegswakf` (`FFF`). Local migrations through `20260718000100` have been applied to the remote project. The `show-posters` Storage bucket is deployed as public-read without a broad listing policy, Realtime is configured only for `public.board_revision_public`, and the `imdb`, `metadata-refresh`, and `weekly-order-reminders` Edge Functions are deployed with JWT pre-verification disabled so their code-level token checks own authorization. `ALLOWED_ORIGINS` must include the GitHub Pages origin plus any LAN origins used for local live testing; loopback localhost origins are allowed in code. Weekly metadata refresh is not currently scheduled. Weekly order reminders are scheduled for Wednesday 12:00 AEST, but require Resend email secrets before they can send.

Remaining manual deployment work:

- TVmaze primary provider is configured in code and requires no API key or URL-template secrets.
- Optional TVDB provider secrets/templates are not configured.
- The first launch users have been created in the remote database. Share secret user links out-of-band; do not record raw tokens in source or documentation.
- The weekly metadata-refresh cron schedule has not been configured.
- Resend email secrets have not been configured for weekly order reminders.

## Verification

Local checks that do not require a linked Supabase project:

```bash
node --check app.js
node --check store.js
node --check providers.js
node --check ranking.js
node --check scripts/verify-contracts.mjs
node scripts/verify-contracts.mjs
```

Edge Function syntax can be checked when Deno is installed:

```bash
deno check supabase/functions/imdb/index.ts
deno check supabase/functions/metadata-refresh/index.ts
deno check supabase/functions/weekly-order-reminders/index.ts
```

Remote deployment can be verified with `npx.cmd supabase migration list`, `npx.cmd supabase functions list`, focused `supabase db query --linked` checks for Storage/Realtime/cron, and live Edge Function smoke calls.
