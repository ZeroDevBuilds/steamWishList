interface PricePoint {
  /** Epoch ms. */
  t: number;
  price: number;
  cut: number;
}

interface SaleEpisode {
  startDate: string;
  /** null when the sale is still running. */
  endDate: string | null;
  price: number;
  cut: number;
  currency: string;
}

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
  /** Up to SALE_EPISODE_LIMIT recent Steam sales, newest first; sliced to taste client-side. */
  recentSales: SaleEpisode[];
  /** Price timeline spanning `recentSales`, oldest first — the trend chart's data. */
  pricePoints: PricePoint[];
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
const trendToggle = document.getElementById("trend-toggle") as HTMLInputElement;
const trendCountInput = document.getElementById("trend-count-input") as HTMLInputElement;
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

const TREND_STORAGE_KEY = "wishlist:saleTrend";
const TREND_COUNT_MIN = 1;
const TREND_COUNT_MAX = 10; // must not exceed the server's SALE_EPISODE_LIMIT
const TREND_COUNT_DEFAULT = 3;

interface SavedTrendControls {
  enabled: boolean;
  count: number;
}

/**
 * The trend controls are pure display state: the server always sends up to SALE_EPISODE_LIMIT
 * episodes, so toggling the trend or changing the count re-renders from data already in hand —
 * no refetch, and the count never becomes a cache-key dimension server-side.
 */
function loadTrendControls(): void {
  let saved: SavedTrendControls | null = null;
  try {
    const raw = localStorage.getItem(TREND_STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) as SavedTrendControls;
  } catch {
    saved = null;
  }
  trendToggle.checked = saved?.enabled ?? false;
  trendCountInput.value = String(saved?.count ?? TREND_COUNT_DEFAULT);
  trendCountInput.disabled = !trendToggle.checked;
}

function saveTrendControls(): void {
  const data: SavedTrendControls = { enabled: trendToggle.checked, count: trendCount() };
  try {
    localStorage.setItem(TREND_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable (private mode / quota) — the controls still work for this session.
  }
}

function trendCount(): number {
  const parsed = Number.parseInt(trendCountInput.value, 10);
  if (!Number.isFinite(parsed)) return TREND_COUNT_DEFAULT;
  return Math.min(TREND_COUNT_MAX, Math.max(TREND_COUNT_MIN, parsed));
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Direction of travel across the shown sales — are Steam's discounts on this game getting
 * deeper or shallower over time? That's the actual question the trend answers ("is this a
 * good moment, or will it get better?"), so it's worth stating rather than leaving the
 * reader to diff the percentages.
 */
function trendDirection(sales: SaleEpisode[]): string {
  if (sales.length < 2) return "";
  const newest = sales[0].cut;
  const oldest = sales[sales.length - 1].cut;
  if (newest > oldest) return `<span class="sale-trend-dir deeper" title="Discounts getting deeper">▲ deeper</span>`;
  if (newest < oldest)
    return `<span class="sale-trend-dir shallower" title="Discounts getting shallower">▼ shallower</span>`;
  return `<span class="sale-trend-dir flat" title="Discount depth unchanged">= flat</span>`;
}

// Chart geometry, in viewBox units. The SVG scales to the card width via CSS, so these are
// proportions rather than pixels — the left gutter holds the two price labels, the bottom
// strip the two date labels.
const CHART_W = 300;
const CHART_H = 78;
const CHART_PAD = { left: 40, right: 10, top: 10, bottom: 22 };

/** The points needed to draw from `start` onward, including the reading in effect at `start`. */
function pointsFrom(points: PricePoint[], start: number): PricePoint[] {
  if (points.length === 0) return [];
  let anchor = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i].t <= start) anchor = i;
    else break;
  }
  return points.slice(anchor);
}

/**
 * Step chart of the Steam price over the span of the shown sales.
 *
 * A *step* line, not a straight one: the price holds flat until the next change and then jumps,
 * so interpolating between points would draw prices that never existed — and would hide that
 * the price returns to full between sales, which is the whole shape worth seeing.
 */
function renderSaleTrend(g: WishlistGame): string {
  if (!trendToggle.checked || g.itadStatus !== "ok") return "";
  const sales = g.recentSales.slice(0, trendCount());
  if (sales.length === 0) {
    return `<p class="sale-trend-empty">No recorded Steam sales</p>`;
  }

  const now = Date.now();
  const windowStart = new Date(sales[sales.length - 1].startDate).getTime();
  const points = pointsFrom(g.pricePoints, windowStart);
  if (points.length === 0) {
    return `<p class="sale-trend-empty">No price history</p>`;
  }
  // Close the line at "now" using Steam's live price, so the chart's right edge agrees with the
  // price printed on the card even when ITAD's log hasn't caught up to the current sale yet.
  const series = [...points, { t: now, price: g.currentPrice ?? points[points.length - 1].price, cut: 0 }];

  const prices = series.map((p) => p.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi - lo < 0.01) {
    // Price never moved in this span — centre the flat line instead of dividing by zero.
    lo -= 1;
    hi += 1;
  }
  const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
  const spanMs = Math.max(1, now - windowStart);
  const xOf = (t: number) =>
    CHART_PAD.left + (Math.min(Math.max(t, windowStart), now) - windowStart) / spanMs * plotW;
  const yOf = (price: number) => CHART_PAD.top + ((hi - price) / (hi - lo)) * plotH;
  const round = (n: number) => Math.round(n * 10) / 10;

  let path = `M ${round(xOf(series[0].t))} ${round(yOf(series[0].price))}`;
  for (let i = 1; i < series.length; i++) {
    // Horizontal to the moment of change at the *old* price, then vertical to the new one.
    path += ` L ${round(xOf(series[i].t))} ${round(yOf(series[i - 1].price))}`;
    path += ` L ${round(xOf(series[i].t))} ${round(yOf(series[i].price))}`;
  }
  const baseline = CHART_PAD.top + plotH;
  const area = `${path} L ${round(xOf(now))} ${baseline} L ${round(xOf(series[0].t))} ${baseline} Z`;

  // The bar the current price has to beat. Drawn recessive (a hairline in the muted ink), since
  // it's context for the data rather than data itself.
  const refLine =
    g.historyLowPrice !== null && g.historyLowPrice >= lo && g.historyLowPrice <= hi
      ? `<line class="trend-ref" x1="${CHART_PAD.left}" x2="${CHART_W - CHART_PAD.right}"
           y1="${round(yOf(g.historyLowPrice))}" y2="${round(yOf(g.historyLowPrice))}" />`
      : "";

  // One hover target per flat stretch, so the whole plot is interrogable without a JS tooltip
  // layer — a native title is enough for a chart this small, and works on 30 cards at once.
  const hover = series
    .slice(0, -1)
    .map((p, i) => {
      const x1 = xOf(p.t);
      const x2 = xOf(series[i + 1].t);
      if (x2 - x1 < 0.5) return "";
      const label = `${formatMoney(p.price, g.currency)}${p.cut > 0 ? ` (-${p.cut}%)` : " (full price)"} from ${formatDate(new Date(p.t).toISOString())}`;
      return `<rect class="trend-hit" x="${round(x1)}" y="${CHART_PAD.top}" width="${round(x2 - x1)}" height="${plotH}"><title>${escapeHtml(label)}</title></rect>`;
    })
    .join("");

  const endX = xOf(now);
  const endY = yOf(series[series.length - 1].price);
  return `<div class="sale-trend">
      <span class="sale-trend-label">Price since ${formatDate(sales[sales.length - 1].startDate)} ${trendDirection(sales)}</span>
      <svg class="trend-chart" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"
           aria-label="Steam price over the last ${sales.length} sale(s), lowest ${formatMoney(lo, g.currency)}, highest ${formatMoney(hi, g.currency)}">
        ${refLine}
        <path class="trend-area" d="${area}" />
        <path class="trend-line" d="${path}" />
        <circle class="trend-dot" cx="${round(endX)}" cy="${round(endY)}" r="4" />
        ${hover}
        <text class="trend-axis" x="${CHART_PAD.left - 6}" y="${CHART_PAD.top + 4}" text-anchor="end">${formatMoney(hi, g.currency)}</text>
        <text class="trend-axis" x="${CHART_PAD.left - 6}" y="${baseline}" text-anchor="end">${formatMoney(lo, g.currency)}</text>
        <text class="trend-axis" x="${CHART_PAD.left}" y="${CHART_H - 2}">${formatDate(sales[sales.length - 1].startDate)}</text>
        <text class="trend-axis" x="${CHART_W - CHART_PAD.right}" y="${CHART_H - 2}" text-anchor="end">now</text>
      </svg>
    </div>`;
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

    const trendBlock = renderSaleTrend(g);

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
        ${trendBlock}
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

function formatElapsed(totalSec: number): string {
  const s = Math.floor(totalSec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function renderProgress(progress: ProgressState) {
  progressBarEl.classList.remove("hidden");
  const elapsedSec = progress.startedAt ? Math.max(0, (Date.now() - progress.startedAt) / 1000) : 0;
  const elapsedText = `${formatElapsed(elapsedSec)} elapsed`;

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
// Trend controls re-render from data already loaded — never refetch.
trendToggle.addEventListener("change", () => {
  trendCountInput.disabled = !trendToggle.checked;
  saveTrendControls();
  render();
});
trendCountInput.addEventListener("change", () => {
  trendCountInput.value = String(trendCount()); // reflect the clamp back to the user
  saveTrendControls();
  render();
});
refreshBtn.addEventListener("click", () => load(true));
forceRefreshBtn.addEventListener("click", () => load(true, true));
debugToggle.addEventListener("change", () => {
  debugLimitInput.disabled = !debugToggle.checked;
});
debugYearsInput.addEventListener("change", () => load());
debugSaveBtn.addEventListener("click", saveDebugControls);

// Restored before the first paint so a reload doesn't flash the default trend state.
loadTrendControls();
load();
