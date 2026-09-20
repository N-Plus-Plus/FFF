import { sha256LowerHex } from "./auth.js";

const TVMAZE = "https://api.tvmaze.com";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const now = () => new Date().toISOString();

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (origin && !cors["access-control-allow-origin"]) return json({ message: "Origin is not allowed." }, 403);
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/artwork/")) return artwork(url, env, cors);
      if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) return json({ message: "Not found." }, 404, cors);
      const input = await request.json();
      const user = await requireUser(input.token, env.DB);
      let result;
      switch (url.pathname) {
        case "/v1/load": result = await load(user, env.DB); break;
        case "/v1/catalogue": result = await catalogue(user, env.DB); break;
        case "/v1/order": result = await order(user, env.DB); break;
        case "/v1/board": result = await board(user, env.DB); break;
        case "/v1/revision": result = await revision(env.DB); break;
        case "/v1/admin/status": result = await adminStatus(user, env.DB); break;
        case "/v1/nominate": result = await nominate(user, input.imdbId, env); break;
        case "/v1/withdraw": result = await withdraw(user, input.showId, env.DB); break;
        case "/v1/ranking": result = await replaceRanking(user, input.showIds, env.DB); break;
        case "/v1/admin/remove": result = await remove(user, input.showId, env.DB); break;
        case "/v1/metadata": result = await metadata(user, input, env); break;
        default: return json({ message: "Not found." }, 404, cors);
      }
      return json(result, 200, cors);
    } catch (error) {
      const status = error.status || 500;
      return json({ message: status === 500 ? "Request failed." : error.message }, status, cors);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(refreshDueShows(env)); }
};

function corsHeaders(origin, env) {
  const fixed = (env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim());
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return (local || fixed.includes(origin)) ? { "access-control-allow-origin": origin, "vary": "Origin", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } : {};
}
async function requireUser(token, db) {
  if (typeof token !== "string" || token.length < 32) throw http(401, "Invalid or inactive user link.");
  const row = await db.prepare("SELECT * FROM app_users WHERE link_token_hash=? AND is_active=1 AND token_revoked_at IS NULL").bind(await sha256LowerHex(token)).first();
  if (!row) throw http(401, "Invalid or inactive user link."); return row;
}
const http = (status, message) => Object.assign(new Error(message), { status });
async function activeShows(db) { return (await db.prepare("SELECT s.* FROM shows s WHERE s.admin_removed_at IS NULL AND EXISTS (SELECT 1 FROM show_nominations n WHERE n.show_id=s.id AND n.withdrawn_at IS NULL) ORDER BY s.created_at,s.title").all()).results; }
async function showJson(show, user, db) {
  const nominated = !!await db.prepare("SELECT 1 FROM show_nominations WHERE user_id=? AND show_id=? AND withdrawn_at IS NULL").bind(user.id, show.id).first();
  const count = await db.prepare("SELECT count(*) AS n FROM show_nominations WHERE show_id=? AND withdrawn_at IS NULL").bind(show.id).first();
  return { ...show, imdb_id: String(show.imdb_id).toLowerCase(), current_user_is_admin: !!user.is_admin, current_user_nominated: nominated, current_user_may_withdraw: nominated, active_nomination_count: Number(count.n) };
}
async function catalogue(user, db) { return { current_user: userJson(user), shows: await Promise.all((await activeShows(db)).map((s) => showJson(s, user, db))), removed_shows: user.is_admin ? await Promise.all(((await db.prepare("SELECT * FROM shows WHERE admin_removed_at IS NOT NULL ORDER BY admin_removed_at DESC,title").all()).results).map((s) => showJson(s, user, db))) : [] }; }
const userJson = (u) => ({ id: u.id, display_name: u.display_name, is_admin: !!u.is_admin, is_active: !!u.is_active, token_revoked_at: u.token_revoked_at });
async function order(user, db) { const shows = await activeShows(db); const ranks = (await db.prepare("SELECT show_id,rank_position FROM user_show_rankings WHERE user_id=? AND rank_position IS NOT NULL ORDER BY rank_position").bind(user.id).all()).results; const byId = new Map(shows.map((s) => [s.id, s])); const rankedIds = new Set(ranks.map((r) => r.show_id)); return { current_user: userJson(user), ranked: await Promise.all(ranks.filter((r) => byId.has(r.show_id)).map(async (r) => ({ ...await showJson(byId.get(r.show_id), user, db), rank_position: r.rank_position }))), unranked: await Promise.all(shows.filter((s) => !rankedIds.has(s.id)).map((s) => showJson(s, user, db))) }; }
async function load(user, db) { const [c, o, b] = await Promise.all([catalogue(user, db), order(user, db), board(user, db)]); return { current_user: c.current_user, shows: c.shows, removed_shows: c.removed_shows, ranked: o.ranked, unranked: o.unranked, board: b }; }
async function revision(db) { return (await db.prepare("SELECT board_revision AS revision,board_updated_at AS updated_at FROM app_revisions WHERE singleton=1").first()) || { revision: 0, updated_at: "" }; }
async function adminStatus(user, db) {
  if (!user.is_admin) throw http(403, "Administrator access is required.");
  const counts = await db.prepare("SELECT (SELECT count(*) FROM app_users WHERE is_active=1 AND token_revoked_at IS NULL) AS active_user_count,(SELECT count(*) FROM shows WHERE admin_removed_at IS NOT NULL) AS removed_show_count").first();
  return { current_user: userJson(user), active_user_count: Number(counts.active_user_count), removed_show_count: Number(counts.removed_show_count) };
}
async function bump(db) { await db.prepare("UPDATE app_revisions SET board_revision=board_revision+1,board_updated_at=? WHERE singleton=1").bind(now()).run(); }
async function replaceRanking(user, ids, db) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw http(400, "Ranking sequence contains duplicate shows.");
  const active = new Set((await activeShows(db)).map((s) => s.id)); if (ids.some((id) => !active.has(id))) throw http(400, "Ranking sequence contains inactive or unknown shows.");
  const statements = [db.prepare("UPDATE user_show_rankings SET rank_position=NULL,updated_at=? WHERE user_id=?").bind(now(), user.id)];
  ids.forEach((id, index) => statements.push(db.prepare("INSERT INTO user_show_rankings(user_id,show_id,rank_position,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,show_id) DO UPDATE SET rank_position=excluded.rank_position,updated_at=excluded.updated_at").bind(user.id, id, index + 1, now())));
  await db.batch(statements); await bump(db); return { ...await revision(db), order: await order(user, db) };
}
async function withdraw(user, id, db) { const show = await db.prepare("SELECT * FROM shows WHERE id=?").bind(id).first(); if (!show) throw http(400, "Unknown show."); await db.batch([db.prepare("UPDATE show_nominations SET withdrawn_at=? WHERE user_id=? AND show_id=? AND withdrawn_at IS NULL").bind(now(), user.id, id), db.prepare("DELETE FROM user_show_rankings WHERE user_id=? AND show_id=?").bind(user.id, id)]); const live = await db.prepare("SELECT 1 FROM show_nominations WHERE show_id=? AND withdrawn_at IS NULL").bind(id).first(); if (!live) await db.prepare("DELETE FROM user_show_rankings WHERE show_id=?").bind(id).run(); await bump(db); return showJson(show, user, db); }
async function remove(user, id, db) { if (!user.is_admin) throw http(403, "Administrator access is required."); const result = await db.prepare("UPDATE shows SET admin_removed_at=coalesce(admin_removed_at,?),admin_removed_by=coalesce(admin_removed_by,?),updated_at=? WHERE id=? RETURNING *").bind(now(), user.id, now(), id).first(); if (!result) throw http(400, "Unknown show."); await bump(db); return showJson(result, user, db); }
async function board(user, db) {
  const shows = (await activeShows(db)).filter(async () => true); const ranked = (await db.prepare("SELECT user_id,show_id,rank_position FROM user_show_rankings WHERE rank_position IS NOT NULL ORDER BY user_id,rank_position").all()).results;
  const candidates = shows.filter((s) => ranked.some((r) => r.show_id === s.id)); const queues = new Map(); for (const r of ranked) { if (!queues.has(r.user_id)) queues.set(r.user_id, []); queues.get(r.user_id).push(r.show_id); }
  const ordered = []; let remaining = candidates.map((s) => s.id); while (remaining.length) { const winner = irv(remaining, queues, new Map(shows.map((s) => [s.id, s.imdb_id]))); if (!winner) break; ordered.push(winner); remaining = remaining.filter((id) => id !== winner); }
  const activeUsers = Number((await db.prepare("SELECT count(*) AS n FROM app_users WHERE is_active=1 AND token_revoked_at IS NULL").first()).n); const byId = new Map(shows.map((s) => [s.id, s]));
  const entries = await Promise.all(ordered.map(async (id, index) => { const s = byId.get(id); const rankedActive = Number((await db.prepare("SELECT count(*) AS n FROM user_show_rankings r JOIN app_users u ON u.id=r.user_id WHERE r.show_id=? AND r.rank_position IS NOT NULL AND u.is_active=1 AND u.token_revoked_at IS NULL").bind(id).first()).n); return { ...await showJson(s, user, db), show_id: id, aggregate_position: index + 1, strategy_id: "sequential-irv-v1", ranked_count: ranked.filter((r) => r.show_id === id).length, ranked_active_user_count: rankedActive, active_user_count: activeUsers, unranked_active_user_count: Math.max(0, activeUsers - rankedActive), is_confirmed: activeUsers > 0 && rankedActive === activeUsers }; })); return { ...await revision(db), entries };
}
function numeric(id) { const n = String(id).replace(/\D/g, "").replace(/^0+/, "") || "0"; return [n.length, n]; }
function cmp(a, b, ids) { const x = numeric(ids.get(a)), y = numeric(ids.get(b)); return x[0] - y[0] || x[1].localeCompare(y[1]); }
function irv(remaining, queues, ids) { let pool = [...remaining]; while (pool.length) { const votes = new Map(pool.map((id) => [id, 0])); for (const ballot of queues.values()) { const pick = ballot.find((id) => votes.has(id)); if (pick) votes.set(pick, votes.get(pick) + 1); } const max = Math.max(...votes.values()), winners = [...votes].filter(([, n]) => n === max).map(([id]) => id); if (winners.length === 1) return winners[0]; const min = Math.min(...votes.values()), losers = [...votes].filter(([, n]) => n === min).map(([id]) => id); if (losers.length === pool.length) return winners.sort((a,b) => cmp(b,a,ids))[0]; pool = pool.filter((id) => id !== losers.sort((a,b) => cmp(a,b,ids))[0]); } return null; }
async function metadata(user, input, env) { const action = input.action; if (action === "search") { const hits = await provider(`${TVMAZE}/search/shows?q=${encodeURIComponent(String(input.query || ""))}`); return { results: (await Promise.all(hits.slice(0, 10).map((v) => normalizeTvmaze(v.show, env)))).filter((v) => v.imdb_id) }; } if (action === "lookup" || action === "enroll") { const imdb = String(input.imdbId || "").toLowerCase(); if (!/^tt\d{7,10}$/.test(imdb)) throw http(400, "Enter a valid IMDb title ID."); const show = await provider(`${TVMAZE}/lookup/shows?imdb=${imdb}`); const result = await normalizeTvmaze(show, env); if (action === "enroll") return { show: await nominateResolved(user, result, env) }; return { result }; } if (action === "verify-backgrounds") return { updatedCount: 0, updated: [] }; throw http(400, "Unknown metadata action."); }
async function nominate(user, imdb, env) { const show = await provider(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdb)}`); return nominateResolved(user, await normalizeTvmaze(show, env), env); }
async function nominateResolved(user, item, env) { if (!item.imdb_id || !item.title) throw http(400, "TVmaze did not provide a canonical TV IMDb title."); const db = env.DB, existing = await db.prepare("SELECT * FROM shows WHERE imdb_id=?").bind(item.imdb_id).first(); if (existing?.admin_removed_at) throw http(403, "This show was removed by the administrator."); const id = existing?.id || crypto.randomUUID(), stamp = now(); if (!existing) await db.prepare("INSERT INTO shows(id,imdb_id,title,release_year,end_year,title_type,provider_title_type,series_status,total_season_count,total_episode_count,total_runtime_minutes,metadata_provider,provider_record_id,metadata_retrieved_at,metadata_refresh_attempted_at,metadata_refresh_succeeded_at,metadata_refresh_status,poster_source_url,card_art_source_url,card_art_type,card_art_width,card_art_height,background_url,disambiguation,metadata,first_enrolled_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.imdb_id,item.title,item.release_year,item.end_year,item.title_type,item.title_type,item.series_status,item.total_season_count,item.total_episode_count,item.total_runtime_minutes,"tvmaze",item.provider_record_id,stamp,stamp,stamp,"success",item.poster_source_url,item.card_art_source_url,item.card_art_type,item.card_art_width,item.card_art_height,item.background_url,"",JSON.stringify(item.metadata),user.id,stamp,stamp).run(); const was = await db.prepare("SELECT 1 FROM show_nominations WHERE user_id=? AND show_id=? AND withdrawn_at IS NULL").bind(user.id,id).first(); await db.prepare("INSERT INTO show_nominations(user_id,show_id,nominated_at,last_activated_at,withdrawn_at) VALUES(?,?,?,?,NULL) ON CONFLICT(user_id,show_id) DO UPDATE SET last_activated_at=excluded.last_activated_at,withdrawn_at=NULL").bind(user.id,id,stamp,stamp).run(); await retainArtwork(id, item, env).catch(() => {}); await bump(db); return { ...await showJson(await db.prepare("SELECT * FROM shows WHERE id=?").bind(id).first(),user,db), already_nominated: !!was }; }
async function retainArtwork(showId, item, env) {
  for (const [kind, source, column] of [["posters", item.poster_source_url, "poster_storage_path"], ["card-art", item.card_art_source_url, "card_art_storage_path"]]) {
    if (!source || (kind === "card-art" && item.card_art_type === "placeholder")) continue;
    const response = await fetch(source, { headers: { accept: "image/jpeg,image/png,image/webp" } });
    const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type) || Number(response.headers.get("content-length") || 0) > 5242880) continue;
    const bytes = await response.arrayBuffer(); if (bytes.byteLength > 5242880) continue;
    const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    const key = `${kind}/${item.imdb_id}.${extension}`;
    await env.ARTWORK.put(key, bytes, { httpMetadata: { contentType: type } });
    const statusColumn = kind === "posters" ? "poster_retrieval_status" : "card_art_retrieval_status";
    await env.DB.prepare(`UPDATE shows SET ${column}=?, ${statusColumn}=?, updated_at=? WHERE id=?`).bind(key, "stored", now(), showId).run();
  }
}
async function provider(url) { const response = await fetch(url, { headers: { accept: "application/json" } }); if (!response.ok) throw http(response.status === 404 ? 404 : 503, response.status === 404 ? "Show not found." : "TVmaze is unavailable."); return response.json(); }
async function normalizeTvmaze(show) { const imdb = String(show?.externals?.imdb || "").toLowerCase(); if (!/^tt\d{7,10}$/.test(imdb)) return { imdb_id: "" }; const episodes = await provider(`${TVMAZE}/shows/${show.id}/episodes`).catch(() => null); const images = await provider(`${TVMAZE}/shows/${show.id}/images`).catch(() => []); const art = selectArt(show, images); const runtimes = Array.isArray(episodes) && episodes.length && episodes.every((e) => Number.isFinite(e.runtime)) ? episodes.reduce((n,e) => n+e.runtime,0) : null; return { imdb_id: imdb, title: show.name, release_year: year(show.premiered), end_year: year(show.ended), title_type: show.type || "tvmaze-show", series_status: show.status || null, total_season_count: episodes ? new Set(episodes.map((e) => e.season).filter(Boolean)).size || null : null, total_episode_count: episodes?.length || null, total_runtime_minutes: runtimes, tvmaze_rating: show.rating?.average ?? null, metadata_provider: "tvmaze", provider_record_id: String(show.id), poster_source_url: show.image?.original || show.image?.medium || null, card_art_source_url: art.url, card_art_type: art.type, card_art_width: art.width, card_art_height: art.height, background_url: ["background","banner"].includes(art.type) ? art.url : null, metadata: { tvmaze: show, tvmaze_rating: show.rating?.average ?? null, tvmaze_card_art_type: art.type } }; }
function year(value) { const m = String(value || "").match(/^\d{4}/); return m ? Number(m[0]) : null; }
function selectArt(show, images) { for (const type of ["background", "banner"]) { const image = images.filter((i) => i.type === type).sort((a,b) => Number(b.main)-Number(a.main))[0]; const source = image?.resolutions?.original || image?.resolutions?.medium; if (source?.url) return { type, url: source.url, width: source.width || null, height: source.height || null }; } const poster = show.image?.original || show.image?.medium; return poster ? { type: "poster", url: poster, width: null, height: null } : { type: "placeholder", url: null, width: null, height: null }; }
async function artwork(url, env, headers) { const key = decodeURIComponent(url.pathname.slice("/artwork/".length)); if (!/^(posters|card-art)\/tt\d{7,10}\.(jpg|jpeg|png|webp)$/i.test(key)) return json({ message: "Not found." }, 404, headers); const object = await env.ARTWORK.get(key); return object ? new Response(object.body, { headers: { ...headers, "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "public, max-age=604800" } }) : json({ message: "Not found." }, 404, headers); }
async function refreshDueShows(env) { const rows = (await env.DB.prepare("SELECT * FROM shows WHERE admin_removed_at IS NULL AND EXISTS(SELECT 1 FROM show_nominations n WHERE n.show_id=shows.id AND n.withdrawn_at IS NULL) AND (metadata_refresh_succeeded_at IS NULL OR metadata_refresh_succeeded_at <= datetime('now','-7 days')) LIMIT 25").all()).results; for (const old of rows) { try { const fresh = await normalizeTvmaze(await provider(`${TVMAZE}/lookup/shows?imdb=${old.imdb_id}`)); if (!fresh.imdb_id) continue; await env.DB.prepare("UPDATE shows SET title=?,release_year=?,end_year=?,series_status=?,total_season_count=?,total_episode_count=?,total_runtime_minutes=?,metadata_provider='tvmaze',provider_record_id=?,metadata_retrieved_at=?,metadata_refresh_attempted_at=?,metadata_refresh_succeeded_at=?,metadata_refresh_status='success',metadata=?,updated_at=? WHERE id=?").bind(fresh.title,fresh.release_year,fresh.end_year,fresh.series_status,fresh.total_season_count,fresh.total_episode_count,fresh.total_runtime_minutes,fresh.provider_record_id,now(),now(),now(),JSON.stringify(fresh.metadata),now(),old.id).run(); await bump(env.DB); } catch { await env.DB.prepare("UPDATE shows SET metadata_refresh_attempted_at=?,metadata_refresh_status='failed',metadata_refresh_failure_category='upstream_failed' WHERE id=?").bind(now(),old.id).run(); } } }
