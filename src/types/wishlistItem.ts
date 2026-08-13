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
}
