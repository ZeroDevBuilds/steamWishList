import { config } from "../config.js";
import { cacheGet, cacheSet, getOrFetch } from "../cache/cacheStore.js";
import { queryWindowLow, querySaleEpisodes, queryPricePoints } from "../cache/historyStore.js";
import { chunk, mapWithConcurrency } from "../utils/concurrency.js";
import { fetchWishlist } from "./steamWishlist.js";
import {
  fetchSteamPrices,
  fetchSteamStoreItems,
  STEAM_PRICE_BATCH_SIZE,
  STEAM_ITEM_BATCH_SIZE,
} from "./steamStore.js";
import { lookupItadId } from "./itad.js";
import { syncGameHistorySafe } from "./priceHistory.js";
import { startProgress, setProgressPhase, incrementProgress, finishProgress } from "./progress.js";
import { logger } from "../utils/logger.js";
import type { WishlistGame, WishlistResponse } from "../types/wishlistItem.js";
import type { ItadLookupResult } from "./itad.js";
import type { SteamPriceOverview, SteamPriceResult, SteamStoreItem } from "../types/steam.js";

// Only ITAD is fetched per-game now (Steam's calls are batched), and ITAD's quota is a window
// budget rather than a rate — so the useful ceiling here is how many sockets to keep busy, with
// `services/itad.ts`'s limiter enforcing the actual budget.
const ITAD_CONCURRENCY = 8;
const PRICE_EPSILON = 0.005; // guards against float rounding when comparing prices

// v3: added `recentSales`, dropped `bestDealElsewhere` (v2 blobs rendered an empty trend).
// v4: `historyLowPrice`/`isLowestEver` now exclude the in-progress sale, so v3 values mean
// something different — a shape change *or* a semantic change needs a bump.
// v5: added `pricePoints` for the sale-trend chart.
function gameCacheKey(appid: number, cc: string, historyYears: number): string {
  return `wishlist:game:v5:${cc}:${historyYears}y:${appid}`;
}

// v2: prices are cached without the name/artwork that used to ride along in the same entry —
// those now live under their own key, since they come from a different (batched) endpoint.
function priceCacheKey(appid: number, cc: string): string {
  return `steam:price:v2:${appid}:${cc}`;
}

function storeItemCacheKey(appid: number): string {
  return `steam:item:v1:${appid}`;
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
  // the wishlist-list cache (per CLAUDE.md's documented refresh semantics) and must not discard
  // every cached price. Only the explicit "Force Refresh" button re-prices the whole wishlist.
  //
  // Prices are read from the per-appid cache first and only the misses go upstream, batched
  // `STEAM_PRICE_BATCH_SIZE` appids per request. One request per game (what this used to do)
  // meant ~300 throttled calls — minutes of wall time — every time the price cache went cold.
  setProgressPhase("Checking prices for sale status…", fullWishlist.length);
  const steamPriceByAppid = new Map<number, SteamPriceOverview | null>();
  const uncachedPriceAppids: number[] = [];
  for (const item of fullWishlist) {
    const cached = forceAllGames ? undefined : cacheGet<SteamPriceResult>(priceCacheKey(item.appid, cc));
    if (cached) {
      steamPriceByAppid.set(item.appid, cached.priceOverview);
    } else {
      uncachedPriceAppids.push(item.appid);
    }
  }
  incrementProgress(fullWishlist.length - uncachedPriceAppids.length);

  let steamPriceFailures = 0;
  // An appid missing from a batch's result (or a whole batch that threw) is a *transient*
  // failure: leave it out of the map so it's excluded from the sale filter below, and
  // negative-cache it with a short TTL — long enough that reloading the page a moment later
  // doesn't immediately re-hammer Steam, short enough that it can't be mistaken for a real
  // "no price data" result the way a full-TTL cache write would be.
  const negativeCachePrice = (appid: number) => {
    steamPriceFailures++;
    cacheSet(priceCacheKey(appid, cc), { appid, priceOverview: null }, config.cacheTtl.steamPriceFailureSec);
  };
  for (const batch of chunk(uncachedPriceAppids, STEAM_PRICE_BATCH_SIZE)) {
    try {
      const prices = await fetchSteamPrices(batch, cc);
      for (const appid of batch) {
        const priceOverview = prices.get(appid);
        if (priceOverview === undefined) {
          negativeCachePrice(appid);
          continue;
        }
        steamPriceByAppid.set(appid, priceOverview);
        cacheSet(priceCacheKey(appid, cc), { appid, priceOverview }, config.cacheTtl.steamPriceSec);
      }
    } catch (err) {
      logger.warn(`Steam price fetch failed for a batch of ${batch.length} appid(s)`, err);
      batch.forEach(negativeCachePrice);
    }
    incrementProgress(batch.length);
  }
  if (steamPriceFailures > 0) {
    warnings.push(`Could not fetch a Steam price for ${steamPriceFailures} wishlist game(s) — they were skipped`);
  }

  const onSaleWishlist = fullWishlist.filter((item) => {
    const price = steamPriceByAppid.get(item.appid);
    return !!price && price.discountPercent > 0;
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

  let itadLookupFailures = 0;
  let historySyncCalls = 0;
  if (staleItems.length > 0) {
    // Name + artwork only matter for games that survived the on-sale filter and aren't already
    // in the 24h game cache, so this batch is small; it's a separate endpoint because
    // appdetails refuses to batch anything beyond price_overview (see steamStore.ts).
    const storeItemByAppid = new Map<number, SteamStoreItem>();
    const uncachedItemAppids: number[] = [];
    for (const item of staleItems) {
      const cached = cacheGet<SteamStoreItem>(storeItemCacheKey(item.appid));
      if (cached) {
        storeItemByAppid.set(item.appid, cached);
      } else {
        uncachedItemAppids.push(item.appid);
      }
    }
    if (uncachedItemAppids.length > 0) {
      setProgressPhase("Fetching game details…", uncachedItemAppids.length);
      for (const batch of chunk(uncachedItemAppids, STEAM_ITEM_BATCH_SIZE)) {
        try {
          const items = await fetchSteamStoreItems(batch, cc);
          for (const [appid, storeItem] of items) {
            storeItemByAppid.set(appid, storeItem);
            cacheSet(storeItemCacheKey(appid), storeItem, config.cacheTtl.steamStoreItemSec);
          }
        } catch (err) {
          // Non-fatal: the game still renders with a placeholder name and the guessed header URL.
          logger.warn(`Steam store details fetch failed for a batch of ${batch.length} appid(s)`, err);
        }
        incrementProgress(batch.length);
      }
    }

    setProgressPhase("Fetching deals…", staleItems.length);
    // Steam prices were already fetched above (to determine sale status); only the ITAD
    // lookup remains to enrich these games.
    const itadLookupByAppid = new Map<number, ItadLookupResult | null>();
    await mapWithConcurrency(
      staleItems,
      ITAD_CONCURRENCY,
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
          itadLookupFailures++;
          itadLookupByAppid.set(item.appid, null);
        }
      },
      () => incrementProgress(),
    );

    const resolvedItadIds = [
      ...new Set([...itadLookupByAppid.values()].filter((v): v is ItadLookupResult => v !== null).map((v) => v.id)),
    ];

    // Price history is stored locally and permanently (`cache/historyStore.ts`), so this is a
    // sync, not a fetch: most games are already current and cost zero upstream calls. Only a
    // game we've never seen (full backfill) or one past ITAD_HISTORY_RESYNC_SEC (a small delta)
    // goes to ITAD. This is what replaced the old one-history-call-per-game-per-refresh —
    // which also had to re-run in full whenever `historyYears` changed, since the low was
    // cached per window. Both the window low and the sale trend are now local queries.
    if (resolvedItadIds.length > 0) {
      setProgressPhase("Syncing price history…", resolvedItadIds.length);
      await mapWithConcurrency(
        resolvedItadIds,
        ITAD_CONCURRENCY,
        async (itadId) => {
          // Force Refresh always pulls the delta: the payload is tiny, and "I don't trust the
          // cache" should still mean a fresh answer. It deliberately does *not* re-backfill —
          // re-reading years of immutable rows buys nothing but wall time.
          if (await syncGameHistorySafe(itadId, cc, { force: forceAllGames })) historySyncCalls++;
        },
        () => incrementProgress(),
      );
    }

    staleItems.forEach((item) => {
      const priceOverview = steamPriceByAppid.get(item.appid) ?? null;
      const storeItem = storeItemByAppid.get(item.appid);
      const itadLookup = itadLookupByAppid.get(item.appid) ?? null;
      const itadId = itadLookup?.id ?? null;
      // Derived per request from the local history rows rather than fetched: the window low
      // moves as the window slides (an old low ages out and the answer goes back *up*), so it
      // can only ever be recomputed, never remembered. It also excludes the sale running right
      // now, so `isLowestEver` asks whether this sale beats every *previous* one.
      const historyLow = itadId ? queryWindowLow(itadId, cc, historyYears) : null;
      const recentSales = itadId ? querySaleEpisodes(itadId, cc, config.saleEpisodeLimit) : [];
      // The chart spans exactly the sales it plots, so the points are bounded by the oldest
      // episode rather than by `historyYears` — sending a decade of points for years=0 would
      // bloat the payload for a chart that only ever draws the recent stretch.
      const oldestSale = recentSales[recentSales.length - 1];
      const pricePoints =
        itadId && oldestSale ? queryPricePoints(itadId, cc, new Date(oldestSale.startDate).getTime()) : [];

      const currentPrice = priceOverview ? priceOverview.final / 100 : null;
      const historyLowPrice = historyLow ? historyLow.price : null;

      let isLowestEver: boolean | null = null;
      if (currentPrice !== null && historyLowPrice !== null) {
        isLowestEver = currentPrice <= historyLowPrice + PRICE_EPSILON;
      }

      const game: WishlistGame = {
        appid: item.appid,
        name: storeItem?.name ?? `App ${item.appid}`,
        // Steam's store item response gives the real, currently-valid header image URL. Newer
        // titles use a hashed path under shared.akamai.steamstatic.com/store_item_assets/ rather
        // than the old static /steam/apps/{appid}/header.jpg convention, which 404s for them —
        // only fall back to guessing that convention if Steam didn't return one (e.g. delisted).
        headerImage:
          storeItem?.headerImage ??
          `https://cdn.akamai.steamstatic.com/steam/apps/${item.appid}/header.jpg`,
        storeUrl: `https://store.steampowered.com/app/${item.appid}`,

        priority: item.priority,
        dateAdded: item.dateAdded,

        priceStatus: priceOverview ? "ok" : "unavailable",
        currency: priceOverview?.currency ?? null,
        currentPrice,
        initialPrice: priceOverview ? priceOverview.initial / 100 : null,
        discountPercent: priceOverview?.discountPercent ?? null,

        itadStatus: itadId ? "ok" : "unmatched",
        itadUrl: itadLookup?.url ?? null,
        historyLowPrice,
        historyLowDate: historyLow?.timestamp ?? null,
        isLowestEver,
        recentSales,
        pricePoints,

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

  const steamPriceSuccesses = fullWishlist.length - steamPriceFailures;
  const itadLookupSuccesses = staleItems.length - itadLookupFailures;
  logger.info(
    `Wishlist refresh complete: ${games.length} on-sale game(s) returned — ` +
      `Steam prices: ${steamPriceSuccesses}/${fullWishlist.length} ok (${steamPriceFailures} failed); ` +
      `ITAD lookups: ${itadLookupSuccesses}/${staleItems.length} ok (${itadLookupFailures} failed); ` +
      `ITAD history syncs: ${historySyncCalls} (rest served from local history)`,
  );

  return {
    games,
    warnings,
    generatedAt: new Date().toISOString(),
    debugCapable,
    debugGameLimit: debugCapable ? (debugGameLimit ?? null) : undefined,
    historyYears,
  };
}
