import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type RefreshCandidate = {
  id: string;
  imdb_id: string;
  title: string;
  poster_storage_path?: string | null;
  poster_source_url?: string | null;
};

type NormalizedTitle = {
  imdb_id: string;
  title: string;
  release_year: number | null;
  title_type: string | null;
  series_status: string | null;
  total_season_count: number | null;
  total_episode_count: number | null;
  total_runtime_minutes: number | null;
  poster_source_url: string | null;
  background_url: string | null;
  metadata_provider: string | null;
  provider_record_id: string | null;
  tvdb_record_id: string | null;
  metadata: Record<string, unknown>;
};

const POSTER_BUCKET = "show-posters";
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TIMEOUT_MS = 8000;
const MAX_POSTER_REDIRECTS = 3;
const SUPPORTED_POSTER_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);
const TV_TITLE_TYPES = new Set([
  "tvSeries",
  "tvMiniSeries",
  "tvReality",
  "tvAnimation",
  "tvDocumentary",
  "tvDocumentarySeries",
  "series",
  "miniSeries",
  "tv_series",
  "tv_miniseries",
  "realityTV",
  "documentary",
  "documentarySeries"
]);
const REJECTED_TITLE_TYPES = new Set([
  "tvEpisode",
  "episode",
  "tv_episode",
  "tvMovie",
  "tv_movie",
  "movie",
  "tvSpecial",
  "tv_special",
  "special"
]);
const TVMAZE_BASE_URL = "https://api.tvmaze.com";

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "invalid_method", message: "Use POST." }, 405);
  }

  if (!isTrustedServiceCall(request)) {
    return json({ error: "forbidden", message: "Service-role authorization is required." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const limit = boundedLimit(body?.limit);
  const supabase = serviceClient();
  const summary = { attempted: 0, succeeded: 0, failed: 0, postersStored: 0, skipped: 0 };

  const { data: candidates, error } = await supabase.rpc("admin_list_metadata_refresh_candidates", { p_limit: limit });
  if (error) {
    return json({ error: "candidate_query_failed", message: "Refresh candidates could not be loaded." }, 500);
  }

  for (const candidate of (candidates || []) as RefreshCandidate[]) {
    summary.attempted += 1;
    try {
      const primary = await lookupPrimary(candidate.imdb_id);
      if (!primary) {
        await recordFailure(supabase, candidate.id, "not_found");
        summary.failed += 1;
        continue;
      }
      const merged = await enrichWithTvdbFallback(primary);
      await supabase.rpc("admin_update_show_metadata", {
        p_show_id: candidate.id,
        p_metadata: metadataPayload(merged)
      });

      if (!candidate.poster_storage_path && merged.poster_source_url) {
        const posterResult = await copyPosterToStorage(supabase, merged).catch((posterError) => ({
          path: null,
          status: posterError instanceof PosterError ? posterError.kind : "failed"
        }));
        if (posterResult.path) {
          summary.postersStored += 1;
        }
        await supabase.rpc("admin_record_show_poster_result", {
          p_show_id: candidate.id,
          p_storage_path: posterResult.path,
          p_source_url: merged.poster_source_url,
          p_status: posterResult.status
        });
      }

      summary.succeeded += 1;
    } catch (refreshError) {
      const category = refreshError instanceof ProviderError ? refreshError.kind : "refresh_failed";
      await recordFailure(supabase, candidate.id, category);
      summary.failed += 1;
    }
  }

  console.log("metadata-refresh summary", summary);
  return json({ ok: true, ...summary }, 200);
});

function isTrustedServiceCall(request: Request) {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const scheduleSecret = Deno.env.get("METADATA_REFRESH_SECRET") || "";
  const header = request.headers.get("authorization") || "";
  return (Boolean(serviceKey) && header === `Bearer ${serviceKey}`)
    || (Boolean(scheduleSecret) && header === `Bearer ${scheduleSecret}`);
}

function serviceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    throw new ProviderError("supabase_configuration", 500);
  }
  return createClient(supabaseUrl, serviceKey, {
    global: { headers: { "x-application-name": "fff-metadata-refresh" } }
  });
}

function boundedLimit(value: unknown) {
  const parsed = Number(value || 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), 25));
}

async function lookupPrimary(imdbId: string): Promise<NormalizedTitle | null> {
  const timeoutMs = Number(Deno.env.get("IMDB_TIMEOUT_MS") || "8000");
  const payload = await fetchProviderJson(`${TVMAZE_BASE_URL}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`, {
    apiKey: "",
    apiKeyHeader: "",
    timeoutMs
  });
  const item = extractSingleItem(payload);
  const [episodes, images] = item
    ? await Promise.all([
        fetchTvmazeEpisodes(item, timeoutMs).catch(() => null),
        fetchTvmazeImages(item, timeoutMs).catch(() => null)
      ])
    : [null, null];
  const normalized = item ? normalizeTvmazeShow(item, episodes, images) : null;
  return normalized && normalized.imdb_id === imdbId && isTelevisionTitle(normalized) ? normalized : null;
}

async function enrichWithTvdbFallback(primary: NormalizedTitle) {
  const tvdb = await lookupTvdbByImdbId(primary.imdb_id).catch(() => null);
  if (!tvdb || tvdb.imdb_id !== primary.imdb_id) {
    return {
      ...primary,
      metadata: {
        primary: primary.metadata,
        tvdb: null,
        provenance: provenance(primary, null)
      }
    };
  }

  return {
    ...primary,
    series_status: primary.series_status || tvdb.series_status,
    total_season_count: primary.total_season_count ?? tvdb.total_season_count,
    total_episode_count: primary.total_episode_count ?? tvdb.total_episode_count,
    total_runtime_minutes: primary.total_runtime_minutes ?? tvdb.total_runtime_minutes,
    poster_source_url: primary.poster_source_url || tvdb.poster_source_url,
    background_url: primary.background_url || tvdb.background_url,
    tvdb_record_id: tvdb.provider_record_id,
    metadata: {
      primary: primary.metadata,
      tvdb: tvdb.metadata,
      provenance: provenance(primary, tvdb)
    }
  };
}

async function lookupTvdbByImdbId(imdbId: string): Promise<NormalizedTitle | null> {
  const template = Deno.env.get("TVDB_IMDB_URL_TEMPLATE") || "";
  const apiKey = Deno.env.get("TVDB_API_KEY") || "";
  if (!template || !apiKey) {
    return null;
  }
  const payload = await fetchProviderJson(applyTemplate(template, { imdbId }), {
    apiKey,
    apiKeyHeader: Deno.env.get("TVDB_API_KEY_HEADER") || "Authorization",
    timeoutMs: Number(Deno.env.get("TVDB_TIMEOUT_MS") || "8000")
  });
  const item = extractSingleItem(payload);
  if (!item) {
    return null;
  }
  const normalized = normalizeTvdbTitle(item, imdbId);
  return normalized.imdb_id === imdbId ? normalized : null;
}

function metadataPayload(title: NormalizedTitle) {
  return {
    imdb_id: title.imdb_id,
    title: title.title,
    release_year: title.release_year,
    provider_title_type: title.title_type,
    series_status: title.series_status,
    total_season_count: title.total_season_count,
    total_episode_count: title.total_episode_count,
    total_runtime_minutes: title.total_runtime_minutes,
    metadata_provider: title.metadata_provider,
    provider_record_id: title.provider_record_id,
    tvdb_record_id: title.tvdb_record_id,
    poster_source_url: title.poster_source_url,
    background_url: title.background_url,
    metadata_retrieved_at: new Date().toISOString(),
    metadata_refresh_status: "success",
    metadata_refresh_failure_category: null,
    source_provenance: title.metadata.provenance,
    upstream: title.metadata
  };
}

async function recordFailure(supabase: ReturnType<typeof createClient>, showId: string, category: string) {
  await supabase.rpc("admin_update_show_metadata", {
    p_show_id: showId,
    p_metadata: {
      metadata_refresh_status: "failed",
      metadata_refresh_failure_category: sanitizeCategory(category),
      metadata_retrieved_at: null
    }
  });
}

function sanitizeCategory(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "failed";
}

async function copyPosterToStorage(serviceClientRef: ReturnType<typeof createClient>, title: NormalizedTitle) {
  if (!title.poster_source_url) {
    throw new PosterError("not_available");
  }
  const poster = await fetchPoster(title.poster_source_url);
  const extension = SUPPORTED_POSTER_TYPES.get(poster.contentType);
  if (!extension) {
    throw new PosterError("unsupported_content_type");
  }
  const path = `posters/${title.imdb_id}.${extension}`;
  const { error } = await serviceClientRef.storage.from(POSTER_BUCKET).upload(path, poster.bytes, {
    contentType: poster.contentType,
    upsert: true
  });
  if (error) {
    throw new PosterError("storage_failed");
  }
  return { path, status: "stored" };
}

async function fetchPoster(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new PosterError("invalid_url");
  }
  let nextUrl = parsed.toString();
  for (let redirect = 0; redirect <= MAX_POSTER_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POSTER_TIMEOUT_MS);
    try {
      const response = await fetch(nextUrl, {
        headers: { accept: "image/jpeg,image/png,image/webp" },
        redirect: "manual",
        signal: controller.signal
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === MAX_POSTER_REDIRECTS) {
          throw new PosterError("too_many_redirects");
        }
        nextUrl = new URL(location, nextUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new PosterError("upstream_failed");
      }
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!SUPPORTED_POSTER_TYPES.has(contentType)) {
        throw new PosterError("unsupported_content_type");
      }
      const length = Number(response.headers.get("content-length") || "0");
      if (length > MAX_POSTER_BYTES) {
        throw new PosterError("too_large");
      }
      return { bytes: await readBoundedBytes(response), contentType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new PosterError("too_many_redirects");
}

async function readBoundedBytes(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new PosterError("failed");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_POSTER_BYTES) {
      throw new PosterError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchProviderJson(url: string, options: { apiKey: string; apiKeyHeader: string; timeoutMs: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(options.timeoutMs, 15000)));
  try {
    const headers = new Headers({ accept: "application/json" });
    if (options.apiKey) {
      headers.set(options.apiKeyHeader, options.apiKey);
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status === 404) throw new ProviderError("not_found", 404);
    if (response.status === 429) throw new ProviderError("rate_limited", 429);
    if (!response.ok) throw new ProviderError("upstream_unavailable", response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError("upstream_timeout", 504);
    }
    throw new ProviderError("upstream_unavailable", 503);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTvmazeEpisodes(show: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>[] | null> {
  const tvmazeId = integerValue(show.id);
  if (tvmazeId === null) {
    return null;
  }
  const payload = await fetchProviderJson(`${TVMAZE_BASE_URL}/shows/${tvmazeId}/episodes`, {
    apiKey: "",
    apiKeyHeader: "",
    timeoutMs
  });
  return Array.isArray(payload) ? payload.filter(isRecord) : null;
}

async function fetchTvmazeImages(show: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>[] | null> {
  const tvmazeId = integerValue(show.id);
  if (tvmazeId === null) {
    return null;
  }
  const payload = await fetchProviderJson(`${TVMAZE_BASE_URL}/shows/${tvmazeId}/images`, {
    apiKey: "",
    apiKeyHeader: "",
    timeoutMs
  });
  return Array.isArray(payload) ? payload.filter(isRecord) : null;
}

function normalizeTvmazeShow(
  show: Record<string, unknown>,
  episodes: Record<string, unknown>[] | null,
  images: Record<string, unknown>[] | null = null
): NormalizedTitle {
  const externals = isRecord(show.externals) ? show.externals : {};
  const image = isRecord(show.image) ? show.image : {};
  const imdbId = normalizeImdbId(stringValue(externals.imdb));
  const episodeCount = episodes ? episodes.length : null;
  const seasonCount = episodes ? totalSeasonCount(episodes) : null;
  const totalRuntime = episodes ? cumulativeExplicitRuntime(episodes) : null;
  const poster = stringValue(image.original) || stringValue(image.medium);
  const background = selectTvmazeBackground(images);

  return {
    imdb_id: imdbId,
    title: stringValue(show.name),
    release_year: yearValue(show.premiered),
    title_type: stringValue(show.type) || "tvmaze-show",
    series_status: stringValue(show.status) || null,
    total_season_count: seasonCount,
    total_episode_count: episodeCount,
    total_runtime_minutes: totalRuntime,
    poster_source_url: poster || null,
    background_url: background,
    metadata_provider: "tvmaze",
    provider_record_id: integerValue(show.id)?.toString() || null,
    tvdb_record_id: null,
    metadata: {
      tvmaze: show,
      total_season_count: seasonCount,
      tvmaze_season_count: seasonCount,
      tvmaze_episode_count: episodeCount,
      tvmaze_runtime_complete: totalRuntime !== null,
      tvmaze_background_url: background,
      provenance: {
        canonical: "tvmaze.externals.imdb",
        title: "tvmaze",
        release_year: "tvmaze",
        title_type: "tvmaze",
        series_status: "tvmaze",
        total_season_count: seasonCount !== null ? "tvmaze_episodes" : null,
        total_episode_count: episodeCount !== null ? "tvmaze" : null,
        total_runtime_minutes: totalRuntime !== null ? "tvmaze_episodes" : null,
        poster_source_url: poster ? "tvmaze" : null,
        background_url: background ? "tvmaze_images" : null
      }
    }
  };
}

function selectTvmazeBackground(images: Record<string, unknown>[] | null): string | null {
  if (!images?.length) {
    return null;
  }
  const candidates = images
    .filter((item) => stringValue(item.type).toLowerCase() === "background")
    .map((item) => {
      const resolutions = isRecord(item.resolutions) ? item.resolutions : {};
      const original = isRecord(resolutions.original) ? resolutions.original : {};
      const medium = isRecord(resolutions.medium) ? resolutions.medium : {};
      const selected = stringValue(original.url) ? original : medium;
      return {
        url: stringValue(selected.url),
        width: integerValue(selected.width) || 0,
        height: integerValue(selected.height) || 0
      };
    })
    .filter((item) => item.url);

  candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return candidates[0]?.url || null;
}

function cumulativeExplicitRuntime(episodes: Record<string, unknown>[]) {
  if (!episodes.length) {
    return null;
  }
  let total = 0;
  for (const episode of episodes) {
    const runtime = integerValue(episode.runtime);
    if (runtime === null) {
      return null;
    }
    total += runtime;
  }
  return total;
}

function totalSeasonCount(episodes: Record<string, unknown>[]) {
  const seasons = new Set<number>();
  for (const episode of episodes) {
    const season = integerValue(episode.season);
    if (season !== null && season > 0) {
      seasons.add(season);
    }
  }
  return seasons.size || null;
}

function normalizeTvdbTitle(item: Record<string, unknown>, canonicalImdbId: string): NormalizedTitle {
  const poster = stringValue(item.poster_url) || stringValue(item.posterUrl) || stringValue(item.image_url) || nestedImageUrl(item);
  const runtimeIsEstimate = booleanValue(item.total_runtime_is_estimate) || booleanValue(item.totalRuntimeIsEstimate) || booleanValue(item.runtime_is_estimate);
  return {
    imdb_id: normalizeImdbId(stringValue(item.imdb_id) || stringValue(item.imdbId) || stringValue(item.imdb_id_crossref) || stringValue(item.imdbIdCrossref)),
    title: stringValue(item.title) || stringValue(item.name),
    release_year: yearValue(item.release_year) || yearValue(item.releaseYear) || yearValue(item.year),
    title_type: "tvdb-fallback",
    series_status: stringValue(item.series_status) || stringValue(item.seriesStatus) || stringValue(item.status) || null,
    total_season_count: integerValue(item.total_season_count) || integerValue(item.totalSeasonCount) || integerValue(item.season_count) || integerValue(item.seasonCount),
    total_episode_count: integerValue(item.total_episode_count) || integerValue(item.totalEpisodeCount) || integerValue(item.episode_count) || integerValue(item.episodeCount),
    total_runtime_minutes: runtimeIsEstimate ? null : integerValue(item.total_runtime_minutes) || integerValue(item.totalRuntimeMinutes) || integerValue(item.runtime_minutes_total) || null,
    poster_source_url: poster || null,
    background_url: stringValue(item.background_url) || stringValue(item.backgroundUrl) || stringValue(item.backdrop_url) || stringValue(item.backdropUrl) || stringValue(item.banner_url) || stringValue(item.bannerUrl) || null,
    metadata_provider: "tvdb",
    provider_record_id: stringValue(item.tvdb_id) || stringValue(item.tvdbId) || stringValue(item.id) || null,
    tvdb_record_id: stringValue(item.tvdb_id) || stringValue(item.tvdbId) || stringValue(item.id) || null,
    metadata: item
  };
}

function isTelevisionTitle(title: NormalizedTitle) {
  if (!title.imdb_id || !title.title) return false;
  if (!title.title_type) return true;
  if (REJECTED_TITLE_TYPES.has(title.title_type)) return false;
  return true;
}

function provenance(primary: NormalizedTitle, tvdb: NormalizedTitle | null) {
  return {
    canonical: "imdb",
    title: "primary",
    series_status: primary.series_status ? "primary" : tvdb?.series_status ? "tvdb" : null,
    total_season_count: primary.total_season_count != null ? "primary" : tvdb?.total_season_count != null ? "tvdb" : null,
    total_episode_count: primary.total_episode_count != null ? "primary" : tvdb?.total_episode_count != null ? "tvdb" : null,
    total_runtime_minutes: primary.total_runtime_minutes != null ? "primary" : tvdb?.total_runtime_minutes != null ? "tvdb" : null,
    poster_source_url: primary.poster_source_url ? "primary" : tvdb?.poster_source_url ? "tvdb" : null,
    background_url: primary.background_url ? "primary" : tvdb?.background_url ? "tvdb" : null
  };
}

function extractSingleItem(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const candidate = payload.result || payload.title || payload.data;
  return isRecord(candidate) ? candidate : payload;
}

function applyTemplate(template: string, values: Record<string, string>) {
  let next = template;
  for (const [key, value] of Object.entries(values)) {
    next = next.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return next;
}

function normalizeImdbId(value: string) {
  const match = value.trim().match(/tt\d{7,10}/i);
  return match ? match[0].toLowerCase() : "";
}

function nestedImageUrl(item: Record<string, unknown>) {
  const image = item.i;
  return isRecord(image) ? stringValue(image.imageUrl) || stringValue(image.url) : "";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function yearValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const match = value.match(/\d{4}/);
    return match ? Number(match[0]) : null;
  }
  return null;
}

function integerValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : null;
  }
  return null;
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

class ProviderError extends Error {
  constructor(public kind: string, public status: number) {
    super(kind);
  }
}

class PosterError extends Error {
  constructor(public kind: string) {
    super(kind);
  }
}
