interface WishlistGame {
  appid: number;
  name: string;
  headerImage: string;
  storeUrl: string;
  dateAdded?: number;
  priceStatus: "ok" | "unavailable";
  currency: string | null;
  currentPrice: number | null;
  initialPrice: number | null;
  discountPercent: number | null;
  itadStatus: "ok" | "unmatched" | "error";
  itadUrl: string | null;
  historyLowPrice: number | null;
  historyLowDate: string | null;
  isLowestEver: boolean | null;
  bestDealElsewhere: { shop: string; price: number } | null;
  nextSaleEstimate: { label: string; confidence: "low" } | null;
}

interface WishlistResponse {
  games: WishlistGame[];
  warnings: string[];
  generatedAt: string;
  debugCapable: boolean;
  debugGameLimit?: number | null;
  historyYears: number;
}

interface ProgressState {
  active: boolean;
  phase: string;
  total: number;
  completed: number;
  startedAt: number | null;
}

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const progressBarEl = document.getElementById("progress-bar") as HTMLDivElement;
const progressBarFillEl = document.getElementById("progress-bar-fill") as HTMLDivElement;
const listEl = document.getElementById("game-list") as HTMLDivElement;
const sortSelect = document.getElementById("sort-select") as HTMLSelectElement;
const viewCardsBtn = document.getElementById("view-cards-btn") as HTMLButtonElement;
const viewListBtn = document.getElementById("view-list-btn") as HTMLButtonElement;
const potentialOnlyCheckbox = document.getElementById("filter-potential-only") as HTMLInputElement;
const bigDealOnlyCheckbox = document.getElementById("filter-big-deal-only") as HTMLInputElement;
const expensiveOnlyCheckbox = document.getElementById("filter-expensive-only") as HTMLInputElement;
const searchInput = document.getElementById("filter-search") as HTMLInputElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const forceRefreshBtn = document.getElementById("force-refresh-btn") as HTMLButtonElement;
const debugControls = document.getElementById("debug-controls") as HTMLElement;
const debugToggle = document.getElementById("debug-toggle") as HTMLInputElement;
const debugLimitInput = document.getElementById("debug-limit-input") as HTMLInputElement;
const debugYearsInput = document.getElementById("debug-years-input") as HTMLInputElement;
const debugSaveBtn = document.getElementById("debug-save-btn") as HTMLButtonElement;
const debugSaveStatus = document.getElementById("debug-save-status") as HTMLSpanElement;

const DEBUG_STORAGE_KEY = "wishlist:debugControls";

interface SavedDebugControls {
  enabled: boolean;
  limit: string;
  years: string;
}

function loadSavedDebugControls(): SavedDebugControls | null {
  try {
    const raw = localStorage.getItem(DEBUG_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedDebugControls;
  } catch {
    return null;
  }
}

function saveDebugControls(): void {
  const data: SavedDebugControls = {
    enabled: debugToggle.checked,
    limit: debugLimitInput.value,
    years: debugYearsInput.value,
  };
  localStorage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(data));
  debugSaveStatus.textContent = "Saved";
  window.setTimeout(() => {
    debugSaveStatus.textContent = "";
  }, 2000);
}

let allGames: WishlistGame[] = [];
let debugCapable = false;
let debugInitialized = false;
let pendingDebugReload = false;
let historyYears = 1;
let viewMode: "cards" | "list" = "cards";

function historyWindowLabel(): string {
  if (historyYears === 0) return "all time";
  if (historyYears === 1) return "the past year";
  return `the past ${historyYears} years`;
}

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ""}`;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string | null): string {
  if (!iso) return "unknown date";
  try {
    const d = new Date(iso);
    return `${pad2(d.getDate())} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function discountTier(discountPercent: number): "low" | "medium" | "high" {
  if (discountPercent >= 70) return "high";
  if (discountPercent >= 40) return "medium";
  return "low";
}

function initialPriceTier(initialPrice: number): "low" | "medium" | "high" {
  if (initialPrice >= 50) return "high";
  if (initialPrice >= 30) return "medium";
  return "low";
}

function isBigDeal(g: WishlistGame): boolean {
  return (
    g.initialPrice !== null &&
    g.discountPercent !== null &&
    initialPriceTier(g.initialPrice) === "high" &&
    discountTier(g.discountPercent) !== "low"
  );
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  let games = allGames.filter((g) => {
    if (potentialOnlyCheckbox.checked && g.isLowestEver !== true) return false;
    if (bigDealOnlyCheckbox.checked && !isBigDeal(g)) return false;
    if (expensiveOnlyCheckbox.checked && (g.initialPrice === null || initialPriceTier(g.initialPrice) !== "high"))
      return false;
    if (query && !g.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const sortBy = sortSelect.value;
  games = games.slice().sort((a, b) => {
    switch (sortBy) {
      case "discount":
        return (b.discountPercent ?? -1) - (a.discountPercent ?? -1);
      case "name":
        return a.name.localeCompare(b.name);
      case "dateAdded":
        return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
      case "price":
      default:
        return (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity);
    }
  });

  listEl.classList.toggle("list-view", viewMode === "list");

  listEl.innerHTML = "";
  if (games.length === 0) {
    listEl.innerHTML = `<p class="status">No games match the current filters.</p>`;
    return;
  }

  for (const g of games) {
    const card = document.createElement("div");
    card.className = "game-card";

    const priceBlock =
      g.priceStatus === "ok"
        ? `<div class="price-row">
            ${g.discountPercent ? `<span class="discount-badge discount-${discountTier(g.discountPercent)}">-${g.discountPercent}%</span>` : ""}
            <span class="price-current">${formatMoney(g.currentPrice, g.currency)}</span>
            ${
              g.initialPrice && g.discountPercent
                ? `<span class="price-initial price-initial-${initialPriceTier(g.initialPrice)}">${formatMoney(g.initialPrice, g.currency)}</span>`
                : ""
            }
          </div>`
        : `<p class="status-flag">Price unavailable</p>`;

    const itadLink = g.itadUrl
      ? ` <a class="itad-link" href="${g.itadUrl}" target="_blank" rel="noopener" title="View on IsThereAnyDeal" aria-label="View on IsThereAnyDeal"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
      : "";

    let lowestBlock = "";
    if (g.itadStatus !== "ok") {
      lowestBlock = `<p class="status-flag">No price-history match on ITAD</p>`;
    } else if (g.isLowestEver === true) {
      lowestBlock = `<p class="lowest-ever">✓ Lowest price in ${historyWindowLabel()}${itadLink}</p>`;
    } else if (g.historyLowPrice !== null) {
      lowestBlock = `<p class="not-lowest">Lowest in ${historyWindowLabel()}: ${formatMoney(g.historyLowPrice, g.currency)} (${formatDate(g.historyLowDate)})${itadLink}</p>`;
    } else if (g.itadUrl) {
      lowestBlock = `<p class="not-lowest">${itadLink}</p>`;
    }

    const elsewhereBlock = g.bestDealElsewhere
      ? `<p class="elsewhere">Cheaper elsewhere: ${formatMoney(g.bestDealElsewhere.price, g.currency)} at ${g.bestDealElsewhere.shop}</p>`
      : "";

    const potentialPurchaseBadge =
      g.isLowestEver === true ? `<span class="potential-badge">Potential Purchase</span>` : "";

    const bigDealBadge = isBigDeal(g) ? `<span class="big-deal-badge">Big Deal</span>` : "";

    card.innerHTML = `
      <a href="${g.storeUrl}" target="_blank" rel="noopener">
        ${potentialPurchaseBadge}
        ${bigDealBadge}
        <img src="${g.headerImage}" alt="${g.name}" loading="lazy" onerror="this.style.display='none'" />
      </a>
      <div class="body">
        <h2><a href="${g.storeUrl}" target="_blank" rel="noopener">${g.name}</a></h2>
        ${priceBlock}
        ${lowestBlock}
        ${elsewhereBlock}
      </div>
    `;
    listEl.appendChild(card);
  }
}

let progressPollHandle: ReturnType<typeof setInterval> | null = null;
let progressPollActive = false;

function stopProgressPolling() {
  progressPollActive = false;
  if (progressPollHandle !== null) {
    clearInterval(progressPollHandle);
    progressPollHandle = null;
  }
  progressBarEl.classList.add("hidden");
  progressBarFillEl.classList.remove("indeterminate");
}

function renderProgress(progress: ProgressState) {
  progressBarEl.classList.remove("hidden");
  const elapsedSec = progress.startedAt ? Math.max(0, (Date.now() - progress.startedAt) / 1000) : 0;
  const elapsedText = `${elapsedSec.toFixed(0)}s elapsed`;

  if (progress.total > 0) {
    progressBarFillEl.classList.remove("indeterminate");
    const pct = Math.min(100, Math.round((progress.completed / progress.total) * 100));
    progressBarFillEl.style.width = `${pct}%`;
    statusEl.textContent = `${progress.phase} ${progress.completed}/${progress.total} (${pct}%) · ${elapsedText}`;
  } else {
    progressBarFillEl.classList.add("indeterminate");
    progressBarFillEl.style.width = "";
    statusEl.textContent = `${progress.phase} · ${elapsedText}`;
  }
}

function startProgressPolling() {
  stopProgressPolling();
  progressPollActive = true;
  progressPollHandle = setInterval(async () => {
    try {
      const res = await fetch("/api/wishlist/progress");
      if (!progressPollActive || !res.ok) return;
      const progress: ProgressState = await res.json();
      if (!progressPollActive || !progress.active) return;
      renderProgress(progress);
    } catch {
      // Ignore transient polling failures — the main request's own error handling covers real failures.
    }
  }, 400);
}

async function load(forceRefresh = false, forceAll = false) {
  statusEl.textContent = forceAll ? "Force refreshing every game…" : forceRefresh ? "Refreshing…" : "Loading wishlist…";
  statusEl.classList.remove("error");
  refreshBtn.disabled = true;
  forceRefreshBtn.disabled = true;
  startProgressPolling();
  try {
    const params = new URLSearchParams();
    if (forceRefresh) params.set("refresh", "1");
    if (forceAll) params.set("force", "1");
    if (debugCapable) {
      if (!debugToggle.checked) {
        params.set("debug", "0");
      } else if (debugLimitInput.value.trim() !== "") {
        params.set("limit", debugLimitInput.value.trim());
      }
      if (debugYearsInput.value.trim() !== "") {
        params.set("years", debugYearsInput.value.trim());
      }
    }
    const query = params.toString();
    const res = await fetch(`/api/wishlist${query ? `?${query}` : ""}`);
    if (!res.ok) {
      throw new Error(`Server responded with ${res.status}`);
    }
    const data: WishlistResponse = await res.json();
    allGames = data.games;
    historyYears = data.historyYears;

    debugCapable = data.debugCapable;
    debugControls.classList.toggle("hidden", !debugCapable);
    if (debugCapable && !debugInitialized) {
      const saved = loadSavedDebugControls();
      if (saved) {
        debugToggle.checked = saved.enabled;
        debugLimitInput.value = saved.limit;
        debugYearsInput.value = saved.years;
        pendingDebugReload = true;
      } else {
        debugToggle.checked = data.debugGameLimit !== null && data.debugGameLimit !== undefined;
        if (data.debugGameLimit !== null && data.debugGameLimit !== undefined) {
          debugLimitInput.value = String(data.debugGameLimit);
        }
        debugYearsInput.value = String(data.historyYears);
      }
      debugLimitInput.disabled = !debugToggle.checked;
      debugInitialized = true;
    }

    const warningText = data.warnings.length ? ` (${data.warnings.length} warning(s) — see console)` : "";
    if (data.warnings.length) console.warn("Wishlist warnings:", data.warnings);
    statusEl.textContent = `${data.games.length} games · updated ${formatTime(new Date(data.generatedAt))}${warningText}`;
    render();

    if (pendingDebugReload) {
      pendingDebugReload = false;
      await load();
      return;
    }
  } catch (err) {
    statusEl.textContent = `Failed to load wishlist: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.classList.add("error");
  } finally {
    stopProgressPolling();
    refreshBtn.disabled = false;
    forceRefreshBtn.disabled = false;
  }
}

function setViewMode(mode: "cards" | "list"): void {
  viewMode = mode;
  viewCardsBtn.classList.toggle("active", mode === "cards");
  viewCardsBtn.setAttribute("aria-pressed", String(mode === "cards"));
  viewListBtn.classList.toggle("active", mode === "list");
  viewListBtn.setAttribute("aria-pressed", String(mode === "list"));
  render();
}

sortSelect.addEventListener("change", render);
viewCardsBtn.addEventListener("click", () => setViewMode("cards"));
viewListBtn.addEventListener("click", () => setViewMode("list"));
potentialOnlyCheckbox.addEventListener("change", render);
bigDealOnlyCheckbox.addEventListener("change", render);
expensiveOnlyCheckbox.addEventListener("change", render);
searchInput.addEventListener("input", render);
refreshBtn.addEventListener("click", () => load(true));
forceRefreshBtn.addEventListener("click", () => load(true, true));
debugToggle.addEventListener("change", () => {
  debugLimitInput.disabled = !debugToggle.checked;
});
debugYearsInput.addEventListener("change", () => load());
debugSaveBtn.addEventListener("click", saveDebugControls);

load();
