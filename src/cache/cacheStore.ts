import { db } from "./db.js";

const getStmt = db.prepare<[string], { value: string; expires_at: number }>(
  "SELECT value, expires_at FROM cache WHERE key = ?",
);
const setStmt = db.prepare<[string, string, number]>(
  "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
);
export function cacheGet<T>(key: string): T | undefined {
  const row = getStmt.get(key);
  if (!row) return undefined;
  if (row.expires_at < Date.now()) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): void {
  setStmt.run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}

/**
 * Returns the cached value for `key` if fresh, otherwise calls `fetchFn`,
 * caches the result, and returns it. Pass `forceRefresh` to bypass the cache read
 * (the fetched result is still written back so subsequent calls are served from cache).
 */
export async function getOrFetch<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>,
  options: { forceRefresh?: boolean } = {},
): Promise<T> {
  if (!options.forceRefresh) {
    const cached = cacheGet<T>(key);
    if (cached !== undefined) {
      return cached;
    }
  }
  const value = await fetchFn();
  cacheSet(key, value, ttlSeconds);
  return value;
}
