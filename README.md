# Wire Wednesday

A mobile-first shared TV catalogue, private participant orders, and a strict aggregate watch sequence. The existing `fff-api` Worker serves [wirewednesday.nissen.nexus](https://wirewednesday.nissen.nexus) using Static Assets, existing D1 `fff`, and R2 `fff-artwork`. The authorised production cutover completed on 11 October 2026; real participant Google sign-in acceptance remains manual.

## Access and privacy

Google sign-in completely replaces participant links. An operator can pre-approve each known Google email against an exact existing participant ID in D1 before launch. The first valid Gmail/Google Workspace sign-in atomically binds that participant to Google's stable `sub` and consumes the pre-approval. Future authentication uses only the established `sub`, even if the email changes. Other Google accounts need the existing operator-reviewed subject approval because Google is not authoritative for their current mailbox ownership. OAuth Test User status alone never grants Wire Wednesday access.

Only active existing participants with enabled subject mappings can access the application, its modules, artwork or data. Unknown accounts are rejected. No public registration, automatic participant creation, automatic identity reassignment, legacy-link fallback, cross-origin API access or browser-supplied actor IDs exist. Approval emails and mappings remain server-side in D1, absent from frontend assets and public responses. Emails use exact trim/lowercase comparison, without alias or dot rewriting; no hashing secret is added to the existing D1-only approval model. Historical link columns remain inert in D1 to avoid destructive schema rebuilding. See the [initial setup procedure](cloudflare/DEPLOYMENT.md#establishing-and-maintaining-participant-mappings) for a four-participant pre-approval template, revocation and recovery.

Google credentials are verified server-side with `jose`, including signature, issuer, audience, expiry, verified email and a single-use browser-bound nonce. The anonymous sign-in page uses Google's official responsive `outline_dark` button following CanBan's current `frontend/SignIn.tsx`. Its Google SDK is the sole external script allowed on that document. The authenticated app uses locally packaged Lucide and Lexend Deca, with no external scripts. Existing fonts/icons retain their visual system.

Sessions use random opaque cookies, storing only hashes in D1. Production cookies are HttpOnly, Secure and host-only; remembered login lasts at most 30 days. Unchecked remember uses a browser-session cookie with a 12-hour server expiry. Logout deletes the session. Approval changes invalidate sessions immediately; deactivation blocks them on every request. Login/logout clears other tabs, and a server guard rejects stale-tab writes after an account change. Mutations require the configured same origin. Private responses are no-store, and referrers are suppressed. The operator accepted the DNS, HTTPS, cache-rule and logging inspection gates for this cutover; live response security headers were verified.

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

Canonical identity is always IMDb. The browser calls Worker `/v1/metadata` for search, lookup and enrolment. TVmaze is the primary television metadata provider and requires no API key. The Worker searches `https://api.tvmaze.com/search/shows?q={query}`, resolves exact canonical IMDb IDs with `https://api.tvmaze.com/lookup/shows?imdb={imdbId}`, retains the numeric TVmaze show ID, retrieves episodes from `https://api.tvmaze.com/shows/{tvmazeId}/episodes`, and retrieves card artwork from `https://api.tvmaze.com/shows/{tvmazeId}/images`. When configured, fanart.tv API v3.2 is the preferred card artwork source: use TVmaze’s `externals.thetvdb` (or the retained TheTVDB record ID), accept native 1000×185 `tvbanner` images, and choose the first suitable result in provider order. No fanart.tv key reaches the browser. Without suitable fanart.tv artwork, TVmaze card artwork selection considers usable `background` originals and `banner` originals (or medium banners), then selects the horizontal image closest to FFF's panoramic card-art ratio. `main: true` breaks an aspect-ratio tie, followed by source resolution. The normal portrait poster and then the local placeholder remain fallbacks.

Canonical identity comes from TVmaze's `externals.imdb` field. Search results without an IMDb ID are rejected. Supported normalized metadata fields are canonical IMDb ID, title, premiered year, ended year, TVmaze type, series status, TVmaze rating, season count when available, episode count, cumulative runtime when every TVmaze episode has an explicit runtime, poster source URL, selected card artwork URL/type/dimensions, background URL and dimensions when horizontal artwork exists, source provider identity, TVmaze record ID, and retrieval timestamp. The app does not store or display synopsis, genre, or estimated cumulative runtime.

TVDB is only a fallback enrichment source after TVmaze successfully resolves canonical IMDb identity. It must not appear in the Add input UI, search choices, duplicate detection, canonical identity logic, show URLs, user-entered references, or ordinary provider status labels. TVDB may fill only missing supported metadata: series status, ended year, season count, total episode count, exact provider-supplied total runtime, poster source when TVmaze has no usable poster, background metadata when TVmaze has no usable background, and TVDB record ID. TVDB output is discarded unless it includes an explicit IMDb cross-reference that normalizes exactly to the canonical IMDb ID. TVDB is not used when the TVmaze request fails, and it never overwrites valid TVmaze values.

TVmaze data is licensed under CC BY-SA. The current app shell does not render provider attribution copy in the Add UI.

Show cards stay restrained: stored card artwork when available, title linked to IMDb when available, commenced year or ended year range, season and episode count when known, exact total runtime when known, rank or aggregate position, and required actions. The List view alone overlays TVmaze's `/10` rating as five Straw SVG stars, rounded to the nearest half-star. Runtime is labelled "Total Runtime" and is displayed only when exact/provider-supplied; estimated cumulative runtime is not derived or shown. Nominate, Rank, List, and Watch all use the same selected card-art asset and background renderer with strong dark text shadows; poster fallback behaviour remains intact when no horizontal artwork exists. On load, rendered card backgrounds are checked through the metadata boundary for preferred fanart.tv artwork, then TVmaze fallback. Existing retained fanart.tv artwork remains available during provider failures or removals. Administrators can use the icon-only Edit button beside the icon-only Remove control on catalogue cards to choose from all suitable banners in an accessible modal. Saving updates canonical artwork across Nominate, Rank, List and Board/Watch without changing existing show metadata, nominations or rankings. Selecting artwork for an unenrolled search result creates an inactive canonical show row without nominating it. Manual selections survive audits, weekly metadata refresh and later nominations even if the provider removes the banner. Previews and selected bytes use authenticated R2 delivery. Each page links once to fanart.tv and CC BY 3.0 below its final card only when loaded fanart.tv artwork is displayed; an empty Rank page has no credit. The picker retains provider/license information, uses keyboard-operable banner buttons with a selected highlight, and provides Save and Retry actions. Show cards experimentally use an exact responsive 200:37 aspect ratio. Native fanart.tv banners are contained without cropping or an artwork overlay; strong dark text shadows preserve readable lettering on light artwork. Nominate, List and Watch stack title, year, seasons/episodes and runtime on four lines at all viewport widths. Mobile uses tighter line spacing while preserving font sizes and the card ratio. Nominate/List card text has an additional 0.5rem inset; Watch retains its position column. Long titles truncate (full titles remain in accessible link names and title tooltips); long mobile metadata lines can scroll horizontally without wrapping. Persistent catalogue cards show no Nominate/Withdraw buttons; search results retain nomination management. Only administrators see Edit and Remove, both matching 32px icon controls with dark grey backgrounds and white icons. List retains its 32px Up/Down/Cross controls and behaviour, using that same dark grey. List rating stars share the title line. The header has a temporary hamburger account popover containing Sign out, ready for its trigger icon to be replaced with an avatar.

## Local development and verification

Run `node cloudflare/scripts/prepare-assets.mjs` then `node scripts/artwork-browser-test.mjs` for isolated fictional-API banner picker, attribution, text-shadow readability, account popover and responsive card checks at 320, 390, 768 and 1440px. Backend manual-choice preservation is covered by `node cloudflare/tests/fanart.test.mjs`.

Use existing npm tooling; no frontend framework or transpilation is introduced. `jose` 6.2.12 verifies Google credentials in the Worker; `lucide` 1.55.0 and `@fontsource/lexend-deca` 5.3.0 are pinned packaging inputs. Asset preparation copies 19 explicitly allowlisted files, including their licenses, into ignored `cloudflare/public/`. It never publishes the repository or environment files.

The ignored root `.env.vars` is the local Google and fanart.tv configuration source. Add `FANART_TV` with your fanart.tv project API key there; the existing explicit `--env-file .env.vars` loads it. It stays server-side. Discovery (including empty/404 results) is cached in D1 for 24 hours; transient failures pause requests for at least five minutes and respect bounded `Retry-After`. Downloaded images are retained in R2 under immutable source-derived keys. No new dependency is needed. Start Wrangler with that explicit file:

```powershell
npm ci --ignore-scripts
node cloudflare/scripts/prepare-assets.mjs
npx.cmd wrangler d1 migrations apply DB --local --persist-to .wrangler/hosting-local
npx.cmd wrangler dev --local --local-upstream 127.0.0.1:3000 --env-file .env.vars --port 3000 --var APP_ORIGIN:http://127.0.0.1:3000 --var LOCAL_DEMO:true --persist-to .wrangler/hosting-local --log-level warn
```

Visit `http://127.0.0.1:3000/?demo=1` for synthetic local demo data. Demo mode is restricted to an explicitly enabled loopback origin; it is unavailable on production. Plain Python serving no longer represents authenticated hosting. Add the exact localhost origin to Google's authorised JavaScript origins for real local sign-in; use only separately approved synthetic local mappings. Do not copy production data into local tests.

Run:

```powershell
npm test
npm run test:browser # requires the local Wrangler above
npm run build
npm run deploy:dry-run
npm run verify:privacy
```

The auth tests self-host local Worker handlers with disposable local D1/R2, signed mock Google identities and mocked TVmaze. With local Wrangler running, also run `node scripts/hosting-browser-test.mjs` and `node scripts/placement-browser-test.mjs`. Optional `node scripts/review-google-button.mjs` reads only the public client ID from `.env.vars`, serves local bytes and fetches the public Google SDK in an anonymous context to review the official button at 320/360/390/768/1440px; it never signs in or contacts production APIs. Its artifacts are ignored.

## Operations and deployment

See [cloudflare/DEPLOYMENT.md](cloudflare/DEPLOYMENT.md) for Google setup, operator-only pre-approval/mapping review, forward migration, cutover, verification and rollback. Establish pre-approvals before announcing sign-in availability; no prior participant sign-in is needed for Gmail/Workspace accounts. Third-party email accounts require reviewed subject mappings. workers.dev and version preview URLs are disabled and return no application. GitHub Pages retirement remains a separate operational follow-up; it is not a runtime fallback. Old credentials have no meaning in the new application.

`wrangler.jsonc` retains `0 2 * * 3` for weekly metadata refresh. The final deployment activates the reviewed metadata handler; live schedule registration is verified. Wednesday 02:00 UTC is 12:00 AEST / 13:00 AEDT in Sydney. No production scheduled event was invoked; the next scheduled execution, 14 October 2026, remains to be observed privately. Weekly outstanding-ranking reminder code and the queued fanart fix were deployed on 11 October 2026 in version `224c1e2f-6cb1-4913-96f2-8ef2750b8443`; reminders remain disabled. The registered additional `0 1 * * 3` event and Sydney timezone gate select Wednesday noon across DST, using native Cloudflare email and private D1 send claims. Run `npm run test:reminders` locally; production migration 0007, four verified destinations and explicit activation approval remain required. See [the reminder activation runbook](cloudflare/DEPLOYMENT.md#weekly-ranking-reminders--deployed-not-activated). Cloudflare is the sole backend authority. Retired Supabase repository tooling has been removed; hosted infrastructure is outside ordinary app operations.

Production version `18d48994-4cc0-4a46-ba5e-00e4bb7c47b3` passed safe anonymous acceptance: DNS, trusted hostname certificate, Google button rendering, security headers, private-module/API/artwork denial, legacy authentication rejection and alternate URL closure. Four existing participants (one administrator), 33 shows, 41 nomination rows, 117 ranking rows and four unclaimed preapprovals were preserved exactly. All 48 R2 objects match their original keys, metadata and SHA-256 content hashes. Recovery artifacts remain private locally and in approved OneDrive storage. Each participant must still perform their own verified Google sign-in to check identity, role, retained personal data and session behaviour; no subjects were fabricated. See the deployment runbook for recovery and outstanding checks.
