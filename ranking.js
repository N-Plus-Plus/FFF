export const BOARD_AGGREGATE_STRATEGY_ID = "sequential-irv-v1";

export function compareImdbTieSeed(leftImdbId, rightImdbId) {
  const left = imdbNumericComponent(leftImdbId);
  const right = imdbNumericComponent(rightImdbId);

  if (!left || !right) {
    throw new Error("Canonical IMDb IDs are required for Board tie-breaking.");
  }
  const result = compareNumericStrings(left, right);
  if (result === 0) {
    throw new Error(`Duplicate canonical IMDb numeric component in Board tie-break: ${leftImdbId}`);
  }
  return -result;
}

export function computeProvisionalBoard(shows, users, rankingsByUser) {
  const activeUsers = users.filter(isUserCurrentlyActive);
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  const activeUserCount = activeUsers.length;
  const showById = new Map(shows.map((show) => [show.id, show]));
  const eligibleIds = shows
    .filter((show) => users.some((user) => (rankingsByUser[user.id] || []).includes(show.id)))
    .map((show) => show.id);

  const ballots = users.map((user) => ({
    userId: user.id,
    rankedShowIds: uniqueKnownIds(rankingsByUser[user.id] || [], showById)
  }));

  const sequence = produceSequentialIrvSequence(eligibleIds, ballots, showById);

  return sequence.map((showId, index) => {
    const show = showById.get(showId);
    const rankedUserIds = users
      .filter((user) => (rankingsByUser[user.id] || []).includes(showId))
      .map((user) => user.id);
    const rankedActiveUserCount = rankedUserIds.filter((userId) => activeUserIds.has(userId)).length;

    return {
      strategy_id: BOARD_AGGREGATE_STRATEGY_ID,
      show_id: show.id,
      imdb_id: show.imdbId,
      title: show.title,
      release_year: show.releaseYear,
      title_type: show.titleType,
      series_status: show.seriesStatus,
      total_episode_count: show.totalEpisodeCount,
      total_runtime_minutes: show.totalRuntimeMinutes,
      poster_storage_path: show.posterStoragePath,
      poster_retrieval_status: show.posterRetrievalStatus,
      disambiguation: show.disambiguation,
      aggregate_position: index + 1,
      ranked_count: rankedActiveUserCount,
      ranked_active_user_count: rankedActiveUserCount,
      active_user_count: activeUserCount,
      unranked_active_user_count: Math.max(activeUserCount - rankedActiveUserCount, 0),
      active_nomination_count: show.activeNominationCount || 0,
      is_confirmed: activeUserCount > 0 && rankedActiveUserCount === activeUserCount
    };
  });
}

function produceSequentialIrvSequence(candidateIds, ballots, showById) {
  const remaining = new Set(candidateIds);
  const result = [];

  while (remaining.size) {
    const winner = runInstantRunoffElection(remaining, ballots, showById);
    result.push(winner);
    remaining.delete(winner);
  }

  return result;
}

function runInstantRunoffElection(candidateIds, ballots, showById) {
  const remaining = new Set(candidateIds);

  while (remaining.size > 1) {
    const counts = currentVoteCounts(remaining, ballots);
    const nonExhaustedCount = [...counts.values()].reduce((total, count) => total + count, 0);
    const majorityWinner = [...counts.entries()].find(([, count]) => count > nonExhaustedCount / 2);

    if (majorityWinner) {
      return majorityWinner[0];
    }

    const minCount = Math.min(...counts.values());
    const tiedForElimination = [...counts.entries()]
      .filter(([, count]) => count === minCount)
      .map(([showId]) => showId);

    if (tiedForElimination.length === remaining.size) {
      return pickHighestImdbCandidate(tiedForElimination, showById);
    }

    remaining.delete(pickLowestImdbCandidate(tiedForElimination, showById));
  }

  return [...remaining][0];
}

function currentVoteCounts(candidateIds, ballots) {
  const counts = new Map([...candidateIds].map((showId) => [showId, 0]));
  ballots.forEach((ballot) => {
    const vote = ballot.rankedShowIds.find((showId) => candidateIds.has(showId));
    if (vote) {
      counts.set(vote, counts.get(vote) + 1);
    }
  });
  return counts;
}

function pickHighestImdbCandidate(showIds, showById) {
  return [...showIds].sort((left, right) => compareImdbTieSeed(showById.get(left)?.imdbId, showById.get(right)?.imdbId))[0];
}

function pickLowestImdbCandidate(showIds, showById) {
  return [...showIds].sort((left, right) => compareImdbTieSeed(showById.get(right)?.imdbId, showById.get(left)?.imdbId))[0];
}

function uniqueKnownIds(showIds, showById) {
  const seen = new Set();
  return showIds.filter((showId) => {
    if (!showById.has(showId) || seen.has(showId)) {
      return false;
    }
    seen.add(showId);
    return true;
  });
}

function isUserCurrentlyActive(user) {
  return user.isActive !== false && !user.tokenRevokedAt;
}

function imdbNumericComponent(value) {
  const numeric = String(value || "").replace(/\D/g, "");
  if (!numeric) {
    return "";
  }
  return numeric.replace(/^0+/, "") || "0";
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) {
    return left.length > right.length ? 1 : -1;
  }
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}
