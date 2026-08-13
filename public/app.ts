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
const onSaleCheckbox = document.getElementById("filter-on-sale") as HTMLInputElement;
const hideUnmatchedCheckbox = document.getElementById("filter-hide-unmatched") as HTMLInputElement;
const searchInput = document.getElementById("filter-search") as HTMLInputElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const forceRefreshBtn = document.getElementById("force-refresh-btn") as HTMLButtonElement;
const debugControls = document.getElementById("debug-controls") as HTMLElement;
const debugToggle = document.getElementById("debug-toggle") as HTMLInputElement;
const debugLimitInput = document.getElementById("debug-limit-input") as HTMLInputElement;
const debugYearsInput = document.getElementById("debug-years-input") as HTMLInputElement;

let allGames: WishlistGame[] = [];
let debugCapable = false;
let debugInitialized = false;
let historyYears = 1;

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

function formatDate(iso: string | null): string {
  if (!iso) return "unknown date";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  let games = allGames.filter((g) => {
    if (onSaleCheckbox.checked && !(g.discountPercent && g.discountPercent > 0)) return false;
    if (hideUnmatchedCheckbox.checked && g.itadStatus !== "ok") return false;
    if (query && !g.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const sortBy = sortSelect.value;
  games = games.slice().sort((a, b) => {
    switch (sortBy) {
      case "price":
        return (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity);
      case "name":
        return a.name.localeCompare(b.name);
      case "dateAdded":
        return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
      case "discount":
      default:
        return (b.discountPercent ?? -1) - (a.discountPercent ?? -1);
    }
  });

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
            ${g.discountPercent ? `<span class="discount-badge">-${g.discountPercent}%</span>` : ""}
            <span class="price-current">${formatMoney(g.currentPrice, g.currency)}</span>
            ${
              g.initialPrice && g.discountPercent
                ? `<span class="price-initial">${formatMoney(g.initialPrice, g.currency)}</span>`
                : ""
            }
          </div>`
        : `<p class="status-flag">Price unavailable</p>`;

    let lowestBlock = "";
    if (g.itadStatus !== "ok") {
      lowestBlock = `<p class="status-flag">No price-history match on ITAD</p>`;
    } else if (g.isLowestEver === true) {
      lowestBlock = `<p class="lowest-ever">✓ Lowest price in ${historyWindowLabel()}</p>`;
    } else if (g.historyLowPrice !== null) {
      lowestBlock = `<p class="not-lowest">Lowest in ${historyWindowLabel()}: ${formatMoney(g.historyLowPrice, g.currency)} (${formatDate(g.historyLowDate)})</p>`;
    }

    const elsewhereBlock = g.bestDealElsewhere
      ? `<p class="elsewhere">Cheaper elsewhere: ${formatMoney(g.bestDealElsewhere.price, g.currency)} at ${g.bestDealElsewhere.shop}</p>`
      : "";

    const potentialPurchaseBadge =
      g.isLowestEver === true ? `<span class="potential-badge">Potential Purchase</span>` : "";

    card.innerHTML = `
      <a href="${g.storeUrl}" target="_blank" rel="noopener">
        ${potentialPurchaseBadge}
        <img src="${g.headerImage}" alt="${g.name}" loading="lazy" />
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
      debugToggle.checked = data.debugGameLimit !== null && data.debugGameLimit !== undefined;
      debugLimitInput.disabled = !debugToggle.checked;
      if (data.debugGameLimit !== null && data.debugGameLimit !== undefined) {
        debugLimitInput.value = String(data.debugGameLimit);
      }
      debugYearsInput.value = String(data.historyYears);
      debugInitialized = true;
    }

    const warningText = data.warnings.length ? ` (${data.warnings.length} warning(s) — see console)` : "";
    if (data.warnings.length) console.warn("Wishlist warnings:", data.warnings);
    statusEl.textContent = `${data.games.length} games · updated ${new Date(data.generatedAt).toLocaleTimeString()}${warningText}`;
    render();
  } catch (err) {
    statusEl.textContent = `Failed to load wishlist: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.classList.add("error");
  } finally {
    stopProgressPolling();
    refreshBtn.disabled = false;
    forceRefreshBtn.disabled = false;
  }
}

sortSelect.addEventListener("change", render);
onSaleCheckbox.addEventListener("change", render);
hideUnmatchedCheckbox.addEventListener("change", render);
searchInput.addEventListener("input", render);
refreshBtn.addEventListener("click", () => load(true));
forceRefreshBtn.addEventListener("click", () => load(true, true));
debugToggle.addEventListener("change", () => {
  debugLimitInput.disabled = !debugToggle.checked;
});
debugYearsInput.addEventListener("change", () => load());

load();
