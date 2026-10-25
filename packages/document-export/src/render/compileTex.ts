import { DocumentExportError } from "../errors";

/** `freeSpacePt`: whole points left at the bottom of the last page, or null when the service did not report it (D217). */
export interface CompiledPdf { pdf: Buffer; pageCount: number; texVersion: string; freeSpacePt: number | null }
export interface TexCompiler { compile(tex: string): Promise<CompiledPdf> }
export interface HttpTexCompilerOptions { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Above the service's own 20 s kill, so a slow compile normally ends as the service's 504, not a client abort. */
export const TEX_COMPILE_CLIENT_TIMEOUT_MS = 30_000;

/** Maps a transport failure (fetch rejection or body-stream error) to the export error class. Name-based: abort/timeout errors are not always `instanceof Error`. */
function transportError(cause: unknown): DocumentExportError {
  const name = (cause as { name?: unknown } | null)?.name;
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return new DocumentExportError(timedOut ? "compiler_timeout" : "compiler_unavailable", { cause });
}

/** Client for services/latex-compiler (Phase 13c spec §5). Errors carry no compiler log text, only a line number. */
export function createHttpTexCompiler(opts: HttpTexCompilerOptions): TexCompiler {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = new URL("/compile", opts.url).toString();
  return {
    async compile(tex: string): Promise<CompiledPdf> {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "text/plain; charset=utf-8" },
          body: tex,
          signal: AbortSignal.timeout(opts.timeoutMs ?? TEX_COMPILE_CLIENT_TIMEOUT_MS),
        });
      } catch (cause) {
        throw transportError(cause);
      }
      if (res.status === 200) {
        const pageCount = Number(res.headers.get("x-page-count"));
        const texVersion = res.headers.get("x-tex-version") ?? "";
        if (!Number.isInteger(pageCount) || pageCount < 1 || texVersion === "") throw new DocumentExportError("compiler_unavailable");
        let pdf: Buffer;
        try {
          pdf = Buffer.from(await res.arrayBuffer());
        } catch (cause) {
          throw transportError(cause);
        }
        const free = res.headers.get("x-free-space-pt");
        const freeSpacePt = free !== null && /^\d+$/.test(free) ? Number(free) : null;
        return { pdf, pageCount, texVersion, freeSpacePt };
      }
      const body = (await res.json().catch(() => null)) as { line?: unknown } | null;
      switch (res.status) {
        case 422:
          throw new DocumentExportError("compile_failed", { detail: typeof body?.line === "number" ? `line ${body.line}` : undefined });
        case 413:
          throw new DocumentExportError("compile_failed", { detail: "document too large" });
        case 503:
          throw new DocumentExportError("compiler_busy");
        case 504:
          throw new DocumentExportError("compiler_timeout");
        default:
          throw new DocumentExportError("compiler_unavailable");
      }
    },
  };
}
