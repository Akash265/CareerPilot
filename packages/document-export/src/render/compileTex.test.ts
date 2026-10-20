import { describe, it, expect, vi } from "vitest";
import { createHttpTexCompiler } from "./compileTex";
import { DocumentExportError } from "../errors";

const response = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const compilerWith = (fetchImpl: typeof fetch) => createHttpTexCompiler({ url: "http://127.0.0.1:8090", token: "t".repeat(32), fetchImpl });
const errorClassOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof DocumentExportError ? [e.errorClass, e.detail] : ["other", String(e)]; }
  return ["resolved"];
};

describe("createHttpTexCompiler", () => {
  it("POSTs the tex with the bearer token and returns pdf, page count and TeX version", async () => {
    const fetchImpl = vi.fn(async () => response(200, Buffer.from("%PDF-1.5"), { "X-Page-Count": "1", "X-Tex-Version": "pdfTeX 3.14" }));
    const out = await compilerWith(fetchImpl as unknown as typeof fetch).compile("\\documentclass{article}");
    expect(out).toEqual({ pdf: Buffer.from("%PDF-1.5"), pageCount: 1, texVersion: "pdfTeX 3.14" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8090/compile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(32)}`);
    expect(init.body).toBe("\\documentclass{article}");
  });

  it.each([
    [422, JSON.stringify({ code: "compile_failed", line: 42 }), ["compile_failed", "line 42"]],
    [413, JSON.stringify({ code: "too_large" }), ["compile_failed", "document too large"]],
    [503, JSON.stringify({ code: "busy" }), ["compiler_busy", undefined]],
    [504, JSON.stringify({ code: "timeout" }), ["compiler_timeout", undefined]],
    [401, JSON.stringify({ code: "unauthorized" }), ["compiler_unavailable", undefined]],
    [500, "oops", ["compiler_unavailable", undefined]],
  ])("maps HTTP %i", async (status, body, expected) => {
    const c = compilerWith((async () => response(status, body)) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(expected);
  });

  it("treats a 200 without page count or version as unavailable", async () => {
    const c = compilerWith((async () => response(200, "x", { "X-Page-Count": "abc" })) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(["compiler_unavailable", undefined]);
  });

  it("maps a network error to unavailable and a client timeout to compiler_timeout", async () => {
    const refused = compilerWith((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    expect((await errorClassOf(refused.compile("x")))[0]).toBe("compiler_unavailable");
    const slow = createHttpTexCompiler({
      url: "http://127.0.0.1:8090", token: "t".repeat(32), timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch,
    });
    expect((await errorClassOf(slow.compile("x")))[0]).toBe("compiler_timeout");
  });

  const bodyFailingWith = (err: unknown) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(err); } });
    return response(200, body, { "X-Page-Count": "1", "X-Tex-Version": "pdfTeX 3.14" });
  };

  it("maps a connection drop while reading the 200 body to compiler_unavailable", async () => {
    const c = compilerWith((async () => bodyFailingWith(new TypeError("terminated"))) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(["compiler_unavailable", undefined]);
  });

  it("maps a timeout while reading the 200 body to compiler_timeout", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const c = compilerWith((async () => bodyFailingWith(timeout)) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(["compiler_timeout", undefined]);
  });
});
