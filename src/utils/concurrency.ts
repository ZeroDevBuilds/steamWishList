const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns a function that, when awaited, resolves immediately the first time
 * and after at least `minIntervalMs` since the previous call thereafter —
 * i.e. spaces out calls to a shared resource (like a rate-limited API)
 * regardless of how many callers are queued up concurrently.
 */
export function createRateLimiter(minIntervalMs: number): () => Promise<void> {
  let nextAvailableAt = 0;
  return async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextAvailableAt - now);
    nextAvailableAt = Math.max(now, nextAvailableAt) + minIntervalMs;
    if (waitMs > 0) await sleep(waitMs);
  };
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
