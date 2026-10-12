export interface PoliteFetchOptions {
  fetchFn?: typeof fetch;
  /** Minimum gap between two requests to the same host. */
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Phase 12 (D188). A fetch that is polite to every job site it talks to: requests to one host are at least
 * `minIntervalMs` apart, and a 429 with a short seconds-valued `Retry-After` is waited out and retried once.
 * Anything else (a long or date-valued Retry-After, a second 429) is returned for fetchJson to classify as
 * `rate_limited`, which the queue retries later. One instance per worker process, shared by every adapter.
 */
export function createPoliteFetch(opts: PoliteFetchOptions): typeof fetch {
  const inner = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastAt = new Map<string, number>();

  const spaced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(input instanceof Request ? input.url : input.toString()).host;
    const previous = lastAt.get(host);
    if (previous !== undefined) {
      const wait = previous + opts.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastAt.set(host, now());
    return inner(input, init);
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const first = await spaced(input, init);
    if (first.status !== 429) return first;
    const header = first.headers.get("retry-after")?.trim() ?? "";
    const seconds = /^\d+$/.test(header) ? Number(header) : NaN;
    if (!Number.isFinite(seconds) || seconds * 1000 > MAX_RETRY_AFTER_MS) return first;
    await first.body?.cancel().catch(() => undefined);
    await sleep(seconds * 1000);
    return spaced(input, init);
  }) as typeof fetch;
}
