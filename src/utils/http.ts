interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
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
        throw new HttpError(`Request failed with status ${res.status}`, res.status, url);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        // Client errors won't be fixed by retrying.
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
