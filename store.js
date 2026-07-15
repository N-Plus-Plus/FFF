import { computeProvisionalBoard } from "./ranking.js";
import { enrollImdbShow } from "./providers.js";

const LOCAL_STATE_KEY = "fff.localDemo.v4";
const POSTER_BUCKET = "show-posters";

export function createDataStore(config, { demoMode }) {
  if (demoMode) {
    return createLocalDemoStore();
  }
  return createSupabaseStore(config);
}

export function isSupabaseConfigured(config) {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey);
}

function createSupabaseStore(config) {
  let supabasePromise = null;
  const getSupabase = async () => {
    if (!supabasePromise) {
      supabasePromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
        .then((module) => module.createClient(config.supabaseUrl, config.supabaseAnonKey));
    }
    return supabasePromise;
  };

  const rpc = async (name, args) => {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      throw new Error(error.message);
    }
    return data;
  };

  return {
    async load(token) {
      const [catalogue, order, board] = await Promise.all([
        rpc("list_catalogue", { p_link_token: token }),
        rpc("get_user_order", { p_link_token: token }),
        rpc("get_board", { p_link_token: token })
      ]);
      return {
        currentUser: normalizeUser(catalogue.current_user),
        shows: (catalogue.shows || []).map((show) => normalizeShow(show, config)),
        removedShows: [],
        ranked: (order.ranked || []).map((show) => normalizeShow(show, config)),
        unranked: (order.unranked || []).map((show) => normalizeShow(show, config)),
        board: normalizeBoard(board, config)
      };
    },
    async listCatalogue(token) {
      const data = await rpc("list_catalogue", { p_link_token: token });
      return {
        shows: (data.shows || []).map((show) => normalizeShow(show, config)),
        removedShows: []
      };
    },
    async nominate(token, show) {
      const data = await enrollImdbShow(config, token, show.imdbId);
      return normalizeShow(data, config);
    },
    async withdraw(token, showId) {
      return normalizeShow(await rpc("withdraw_nomination", { p_link_token: token, p_show_id: showId }), config);
    },
    async removeShow(token, showId) {
      return normalizeShow(await rpc("admin_remove_show", {
        p_link_token: token,
        p_show_id: showId
      }), config);
    },
    async getOrder(token) {
      const data = await rpc("get_user_order", { p_link_token: token });
      return {
        ranked: (data.ranked || []).map((show) => normalizeShow(show, config)),
        unranked: (data.unranked || []).map((show) => normalizeShow(show, config))
      };
    },
    async replaceRanking(token, showIds) {
      const data = await rpc("replace_user_ranking", { p_link_token: token, p_show_ids: showIds });
      return {
        revision: data.revision,
        updatedAt: data.updated_at,
        ranked: (data.order?.ranked || []).map((show) => normalizeShow(show, config)),
        unranked: (data.order?.unranked || []).map((show) => normalizeShow(show, config))
      };
    },
    async getBoard(token) {
      return normalizeBoard(await rpc("get_board", { p_link_token: token }), config);
    },
    async getBoardRevision(token) {
      const data = await rpc("get_board_revision", { p_link_token: token });
      return {
        revision: Number(data?.revision || 0),
        updatedAt: data?.updated_at || data?.updatedAt || ""
      };
    },
    async subscribeBoardInvalidation(onRevision) {
      const supabase = await getSupabase();
      const channel = supabase
        .channel("board-revision")
        .on("postgres_changes", {
          event: "*",
          schema: "public",
          table: "board_revision_public"
        }, (payload) => {
          const row = payload.new || {};
          onRevision({
            revision: Number(row.revision || 0),
            updatedAt: row.updated_at || ""
          });
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  };
}

function createLocalDemoStore() {
  const notifyRevision = (state) => {
    window.dispatchEvent(new CustomEvent("fff-demo-board-revision", {
      detail: { revision: state.revision, updatedAt: state.updatedAt }
    }));
  };

  return {
    async load(token) {
      const state = readLocalState(token);
      return snapshot(state);
    },
    async listCatalogue(token) {
      const state = readLocalState(token);
      return catalogueSnapshot(state);
    },
    async nominate(token, show) {
      const state = readLocalState(token);
      const user = currentLocalUser(state, token);
      let saved = state.shows.find((item) => item.imdbId === show.imdbId);
      if (saved?.adminRemovedAt) {
        throw new Error("This show was removed by the administrator.");
      }
      if (!saved) {
        saved = {
          ...show,
          id: crypto.randomUUID(),
          firstEnrolledBy: user.id,
          createdAt: new Date().toISOString(),
          adminRemovedAt: null,
          adminRemovedBy: null
        };
        state.shows.push(saved);
      }
      const key = `${user.id}:${saved.id}`;
      const alreadyActive = state.nominations[key] && !state.nominations[key].withdrawnAt;
      if (alreadyActive) {
        return { ...decorateShow(saved, state, user.id), alreadyNominated: true };
      }
      state.nominations[`${user.id}:${saved.id}`] = {
        userId: user.id,
        showId: saved.id,
        nominatedAt: state.nominations[key]?.nominatedAt || new Date().toISOString(),
        lastActivatedAt: new Date().toISOString(),
        withdrawnAt: null
      };
      bumpRevision(state);
      writeLocalState(state);
      notifyRevision(state);
      return decorateShow(saved, state, user.id);
    },
    async withdraw(token, showId) {
      const state = readLocalState(token);
      const user = currentLocalUser(state, token);
      const key = `${user.id}:${showId}`;
      if (state.nominations[key]) {
        state.nominations[key].withdrawnAt = new Date().toISOString();
      }
      removeRankedShowForUser(state, user.id, showId);
      if (!hasActiveNomination(state, showId)) {
        clearCurrentRankingsForShow(state, showId);
      }
      bumpRevision(state);
      writeLocalState(state);
      notifyRevision(state);
      return decorateShow(state.shows.find((show) => show.id === showId), state, user.id);
    },
    async removeShow(token, showId) {
      const state = readLocalState(token);
      const user = currentLocalUser(state, token);
      if (!user.isAdmin) {
        throw new Error("Administrator access is required.");
      }
      const show = state.shows.find((item) => item.id === showId);
      if (!show) {
        throw new Error("Unknown show.");
      }
      show.adminRemovedAt = show.adminRemovedAt || new Date().toISOString();
      show.adminRemovedBy = user.id;
      bumpRevision(state);
      writeLocalState(state);
      notifyRevision(state);
      return decorateShow(show, state, user.id);
    },
    async getOrder(token) {
      const state = readLocalState(token);
      return orderSnapshot(state, currentLocalUser(state, token));
    },
    async replaceRanking(token, showIds) {
      const state = readLocalState(token);
      const user = currentLocalUser(state, token);
      const activeIds = new Set(activeShows(state).map((show) => show.id));
      if (new Set(showIds).size !== showIds.length) {
        throw new Error("Ranking sequence contains duplicate shows.");
      }
      if (showIds.some((id) => !activeIds.has(id))) {
        throw new Error("Ranking sequence contains inactive or unknown shows.");
      }
      state.rankings[user.id] = [...showIds];
      bumpRevision(state);
      writeLocalState(state);
      notifyRevision(state);
      return { revision: state.revision, updatedAt: state.updatedAt, ...orderSnapshot(state, user) };
    },
    async getBoard(token) {
      return boardSnapshot(readLocalState(token));
    },
    async getBoardRevision(token) {
      const state = readLocalState(token);
      return { revision: state.revision, updatedAt: state.updatedAt };
    },
    async subscribeBoardInvalidation(onRevision) {
      const listener = (event) => onRevision(event.detail);
      window.addEventListener("fff-demo-board-revision", listener);
      return () => window.removeEventListener("fff-demo-board-revision", listener);
    },
    async adminSetUserActive(token, userId, isActive) {
      const state = readLocalState(token);
      const admin = currentLocalUser(state, token);
      if (!admin.isAdmin) {
        throw new Error("Administrator access is required.");
      }
      const user = state.users.find((item) => item.id === userId);
      if (!user) {
        throw new Error("Unknown user.");
      }
      user.isActive = Boolean(isActive);
      bumpRevision(state);
      writeLocalState(state);
      notifyRevision(state);
      return normalizeUser(user);
    }
  };
}

function normalizeUser(user) {
  return {
    id: user.id,
    displayName: user.display_name || user.displayName,
    isAdmin: Boolean(user.is_admin || user.isAdmin),
    isActive: user.is_active ?? user.isActive ?? true,
    tokenRevokedAt: user.token_revoked_at || user.tokenRevokedAt || null
  };
}

function normalizeShow(show, config = null) {
  const posterStoragePath = show.poster_storage_path || show.posterStoragePath || "";
  return {
    id: show.id,
    imdbId: show.imdb_id || show.imdbId,
    title: show.title,
    releaseYear: show.release_year || show.releaseYear || null,
    titleType: show.title_type || show.titleType || null,
    seriesStatus: show.series_status || show.seriesStatus || null,
    totalSeasonCount: show.total_season_count ?? show.totalSeasonCount ?? show.metadata?.total_season_count ?? show.metadata?.totalSeasonCount ?? show.metadata?.tvmaze_season_count ?? null,
    totalEpisodeCount: show.total_episode_count ?? show.totalEpisodeCount ?? null,
    totalRuntimeMinutes: show.total_runtime_minutes ?? show.totalRuntimeMinutes ?? null,
    metadataProvider: show.metadata_provider || show.metadataProvider || null,
    providerRecordId: show.provider_record_id || show.providerRecordId || null,
    metadataRetrievedAt: show.metadata_retrieved_at || show.metadataRetrievedAt || null,
    posterStoragePath,
    posterSourceUrl: show.poster_source_url || show.posterSourceUrl || "",
    posterRetrievalStatus: show.poster_retrieval_status || show.posterRetrievalStatus || "",
    posterUpdatedAt: show.poster_updated_at || show.posterUpdatedAt || null,
    posterUrl: posterStoragePath ? posterPublicUrl(config, posterStoragePath) : "",
    backgroundUrl: show.background_url || show.backgroundUrl || show.banner_url || show.bannerUrl || show.backdrop_url || show.backdropUrl || "",
    bannerUrl: show.banner_url || show.bannerUrl || show.background_url || show.backgroundUrl || show.backdrop_url || show.backdropUrl || "",
    backdropUrl: show.backdrop_url || show.backdropUrl || show.background_url || show.backgroundUrl || "",
    disambiguation: show.disambiguation || "",
    currentUserNominated: Boolean(show.current_user_nominated || show.currentUserNominated),
    currentUserMayWithdraw: Boolean(show.current_user_may_withdraw || show.currentUserMayWithdraw),
    currentUserIsAdmin: Boolean(show.current_user_is_admin || show.currentUserIsAdmin),
    activeNominationCount: Number(show.active_nomination_count || show.activeNominationCount || 0),
    isAdminRemoved: Boolean(show.is_admin_removed || show.isAdminRemoved),
    adminRemovedAt: show.admin_removed_at || show.adminRemovedAt || null,
    adminRemovedBy: show.admin_removed_by || show.adminRemovedBy || null,
    rankPosition: show.rank_position || show.rankPosition || null,
    alreadyNominated: Boolean(show.already_nominated || show.alreadyNominated),
    metadata: show.metadata || {}
  };
}

function normalizeBoard(board, config = null) {
  return {
    revision: board?.revision || 0,
    updatedAt: board?.updated_at || board?.updatedAt || "",
    entries: (board?.entries || []).map((entry) => ({
      showId: entry.show_id || entry.showId,
      imdbId: entry.imdb_id || entry.imdbId,
      title: entry.title,
      releaseYear: entry.release_year || entry.releaseYear || null,
      titleType: entry.title_type || entry.titleType || null,
      seriesStatus: entry.series_status || entry.seriesStatus || null,
      totalSeasonCount: entry.total_season_count ?? entry.totalSeasonCount ?? entry.metadata?.total_season_count ?? entry.metadata?.totalSeasonCount ?? entry.metadata?.tvmaze_season_count ?? null,
      totalEpisodeCount: entry.total_episode_count ?? entry.totalEpisodeCount ?? null,
      totalRuntimeMinutes: entry.total_runtime_minutes ?? entry.totalRuntimeMinutes ?? null,
      posterStoragePath: entry.poster_storage_path || entry.posterStoragePath || "",
      posterRetrievalStatus: entry.poster_retrieval_status || entry.posterRetrievalStatus || "",
      posterUrl: entry.poster_storage_path || entry.posterStoragePath
        ? posterPublicUrl(config, entry.poster_storage_path || entry.posterStoragePath)
        : "",
      backgroundUrl: entry.background_url || entry.backgroundUrl || entry.banner_url || entry.bannerUrl || entry.backdrop_url || entry.backdropUrl || "",
      bannerUrl: entry.banner_url || entry.bannerUrl || entry.background_url || entry.backgroundUrl || entry.backdrop_url || entry.backdropUrl || "",
      backdropUrl: entry.backdrop_url || entry.backdropUrl || entry.background_url || entry.backgroundUrl || "",
      disambiguation: entry.disambiguation || "",
      averageRank: entry.average_rank === null || entry.average_rank === undefined ? null : Number(entry.average_rank),
      provisionalScore: entry.provisional_score === null || entry.provisional_score === undefined
        ? null
        : Number(entry.provisional_score),
      aggregatePosition: Number(entry.aggregate_position || entry.aggregatePosition || 0),
      rankedCount: Number(entry.ranked_count || entry.rankedCount || 0),
      rankedActiveUserCount: Number(entry.ranked_active_user_count || entry.rankedActiveUserCount || 0),
      activeUserCount: Number(entry.active_user_count || entry.activeUserCount || 0),
      unrankedActiveUserCount: Number(entry.unranked_active_user_count || entry.unrankedActiveUserCount || 0),
      isConfirmed: Boolean(entry.is_confirmed || entry.isConfirmed)
    }))
  };
}

function readLocalState(token) {
  const existing = localStorage.getItem(LOCAL_STATE_KEY);
  if (existing) {
    const parsed = JSON.parse(existing);
    parsed.currentUserId = currentLocalUser(parsed, token).id;
    return parsed;
  }

  const state = {
    currentUserId: "demo-admin",
    users: [
      { id: "demo-admin", displayName: "Demo admin", isAdmin: true, isActive: true, token: "demo-admin" },
      { id: "demo-user", displayName: "Demo user", isAdmin: false, isActive: true, token: "demo-user" },
      { id: "demo-casey", displayName: "Casey", isAdmin: false, isActive: true, token: "demo-casey" },
      { id: "demo-riley", displayName: "Riley", isAdmin: false, isActive: false, token: "demo-riley" }
    ],
    shows: seededShows(),
    nominations: {},
    rankings: {
      "demo-admin": ["demo-show-bear", "demo-show-bad"],
      "demo-user": ["demo-show-bad", "demo-show-bear"],
      "demo-casey": ["demo-show-bear"],
      "demo-riley": ["demo-show-bad", "demo-show-bear"]
    },
    revision: 1,
    updatedAt: new Date().toISOString()
  };
  seedNominations(state);
  state.currentUserId = currentLocalUser(state, token).id;
  writeLocalState(state);
  return state;
}

function writeLocalState(state) {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
}

function currentLocalUser(state, token) {
  const user = state.users.find((item) => item.token === token) || state.users[0];
  if (!user.isActive || user.tokenRevokedAt) {
    throw new Error("Invalid or inactive user link.");
  }
  return user;
}

function snapshot(state) {
  const user = state.users.find((item) => item.id === state.currentUserId);
  return {
    currentUser: normalizeUser(user),
    ...catalogueSnapshot(state),
    ...orderSnapshot(state, user),
    board: boardSnapshot(state)
  };
}

function catalogueSnapshot(state) {
  const user = state.users.find((item) => item.id === state.currentUserId);
  return {
    shows: activeShows(state).map((show) => decorateShow(show, state, user.id)),
    removedShows: []
  };
}

function orderSnapshot(state, user) {
  const shows = activeShows(state).map((show) => decorateShow(show, state, user.id));
  const order = (state.rankings[user.id] || []).filter((id) => shows.some((show) => show.id === id));
  const ranked = order.map((id) => shows.find((show) => show.id === id));
  const rankedIds = new Set(order);
  return {
    ranked,
    unranked: shows.filter((show) => !rankedIds.has(show.id))
  };
}

function boardSnapshot(state) {
  const shows = activeShows(state).map((show) => decorateShow(show, state, state.currentUserId));
  const entries = computeProvisionalBoard(shows, state.users, state.rankings);
  return normalizeBoard({
    revision: state.revision,
    updated_at: state.updatedAt,
    entries
  });
}

function activeShows(state) {
  return state.shows.filter((show) => {
    if (show.adminRemovedAt) {
      return false;
    }
    return Object.values(state.nominations).some((nomination) => {
      return nomination.showId === show.id && !nomination.withdrawnAt;
    });
  });
}

function decorateShow(show, state, userId) {
  const nomination = state.nominations[`${userId}:${show.id}`];
  const activeNominations = Object.values(state.nominations).filter((item) => item.showId === show.id && !item.withdrawnAt);
  return normalizeShow({
    ...show,
    currentUserNominated: Boolean(nomination && !nomination.withdrawnAt),
    currentUserMayWithdraw: Boolean(nomination && !nomination.withdrawnAt),
    currentUserIsAdmin: Boolean(state.users.find((user) => user.id === userId)?.isAdmin),
    activeNominationCount: activeNominations.length,
    isAdminRemoved: Boolean(show.adminRemovedAt)
  });
}

function hasActiveNomination(state, showId) {
  return Object.values(state.nominations).some((item) => item.showId === showId && !item.withdrawnAt);
}

function removeRankedShowForUser(state, userId, showId) {
  state.rankings[userId] = (state.rankings[userId] || []).filter((id) => id !== showId);
}

function clearCurrentRankingsForShow(state, showId) {
  Object.keys(state.rankings).forEach((userId) => removeRankedShowForUser(state, userId, showId));
}

function posterPublicUrl(config, path) {
  if (!config?.supabaseUrl || !path) {
    return "";
  }
  return `${config.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${POSTER_BUCKET}/${encodeURIComponent(path).replaceAll("%2F", "/")}`;
}

function bumpRevision(state) {
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
}

function seededShows() {
  const now = new Date().toISOString();
  return [
    {
      id: "demo-show-bear",
      imdbId: "tt14452776",
      title: "The Bear",
      releaseYear: 2022,
      titleType: "tvSeries",
      seriesStatus: "Returning Series",
      totalEpisodeCount: 28,
      totalRuntimeMinutes: 844,
      posterStoragePath: "posters/tt14452776.jpg",
      posterRetrievalStatus: "stored",
      metadataProvider: "demo",
      providerRecordId: "tt14452776",
      firstEnrolledBy: "demo-admin",
      createdAt: now,
      adminRemovedAt: null
    },
    {
      id: "demo-show-bad",
      imdbId: "tt0903747",
      title: "Breaking Bad",
      releaseYear: 2008,
      titleType: "tvSeries",
      seriesStatus: "Ended",
      totalEpisodeCount: 62,
      totalRuntimeMinutes: 2943,
      posterStoragePath: "",
      posterRetrievalStatus: "failed",
      metadataProvider: "demo",
      providerRecordId: "tt0903747",
      firstEnrolledBy: "demo-user",
      createdAt: now,
      adminRemovedAt: null
    }
  ];
}

function seedNominations(state) {
  const now = new Date().toISOString();
  [
    ["demo-admin", "demo-show-bear"],
    ["demo-user", "demo-show-bear"],
    ["demo-casey", "demo-show-bear"],
    ["demo-admin", "demo-show-bad"]
  ].forEach(([userId, showId]) => {
    state.nominations[`${userId}:${showId}`] = {
      userId,
      showId,
      nominatedAt: now,
      lastActivatedAt: now,
      withdrawnAt: null
    };
  });
}
