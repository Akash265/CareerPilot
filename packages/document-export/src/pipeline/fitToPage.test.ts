import { describe, it, expect, vi } from "vitest";
import { fitToPage, MAX_EXTRA_TRIMS } from "./fitToPage";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { TexCompiler } from "../render/compileTex";

const sel = (extra: number, exhausted = false): TailoredSelection => ({
  model: { title: `m${extra}`, contactLine: null, blocks: [] }, includedCount: 10 - extra, totalCount: 10, omitted: [], exhausted,
});
const render = (m: { title: string }) => `tex:${m.title}`;
const compilerReturning = (...pages: number[]): TexCompiler & { compile: ReturnType<typeof vi.fn> } => {
  const compile = vi.fn(async (tex: string) => ({ pdf: Buffer.from(tex), pageCount: pages.shift() ?? 1, texVersion: "v" }));
  return { compile };
};

describe("fitToPage", () => {
  it("returns the estimate fit without compiling when there is no compiler", async () => {
    const out = await fitToPage(sel, render, null);
    expect(out).toEqual({ selection: sel(0), tex: "tex:m0", compiled: null });
  });
  it("stops at the first one-page compile", async () => {
    const c = compilerReturning(1);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(1);
  });
  it("trims and recompiles until it fits", async () => {
    const c = compilerReturning(2, 2, 1);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(3);
    expect(out.tex).toBe("tex:m2");
    expect(out.compiled?.pdf.toString()).toBe("tex:m2");
  });
  it("gives up after MAX_EXTRA_TRIMS extra compiles and returns the last (2-page) result", async () => {
    const c = compilerReturning(2, 2, 2, 2, 2);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(MAX_EXTRA_TRIMS + 1);
    expect(out.compiled?.pageCount).toBe(2);
  });
  it("stops when nothing more can be removed", async () => {
    const c = compilerReturning(2, 2);
    const out = await fitToPage((n) => sel(n, true), render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(2);
  });
});
