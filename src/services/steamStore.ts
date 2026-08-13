import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import { createRateLimiter } from "../utils/concurrency.js";
import type { SteamPriceResult } from "../types/steam.js";

// Steam's storefront API (unlike the official Web API) has no documented rate limit,
// but it's fronted by Akamai bot-protection that will 403 an IP outright after a burst
// of requests with no spacing — seen in practice when polling a large wishlist with no
// delay between calls. Space requests out to stay well under whatever that threshold is.
const throttle = createRateLimiter(config.steamPriceThrottleMs);

interface AppDetailsRawResponse {
  [appid: string]: {
    success: boolean;
    data?: {
      name?: string;
      price_overview?: {
        currency: string;
        initial: number;
        final: number;
        discount_percent: number;
      };
    };
  };
}

export async function fetchSteamPrice(
  appid: number,
  countryCode: string = config.countryCode,
): Promise<SteamPriceResult> {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("cc", countryCode);
  url.searchParams.set("filters", "price_overview,basic");

  await throttle();
  // A delisted app or one with no price data in this region is a normal, cacheable API
  // response (`success: false` / missing `data`) — return "no price" for that. A thrown
  // error (network failure, Steam's Akamai edge 403-blocking an IP after a burst, etc.) is
  // a *transient* failure and must propagate rather than being swallowed here: callers
  // decide how to handle it, but critically must not cache it as if it were a real "no
  // price" result — that would turn a few seconds of bad luck into an hour of every game
  // looking delisted (the wishlist's real per-game cache TTL).
  const raw = await fetchJson<AppDetailsRawResponse>(url.toString(), { retries: 1 });
  const entry = raw[String(appid)];
  if (!entry?.success || !entry.data) {
    return { appid, priceOverview: null };
  }
  const po = entry.data.price_overview;
  return {
    appid,
    name: entry.data.name,
    priceOverview: po
      ? {
          currency: po.currency,
          initial: po.initial,
          final: po.final,
          discountPercent: po.discount_percent,
        }
      : null,
  };
}
