import { createHash } from "node:crypto";
import { config } from "../config.js";
import { cacheGet, cacheSet, getOrFetch } from "../cache/cacheStore.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { fetchWishlist } from "./steamWishlist.js";
import { fetchSteamPrice } from "./steamStore.js";
import { lookupItadId, fetchItadPrices, fetchItadHistoryLow, fetchItadHistoryLowAllTime } from "./itad.js";
import { startProgress, setProgressPhase, incrementProgress, finishProgress } from "./progress.js";
import { logger } from "../utils/logger.js";
import type { WishlistGame, WishlistResponse } from "../types/wishlistItem.js";
import type { ItadDeal, ItadHistoryLow } from "../types/itad.js";

const CONCURRENCY = 5;
const PRICE_EPSILON = 0.005; // guards against float rounding when comparing prices

function hashIds(ids: string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

function gameCacheKey(appid: number, cc: string, historyYears: number): string {
  return `wishlist:game:${cc}:${historyYears}y:${appid}`;
}

export async function getWishlistData(
  options: {
    forceRefresh?: boolean;
    forceAllGames?: boolean;
    debugGameLimit?: number | null;
    historyYears?: number;
  } = {},
): Promise<WishlistResponse> {
  const { forceRefresh = false, forceAllGames = false, historyYears = 1 } = options;
  const cc = config.countryCode;
  const warnings: string[] = [];

  // Debug capability only exists when DEBUG_GAME_LIMIT is configured server-side. Within that,
  // the UI can narrow the limit (a number), lift it entirely for one request (null), or leave it
  // unset to fall back to the server default (undefined).
  const debugCapable = config.debugGameLimit !== undefined;
  let debugGameLimit: number | undefined;
  if (debugCapable) {
    if (options.debugGameLimit === undefined) {
      debugGameLimit = config.debugGameLimit;
    } else if (options.debugGameLimit !== null) {
      debugGameLimit = options.debugGameLimit;
    }
  }

  startProgress("Fetching wishlist…");
  const fullWishlist = await getOrFetch(
    `steam:wishlist:${config.steamId64}`,
    config.cacheTtl.wishlistSec,
    fetchWishlist,
    { forceRefresh },
  );
  const wishlist = debugGameLimit !== undefined ? fullWishlist.slice(0, debugGameLimit) : fullWishlist;
  if (debugGameLimit !== undefined) {
    logger.info(`DEBUG_GAME_LIMIT set — enriching only ${wishlist.length} of ${fullWishlist.length} wishlist games`);
  }

  // Each game's fully-enriched data is cached for CACHE_TTL_GAME_SEC (24h by default). Only
  // games whose cache has expired (or was never cached) trigger fresh Steam/ITAD API calls —
  // this is what actually protects against rate limits, independent of the refresh button.
  const cachedGames = new Map<number, WishlistGame>();
  const staleItems = wishlist.filter((item) => {
    if (!forceAllGames) {
      const cached = cacheGet<WishlistGame>(gameCacheKey(item.appid, cc, historyYears));
      if (cached) {
        cachedGames.set(item.appid, cached);
        return false;
      }
    }
    return true;
  });
  if (forceAllGames && wishlist.length > 0) {
    logger.info(`Force refresh — bypassing the 24h game cache for all ${wishlist.length} wishlist games`);
  }

  if (staleItems.length > 0) {
    setProgressPhase("Fetching prices & deals…", staleItems.length * 2);
    // Steam prices and ITAD lookups hit independent APIs (each internally throttled),
    // so run them concurrently rather than one after the other.
    const itadIdByAppid = new Map<number, string | null>();
    const [steamPrices] = await Promise.all([
      mapWithConcurrency(
        staleItems,
        CONCURRENCY,
        (item) =>
          getOrFetch(
            `steam:price:${item.appid}:${cc}`,
            config.cacheTtl.steamPriceSec,
            () => fetchSteamPrice(item.appid, cc),
            { forceRefresh },
          ),
        () => incrementProgress(),
      ),
      mapWithConcurrency(
        staleItems,
        CONCURRENCY,
        async (item) => {
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
        },
        () => incrementProgress(),
      ),
    ]);

    const resolvedItadIds = [...new Set([...itadIdByAppid.values()].filter((id): id is string => id !== null))];
    const idsHash = hashIds(resolvedItadIds);

    let pricesByItadId: Record<string, ItadDeal[]> = {};
    let historyLowByItadId: Record<string, ItadHistoryLow> = {};
    if (resolvedItadIds.length > 0) {
      setProgressPhase("Fetching deal details…", resolvedItadIds.length);
      try {
        pricesByItadId = await getOrFetch(
          `itad:prices:${cc}:${idsHash}`,
          config.cacheTtl.itadPriceSec,
          () => fetchItadPrices(resolvedItadIds, cc),
          { forceRefresh },
        );
      } catch (err) {
        logger.warn("ITAD batch price fetch failed", err);
        warnings.push("Could not fetch current deals from ITAD");
      }

      if (historyYears === 0) {
        // All-time low has a dedicated batch endpoint (like the prices call above), unlike
        // the windowed lookup below which only accepts one game id per call.
        try {
          historyLowByItadId = await getOrFetch(
            `itad:historylowall:${cc}:${idsHash}`,
            config.cacheTtl.itadPriceSec,
            () => fetchItadHistoryLowAllTime(resolvedItadIds, cc),
            { forceRefresh },
          );
        } catch (err) {
          logger.warn("ITAD batch all-time-low fetch failed", err);
          warnings.push("Could not fetch all-time low prices from ITAD");
        }
        resolvedItadIds.forEach(() => incrementProgress());
      } else {
        // history/v2 (unlike historylow/v1) only accepts one game id per call, so this is
        // fetched per-game and cached per-game rather than batched like the prices call above.
        await mapWithConcurrency(
          resolvedItadIds,
          CONCURRENCY,
          async (itadId) => {
            try {
              const low = await getOrFetch(
                `itad:historylow:${historyYears}y:${cc}:${itadId}`,
                config.cacheTtl.itadPriceSec,
                () => fetchItadHistoryLow(itadId, cc, historyYears),
                { forceRefresh },
              );
              if (low) historyLowByItadId[itadId] = low;
            } catch (err) {
              logger.warn(`ITAD historylow fetch failed for id ${itadId}`, err);
            }
          },
          () => incrementProgress(),
        );
      }
    }

    staleItems.forEach((item, index) => {
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

      const game: WishlistGame = {
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

      cacheSet(gameCacheKey(item.appid, cc, historyYears), game, config.cacheTtl.gameSec);
      cachedGames.set(item.appid, game);
    });
  }

  const games: WishlistGame[] = wishlist.map((item) => cachedGames.get(item.appid)!);

  games.sort((a, b) => {
    const discountA = a.discountPercent ?? -1;
    const discountB = b.discountPercent ?? -1;
    if (discountB !== discountA) return discountB - discountA;
    const priceA = a.currentPrice ?? Number.POSITIVE_INFINITY;
    const priceB = b.currentPrice ?? Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });

  finishProgress();

  return {
    games,
    warnings,
    generatedAt: new Date().toISOString(),
    debugCapable,
    debugGameLimit: debugCapable ? (debugGameLimit ?? null) : undefined,
    historyYears,
  };
}
