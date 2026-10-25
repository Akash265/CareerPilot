import type { DocumentModel } from "../model/types";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { CompiledPdf, TexCompiler } from "../render/compileTex";

/** Compiles after the estimate fit at most this many extra times, removing one more item each time (spec §3). */
export const MAX_EXTRA_TRIMS = 3;
/** Once one page is reached, at most this many more compiles try putting cut items back (D217). */
export const MAX_REFILL_COMPILES = 4;
/** One estimated line in points: the template's 10pt text sits on a 12pt baseline. */
export const LINE_PT = 12;

export interface FitResult { selection: TailoredSelection; tex: string; compiled: CompiledPdf | null }

export type BuildSelection = (extraRemovals: number, include?: ReadonlySet<string>) => TailoredSelection;

/**
 * Estimate fit, then (with a compiler) compile → if more than one page, remove the next item and recompile.
 * Ends at one page, after MAX_EXTRA_TRIMS, or when floors leave nothing removable (D211).
 * Then, on a one-page result whose free space the compiler reported, refill (D217): walk the cut items best-ranked
 * first; skip any whose estimated height exceeds the space left; otherwise put it back, recompile, and keep it only
 * if the PDF is still one page. A refill compile that fails ends the refill; the best one-page result stands.
 */
export async function fitToPage(build: BuildSelection, render: (model: DocumentModel) => string, compiler: TexCompiler | null): Promise<FitResult> {
  let extra = 0;
  let best: FitResult;
  for (; ; extra++) {
    const selection = build(extra);
    const tex = render(selection.model);
    if (compiler === null) return { selection, tex, compiled: null };
    const compiled = await compiler.compile(tex);
    if (compiled.pageCount <= 1 || extra >= MAX_EXTRA_TRIMS || selection.exhausted) {
      best = { selection, tex, compiled };
      break;
    }
  }
  if (best.compiled === null || best.compiled.pageCount > 1 || best.compiled.freeSpacePt === null) return best;

  const refillCompiler = compiler as TexCompiler; // non-null: best.compiled exists only when a compiler ran
  let free = best.compiled.freeSpacePt;
  let include = new Set<string>();
  let compiles = 0;
  for (const candidate of best.selection.refill) {
    if (compiles >= MAX_REFILL_COMPILES) break;
    if (candidate.addedLines * LINE_PT > free) continue;
    const trial = new Set(include).add(candidate.key);
    const selection = build(extra, trial);
    const tex = render(selection.model);
    compiles++;
    let compiled: CompiledPdf;
    try {
      compiled = await refillCompiler.compile(tex);
    } catch {
      break;
    }
    if (compiled.pageCount > 1) continue;
    include = trial;
    best = { selection, tex, compiled };
    if (compiled.freeSpacePt === null) break;
    free = compiled.freeSpacePt;
  }
  return best;
}
