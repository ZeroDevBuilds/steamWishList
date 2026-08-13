import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import { createRateLimiter } from "../utils/concurrency.js";
import type { ItadDeal, ItadHistoryLow } from "../types/itad.js";

const BASE_URL = "https://api.isthereanydeal.com";

// ITAD requests all share one budget — the lookup endpoint in particular gets called
// once per wishlist game, so without spacing these out a wishlist of any real size
// bursts past ITAD's rate limit and gets 429s.
const throttle = createRateLimiter(300);

function authHeaders(): Record<string, string> {
  return { "ITAD-API-Key": config.itadApiKey };
}

interface LookupRawResponse {
  found: boolean;
  game?: { id: string };
}

/** Maps a Steam appid to an ITAD game UUID, or null if ITAD has no match. */
export async function lookupItadId(appid: number): Promise<string | null> {
  await throttle();
  const url = new URL(`${BASE_URL}/games/lookup/v1`);
  url.searchParams.set("appid", String(appid));
  const raw = await fetchJson<LookupRawResponse>(url.toString(), {
    headers: authHeaders(),
    retries: 3,
  });
  return raw.found && raw.game ? raw.game.id : null;
}

interface PricesRawResponse {
  id: string;
  deals: Array<{
    shop: { id: number; name: string };
    price: { amount: number; currency: string };
    cut: number;
    url: string;
  }>;
}

/** Best current deal per ITAD game id, keyed by ITAD id. Empty array if no active deals. */
export async function fetchItadPrices(
  itadIds: string[],
  countryCode: string = config.countryCode,
): Promise<Record<string, ItadDeal[]>> {
  const result: Record<string, ItadDeal[]> = {};
  if (itadIds.length === 0) return result;

  await throttle();
  const url = new URL(`${BASE_URL}/games/prices/v3`);
  url.searchParams.set("country", countryCode);
  const raw = await fetchJson<PricesRawResponse[]>(url.toString(), {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(itadIds),
    retries: 3,
  });

  for (const entry of raw) {
    result[entry.id] = entry.deals.map((d) => ({
      shop: d.shop.name,
      price: d.price.amount,
      currency: d.price.currency,
      cut: d.cut,
      url: d.url,
    }));
  }
  return result;
}

// For a scoped window (years >= 1) we pull the price-change log via history/v2 (bounded with
// `since`) and take the min ourselves — omitting `since` does NOT return the full log (ITAD
// defaults to a short recent window in that case), so it cannot be used for "all time".
interface HistoryRawEntry {
  timestamp: string;
  shop?: { id: number; name: string };
  deal: {
    price: { amount: number; currency: string };
  };
}

/** Lowest price seen for one ITAD game id within the last `years` years (years >= 1), or null if none recorded. */
export async function fetchItadHistoryLow(
  itadId: string,
  countryCode: string = config.countryCode,
  years: number = 1,
): Promise<ItadHistoryLow | null> {
  await throttle();
  const url = new URL(`${BASE_URL}/games/history/v2`);
  url.searchParams.set("id", itadId);
  url.searchParams.set("country", countryCode);
  // ITAD rejects the milliseconds component that Date#toISOString() includes by default
  // ("Invalid 'since' format" / HTTP 400) — strip it down to whole-second precision.
  const since = new Date(Date.now() - years * 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  url.searchParams.set("since", since);
  const raw = await fetchJson<HistoryRawEntry[]>(url.toString(), {
    headers: authHeaders(),
    retries: 3,
  });

  if (raw.length === 0) return null;
  const lowest = raw.reduce((min, entry) => (entry.deal.price.amount < min.deal.price.amount ? entry : min));
  return {
    price: lowest.deal.price.amount,
    currency: lowest.deal.price.currency,
    shop: lowest.shop?.name ?? null,
    timestamp: lowest.timestamp,
  };
}

interface HistoryLowRawResponse {
  id: string;
  low?: {
    shop?: { id: number; name: string };
    price: { amount: number; currency: string };
    timestamp: string;
  };
}

/** All-time lowest price per ITAD game id, keyed by ITAD id (batched, like fetchItadPrices). */
export async function fetchItadHistoryLowAllTime(
  itadIds: string[],
  countryCode: string = config.countryCode,
): Promise<Record<string, ItadHistoryLow>> {
  const result: Record<string, ItadHistoryLow> = {};
  if (itadIds.length === 0) return result;

  await throttle();
  const url = new URL(`${BASE_URL}/games/historylow/v1`);
  url.searchParams.set("country", countryCode);
  const raw = await fetchJson<HistoryLowRawResponse[]>(url.toString(), {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(itadIds),
    retries: 3,
  });

  for (const entry of raw) {
    if (!entry.low) continue;
    result[entry.id] = {
      price: entry.low.price.amount,
      currency: entry.low.price.currency,
      shop: entry.low.shop?.name ?? null,
      timestamp: entry.low.timestamp,
    };
  }
  return result;
}
