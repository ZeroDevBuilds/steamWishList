import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const config = {
  steamId64: requireEnv("STEAM_ID64"),
  steamApiKey: process.env.STEAM_API_KEY ?? "",
  itadApiKey: requireEnv("ITAD_API_KEY"),
  countryCode: optionalEnv("COUNTRY_CODE", "us"),
  port: intEnv("PORT", 3000),
  host: optionalEnv("HOST", "127.0.0.1"),
  /** Debug-only: caps how many wishlist games get price/ITAD enrichment. Unset = no limit. */
  debugGameLimit: optionalIntEnv("DEBUG_GAME_LIMIT"),
  /** Minimum spacing between Steam storefront price requests — shared across all concurrent
   *  callers. Raise this if Steam starts 429ing (Akamai bot protection). */
  steamPriceThrottleMs: intEnv("STEAM_PRICE_THROTTLE_MS", 1000),
  /** ITAD publishes a window quota ("1000 requests in a 5 minute window" for a verified
   *  account) and asks clients not to sit at the ceiling, so the default budget is deliberately
   *  below it. `itadThrottleMs` is a burst damper on top, not the sustained rate. */
  itadMaxRequestsPerWindow: intEnv("ITAD_MAX_REQUESTS_PER_WINDOW", 800),
  itadRateWindowSec: intEnv("ITAD_RATE_WINDOW_SEC", 300),
  itadThrottleMs: intEnv("ITAD_THROTTLE_MS", 50),
  /** How stale a game's locally stored price history may get before a delta re-sync from ITAD.
   *  **Not a TTL** — the rows themselves never expire, because a past price change is a fact.
   *  This only bounds how long a gap (a sale that opened and closed while we weren't looking)
   *  can go unnoticed. Games entering a sale are still caught immediately, via Steam's own
   *  price call, so this can sit high. */
  itadHistoryResyncSec: intEnv("ITAD_HISTORY_RESYNC_SEC", 2592000), // 30d
  /** Lookback for a game's first history backfill. Effectively "all time" — ITAD returns
   *  nothing before a game's first recorded price anyway, and a single wide backfill makes
   *  every `years` window answerable locally without another upstream call. */
  itadHistoryBackfillYears: intEnv("ITAD_HISTORY_BACKFILL_YEARS", 20),
  /** Upper bound on sale episodes returned per game. The UI slices this down to the user's
   *  chosen count client-side, so this only needs to exceed what anyone would want on screen —
   *  keeping the count out of the cache key and off the network. */
  saleEpisodeLimit: intEnv("SALE_EPISODE_LIMIT", 10),
  cacheTtl: {
    wishlistSec: intEnv("CACHE_TTL_WISHLIST_SEC", 21600),
    steamPriceSec: intEnv("CACHE_TTL_STEAM_PRICE_SEC", 3600),
    /** Short negative-cache TTL for a *failed* Steam price fetch (e.g. Akamai 403) — long enough
     *  that a retried page load doesn't immediately re-hammer Steam, short enough that it isn't
     *  mistaken for a real "no price data" result for anywhere near the full price TTL. */
    steamPriceFailureSec: intEnv("CACHE_TTL_STEAM_PRICE_FAILURE_SEC", 120),
    /** Steam store metadata (name, header artwork) — near-static, so this can sit well above
     *  the price TTL; it only exists to keep GetItems batches small on a warm cache. */
    steamStoreItemSec: intEnv("CACHE_TTL_STEAM_ITEM_SEC", 604800),
    itadLookupSec: intEnv("CACHE_TTL_ITAD_LOOKUP_SEC", 2592000),
    /** How long a game's fully-enriched data (price + ITAD deal/history) is reused before re-fetching. */
    gameSec: intEnv("CACHE_TTL_GAME_SEC", 86400),
  },
};
