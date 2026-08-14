import { config } from "../config.js";
import {
  getHistoryWatermark,
  insertHistoryEntries,
  setHistoryWatermark,
} from "../cache/historyStore.js";
import { fetchItadHistory } from "./itad.js";
import { logger } from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a delta re-sync reaches beyond the watermark. ITAD entries can land slightly
 * out of order relative to when we asked, and re-inserting an entry we already have is free
 * (the store upserts on timestamp), so a day of overlap is cheap insurance against a gap.
 */
const RESYNC_OVERLAP_MS = DAY_MS;

/**
 * Brings one game's local Steam price history up to date, if it's due.
 *
 * The gate is the *watermark* — when we last asked — never the date of the game's most recent
 * price change. A game dormant for a year has a year-old last-change date permanently, and no
 * amount of fetching moves it, so gating on that would re-poll exactly the games that have
 * nothing new, on every single refresh.
 *
 * Returns true if an upstream call was made.
 */
export async function syncGameHistory(
  itadId: string,
  countryCode: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const now = Date.now();
  const watermark = getHistoryWatermark(itadId, countryCode);

  let since: number;
  if (watermark === null) {
    // First sight of this game: backfill wide enough that every history window the UI can ask
    // for is answerable locally, forever. It's one call either way — only the payload differs —
    // so scoping the backfill to the currently-requested `years` would just guarantee another
    // round trip for every game the first time the user widens the window.
    since = now - config.itadHistoryBackfillYears * 365 * DAY_MS;
  } else if (options.force || now - watermark.syncedThrough >= config.itadHistoryResyncSec * 1000) {
    since = watermark.syncedThrough - RESYNC_OVERLAP_MS;
  } else {
    return false; // still fresh — serve from local rows
  }

  const entries = await fetchItadHistory(itadId, countryCode, since);
  insertHistoryEntries(itadId, countryCode, entries);
  const newestChange = entries.length > 0 ? entries[entries.length - 1].timestamp : null;
  setHistoryWatermark(itadId, countryCode, now, newestChange);
  return true;
}

/**
 * Best-effort wrapper: a history sync failure must not fail the request. Whatever rows are
 * already local stay usable, and the watermark isn't advanced, so the next refresh retries.
 */
export async function syncGameHistorySafe(
  itadId: string,
  countryCode: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  try {
    return await syncGameHistory(itadId, countryCode, options);
  } catch (err) {
    logger.warn(`ITAD history sync failed for id ${itadId}`, err);
    return false;
  }
}
