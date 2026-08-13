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
  cacheTtl: {
    wishlistSec: intEnv("CACHE_TTL_WISHLIST_SEC", 21600),
    steamPriceSec: intEnv("CACHE_TTL_STEAM_PRICE_SEC", 3600),
    itadLookupSec: intEnv("CACHE_TTL_ITAD_LOOKUP_SEC", 2592000),
    itadPriceSec: intEnv("CACHE_TTL_ITAD_PRICE_SEC", 3600),
  },
};
