import { describe, it, expect, vi } from "vitest";
import { fitToPage, LINE_PT, MAX_EXTRA_TRIMS, MAX_REFILL_COMPILES } from "./fitToPage";
import type { RefillCandidate, TailoredSelection } from "../model/selectTailoredResume";
import type { CompiledPdf, TexCompiler } from "../render/compileTex";
import { DocumentExportError } from "../errors";

const sel = (extra: number, exhausted = false, refill: RefillCandidate[] = []): TailoredSelection => ({
  model: { title: `m${extra}`, contactLine: null, blocks: [] }, includedCount: 10 - extra, totalCount: 10, omitted: [], exhausted, refill,
});
const render = (m: { title: string }) => `tex:${m.title}`;
const compilerReturning = (...pages: number[]): TexCompiler & { compile: ReturnType<typeof vi.fn> } => {
  const compile = vi.fn(async (tex: string): Promise<CompiledPdf> => ({ pdf: Buffer.from(tex), pageCount: pages.shift() ?? 1, texVersion: "v", freeSpacePt: null }));
  return { compile };
};

/**
 * A page with `freeLines` of room after the estimate fit. Each candidate has an estimated height (what the selection
 * reports) and a real height (what the compiled page uses); the fake compiler reports the real space left.
 */
function pageWithRoom(freeLines: number, candidates: { key: string; estimated: number; real: number }[]) {
  const build = (extra: number, include: ReadonlySet<string> = new Set()): TailoredSelection => ({
    model: { title: `m${extra}+${[...include].sort().join(",")}`, contactLine: null, blocks: [] },
    includedCount: 5 + include.size, totalCount: 5 + candidates.length, omitted: [], exhausted: false,
    refill: candidates.filter((c) => !include.has(c.key)).map((c) => ({ key: c.key, addedLines: c.estimated })),
  });
  const compile = vi.fn(async (tex: string): Promise<CompiledPdf> => {
    const included = tex.slice(tex.indexOf("+") + 1).split(",").filter(Boolean);
    const used = included.reduce((sum, key) => sum + candidates.find((c) => c.key === key)!.real, 0);
    const free = (freeLines - used) * LINE_PT;
    return { pdf: Buffer.from(tex), pageCount: free >= 0 ? 1 : 2, texVersion: "v", freeSpacePt: free >= 0 ? free : 0 };
  });
  return { build, compiler: { compile } as TexCompiler & { compile: ReturnType<typeof vi.fn> } };
}

describe("fitToPage", () => {
  it("returns the estimate fit without compiling when there is no compiler", async () => {
    const out = await fitToPage((n) => sel(n), render, null);
    expect(out).toEqual({ selection: sel(0), tex: "tex:m0", compiled: null });
  });
  it("stops at the first one-page compile", async () => {
    const c = compilerReturning(1);
    const out = await fitToPage((n) => sel(n), render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(1);
  });
  it("trims and recompiles until it fits", async () => {
    const c = compilerReturning(2, 2, 1);
    const out = await fitToPage((n) => sel(n), render, c);
    expect(c.compile).toHaveBeenCalledTimes(3);
    expect(out.tex).toBe("tex:m2");
    expect(out.compiled?.pdf.toString()).toBe("tex:m2");
  });
  it("gives up after MAX_EXTRA_TRIMS extra compiles and returns the last (2-page) result", async () => {
    const c = compilerReturning(2, 2, 2, 2, 2);
    const out = await fitToPage((n) => sel(n), render, c);
    expect(c.compile).toHaveBeenCalledTimes(MAX_EXTRA_TRIMS + 1);
    expect(out.compiled?.pageCount).toBe(2);
  });
  it("stops when nothing more can be removed", async () => {
    const c = compilerReturning(2, 2);
    const out = await fitToPage((n) => sel(n, true), render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(2);
  });

  describe("refill from the real page (D217)", () => {
    it("puts back best-ranked items that fit, skipping one too tall for the space without compiling it", async () => {
      const { build, compiler } = pageWithRoom(4, [
        { key: "a", estimated: 2, real: 2 },
        { key: "b", estimated: 6, real: 6 }, // never fits the 2 lines left after "a"
        { key: "c", estimated: 1, real: 1 },
      ]);
      const out = await fitToPage(build, render, compiler);
      expect(out.tex).toBe("tex:m0+a,c");
      expect(compiler.compile).toHaveBeenCalledTimes(3); // the fit, then "a" and "c" only
      expect(out.compiled).toMatchObject({ pageCount: 1, freeSpacePt: 1 * LINE_PT });
      expect(out.selection.includedCount).toBe(7);
    });

    it("rejects an item whose real compile spills onto a second page and keeps the previous page", async () => {
      const { build, compiler } = pageWithRoom(4, [
        { key: "a", estimated: 2, real: 5 }, // the estimate says it fits; the real page does not
        { key: "c", estimated: 1, real: 1 },
      ]);
      const out = await fitToPage(build, render, compiler);
      expect(out.tex).toBe("tex:m0+c");
      expect(out.compiled?.pageCount).toBe(1);
    });

    it(`makes at most ${MAX_REFILL_COMPILES} refill compiles`, async () => {
      const tiny = Array.from({ length: 10 }, (_, i) => ({ key: `t${i}`, estimated: 0.1, real: 0 }));
      const { build, compiler } = pageWithRoom(4, tiny);
      await fitToPage(build, render, compiler);
      expect(compiler.compile).toHaveBeenCalledTimes(1 + MAX_REFILL_COMPILES);
    });

    it("does not refill when the page's free space is unknown", async () => {
      const c = compilerReturning(1); // freeSpacePt null
      const out = await fitToPage((n) => sel(n, false, [{ key: "a", addedLines: 1 }]), render, c);
      expect(c.compile).toHaveBeenCalledTimes(1);
      expect(out.tex).toBe("tex:m0");
    });

    it("does not refill a result that is still two pages", async () => {
      const compile = vi.fn(async (tex: string): Promise<CompiledPdf> => ({ pdf: Buffer.from(tex), pageCount: 2, texVersion: "v", freeSpacePt: 300 }));
      await fitToPage((n) => sel(n, false, [{ key: "a", addedLines: 1 }]), render, { compile });
      expect(compile).toHaveBeenCalledTimes(MAX_EXTRA_TRIMS + 1);
    });

    it("keeps the best page so far when a refill compile fails", async () => {
      const { build, compiler } = pageWithRoom(4, [{ key: "a", estimated: 1, real: 1 }, { key: "c", estimated: 1, real: 1 }]);
      const real = compiler.compile.getMockImplementation()!;
      compiler.compile.mockImplementation(async (tex: string) => {
        if (tex.endsWith("a,c")) throw new DocumentExportError("compiler_busy");
        return real(tex);
      });
      const out = await fitToPage(build, render, compiler);
      expect(out.tex).toBe("tex:m0+a");
      expect(out.compiled?.pageCount).toBe(1);
    });
  });
});
