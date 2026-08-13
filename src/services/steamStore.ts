import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import type { SteamPriceResult } from "../types/steam.js";

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
  url.searchParams.set("filters", "price_overview");

  try {
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
  } catch {
    // Delisted app, region unavailable, or transient failure — treat as "no price data"
    // rather than failing the whole pipeline for one game.
    return { appid, priceOverview: null };
  }
}
