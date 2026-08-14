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
  name?: string;
  headerImage?: string;
  priceOverview: SteamPriceOverview | null;
}
