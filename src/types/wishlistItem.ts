import type { PricePoint, SaleEpisode } from "./itad.js";

export type PriceStatus = "ok" | "unavailable";
export type ItadStatus = "ok" | "unmatched" | "error";

export interface NextSaleEstimate {
  label: string;
  confidence: "low";
}

export interface WishlistGame {
  appid: number;
  name: string;
  headerImage: string;
  storeUrl: string;

  priority?: number;
  dateAdded?: number;

  priceStatus: PriceStatus;
  currency: string | null;
  currentPrice: number | null;
  initialPrice: number | null;
  discountPercent: number | null;

  itadStatus: ItadStatus;
  /** Public isthereanydeal.com page for this game, when ITAD has a match. */
  itadUrl: string | null;
  /**
   * Lowest Steam price within the response's `historyYears` window (0 = all-time), **excluding
   * any sale running right now** — so it's the bar the current price has to beat, not itself.
   * Null when there's no prior sale in the window to compare against.
   */
  historyLowPrice: number | null;
  historyLowDate: string | null;
  /** Whether the current price matches or beats every *previous* sale in the window. */
  isLowestEver: boolean | null;
  /**
   * Recent Steam discount periods, newest first — up to `SALE_EPISODE_LIMIT` of them.
   * The client renders however many the user asked for, so this is deliberately not scoped
   * to a requested count (which would fragment the per-game cache by every value picked).
   */
  recentSales: SaleEpisode[];
  /**
   * Steam price timeline covering `recentSales`, oldest first — the sale-trend chart's data.
   * Includes the full-price stretches between sales, so the step line tells the truth about
   * what the price actually was rather than interpolating between discounts.
   */
  pricePoints: PricePoint[];

  nextSaleEstimate: NextSaleEstimate | null;
}

export interface WishlistResponse {
  games: WishlistGame[];
  warnings: string[];
  generatedAt: string;
  /** True when DEBUG_GAME_LIMIT is configured server-side, so the UI can offer the debug controls. */
  debugCapable: boolean;
  /** The limit applied to this response: a number, null when debug mode is capable but disabled, undefined when not debug-capable. */
  debugGameLimit?: number | null;
  /** The price-history lookback window (in years) used for `historyLowPrice/isLowestEver`; 0 means all-time. */
  historyYears: number;
}
