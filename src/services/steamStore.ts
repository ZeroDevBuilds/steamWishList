import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import { createRateLimiter } from "../utils/concurrency.js";
import type { SteamPriceOverview, SteamStoreItem } from "../types/steam.js";

// Steam's storefront API (unlike the official Web API) has no documented rate limit,
// but it's fronted by Akamai bot-protection that will 403 an IP outright after a burst
// of requests with no spacing — seen in practice when polling a large wishlist with no
// delay between calls. Space requests out to stay well under whatever that threshold is.
// Shared with the GetItems calls below so the two can't burst against each other.
const throttle = createRateLimiter(config.steamPriceThrottleMs);

/**
 * `appdetails` honours a comma-separated `appids=` list **only** when `filters` is restricted
 * to `price_overview`; asking for `basic` (name/header_image) as well makes it return `null`
 * for a multi-appid request. So prices come from here in big batches, and name/artwork comes
 * from `fetchSteamStoreItems` below — never go back to one appdetails call per game, that's
 * ~1 request per wishlist item and minutes of throttled wall time on a 300-game wishlist.
 */
export const STEAM_PRICE_BATCH_SIZE = 150;
/** GetItems happily returns 200 items in one ~0.5s call; keep some headroom under that. */
export const STEAM_ITEM_BATCH_SIZE = 100;

const ASSET_BASE_URL = "https://shared.akamai.steamstatic.com/store_item_assets/";

interface PriceOverviewRawResponse {
  [appid: string]: {
    success: boolean;
    // Steam returns `[]` (not an object) for apps with no price data at all, e.g. free games.
    data?: { price_overview?: { currency: string; initial: number; final: number; discount_percent: number } } | [];
  };
}

/**
 * Current Steam price for a batch of appids (max `STEAM_PRICE_BATCH_SIZE` per call).
 *
 * An appid maps to `null` when Steam gave a definite "no price here" answer (delisted, free,
 * region-locked) — that's a normal, cacheable result. An appid **missing from the map** means
 * Steam didn't answer for it; callers must not cache that as "no price". A thrown error
 * (network failure, Akamai edge 403 after a burst, malformed response) is likewise transient
 * and propagates: caching it under the normal price TTL would turn a few seconds of bad luck
 * into an hour of every game looking not-on-sale.
 */
export async function fetchSteamPrices(
  appids: number[],
  countryCode: string = config.countryCode,
): Promise<Map<number, SteamPriceOverview | null>> {
  const result = new Map<number, SteamPriceOverview | null>();
  if (appids.length === 0) return result;

  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", appids.join(","));
  url.searchParams.set("cc", countryCode);
  url.searchParams.set("filters", "price_overview");

  await throttle();
  const raw = await fetchJson<PriceOverviewRawResponse | null>(url.toString(), { retries: 1 });
  // A `null`/non-object body is Steam rejecting the request shape, not "none of these have a
  // price" — treat it as a transient failure rather than poisoning the cache for every appid.
  if (!raw || typeof raw !== "object") {
    throw new Error(`Steam appdetails returned an unusable body for ${appids.length} appid(s)`);
  }

  for (const appid of appids) {
    const entry = raw[String(appid)];
    if (entry === undefined) continue; // no answer for this appid — caller decides
    if (!entry.success || !entry.data || Array.isArray(entry.data)) {
      result.set(appid, null);
      continue;
    }
    const po = entry.data.price_overview;
    result.set(
      appid,
      po
        ? {
            currency: po.currency,
            initial: po.initial,
            final: po.final,
            discountPercent: po.discount_percent,
          }
        : null,
    );
  }
  return result;
}

interface StoreItemsRawResponse {
  response?: {
    store_items?: Array<{
      id?: number;
      appid?: number;
      success?: number;
      visible?: boolean;
      name?: string;
      assets?: {
        /** e.g. `steam/apps/1091500/${FILENAME}?t=1784714077` — `${FILENAME}` is a literal placeholder. */
        asset_url_format?: string;
        header?: string;
      };
      release?: {
        /** unix seconds; 0 or absent for unreleased/undated apps. */
        steam_release_date?: number;
        /** Set for games that existed before their Steam launch; 0 when there's no separate date. */
        original_release_date?: number;
      };
    }>;
  };
}

/**
 * Name + header artwork + release date for a batch of appids (max `STEAM_ITEM_BATCH_SIZE` per
 * call), via the official Web API's `IStoreBrowseService/GetItems` — the batched equivalent of
 * appdetails' `filters=basic`, which can't be batched (see `fetchSteamPrices`). Needs no API key.
 * Each extra `data_request` flag widens this same call rather than adding another one.
 *
 * Appids Steam has no visible store item for are simply absent from the returned map.
 */
export async function fetchSteamStoreItems(
  appids: number[],
  countryCode: string = config.countryCode,
): Promise<Map<number, SteamStoreItem>> {
  const result = new Map<number, SteamStoreItem>();
  if (appids.length === 0) return result;

  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: countryCode.toUpperCase(), steam_realm: 1 },
    data_request: { include_assets: true, include_release: true },
  };
  const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  url.searchParams.set("input_json", JSON.stringify(input));

  await throttle();
  const raw = await fetchJson<StoreItemsRawResponse>(url.toString(), { retries: 1 });

  for (const item of raw?.response?.store_items ?? []) {
    const appid = item.appid ?? item.id;
    if (appid === undefined || item.success !== 1 || !item.visible) continue;
    // Steam sends 0 rather than omitting the field when it has no date, so treat that as absent.
    const releaseDate = item.release?.steam_release_date || item.release?.original_release_date || undefined;
    result.set(appid, {
      appid,
      name: item.name,
      releaseDate,
      // Newer titles' header lives at a hashed path, so it has to be assembled from the
      // per-app URL format plus the header filename rather than guessed from the appid.
      headerImage:
        item.assets?.asset_url_format && item.assets.header
          ? ASSET_BASE_URL + item.assets.asset_url_format.replace("${FILENAME}", item.assets.header)
          : undefined,
    });
  }
  return result;
}
