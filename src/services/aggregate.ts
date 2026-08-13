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
import type { ItadLookupResult } from "./itad.js";
import type { SteamPriceResult } from "../types/steam.js";

const CONCURRENCY = 5;
const PRICE_EPSILON = 0.005; // guards against float rounding when comparing prices

function hashIds(ids: string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

function gameCacheKey(appid: number, cc: string, historyYears: number): string {
  return `wishlist:game:v2:${cc}:${historyYears}y:${appid}`;
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

  // Sale status can only be known after checking each game's current Steam price, so every
  // wishlist item gets priced (via the per-endpoint cache, cheap after the first run) before
  // the on-sale filter and the game limit are applied — the limit caps the number of on-sale
  // games enriched with ITAD data, not the number of raw wishlist items checked for a sale.
  //
  // Deliberately keyed off `forceAllGames`, NOT `forceRefresh`: a plain refresh=1 only bypasses
  // the wishlist-list cache (per CLAUDE.md's documented refresh semantics) and must not force a
  // fresh Steam price check across the *entire* wishlist — that's hundreds of storefront calls
  // in one burst, which is exactly what trips Steam's Akamai bot-block (see the rate-limiting
  // note above). Only the explicit "Force Refresh" button accepts that risk.
  setProgressPhase("Checking prices for sale status…", fullWishlist.length);
  const steamPriceByAppid = new Map<number, SteamPriceResult>();
  let steamPriceFailures = 0;
  await mapWithConcurrency(
    fullWishlist,
    CONCURRENCY,
    async (item) => {
      try {
        const price = await getOrFetch(
          `steam:price:${item.appid}:${cc}`,
          config.cacheTtl.steamPriceSec,
          () => fetchSteamPrice(item.appid, cc),
          { forceRefresh: forceAllGames },
        );
        steamPriceByAppid.set(item.appid, price);
      } catch (err) {
        // Leave this appid out of the map (excluded from the sale filter below). Negative-cache
        // the failure with a short TTL — long enough that reloading the page a moment later
        // doesn't immediately re-hammer Steam for the same appid, short enough that it can't be
        // mistaken for a real "no price data" result the way a full-TTL cache write would be.
        logger.warn(`Steam price fetch failed for appid ${item.appid}`, err);
        steamPriceFailures++;
        cacheSet(`steam:price:${item.appid}:${cc}`, { appid: item.appid, priceOverview: null }, config.cacheTtl.steamPriceFailureSec);
      }
    },
    () => incrementProgress(),
  );
  if (steamPriceFailures > 0) {
    warnings.push(`Could not fetch a Steam price for ${steamPriceFailures} wishlist game(s) — they were skipped`);
  }

  const onSaleWishlist = fullWishlist.filter((item) => {
    const price = steamPriceByAppid.get(item.appid);
    return !!price?.priceOverview && price.priceOverview.discountPercent > 0;
  });

  const wishlist = debugGameLimit !== undefined ? onSaleWishlist.slice(0, debugGameLimit) : onSaleWishlist;
  if (debugGameLimit !== undefined) {
    logger.info(
      `DEBUG_GAME_LIMIT set — enriching only ${wishlist.length} of ${onSaleWishlist.length} on-sale wishlist games (${fullWishlist.length} total)`,
    );
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
    setProgressPhase("Fetching deals…", staleItems.length);
    // Steam prices were already fetched above (to determine sale status); only the ITAD
    // lookup remains to enrich these games.
    const itadLookupByAppid = new Map<number, ItadLookupResult | null>();
    await mapWithConcurrency(
      staleItems,
      CONCURRENCY,
      async (item) => {
        try {
          const itadLookup = await getOrFetch(
            `itad:lookup:v2:${item.appid}`,
            config.cacheTtl.itadLookupSec,
            () => lookupItadId(item.appid),
            { forceRefresh },
          );
          itadLookupByAppid.set(item.appid, itadLookup);
        } catch (err) {
          logger.warn(`ITAD lookup failed for appid ${item.appid}`, err);
          warnings.push(`Could not look up ITAD data for appid ${item.appid}`);
          itadLookupByAppid.set(item.appid, null);
        }
      },
      () => incrementProgress(),
    );

    const resolvedItadIds = [
      ...new Set([...itadLookupByAppid.values()].filter((v): v is ItadLookupResult => v !== null).map((v) => v.id)),
    ];
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

    staleItems.forEach((item) => {
      const steamPrice = steamPriceByAppid.get(item.appid)!;
      const itadLookup = itadLookupByAppid.get(item.appid) ?? null;
      const itadId = itadLookup?.id ?? null;
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
        itadUrl: itadLookup?.url ?? null,
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
    const priceA = a.currentPrice ?? Number.POSITIVE_INFINITY;
    const priceB = b.currentPrice ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    const discountA = a.discountPercent ?? -1;
    const discountB = b.discountPercent ?? -1;
    return discountB - discountA;
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
