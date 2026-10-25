import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createCompilerServer, type ServerDeps } from "./server";
import { createLimiter } from "./limiter";
import type { CompileOutcome } from "./compile";

const TOKEN = "k".repeat(32);
const lines: string[] = [];
const logger = { debug() {}, info: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })), warn: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })), error: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })) };
let server: http.Server | undefined;

async function start(over: Partial<ServerDeps> = {}): Promise<string> {
  server = createCompilerServer({
    token: TOKEN, texVersion: "pdfTeX test", logger, limiter: createLimiter({ concurrency: 2, maxQueue: 4 }),
    compile: async (): Promise<CompileOutcome> => ({ kind: "ok", pdf: Buffer.from("%PDF"), pageCount: 1, freeSpacePt: null }),
    ...over,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  lines.length = 0;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});
const post = (base: string, p: string, body: string, token = TOKEN) =>
  fetch(`${base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });

describe("latex-compiler server", () => {
  it("reports health with the TeX version", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, texVersion: "pdfTeX test" });
  });
  it("compiles: 200 PDF with page count and version headers", async () => {
    const base = await start();
    const res = await post(base, "/compile", "\\documentclass{article}");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-page-count")).toBe("1");
    expect(res.headers.get("x-tex-version")).toBe("pdfTeX test");
    expect(res.headers.get("x-free-space-pt")).toBeNull(); // the default fake reports no free space
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF");
  });
  it("reports the page's free space as a whole-points header when the compile measured it", async () => {
    const base = await start({ compile: async (): Promise<CompileOutcome> => ({ kind: "ok", pdf: Buffer.from("%PDF"), pageCount: 1, freeSpacePt: 48 }) });
    const res = await post(base, "/compile", "\\documentclass{article}");
    expect(res.headers.get("x-free-space-pt")).toBe("48");
  });
  it("rejects a missing or wrong token with 401", async () => {
    const base = await start();
    expect((await post(base, "/compile", "x", "wrong")).status).toBe(401);
    expect((await fetch(`${base}/compile`, { method: "POST", body: "x" })).status).toBe(401);
  });
  it("rejects a body over 256 KB with 413", async () => {
    const base = await start();
    const res = await post(base, "/compile", "x".repeat(256 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "too_large" });
  });
  it("maps failed/timeout/busy, never echoing compiler or document text, and logs no content", async () => {
    const failedBase = await start({ compile: async () => ({ kind: "failed", line: 9 }) });
    const failed = await post(failedBase, "/compile", "SECRET-TEXT");
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ code: "compile_failed", line: 9 });
    expect(lines.join("\n")).not.toContain("SECRET-TEXT");
    await new Promise<void>((r) => server!.close(() => r()));

    const slowBase = await start({ compile: async () => ({ kind: "timeout" }) });
    expect((await post(slowBase, "/compile", "x")).status).toBe(504);
    await new Promise<void>((r) => server!.close(() => r()));

    const busyBase = await start({ limiter: createLimiter({ concurrency: 0, maxQueue: 0 }) });
    const busy = await post(busyBase, "/compile", "x");
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ code: "busy" });
  });
  it("exposes /extract only in test mode", async () => {
    const base = await start();
    expect((await post(base, "/extract", "%PDF")).status).toBe(404);
    await new Promise<void>((r) => server!.close(() => r()));
    const testBase = await start({ extract: async (pdf) => `text of ${pdf.length} bytes` });
    const res = await post(testBase, "/extract", "%PDF");
    expect(await res.text()).toBe("text of 4 bytes");
  });
  it("404s unknown routes", async () => {
    const base = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
