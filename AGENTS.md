# AGENTS.md: Project Guidance

Read this file before every coding, maintenance, review, investigation, or documentation pass in this project.

This project is a Git repository and may be treated as a normal Git worktree for inspection and version-control operations.

`AGENTS.md` is the root entry guide for this project.

This file is the root standing guide for agents working in the repository. It should remain concise, current, and useful as a source of stable project context. Future prompts may rely on it without restating information already recorded here.

## 1. Authority and interpretation

Follow instructions in this order:

1. The user's current prompt defines the immediate task and scope.
2. This file defines standing project rules, safety boundaries, and working practices.
3. More specialised project documents govern their stated areas when they exist.
4. The current implementation is evidence of actual behaviour when documentation is incomplete or stale.

A specific user instruction may deliberately change an established project rule. Treat that as a scoped decision only when it is explicit and unambiguous. Never interpret a vague request as permission for destructive work, broad redesign, data loss, secret exposure, or an unrelated architectural change.

Do not ask the user to repeat context already stated accurately in this file or another clearly authoritative project document.

## 2. Project state

The project is an established static web app with live Cloudflare Worker hosting and Google-only participant authentication.

| Project fact | Current state |
| --- | --- |
| Project name | Wire Wednesday (internal repository/resources remain FFF) |
| Product purpose | Mobile-first shared TV show catalogue, private personal ordering, and strict aggregate Board sequence |
| Intended users | Existing known participants pre-approved in D1, then bound to verified Google subjects; no registration |
| Project maturity | Established static app with Cloudflare backend |
| Application shape | Static HTML/CSS/JavaScript ES modules served by existing Cloudflare Worker Static Assets |
| Languages and runtime | Browser JavaScript, HTML, CSS; no build step |
| Frameworks and major libraries | Raw browser JS; Worker `jose` 6.2.12 verifies Google credentials; pinned Lucide 1.55.0 and Lexend Deca 5.3.0 packaged locally; Playwright/Wrangler development tools |
| Package manager | npm, for development-only tooling |
| Persistence or database | Cloudflare D1 (`fff`, Oceania) is the production store through Worker `fff-api`. Opt-in localStorage demo with `?demo=1` |
| External services | Cloudflare Workers, D1, R2, and Cron Trigger; TVmaze primary television metadata, fanart.tv preferred banners |
| Deployment target | Live existing Cloudflare `fff-api` at `https://wirewednesday.nissen.nexus`; workers.dev/previews disabled. GitHub Pages retirement is pending |
| Source-control policy | Git worktree on `main` with `origin` at `https://github.com/N-Plus-Plus/FFF.git`; preserve unrelated user changes and do not push, commit, or rewrite history unless explicitly requested |
| Test framework | Node assertion contracts and disposable Cloudflare D1/R2 fixtures; Playwright authentication, artwork, hosting and placement checks |
| Build, run, and verification commands | See project commands |

## 3. Start-of-pass procedure

Before changing files:

1. Read this file completely.
2. Read the user's prompt closely and identify the exact requested outcome.
3. Inspect the repository root and determine whether the project is blank, scaffolded, or established.
4. Check for relevant manifests and guidance, such as `README.md`, package manifests, lock files, configuration examples, source directories, tests, and specialised documentation.
5. Inspect only the files and modules relevant to the requested task.
6. Identify safety-sensitive resources, including live databases, user files, credentials, network shares, production services, large downloads, and destructive commands.
7. Determine the smallest implementation scope that fully satisfies the request.
8. Choose verification proportionate to the change.
9. Check whether the work will require an update to this file or another authoritative document.

Do not begin with a full repository audit, full test suite, dependency upgrade, broad refactor, or new framework unless the task requires it.

When the repository is blank or nearly blank:

- Do not assume a language, framework, package manager, database, deployment platform, source-control workflow, or directory layout.
- Do not create speculative infrastructure.
- Establish only the minimum structure required by the user's current request.
- Record newly established project facts in this file before finishing the pass.

## 4. Project navigation

Maintain this section as the project develops. It should help a future agent find the owning files without reading the entire repository.

### Key files and directories

| Area | Owning files or directories |
| --- | --- |
| Application entry point | `index.html` |
| User interface | `style.css`, DOM rendering in `app.js`; canonical logo/favicon source `assets/wire-wednesday.png`, packaged at `/wire-wednesday.png`; account PNGs in `assets/avatars/`, private participant mapping in `cloudflare/src/avatars.js` |
| Domain or business rules | Board aggregate strategy and IMDb tie-breaking in `ranking.js`; ranking sequence orchestration in `app.js` |
| Persistence and data access | Same-origin session adapter in `store.js`/`api.js`; authoritative D1 schema in `cloudflare/migrations/` |
| API or service boundaries | `cloudflare/src/index.js` owns API/metadata/artwork/Cron dispatch; `cloudflare/src/ranking-reminders.js` owns private weekly email claims/delivery; `cloudflare/src/show-visibility.js` shares catalogue/Order/reminder visibility; `cloudflare/src/fanart.js` owns banner discovery/cache/selection; `cloudflare/src/google-auth.js` owns Google verification and sessions; `providers.js` owns frontend metadata normalization |
| Cloudflare backend | `wrangler.jsonc`, D1 schema in `cloudflare/migrations/`, Worker API in `cloudflare/src/index.js` |
| Configuration | `config.js` selects same-origin delivery; `wrangler.jsonc` owns resources/origin/Cron; ignored root `.env.vars` is local Google/fanart.tv configuration |
| Shared utilities | Small ES modules in `store.js`, `providers.js`, and `ranking.js` |
| Tests | Contract/demo checks in `scripts/verify-contracts.mjs`; disposable signed-Google/D1/R2 tests in `cloudflare/tests/`; actual Wrangler/placement checks in `scripts/`; anonymous official-button review in `scripts/review-google-button.mjs` |
| Build and deployment | `cloudflare/scripts/prepare-assets.mjs` copies an explicit public-file allowlist; Wrangler serves it through existing `fff-api` |
| Further documentation | `README.md`; `cloudflare/DEPLOYMENT.md` for delivery, privacy, cutover and rollback |

Update this map when files gain clear ownership, move, or are retired. Prefer direct ownership guidance over a long inventory of every file.

### Authoritative documents

Add specialised documents only when they have a clear purpose. Common examples include:

- `README.md` for user-facing purpose, setup, and ordinary operation.
- `DESIGN.md` for product behaviour and requirements.
- `STYLE.md` for visual and interaction rules.
- `ARCHITECTURE.md` for system structure and major boundaries.
- `PATTERNS.md` for shared implementation patterns.
- `TESTING.md` for test policy and commands.
- `SECURITY.md` for security assumptions and reporting.
- `docs/` for deeper subsystem references.

Do not create all of these by default. Create a document only when the project has enough stable information to justify it.

## 5. Documentation self-healing

Documentation maintenance is part of implementation work.

During every pass, compare the relevant documentation with the behaviour and structure being inspected or changed. Update an authoritative document when the pass makes it provably incorrect or materially incomplete.

This includes changes to:

- architecture or module ownership
- product behaviour
- public interfaces or data contracts
- routes, commands, or configuration
- persistence or schema
- security and safety assumptions
- external dependencies
- deployment or operating procedures
- testing policy
- important project navigation
- explicit non-goals or retired behaviour

When updating documentation:

- Edit the existing authoritative section instead of appending a conflicting rule elsewhere.
- Remove or replace stale guidance.
- Preserve intentional historical records by clearly labelling them as historical.
- Do not turn this file into a changelog or implementation diary.
- Do not add speculative claims.
- Keep detail in specialised documents when it would make this root guide unwieldy.
- In a read-only or audit-only task, report material drift instead of editing unless documentation changes are authorised.

Before finishing every pass, check whether `AGENTS.md` itself is stale, incorrect, or materially incomplete because of the work performed. Update it in the same pass when necessary, even when the user did not separately request documentation maintenance.

## 6. Scope and implementation discipline

Implement the narrow task requested.

- Prefer targeted, low-risk changes over broad refactors.
- Do not add adjacent features merely because they may be useful later.
- Do not redesign established behaviour incidentally.
- Do not perform unrelated cleanup, dependency upgrades, formatting sweeps, or file moves.
- Reuse established patterns and owning modules before creating parallel implementations.
- Centralise behaviour that must remain consistent across interfaces.
- Keep pure domain rules separate from transport, persistence, and presentation where the project architecture supports that separation.
- Preserve existing public behaviour unless the task explicitly owns a contract change.
- Report assumptions, limitations, and deferred work honestly.

When the project is still blank, avoid building abstractions for hypothetical future requirements. Introduce structure only when it protects a real boundary or supports the requested implementation.

## 7. Safety and data preservation

Treat user data, production data, credentials, and external systems conservatively.

Unless explicitly authorised:

- Do not delete, overwrite, migrate, repair, regenerate, or bulk-modify live data.
- Do not run destructive database, filesystem, cloud, or API operations.
- Do not modify source assets merely to simplify development.
- Do not connect tests to live services or real user accounts.
- Do not expose credentials, tokens, private paths, personal data, stack traces, or raw sensitive payloads.
- Do not place secrets in source files, logs, URLs, fixtures, screenshots, generated reports, or documentation.
- Do not bypass path-boundary checks or validation guards.
- Do not claim an operation is read-only unless its complete execution path is read-only.

Use temporary fixtures, disposable test data, mocks, or copied snapshots for verification where appropriate.

Before relying on an external resource, perform a cheap and bounded preflight where practical. Distinguish unavailable environments from missing individual resources, and do not turn one environmental failure into a large set of false findings.

## 8. Dependencies and toolchain

Keep dependencies deliberate and minimal.

Before adding or changing a dependency:

1. Identify the concrete requirement it satisfies.
2. Check whether the existing stack or standard library already provides the capability.
3. Confirm compatibility with the established runtime and toolchain.
4. Avoid installing competing alternatives.
5. Avoid unrelated upgrades.
6. Record any material dependency decision in this file or the appropriate specialised document.
7. Report the exact dependency change and purpose.

Do not establish a new runtime, framework, package manager, database, container platform, or build system without a task-driven reason.

Inspect existing manifest scripts before running them. Do not assume a command is safe, cheap, offline, or non-destructive merely because its name suggests that it is.

## 9. Source control

First determine whether the project is actually under source control.

- Do not assume Git is present.
- Treat the project as an established Git worktree. Use `git status`, `git diff`, and history commands when they are relevant to the task; do not commit, push, or alter remotes unless requested.
- When Git is present, preserve unrelated user changes and do not discard or rewrite them.
- Never use destructive source-control commands merely to obtain a clean working tree.
- Report changed files explicitly whether or not source control is available.

Update the project facts section once the source-control policy is known.

## 10. Generated artefacts and local files

Keep generated, machine-local, large, or sensitive files separate from source where practical.

Do not use sibling directories of this project for app-related work, temporary checkouts, release staging, or artifacts. Keep app-internal working items in subdirectories of the project, with generated/private content ignored as appropriate. Keep app-external items only under `<OneDrive root>\DevData\FFF\`; the OneDrive root may vary by machine, so resolve the approved local location rather than hard-coding a user profile. Preserve the established root source/configuration files.

Examples may include:

- dependency directories
- build output
- caches
- logs
- temporary files
- local configuration
- environment files
- downloaded models or datasets
- database snapshots
- coverage reports
- generated exports
- editor or operating-system state

Once the project has a source-control policy, maintain appropriate ignore rules without hiding source files or required small fixtures.

Do not remove ignore protections simply to make generated files visible. Do not commit or share private local paths when a portable description is sufficient.

## 11. Persistence and contracts

Once the project introduces persistence, external interfaces, or durable artefacts, document the authoritative ownership and compatibility rules here or in a linked specialised document.

Record, as applicable:

- canonical data source
- cache and derived-data boundaries
- schema and migration policy
- atomic write expectations
- backup or recovery assumptions
- API routes and response contracts
- configuration ownership
- versioning and compatibility rules
- read-only boundaries
- concurrency and conflict behaviour

Do not create multiple canonical stores accidentally. Do not silently change durable file shapes, public APIs, migration history, or compatibility contracts.

## 12. User interface work

This section applies only once a user interface exists.

Before changing UI, inspect the established visual system, component primitives, accessibility patterns, responsive behaviour, and any authoritative style document.

- Reuse existing tokens and components before introducing one-off styling.
- Preserve interaction and accessibility conventions.
- Check affected layouts at relevant viewport sizes.
- Do not introduce a second icon family or parallel component system without a deliberate decision.
- Do not alter established visual rules incidentally during feature work.
- Update the authoritative style guidance when deliberately extending the visual system.
- Report deliberate deviations.

Until a UI stack and visual system are established, do not invent detailed permanent style rules in this file.

## 13. Error behaviour and truthful status

Prefer explicit, actionable states over generic failure.

Where relevant, distinguish between:

- invalid input or configuration
- unavailable environment
- unsupported capability
- blocked operation
- authentication or authorisation failure
- missing resource
- corrupt input
- conflict or stale state
- partial output
- deferred verification
- implementation error

Do not swallow meaningful errors. Do not present experimental, partial, simulated, cached, or unverified results as authoritative. Do not report a check as passed when it was skipped, blocked, or not applicable.

Browser-facing and user-facing errors must not expose secrets, private internals, or raw stack traces.

## 14. Verification strategy

Verification must be proportionate to the change and grounded in the project's actual commands.

Default approach:

- Run focused checks for the files or behaviour changed.
- Prefer targeted unit, integration, type, lint, syntax, build, or smoke checks over the complete suite for a narrow pass.
- Run the full suite when the prompt requests it, the change affects broadly shared infrastructure, release confidence is required, or targeted failures indicate wider risk.
- Do not repeatedly rerun unrelated passing tests.
- Do not run environment-dependent or destructive checks against live resources without explicit authorisation.
- For documentation-only changes, inspect content and formatting; automated tests are not normally required unless documentation generation is involved.
- For a blank project with no test framework, do not add one solely to validate a trivial initial file unless the task establishes testing as part of the project.

Before running a command, inspect its definition when its cost or side effects are uncertain.

Report:

- exact commands run
- relevant results
- whether the full suite was run
- checks skipped, blocked, or unavailable
- why the verification scope was appropriate
- any manual verification still required

## 15. Editing and encoding

Unless the project establishes another requirement:

- Use UTF-8 for source and documentation.
- Preserve existing line endings and file encoding when editing established files.
- Avoid broad formatting or encoding-only changes during unrelated work.
- Use stable code, identifiers, headings, routes, selectors, or constants as patch anchors.
- Preserve deliberate user-authored wording and comments outside the task scope.
- Do not claim encoding corruption without evidence.
- Keep generated changes deterministic where practical.

Once formatting, linting, or encoding commands are established, record them in the project facts or command section.

## 16. Project commands

Replace this table as commands become established. Verify commands from the current manifests rather than relying on memory.

| Purpose | Command |
| --- | --- |
| Install dependencies | `npm install`; install Chromium for browser verification with `npx playwright install chromium` |
| Start development mode | `.\start-local-server.bat` starts local Wrangler using ignored `.env.vars`; exact loopback origin and demo URL printed by the script |
| Build | `node cloudflare/scripts/prepare-assets.mjs` (public asset copying only; also run by Wrangler) |
| Local Cloudflare checks | `node cloudflare/tests/hosting.test.mjs`; `node cloudflare/tests/auth-browser.test.mjs`; `node cloudflare/tests/preapproval.test.mjs`; `node cloudflare/tests/fanart.test.mjs`; `node cloudflare/tests/fanart-runtime.test.mjs`; `npm run test:reminders` (disposable D1 and native local email simulator); with local Wrangler running, `node scripts/hosting-browser-test.mjs` |
| Start production mode | Separately approved Wrangler deployment; see `cloudflare/DEPLOYMENT.md` |
| Targeted tests | `node --check app.js`; `node --check store.js`; `node --check providers.js`; `node --check ranking.js`; `node --check scripts/verify-contracts.mjs`; `node scripts/verify-contracts.mjs`; with a local server already running, `node scripts/placement-browser-test.mjs` |
| Privacy and dry-run | `npm run build`; `npm run deploy:dry-run`; `npm run verify:privacy` (requires generated bundle) |
| Full test suite | `npm test` (contracts and disposable Cloudflare checks); `npm run test:browser` with local Wrangler running |
| Type checking | Not established |
| Linting | Not established |
| Formatting or encoding check | Not established |
| Database or schema validation | Disposable fixture applies all forward D1 migrations in `cloudflare/tests/hosting.test.mjs`; no remote database checks during migration preparation |

Do not leave obsolete commands in this table after scripts are renamed or retired.

## 17. Current boundaries, decisions, and non-goals

Current decisions:

- Canonical production hosting is existing `fff-api` with Static Assets at `https://wirewednesday.nissen.nexus`. Production disables workers.dev, version preview URLs and cross-origin API use; GitHub Pages retirement is a pending operational follow-up. Package only allowlisted frontend files.
- `bootstrap.js` appends per-page-load cache-busting queries to CSS and app modules. No inline scripts or document.write; production app CSP allows only local scripts.
- The frontend uses same-origin session-authenticated Worker endpoints and receives no direct D1 access. Cloudflare is the sole application authority; retired hosted infrastructure must not be accessed without a separate explicit task.
- Production resources remain Worker `fff-api`, D1 `fff` in Oceania and R2 `fff-artwork`. The authorised final cutover completed on 11 October 2026; version and acceptance evidence live in `cloudflare/DEPLOYMENT.md` and ignored `.wrangler/preflight/final/`. Migrations 0004–0006 and four reviewed Google preapprovals are installed. No subjects were fabricated; real first sign-in/session acceptance remains manual. Participant/admin/show/nomination/ranking data and all 48 original R2 objects were verified unchanged. Original D1/R2 recovery artifacts have checksum-matching, provider-confirmed in-sync copies in approved OneDrive storage. Preserve original exports/bookmarks and private approval mappings. Use explicit UTF-8 for evidence/SQL reads and writes; Windows CP1252 decoding previously caused six false metadata mismatches. On a failed production safety gate deploy the prepared Google-safe post-domain maintenance configuration, preserving the domain, disabling alternate URLs and removing data/assets bindings; never revive bearer authentication or restore old data over newer writes. Supabase is retired and cannot be a runtime fallback.
- The catalogue is global and shared; `shows` is the canonical IMDb-deduplicated record, and nominations are a separate per-user concept. Multiple users may nominate the same show, but a user may have only one active nomination for a show.
- Participant creation/Google mapping administration is operator-controlled outside the app. App admin status never permits choosing another participant for API operations.
- Google exclusively authenticates participants. Operator-only D1 `participant_google_preapprovals` can associate exact trim/lowercase emails with existing participant IDs before launch (`0006_google_preapprovals.sql`). First fully verified Gmail/Workspace sign-in atomically inserts the unique `participant_google_auth` subject mapping and consumes its allowance via a trigger. Third-party emails require independent operator subject review; OAuth Test User status alone grants no app access. Future login uses stable `sub` only, never email reassignment; existing/disabled subjects and consumed allowances cannot be automatically rebound. No participant creation or legacy fallback. Approval emails/mappings stay server-side in D1, absent from frontend/public responses; use the trusted D1 console for real setup/recovery rather than local files. No keyed hashing secret is added to the existing plaintext D1-only approval model. Explicit recovery requires a fresh verified request and exact prior subject. `cloudflare/DEPLOYMENT.md` owns setup/revocation/recovery; `prepare-google-mapping.mjs` remains a guarded SQL generator for fictional local fixtures.
- Session cookies are opaque, HttpOnly, host-only and Secure in production, with 30-day remembered or 12-hour browser-session expiry. D1 stores hashes; logout/reapproval invalidates sessions. Login/logout clears other tabs; a participant header can only reject stale-tab writes, never select an actor. Mutations require the configured origin and cannot accept actor overrides.
- Only the anonymous sign-in document permits the Google GIS SDK/popup. Use official `outline_dark`, responsive width capped at 320px, matching current CanBan `SignIn.tsx`. Authenticated pages use local Lucide/fonts and a strict script CSP. Private content/API/artwork responses are private/no-store/no-referrer; logging and R2-public-exposure review remain deployment gates.
- One known user can be marked administrator. Administrators may soft-remove active shows through the app; restoration is deliberately operator-controlled in D1. Restoration clears the removal marker only, withdraws prior nominations, clears current ranking rows for that show, and leaves the show inactive until a fresh nomination.
- `config.js` contains only same-origin `apiUrl: "/"`; no Supabase frontend adapter remains. Local Google setup explicitly loads ignored `.env.vars`; production client-ID configuration is separate. The initial cutover installed `GOOGLE_CLIENT_ID` and `FANART_TV` using the ignored Stage 2 secrets file. Subsequent code-only deployments use `wrangler deploy --keep-vars` from a clean reviewed commit, preserving existing secrets and configuration without loading local environment or secrets files. Do not use `secret put`/legacy secret helpers while maintaining isolation, because they immediately deploy. Never publish environment files. GIS needs no client secret.
- `cloudflare/migrations/` is the authoritative current schema, using forward-only additive changes. Preserve all six existing migration filenames and compatibility fields; do not recreate competing schemas or bearer authentication.
- IMDb title IDs are the canonical provider boundary and are mandatory for enrolled shows. Production browser code uses Worker `/v1/metadata`, which owns external provider access. Production API access is same-origin only. TVmaze is the primary television metadata provider, requires no API key, and is called through fixed public HTTPS endpoints for search, IMDb lookup, episode retrieval, and `shows/{tvmazeId}/images` card-art retrieval after retaining the numeric TVmaze show ID. Do not search ordinary TVmaze show lookup responses for background or banner properties. The TVmaze fallback card-art selection considers usable background originals and banner original/medium URLs and selects the horizontal candidate closest to FFF's panoramic target ratio; `main: true`, then source resolution, break ties. The normal poster and local placeholder remain fallbacks. Canonical identity comes from TVmaze `externals.imdb`; reject TVmaze search results without an IMDb ID. Card-art records retain the selected TVmaze artwork type and dimensions so stale persisted image assets can be detected and refreshed.
- TVmaze cumulative runtime is exact only: sum explicit TVmaze episode `runtime` values, and leave cumulative runtime unknown if any retrieved episode lacks runtime. Do not estimate from average runtime or other derived fields.
- TVmaze's provider rating is stored as a `/10` value. Order cards alone render it as a five-star Straw SVG overlay, rounded to the nearest half-star; Add and Board cards do not render ratings.
- TVmaze data is licensed under CC BY-SA; the app shell currently does not render provider attribution copy in the Add UI.
- TVDB is permitted only as fallback enrichment after TVmaze successfully resolves the canonical IMDb ID. It must include an explicit IMDb cross-reference that normalizes exactly to that canonical ID, may fill only absent supported fields, and must not run after primary-provider failure or appear in Add UI, search choices, canonical identity, duplicate detection, show URLs, or user-entered references. Supported fallback fields include series status, ended year, season count, episode count, exact/provider-supplied total runtime, poster source, background metadata, and TVDB record ID.
- Ranking changes auto-save through Worker `/v1/ranking`; active shows may be omitted and therefore remain unranked. Missing ranking rows mean no expressed opinion, not a last-place ranking. Withdrawal removes that user's current rank for the show, and final withdrawal clears current rankings for the show so future reactivation starts unranked for everyone.
- The current Board aggregate strategy is isolated and identified as `sequential-irv-v1`. Each user's explicit ranked queue is a partial ranked-choice ballot; unranked shows are absent. The Board sequence is produced by repeated instant-runoff elections over active, non-removed shows with at least one retained ranking input. Retained rankings from inactive users still influence the election.
- Board confirmation is dynamic: active users have `is_active = true` and an enabled Google mapping, and a show is confirmed only when every currently active user has explicitly ranked it. With zero active users, no result is confirmed. The displayed Board ranking count is active users only; inactive-user contribution counts are not browser-facing.
- Board cards with fewer than four active-user rankings display a top-right `Votes: N of 4` badge; aggregate scores and voter identities remain hidden.
- Aggregate ties are deterministic and use canonical IMDb numeric value: strip non-digits, compare arbitrary-precision-safe numeric strings, let the higher value win winner ties, and let the lower value lose elimination ties first.
- Board refresh uses session-authenticated revision polling when the Board is open, on focus/visibility return, and through a one-minute fallback interval; do not introduce Realtime infrastructure.
- fanart.tv API v3.2 is preferred for native 1000×185 `tvbanner` artwork, using TVmaze’s TheTVDB cross-reference or retained `tvdb_record_id`. Select the first suitable banner automatically; keep existing artwork when unavailable. `FANART_TV` is server-only in ignored `.env.vars` locally and a separate production Worker secret. Discovery/empty responses cache in D1 for 24 hours; failures back off for at least five minutes with bounded Retry-After. Admin-only `/v1/admin/artwork` chooses canonical banners without modifying existing metadata, nominations or rankings; choosing an unenrolled search result creates an inactive canonical row only. `0005_fanart_banners.sql` persists a manual flag and banner ID. Manual choices survive all refresh/nomination paths. Originals/previews use authenticated R2 and immutable source-derived keys; source and CC BY 3.0 attribution identify display treatment. No new dependency or browser provider access. Provider discovery and downloads use `redirect: "manual"` and reject redirect responses; `redirect: "error"` is incompatible with the deployed workerd compatibility configuration. Native workerd coverage is required alongside Node mocks. Discovery failure diagnostics contain only fixed categories, HTTP status and retry duration; cached failures remain five-minute minimum backoff, without exposing provider bodies, URLs, IDs, credentials or raw exceptions.
- Show cards experimentally use exact responsive 200:37 proportions with uncropped native fanart.tv banners, no artwork overlay, and strong dark text shadows. Page-level fanart.tv/CC BY 3.0 credit appears below cards only when fanart.tv images load; the banner picker retains attribution and keyboard-operable selection buttons. Nominate/List/Watch use four stacked text lines on desktop and mobile, with tighter mobile line spacing and an extra 0.5rem indent on Nominate/List card text; Watch retains its position column. Persistent catalogue cards have only admin Edit/Remove controls; search retains nomination management. Admin tools and unchanged List Up/Down/Cross are 32px dark-grey icon buttons with accessible names. Long titles truncate and long mobile metadata can scroll without wrapping. The header uses a 6rem account avatar at its top-right corner on a transparent button with a fixed Sign out popover at top 6rem/right 0; avatars are matched by stable participant ID and served only through authenticated `/avatar.png`. Original filenames/emails are not published. List auto-saves without persistent save-status or retry controls; failures still produce error toasts. `README.md` documents compromises and `scripts/artwork-browser-test.mjs` verifies fictional-API UI at four widths.
- Enrolled posters and selected card artwork are retained in the `fff-artwork` R2 bucket under deterministic `posters/` and `card-art/` paths. Browser reads are served by the Worker; browser uploads are not permitted.
- Weekly metadata refresh is active at Wednesday `02:00 UTC` (`0 2 * * 3`, 12:00 AEST / 13:00 AEDT in Sydney). Live registration and the deployed metadata handler were verified during final cutover on 11 October 2026; registration does not prove successful executions. Do not manually invoke production Cron as acceptance. It processes active non-removed due shows through TVmaze/fanart and writes metadata/artwork with sanitized failures. Google-safe maintenance keeps the registration but replaces scheduled handling with a no-op.
- Weekly ranking reminder code and the queued fanart fix were deployed on 11 October 2026 from `4f57e98`; reminders remain disabled (`RANKING_REMINDERS_ENABLED=false`). Version and acceptance evidence are recorded in `cloudflare/DEPLOYMENT.md`. Native `send_email` binding `RANKING_EMAIL` restricts sender to `troy@nissen.nexus`; never enable remote email bindings in tests. Both UTC Wednesday 01:00 and preserved 02:00 triggers are registered and use the scheduled timestamp and `Australia/Sydney` to select exactly local noon; only 02:00 runs metadata. Counts share Order visibility and non-null-ranking rules. Recipients require active users and enabled Google mappings, using current private `approved_email`, never unclaimed preapprovals or auth requests. Migration 0007 adds private participant/local-date claims with count/status/timestamps only and remains unapplied to production; preserve claims indefinitely for at-most-once attempts, including failed/unknown outcomes. There is no automatic same-day retry or public send/audit endpoint. Four verified Email Routing destinations, existing-domain review, migration and explicit activation approval remain manual gates in `cloudflare/DEPLOYMENT.md`. No paid provider or new dependency.
- D1 access is exclusively through Worker authorization. Supabase tooling and source have been removed; it is never a runtime fallback.

Add only decisions that materially guide future work. Examples include:

- supported platforms
- deployment constraints
- security boundaries
- chosen architecture
- canonical data ownership
- compatibility commitments
- explicitly excluded features
- retired behaviour that must not be reintroduced

Do not infer non-goals from temporary absence. Do not preserve abandoned decisions as current rules.

## 18. Final report requirements

Every implementation report should state, where relevant:

1. Files created, changed, moved, or removed.
2. The exact scope completed.
3. Material architecture, behaviour, dependency, configuration, schema, or command changes.
4. Verification performed and results.
5. Whether the full test suite was run.
6. Checks skipped, blocked, or deferred, with reasons.
7. Safety-sensitive resources accessed or deliberately not accessed.
8. Assumptions, limitations, risks, and unresolved decisions.
9. Any documentation changed.
10. Whether `AGENTS.md` was checked.
11. Whether `AGENTS.md` was changed, and why or why not.

Do not bury blockers, substitutions, failures, or unverified claims in general prose.

A concise closeout format is acceptable:

```text
Files changed:
- ...

Completed:
- ...

Validation:
- ...

Not changed or not run:
- ...

AGENTS.md:
- Checked: yes
- Updated: yes/no
- Reason: ...
```

## 19. AGENTS.md closeout check

Before finishing every pass:

1. Re-read the sections relevant to the work performed.
2. Check whether the pass established new project facts.
3. Check whether architecture, ownership, commands, contracts, safety rules, project navigation, or non-goals changed.
4. Check whether any statement in this file is now stale, incorrect, duplicated, or materially incomplete.
5. Update the existing authoritative section when needed.
6. Remove obsolete guidance rather than adding a conflicting note.
7. Keep this file focused on information future agents need.
8. State in the final report that the file was checked and whether it changed.

This maintenance requirement applies even when the user does not mention `AGENTS.md` in the current prompt.
