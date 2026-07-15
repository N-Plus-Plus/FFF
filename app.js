import { APP_CONFIG } from "./config.js";
import { createDataStore, isSupabaseConfigured } from "./store.js";
import { createMetadataProvider, normalizeProviderTitle, parseImdbId } from "./providers.js";

const BOARD_FALLBACK_POLL_MS = 60000;
const SAVE_DEBOUNCE_MS = 650;
const DRAG_HOLD_DELAY_MS = 400;
const DRAG_CANCEL_MOVE_PX = 8;
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
  loadingOverlay: document.querySelector("#loadingOverlay"),
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
  searchLoading: false,
  board: { revision: 0, updatedAt: "", entries: [] },
  activeTab: "add",
  backgroundAuditQueued: false,
  backgroundAuditInFlight: false,
  pendingDragCard: null,
  pendingDragPointerId: null,
  pendingDragTimer: 0,
  pendingDragStartX: 0,
  pendingDragStartY: 0,
  draggingShowId: null,
  draggingSourceZone: "",
  dragRankedInsertIndex: null,
  dragStartX: 0,
  dragStartY: 0,
  dragMoved: false,
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
  refreshIcons();
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
    clearSearch();
  });

  dom.retrySaveButton?.addEventListener("click", () => flushSaveQueue());
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
  queueBackgroundAudit();
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
  refreshIcons();
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
  dom.searchResults.hidden = true;
  dom.searchResults.replaceChildren();
  dom.rankedList.innerHTML = emptyState(message);
  dom.unrankedList.innerHTML = "";
  dom.leaderboardList.innerHTML = emptyState(message);
}

function setActiveTab(tabName) {
  const tabChanged = appState.activeTab !== tabName;
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
  if (tabChanged) {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }
}

async function searchShows() {
  const query = dom.titleInput.value.trim();
  if (!query) {
    showToast("Enter an IMDb title ID, URL, or show name.", "error");
    return;
  }

  appState.searchLoading = true;
  appState.searchResults = [];
  renderSearchResults();
  try {
    appState.searchResults = await metadataProvider.search(query);
    appState.searchLoading = false;
    renderSearchResults();
    if (!appState.searchResults.length) {
      showToast("No matching television titles found.", "error");
    }
  } catch (error) {
    appState.searchResults = [];
    appState.searchLoading = false;
    renderSearchResults();
    showToast(error.message, "error");
  }
}

async function nominateResult(result) {
  showLoadingOverlay();
  try {
    const saved = await dataStore.nominate(appState.token, result);
    upsertActiveShow(saved);
    await reloadOrderAndCatalogue();
    render();
    clearSearch();
    showToast(saved.alreadyNominated ? `${saved.title} is already nominated by you.` : `${saved.title} nominated.`, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    hideLoadingOverlay();
  }
}

function clearSearch() {
  appState.searchResults = [];
  appState.searchLoading = false;
  dom.titleInput.value = "";
  renderSearchResults();
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

function queueBackgroundAudit() {
  if (appState.demoMode || appState.backgroundAuditQueued || appState.backgroundAuditInFlight) {
    return;
  }
  appState.backgroundAuditQueued = true;
  window.setTimeout(() => {
    auditRenderedBackgrounds().catch(() => {
      appState.backgroundAuditQueued = false;
      appState.backgroundAuditInFlight = false;
    });
  }, 0);
}

async function auditRenderedBackgrounds() {
  if (!metadataProvider.verifyBackgrounds) {
    appState.backgroundAuditQueued = false;
    return;
  }
  const images = Array.from(document.querySelectorAll(".card-background img[data-bg-show-id][data-bg-imdb-id]"));
  const loaded = await Promise.all(images.map(resolveBackgroundImageAuditItem));
  const unique = new Map();
  loaded.filter(Boolean).forEach((item) => {
    if (!unique.has(item.showId)) {
      unique.set(item.showId, item);
    }
  });
  const items = Array.from(unique.values());
  appState.backgroundAuditQueued = false;
  if (!items.length) {
    return;
  }

  appState.backgroundAuditInFlight = true;
  try {
    const result = await metadataProvider.verifyBackgrounds(items);
    if (result?.updatedCount > 0) {
      await reloadOrderAndCatalogue();
      if (appState.activeTab === "board") {
        await refreshBoard("Background metadata refreshed");
      }
      render();
    }
  } finally {
    appState.backgroundAuditInFlight = false;
  }
}

function resolveBackgroundImageAuditItem(image) {
  return new Promise((resolve) => {
    const finish = () => {
      const showId = image.dataset.bgShowId || "";
      const imdbId = image.dataset.bgImdbId || "";
      if (!showId || !imdbId || !image.currentSrc) {
        resolve(null);
        return;
      }
      resolve({
        showId,
        imdbId,
        backgroundUrl: image.currentSrc,
        width: image.naturalWidth || 0,
        height: image.naturalHeight || 0
      });
    };
    if (image.complete) {
      finish();
      return;
    }
    image.addEventListener("load", finish, { once: true });
    image.addEventListener("error", finish, { once: true });
  });
}

function renderSearchResults() {
  if (appState.searchLoading) {
    dom.searchResults.hidden = false;
    dom.searchResults.innerHTML = emptyState("Loading...");
    return;
  }

  if (!appState.searchResults.length) {
    dom.searchResults.hidden = true;
    dom.searchResults.replaceChildren();
    return;
  }

  dom.searchResults.hidden = false;
  dom.searchResults.replaceChildren(...appState.searchResults.map((result) => {
    const show = normalizeProviderTitle(result);
    const known = findKnownShow(show.imdbId);
    const status = known ? showStatusText(known) : "Not nominated by you";
    const card = document.createElement("article");
    card.className = "result-card";
    card.innerHTML = `
      ${posterMarkup(show)}
      <div class="show-meta">
        ${titleMarkup(show)}
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
  card.className = "result-card result-card--catalogue";
  card.innerHTML = `
    ${backgroundMarkup(show)}
    <div class="show-meta">
      ${titleMarkup(show)}
      ${metadataMarkup(show)}
    </div>
    <div class="card-actions"></div>
  `;
  renderShowActions(card.querySelector(".card-actions"), show);
  wireInteractiveControls(card);
  return card;
}

function renderShowActions(container, show, options = {}) {
  container.replaceChildren();
  const known = show.id ? show : findKnownShow(show.imdbId);

  if (known?.isAdminRemoved) {
    container.append(disabledButton("Removed", "ban"));
    return;
  }

  if (known?.currentUserNominated) {
    container.append(actionButton("Withdraw", "button--destructive", () => withdrawNomination(known.id), "circle-minus"));
  } else {
    container.append(actionButton("Nominate", "button--constructive button--nominate", () => nominateResult(options.searchResult || show), "circle-plus"));
  }

  if (known?.id && appState.currentUser?.isAdmin) {
    container.append(actionButton("Remove", "button--destructive", () => removeShow(known.id), "trash-2"));
  }
  refreshIcons(container);
}

function renderOrder() {
  renderSaveStatus();
  renderUnrankedReminder();
  const rankedChildren = appState.ranked.map((show, index) => rankedCard(show, index));
  const shouldShowRankedPlaceholder = appState.draggingShowId && appState.dragRankedInsertIndex !== null;
  if (shouldShowRankedPlaceholder) {
    const insertIndex = Math.max(0, Math.min(appState.dragRankedInsertIndex, rankedChildren.length));
    rankedChildren.splice(insertIndex, 0, rankedDropPlaceholder());
  }

  if (!rankedChildren.length) {
    dom.rankedList.innerHTML = emptyState("No ranked shows yet.");
  } else {
    dom.rankedList.replaceChildren(...rankedChildren);
  }

  if (!appState.unranked.length) {
    dom.unrankedList.innerHTML = emptyState("Every active show is ranked.");
  } else {
    dom.unrankedList.replaceChildren(...appState.unranked.map((show) => unrankedCard(show)));
  }
  refreshIcons();
}

function rankedCard(show, index) {
  const card = document.createElement("article");
  card.className = "show-card";
  card.dataset.showId = show.id;
  card.dataset.zone = "ranked";
    card.classList.toggle("is-dragging", appState.draggingShowId === show.id);
  card.innerHTML = `
    <div class="rank-number">${index + 1}</div>
      ${backgroundMarkup(show)}
      <div class="show-meta">
      ${titleMarkup(show)}
      ${metadataMarkup(show)}
    </div>
    <div class="rank-controls" aria-label="Move ${escapeAttribute(show.title)}">
      <button class="icon-button" type="button" data-move="up" aria-label="Move up"><i data-lucide="arrow-up" aria-hidden="true"></i></button>
      <button class="icon-button" type="button" data-move="down" aria-label="Move down"><i data-lucide="arrow-down" aria-hidden="true"></i></button>
      <button class="icon-button" type="button" data-remove aria-label="Remove from ranking"><i data-lucide="x" aria-hidden="true"></i></button>
    </div>
  `;
  card.querySelector('[data-move="up"]').disabled = index === 0;
  card.querySelector('[data-move="down"]').disabled = index === appState.ranked.length - 1;
  card.querySelector('[data-move="up"]').addEventListener("click", () => moveRanked(show.id, -1));
  card.querySelector('[data-move="down"]').addEventListener("click", () => moveRanked(show.id, 1));
  card.querySelector("[data-remove]").addEventListener("click", () => unrankShow(show.id));
  card.addEventListener("pointerdown", beginDrag);
  suppressCardContextMenu(card);
  wireInteractiveControls(card);
  return card;
}

function unrankedCard(show) {
  const card = document.createElement("article");
  card.className = "show-card show-card--unranked";
  card.dataset.showId = show.id;
  card.dataset.zone = "unranked";
  card.classList.toggle("is-dragging", appState.draggingShowId === show.id);
  card.innerHTML = `
    <div class="rank-number">-</div>
      ${backgroundMarkup(show)}
      <div class="show-meta">
      ${titleMarkup(show)}
      ${metadataMarkup(show)}
    </div>
    <div class="rank-controls">
      <button class="icon-button" type="button" data-rank aria-label="Add to ranking"><i data-lucide="plus" aria-hidden="true"></i></button>
    </div>
  `;
  card.querySelector("[data-rank]").addEventListener("click", () => rankShow(show.id));
  card.addEventListener("pointerdown", beginDrag);
  suppressCardContextMenu(card);
  wireInteractiveControls(card);
  return card;
}

function rankedDropPlaceholder() {
  const element = document.createElement("div");
  element.className = "rank-drop-placeholder";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function beginDrag(event) {
  if (event.target.closest("button, a, input, select, textarea")) {
    return;
  }
  if (event.button !== undefined && event.button !== 0) {
    return;
  }
  const card = event.currentTarget;
  clearPendingDrag();
  appState.pendingDragCard = card;
  appState.pendingDragPointerId = event.pointerId;
  appState.pendingDragStartX = event.clientX;
  appState.pendingDragStartY = event.clientY;
  appState.pendingDragTimer = window.setTimeout(() => {
    startDrag(card, event.pointerId, event.clientX, event.clientY);
  }, DRAG_HOLD_DELAY_MS);
  document.addEventListener("pointermove", pendingDragMove);
  document.addEventListener("pointerup", finishPendingDrag, { once: true });
  document.addEventListener("pointercancel", cancelPendingDrag, { once: true });
}

function startDrag(card, pointerId, x, y) {
  clearPendingDragTimer();
  appState.draggingShowId = card.dataset.showId;
  appState.draggingSourceZone = card.dataset.zone || "";
  appState.dragRankedInsertIndex = appState.draggingSourceZone === "ranked"
    ? appState.ranked.findIndex((show) => show.id === appState.draggingShowId)
    : null;
  appState.dragStartX = x;
  appState.dragStartY = y;
  appState.dragMoved = false;
  card.setPointerCapture(pointerId);
  card.classList.add("is-dragging");
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", endDrag, { once: true });
  document.addEventListener("pointercancel", cancelDrag, { once: true });
  document.addEventListener("touchmove", preventActiveDragTouchScroll, { passive: false });
}

function pendingDragMove(event) {
  if (event.pointerId !== appState.pendingDragPointerId) {
    return;
  }
  const distance = Math.hypot(event.clientX - appState.pendingDragStartX, event.clientY - appState.pendingDragStartY);
  if (distance > DRAG_CANCEL_MOVE_PX) {
    cancelPendingDrag();
  }
}

function finishPendingDrag() {
  if (appState.draggingShowId) {
    return;
  }
  const card = appState.pendingDragCard;
  const sourceZone = card?.dataset.zone || "";
  const showId = card?.dataset.showId;
  clearPendingDrag();
  if (sourceZone === "unranked" && showId) {
    rankShow(showId);
  }
}

function cancelPendingDrag() {
  clearPendingDrag();
}

function clearPendingDrag() {
  clearPendingDragTimer();
  document.removeEventListener("pointermove", pendingDragMove);
  document.removeEventListener("pointerup", finishPendingDrag);
  document.removeEventListener("pointercancel", cancelPendingDrag);
  appState.pendingDragCard = null;
  appState.pendingDragPointerId = null;
  appState.pendingDragStartX = 0;
  appState.pendingDragStartY = 0;
}

function clearPendingDragTimer() {
  if (appState.pendingDragTimer) {
    window.clearTimeout(appState.pendingDragTimer);
    appState.pendingDragTimer = 0;
  }
}

function preventActiveDragTouchScroll(event) {
  if (appState.draggingShowId) {
    event.preventDefault();
  }
}

function dragMove(event) {
  if (!appState.draggingShowId) {
    return;
  }
  if (event.pointerId !== appState.pendingDragPointerId) {
    return;
  }
  if (Math.hypot(event.clientX - appState.dragStartX, event.clientY - appState.dragStartY) > DRAG_CANCEL_MOVE_PX) {
    appState.dragMoved = true;
  }
  const nextIndex = rankedInsertIndexFromPoint(event.clientX, event.clientY);
  if (nextIndex === appState.dragRankedInsertIndex) {
    return;
  }
  updateOrderWithMotion(() => {
    appState.dragRankedInsertIndex = nextIndex;
  });
}

function rankedInsertIndexFromPoint(x, y) {
  const rankedRect = dom.rankedList.getBoundingClientRect();
  if (x < rankedRect.left || x > rankedRect.right || y < rankedRect.top || y > rankedRect.bottom) {
    return null;
  }

  const cards = Array.from(dom.rankedList.querySelectorAll('.show-card[data-zone="ranked"]'))
    .filter((card) => card.dataset.showId !== appState.draggingShowId);
  if (!cards.length) {
    return 0;
  }

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      const id = card.dataset.showId;
      return appState.ranked.findIndex((show) => show.id === id);
    }
  }
  return appState.ranked.length;
}

function commitRankedDrag() {
  if (!appState.draggingShowId || appState.dragRankedInsertIndex === null) {
    return;
  }
  const sourceZone = appState.draggingSourceZone;
  const showId = appState.draggingShowId;
  const sourceList = sourceZone === "unranked" ? appState.unranked : appState.ranked;
  const sourceIndex = sourceList.findIndex((show) => show.id === showId);
  if (sourceIndex === -1) {
    return;
  }

  const [show] = sourceList.splice(sourceIndex, 1);
  let insertIndex = Math.max(0, Math.min(appState.dragRankedInsertIndex, appState.ranked.length));
  if (sourceZone === "ranked" && sourceIndex < insertIndex) {
    insertIndex -= 1;
  }
  if (sourceZone === "ranked" && sourceIndex === insertIndex) {
    appState.ranked.splice(sourceIndex, 0, show);
    return;
  }
  appState.ranked.splice(insertIndex, 0, show);
  markRankingChanged();
}

function endDrag() {
  clearPendingDrag();
  clearDragListeners();
  updateOrderWithMotion(() => {
    commitRankedDrag();
    clearDragState();
  });
}

function cancelDrag() {
  clearPendingDrag();
  clearDragListeners();
  clearDragState();
  renderOrder();
}

function clearDragListeners() {
  document.removeEventListener("pointermove", dragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", cancelDrag);
  document.removeEventListener("touchmove", preventActiveDragTouchScroll);
}

function clearDragState() {
  appState.draggingShowId = null;
  appState.draggingSourceZone = "";
  appState.dragRankedInsertIndex = null;
  appState.dragStartX = 0;
  appState.dragStartY = 0;
  appState.dragMoved = false;
}

function updateOrderWithMotion(mutator) {
  const before = snapshotOrderCardRects();
  mutator();
  renderOrder();
  animateOrderCardMoves(before);
}

function snapshotOrderCardRects() {
  const rects = new Map();
  [...dom.rankedList.querySelectorAll(".show-card"), ...dom.unrankedList.querySelectorAll(".show-card")].forEach((card) => {
    if (card.dataset.showId) {
      rects.set(card.dataset.showId, card.getBoundingClientRect());
    }
  });
  return rects;
}

function animateOrderCardMoves(before) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  [...dom.rankedList.querySelectorAll(".show-card"), ...dom.unrankedList.querySelectorAll(".show-card")].forEach((card) => {
    const previous = before.get(card.dataset.showId);
    if (!previous || typeof card.animate !== "function") {
      return;
    }
    const current = card.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (!dx && !dy) {
      return;
    }
    card.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: "translate(0, 0)" }
    ], {
      duration: 180,
      easing: "cubic-bezier(0.2, 0, 0, 1)"
    });
  });
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

function rankShow(showId, options = {}) {
  const index = appState.unranked.findIndex((show) => show.id === showId);
  if (index === -1) {
    return;
  }
  const [show] = appState.unranked.splice(index, 1);
  appState.ranked.push(show);
  markRankingChanged();
  if (options.render !== false) {
    renderOrder();
  }
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
  if (!dom.sequenceStatus || !dom.retrySaveButton) {
    return;
  }
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
    card.innerHTML = `
      <div class="leader-position">${entry.aggregatePosition || index + 1}</div>
      ${backgroundMarkup(entry)}
      <div class="show-meta">
        ${titleMarkup(entry)}
        ${metadataMarkup(entry)}
      </div>
    `;
    wireInteractiveControls(card);
    return card;
  }));
  refreshIcons();
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
  return show.releaseYear || show.totalEpisodeCount || show.totalRuntimeMinutes ? "" : "IMDb title";
}

function titleMarkup(show) {
  const imdbId = show.imdbId || show.imdb_id;
  const title = escapeHtml(show.title);
  if (!imdbId) {
    return `<p class="show-title">${title}</p>`;
  }
  return `
    <p class="show-title">
      <a class="show-title__link" href="https://www.imdb.com/title/${escapeAttribute(imdbId)}/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label="Open ${escapeAttribute(show.title || "show")} on IMDb">
        ${title}
      </a>
    </p>
  `;
}

function metadataMarkup(show) {
  const rows = [];
  const yearRange = formatYearRange(show);
  if (yearRange) {
    rows.push(yearRange);
  }
  if (show.totalEpisodeCount) {
    rows.push(formatEpisodeCount(show));
  }
  if (show.totalRuntimeMinutes) {
    rows.push(`Total Runtime: ${formatRuntime(show.totalRuntimeMinutes)}`);
  }
  if (!rows.length) {
    rows.push(formatShowSubtitle(show));
  }
  return rows.map((row) => `<p class="show-subtitle">${escapeHtml(row)}</p>`).join("");
}

function formatYearRange(show) {
  const startYear = Number(show.releaseYear);
  if (!Number.isFinite(startYear) || startYear <= 0) {
    return "";
  }
  const status = String(show.seriesStatus || "").trim().toLowerCase();
  const endYear = Number(show.endYear ?? show.endedYear ?? show.finalYear ?? show.metadata?.end_year ?? show.metadata?.endYear ?? show.metadata?.tvmaze_end_year);
  if (status === "ended" && Number.isFinite(endYear) && endYear > 0 && endYear !== startYear) {
    return `${startYear}-${endYear}`;
  }
  return String(startYear);
}

function formatEpisodeCount(show) {
  const episodeCount = Number(show.totalEpisodeCount);
  const seasonCount = Number(show.totalSeasonCount ?? show.metadata?.totalSeasonCount ?? show.metadata?.total_season_count ?? show.metadata?.tvmaze_season_count);
  const episodeText = `${episodeCount} episode${episodeCount === 1 ? "" : "s"}`;
  if (!Number.isFinite(seasonCount) || seasonCount <= 0) {
    return episodeText;
  }
  return `${seasonCount} season${seasonCount === 1 ? "" : "s"}, ${episodeText}`;
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

function backgroundMarkup(show) {
  const url = show.backgroundUrl || show.background_url || show.bannerUrl || show.banner_url || show.backdropUrl || show.backdrop_url || "";
  if (url) {
    const showId = show.id || show.showId || show.show_id || "";
    const imdbId = show.imdbId || show.imdb_id || "";
    return `<div class="card-background"><img src="${escapeAttribute(url)}" alt="" draggable="false" data-bg-show-id="${escapeAttribute(showId)}" data-bg-imdb-id="${escapeAttribute(imdbId)}"></div>`;
  }
  return '<div class="card-background">TV</div>';
}

function suppressCardContextMenu(card) {
  card.addEventListener("contextmenu", (event) => {
    if (event.target.closest("button, input, select, textarea")) {
      return;
    }
    event.preventDefault();
  });
  card.querySelectorAll("img").forEach((image) => {
    image.addEventListener("dragstart", (event) => event.preventDefault());
  });
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
  dom.unrankedReminderText.textContent = "Get ranking!";
}

function sectionLabel(text) {
  const element = document.createElement("h3");
  element.className = "list-heading list-heading--inset";
  element.textContent = text;
  return element;
}

function actionButton(text, modifier, handler, iconName = "") {
  const button = document.createElement("button");
  button.className = `button ${modifier}`;
  button.type = "button";
  button.innerHTML = `${iconName ? `<i data-lucide="${escapeAttribute(iconName)}" aria-hidden="true"></i>` : ""}<span>${escapeHtml(text)}</span>`;
  button.addEventListener("click", handler);
  return button;
}

function disabledButton(text, iconName = "") {
  const button = actionButton(text, "button--neutral", () => {}, iconName);
  button.disabled = true;
  return button;
}

function refreshIcons(root = document) {
  window.lucide?.createIcons({ attrs: { "stroke-width": 2.2 }, nameAttr: "data-lucide" });
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

function showLoadingOverlay() {
  dom.loadingOverlay.hidden = false;
}

function hideLoadingOverlay() {
  dom.loadingOverlay.hidden = true;
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
