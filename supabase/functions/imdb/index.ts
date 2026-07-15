import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type AppUser = {
  id: string;
  display_name: string;
  is_admin: boolean;
};

type ImdbRequest =
  | { action: "search"; token?: string; query?: string }
  | { action: "lookup"; token?: string; imdbId?: string }
  | { action: "enroll"; token?: string; imdbId?: string };

type NormalizedTitle = {
  imdb_id: string;
  title: string;
  release_year: number | null;
  title_type: string | null;
  series_status: string | null;
  total_episode_count: number | null;
  total_runtime_minutes: number | null;
  poster_url: string | null;
  poster_source_url: string | null;
  poster_storage_path: string | null;
  poster_retrieval_status: string | null;
  metadata_provider: string | null;
  provider_record_id: string | null;
  tvdb_record_id?: string | null;
  disambiguation: string | null;
  metadata: Record<string, unknown>;
};

const CORS_HEADERS = "authorization, x-client-info, apikey, content-type";
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
const EPISODE_TITLE_TYPES = new Set([
  "tvEpisode",
  "episode",
  "tv_episode"
]);
const REJECTED_TITLE_TYPES = new Set([
  ...EPISODE_TITLE_TYPES,
  "tvMovie",
  "tv_movie",
  "movie",
  "tvSpecial",
  "tv_special",
  "special"
]);
const TVMAZE_BASE_URL = "https://api.tvmaze.com";

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (request.method !== "POST") {
    return json({ error: "invalid_method", message: "Use POST." }, 405, cors);
  }

  let body: ImdbRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "Request body must be JSON." }, 400, cors);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return json({ error: "invalid_token", message: "A user link token is required." }, 401, cors);
  }

  const userResult = await resolveUser(token);
  if (!userResult.ok) {
    return json({ error: "invalid_token", message: "Invalid or inactive user link." }, 401, cors);
  }

  const adapter = createImdbProviderAdapter();

  try {
    if (body.action === "search") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (query.length < 2) {
        return json({ error: "invalid_input", message: "Enter at least two characters." }, 400, cors);
      }
      const results = await adapter.search(query);
      return json({ user: userResult.user, results }, 200, cors);
    }

    if (body.action === "lookup") {
      const imdbId = normalizeImdbId(body.imdbId || "");
      if (!imdbId) {
        return json({ error: "invalid_input", message: "Enter a valid IMDb title ID." }, 400, cors);
      }
      const result = await enrichWithTvdbFallback(await adapter.lookup(imdbId));
      if (!result) {
        return json({ error: "not_found", message: "No television title was found for that IMDb ID." }, 404, cors);
      }
      return json({ user: userResult.user, result }, 200, cors);
    }

    if (body.action === "enroll") {
      const imdbId = normalizeImdbId(body.imdbId || "");
      if (!imdbId) {
        return json({ error: "invalid_input", message: "Enter a valid IMDb title ID." }, 400, cors);
      }
      const result = await enrichWithTvdbFallback(await adapter.lookup(imdbId));
      if (!result) {
        return json({ error: "not_found", message: "No television title was found for that IMDb ID." }, 404, cors);
      }
      const show = await enrollShow(token, result);
      return json({ user: userResult.user, show }, 200, cors);
    }

    return json({ error: "invalid_action", message: "Use action search, lookup, or enroll." }, 400, cors);
  } catch (error) {
    const mapped = mapProviderError(error);
    return json(mapped.body, mapped.status, cors);
  }
});

function corsHeaders(origin: string): HeadersInit {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const localOrigins = new Set([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:54321",
    "http://127.0.0.1:54321"
  ]);
  const allowOrigin = allowed.includes(origin) || localOrigins.has(origin)
    ? origin
    : (allowed[0] || "http://localhost:8000");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

async function resolveUser(token: string): Promise<{ ok: true; user: AppUser } | { ok: false }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { "x-application-name": "fff-imdb-edge-function" } }
  });

  const { data, error } = await supabase.rpc("resolve_current_user", { p_link_token: token });
  if (error || !data?.id) {
    return { ok: false };
  }

  return {
    ok: true,
    user: {
      id: data.id,
      display_name: data.display_name,
      is_admin: Boolean(data.is_admin)
    }
  };
}

async function enrollShow(token: string, title: NormalizedTitle) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new ProviderError("supabase_unavailable", 503);
  }

  const metadata = providerMetadata(title);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { "x-application-name": "fff-imdb-enroll" } }
  });

  const { data: nominated, error } = await supabase.rpc("nominate_imdb_show", {
    p_link_token: token,
    p_imdb_id: title.imdb_id,
    p_title: title.title,
    p_release_year: title.release_year,
    p_title_type: title.title_type,
    p_poster_url: title.poster_source_url,
    p_disambiguation: title.disambiguation,
    p_metadata: metadata
  });
  if (error) {
    throw new ProviderError(error.message || "nomination_failed", 400);
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceKey) {
    return nominated;
  }

  const serviceClient = createClient(supabaseUrl, serviceKey, {
    global: { headers: { "x-application-name": "fff-imdb-poster-copy" } }
  });

  const posterResult = await copyPosterToStorage(serviceClient, title).catch((error) => ({
    path: null,
    status: error instanceof PosterError ? error.kind : "failed"
  }));

  const { data: updated } = await serviceClient.rpc("admin_record_show_poster_result", {
    p_show_id: nominated.id,
    p_storage_path: posterResult.path,
    p_source_url: title.poster_source_url,
    p_status: posterResult.status
  });

  return updated || nominated;
}

function providerMetadata(title: NormalizedTitle) {
  return {
    provider_title_type: title.title_type,
    series_status: title.series_status,
    total_episode_count: title.total_episode_count,
    total_runtime_minutes: title.total_runtime_minutes,
    metadata_provider: title.metadata_provider,
    provider_record_id: title.provider_record_id,
    tvdb_record_id: title.tvdb_record_id || null,
    metadata_retrieved_at: new Date().toISOString(),
    poster_source_url: title.poster_source_url,
    poster_retrieval_status: title.poster_source_url ? "pending" : "not_available",
    source_provenance: title.metadata.provenance || null,
    upstream: title.metadata
  };
}

async function copyPosterToStorage(serviceClient: ReturnType<typeof createClient>, title: NormalizedTitle) {
  if (!title.poster_source_url) {
    throw new PosterError("not_available");
  }

  const poster = await fetchPoster(title.poster_source_url);
  const extension = SUPPORTED_POSTER_TYPES.get(poster.contentType);
  if (!extension) {
    throw new PosterError("unsupported_content_type");
  }

  const path = `posters/${title.imdb_id}.${extension}`;
  const { error } = await serviceClient.storage
    .from(POSTER_BUCKET)
    .upload(path, poster.bytes, {
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
        const redirected = new URL(location, nextUrl);
        if (!["http:", "https:"].includes(redirected.protocol)) {
          throw new PosterError("invalid_url");
        }
        nextUrl = redirected.toString();
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

      const bytes = await readBoundedBytes(response);
      return { bytes, contentType };
    } catch (error) {
      if (error instanceof PosterError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PosterError("timeout");
      }
      throw new PosterError("failed");
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
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > MAX_POSTER_BYTES) {
        throw new PosterError("too_large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createImdbProviderAdapter() {
  const timeoutMs = Number(Deno.env.get("IMDB_TIMEOUT_MS") || "8000");

  return {
    configured: true,
    async search(query: string): Promise<NormalizedTitle[]> {
      const url = `${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(query)}`;
      const payload = await fetchProviderJson(url, "", "", timeoutMs);
      return extractTvmazeSearchItems(payload)
        .map((item) => normalizeTvmazeShow(item, null))
        .filter(isTelevisionTitle);
    },
    async lookup(imdbId: string): Promise<NormalizedTitle | null> {
      const url = `${TVMAZE_BASE_URL}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`;
      const payload = await fetchProviderJson(url, "", "", timeoutMs);
      const item = extractSingleItem(payload);
      const episodes = item ? await fetchTvmazeEpisodes(item, timeoutMs) : null;
      const normalized = item ? normalizeTvmazeShow(item, episodes) : null;
      return normalized && isTelevisionTitle(normalized) ? normalized : null;
    }
  };
}

function applyTemplate(template: string, values: Record<string, string>) {
  let next = template;
  for (const [key, value] of Object.entries(values)) {
    next = next.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return next;
}

async function fetchProviderJson(url: string, apiKey: string, apiKeyHeader: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(timeoutMs, 15000)));
  try {
    const headers = new Headers({ accept: "application/json" });
    if (apiKey) {
      headers.set(apiKeyHeader, apiKey);
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status === 404) {
      throw new ProviderError("not_found", 404);
    }
    if (response.status === 429) {
      throw new ProviderError("rate_limited", 429);
    }
    if (!response.ok) {
      throw new ProviderError("upstream_unavailable", response.status);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError("upstream_timeout", 504);
    }
    throw new ProviderError("upstream_unavailable", 503);
  } finally {
    clearTimeout(timer);
  }
}

function extractTvmazeSearchItems(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((item) => isRecord(item) && isRecord(item.show) ? item.show : null)
    .filter(isRecord);
}

function extractSingleItem(payload: unknown): Record<string, unknown> | null {
  if (isRecord(payload)) {
    const candidate = payload.result || payload.title || payload.data;
    if (isRecord(candidate)) {
      return candidate;
    }
    return payload;
  }
  return null;
}

async function fetchTvmazeEpisodes(show: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>[] | null> {
  const tvmazeId = integerValue(show.id);
  if (tvmazeId === null) {
    return null;
  }
  const payload = await fetchProviderJson(`${TVMAZE_BASE_URL}/shows/${tvmazeId}/episodes`, "", "", timeoutMs);
  return Array.isArray(payload) ? payload.filter(isRecord) : null;
}

function normalizeTvmazeShow(show: Record<string, unknown>, episodes: Record<string, unknown>[] | null): NormalizedTitle {
  const externals = isRecord(show.externals) ? show.externals : {};
  const image = isRecord(show.image) ? show.image : {};
  const imdbId = normalizeImdbId(stringValue(externals.imdb));
  const episodeCount = episodes ? episodes.length : null;
  const totalRuntime = episodes ? cumulativeExplicitRuntime(episodes) : null;
  const poster = stringValue(image.original) || stringValue(image.medium);

  return {
    imdb_id: imdbId,
    title: stringValue(show.name),
    release_year: yearValue(show.premiered),
    title_type: stringValue(show.type) || "tvmaze-show",
    series_status: stringValue(show.status) || null,
    total_episode_count: episodeCount,
    total_runtime_minutes: totalRuntime,
    poster_url: poster || null,
    poster_source_url: poster || null,
    poster_storage_path: null,
    poster_retrieval_status: poster ? "not_copied" : "not_available",
    metadata_provider: "tvmaze",
    provider_record_id: integerValue(show.id)?.toString() || null,
    disambiguation: null,
    metadata: {
      tvmaze: show,
      tvmaze_episode_count: episodeCount,
      tvmaze_runtime_complete: totalRuntime !== null,
      provenance: {
        canonical: "tvmaze.externals.imdb",
        title: "tvmaze",
        release_year: "tvmaze",
        title_type: "tvmaze",
        series_status: "tvmaze",
        total_episode_count: episodeCount !== null ? "tvmaze" : null,
        total_runtime_minutes: totalRuntime !== null ? "tvmaze_episodes" : null,
        poster_source_url: poster ? "tvmaze" : null
      }
    }
  };
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

function isTelevisionTitle(title: NormalizedTitle) {
  if (!title.imdb_id || !title.title) {
    return false;
  }
  if (!title.title_type) {
    return true;
  }
  if (REJECTED_TITLE_TYPES.has(title.title_type)) {
    return false;
  }
  return true;
}

async function enrichWithTvdbFallback(primary: NormalizedTitle | null): Promise<NormalizedTitle | null> {
  if (!primary) {
    return null;
  }
  const tvdb = await lookupTvdbByImdbId(primary.imdb_id).catch(() => null);
  if (!tvdb || tvdb.imdb_id !== primary.imdb_id) {
    return primary;
  }

  return {
    ...primary,
    series_status: primary.series_status || tvdb.series_status,
    total_episode_count: primary.total_episode_count ?? tvdb.total_episode_count,
    total_runtime_minutes: primary.total_runtime_minutes ?? tvdb.total_runtime_minutes,
    poster_url: primary.poster_url || tvdb.poster_url,
    poster_source_url: primary.poster_source_url || tvdb.poster_source_url,
    tvdb_record_id: tvdb.provider_record_id,
    metadata: {
      primary: primary.metadata,
      tvdb: tvdb.metadata,
      provenance: {
        canonical: "imdb",
        title: "primary",
        series_status: primary.series_status ? "primary" : tvdb.series_status ? "tvdb" : null,
        total_episode_count: primary.total_episode_count != null ? "primary" : tvdb.total_episode_count != null ? "tvdb" : null,
        total_runtime_minutes: primary.total_runtime_minutes != null ? "primary" : tvdb.total_runtime_minutes != null ? "tvdb" : null,
        poster_source_url: primary.poster_source_url ? "primary" : tvdb.poster_source_url ? "tvdb" : null
      }
    }
  };
}

async function lookupTvdbByImdbId(imdbId: string): Promise<NormalizedTitle | null> {
  const template = Deno.env.get("TVDB_IMDB_URL_TEMPLATE") || "";
  const apiKey = Deno.env.get("TVDB_API_KEY") || "";
  const apiKeyHeader = Deno.env.get("TVDB_API_KEY_HEADER") || "Authorization";
  const timeoutMs = Number(Deno.env.get("TVDB_TIMEOUT_MS") || "8000");
  if (!template || !apiKey) {
    return null;
  }

  const payload = await fetchProviderJson(applyTemplate(template, { imdbId }), apiKey, apiKeyHeader, timeoutMs);
  const item = extractSingleItem(payload);
  if (!item) {
    return null;
  }
  const normalized = normalizeTvdbTitle(item, imdbId);
  return normalized.imdb_id === imdbId ? normalized : null;
}

function normalizeTvdbTitle(item: Record<string, unknown>, canonicalImdbId: string): NormalizedTitle {
  const imdbId = normalizeImdbId(
    stringValue(item.imdb_id)
      || stringValue(item.imdbId)
      || stringValue(item.imdb_id_crossref)
      || stringValue(item.imdbIdCrossref)
  );
  const poster = stringValue(item.poster_url) || stringValue(item.posterUrl) || stringValue(item.image_url) || nestedImageUrl(item);
  const runtimeIsEstimate = booleanValue(item.total_runtime_is_estimate)
    || booleanValue(item.totalRuntimeIsEstimate)
    || booleanValue(item.runtime_is_estimate);

  return {
    imdb_id: imdbId || "",
    title: stringValue(item.title) || stringValue(item.name) || "",
    release_year: yearValue(item.release_year) || yearValue(item.releaseYear) || yearValue(item.year),
    title_type: "tvdb-fallback",
    series_status: stringValue(item.series_status) || stringValue(item.seriesStatus) || stringValue(item.status) || null,
    total_episode_count: integerValue(item.total_episode_count) || integerValue(item.totalEpisodeCount) || integerValue(item.episode_count) || integerValue(item.episodeCount),
    total_runtime_minutes: runtimeIsEstimate ? null : integerValue(item.total_runtime_minutes) || integerValue(item.totalRuntimeMinutes) || integerValue(item.runtime_minutes_total) || null,
    poster_url: poster || null,
    poster_source_url: poster || null,
    poster_storage_path: null,
    poster_retrieval_status: poster ? "not_copied" : "not_available",
    metadata_provider: "tvdb",
    provider_record_id: stringValue(item.tvdb_id) || stringValue(item.tvdbId) || stringValue(item.id) || null,
    disambiguation: null,
    metadata: item
  };
}

function normalizeImdbId(value: string) {
  const match = value.trim().match(/tt\d{7,10}/i);
  return match ? match[0].toLowerCase() : "";
}

function nestedImageUrl(item: Record<string, unknown>) {
  const image = item.i;
  if (isRecord(image)) {
    return stringValue(image.imageUrl) || stringValue(image.url);
  }
  return "";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function yearValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const match = value.match(/\d{4}/);
    return match ? Number(match[0]) : null;
  }
  return null;
}

function integerValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
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

function json(body: Record<string, unknown>, status: number, headers: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function mapProviderError(error: unknown) {
  if (error instanceof ProviderError) {
    if (error.kind !== "not_found" && error.kind !== "rate_limited" && error.kind !== "upstream_timeout") {
      return { status: error.status, body: { error: "provider_error", message: error.message } };
    }
    if (error.kind === "not_found") {
      return { status: 404, body: { error: "not_found", message: "No matching TVmaze television title was found." } };
    }
    if (error.kind === "rate_limited") {
      return { status: 429, body: { error: "rate_limited", message: "TVmaze rate limit reached." } };
    }
    if (error.kind === "upstream_timeout") {
      return { status: 504, body: { error: "upstream_unavailable", message: "TVmaze timed out." } };
    }
  }
  return { status: 503, body: { error: "upstream_unavailable", message: "TVmaze is unavailable." } };
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
