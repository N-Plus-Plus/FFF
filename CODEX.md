# CODEX.md: Project Guidance

Read this file before every coding, maintenance, review, investigation, or documentation pass in this project.

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

The project is now an initial static web app scaffold.

| Project fact | Current state |
| --- | --- |
| Project name | FFF TV Ranking |
| Product purpose | Mobile-first shared TV show catalogue, private personal ordering, and strict aggregate Board sequence |
| Intended users | Manually created known users who receive unique secret token links |
| Project maturity | Static scaffold with Supabase architecture established |
| Application shape | Static GitHub Pages app with raw HTML, CSS, and JavaScript ES modules |
| Languages and runtime | Browser JavaScript, HTML, CSS; no build step |
| Frameworks and major libraries | Supabase JS browser client loaded from CDN |
| Package manager | None established |
| Persistence or database | Supabase Postgres via RLS-protected tables and narrow RPC functions; opt-in localStorage demo with `?demo=1` |
| External services | Supabase; TVmaze primary television metadata through Supabase Edge Functions; optional TVDB fallback enrichment; Resend for weekly ordering reminder email delivery; Supabase Storage for retained posters |
| Deployment target | GitHub Pages |
| Source-control policy | Git worktree on `main` with `origin` at `https://github.com/N-Plus-Plus/FFF.git`; preserve unrelated user changes and do not push, commit, or rewrite history unless explicitly requested |
| Test framework | None established |
| Build, run, and verification commands | See project commands |
| Supabase operations | Codex may operate the linked Supabase project when the user explicitly requests backend control; use dry runs or read-only inspection first when practical, avoid destructive resets, and report live changes clearly |

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
| User interface | `style.css`, DOM rendering in `app.js` |
| Domain or business rules | Board aggregate strategy and IMDb tie-breaking in `ranking.js`; ranking sequence orchestration in `app.js` |
| Persistence and data access | Supabase/local data store helpers in `store.js`; schema/RPC in `supabase/migrations/` |
| API or service boundaries | TVmaze primary provider boundary and TVDB fallback merge helpers in `providers.js`; canonical IMDb Edge Function in `supabase/functions/imdb`; weekly refresh Edge Function in `supabase/functions/metadata-refresh`; weekly ordering reminder Edge Function in `supabase/functions/weekly-order-reminders`; Supabase RPC functions in migrations |
| Configuration | `config.js` |
| Shared utilities | Small ES modules in `store.js`, `providers.js`, and `ranking.js` |
| Tests | Not established |
| Build and deployment | Static files served by GitHub Pages; no build step |
| Further documentation | `README.md` |

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

Before finishing every pass, check whether `CODEX.md` itself is stale, incorrect, or materially incomplete because of the work performed. Update it in the same pass when necessary, even when the user did not separately request documentation maintenance.

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
- Do not initialise Git, create branches, commit, push, alter remotes, add CI, or create repository metadata unless explicitly requested or already established as normal project practice.
- Do not rely on `git diff`, `git status`, or history commands when the directory is not a Git worktree.
- When Git is present, preserve unrelated user changes and do not discard or rewrite them.
- Never use destructive source-control commands merely to obtain a clean working tree.
- Report changed files explicitly whether or not source control is available.

Update the project facts section once the source-control policy is known.

## 10. Generated artefacts and local files

Keep generated, machine-local, large, or sensitive files separate from source where practical.

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
| Install dependencies | Not established |
| Start development mode | `.\start-local-server.bat` for port 3000 device testing, or `python -m http.server 3000 --bind 0.0.0.0` |
| Build | Not applicable; static files are served directly |
| Start production mode | GitHub Pages serves the repository files directly |
| Targeted tests | `node --check app.js`; `node --check store.js`; `node --check providers.js`; `node --check ranking.js`; `node --check scripts/verify-contracts.mjs`; `node scripts/verify-contracts.mjs` |
| Full test suite | Not established |
| Type checking | Not established |
| Linting | Not established |
| Formatting or encoding check | Not established |
| Database or schema validation | `npx.cmd supabase db push --dry-run --linked --yes` when Supabase CLI auth and a linked development project are available |

Do not leave obsolete commands in this table after scripts are renamed or retired.

## 17. Current boundaries, decisions, and non-goals

Current decisions:

- The app is static and must run on GitHub Pages without a custom application server.
- `index.html` deliberately appends a per-page-load cache-busting query string to local CSS and module assets so refreshes do not reuse stale UI files.
- Supabase is the persistence backend. Browser code calls narrow RPC functions with a user link token and receives no direct table grants.
- The user expects Codex to control the linked Supabase project for requested backend work. Apply migrations, deploy Edge Functions, inspect remote state, and run bounded verification when needed, but do not run destructive linked resets or bulk data changes unless the user explicitly asks for that specific operation.
- The catalogue is global and shared; `shows` is the canonical IMDb-deduplicated record, and nominations are a separate per-user concept. Multiple users may nominate the same show, but a user may have only one active nomination for a show.
- Known users are manually administered outside the ordinary app UI.
- Unique links use `?u=<link_token>` and the token is treated as a bearer credential. Store only token hashes in the database and never expose hashes to the browser.
- One known user can be marked administrator. Administrators may soft-remove active shows through the app; restoration is deliberately database/service-role only through `admin_restore_show`. Restoration clears the removal marker only, withdraws prior nominations, clears current ranking rows for that show, and leaves the show inactive until a fresh nomination.
- `config.js` must contain only the Supabase project URL and publishable browser key.
- Migration files in `supabase/migrations/` are the authoritative schema source. Do not restore `supabase-schema.sql` as a competing schema.
- IMDb title IDs are the canonical provider boundary and are mandatory for enrolled shows. Browser code must use the Supabase Edge Function in `supabase/functions/imdb`, which owns external provider access and allows CORS from configured origins plus loopback local origins on any port. TVmaze is the primary television metadata provider, requires no API key, and is called through fixed public HTTPS endpoints for search, IMDb lookup, episode retrieval, and `shows/{tvmazeId}/images` card-art retrieval after retaining the numeric TVmaze show ID. Do not search ordinary TVmaze show lookup responses for background or banner properties. Card-art selection prefers background original URL, then banner original/medium URL, then the normal poster, then the local placeholder; `main: true` wins within a type. Canonical identity comes from TVmaze `externals.imdb`; reject TVmaze search results without an IMDb ID. Card-art records retain the selected TVmaze artwork type and dimensions so stale persisted image assets can be detected and refreshed.
- TVmaze cumulative runtime is exact only: sum explicit TVmaze episode `runtime` values, and leave cumulative runtime unknown if any retrieved episode lacks runtime. Do not estimate from average runtime or other derived fields.
- TVmaze data is licensed under CC BY-SA; the app shell currently does not render provider attribution copy in the Add UI.
- TVDB is permitted only as fallback enrichment after TVmaze successfully resolves the canonical IMDb ID. It must include an explicit IMDb cross-reference that normalizes exactly to that canonical ID, may fill only absent supported fields, and must not run after primary-provider failure or appear in Add UI, search choices, canonical identity, duplicate detection, show URLs, or user-entered references. Supported fallback fields include series status, ended year, season count, episode count, exact/provider-supplied total runtime, poster source, background metadata, and TVDB record ID.
- Ranking changes auto-save through `replace_user_ranking`; active shows may be omitted and therefore remain unranked. Missing ranking rows mean no expressed opinion, not a last-place ranking. Withdrawal removes that user's current rank for the show, and final withdrawal clears current rankings for the show so future reactivation starts unranked for everyone.
- The current Board aggregate strategy is isolated and identified as `sequential-irv-v1`. Each user's explicit ranked queue is a partial ranked-choice ballot; unranked shows are absent. The Board sequence is produced by repeated instant-runoff elections over active, non-removed shows with at least one retained ranking input. Retained rankings from inactive users still influence the election.
- Board confirmation is dynamic: active users are those with `is_active = true` and no revoked token, and a show is confirmed only when every currently active user has explicitly ranked it. With zero active users, no result is confirmed. The displayed Board ranking count is active users only; inactive-user contribution counts are not browser-facing.
- Aggregate ties are deterministic and use canonical IMDb numeric value: strip non-digits, compare arbitrary-precision-safe numeric strings, let the higher value win winner ties, and let the lower value lose elimination ties first.
- Board refresh uses Supabase Realtime invalidation through a non-sensitive public revision row, then calls token-authenticated Board RPCs. Retain bounded polling only as a fallback.
- Enrolled posters and selected card artwork are retained in the `show-posters` Supabase Storage bucket via trusted server-side code. Card artwork is stored separately from posters under deterministic `card-art/` paths and records whether the source was background, banner, poster, or placeholder. Browser code may read public image assets but must not receive arbitrary upload permission.
- Weekly metadata refresh is implemented as a trusted Edge Function and schedule template. It accepts service-role authorization or the dedicated `METADATA_REFRESH_SECRET`, processes active, non-removed shows whose last successful refresh is at least seven days old, refreshes through TVmaze first, preserves known values on provider failures, and uses TVDB only under the strict cross-reference fallback rule. The Edge Function is deployed to the linked FFF project, but the weekly cron schedule is not currently configured.
- Weekly order reminders are implemented as a trusted Edge Function, service-role RPC helper, and schedule template. The function accepts service-role authorization or `ORDER_REMINDER_SECRET`, reads recipient names, email addresses, and personal bearer links only from Supabase secrets, preferring `ORDER_REMINDER_RECIPIENTS_B64` over `ORDER_REMINDER_RECIPIENTS_JSON`, sends through Resend, and skips active users who have no active unranked shows. The fixed schedule target is Wednesday 12:00 AEST, represented as `02:00 UTC`.
- All app tables must have RLS enabled. `anon` must not receive direct read/write grants. Privileged functions must use safe `search_path` settings and validate link tokens internally.

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
10. Whether `CODEX.md` was checked.
11. Whether `CODEX.md` was changed, and why or why not.

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

CODEX.md:
- Checked: yes
- Updated: yes/no
- Reason: ...
```

## 19. CODEX.md closeout check

Before finishing every pass:

1. Re-read the sections relevant to the work performed.
2. Check whether the pass established new project facts.
3. Check whether architecture, ownership, commands, contracts, safety rules, project navigation, or non-goals changed.
4. Check whether any statement in this file is now stale, incorrect, duplicated, or materially incomplete.
5. Update the existing authoritative section when needed.
6. Remove obsolete guidance rather than adding a conflicting note.
7. Keep this file focused on information future agents need.
8. State in the final report that the file was checked and whether it changed.

This maintenance requirement applies even when the user does not mention `CODEX.md` in the current prompt.
