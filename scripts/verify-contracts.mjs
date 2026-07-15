import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import {
  BOARD_AGGREGATE_STRATEGY_ID,
  compareImdbTieSeed,
  computeProvisionalBoard
} from "../ranking.js";
import {
  isWeeklyRefreshDue,
  mergePrimaryAndTvdbMetadata,
  normalizeProviderTitle
} from "../providers.js";
import { createDataStore } from "../store.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  getItem(key) {
    return this.values.get(key) || null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

const listeners = new Map();
globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
};
globalThis.window = {
  addEventListener(type, listener) {
    const bucket = listeners.get(type) || new Set();
    bucket.add(listener);
    listeners.set(type, bucket);
  },
  removeEventListener(type, listener) {
    listeners.get(type)?.delete(listener);
  },
  dispatchEvent(event) {
    listeners.get(event.type)?.forEach((listener) => listener(event));
  }
};

const rootFiles = {
  app: await readFile(new URL("../app.js", import.meta.url), "utf8"),
  index: await readFile(new URL("../index.html", import.meta.url), "utf8"),
  store: await readFile(new URL("../store.js", import.meta.url), "utf8"),
  providers: await readFile(new URL("../providers.js", import.meta.url), "utf8"),
  migration: await readFile(new URL("../supabase/migrations/20260715000400_sequential_irv_lifecycle_privacy.sql", import.meta.url), "utf8"),
  edge: await readFile(new URL("../supabase/functions/imdb/index.ts", import.meta.url), "utf8"),
  refreshEdge: await readFile(new URL("../supabase/functions/metadata-refresh/index.ts", import.meta.url), "utf8")
};

verifyRanking();
verifyProviders();
await verifyDemoStore();
verifyTextContracts();

console.log("contract verification passed");

function verifyRanking() {
  assert.equal(BOARD_AGGREGATE_STRATEGY_ID, "sequential-irv-v1");
  assert.ok(compareImdbTieSeed("tt2000001", "tt1000001") < 0, "higher numeric IMDb wins ties");
  assert.ok(compareImdbTieSeed("tt1000000001", "tt9999999") < 0, "identifier length is compared safely");
  assert.ok(compareImdbTieSeed("tt0000002", "tt0000001") < 0, "leading zeroes do not change numeric order");
  assert.ok(compareImdbTieSeed("abc-tt3000000-x", "tt2000000") < 0, "alpha characters are ignored");
  assert.throws(() => compareImdbTieSeed("tt0000001", "tt1"), /Duplicate canonical IMDb numeric component/);

  const shows = [
    { id: "a", imdbId: "tt1000001", title: "Alpha", activeNominationCount: 2 },
    { id: "b", imdbId: "tt1000002", title: "Beta", activeNominationCount: 1 },
    { id: "c", imdbId: "tt1000003", title: "Gamma", activeNominationCount: 1 },
    { id: "d", imdbId: "tt1000004", title: "Delta", activeNominationCount: 1 }
  ];
  const users = [
    { id: "admin", isActive: true, isAdmin: true },
    { id: "u2", isActive: true },
    { id: "u3", isActive: true },
    { id: "old", isActive: false }
  ];

  let board = computeProvisionalBoard(shows, users, {
    admin: ["a", "b"],
    u2: ["b", "a"],
    u3: [],
    old: ["c", "b", "a"]
  });
  assert.equal(board.length, 3, "shows with no ranking input are excluded");
  assert.deepEqual(board.map((entry) => entry.show_id), ["c", "b", "a"], "complete repeated IRV sequence is deterministic");
  assert.equal(board[0].ranked_count, 0, "inactive ballot can influence order without being displayed");
  assert.equal(board[0].ranked_active_user_count, 0);
  assert.equal(board[0].is_confirmed, false, "all active users must rank the show");

  board = computeProvisionalBoard(shows, users, {
    admin: ["a", "b", "c"],
    u2: ["b", "c", "a"],
    u3: ["c", "b", "a"],
    old: ["a"]
  });
  assert.deepEqual(board.map((entry) => entry.show_id), ["c", "b", "a"], "elimination ties use lower numeric IMDb as loser first");
  assert.equal(board.find((entry) => entry.show_id === "b").is_confirmed, true);
  assert.equal(board.find((entry) => entry.show_id === "a").is_confirmed, true);

  board = computeProvisionalBoard(shows, users, {
    admin: ["a"],
    u2: ["b"],
    u3: []
  });
  assert.equal(board[0].show_id, "b", "final winner tie uses higher numeric IMDb");

  board = computeProvisionalBoard(shows, users.map((user) => ({ ...user, isActive: false })), {
    old: ["a"]
  });
  assert.equal(board[0].is_confirmed, false, "no active users means no confirmed result");
}

function verifyProviders() {
  assert.equal(normalizeProviderTitle({ imdb_id: "tt1111111", title: "Episode", title_type: "tvEpisode" }).imdbId, "");
  assert.equal(normalizeProviderTitle({ imdb_id: "tt2222222", title: "Movie", title_type: "tvMovie" }).imdbId, "");
  assert.equal(normalizeProviderTitle({ imdb_id: "tt3333333", title: "Special", title_type: "tvSpecial" }).imdbId, "");

  const merged = mergePrimaryAndTvdbMetadata(
    {
      imdb_id: "tt4444444",
      title: "Primary Title",
      title_type: "tvSeries",
      series_status: "Continuing",
      total_runtime_minutes: null,
      metadata_provider: "imdb-oriented",
      provider_record_id: "tt4444444"
    },
    {
      imdb_id: "tt4444444",
      tvdb_id: "tvdb-444",
      status: "Ended",
      episode_count: 12,
      runtime_minutes_total: 360,
      poster_url: "https://example.invalid/poster.jpg"
    },
    { totalRuntimeMinutes: 320 }
  );
  assert.equal(merged.imdbId, "tt4444444", "TVDB cannot change canonical identity");
  assert.equal(merged.title, "Primary Title", "primary title wins");
  assert.equal(merged.seriesStatus, "Continuing", "primary field already present is not overwritten");
  assert.equal(merged.totalEpisodeCount, 12);
  assert.equal(merged.totalRuntimeMinutes, 360);
  assert.equal(merged.tvdbRecordId, "tvdb-444");

  const mismatched = mergePrimaryAndTvdbMetadata(
    { imdb_id: "tt5555555", title: "Primary", title_type: "tvSeries", metadata_provider: "primary" },
    { imdb_id: "tt6666666", status: "Ended" },
    { seriesStatus: "Returning" }
  );
  assert.equal(mismatched.seriesStatus, "Returning", "mismatched TVDB cross-reference is skipped");

  const missingCrossref = mergePrimaryAndTvdbMetadata(
    { imdb_id: "tt5555555", title: "Primary", title_type: "tvSeries", metadata_provider: "primary" },
    { tvdb_id: "tvdb-555", status: "Ended" },
    { seriesStatus: "Returning" }
  );
  assert.equal(missingCrossref.seriesStatus, "Returning", "missing TVDB cross-reference is skipped");

  assert.throws(
    () => mergePrimaryAndTvdbMetadata(null, { imdb_id: "tt4444444", status: "Ended" }),
    /Canonical IMDb title ID is required/,
    "TVDB is not used when primary provider resolution failed"
  );

  const estimated = normalizeProviderTitle({
    imdb_id: "tt7777777",
    title: "Estimated Runtime",
    title_type: "tvSeries",
    total_runtime_minutes: 100,
    total_runtime_is_estimate: true
  });
  assert.equal(estimated.totalRuntimeMinutes, null, "estimated runtime is not accepted");
  assert.equal(isWeeklyRefreshDue("2026-07-08T00:00:00.000Z", new Date("2026-07-15T00:00:00.000Z")), true);
  assert.equal(isWeeklyRefreshDue("2026-07-09T00:00:00.000Z", new Date("2026-07-15T00:00:00.000Z")), false);
}

async function verifyDemoStore() {
  localStorage.clear();
  const store = createDataStore({}, { demoMode: true });
  const initial = await store.load("demo-admin");
  assert.equal(initial.currentUser.isAdmin, true, "administrator is an ordinary participant");
  const bear = initial.shows.find((show) => show.imdbId === "tt14452776");
  const breakingBad = initial.shows.find((show) => show.imdbId === "tt0903747");
  assert.ok(bear && breakingBad);
  assert.equal(initial.shows.some((show) => show.nominators?.length), false, "nominator identities are not in demo state");

  const board = await store.getBoard("demo-admin");
  assert.ok(board.entries.some((entry) => entry.rankedCount === entry.rankedActiveUserCount), "displayed ranked count is active users only");
  assert.ok(board.entries.every((entry) => entry.activeUserCount === 3), "deactivated users are excluded from confirmation denominator");

  await assert.rejects(() => store.load("demo-riley"), /inactive user link/i, "deactivated user cannot read app data");
  await store.adminSetUserActive("demo-admin", "demo-riley", true);
  const reactivatedBoard = await store.getBoard("demo-admin");
  assert.ok(reactivatedBoard.entries.some((entry) => !entry.isConfirmed), "reactivation can make results unconfirmed");

  await store.adminSetUserActive("demo-admin", "demo-riley", false);
  const deactivatedBoard = await store.getBoard("demo-admin");
  assert.ok(deactivatedBoard.entries.some((entry) => entry.activeUserCount === 3), "deactivation updates active denominator");

  await store.replaceRanking("demo-admin", [breakingBad.id, bear.id]);
  const otherUser = await store.load("demo-user");
  assert.equal(otherUser.ranked[0].imdbId, "tt0903747", "users only see their own personal sequence");

  await assert.rejects(
    () => store.replaceRanking("demo-admin", [breakingBad.id, breakingBad.id]),
    /duplicate/i,
    "strict personal ranking rejects duplicates"
  );

  const newNomination = await store.nominate("demo-admin", {
    imdbId: "tt2861424",
    title: "Rick and Morty",
    releaseYear: 2013,
    titleType: "tvSeries"
  });
  assert.equal(newNomination.alreadyNominated, false, "valid nomination activates immediately");
  const afterNomination = await store.load("demo-user");
  assert.ok(afterNomination.unranked.some((show) => show.imdbId === "tt2861424"), "new show appears as unranked without ranking rows");

  await store.withdraw("demo-admin", breakingBad.id);
  const afterFinalWithdrawal = await store.load("demo-admin");
  assert.ok(!afterFinalWithdrawal.shows.some((show) => show.id === breakingBad.id), "final nomination withdrawal deactivates show");
  assert.ok(!afterFinalWithdrawal.ranked.some((show) => show.id === breakingBad.id), "final withdrawal clears current ranking state");

  const reactivated = await store.nominate("demo-admin", {
    imdbId: "tt0903747",
    title: "Breaking Bad",
    releaseYear: 2008,
    titleType: "tvSeries"
  });
  assert.equal(reactivated.id, breakingBad.id, "reactivation reuses canonical show record");
  const afterReactivation = await store.load("demo-admin");
  assert.ok(afterReactivation.unranked.some((show) => show.id === breakingBad.id), "reactivation starts unranked");

  let observedRevision = 0;
  const unsubscribe = await store.subscribeBoardInvalidation((revision) => {
    observedRevision = revision.revision;
  });
  await store.adminSetUserActive("demo-admin", "demo-riley", true);
  unsubscribe();
  assert.ok(observedRevision > 0, "user activation emits Board revision invalidation");
}

function verifyTextContracts() {
  assert.match(rootFiles.app, /rel="noopener noreferrer"/, "IMDb link uses noopener noreferrer");
  assert.match(rootFiles.app, /referrerpolicy="no-referrer"/, "IMDb link avoids referrer leakage");
  assert.match(rootFiles.app, /closest\("button, a, input, select, textarea"\)/, "interactive controls do not start drag");
  assert.doesNotMatch(rootFiles.app, /Score /, "ordinary Board UI does not display numeric aggregate score");
  assert.match(rootFiles.app, /sessionStorage\.setItem\(REMINDER_DISMISSED_KEY/, "unranked reminder dismissal is session scoped");
  assert.match(rootFiles.index, /dismissReminderButton/, "unranked reminder has dismiss control");
  assert.doesNotMatch(rootFiles.index, /RV metadata by TVMaze/i, "legacy TVMaze attribution copy stays out of the app shell");
  assert.doesNotMatch(rootFiles.app, /nominators/, "browser UI does not render nominator names");
  assert.doesNotMatch(rootFiles.store, /nominators/, "frontend state does not normalize nominator names");

  assert.match(rootFiles.migration, /sequential-irv-v1/, "SQL exposes named IRV Board strategy");
  assert.match(rootFiles.migration, /run_irv_election/, "SQL uses repeated instant-runoff helper");
  assert.match(rootFiles.migration, /imdb_numeric_key/, "SQL uses numeric IMDb tie-break key");
  assert.match(rootFiles.migration, /ranked_active_user_count = show_row\.active_user_count/, "confirmation requires all active users");
  assert.match(rootFiles.migration, /delete from public\.user_show_rankings\s+where show_id = v_show\.id/i, "database restore clears prior ranking state");
  assert.match(rootFiles.migration, /tvdb_record_id/, "nomination persists TVDB record ID into dedicated column");
  assert.match(rootFiles.migration, /metadata_source_provenance/, "nomination persists source provenance");
  const retiredMeanStrategyPattern = new RegExp(["mean", "explicit", "position", "v1"].join("-"));
  assert.doesNotMatch(rootFiles.migration, retiredMeanStrategyPattern, "old Board strategy is absent from final migration");
  assert.doesNotMatch(rootFiles.migration, /jsonb_agg\(u\.display_name/, "browser RPC show JSON does not expose private nomination names");

  assert.match(rootFiles.edge, /TVDB_IMDB_URL_TEMPLATE/, "TVDB fallback is only behind Edge secrets");
  assert.match(rootFiles.edge, /https:\/\/api\.tvmaze\.com/, "IMDb Edge Function uses TVmaze as primary provider");
  assert.match(rootFiles.edge, /\/search\/shows\?q=/, "IMDb Edge Function uses TVmaze search");
  assert.match(rootFiles.edge, /\/lookup\/shows\?imdb=/, "IMDb Edge Function resolves exact IMDb IDs through TVmaze");
  assert.match(rootFiles.edge, /\/shows\/\$\{tvmazeId\}\/episodes/, "IMDb Edge Function retrieves TVmaze episodes");
  assert.match(rootFiles.edge, /externals\.imdb/, "TVmaze canonical identity comes from externals.imdb");
  assert.match(rootFiles.edge, /cumulativeExplicitRuntime/, "TVmaze runtime is summed only from explicit episode runtime");
  assert.doesNotMatch(rootFiles.edge, /IMDB_SEARCH_URL_TEMPLATE/, "TVmaze primary provider does not require generic IMDb search URL template");
  assert.doesNotMatch(rootFiles.edge, /IMDB_TITLE_URL_TEMPLATE/, "TVmaze primary provider does not require generic IMDb title URL template");
  assert.doesNotMatch(rootFiles.edge, /IMDB_API_KEY/, "TVmaze primary provider does not require an API key");
  assert.doesNotMatch(rootFiles.edge, /stringValue\(item\.imdbIdCrossref\)\s*\|\|\s*canonicalImdbId/, "IMDb Edge Function does not substitute requested IMDb ID for TVDB cross-reference");
  assert.match(rootFiles.edge, /tvdb\.imdb_id !== primary\.imdb_id/, "TVDB cannot change canonical IMDb identity");
  assert.match(rootFiles.edge, /REJECTED_TITLE_TYPES/, "provider boundary rejects episodes, TV movies, and specials");
  assert.match(rootFiles.refreshEdge, /Service-role authorization is required/, "browser refresh calls are rejected");
  assert.match(rootFiles.refreshEdge, /https:\/\/api\.tvmaze\.com/, "refresh function uses TVmaze as primary provider");
  assert.match(rootFiles.refreshEdge, /\/lookup\/shows\?imdb=/, "refresh function uses TVmaze exact IMDb lookup");
  assert.match(rootFiles.refreshEdge, /\/shows\/\$\{tvmazeId\}\/episodes/, "refresh function retrieves TVmaze episodes");
  assert.match(rootFiles.refreshEdge, /externals\.imdb/, "refresh canonical identity comes from TVmaze externals.imdb");
  assert.doesNotMatch(rootFiles.refreshEdge, /IMDB_TITLE_URL_TEMPLATE/, "refresh function does not require generic IMDb title URL template");
  assert.doesNotMatch(rootFiles.refreshEdge, /IMDB_API_KEY/, "refresh function does not require an IMDb API key");
  assert.doesNotMatch(rootFiles.refreshEdge, /imdb_id_crossref\) \|\| canonicalImdbId/, "refresh function requires explicit TVDB cross-reference");
  assert.match(rootFiles.refreshEdge, /admin_list_metadata_refresh_candidates/, "weekly refresh function loads due shows through service RPC");
  assert.match(rootFiles.refreshEdge, /metadata_refresh_failure_category/, "provider failure category is sanitized and retained");
  assert.match(rootFiles.refreshEdge, /copyPosterToStorage/, "refresh function can update posters through trusted code");
  assert.doesNotMatch(rootFiles.refreshEdge, /console\.log\(.*token/i, "refresh logging does not include raw tokens");

  assert.match(rootFiles.providers, /REJECTED_TITLE_TYPES/, "browser provider normalization rejects unsupported one-off titles");
  assert.match(rootFiles.store, /computeProvisionalBoard/, "demo Board uses shared ranking semantics");
}
