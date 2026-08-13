interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 1, ...init } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        throw new HttpError(`Request failed with status ${res.status}`, res.status, url, retryAfterMs(res));
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      const isRetryable =
        !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!isRetryable || attempt === retries) {
        throw err;
      }
      const backoffMs = err instanceof HttpError && err.retryAfterMs !== null
        ? err.retryAfterMs
        : 500 * 2 ** attempt;
      await sleep(backoffMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
