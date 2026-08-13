export interface ItadDeal {
  shop: string;
  price: number;
  currency: string;
  cut: number;
  url: string;
}

export interface ItadHistoryLow {
  price: number;
  currency: string;
  shop: string | null;
  timestamp: string | null; // ISO date, best-effort
}
