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
  /** Lowest price seen within the response's `historyYears` window (0 = all-time), per ITAD's history log. */
  historyLowPrice: number | null;
  historyLowDate: string | null;
  isLowestEver: boolean | null;
  /** Best currently-listed deal ITAD knows of, which may be a different shop than Steam. */
  bestDealElsewhere: { shop: string; price: number } | null;

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
