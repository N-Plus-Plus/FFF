# Wire Wednesday

A mobile-first shared TV catalogue, private participant orders, and a strict aggregate watch sequence. The existing `fff-api` Worker is prepared to serve `https://wirewednesday.nissen.nexus` using Static Assets, existing D1 `fff`, and R2 `fff-artwork`. This is uncommitted local preparation; no production cutover has occurred.

## Access and privacy

Google sign-in completely replaces participant links. Only an active existing participant with an enabled, explicit Google-subject mapping can access the application, its modules, artwork or data. No public registration, automatic participant creation, email-only matching, legacy-link fallback, cross-origin API access or browser-supplied actor IDs exist. Historical link columns remain inert in D1 to avoid destructive schema rebuilding.

Google credentials are verified server-side with `jose`, including signature, issuer, audience, expiry, verified email and a single-use browser-bound nonce. The anonymous sign-in page uses Google's official responsive `outline_dark` button following CanBan's current `frontend/SignIn.tsx`. Its Google SDK is the sole external script allowed on that document. The authenticated app uses locally packaged Lucide and Lexend Deca, with no external scripts. Existing fonts/icons retain their visual system.

Sessions use random opaque cookies, storing only hashes in D1. Production cookies are HttpOnly, Secure and host-only; remembered login lasts at most 30 days. Unchecked remember uses a browser-session cookie with a 12-hour server expiry. Logout deletes the session. Approval changes invalidate sessions immediately; deactivation blocks them on every request. Mutations require the configured same origin. Private responses are no-store, and referrers are suppressed. Operator logging/cache review is still required before deployment.

The session selects one existing participant ID. Their nominations, rankings, admin status and history stay attached to that ID. Other participants' personal order and identities are not returned. Inactive or unapproved participants' retained ballots still influence aggregate order, while only active approved participants count toward confirmation.

## Product Rules

Canonical shows are deduplicated by normalized IMDb title ID. A valid canonical IMDb title ID is mandatory for every enrolled show. The app accepts television series, miniseries, reality series, animation series, and documentary series. It rejects individual episodes, television movies, and one-off television specials.

Multiple users may nominate the same canonical IMDb show. A valid nomination by an active user makes the show active immediately; there is no pending, moderation, or approval queue. A user can have only one active nomination for a show; duplicate active nominations return an already-nominated result. Withdrawing a nomination affects only that user, removes that show from that user's current ranking, resequences their remaining ranked shows, and preserves canonical show rows plus historical nomination timestamps.

Shows remain active while at least one nomination is active. When the final active nomination is withdrawn, the show leaves Nominate, Rank, List, and Watch responses automatically and all current ranking rows for that show are cleared. If nominated again later, the existing canonical row is reused and reactivated, but prior ranking positions are not restored; every user sees it as unranked until they rank it again.

Administrators can remove an active show from the ordinary app. Removal is reversible, records who removed it and when, and hides the show from Nominate, Rank, List, Watch, and search-as-catalogue results. There is no in-app removed-show history or restore UI.

Restoration remains an operator-controlled database operation, with no in-app restore UI. Preserve established restoration semantics: clear the removal marker, withdraw prior nominations and clear current ranking rows so reactivation starts unranked.

## Ordering and Board

Rank contains only shows the current user has not ranked. With more than one, the user chooses a show before entering placement mode; its full show card is the actual centre element between clipped compact-row lanes above and below it. A vertical swipe transfers one compact row across that centre boundary at a time, while the proposed rank shows where confirmation will insert the show, including before #1 and after the final item. The List tab contains the current ranked sequence and retains arrow controls, removal, and secondary tap-hold reordering for small corrections. Newly nominated active shows remain unranked for every user and do not create ranking rows until explicitly placed. Ranked positions are strict, unique, contiguous, and transactionally replaced through Worker `/v1/ranking`.

The app persistently reminds valid users when they have active unranked shows: the Rank tab shows a count, while a non-blocking banner with a direct Rank action remains visible across Nominate, List, and Watch. It is deliberately hidden while Rank is open. The banner has a dismiss control, and dismissal lasts only for the current browser session through `sessionStorage`. The reminder returns in a new browser session or when session state is cleared.

The current aggregate strategy is `sequential-irv-v1`, implemented in `ranking.js` and the Cloudflare Worker. Each user's ranked queue is a partial ranked-choice ballot. Unranked shows are absent from that user's ballot and never count as a synthetic last-place preference.

The Board candidate set contains active, non-removed shows with at least one retained explicit ranking. Rankings retained from inactive users continue contributing to the election, but inactive users do not count toward confirmation and are not included in the displayed "ranked by" count.

The Board sequence is produced by repeated instant-runoff elections. The first election chooses first place from all eligible candidates. That winner is removed, the original ballots are filtered to the remaining candidates, and a fresh instant-runoff election chooses the next position. This repeats until every eligible candidate has a strict position. Exhausted ballots are ignored for the current election.

The ordinary Board displays the aggregate sequence without aggregate scores or algorithm explanation. A card with fewer than four active-user rankings displays a `Votes: N of 4` badge in its top-right corner; entries that do not yet have one vote from every active user remain in their aggregate position but render at reduced opacity.

Confirmation is dynamic. For every Board calculation:

```text
activeUserCount = participants where is_active = true and Google approval is enabled
confirmed = activeUserCount > 0 and rankedActiveUserCount >= activeUserCount
```

Inactive users' historical rankings contribute to aggregate order, but not to the active-user confirmation denominator or displayed participation count. Reactivating a user may make previously confirmed shows unconfirmed until that user ranks them; deactivating a user may make shows confirmed without deleting that user's retained ranking contribution.

Aggregate ties are broken deterministically by canonical IMDb numeric value. Remove every non-numeric character from the IMDb ID and compare the remaining numeric strings without floating-point conversion. The higher numeric IMDb value wins winner ties, and the lower numeric IMDb value loses elimination ties first. Matching numeric components across distinct records are a data-integrity failure.

## Metadata and Cards

Canonical identity is always IMDb. The browser calls Worker `/v1/metadata` for search, lookup and enrolment. TVmaze is the primary television metadata provider and requires no API key. The Worker searches `https://api.tvmaze.com/search/shows?q={query}`, resolves exact canonical IMDb IDs with `https://api.tvmaze.com/lookup/shows?imdb={imdbId}`, retains the numeric TVmaze show ID, retrieves episodes from `https://api.tvmaze.com/shows/{tvmazeId}/episodes`, and retrieves card artwork from `https://api.tvmaze.com/shows/{tvmazeId}/images`. Card artwork selection considers usable `background` originals and `banner` originals (or medium banners), then selects the horizontal image closest to FFF's panoramic card-art ratio. `main: true` breaks an aspect-ratio tie, followed by source resolution. The normal portrait poster and then the local placeholder remain fallbacks.

Canonical identity comes from TVmaze's `externals.imdb` field. Search results without an IMDb ID are rejected. Supported normalized metadata fields are canonical IMDb ID, title, premiered year, ended year, TVmaze type, series status, TVmaze rating, season count when available, episode count, cumulative runtime when every TVmaze episode has an explicit runtime, poster source URL, selected card artwork URL/type/dimensions, background URL and dimensions when horizontal artwork exists, source provider identity, TVmaze record ID, and retrieval timestamp. The app does not store or display synopsis, genre, or estimated cumulative runtime.

TVDB is only a fallback enrichment source after TVmaze successfully resolves canonical IMDb identity. It must not appear in the Add input UI, search choices, duplicate detection, canonical identity logic, show URLs, user-entered references, or ordinary provider status labels. TVDB may fill only missing supported metadata: series status, ended year, season count, total episode count, exact provider-supplied total runtime, poster source when TVmaze has no usable poster, background metadata when TVmaze has no usable background, and TVDB record ID. TVDB output is discarded unless it includes an explicit IMDb cross-reference that normalizes exactly to the canonical IMDb ID. TVDB is not used when the TVmaze request fails, and it never overwrites valid TVmaze values.

TVmaze data is licensed under CC BY-SA. The current app shell does not render provider attribution copy in the Add UI.

Show cards stay restrained: stored card artwork when available, title linked to IMDb when available, commenced year or ended year range, season and episode count when known, exact total runtime when known, rank or aggregate position, and required actions. The List view alone overlays TVmaze's `/10` rating as five Straw SVG stars, rounded to the nearest half-star. Runtime is labelled "Total Runtime" and is displayed only when exact/provider-supplied; estimated cumulative runtime is not derived or shown. Nominate, Rank, List, and Watch all use the same selected card-art asset and background renderer with a dark text overlay; poster fallback behaviour remains intact when no horizontal artwork exists. On load, rendered card backgrounds are checked against the current TVmaze selection, so stale persisted artwork—including an older background-first choice—is safely replaced through the metadata boundary.

## Local development and verification

Use existing npm tooling; no frontend framework or transpilation is introduced. `jose` 6.2.12 verifies Google credentials in the Worker; `lucide` 1.55.0 and `@fontsource/lexend-deca` 5.3.0 are pinned packaging inputs. Asset preparation copies 19 explicitly allowlisted files, including their licenses, into ignored `cloudflare/public/`. It never publishes the repository or environment files.

The ignored root `.env.vars` is the local Google configuration source. Start Wrangler with that explicit file:

```powershell
npm ci --ignore-scripts
node cloudflare/scripts/prepare-assets.mjs
npx.cmd wrangler d1 migrations apply DB --local --persist-to .wrangler/hosting-local
npx.cmd wrangler dev --local --local-upstream 127.0.0.1:3000 --env-file .env.vars --port 3000 --var APP_ORIGIN:http://127.0.0.1:3000 --var LOCAL_DEMO:true --persist-to .wrangler/hosting-local --log-level warn
```

Visit `http://127.0.0.1:3000/?demo=1` for synthetic local demo data. Demo mode is restricted to an explicitly enabled loopback origin; it is unavailable on production. Plain Python serving no longer represents authenticated hosting. Add the exact localhost origin to Google's authorised JavaScript origins for real local sign-in; use only separately approved synthetic local mappings. Do not copy production data into local tests.

Run:

```powershell
node scripts/verify-contracts.mjs
node cloudflare/tests/session-hash.test.mjs
node cloudflare/tests/hosting.test.mjs
node cloudflare/tests/auth-browser.test.mjs
```

The auth tests self-host local Worker handlers with disposable local D1/R2, signed mock Google identities and mocked TVmaze. With local Wrangler running, also run `node scripts/hosting-browser-test.mjs` and `node scripts/placement-browser-test.mjs`. Optional `node scripts/review-google-button.mjs` reads only the public client ID from `.env.vars`, serves local bytes and fetches the public Google SDK in an anonymous context to review the official button at 320/360/390/768/1440px; it never signs in or contacts production APIs. Its artifacts are ignored.

## Operations and deployment

See [cloudflare/DEPLOYMENT.md](cloudflare/DEPLOYMENT.md) for Google setup, operator-only mapping review, forward migration, cutover, verification and rollback. Establish mappings before announcing sign-in availability. GitHub Pages and workers.dev can be retired during the approved cutover; old credentials have no meaning in the new application.

`wrangler.jsonc` retains `0 2 * * 3` for weekly TVmaze metadata refresh. Its live status is unconfirmed because it is not currently visible in Cloudflare. Deployment can register this trigger and enable future scheduled D1/R2 writes; approve that explicitly. This is not an ordering-reminder schedule. The retained Supabase source is historical and must not be deployed as an alternate authentication path. Any historical reminder service must have its participant-link content retired or replaced with the plain canonical sign-in URL before cutover; whether to keep/rework that service requires operator review.
