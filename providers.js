const DEMO_RESULTS = [
  {
    imdb_id: "tt14452776",
    title: "The Bear",
    release_year: 2022,
    title_type: "tvSeries",
    series_status: "Returning Series",
    total_episode_count: 28,
    total_runtime_minutes: null,
    poster_url: "",
    poster_source_url: "https://example.invalid/posters/the-bear.jpg",
    poster_retrieval_status: "stored",
    poster_storage_path: "posters/tt14452776.jpg",
    provider: "demo",
    provider_record_id: "tt14452776",
    disambiguation: "Comedy drama",
    metadata: { demo: true }
  },
  {
    imdb_id: "tt0903747",
    title: "Breaking Bad",
    release_year: 2008,
    title_type: "tvSeries",
    series_status: "Ended",
    total_episode_count: 62,
    total_runtime_minutes: null,
    poster_url: "",
    poster_source_url: "https://example.invalid/posters/breaking-bad.jpg",
    poster_retrieval_status: "failed",
    poster_storage_path: "",
    provider: "demo",
    provider_record_id: "tt0903747",
    disambiguation: "Crime drama",
    metadata: { demo: true }
  },
  {
    imdb_id: "tt2861424",
    title: "Rick and Morty",
    release_year: 2013,
    title_type: "tvSeries",
    series_status: "Returning Series",
    total_episode_count: null,
    total_runtime_minutes: null,
    poster_url: "",
    poster_source_url: "",
    poster_retrieval_status: "not_available",
    poster_storage_path: "",
    provider: "demo",
    provider_record_id: "tt2861424",
    disambiguation: "Animated science fiction",
    metadata: { demo: true }
  }
];

const EPISODE_TITLE_TYPES = new Set(["tvEpisode", "episode", "tv_episode"]);
const REJECTED_TITLE_TYPES = new Set([
  ...EPISODE_TITLE_TYPES,
  "tvMovie",
  "tv_movie",
  "movie",
  "tvSpecial",
  "tv_special",
  "special"
]);

export function createMetadataProvider({ config, token, demoMode }) {
  const imdb = demoMode ? createDemoImdbAdapter() : createEdgeImdbAdapter(config, token);

  return {
    providerName: "TVmaze",
    parseImdbId,
    async search(input) {
      const imdbId = parseImdbId(input);
      if (imdbId) {
        const result = await imdb.lookup(imdbId);
        return result ? [result] : [];
      }
      return imdb.search(input);
    },
    lookup(imdbId) {
      return imdb.lookup(imdbId);
    },
    enroll(imdbId) {
      return imdb.enroll(imdbId);
    }
  };
}

function createEdgeImdbAdapter(config, token) {
  return {
    async search(query) {
      const data = await requestImdb(config, token, { action: "search", query });
      return (data.results || []).map(normalizeProviderTitle).filter((item) => item.imdbId && item.title);
    },
    async lookup(imdbId) {
      const data = await requestImdb(config, token, { action: "lookup", imdbId });
      return data.result ? normalizeProviderTitle(data.result) : null;
    },
    async enroll(imdbId) {
      const data = await requestImdb(config, token, { action: "enroll", imdbId });
      return data.show || data.result || null;
    }
  };
}

function createDemoImdbAdapter() {
  return {
    async search(query) {
      const normalized = query.trim().toLowerCase();
      return DEMO_RESULTS
        .filter((show) => show.title.toLowerCase().includes(normalized) || show.imdb_id === normalized)
        .map(normalizeProviderTitle);
    },
    async lookup(imdbId) {
      const result = DEMO_RESULTS.find((show) => show.imdb_id === imdbId);
      return result ? normalizeProviderTitle(result) : null;
    },
    async enroll(imdbId) {
      const result = DEMO_RESULTS.find((show) => show.imdb_id === imdbId);
      return result ? normalizeProviderTitle(result) : null;
    }
  };
}

async function requestImdb(config, token, payload) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("Supabase is not configured, so TV show search is unavailable.");
  }

  const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/imdb`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`
    },
    body: JSON.stringify({ ...payload, token })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `TV metadata request failed with ${response.status}.`);
  }
  return data;
}

export async function enrollImdbShow(config, token, imdbId) {
  const data = await requestImdb(config, token, { action: "enroll", imdbId });
  return data.show || data.result;
}

export function parseImdbId(value) {
  const match = String(value || "").match(/tt\d{7,10}/i);
  return match ? match[0].toLowerCase() : "";
}

export function normalizeProviderTitle(input) {
  if (!input || typeof input !== "object") {
    return {
      imdbId: "",
      title: "",
      metadata: input || {}
    };
  }
  const titleType = input.title_type || input.titleType || input.provider_title_type || input.providerTitleType || null;
  if (REJECTED_TITLE_TYPES.has(titleType)) {
    return {
      imdbId: "",
      title: "",
      metadata: input
    };
  }

  const posterSourceUrl = input.poster_source_url || input.posterSourceUrl || input.poster_url || input.posterUrl || "";
  const runtimeIsEstimate = Boolean(input.total_runtime_is_estimate || input.totalRuntimeIsEstimate || input.runtime_is_estimate || input.runtimeIsEstimate);
  return {
    imdbId: input.imdb_id || input.imdbId || "",
    title: input.title || "",
    releaseYear: input.release_year || input.releaseYear || null,
    titleType,
    seriesStatus: input.series_status || input.seriesStatus || null,
    totalEpisodeCount: input.total_episode_count ?? input.totalEpisodeCount ?? null,
    totalRuntimeMinutes: runtimeIsEstimate ? null : input.total_runtime_minutes ?? input.totalRuntimeMinutes ?? null,
    posterUrl: input.poster_url || input.posterUrl || posterSourceUrl,
    posterSourceUrl,
    posterStoragePath: input.poster_storage_path || input.posterStoragePath || "",
    posterRetrievalStatus: input.poster_retrieval_status || input.posterRetrievalStatus || "",
    posterUpdatedAt: input.poster_updated_at || input.posterUpdatedAt || null,
    metadataProvider: input.metadata_provider || input.metadataProvider || input.provider || "imdb",
    providerRecordId: input.provider_record_id || input.providerRecordId || input.imdb_id || input.imdbId || "",
    disambiguation: input.disambiguation || "",
    metadata: input.metadata || input
  };
}

export function mergePrimaryAndTvdbMetadata(primaryInput, tvdbInput = null, retainedInput = {}) {
  const primary = normalizeProviderTitle(primaryInput);
  const retained = normalizeProviderTitle(retainedInput);
  const tvdb = tvdbInput ? normalizeTvdbFallback(tvdbInput, primary.imdbId) : null;

  if (!primary.imdbId) {
    throw new Error("Canonical IMDb title ID is required.");
  }

  const merged = {
    ...primary,
    imdbId: primary.imdbId,
    title: primary.title || retained.title,
    releaseYear: firstPresent(primary.releaseYear, retained.releaseYear),
    titleType: firstPresent(primary.titleType, retained.titleType),
    seriesStatus: firstPresent(primary.seriesStatus, tvdb?.seriesStatus, retained.seriesStatus),
    totalEpisodeCount: firstPresent(primary.totalEpisodeCount, tvdb?.totalEpisodeCount, retained.totalEpisodeCount),
    totalRuntimeMinutes: firstPresent(primary.totalRuntimeMinutes, tvdb?.totalRuntimeMinutes, retained.totalRuntimeMinutes),
    posterUrl: firstPresent(primary.posterUrl, tvdb?.posterUrl, retained.posterUrl),
    posterSourceUrl: firstPresent(primary.posterSourceUrl, tvdb?.posterSourceUrl, retained.posterSourceUrl),
    metadataProvider: primary.metadataProvider,
    providerRecordId: primary.providerRecordId,
    tvdbRecordId: tvdb?.providerRecordId || retained.tvdbRecordId || null,
    metadata: {
      retained: retained.metadata || {},
      primary: primary.metadata || {},
      tvdb: tvdb?.metadata || null,
      provenance: {
        canonical: "imdb",
        title: "primary",
        seriesStatus: primary.seriesStatus ? "primary" : tvdb?.seriesStatus ? "tvdb" : retained.seriesStatus ? "retained" : null,
        totalEpisodeCount: primary.totalEpisodeCount != null ? "primary" : tvdb?.totalEpisodeCount != null ? "tvdb" : retained.totalEpisodeCount != null ? "retained" : null,
        totalRuntimeMinutes: primary.totalRuntimeMinutes != null ? "primary" : tvdb?.totalRuntimeMinutes != null ? "tvdb" : retained.totalRuntimeMinutes != null ? "retained" : null,
        posterSourceUrl: primary.posterSourceUrl ? "primary" : tvdb?.posterSourceUrl ? "tvdb" : retained.posterSourceUrl ? "retained" : null
      }
    }
  };

  return merged;
}

export function normalizeTvdbFallback(input, canonicalImdbId) {
  const imdbId = parseImdbId(input.imdb_id || input.imdbId || input.imdb_id_crossref || input.imdbIdCrossref || "");
  if (!canonicalImdbId || imdbId !== canonicalImdbId) {
    return null;
  }

  const runtimeIsEstimate = Boolean(input.total_runtime_is_estimate || input.totalRuntimeIsEstimate || input.runtime_is_estimate || input.runtimeIsEstimate);
  return {
    imdbId,
    title: input.title || input.name || "",
    seriesStatus: input.series_status || input.seriesStatus || input.status || null,
    totalEpisodeCount: input.total_episode_count ?? input.totalEpisodeCount ?? input.episode_count ?? input.episodeCount ?? null,
    totalRuntimeMinutes: runtimeIsEstimate ? null : input.total_runtime_minutes ?? input.totalRuntimeMinutes ?? input.runtime_minutes_total ?? null,
    posterUrl: input.poster_url || input.posterUrl || input.image_url || input.imageUrl || "",
    posterSourceUrl: input.poster_source_url || input.posterSourceUrl || input.poster_url || input.posterUrl || input.image_url || input.imageUrl || "",
    metadataProvider: "tvdb",
    providerRecordId: input.tvdb_id || input.tvdbId || input.id || null,
    metadata: input
  };
}

export function isWeeklyRefreshDue(lastSuccessfulRefresh, now = new Date()) {
  if (!lastSuccessfulRefresh) {
    return true;
  }
  const last = new Date(lastSuccessfulRefresh);
  if (Number.isNaN(last.getTime())) {
    return true;
  }
  return now.getTime() - last.getTime() >= 7 * 24 * 60 * 60 * 1000;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "") ?? null;
}
