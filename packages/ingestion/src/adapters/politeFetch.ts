export interface PoliteFetchOptions {
  fetchFn?: typeof fetch;
  /** Minimum gap between two requests to the same host. */
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// The request's own timeout (fetchJson: 30 s) starts before the first attempt and also covers the retry, so only a
// short wait leaves the retry time to finish.
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Phase 12 (D188). A fetch that is polite to every job site it talks to: requests to one host are at least
 * `minIntervalMs` apart (concurrent callers included), and a 429 with a `Retry-After` of at most 10 s is waited out
 * and retried once.
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
    // Reserve this request's slot before sleeping, so concurrent callers (a run and a validation pass) queue up
    // instead of all reading the same "last request" time and firing together.
    const previous = lastAt.get(host);
    const slot = previous === undefined ? now() : Math.max(now(), previous + opts.minIntervalMs);
    lastAt.set(host, slot);
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
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
