export interface SteamWishlistItem {
  appid: number;
  priority?: number;
  dateAdded?: number; // unix seconds
}

export interface SteamPriceOverview {
  currency: string;
  /** cents/pence, as returned by Steam */
  initial: number;
  final: number;
  discountPercent: number;
}

export interface SteamPriceResult {
  appid: number;
  priceOverview: SteamPriceOverview | null;
}

/** Store metadata (name, artwork, release) — fetched separately from price, see `services/steamStore.ts`. */
export interface SteamStoreItem {
  appid: number;
  name?: string;
  headerImage?: string;
  /** Steam release date, unix seconds. Absent for unreleased/undated apps. */
  releaseDate?: number;
}
