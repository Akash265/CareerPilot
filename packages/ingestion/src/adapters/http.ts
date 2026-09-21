import { IngestError } from "../types";

export const DEFAULT_TIMEOUT_MS = 30_000;
// Greenhouse boards with content=true are large (Stripe ~5 MB, Palantir/Lever ~6 MB).
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface FetchJsonOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchFn?: typeof fetch;
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** GET a URL and return parsed JSON. Throws `IngestError` and nothing else, with a class only. */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "career-pilot-ingestion/0.1 (personal job search tool)" },
      // A redirect could move the request off the configured host; treat any 3xx as an error.
      redirect: "manual",
    });
  } catch (error) {
    throw new IngestError(isTimeout(error) ? "timeout" : "network");
  }

  if (response.status === 404) throw new IngestError("not_found");
  if (response.status === 429) throw new IngestError("rate_limited");
  if (response.status >= 500) throw new IngestError("server_error");
  if (!response.ok) throw new IngestError("http_error");

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new IngestError("response_too_large");

  let text: string;
  try {
    text = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(isTimeout(error) ? "timeout" : "network");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new IngestError("schema_mismatch");
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IngestError("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
