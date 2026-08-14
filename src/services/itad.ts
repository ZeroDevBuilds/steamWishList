import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import { createWindowRateLimiter } from "../utils/concurrency.js";
import type { ItadHistoryEntry } from "../types/itad.js";

const BASE_URL = "https://api.isthereanydeal.com";

/** ITAD's shop id for Steam. Every call here is scoped to it — see `fetchItadHistory`. */
const STEAM_SHOP_ID = 61;

// ITAD requests all share one budget, documented as a *window* quota ("1000 requests in a
// 5 minute window" for a verified account) rather than a per-second rate. So the limiter is
// window-based: a refresh may burst through a few hundred calls, and only actually waits if
// that budget runs out — which for a whole wishlist refresh it doesn't. Spacing every call a
// fixed ~300ms apart instead (what this used to do) pinned throughput at the sustained
// average even when the entire budget was untouched, and that was most of a refresh's wall
// time once Steam's calls were batched.
const throttle = createWindowRateLimiter({
  maxRequests: config.itadMaxRequestsPerWindow,
  windowMs: config.itadRateWindowSec * 1000,
  minIntervalMs: config.itadThrottleMs,
});

function authHeaders(): Record<string, string> {
  return { "ITAD-API-Key": config.itadApiKey };
}

interface LookupRawResponse {
  found: boolean;
  game?: { id: string; slug: string };
}

export interface ItadLookupResult {
  id: string;
  /** Public isthereanydeal.com page for this game, built from its slug. */
  url: string;
}

/** Maps a Steam appid to an ITAD game UUID (+ its public page URL), or null if ITAD has no match. */
export async function lookupItadId(appid: number): Promise<ItadLookupResult | null> {
  await throttle();
  const url = new URL(`${BASE_URL}/games/lookup/v1`);
  url.searchParams.set("appid", String(appid));
  const raw = await fetchJson<LookupRawResponse>(url.toString(), {
    headers: authHeaders(),
    retries: 3,
  });
  if (!raw.found || !raw.game) return null;
  return { id: raw.game.id, url: `https://isthereanydeal.com/game/${raw.game.slug}/` };
}

interface HistoryRawEntry {
  timestamp: string;
  shop?: { id: number; name: string };
  deal: {
    price: { amount: number; currency: string };
    regular: { amount: number; currency: string };
    cut: number;
  };
}

/**
 * Steam's price-change log for one game since `sinceMs`, oldest entry first.
 *
 * Returns the raw entries rather than a reduced "lowest price" because the log is the part
 * that's immutable — the low depends on a window that slides, and the sale trend needs the
 * individual changes anyway. Callers persist these via `cache/historyStore.ts` and derive
 * both locally.
 *
 * Scoped to `shops=61` (Steam). Beyond keeping the app's comparisons Steam-to-Steam, this is
 * a ~25x payload reduction: an unfiltered two-year history for a popular game is ~300 entries
 * across ~17 shops, of which ~13 are Steam's. Note the bare `shops=61` form — `shops[]=61`
 * makes ITAD 500.
 */
export async function fetchItadHistory(
  itadId: string,
  countryCode: string = config.countryCode,
  sinceMs: number,
): Promise<ItadHistoryEntry[]> {
  await throttle();
  const url = new URL(`${BASE_URL}/games/history/v2`);
  url.searchParams.set("id", itadId);
  url.searchParams.set("country", countryCode);
  url.searchParams.set("shops", String(STEAM_SHOP_ID));
  // ITAD rejects the milliseconds component that Date#toISOString() includes by default
  // ("Invalid 'since' format" / HTTP 400) — strip it down to whole-second precision.
  // Omitting `since` does NOT mean "all history"; ITAD falls back to a short recent window,
  // so a full backfill passes a deliberately ancient timestamp instead.
  const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  url.searchParams.set("since", since);
  const raw = await fetchJson<HistoryRawEntry[]>(url.toString(), {
    headers: authHeaders(),
    retries: 3,
  });

  return raw
    .map((entry) => ({
      timestamp: new Date(entry.timestamp).getTime(),
      price: entry.deal.price.amount,
      regular: entry.deal.regular.amount,
      cut: entry.deal.cut,
      currency: entry.deal.price.currency,
    }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}
