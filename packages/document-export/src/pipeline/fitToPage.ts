import type { DocumentModel } from "../model/types";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { CompiledPdf, TexCompiler } from "../render/compileTex";
import { DocumentExportError, type DocumentExportErrorClass } from "../errors";

/** Compiles after the estimate fit at most this many extra times, removing one more item each time (spec §3). */
export const MAX_EXTRA_TRIMS = 3;
/** Once one page is reached, at most this many more compiles try putting cut items back (D217). */
export const MAX_REFILL_COMPILES = 4;
/** One estimated line in points: the template's 12pt baseline plus 1pt between bullets (itemsep). */
export const LINE_PT = 13;

/** The compiler cannot take more work right now: stop refilling and keep the best page so far. */
const COMPILER_DOWN: ReadonlySet<DocumentExportErrorClass> = new Set(["compiler_unavailable", "compiler_busy", "compiler_timeout"]);

export interface FitResult { selection: TailoredSelection; tex: string; compiled: CompiledPdf | null }

export type BuildSelection = (extraRemovals: number, include?: ReadonlySet<string>) => TailoredSelection;

export interface FitOptions {
  /**
   * False for a page that must not be compiled (e.g. a character pdflatex cannot typeset). The caller checks the
   * estimate fit itself; refill trials bring back items that fit never contained, so each is checked here first.
   */
  isRenderable?: (model: DocumentModel) => boolean;
}

/**
 * Estimate fit, then (with a compiler) compile → if more than one page, remove the next item and recompile.
 * Ends at one page, after MAX_EXTRA_TRIMS, or when floors leave nothing removable (D211).
 * Then, on a one-page result whose free space the compiler reported, refill (D217): walk the cut items best-ranked
 * first; skip any whose estimated height exceeds the space left or whose page is not renderable; otherwise put it
 * back, recompile, and keep it only if the PDF is still one page. A candidate that fails to typeset is skipped; a
 * busy, timed-out or unavailable compiler ends the refill with the best one-page result; any other error is rethrown.
 * Worst case: 1 + MAX_EXTRA_TRIMS + MAX_REFILL_COMPILES compiles per export.
 */
export async function fitToPage(
  build: BuildSelection, render: (model: DocumentModel) => string, compiler: TexCompiler | null, opts: FitOptions = {}
): Promise<FitResult> {
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
    if (opts.isRenderable && !opts.isRenderable(selection.model)) continue;
    const tex = render(selection.model);
    compiles++;
    let compiled: CompiledPdf;
    try {
      compiled = await refillCompiler.compile(tex);
    } catch (err) {
      if (!(err instanceof DocumentExportError)) throw err;
      if (COMPILER_DOWN.has(err.errorClass)) break;
      continue; // compile_failed: this candidate's page did not typeset; the next one may
    }
    if (compiled.pageCount > 1) continue;
    include = trial;
    best = { selection, tex, compiled };
    if (compiled.freeSpacePt === null) break;
    free = compiled.freeSpacePt;
  }
  return best;
}
