import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { serializeError, type Logger } from "@ai-career/logging";
import { BusyError, type Limiter } from "./limiter";
import type { CompileOutcome } from "./compile";

export const MAX_TEX_BYTES = 256 * 1024;
export const MAX_EXTRACT_BYTES = 4 * 1024 * 1024;

export interface ServerDeps {
  token: string;
  texVersion: string;
  compile: (tex: string) => Promise<CompileOutcome>;
  limiter: Limiter;
  logger: Logger;
  /** Set only when LATEX_COMPILER_TEST_MODE=1 (integration tests read the PDF's text through it). */
  extract?: (pdf: Buffer) => Promise<string>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The body, or null when it exceeds `max` (the rest is drained, not buffered). */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://compiler");
  if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, texVersion: deps.texVersion });
  const isCompile = req.method === "POST" && pathname === "/compile";
  const isExtract = req.method === "POST" && pathname === "/extract" && deps.extract !== undefined;
  if (!isCompile && !isExtract) return sendJson(res, 404, { code: "not_found" });
  if (!authorized(req.headers.authorization, deps.token)) {
    req.resume();
    return sendJson(res, 401, { code: "unauthorized" });
  }
  const body = await readBody(req, isExtract ? MAX_EXTRACT_BYTES : MAX_TEX_BYTES);
  if (body === null) {
    res.setHeader("Connection", "close");
    return sendJson(res, 413, { code: "too_large" });
  }
  if (isExtract) {
    const text = await deps.extract!(body);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
    return;
  }

  const requestId = randomUUID();
  const started = Date.now();
  let outcome: CompileOutcome;
  try {
    outcome = await deps.limiter.run(() => deps.compile(body.toString("utf8")));
  } catch (err) {
    if (err instanceof BusyError) {
      deps.logger.warn("latex_compiler.busy", { requestId, bytes: body.length });
      return sendJson(res, 503, { code: "busy" });
    }
    throw err;
  }
  // Sizes, timings and outcomes only -- never the .tex or pdflatex's log (CLAUDE.md §9).
  deps.logger.info("latex_compiler.compile", {
    requestId, bytes: body.length, durationMs: Date.now() - started, outcome: outcome.kind,
    ...(outcome.kind === "ok" ? { pageCount: outcome.pageCount } : {}),
    ...(outcome.kind === "failed" && outcome.line !== undefined ? { line: outcome.line } : {}),
  });
  switch (outcome.kind) {
    case "ok":
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": outcome.pdf.length,
        "X-Page-Count": String(outcome.pageCount),
        "X-Tex-Version": deps.texVersion,
        // Whole points left at the bottom of the page (D217); omitted when the template did not report it.
        ...(outcome.freeSpacePt !== null ? { "X-Free-Space-Pt": String(outcome.freeSpacePt) } : {}),
      });
      res.end(outcome.pdf);
      return;
    case "failed":
      return sendJson(res, 422, outcome.line !== undefined ? { code: "compile_failed", line: outcome.line } : { code: "compile_failed" });
    case "timeout":
      return sendJson(res, 504, { code: "timeout" });
  }
}

export function createCompilerServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      deps.logger.error("latex_compiler.unhandled", { error: serializeError(err) });
      if (!res.headersSent) sendJson(res, 500, { code: "internal" });
      else res.destroy();
    });
  });
}
