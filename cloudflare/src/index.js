import { participantAvatars } from "./avatars.js";
import { preferBanner, bannerOptions, saveBanner, bannerPreview } from "./fanart.js";
import { authenticate, authRoute, appOrigin, sameOrigin, localDemo } from "./google-auth.js";
import { ACTIVE_SHOW_SQL } from "./show-visibility.js";
import { sendRankingReminders } from "./ranking-reminders.js";

const TVMAZE = "https://api.tvmaze.com";
const json = (body, status = 200) => Response.json(body, { status });
const now = () => new Date().toISOString();
const PUBLIC_FILES = new Set(["/login.html", "/login.js", "/style.css", "/wire-wednesday.png", ...[400,600,700,800].map((n) => `/vendor/lexend-deca-latin-${n}.woff2`)]);
const PRIVATE_FILES = new Set(["/index.html", "/app.js", "/bootstrap.js", "/api.js", "/config.js", "/store.js", "/providers.js", "/ranking.js", "/vendor/lucide.min.js", "/vendor/lucide-LICENSE.txt", "/vendor/lexend-deca-LICENSE.txt"]);

// Verifier injection is an in-process test seam, never an HTTP/env bypass.
export function createWorker({ verifyGoogle } = {}) { return {
  async fetch(request, env) {
    let response;
    try { response = await handleRequest(request, env, verifyGoogle); }
    catch (error) { response = json({ message: error.status ? error.message : "Request failed." }, error.status || 500); }
    const secured = new Response(response.body, response);
    secured.headers.set("Referrer-Policy", "no-referrer");
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Cache-Control", "private, no-store");
    secured.headers.set("Vary", "Cookie");
    secured.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    secured.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https: data:; connect-src 'self'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    if (response.headers.get("X-WW-Login") === "1") {
      // Google GIS is the only external script, only on the anonymous sign-in document.
      secured.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; font-src 'self'; img-src 'self' https://accounts.google.com https://ssl.gstatic.com data:; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
      secured.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    }
    secured.headers.delete("X-WW-Login");
    if (new URL(request.url).protocol === "https:") secured.headers.set("Strict-Transport-Security", "max-age=31536000");
    return secured;
  },
  async scheduled(event, env, ctx) {
    // Keep metadata at its existing UTC time; the extra 01:00 event is email-only.
    if (!event.cron || event.cron === "0 2 * * 3") ctx.waitUntil(refreshDueShows(env));
    if (event.cron === "0 1 * * 3" || event.cron === "0 2 * * 3") ctx.waitUntil(sendRankingReminders(event, env));
  }
}; }
export default createWorker();

async function handleRequest(request, env, verifyGoogle) {
  const url = new URL(request.url), path = url.pathname;
  if (url.origin !== appOrigin(env)) return json({ message: "Use the Wire Wednesday application origin." }, 403);
  if (path.startsWith("/auth/")) return authRoute(request, env, verifyGoogle);
  if (path.startsWith("/v1/")) {
    if (request.method !== "POST") return json({ message: "Not found." }, 404);
    sameOrigin(request, env);
    const user = await authenticate(request, env);
    const expectedParticipant = request.headers.get("X-WW-Participant");
    if (expectedParticipant && expectedParticipant !== user.id) return Response.json({ message: "Your signed-in account changed. Reload the application.", code: "SESSION_CHANGED" }, { status: 409 });
    if (!(request.headers.get("content-type") || "").startsWith("application/json")) return json({ message: "Use JSON." }, 415);
    const text = await request.text();
    if (text.length > 32768) return json({ message: "Request is too large." }, 413);
    let input;
    try { input = JSON.parse(text); } catch { return json({ message: "Invalid JSON." }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ message: "Invalid JSON." }, 400);
    // Actor selection belongs exclusively to the session, never request fields.
    if (["token", "userId", "user_id", "participantId", "participant_id", "google_sub"].some((key) => key in input)) return json({ message: "Participant overrides are not accepted." }, 400);
    let result;
    switch (path) {
      case "/v1/load": result = await load(user, env.DB); break;
      case "/v1/catalogue": result = await catalogue(user, env.DB); break;
      case "/v1/order": result = await order(user, env.DB); break;
      case "/v1/board": result = await board(user, env.DB); break;
      case "/v1/revision": result = await revision(env.DB); break;
      case "/v1/admin/status": result = await adminStatus(user, env.DB); break;
      case "/v1/nominate": result = await nominate(user, input.imdbId, env); break;
      case "/v1/withdraw": result = await withdraw(user, input.showId, env.DB); break;
      case "/v1/ranking": result = await replaceRanking(user, input.showIds, env.DB); break;
      case "/v1/admin/artwork": result = input.action === "save" ? await saveBanner(user, input, env) : await bannerOptions(user, input, env); break;
      case "/v1/admin/remove": result = await remove(user, input.showId, env.DB); break;
      case "/v1/metadata": result = await metadata(user, input, env); break;
      default: return json({ message: "Not found." }, 404);
    }
    return json(result);
  }
  if (!["GET", "HEAD"].includes(request.method)) return json({ message: "Not found." }, 404);
  if (path === "/avatar.png") {
    const user = await authenticate(request, env);
    const filename = participantAvatars.get(user.id);
    if (!filename || !env.ASSETS) return json({ message: "Not found." }, 404);
    return env.ASSETS.fetch(new Request(new URL(`/avatars/${filename}`, url), { method: request.method }));
  }
  if (path.startsWith("/artwork/")) {
    await authenticate(request, env);
    const response = (path.startsWith("/artwork/fanart/") || path.startsWith("/artwork/card-art/fanart/")) ? await bannerPreview(url, env) : await artwork(url, env, {});
    return request.method === "HEAD" ? new Response(null, response) : response;
  }
  if (!env.ASSETS) return json({ message: "Not found." }, 404);
  if (path !== "/" && !PUBLIC_FILES.has(path) && !PRIVATE_FILES.has(path)) return json({ message: "Not found." }, 404);
  let assetPath = path;
  if (path === "/login.html") {
    try { await authenticate(request, env); return new Response(null, { status: 303, headers: { Location: "/" } }); }
    catch (error) { if (error.status !== 401) throw error; }
  }
  if (path === "/" || path === "/index.html") {
    if (!localDemo(request, env) || url.searchParams.get("demo") !== "1") {
      try { await authenticate(request, env); }
      catch (error) { if (error.status !== 401) throw error; assetPath = "/login.html"; }
    }
    if (assetPath !== "/login.html") assetPath = "/index.html";
  } else if (!PUBLIC_FILES.has(path) && !localDemo(request, env)) {
    await authenticate(request, env);
  }
  // Strip OAuth parameters and historical link parameters before asset delivery.
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), { method: request.method }));
  const result = new Response(response.body, response);
  if (assetPath === "/login.html") result.headers.set("X-WW-Login", "1");
  return result;
}

const http = (status, message) => Object.assign(new Error(message), { status });
async function activeShows(db) { return (await db.prepare(`SELECT s.* FROM shows s WHERE ${ACTIVE_SHOW_SQL} ORDER BY s.created_at,s.title`).all()).results; }
async function showJson(show, user, db) {
  const nominated = !!await db.prepare("SELECT 1 FROM show_nominations WHERE user_id=? AND show_id=? AND withdrawn_at IS NULL").bind(user.id, show.id).first();
  const count = await db.prepare("SELECT count(*) AS n FROM show_nominations WHERE show_id=? AND withdrawn_at IS NULL").bind(show.id).first();
  return { ...show, imdb_id: String(show.imdb_id).toLowerCase(), current_user_is_admin: !!user.is_admin, current_user_nominated: nominated, current_user_may_withdraw: nominated, active_nomination_count: Number(count.n) };
}
async function catalogue(user, db) { return { current_user: userJson(user), shows: await Promise.all((await activeShows(db)).map((s) => showJson(s, user, db))), removed_shows: user.is_admin ? await Promise.all(((await db.prepare("SELECT * FROM shows WHERE admin_removed_at IS NOT NULL ORDER BY admin_removed_at DESC,title").all()).results).map((s) => showJson(s, user, db))) : [] }; }
const userJson = (u) => ({ id: u.id, display_name: u.display_name, is_admin: !!u.is_admin, is_active: !!u.is_active });
async function order(user, db) { const shows = await activeShows(db); const ranks = (await db.prepare("SELECT show_id,rank_position FROM user_show_rankings WHERE user_id=? AND rank_position IS NOT NULL ORDER BY rank_position").bind(user.id).all()).results; const byId = new Map(shows.map((s) => [s.id, s])); const rankedIds = new Set(ranks.map((r) => r.show_id)); return { current_user: userJson(user), ranked: await Promise.all(ranks.filter((r) => byId.has(r.show_id)).map(async (r) => ({ ...await showJson(byId.get(r.show_id), user, db), rank_position: r.rank_position }))), unranked: await Promise.all(shows.filter((s) => !rankedIds.has(s.id)).map((s) => showJson(s, user, db))) }; }
async function load(user, db) { const [c, o, b] = await Promise.all([catalogue(user, db), order(user, db), board(user, db)]); return { current_user: c.current_user, shows: c.shows, removed_shows: c.removed_shows, ranked: o.ranked, unranked: o.unranked, board: b }; }
async function revision(db) { return (await db.prepare("SELECT board_revision AS revision,board_updated_at AS updated_at FROM app_revisions WHERE singleton=1").first()) || { revision: 0, updated_at: "" }; }
async function adminStatus(user, db) {
  if (!user.is_admin) throw http(403, "Administrator access is required.");
  const counts = await db.prepare("SELECT (SELECT count(*) FROM app_users u JOIN participant_google_auth a ON a.user_id=u.id WHERE u.is_active=1 AND a.enabled=1) AS active_user_count,(SELECT count(*) FROM shows WHERE admin_removed_at IS NOT NULL) AS removed_show_count").first();
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
  const activeUsers = Number((await db.prepare("SELECT count(*) AS n FROM app_users u JOIN participant_google_auth a ON a.user_id=u.id WHERE u.is_active=1 AND a.enabled=1").first()).n); const byId = new Map(shows.map((s) => [s.id, s]));
  const entries = await Promise.all(ordered.map(async (id, index) => { const s = byId.get(id); const rankedActive = Number((await db.prepare("SELECT count(*) AS n FROM user_show_rankings r JOIN app_users u ON u.id=r.user_id WHERE r.show_id=? AND r.rank_position IS NOT NULL AND u.is_active=1 AND EXISTS (SELECT 1 FROM participant_google_auth a WHERE a.user_id=u.id AND a.enabled=1)").bind(id).first()).n); return { ...await showJson(s, user, db), show_id: id, aggregate_position: index + 1, strategy_id: "sequential-irv-v1", ranked_count: ranked.filter((r) => r.show_id === id).length, ranked_active_user_count: rankedActive, active_user_count: activeUsers, unranked_active_user_count: Math.max(0, activeUsers - rankedActive), is_confirmed: activeUsers > 0 && rankedActive === activeUsers }; })); return { ...await revision(db), entries };
}
function numeric(id) { const n = String(id).replace(/\D/g, "").replace(/^0+/, "") || "0"; return [n.length, n]; }
function cmp(a, b, ids) { const x = numeric(ids.get(a)), y = numeric(ids.get(b)); return x[0] - y[0] || x[1].localeCompare(y[1]); }
function irv(remaining, queues, ids) { let pool = [...remaining]; while (pool.length) { const votes = new Map(pool.map((id) => [id, 0])); for (const ballot of queues.values()) { const pick = ballot.find((id) => votes.has(id)); if (pick) votes.set(pick, votes.get(pick) + 1); } const max = Math.max(...votes.values()), winners = [...votes].filter(([, n]) => n === max).map(([id]) => id); if (winners.length === 1) return winners[0]; const min = Math.min(...votes.values()), losers = [...votes].filter(([, n]) => n === min).map(([id]) => id); if (losers.length === pool.length) return winners.sort((a,b) => cmp(b,a,ids))[0]; pool = pool.filter((id) => id !== losers.sort((a,b) => cmp(a,b,ids))[0]); } return null; }
async function metadata(user, input, env) { const action = input.action; if (action === "search") { const hits = await provider(`${TVMAZE}/search/shows?q=${encodeURIComponent(String(input.query || ""))}`); return { results: (await Promise.all(hits.slice(0, 10).map((v) => normalizeTvmaze(v.show, env)))).filter((v) => v.imdb_id) }; } if (action === "lookup" || action === "enroll") { const imdb = String(input.imdbId || "").toLowerCase(); if (!/^tt\d{7,10}$/.test(imdb)) throw http(400, "Enter a valid IMDb title ID."); const show = await provider(`${TVMAZE}/lookup/shows?imdb=${imdb}`); const result = await normalizeTvmaze(show, env); if (action === "enroll") return { show: await nominateResolved(user, result, env) }; return { result }; } if (action === "verify-backgrounds") return verifyBackgrounds(input.items, env); throw http(400, "Unknown metadata action."); }
async function nominate(user, imdb, env) { const show = await provider(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdb)}`); return nominateResolved(user, await normalizeTvmaze(show, env), env); }
export async function ensureArtworkShow(user, item, env) { if (!item.imdb_id || !item.title) throw http(400, "TVmaze did not provide a canonical TV IMDb title."); const db = env.DB, existing = await db.prepare("SELECT * FROM shows WHERE imdb_id=?").bind(item.imdb_id).first(); if (existing?.admin_removed_at) throw http(403, "This show was removed by the administrator."); const id = existing?.id || crypto.randomUUID(), stamp = now(); if (!existing) await db.prepare("INSERT INTO shows(id,imdb_id,title,release_year,end_year,title_type,provider_title_type,series_status,total_season_count,total_episode_count,total_runtime_minutes,metadata_provider,provider_record_id,metadata_retrieved_at,metadata_refresh_attempted_at,metadata_refresh_succeeded_at,metadata_refresh_status,poster_source_url,card_art_source_url,card_art_type,card_art_width,card_art_height,background_url,disambiguation,metadata,first_enrolled_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,item.imdb_id,item.title,item.release_year,item.end_year,item.title_type,item.title_type,item.series_status,item.total_season_count,item.total_episode_count,item.total_runtime_minutes,"tvmaze",item.provider_record_id,stamp,stamp,stamp,"success",item.poster_source_url,item.card_art_source_url,item.card_art_type,item.card_art_width,item.card_art_height,item.background_url,"",JSON.stringify(item.metadata),user.id,stamp,stamp).run(); if (!existing) await retainArtwork(id,item,env).catch(() => {}); return await db.prepare("SELECT * FROM shows WHERE id=?").bind(id).first(); }
async function nominateResolved(user, item, env) { const show = await ensureArtworkShow(user,item,env), db = env.DB, id = show.id, stamp = now(); const was = await db.prepare("SELECT 1 FROM show_nominations WHERE user_id=? AND show_id=? AND withdrawn_at IS NULL").bind(user.id,id).first(); await db.prepare("INSERT INTO show_nominations(user_id,show_id,nominated_at,last_activated_at,withdrawn_at) VALUES(?,?,?,?,NULL) ON CONFLICT(user_id,show_id) DO UPDATE SET last_activated_at=excluded.last_activated_at,withdrawn_at=NULL").bind(user.id,id,stamp,stamp).run();  await preferBanner(await db.prepare("SELECT * FROM shows WHERE id=?").bind(id).first(), item, env).catch(() => {}); await bump(db); return { ...await showJson(await db.prepare("SELECT * FROM shows WHERE id=?").bind(id).first(),user,db), already_nominated: !!was }; }
async function retainArtwork(showId, item, env) {
  const retained = { poster: false, cardArt: false };
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
    await env.DB.prepare(`UPDATE shows SET ${column}=?, ${statusColumn}=?, updated_at=? WHERE id=? ${kind === "card-art" ? "AND card_art_manual=0 AND coalesce(card_art_type,'') <> 'fanart-tvbanner'" : ""}`).bind(key, "stored", now(), showId).run();
    if (kind === "posters") retained.poster = true;
    else retained.cardArt = true;
  }
  return retained;
}
async function verifyBackgrounds(items, env) { const updated = [], seen = new Set(); for (const item of Array.isArray(items) ? items.slice(0, 30) : []) { const id = String(item?.showId || "").trim(), imdb = String(item?.imdbId || "").trim().toLowerCase(); if (!id || !/^tt\d{7,10}$/.test(imdb) || seen.has(id)) continue; seen.add(id); const existing = await env.DB.prepare("SELECT * FROM shows WHERE id=? AND imdb_id=?").bind(id, imdb).first(); if (!existing || existing.card_art_manual) continue; const show = await provider(`${TVMAZE}/lookup/shows?imdb=${imdb}`).catch(() => null); if (!show) continue; const fresh = await normalizeTvmaze(show); const preferred = await preferBanner(existing, fresh, env).catch(() => false); if (preferred) { if (preferred === "updated") updated.push(id); continue; } if (existing.card_art_type === "fanart-tvbanner") continue; if (!fresh.card_art_source_url || fresh.card_art_type === "placeholder") continue; const changed = existing.card_art_source_url !== fresh.card_art_source_url || existing.card_art_type !== fresh.card_art_type || Number(existing.card_art_width || 0) !== Number(fresh.card_art_width || 0) || Number(existing.card_art_height || 0) !== Number(fresh.card_art_height || 0); if (!changed) continue; const retained = await retainArtwork(id, fresh, env).catch(() => null); if (!retained?.cardArt) continue; await env.DB.prepare("UPDATE shows SET card_art_source_url=?,card_art_type=?,card_art_width=?,card_art_height=?,background_url=?,metadata=?,updated_at=? WHERE id=? AND card_art_manual=0 AND coalesce(card_art_type,'') <> 'fanart-tvbanner'").bind(fresh.card_art_source_url,fresh.card_art_type,fresh.card_art_width,fresh.card_art_height,fresh.background_url,JSON.stringify(fresh.metadata),now(),id).run(); updated.push(id); } if (updated.length) await bump(env.DB); return { updatedCount: updated.length, updated }; }
async function provider(url) { const response = await fetch(url, { headers: { accept: "application/json" } }); if (!response.ok) throw http(response.status === 404 ? 404 : 503, response.status === 404 ? "Show not found." : "TVmaze is unavailable."); return response.json(); }
export async function normalizeTvmaze(show) { const imdb = String(show?.externals?.imdb || "").toLowerCase(); if (!/^tt\d{7,10}$/.test(imdb)) return { imdb_id: "" }; const episodes = await provider(`${TVMAZE}/shows/${show.id}/episodes`).catch(() => null); const images = await provider(`${TVMAZE}/shows/${show.id}/images`).catch(() => []); const art = selectArt(show, images); const runtimes = Array.isArray(episodes) && episodes.length && episodes.every((e) => Number.isFinite(e.runtime)) ? episodes.reduce((n,e) => n+e.runtime,0) : null; return { imdb_id: imdb, title: show.name, release_year: year(show.premiered), end_year: year(show.ended), title_type: show.type || "tvmaze-show", series_status: show.status || null, total_season_count: episodes ? new Set(episodes.map((e) => e.season).filter(Boolean)).size || null : null, total_episode_count: episodes?.length || null, total_runtime_minutes: runtimes, tvmaze_rating: show.rating?.average ?? null, metadata_provider: "tvmaze", provider_record_id: String(show.id), poster_source_url: show.image?.original || show.image?.medium || null, card_art_source_url: art.url, card_art_type: art.type, card_art_width: art.width, card_art_height: art.height, background_url: ["background","banner"].includes(art.type) ? art.url : null, metadata: { tvmaze: show, tvmaze_rating: show.rating?.average ?? null, tvmaze_card_art_type: art.type } }; }
function year(value) { const m = String(value || "").match(/^\d{4}/); return m ? Number(m[0]) : null; }
function selectArt(show, images) { const candidates = []; for (const type of ["background", "banner"]) for (const image of Array.isArray(images) ? images : []) { if (image?.type !== type) continue; const source = type === "background" ? image?.resolutions?.original : image?.resolutions?.original || image?.resolutions?.medium; if (source?.url) candidates.push({ type, url: source.url, width: Number(source.width) || null, height: Number(source.height) || null, main: !!image.main }); } if (candidates.length) return candidates.sort((a,b) => { const da = a.width && a.height ? Math.abs(Math.log((a.width / a.height) / 5)) : Infinity, db = b.width && b.height ? Math.abs(Math.log((b.width / b.height) / 5)) : Infinity; return da - db || Number(b.main) - Number(a.main) || ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)); })[0]; const poster = show.image?.original || show.image?.medium; return poster ? { type: "poster", url: poster, width: null, height: null } : { type: "placeholder", url: null, width: null, height: null }; }
async function artwork(url, env, headers) { const key = decodeURIComponent(url.pathname.slice("/artwork/".length)); if (!/^(posters|card-art)\/tt\d{7,10}\.(jpg|jpeg|png|webp)$/i.test(key)) return json({ message: "Not found." }, 404, headers); const object = await env.ARTWORK.get(key); return object ? new Response(object.body, { headers: { ...headers, "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, no-store" } }) : json({ message: "Not found." }, 404, headers); }
async function refreshDueShows(env) { const rows = (await env.DB.prepare("SELECT * FROM shows WHERE admin_removed_at IS NULL AND EXISTS(SELECT 1 FROM show_nominations n WHERE n.show_id=shows.id AND n.withdrawn_at IS NULL) AND (metadata_refresh_succeeded_at IS NULL OR metadata_refresh_succeeded_at <= datetime('now','-7 days')) LIMIT 25").all()).results; for (const old of rows) { try { const fresh = await normalizeTvmaze(await provider(`${TVMAZE}/lookup/shows?imdb=${old.imdb_id}`)); if (!fresh.imdb_id) continue; const artChanged = old.card_art_source_url !== fresh.card_art_source_url || old.card_art_type !== fresh.card_art_type || Number(old.card_art_width || 0) !== Number(fresh.card_art_width || 0) || Number(old.card_art_height || 0) !== Number(fresh.card_art_height || 0); const fanart = await preferBanner(old, fresh, env).catch(() => false); if (!old.card_art_manual && !fanart && old.card_art_type !== "fanart-tvbanner" && artChanged && fresh.card_art_source_url && fresh.card_art_type !== "placeholder") { const retained = await retainArtwork(old.id, fresh, env).catch(() => null); if (retained?.cardArt) await env.DB.prepare("UPDATE shows SET card_art_source_url=?,card_art_type=?,card_art_width=?,card_art_height=?,background_url=?,updated_at=? WHERE id=? AND card_art_manual=0 AND coalesce(card_art_type,'') <> 'fanart-tvbanner'").bind(fresh.card_art_source_url,fresh.card_art_type,fresh.card_art_width,fresh.card_art_height,fresh.background_url,now(),old.id).run(); } await env.DB.prepare("UPDATE shows SET title=?,release_year=?,end_year=?,series_status=?,total_season_count=?,total_episode_count=?,total_runtime_minutes=?,metadata_provider='tvmaze',provider_record_id=?,metadata_retrieved_at=?,metadata_refresh_attempted_at=?,metadata_refresh_succeeded_at=?,metadata_refresh_status='success',metadata=?,updated_at=? WHERE id=?").bind(fresh.title,fresh.release_year,fresh.end_year,fresh.series_status,fresh.total_season_count,fresh.total_episode_count,fresh.total_runtime_minutes,fresh.provider_record_id,now(),now(),now(),JSON.stringify(fresh.metadata),now(),old.id).run(); await bump(env.DB); } catch { await env.DB.prepare("UPDATE shows SET metadata_refresh_attempted_at=?,metadata_refresh_status='failed',metadata_refresh_failure_category='upstream_failed' WHERE id=?").bind(now(),old.id).run(); } } }
