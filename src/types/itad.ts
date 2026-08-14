/** One Steam price-change entry from ITAD's history log. */
export interface ItadHistoryEntry {
  /** Epoch ms. */
  timestamp: number;
  price: number;
  /** Non-discounted price at the time — used to tell a sale from a return to full price. */
  regular: number;
  /** Discount percent; 0 means the price went back up to `regular` (i.e. a sale ended). */
  cut: number;
  currency: string;
}

export interface ItadHistoryLow {
  price: number;
  currency: string;
  timestamp: string | null; // ISO date, best-effort
}

/**
 * One point on the Steam price timeline. The price holds at this value until the next
 * point, so these are rendered as a *step* line — the price genuinely jumps, it doesn't
 * drift between readings, and interpolating would draw prices that never existed.
 */
export interface PricePoint {
  /** Epoch ms. */
  t: number;
  price: number;
  cut: number;
}

/**
 * One contiguous discount period on Steam, folded from the raw price-change log:
 * a `cut > 0` entry opens an episode and the next `cut === 0` entry closes it.
 */
export interface SaleEpisode {
  /** ISO date the discount started. */
  startDate: string;
  /** ISO date it ended, or null when the sale is still running. */
  endDate: string | null;
  /** Lowest price reached during the episode (Steam sometimes re-cuts mid-sale). */
  price: number;
  /** Deepest discount percent reached during the episode. */
  cut: number;
  currency: string;
}
