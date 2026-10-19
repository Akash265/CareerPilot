import { DocumentExportError } from "../errors";

export interface CompiledPdf { pdf: Buffer; pageCount: number; texVersion: string }
export interface TexCompiler { compile(tex: string): Promise<CompiledPdf> }
export interface HttpTexCompilerOptions { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Above the service's own 20 s kill, so a slow compile normally ends as the service's 504, not a client abort. */
export const TEX_COMPILE_CLIENT_TIMEOUT_MS = 30_000;

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
        const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        throw new DocumentExportError(timedOut ? "compiler_timeout" : "compiler_unavailable", { cause });
      }
      if (res.status === 200) {
        const pageCount = Number(res.headers.get("x-page-count"));
        const texVersion = res.headers.get("x-tex-version") ?? "";
        if (!Number.isInteger(pageCount) || pageCount < 1 || texVersion === "") throw new DocumentExportError("compiler_unavailable");
        return { pdf: Buffer.from(await res.arrayBuffer()), pageCount, texVersion };
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
