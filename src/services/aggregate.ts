import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getOrFetch } from "../cache/cacheStore.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { fetchWishlist } from "./steamWishlist.js";
import { fetchSteamPrice } from "./steamStore.js";
import { lookupItadId, fetchItadPrices, fetchItadHistoryLow } from "./itad.js";
import { logger } from "../utils/logger.js";
import type { WishlistGame, WishlistResponse } from "../types/wishlistItem.js";
import type { ItadDeal, ItadHistoryLow } from "../types/itad.js";

const CONCURRENCY = 5;
const PRICE_EPSILON = 0.005; // guards against float rounding when comparing prices

function hashIds(ids: string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

export async function getWishlistData(options: { forceRefresh?: boolean } = {}): Promise<WishlistResponse> {
  const { forceRefresh = false } = options;
  const cc = config.countryCode;
  const warnings: string[] = [];

  const fullWishlist = await getOrFetch(
    `steam:wishlist:${config.steamId64}`,
    config.cacheTtl.wishlistSec,
    fetchWishlist,
    { forceRefresh },
  );
  const wishlist =
    config.debugGameLimit !== undefined ? fullWishlist.slice(0, config.debugGameLimit) : fullWishlist;
  if (config.debugGameLimit !== undefined) {
    logger.info(`DEBUG_GAME_LIMIT set — enriching only ${wishlist.length} of ${fullWishlist.length} wishlist games`);
  }

  // Steam prices and ITAD lookups hit independent APIs (each internally throttled),
  // so run them concurrently rather than one after the other.
  const itadIdByAppid = new Map<number, string | null>();
  const [steamPrices] = await Promise.all([
    mapWithConcurrency(wishlist, CONCURRENCY, (item) =>
      getOrFetch(
        `steam:price:${item.appid}:${cc}`,
        config.cacheTtl.steamPriceSec,
        () => fetchSteamPrice(item.appid, cc),
        { forceRefresh },
      ),
    ),
    mapWithConcurrency(wishlist, CONCURRENCY, async (item) => {
      try {
        const itadId = await getOrFetch(
          `itad:lookup:${item.appid}`,
          config.cacheTtl.itadLookupSec,
          () => lookupItadId(item.appid),
          { forceRefresh },
        );
        itadIdByAppid.set(item.appid, itadId);
      } catch (err) {
        logger.warn(`ITAD lookup failed for appid ${item.appid}`, err);
        warnings.push(`Could not look up ITAD data for appid ${item.appid}`);
        itadIdByAppid.set(item.appid, null);
      }
    }),
  ]);

  const resolvedItadIds = [...new Set([...itadIdByAppid.values()].filter((id): id is string => id !== null))];
  const idsHash = hashIds(resolvedItadIds);

  let pricesByItadId: Record<string, ItadDeal[]> = {};
  let historyLowByItadId: Record<string, ItadHistoryLow> = {};
  try {
    [pricesByItadId, historyLowByItadId] = await Promise.all([
      getOrFetch(
        `itad:prices:${cc}:${idsHash}`,
        config.cacheTtl.itadPriceSec,
        () => fetchItadPrices(resolvedItadIds, cc),
        { forceRefresh },
      ),
      getOrFetch(
        `itad:historylow:${cc}:${idsHash}`,
        config.cacheTtl.itadPriceSec,
        () => fetchItadHistoryLow(resolvedItadIds, cc),
        { forceRefresh },
      ),
    ]);
  } catch (err) {
    logger.warn("ITAD batch price/historylow fetch failed", err);
    warnings.push("Could not fetch current deals / historical lows from ITAD");
  }

  const games: WishlistGame[] = wishlist.map((item, index) => {
    const steamPrice = steamPrices[index];
    const itadId = itadIdByAppid.get(item.appid) ?? null;
    const historyLow = itadId ? historyLowByItadId[itadId] : undefined;
    const deals = itadId ? pricesByItadId[itadId] : undefined;

    const currentPrice = steamPrice.priceOverview ? steamPrice.priceOverview.final / 100 : null;
    const historyLowPrice = historyLow ? historyLow.price : null;

    let isLowestEver: boolean | null = null;
    if (currentPrice !== null && historyLowPrice !== null) {
      isLowestEver = currentPrice <= historyLowPrice + PRICE_EPSILON;
    }

    const bestDeal = deals?.length
      ? deals.reduce((best, d) => (d.price < best.price ? d : best))
      : null;

    return {
      appid: item.appid,
      name: steamPrice.name ?? `App ${item.appid}`,
      headerImage: `https://cdn.akamai.steamstatic.com/steam/apps/${item.appid}/header.jpg`,
      storeUrl: `https://store.steampowered.com/app/${item.appid}`,

      priority: item.priority,
      dateAdded: item.dateAdded,

      priceStatus: steamPrice.priceOverview ? "ok" : "unavailable",
      currency: steamPrice.priceOverview?.currency ?? null,
      currentPrice,
      initialPrice: steamPrice.priceOverview ? steamPrice.priceOverview.initial / 100 : null,
      discountPercent: steamPrice.priceOverview?.discountPercent ?? null,

      itadStatus: itadId ? "ok" : "unmatched",
      historyLowPrice,
      historyLowDate: historyLow?.timestamp ?? null,
      isLowestEver,
      bestDealElsewhere:
        bestDeal && currentPrice !== null && bestDeal.price < currentPrice - PRICE_EPSILON
          ? { shop: bestDeal.shop, price: bestDeal.price }
          : null,

      nextSaleEstimate: null, // populated by the stretch feature (M7), if built
    };
  });

  games.sort((a, b) => {
    const discountA = a.discountPercent ?? -1;
    const discountB = b.discountPercent ?? -1;
    if (discountB !== discountA) return discountB - discountA;
    const priceA = a.currentPrice ?? Number.POSITIVE_INFINITY;
    const priceB = b.currentPrice ?? Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });

  return { games, warnings, generatedAt: new Date().toISOString() };
}
