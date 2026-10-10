import assert from "node:assert/strict";
import { normalizeTvmaze } from "../src/index.js";
import { fixture } from "./fixture.mjs";

const test = await fixture();
const { env } = test;
try {
  let episodes = [{ season: 1, runtime: 30 }, { season: 2, runtime: 45 }];
  const lookups = [];
  globalThis.fetch = async (value) => {
    const url = new URL(value);
    assert.equal(url.origin, "https://api.tvmaze.com", "Only the active provider is contacted");
    if (url.pathname.endsWith("/episodes")) return Response.json(episodes);
    if (url.pathname.endsWith("/images")) return Response.json([]);
    const imdb = url.searchParams.get("imdb");
    lookups.push(imdb);
    return Response.json({ id: 1, name: "Refreshed", externals: { imdb }, rating: { average: 8.5 } });
  };
  const show = { id: 1, name: "Metadata", premiered: "2020-01-01", ended: "2022-01-01", externals: { imdb: "tt90000001" }, rating: { average: 8.5 } };
  const exact = await normalizeTvmaze(show);
  assert.equal(exact.total_runtime_minutes, 75);
  assert.equal(exact.total_season_count, 2);
  assert.equal(exact.total_episode_count, 2);
  assert.equal(exact.end_year, 2022);
  assert.equal(exact.tvmaze_rating, 8.5);
  assert.equal(exact.card_art_type, "placeholder");
  episodes = [{ season: 1, runtime: 30 }, { season: 1, runtime: null }];
  assert.equal((await normalizeTvmaze(show)).total_runtime_minutes, null, "Missing runtime cannot be estimated");
  assert.deepEqual(await normalizeTvmaze({ ...show, externals: {} }), { imdb_id: "" }, "Provider identity must be explicit");

  for (const [id, imdb, success, removed, nominated] of [
    ["due", "tt90000001", "2000-01-01", null, true],
    ["fresh", "tt90000002", new Date().toISOString(), null, true],
    ["removed", "tt90000003", "2000-01-01", "2026-01-01", true],
    ["inactive", "tt90000004", "2000-01-01", null, false]
  ]) {
    await env.DB.prepare("INSERT INTO shows(id,imdb_id,title,first_enrolled_by,created_at,updated_at,metadata_refresh_succeeded_at,admin_removed_at) VALUES(?,?,?,'a','2026-01-01','2026-01-01',?,?)").bind(id, imdb, id, success, removed).run();
    if (nominated) await env.DB.prepare("INSERT INTO show_nominations(user_id,show_id,nominated_at,last_activated_at) VALUES('a',?,'2026-01-01','2026-01-01')").bind(id).run();
  }
  await env.DB.prepare("INSERT INTO user_show_rankings VALUES('a','due',1,'2026-01-01')").run();
  const snapshot = async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
  const protectedBefore = await snapshot("app_users");
  const nominationsBefore = await snapshot("show_nominations");
  const rankingsBefore = await snapshot("user_show_rankings");
  let pending;
  await test.worker.scheduled({}, env, { waitUntil(value) { pending = value; } });
  await pending;
  assert.deepEqual(lookups, ["tt90000001"], "Cron excludes fresh, removed and unnominated rows");
  assert.equal((await env.DB.prepare("SELECT title FROM shows WHERE id='due'").first()).title, "Refreshed");
  assert.deepEqual(await snapshot("app_users"), protectedBefore);
  assert.deepEqual(await snapshot("show_nominations"), nominationsBefore);
  assert.deepEqual(await snapshot("user_show_rankings"), rankingsBefore);
  console.log("Active Worker metadata, exact runtime, canonical identity and Cron eligibility checks passed.");
} finally { await test.dispose(); }
