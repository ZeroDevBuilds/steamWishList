import { db } from "./db.js";
import type { ItadHistoryEntry, ItadHistoryLow, PricePoint, SaleEpisode } from "../types/itad.js";

/**
 * Local store of Steam price history (see the table comments in `db.ts` for why it isn't a
 * cache). Everything the app used to ask ITAD for per request — the window low, and now the
 * recent-sales trend — is derived from these rows instead, so switching the history window
 * costs zero upstream calls.
 */

const insertRowStmt = db.prepare<[string, string, number, number, number, number, string]>(
  "INSERT INTO price_history (itad_id, country, timestamp, price, regular, cut, currency) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?) " +
    // Re-syncs deliberately overlap the previous watermark, so the same entry can arrive
    // twice; the newer copy simply replaces the old one.
    "ON CONFLICT(itad_id, country, timestamp) DO UPDATE SET " +
    "price = excluded.price, regular = excluded.regular, cut = excluded.cut, currency = excluded.currency",
);

const selectRowsStmt = db.prepare<[string, string], HistoryRow>(
  "SELECT timestamp, price, regular, cut, currency FROM price_history " +
    "WHERE itad_id = ? AND country = ? ORDER BY timestamp ASC",
);

const selectLowStmt = db.prepare<
  [string, string, number, number],
  { timestamp: number; price: number; currency: string }
>(
  "SELECT timestamp, price, currency FROM price_history " +
    "WHERE itad_id = ? AND country = ? AND timestamp >= ? AND timestamp <= ? " +
    "ORDER BY price ASC, timestamp ASC LIMIT 1",
);

const selectNewestStmt = db.prepare<[string, string], { timestamp: number; cut: number }>(
  "SELECT timestamp, cut FROM price_history WHERE itad_id = ? AND country = ? ORDER BY timestamp DESC LIMIT 1",
);

const selectLastCloseStmt = db.prepare<[string, string], { ts: number | null }>(
  "SELECT MAX(timestamp) AS ts FROM price_history WHERE itad_id = ? AND country = ? AND cut = 0",
);

// Anchored to the last reading at or before `since` so the step line starts at the price
// that was actually in effect when the window opens, instead of springing from nowhere.
const selectPointsStmt = db.prepare<
  [string, string, string, string, number, number],
  { timestamp: number; price: number; cut: number }
>(
  "SELECT timestamp, price, cut FROM price_history " +
    "WHERE itad_id = ? AND country = ? AND timestamp >= COALESCE(" +
    "(SELECT MAX(timestamp) FROM price_history WHERE itad_id = ? AND country = ? AND timestamp <= ?), ?" +
    ") ORDER BY timestamp ASC",
);

const selectWatermarkStmt = db.prepare<[string, string], WatermarkRow>(
  "SELECT synced_through, last_change_at FROM history_sync WHERE itad_id = ? AND country = ?",
);

const upsertWatermarkStmt = db.prepare<[string, string, number, number | null]>(
  "INSERT INTO history_sync (itad_id, country, synced_through, last_change_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(itad_id, country) DO UPDATE SET " +
    "synced_through = excluded.synced_through, " +
    // A delta that returned nothing new must not blank out a known last-change date.
    "last_change_at = COALESCE(excluded.last_change_at, history_sync.last_change_at)",
);

interface HistoryRow {
  timestamp: number;
  price: number;
  regular: number;
  cut: number;
  currency: string;
}

interface WatermarkRow {
  synced_through: number;
  last_change_at: number | null;
}

export interface HistoryWatermark {
  /** Epoch ms of the last time we asked ITAD for this game's history. */
  syncedThrough: number;
  /** Epoch ms of the newest price change ITAD has recorded, or null if it has none. */
  lastChangeAt: number | null;
}

const insertRowsTxn = db.transaction((itadId: string, country: string, entries: ItadHistoryEntry[]) => {
  for (const e of entries) {
    insertRowStmt.run(itadId, country, e.timestamp, e.price, e.regular, e.cut, e.currency);
  }
});

/** Appends price-change entries for one game. Idempotent — re-inserting the same entry is a no-op. */
export function insertHistoryEntries(itadId: string, country: string, entries: ItadHistoryEntry[]): void {
  if (entries.length === 0) return;
  insertRowsTxn(itadId, country, entries);
}

export function getHistoryWatermark(itadId: string, country: string): HistoryWatermark | null {
  const row = selectWatermarkStmt.get(itadId, country);
  if (!row) return null;
  return { syncedThrough: row.synced_through, lastChangeAt: row.last_change_at };
}

export function setHistoryWatermark(
  itadId: string,
  country: string,
  syncedThrough: number,
  lastChangeAt: number | null,
): void {
  upsertWatermarkStmt.run(itadId, country, syncedThrough, lastChangeAt);
}

/**
 * Newest timestamp eligible for the window low, excluding a sale that is running *right now*.
 *
 * Returns null when nothing needs excluding (no sale in progress). Returns -1 when the entire
 * recorded log is one unbroken sale — there is genuinely no prior sale to compare against, so
 * the low comes back null rather than silently comparing the current sale to itself.
 */
function priorSaleCeiling(itadId: string, country: string): number | null {
  const newest = selectNewestStmt.get(itadId, country);
  if (!newest || newest.cut === 0) return null; // not currently discounted — nothing to exclude
  // A sale is open, so it's every row after the most recent one that closed a sale.
  return selectLastCloseStmt.get(itadId, country)?.ts ?? -1;
}

/**
 * Lowest recorded price within the last `years` years (0 = all time), **excluding the sale
 * currently in progress**, or null if there's nothing to compare against.
 *
 * The exclusion is what gives `isLowestEver` its meaning: the running sale is itself in the
 * history, so including it makes the low equal the current price and the flag true for any
 * game sitting at its usual discount. Excluding it turns the question into the useful one —
 * "does this sale match or beat every *previous* sale?"
 *
 * Recomputed on every call rather than stored: with a rolling window the answer can move *up*
 * as an old low ages out, which a remembered low could never do.
 */
export function queryWindowLow(itadId: string, country: string, years: number): ItadHistoryLow | null {
  const since = years === 0 ? 0 : Date.now() - years * 365 * 24 * 60 * 60 * 1000;
  const ceiling = priorSaleCeiling(itadId, country) ?? Number.MAX_SAFE_INTEGER;
  const row = selectLowStmt.get(itadId, country, since, ceiling);
  if (!row) return null;
  return {
    price: row.price,
    currency: row.currency,
    timestamp: new Date(row.timestamp).toISOString(),
  };
}

/**
 * Raw price points from `since` onward, oldest first, for the sale-trend step chart.
 *
 * Sent as points rather than a pre-rendered path so the client can re-window the chart to the
 * user's chosen sale count without a refetch — the same reason `recentSales` is over-supplied.
 */
export function queryPricePoints(itadId: string, country: string, since: number): PricePoint[] {
  return selectPointsStmt
    .all(itadId, country, itadId, country, since, since)
    .map((r) => ({ t: r.timestamp, price: r.price, cut: r.cut }));
}

/**
 * The most recent `limit` discount periods, newest first.
 *
 * Deliberately not scoped to the history-years window: "the last 3 sales" should mean the last
 * 3, otherwise a game with two sales in the window renders a short list for reasons invisible
 * on screen. The window stays what it is — the basis for `isLowestEver`.
 */
export function querySaleEpisodes(itadId: string, country: string, limit: number): SaleEpisode[] {
  if (limit <= 0) return [];
  const rows = selectRowsStmt.all(itadId, country);
  const episodes: SaleEpisode[] = [];

  // Folded oldest-first so an episode's start is seen before its end. Consecutive cut > 0
  // entries are one episode, not several: Steam re-cuts mid-sale (and ITAD logs a row for a
  // regular-price change during a sale), which would otherwise split one sale into a run of
  // adjacent one-day "sales".
  let current: SaleEpisode | null = null;
  for (const row of rows) {
    if (row.cut > 0) {
      if (current === null) {
        current = {
          startDate: new Date(row.timestamp).toISOString(),
          endDate: null,
          price: row.price,
          cut: row.cut,
          currency: row.currency,
        };
      } else {
        current.price = Math.min(current.price, row.price);
        current.cut = Math.max(current.cut, row.cut);
      }
    } else if (current !== null) {
      current.endDate = new Date(row.timestamp).toISOString();
      episodes.push(current);
      current = null;
    }
  }
  // An episode still open at the end of the log is a sale running right now — endDate stays null.
  if (current !== null) episodes.push(current);

  return episodes.reverse().slice(0, limit);
}
