import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";
import type { SteamWishlistItem } from "../types/steam.js";

// Documented shape of IWishlistService/GetWishlist/v1. Verify against a real
// response for this account (see the debug route) before trusting this blindly —
// Valve's wishlist API has changed shape before.
interface GetWishlistRawResponse {
  response?: {
    items?: Array<{
      appid: number;
      priority?: number;
      date_added?: number;
    }>;
  };
}

export async function fetchWishlistRaw(): Promise<GetWishlistRawResponse> {
  const url = new URL("https://api.steampowered.com/IWishlistService/GetWishlist/v1/");
  url.searchParams.set("steamid", config.steamId64);
  if (config.steamApiKey) {
    url.searchParams.set("key", config.steamApiKey);
  }
  return fetchJson<GetWishlistRawResponse>(url.toString(), { retries: 2 });
}

export async function fetchWishlist(): Promise<SteamWishlistItem[]> {
  const raw = await fetchWishlistRaw();
  const items = raw.response?.items ?? [];
  return items.map((item) => ({
    appid: item.appid,
    priority: item.priority,
    dateAdded: item.date_added,
  }));
}
