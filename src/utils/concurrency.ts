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

/**
 * Returns a function that, when awaited, admits at most `maxRequests` calls in any
 * `windowMs` sliding window, optionally also spacing consecutive calls `minIntervalMs` apart.
 *
 * This models a *window*-based quota (ITAD publishes "1000 requests in a 5 minute window")
 * rather than a fixed rate: bursts up to the budget are allowed, and callers only wait once
 * the window is genuinely full. `createRateLimiter`'s fixed spacing pins throughput at the
 * sustained average forever, which wastes the whole budget when the work is bursty — a
 * wishlist refresh is a few hundred calls and then nothing for an hour.
 *
 * Slots are reserved synchronously before awaiting, so concurrent callers can't over-book.
 */
export function createWindowRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  minIntervalMs?: number;
}): () => Promise<void> {
  const { maxRequests, windowMs, minIntervalMs = 0 } = options;
  // Slot times already handed out, oldest first; entries older than the window are dropped.
  const reserved: number[] = [];
  let nextAvailableAt = 0;

  const dropExpired = (asOf: number) => {
    while (reserved.length > 0 && reserved[0] <= asOf - windowMs) reserved.shift();
  };

  return async () => {
    const now = Date.now();
    let slot = Math.max(now, nextAvailableAt);
    dropExpired(slot);
    if (reserved.length >= maxRequests) {
      // Wait for the oldest call that's still counted against the window to age out of it.
      slot = Math.max(slot, reserved[reserved.length - maxRequests] + windowMs);
      dropExpired(slot);
    }
    nextAvailableAt = slot + minIntervalMs;
    reserved.push(slot);

    const waitMs = slot - now;
    if (waitMs > 0) await sleep(waitMs);
  };
}

/** Splits `items` into consecutive groups of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onItemDone?: () => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
      onItemDone?.();
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
