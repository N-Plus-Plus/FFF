// Server-only fanart.tv boundary. Credentials never enter URLs or browser responses.
import { ensureArtworkShow, normalizeTvmaze } from "./index.js";

const fail = (status, message) => Object.assign(new Error(message), { status });
const numeric = (value) => /^[1-9]\d{0,11}$/.test(String(value || "")) ? String(value) : null;
const parseMetadata = (show) => { try { return typeof show.metadata === "string" ? JSON.parse(show.metadata) : show.metadata || {}; } catch { return {}; } };
const tvdbId = (show) => numeric(parseMetadata(show).tvmaze?.externals?.thetvdb) || numeric(show.tvdb_record_id);
function sourceUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "assets.fanart.tv" && !u.username && !u.password && !u.search && !u.hash && u.pathname.startsWith("/fanart/") ? u.href : null; }
  catch { return null; }
}
function suitable(body, id) {
  if (String(body?.thetvdb_id) !== id || (body.tvbanner !== undefined && !Array.isArray(body.tvbanner))) throw fail(503, "fanart.tv returned an invalid banner list.");
  const seen = new Set();
  return (body.tvbanner || []).flatMap((image) => {
    const bannerId = numeric(image.id), url = sourceUrl(image.url);
    if (!bannerId || !url || Number(image.width) !== 1000 || Number(image.height) !== 185 || seen.has(bannerId)) return [];
    seen.add(bannerId);
    return [{ id: bannerId, url, lang: String(image.lang || ""), width: 1000, height: 185 }];
  });
}
const pending = new WeakMap();
const unavailable = (diagnostic) => Object.assign(fail(503, "fanart.tv is temporarily unavailable. Try again later."), { fanartDiagnostic: diagnostic });
export async function banners(id, env) {
  if (!id) return [];
  if (!env.FANART_TV?.trim()) throw fail(503, "fanart.tv artwork is not configured. Contact the operator.");
  const cached = await env.DB.prepare("SELECT * FROM fanart_cache WHERE tvdb_id=?").bind(id).first();
  if (cached && cached.expires_at > Date.now()) {
    if (cached.failure) throw unavailable({ category: "cached_failure", expiresAt: cached.expires_at });
    return JSON.parse(cached.banners);
  }
  let requests = pending.get(env.DB);
  if (!requests) { requests = new Map(); pending.set(env.DB, requests); }
  if (requests.has(id)) return requests.get(id);
  const promise = (async () => {
    let category = "transport_or_runtime", upstreamStatus = null;
    try {
      const response = await fetch(`https://webservice.fanart.tv/v3.2/tv/${id}`, {
        // workerd rejects redirect:"error". Manual mode never forwards credentials.
        headers: { "api-key": env.FANART_TV.trim(), accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(8000)
      });
      upstreamStatus = response.status;
      if (!response.ok && response.status !== 404) {
        category = response.status >= 300 && response.status < 400 ? "redirect" : [401,403].includes(response.status) ? "credentials" : response.status === 429 ? "rate_limit" : "upstream_http";
        const retry = Number(response.headers.get("retry-after"));
        throw Object.assign(fail(503, "fanart.tv is temporarily unavailable. Try again later."), { retry: Number.isFinite(retry) ? Math.max(300, Math.min(retry, 86400)) : 300 });
      }
      let result = [];
      if (response.status !== 404) {
        category = "invalid_json";
        const body = await response.json();
        category = "invalid_banner_list";
        result = suitable(body, id);
      }
      category = "cache_write";
      await env.DB.prepare("INSERT INTO fanart_cache(tvdb_id,banners,expires_at,failure) VALUES(?,?,?,0) ON CONFLICT(tvdb_id) DO UPDATE SET banners=excluded.banners,expires_at=excluded.expires_at,failure=0")
        .bind(id, JSON.stringify(result), Date.now() + 86400000).run();
      return result;
    } catch (error) {
      const retrySeconds = error.retry || 300;
      const diagnostic = { category: error.name === "TimeoutError" ? "timeout" : category, upstreamStatus, retrySeconds };
      // Fixed categories/status only: never log URLs, IDs, credentials, bodies or raw errors.
      console.warn("fanart_discovery_failure", JSON.stringify(diagnostic));
      await env.DB.prepare("INSERT INTO fanart_cache(tvdb_id,banners,expires_at,failure) VALUES(?,'[]',?,1) ON CONFLICT(tvdb_id) DO UPDATE SET expires_at=excluded.expires_at,failure=1")
        .bind(id, Date.now() + retrySeconds * 1000).run();
      throw unavailable(diagnostic);
    }
  })();
  requests.set(id, promise);
  try { return await promise; } finally { requests.delete(id); }
}
async function retain(banner, id, env) {
  // Immutable source-derived keys prevent refresh/save races from overwriting selected bytes.
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(banner.url)))].map((v) => v.toString(16).padStart(2,"0")).join("");
  const key = `card-art/fanart/${id}/${banner.id}-${digest}`;
  if (await env.ARTWORK.head(key)) return key;
  const response = await fetch(banner.url, { headers: { accept: "image/jpeg,image/png,image/webp" }, redirect: "manual", signal: AbortSignal.timeout(8000) });
  const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!response.ok || !["image/jpeg","image/png","image/webp"].includes(type) || Number(response.headers.get("content-length") || 0) > 5242880) throw fail(503, "The banner could not be downloaded. Try again.");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 5242880) { await reader.cancel(); throw fail(503,"The banner is too large."); } chunks.push(value); }
  if (!size) throw fail(503,"The banner could not be downloaded. Try again.");
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  await env.ARTWORK.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { source: banner.url, provider: "fanart.tv" } });
  return key;
}
async function select(show, banner, id, manual, env) {
  const key = await retain(banner, id, env);
  const stamp = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE shows SET card_art_storage_path=?,card_art_source_url=?,card_art_type='fanart-tvbanner',card_art_width=1000,card_art_height=185,card_art_retrieval_status='stored',card_art_updated_at=?,fanart_banner_id=?,card_art_manual=?,background_url=? WHERE id=? ${manual ? "" : "AND card_art_manual=0"} RETURNING id`)
    .bind(key,banner.url,stamp,banner.id,manual ? 1 : 0,banner.url,show.id).first();
  if (result) await env.DB.prepare("UPDATE app_revisions SET board_revision=board_revision+1,board_updated_at=? WHERE singleton=1").bind(stamp).run();
  return !!result;
}
export async function preferBanner(show, fresh, env) {
  if (show.card_art_manual) return "unchanged";
  const id = tvdbId(fresh) || tvdbId(show);
  const options = await banners(id, env);
  const banner = options[0];
  if (!banner) return false;
  if (show.card_art_type === "fanart-tvbanner" && show.fanart_banner_id === banner.id && show.card_art_source_url === banner.url && show.card_art_storage_path && await env.ARTWORK.head(show.card_art_storage_path)) return "unchanged";
  return await select(show,banner,id,false,env) ? "updated" : "unchanged";
}
async function resolve(user, input, env) {
  if (!user.is_admin) throw fail(403,"Administrator access is required.");
  const imdb = String(input.imdbId || "").toLowerCase();
  if (!/^tt\d{7,10}$/.test(imdb)) throw fail(400,"Enter a valid IMDb title ID.");
  let show = await env.DB.prepare("SELECT * FROM shows WHERE imdb_id=?").bind(imdb).first();
  if (show?.admin_removed_at) throw fail(403,"This show was removed by the administrator.");
  let fresh;
  if (!show || !tvdbId(show)) {
    const response = await fetch(`https://api.tvmaze.com/lookup/shows?imdb=${imdb}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw fail(503,"TVmaze is unavailable. Try again.");
    fresh = await normalizeTvmaze(await response.json());
    if (fresh.imdb_id !== imdb) throw fail(503,"TVmaze could not resolve this series.");
  }
  return { show, fresh, imdb, id: tvdbId(fresh || show) || tvdbId(show || {}) };
}
export async function bannerOptions(user, input, env) {
  const {show,id} = await resolve(user,input,env);
  const options = await banners(id,env);
  return { banners: options.map((b) => ({ id: b.id, lang: b.lang, url: `/artwork/fanart/${id}/${b.id}` })), selectedId: show?.fanart_banner_id || null, manual: !!show?.card_art_manual,
    currentUrl: show?.card_art_storage_path ? `/artwork/${show.card_art_storage_path}` : null };
}
export async function saveBanner(user, input, env) {
  const resolved = await resolve(user,input,env);
  const banner = (await banners(resolved.id,env)).find((b) => b.id === String(input.bannerId));
  if (!banner) throw fail(400,"This banner is unavailable. Reopen the artwork selector.");
  // Validate/download before creating a canonical row for a not-yet-nominated search result.
  await retain(banner,resolved.id,env);
  const show = resolved.show || await ensureArtworkShow(user,resolved.fresh,env);
  await select(show,banner,resolved.id,true,env);
  const selected = await env.DB.prepare("SELECT card_art_storage_path FROM shows WHERE id=?").bind(show.id).first();
  return { saved: true, artwork: { card_art_url: `/artwork/${selected.card_art_storage_path}`, card_art_type: "fanart-tvbanner" } };
}
export async function bannerPreview(url, env) {
  let match = url.pathname.match(/^\/artwork\/fanart\/([1-9]\d{0,11})\/([1-9]\d{0,11})$/);
  if (match) {
    const banner = (await banners(match[1],env)).find((b) => b.id === match[2]);
    if (!banner) throw fail(404,"Banner not found.");
    const object = await env.ARTWORK.get(await retain(banner,match[1],env));
    return new Response(object.body,{headers:{"content-type":object.httpMetadata.contentType}});
  }
  match = url.pathname.match(/^\/artwork\/card-art\/fanart\/([1-9]\d{0,11})\/([1-9]\d{0,11}-[a-f0-9]{64})$/);
  if (!match) throw fail(404,"Banner not found.");
  const object = await env.ARTWORK.get(url.pathname.slice("/artwork/".length));
  if (!object) throw fail(404,"Banner not found.");
  return new Response(object.body,{headers:{"content-type":object.httpMetadata.contentType}});
}
