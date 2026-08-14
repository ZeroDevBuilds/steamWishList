import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CACHE_DB_PATH ?? `${__dirname}/../../data/cache.sqlite`;

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

// Steam price-change log, accumulated from ITAD's games/history/v2 and kept indefinitely.
//
// This is NOT a cache and has no TTL: a price change that happened on a given date is a fact
// that never changes, so the rows are only ever appended to. What *is* derived (and therefore
// must never be stored) is the lowest price within a window — that answer moves as the window
// slides, so it's recomputed per request in `historyStore.ts` rather than remembered.
//
// Steam-only (ITAD shop 61), hence no shop column: every price this app shows is a Steam price,
// so mixing other shops' deals in would make "lowest ever" incomparable to the current price.
db.exec(`
  CREATE TABLE IF NOT EXISTS price_history (
    itad_id TEXT NOT NULL,
    country TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    price REAL NOT NULL,
    regular REAL NOT NULL,
    cut INTEGER NOT NULL,
    currency TEXT NOT NULL,
    PRIMARY KEY (itad_id, country, timestamp)
  )
`);

// One row per game tracking how current our copy of its history is.
//
// `synced_through` is the watermark — when we last *asked* ITAD — and is the only value that
// gates whether a re-sync is due, because it's the only one a successful call always advances.
// `last_change_at` (the newest price change ITAD knows of) is a property of how often the game
// goes on sale, not of our freshness: a game dormant for a year has a year-old `last_change_at`
// no matter how recently we synced, so gating on it would re-poll exactly the games with
// nothing to fetch, forever. It's kept because it's a good signal for how *often* to poll.
db.exec(`
  CREATE TABLE IF NOT EXISTS history_sync (
    itad_id TEXT NOT NULL,
    country TEXT NOT NULL,
    synced_through INTEGER NOT NULL,
    last_change_at INTEGER,
    PRIMARY KEY (itad_id, country)
  )
`);
