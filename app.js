import { APP_CONFIG } from "./config.js";
import { createDataStore, isSupabaseConfigured } from "./store.js";
import { createMetadataProvider, normalizeProviderTitle, parseImdbId } from "./providers.js";

const BOARD_FALLBACK_POLL_MS = 60000;
const SAVE_DEBOUNCE_MS = 650;
const REMINDER_DISMISSED_KEY = "fff.unrankedReminder.dismissed";

const dom = {
  userBadge: document.querySelector("#userBadge"),
  appNotice: document.querySelector("#appNotice"),
  addForm: document.querySelector("#addForm"),
  titleInput: document.querySelector("#titleInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  unrankedReminder: document.querySelector("#unrankedReminder"),
  unrankedReminderTitle: document.querySelector("#unrankedReminderTitle"),
  unrankedReminderText: document.querySelector("#unrankedReminderText"),
  openOrderButton: document.querySelector("#openOrderButton"),
  dismissReminderButton: document.querySelector("#dismissReminderButton"),
  unrankedBadge: document.querySelector("#unrankedBadge"),
  searchResults: document.querySelector("#searchResults"),
  catalogueList: document.querySelector("#catalogueList"),
  rankedList: document.querySelector("#rankedList"),
  unrankedList: document.querySelector("#unrankedList"),
  sequenceStatus: document.querySelector("#sequenceStatus"),
  retrySaveButton: document.querySelector("#retrySaveButton"),
  boardStatus: document.querySelector("#boardStatus"),
  leaderboardList: document.querySelector("#leaderboardList"),
  toastRegion: document.querySelector("#toastRegion"),
  tabs: Array.from(document.querySelectorAll("[data-tab]")),
  panels: Array.from(document.querySelectorAll("[data-panel]"))
};

const appState = {
  token: readUserToken(),
  demoMode: isDemoMode(),
  currentUser: null,
  shows: [],
  removedShows: [],
  ranked: [],
  unranked: [],
  searchResults: [],
  board: { revision: 0, updatedAt: "", entries: [] },
  activeTab: "add",
  draggingShowId: null,
  saveTimer: 0,
  saveVersion: 0,
  inFlightVersion: 0,
  saveQueued: false,
  saveStatus: "idle",
  boardTimer: 0,
  boardRefreshPromise: null,
  pendingBoardRefreshReason: "",
  unsubscribeBoardRevision: null,
  unrankedReminderDismissed: sessionStorage.getItem(REMINDER_DISMISSED_KEY) === "1"
};

const dataStore = createDataStore(APP_CONFIG, { demoMode: appState.demoMode });
const metadataProvider = createMetadataProvider({
  config: APP_CONFIG,
  token: appState.token,
  demoMode: appState.demoMode
});

init().catch((error) => {
  renderFatalError(error.message || "The app failed to start.");
});

async function init() {
  bindEvents();
  renderNotice();
  guardConfiguration();
  await loadApp();
  await startBoardRealtime();
  startBoardFallbackPolling();
}

function bindEvents() {
  dom.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  dom.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await searchShows();
  });

  dom.clearSearchButton.addEventListener("click", () => {
    appState.searchResults = [];
    dom.titleInput.value = "";
    renderSearchResults();
  });

  dom.retrySaveButton.addEventListener("click", () => flushSaveQueue());
  dom.openOrderButton.addEventListener("click", () => setActiveTab("rank"));
  dom.dismissReminderButton.addEventListener("click", () => {
    appState.unrankedReminderDismissed = true;
    sessionStorage.setItem(REMINDER_DISMISSED_KEY, "1");
    renderUnrankedReminder();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      startBoardRealtime();
      if (appState.activeTab === "board") {
        refreshBoard("Page visible");
      }
    }
  });
  window.addEventListener("focus", () => {
    if (appState.activeTab === "board") {
      refreshBoard("Window focused");
    }
  });
  window.addEventListener("online", () => startBoardRealtime());
  window.addEventListener("beforeunload", teardownRealtime);
}

function guardConfiguration() {
  if (appState.demoMode) {
    return;
  }
  if (!isSupabaseConfigured(APP_CONFIG)) {
    throw new Error("Supabase is not configured. Set supabaseUrl and supabaseAnonKey in config.js, or add ?demo=1 for local demo mode.");
  }
  if (!appState.token) {
    throw new Error("Missing user link token. Open the permanent URL containing ?u=<link_token>.");
  }
}

async function loadApp() {
  setLoading("Loading shared list");
  const data = await dataStore.load(appState.token);
  appState.currentUser = data.currentUser;
  appState.shows = data.shows;
  appState.removedShows = data.removedShows;
  appState.ranked = data.ranked;
  appState.unranked = data.unranked;
  appState.board = data.board;
  appState.saveStatus = "saved";
  render();
}

function render() {
  dom.userBadge.textContent = appState.currentUser
    ? `${appState.currentUser.displayName}${appState.currentUser.isAdmin ? " / admin" : ""}`
    : "Unknown user";
  renderSearchResults();
  renderCatalogue();
  renderOrder();
  renderUnrankedReminder();
  renderBoard();
}

function renderFatalError(message) {
  dom.userBadge.textContent = "Unavailable";
  dom.appNotice.hidden = false;
  dom.appNotice.textContent = message;
  dom.searchResults.innerHTML = emptyState(message);
  dom.rankedList.innerHTML = emptyState(message);
  dom.unrankedList.innerHTML = "";
  dom.leaderboardList.innerHTML = emptyState(message);
}

function renderNotice() {
  const notices = [];
  if (appState.demoMode) {
    notices.push("Local demo mode is enabled. Data is stored in this browser only.");
  } else if (!isSupabaseConfigured(APP_CONFIG)) {
    notices.push("Supabase is not configured.");
  }
  dom.appNotice.hidden = notices.length === 0;
  dom.appNotice.textContent = notices.join(" ");
}

function setLoading(message) {
  dom.userBadge.textContent = "Loading";
  dom.searchResults.innerHTML = emptyState(message);
  dom.rankedList.innerHTML = emptyState(message);
  dom.unrankedList.innerHTML = "";
  dom.leaderboardList.innerHTML = emptyState(message);
}

function setActiveTab(tabName) {
  appState.activeTab = tabName;
  dom.tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  dom.panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  });
  if (tabName === "board") {
    refreshBoard("Opened Board");
  }
}

async function searchShows() {
  const query = dom.titleInput.value.trim();
  if (!query) {
    showToast("Enter an IMDb title ID, URL, or show name.", "error");
    return;
  }

  dom.searchResults.innerHTML = emptyState(parseImdbId(query) ? "Looking up IMDb title" : "Searching TVmaze");
  try {
    appState.searchResults = await metadataProvider.search(query);
    renderSearchResults();
    if (!appState.searchResults.length) {
      showToast("No matching television titles found.", "error");
    }
  } catch (error) {
    appState.searchResults = [];
    renderSearchResults();
    showToast(error.message, "error");
  }
}

async function nominateResult(result) {
  try {
    const saved = await dataStore.nominate(appState.token, result);
    upsertActiveShow(saved);
    await reloadOrderAndCatalogue();
    render();
    showToast(saved.alreadyNominated ? `${saved.title} is already nominated by you.` : `${saved.title} nominated.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function withdrawNomination(showId) {
  try {
    const show = await dataStore.withdraw(appState.token, showId);
    await reloadOrderAndCatalogue();
    render();
    showToast(`${show.title} withdrawn.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function removeShow(showId) {
  try {
    const show = await dataStore.removeShow(appState.token, showId);
    await reloadOrderAndCatalogue();
    await refreshBoard("Removed show");
    render();
    showToast(`${show.title} removed.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function reloadOrderAndCatalogue() {
  const [catalogue, order] = await Promise.all([
    dataStore.listCatalogue(appState.token),
    dataStore.getOrder(appState.token)
  ]);
  appState.shows = catalogue.shows;
  appState.removedShows = catalogue.removedShows;
  appState.ranked = order.ranked;
  appState.unranked = order.unranked;
}

function renderSearchResults() {
  if (!appState.searchResults.length) {
    dom.searchResults.innerHTML = emptyState("TV show search results will appear here.");
    return;
  }

  dom.searchResults.replaceChildren(...appState.searchResults.map((result) => {
    const show = normalizeProviderTitle(result);
    const known = findKnownShow(show.imdbId);
    const status = known ? showStatusText(known) : "Not nominated by you";
    const card = document.createElement("article");
    card.className = "result-card";
    card.innerHTML = `
      ${posterMarkup(show)}
      <div class="show-meta">
        <p class="show-title">${escapeHtml(show.title)}</p>
        ${metadataMarkup(show)}
        <p class="show-subtitle">${escapeHtml(status)}</p>
      </div>
      <div class="card-actions"></div>
    `;
    renderShowActions(card.querySelector(".card-actions"), known || show, { searchResult: show });
    wireInteractiveControls(card);
    return card;
  }));
}

function renderCatalogue() {
  const cards = [];
  if (appState.shows.length) {
    cards.push(sectionLabel("Active shows"));
    appState.shows.forEach((show) => cards.push(catalogueCard(show)));
  }
  dom.catalogueList.replaceChildren(...(cards.length ? cards : [htmlToElement(emptyState("No active nominated shows yet."))]));
}

function catalogueCard(show) {
  const card = document.createElement("article");
  card.className = "result-card";
  card.innerHTML = `
    ${posterMarkup(show)}
    <div class="show-meta">
      <p class="show-title">${escapeHtml(show.title)}</p>
      ${metadataMarkup(show)}
      <p class="show-subtitle">${escapeHtml(showStatusText(show))}</p>
    </div>
    <div class="card-actions"></div>
  `;
  renderShowActions(card.querySelector(".card-actions"), show);
  wireInteractiveControls(card);
  return card;
}

function renderShowActions(container, show, options = {}) {
  container.replaceChildren();
  const imdbLink = imdbLinkMarkup(show);
  if (imdbLink) {
    container.append(htmlToElement(imdbLink));
  }
  const known = show.id ? show : findKnownShow(show.imdbId);

  if (known?.isAdminRemoved) {
    container.append(disabledButton("Removed"));
    return;
  }

  if (known?.currentUserNominated) {
    container.append(actionButton("Withdraw", "button--neutral", () => withdrawNomination(known.id)));
  } else {
    container.append(actionButton("Nominate", "button--constructive", () => nominateResult(options.searchResult || show)));
  }

  if (known?.id && appState.currentUser?.isAdmin) {
    container.append(actionButton("Remove", "button--destructive", () => removeShow(known.id)));
  }
}

function renderOrder() {
  renderSaveStatus();
  renderUnrankedReminder();

  if (!appState.ranked.length) {
    dom.rankedList.innerHTML = emptyState("No ranked shows yet.");
  } else {
    dom.rankedList.replaceChildren(...appState.ranked.map((show, index) => rankedCard(show, index)));
  }

  if (!appState.unranked.length) {
    dom.unrankedList.innerHTML = emptyState("Every active show is ranked.");
  } else {
    dom.unrankedList.replaceChildren(...appState.unranked.map((show) => unrankedCard(show)));
  }
}

function rankedCard(show, index) {
  const card = document.createElement("article");
  card.className = "show-card";
  card.dataset.showId = show.id;
  card.dataset.zone = "ranked";
  card.classList.toggle("is-dragging", appState.draggingShowId === show.id);
  card.innerHTML = `
    <div class="rank-number">${index + 1}</div>
    ${posterMarkup(show)}
    <div class="show-meta">
      <p class="show-title">${escapeHtml(show.title)}</p>
      ${metadataMarkup(show)}
    </div>
    <div class="rank-controls" aria-label="Move ${escapeAttribute(show.title)}">
      ${imdbLinkMarkup(show)}
      <button class="icon-button" type="button" data-move="up" aria-label="Move up">Up</button>
      <button class="icon-button" type="button" data-move="down" aria-label="Move down">Dn</button>
      <button class="icon-button" type="button" data-remove aria-label="Remove from ranking">X</button>
    </div>
  `;
  card.querySelector('[data-move="up"]').disabled = index === 0;
  card.querySelector('[data-move="down"]').disabled = index === appState.ranked.length - 1;
  card.querySelector('[data-move="up"]').addEventListener("click", () => moveRanked(show.id, -1));
  card.querySelector('[data-move="down"]').addEventListener("click", () => moveRanked(show.id, 1));
  card.querySelector("[data-remove]").addEventListener("click", () => unrankShow(show.id));
  card.addEventListener("pointerdown", beginDrag);
  wireInteractiveControls(card);
  return card;
}

function unrankedCard(show) {
  const card = document.createElement("article");
  card.className = "show-card show-card--unranked";
  card.dataset.showId = show.id;
  card.innerHTML = `
    <div class="rank-number">-</div>
    ${posterMarkup(show)}
    <div class="show-meta">
      <p class="show-title">${escapeHtml(show.title)}</p>
      ${metadataMarkup(show)}
    </div>
    <div class="rank-controls">
      ${imdbLinkMarkup(show)}
      <button class="icon-button" type="button" data-rank aria-label="Add to ranking">+</button>
    </div>
  `;
  card.querySelector("[data-rank]").addEventListener("click", () => rankShow(show.id));
  wireInteractiveControls(card);
  return card;
}

function beginDrag(event) {
  if (event.target.closest("button, a, input, select, textarea")) {
    return;
  }
  const card = event.currentTarget;
  appState.draggingShowId = card.dataset.showId;
  card.setPointerCapture(event.pointerId);
  card.classList.add("is-dragging");
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", endDrag, { once: true });
  document.addEventListener("pointercancel", cancelDrag, { once: true });
}

function dragMove(event) {
  if (!appState.draggingShowId) {
    return;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.show-card[data-zone="ranked"]');
  if (!target || target.dataset.showId === appState.draggingShowId) {
    return;
  }
  const targetIndex = appState.ranked.findIndex((show) => show.id === target.dataset.showId);
  const draggedIndex = appState.ranked.findIndex((show) => show.id === appState.draggingShowId);
  if (targetIndex === -1 || draggedIndex === -1 || targetIndex === draggedIndex) {
    return;
  }
  const [show] = appState.ranked.splice(draggedIndex, 1);
  appState.ranked.splice(targetIndex, 0, show);
  markRankingChanged();
  renderOrder();
}

function endDrag() {
  clearDragListeners();
  appState.draggingShowId = null;
  renderOrder();
}

function cancelDrag() {
  clearDragListeners();
  appState.draggingShowId = null;
  renderOrder();
}

function clearDragListeners() {
  document.removeEventListener("pointermove", dragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", cancelDrag);
}

function moveRanked(showId, direction) {
  const index = appState.ranked.findIndex((show) => show.id === showId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= appState.ranked.length) {
    return;
  }
  const [show] = appState.ranked.splice(index, 1);
  appState.ranked.splice(nextIndex, 0, show);
  markRankingChanged();
  renderOrder();
}

function rankShow(showId) {
  const index = appState.unranked.findIndex((show) => show.id === showId);
  if (index === -1) {
    return;
  }
  const [show] = appState.unranked.splice(index, 1);
  appState.ranked.push(show);
  markRankingChanged();
  renderOrder();
}

function unrankShow(showId) {
  const index = appState.ranked.findIndex((show) => show.id === showId);
  if (index === -1) {
    return;
  }
  const [show] = appState.ranked.splice(index, 1);
  appState.unranked.push(show);
  appState.unranked.sort((a, b) => a.title.localeCompare(b.title));
  markRankingChanged();
  renderOrder();
}

function markRankingChanged() {
  appState.saveVersion += 1;
  appState.saveStatus = "saving";
  window.clearTimeout(appState.saveTimer);
  appState.saveTimer = window.setTimeout(flushSaveQueue, SAVE_DEBOUNCE_MS);
}

async function flushSaveQueue() {
  window.clearTimeout(appState.saveTimer);
  if (appState.inFlightVersion) {
    appState.saveQueued = true;
    return;
  }

  const version = appState.saveVersion;
  const sequence = appState.ranked.map((show) => show.id);
  appState.inFlightVersion = version;
  appState.saveQueued = false;
  appState.saveStatus = "saving";
  renderSaveStatus();

  try {
    const result = await dataStore.replaceRanking(appState.token, sequence);
    if (appState.saveVersion === version) {
      appState.ranked = result.ranked;
      appState.unranked = result.unranked;
      appState.saveStatus = "saved";
      await refreshBoard("Ranking saved");
      renderOrder();
    }
  } catch (error) {
    if (appState.saveVersion === version) {
      appState.saveStatus = "failed";
      showToast(error.message, "error");
      renderSaveStatus();
    }
  } finally {
    appState.inFlightVersion = 0;
    if (appState.saveQueued || appState.saveVersion !== version) {
      flushSaveQueue();
    }
  }
}

function renderSaveStatus() {
  const labels = {
    idle: "No changes",
    saving: "Saving",
    saved: "Saved",
    failed: "Save failed"
  };
  dom.sequenceStatus.textContent = labels[appState.saveStatus] || "No changes";
  dom.retrySaveButton.hidden = appState.saveStatus !== "failed";
}

async function refreshBoard(reason) {
  if (appState.boardRefreshPromise) {
    appState.pendingBoardRefreshReason = reason || appState.pendingBoardRefreshReason || "Board changed";
    return appState.boardRefreshPromise;
  }
  appState.boardRefreshPromise = (async () => {
    try {
      if (reason) {
        dom.boardStatus.textContent = `${reason}; refreshing`;
      }
      appState.board = await dataStore.getBoard(appState.token);
      renderBoard();
    } catch (error) {
      dom.boardStatus.textContent = "Board refresh failed";
      showToast(error.message, "error");
    } finally {
      appState.boardRefreshPromise = null;
      if (appState.pendingBoardRefreshReason) {
        const nextReason = appState.pendingBoardRefreshReason;
        appState.pendingBoardRefreshReason = "";
        refreshBoard(nextReason);
      }
    }
  })();
  return appState.boardRefreshPromise;
}

function renderBoard() {
  const updated = appState.board.updatedAt ? new Date(appState.board.updatedAt) : null;
  dom.boardStatus.textContent = updated
    ? `Updated ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "Not refreshed yet";

  if (!appState.board.entries.length) {
    dom.leaderboardList.innerHTML = emptyState("No ranked active shows yet.");
    return;
  }

  dom.leaderboardList.replaceChildren(...appState.board.entries.map((entry, index) => {
    const card = document.createElement("article");
    card.className = "leader-card";
    card.classList.toggle("is-unconfirmed", !entry.isConfirmed);
    const stateText = entry.isConfirmed ? "Confirmed" : "Unconfirmed";
    card.innerHTML = `
      <div class="leader-position">${entry.aggregatePosition || index + 1}</div>
      ${posterMarkup(entry)}
      <div class="show-meta">
        <p class="show-title">${escapeHtml(entry.title)}</p>
        ${metadataMarkup(entry)}
        <p class="show-subtitle"><span aria-label="Board state">${stateText}</span> / ${entry.rankedCount} ranked</p>
      </div>
      <div class="leader-stats">
        ${imdbLinkMarkup(entry)}
        <span aria-hidden="true">${entry.isConfirmed ? "OK" : "..."}</span>
      </div>
    `;
    wireInteractiveControls(card);
    return card;
  }));
}

async function startBoardRealtime() {
  if (appState.unsubscribeBoardRevision || !dataStore.subscribeBoardInvalidation || !appState.currentUser) {
    return;
  }
  try {
    appState.unsubscribeBoardRevision = await dataStore.subscribeBoardInvalidation((revision) => {
      if (Number(revision.revision || 0) > Number(appState.board.revision || 0)) {
        refreshBoard("Board changed");
      }
    });
  } catch (error) {
    appState.unsubscribeBoardRevision = null;
  }
}

function teardownRealtime() {
  if (appState.unsubscribeBoardRevision) {
    appState.unsubscribeBoardRevision();
    appState.unsubscribeBoardRevision = null;
  }
}

function startBoardFallbackPolling() {
  window.clearInterval(appState.boardTimer);
  appState.boardTimer = window.setInterval(() => {
    if (appState.activeTab === "board" && !document.hidden) {
      refreshBoard("Fallback refresh");
    }
  }, BOARD_FALLBACK_POLL_MS);
}

function findKnownShow(imdbId) {
  return [...appState.shows, ...appState.removedShows].find((show) => show.imdbId === imdbId);
}

function upsertActiveShow(show) {
  appState.shows = appState.shows.filter((item) => item.id !== show.id).concat(show);
  appState.removedShows = appState.removedShows.filter((item) => item.id !== show.id);
}

function showStatusText(show) {
  if (show.isAdminRemoved) {
    return "Removed by administrator";
  }
  const parts = [];
  parts.push(show.currentUserNominated ? "Nominated by you" : "Not nominated by you");
  parts.push(`${show.activeNominationCount} active nomination${show.activeNominationCount === 1 ? "" : "s"}`);
  return parts.join(" / ");
}

function formatShowSubtitle(show) {
  const parts = [];
  if (show.releaseYear) {
    parts.push(show.releaseYear);
  }
  if (show.titleType) {
    parts.push(show.titleType);
  }
  if (show.seriesStatus) {
    parts.push(show.seriesStatus);
  }
  if (show.totalEpisodeCount) {
    parts.push(`${show.totalEpisodeCount} episodes`);
  }
  if (show.totalRuntimeMinutes) {
    parts.push(formatRuntime(show.totalRuntimeMinutes));
  }
  if (show.imdbId) {
    parts.push(show.imdbId);
  }
  if (show.disambiguation) {
    parts.push(show.disambiguation);
  }
  return parts.join(" / ") || "IMDb title";
}

function metadataMarkup(show) {
  return `<p class="show-subtitle">${escapeHtml(formatShowSubtitle(show))}</p>`;
}

function formatRuntime(minutes) {
  const total = Number(minutes);
  if (!Number.isFinite(total) || total <= 0) {
    return "";
  }
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (!hours) {
    return `${mins} min`;
  }
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function posterMarkup(show) {
  const url = show.posterUrl || show.poster_url || "";
  if (url) {
    return `<div class="poster"><img src="${escapeAttribute(url)}" alt=""></div>`;
  }
  return '<div class="poster">TV</div>';
}

function imdbLinkMarkup(show) {
  if (!show.imdbId && !show.imdb_id) {
    return "";
  }
  const imdbId = show.imdbId || show.imdb_id;
  return `
    <a class="icon-button imdb-link" href="https://www.imdb.com/title/${escapeAttribute(imdbId)}/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Open ${escapeAttribute(show.title || "show")} on IMDb" title="Open on IMDb">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h6v6"></path>
        <path d="M10 14 21 3"></path>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      </svg>
    </a>
  `;
}

function wireInteractiveControls(root) {
  root.querySelectorAll("a, button, input, select, textarea").forEach((control) => {
    control.addEventListener("pointerdown", (event) => event.stopPropagation());
  });
}

function renderUnrankedReminder() {
  const count = appState.currentUser ? appState.unranked.length : 0;
  dom.unrankedBadge.hidden = count === 0;
  dom.unrankedBadge.textContent = String(count);
  dom.unrankedReminder.hidden = count === 0 || appState.unrankedReminderDismissed;
  dom.unrankedReminderTitle.textContent = `${count} unranked show${count === 1 ? "" : "s"}`;
  dom.unrankedReminderText.textContent = "Order is waiting. Rank them or leave them unranked until you have an opinion.";
}

function sectionLabel(text) {
  const element = document.createElement("h3");
  element.className = "list-heading list-heading--inset";
  element.textContent = text;
  return element;
}

function actionButton(text, modifier, handler) {
  const button = document.createElement("button");
  button.className = `button ${modifier}`;
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", handler);
  return button;
}

function disabledButton(text) {
  const button = actionButton(text, "button--neutral", () => {});
  button.disabled = true;
  return button;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function htmlToElement(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function readUserToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("u") || (isDemoMode() ? "demo-admin" : "");
}

function isDemoMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("demo") === "1" || params.get("demo") === "true";
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  toast.textContent = message;
  dom.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
