import { APP_CONFIG } from "./config.js";
import { createDataStore, isApiConfigured } from "./store.js";
import { createMetadataProvider, normalizeProviderTitle, parseImdbId } from "./providers.js";

const BOARD_FALLBACK_POLL_MS = 60000;
const SAVE_DEBOUNCE_MS = 650;
const DRAG_HOLD_DELAY_MS = 250;
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
  rankChoices: document.querySelector("#rankChoices"),
  placementMode: document.querySelector("#placementMode"),
  rankedList: document.querySelector("#rankedList"),
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
  placement: null,
  placementSnapTimer: 0,
  rankDismissedShowId: "",
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
  if (!isApiConfigured(APP_CONFIG)) {
    throw new Error("FFF API is not configured. Set apiUrl in config.js, or add ?demo=1 for local demo mode.");
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
  renderRank();
  renderList();
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
  dom.rankChoices.innerHTML = "";
  dom.placementMode.replaceChildren();
  dom.leaderboardList.innerHTML = emptyState(message);
}

function renderNotice() {
  const notices = [];
  if (appState.demoMode) {
    notices.push("Local demo mode is enabled. Data is stored in this browser only.");
  } else if (!isApiConfigured(APP_CONFIG)) {
    notices.push("API is not configured.");
  }
  dom.appNotice.hidden = notices.length === 0;
  dom.appNotice.textContent = notices.join(" ");
}

function setLoading(message) {
  dom.userBadge.textContent = "Loading";
  dom.searchResults.hidden = true;
  dom.searchResults.replaceChildren();
  dom.rankedList.innerHTML = emptyState(message);
  dom.rankChoices.innerHTML = "";
  dom.placementMode.replaceChildren();
  dom.leaderboardList.innerHTML = emptyState(message);
}

function setActiveTab(tabName) {
  if (appState.placement && tabName !== "rank") {
    cancelPlacement();
  }
  const tabChanged = appState.activeTab !== tabName;
  appState.activeTab = tabName;
  dom.tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  dom.panels.forEach((panel) => {
    const isActive = panel.dataset.panel === tabName;
    panel.classList.toggle("is-active", isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
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

function renderList() {
  renderSaveStatus();
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

  refreshIcons();
}

function renderRank() {
  if (appState.placement) {
    renderPlacement();
    return;
  }
  dom.placementMode.hidden = true;
  dom.placementMode.replaceChildren();
  if (!appState.unranked.length) {
    dom.rankChoices.innerHTML = emptyState("You have ranked every active show.");
    return;
  }
  if (appState.unranked.length === 1 && appState.rankDismissedShowId !== appState.unranked[0].id) {
    beginPlacement(appState.unranked[0].id);
    return;
  }
  const heading = document.createElement("h3");
  heading.className = "list-heading list-heading--inset";
  heading.textContent = "What would you like to place?";
  dom.rankChoices.replaceChildren(heading, ...appState.unranked.map(rankChoiceCard));
  refreshIcons();
}

function rankChoiceCard(show) {
  const card = document.createElement("article");
  card.className = "show-card rank-choice-card";
  card.innerHTML = `${backgroundMarkup(show)}<div class="show-meta">${titleMarkup(show)}${metadataMarkup(show)}</div><div class="rank-choice-card__action"><i data-lucide="chevron-right" aria-hidden="true"></i></div>`;
  card.addEventListener("click", () => beginPlacement(show.id));
  wireInteractiveControls(card);
  return card;
}

function beginPlacement(showId) {
  const show = appState.unranked.find((item) => item.id === showId);
  if (!show) {
    renderRank();
    return;
  }
  appState.placement = {
    showId,
    insertIndex: appState.ranked.length,
    rankedIds: appState.ranked.map((item) => item.id).join(","),
    restScrollTop: 0
  };
  appState.rankDismissedShowId = "";
  renderRank();
}

function cancelPlacement() {
  window.clearTimeout(appState.placementSnapTimer);
  appState.rankDismissedShowId = appState.placement?.showId || "";
  appState.placement = null;
  if (appState.activeTab === "rank") {
    renderRank();
  }
}

function renderPlacement() {
  const placement = appState.placement;
  const show = placement && appState.unranked.find((item) => item.id === placement.showId);
  if (!placement || !show || placement.rankedIds !== appState.ranked.map((item) => item.id).join(",")) {
    appState.placement = null;
    showToast("Your ranking changed. Please choose the show again.", "info");
    renderRank();
    refreshRankingAfterInvalidPlacement();
    return;
  }
  dom.rankChoices.replaceChildren();
  dom.placementMode.hidden = false;
  const stage = document.createElement("div");
  stage.className = "placement-stage";
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", "Swipe to choose the position in your ranking");
  const aboveViewport = document.createElement("div");
  aboveViewport.className = "placement-viewport placement-viewport--above";
  const aboveRows = document.createElement("div");
  aboveRows.className = "placement-track placement-track--above";
  aboveViewport.append(aboveRows);
  const selected = placementCard(show, placement.insertIndex);
  const belowViewport = document.createElement("div");
  belowViewport.className = "placement-viewport placement-viewport--below";
  const belowRows = document.createElement("div");
  belowRows.className = "placement-track placement-track--below";
  belowViewport.append(belowRows);
  stage.append(aboveViewport, selected, belowViewport);
  dom.placementMode.replaceChildren(stage);
  requestAnimationFrame(() => sizePlacementStage(stage));
  renderPlacementLanes(stage);
  bindPlacementGestures(stage);
  refreshIcons();
}

function placementRow(show, index) {
  const row = document.createElement("div");
  row.className = "placement-row";
  row.dataset.showId = show.id;
  row.innerHTML = `<span>${escapeHtml(show.title)}</span><strong>#${index + 1}</strong>`;
  return row;
}

function renderPlacementLanes(stage) {
  const placement = appState.placement;
  const above = stage.querySelector(".placement-track--above");
  const below = stage.querySelector(".placement-track--below");
  above.replaceChildren(...appState.ranked.slice(0, placement.insertIndex).map(placementRow));
  below.replaceChildren(...appState.ranked.slice(placement.insertIndex).map((show, index) => placementRow(show, placement.insertIndex + index)));
  updatePlacementCopy(stage.querySelector(".placement-card"), placement.insertIndex);
}

function sizePlacementStage(stage) {
  const tabs = document.querySelector(".bottom-tabs");
  const bottom = tabs?.getBoundingClientRect().top || window.innerHeight;
  const top = stage.getBoundingClientRect().top;
  stage.style.height = `${Math.max(280, bottom - top)}px`;
}

function bindPlacementGestures(stage) {
  let pointerId = null;
  let lastY = 0;
  stage.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, a")) return;
    pointerId = event.pointerId;
    lastY = event.clientY;
    stage.setPointerCapture(pointerId);
    stage.classList.add("is-dragging-placement");
  });
  stage.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    movePlacementBy(stage, event.clientY - lastY);
    lastY = event.clientY;
  });
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    stage.classList.remove("is-dragging-placement");
    settlePlacementLanes(stage);
  };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    movePlacementBy(stage, -event.deltaY);
    window.clearTimeout(appState.placementSnapTimer);
    appState.placementSnapTimer = window.setTimeout(() => settlePlacementLanes(stage), 200);
  }, { passive: false });
  stage.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") movePlacementBy(stage, 54);
    else if (event.key === "ArrowDown") movePlacementBy(stage, -54);
    else return;
    event.preventDefault();
    settlePlacementLanes(stage);
  });
}

function movePlacementBy(stage, distance) {
  const placement = appState.placement;
  if (!placement) return;
  placement.dragOffset = (placement.dragOffset || 0) + distance;
  const rowHeight = 54;
  while (placement.dragOffset <= -rowHeight && placement.insertIndex < appState.ranked.length) {
    placement.dragOffset += rowHeight;
    transferPlacementLaneRow(stage, 1);
  }
  while (placement.dragOffset >= rowHeight && placement.insertIndex > 0) {
    placement.dragOffset -= rowHeight;
    transferPlacementLaneRow(stage, -1);
  }
  applyPlacementLaneOffset(stage);
}

function transferPlacementLaneRow(stage, direction) {
  const placement = appState.placement;
  const oldIndex = placement.insertIndex;
  const show = appState.ranked[direction > 0 ? oldIndex : oldIndex - 1];
  const source = stage.querySelector(`[data-show-id="${CSS.escape(show.id)}"]`);
  const sourceRect = source?.getBoundingClientRect();
  placement.insertIndex += direction;
  renderPlacementLanes(stage);
  const destination = stage.querySelector(`[data-show-id="${CSS.escape(show.id)}"]`);
  if (sourceRect && destination) animatePlacementPass(stage, source, sourceRect, destination.getBoundingClientRect());
}

function applyPlacementLaneOffset(stage) {
  const offset = appState.placement?.dragOffset || 0;
  stage.querySelectorAll(".placement-track").forEach((track) => {
    track.style.transform = `translateY(${offset}px)`;
  });
}

function settlePlacementLanes(stage) {
  window.clearTimeout(appState.placementSnapTimer);
  if (!appState.placement) return;
  stage.classList.add("is-settling");
  appState.placement.dragOffset = 0;
  applyPlacementLaneOffset(stage);
  window.setTimeout(() => stage.classList.remove("is-settling"), 200);
}

function animatePlacementPass(stage, source, sourceRect, destinationRect) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stageRect = stage.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  ghost.className = "placement-passing-row";
  ghost.style.left = `${sourceRect.left - stageRect.left}px`;
  ghost.style.top = `${sourceRect.top - stageRect.top}px`;
  ghost.style.width = `${sourceRect.width}px`;
  stage.append(ghost);
  const destination = stage.querySelector(`[data-show-id="${CSS.escape(source.dataset.showId)}"]`);
  if (destination) destination.style.visibility = "hidden";
  const restingDestinationTop = destinationRect.top - (appState.placement?.dragOffset || 0);
  const dy = restingDestinationTop - sourceRect.top;
  ghost.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${dy}px)`, opacity: 1 }], { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }).finished.finally(() => {
    ghost.remove();
    if (destination?.isConnected) destination.style.visibility = "";
  });
}

function placementCard(show, insertIndex) {
  const card = document.createElement("article");
  card.className = "show-card placement-card";
  card.innerHTML = `${backgroundMarkup(show)}<div class="show-meta">${titleMarkup(show)}${metadataMarkup(show)}<p class="placement-result" data-placement-result></p></div><div class="placement-actions"><button class="icon-button" type="button" data-cancel aria-label="Cancel placement"><i data-lucide="x" aria-hidden="true"></i></button><button class="icon-button placement-confirm" type="button" data-confirm aria-label="Confirm placement"><i data-lucide="check" aria-hidden="true"></i></button></div>`;
  card.querySelector("[data-cancel]").addEventListener("click", cancelPlacement);
  card.querySelector("[data-confirm]").addEventListener("click", confirmPlacement);
  updatePlacementCopy(card, insertIndex);
  wireInteractiveControls(card);
  return card;
}

function updatePlacementCopy(card, insertIndex) {
  const result = card.querySelector("[data-placement-result]");
  if (result) result.textContent = `Place at #${insertIndex + 1}`;
}

async function confirmPlacement() {
  const placement = appState.placement;
  const stillValid = placement
    && placement.rankedIds === appState.ranked.map((item) => item.id).join(",")
    && appState.unranked.some((item) => item.id === placement.showId);
  if (!stillValid) {
    appState.placement = null;
    showToast("That show or ranking changed. Refreshing your list.", "error");
    renderRank();
    await refreshRankingAfterInvalidPlacement();
    return;
  }
  const show = appState.unranked.splice(appState.unranked.findIndex((item) => item.id === placement.showId), 1)[0];
  window.clearTimeout(appState.placementSnapTimer);
  appState.ranked.splice(placement.insertIndex, 0, show);
  appState.placement = null;
  markRankingChanged();
  renderRank();
  renderList();
  renderUnrankedReminder();
}

async function refreshRankingAfterInvalidPlacement() {
  try {
    await reloadOrderAndCatalogue();
    render();
  } catch (error) {
    showToast("Could not refresh your ranking. Please reopen the link.", "error");
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
      ${backgroundMarkup(show)}
      <div class="show-meta">
      ${titleMarkup(show)}
      ${metadataMarkup(show)}
    </div>
    ${ratingStarsMarkup(show)}
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
  clearPendingDrag();
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
  const showId = appState.draggingShowId;
  const sourceIndex = appState.ranked.findIndex((show) => show.id === showId);
  if (sourceIndex === -1) {
    return;
  }

  const [show] = appState.ranked.splice(sourceIndex, 1);
  let insertIndex = Math.max(0, Math.min(appState.dragRankedInsertIndex, appState.ranked.length));
  if (sourceIndex < insertIndex) {
    insertIndex -= 1;
  }
  if (sourceIndex === insertIndex) {
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
  renderList();
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
  renderList();
  animateOrderCardMoves(before);
}

function snapshotOrderCardRects() {
  const rects = new Map();
  dom.rankedList.querySelectorAll(".show-card").forEach((card) => {
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
  dom.rankedList.querySelectorAll(".show-card").forEach((card) => {
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
  renderList();
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
  renderRank();
  renderList();
  renderUnrankedReminder();
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
      renderRank();
      renderList();
      renderUnrankedReminder();
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
      ${entry.rankedCount < 4 ? `<span class="leader-vote-badge">Votes: ${entry.rankedCount} of 4</span>` : ""}
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
  return metadataNumber(show, ["releaseYear", "release_year"])
    || metadataNumber(show, ["totalEpisodeCount", "total_episode_count", "episodeCount", "episode_count", "tvmaze_episode_count"])
    || metadataNumber(show, ["totalRuntimeMinutes", "total_runtime_minutes"])
    ? ""
    : "IMDb title";
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
  const yearRange = formatYearRange(show);
  const episodeCount = metadataNumber(show, ["totalEpisodeCount", "total_episode_count", "episodeCount", "episode_count", "tvmaze_episode_count"]);
  const runtimeMinutes = metadataNumber(show, ["totalRuntimeMinutes", "total_runtime_minutes"]);
  const rows = [
    yearRange,
    episodeCount ? formatEpisodeCount(show, episodeCount) : "",
    runtimeMinutes ? `Total Runtime: ${formatRuntime(runtimeMinutes)}` : ""
  ];
  return rows.map((row) => `<p class="show-subtitle${row ? "" : " show-subtitle--placeholder"}">${row ? escapeHtml(row) : "&nbsp;"}</p>`).join("");
}

function ratingStarsMarkup(show) {
  const rating = Number(show.tvmazeRating ?? show.tvmaze_rating);
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
    return "";
  }

  const halfStarCount = Math.round(rating);
  const stars = Array.from({ length: 5 }, (_, index) => {
    const fill = Math.max(0, Math.min(2, halfStarCount - (index * 2)));
    return ratingStarSvg(fill, `${show.id || "show"}-${index}`);
  }).join("");
  const displayRating = rating.toFixed(1).replace(/\.0$/, "");
  return `<div class="rating-stars" role="img" aria-label="TVmaze rating ${escapeAttribute(displayRating)} out of 10">${stars}</div>`;
}

function ratingStarSvg(fill, index) {
  const path = "M256 38.013c-22.458 0-66.472 110.3-84.64 123.502-18.17 13.2-136.674 20.975-143.614 42.334-6.94 21.358 84.362 97.303 91.302 118.662 6.94 21.36-22.286 136.465-4.116 149.665 18.17 13.2 118.61-50.164 141.068-50.164 22.458 0 122.9 63.365 141.068 50.164 18.17-13.2-11.056-128.306-4.116-149.665 6.94-21.36 98.242-97.304 91.302-118.663-6.94-21.36-125.444-29.134-143.613-42.335-18.168-13.2-62.182-123.502-84.64-123.502z";
  const fillMarkup = fill === 2
    ? `<path class="rating-star__fill" d="${path}" />`
    : fill === 1
      ? `<path class="rating-star__fill" d="${path}" clip-path="url(#rating-star-half-${index})" />`
      : "";
  return `<svg class="rating-star" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><defs><clipPath id="rating-star-half-${index}"><rect width="256" height="512" /></clipPath></defs>${fillMarkup}<path class="rating-star__outline" d="${path}" /></svg>`;
}

function formatYearRange(show) {
  const startYear = metadataNumber(show, ["releaseYear", "release_year"]);
  if (!Number.isFinite(startYear) || startYear <= 0) {
    return "";
  }
  const status = metadataText(show, ["seriesStatus", "series_status", "status"]).toLowerCase();
  const endYear = metadataNumber(show, ["endYear", "end_year", "endedYear", "ended_year", "finalYear", "final_year", "ended", "tvmaze_end_year"]);
  if ((status.includes("ended") || endYear) && Number.isFinite(endYear) && endYear > 0 && endYear !== startYear) {
    return `${startYear}-${endYear}`;
  }
  return String(startYear);
}

function formatEpisodeCount(show, knownEpisodeCount = null) {
  const episodeCount = knownEpisodeCount || metadataNumber(show, ["totalEpisodeCount", "total_episode_count", "episodeCount", "episode_count", "tvmaze_episode_count"]);
  const seasonCount = metadataNumber(show, ["totalSeasonCount", "total_season_count", "seasonCount", "season_count", "tvmaze_season_count"]);
  const episodeText = `${episodeCount} episode${episodeCount === 1 ? "" : "s"}`;
  if (!Number.isFinite(seasonCount) || seasonCount <= 0) {
    return episodeText;
  }
  return `${seasonCount} season${seasonCount === 1 ? "" : "s"}, ${episodeText}`;
}

function metadataNumber(show, keys) {
  for (const value of metadataValues(show, keys)) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return null;
}

function metadataText(show, keys) {
  for (const value of metadataValues(show, keys)) {
    if (value !== null && value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function metadataValues(show, keys) {
  const metadata = show?.metadata && typeof show.metadata === "object" ? show.metadata : {};
  const nestedMetadata = [
    metadata,
    metadata.last_refresh,
    metadata.lastRefresh,
    metadata.upstream,
    metadata.primary,
    metadata.tvdb,
    metadata.retained
  ].filter((item) => item && typeof item === "object");

  const values = [];
  keys.forEach((key) => {
    values.push(show?.[key]);
    nestedMetadata.forEach((source) => values.push(source[key]));
  });
  return values;
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
  const url = show.cardArtUrl || show.card_art_url || show.cardArtSourceUrl || show.card_art_source_url || show.backgroundUrl || show.background_url || show.bannerUrl || show.banner_url || show.backdropUrl || show.backdrop_url || show.posterUrl || show.poster_url || "";
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
