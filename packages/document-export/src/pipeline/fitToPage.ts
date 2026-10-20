import type { DocumentModel } from "../model/types";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { CompiledPdf, TexCompiler } from "../render/compileTex";

/** Compiles after the estimate fit at most this many extra times, removing one more item each time (spec §3). */
export const MAX_EXTRA_TRIMS = 3;

export interface FitResult { selection: TailoredSelection; tex: string; compiled: CompiledPdf | null }

/**
 * Estimate fit, then (with a compiler) compile → if more than one page, remove the next item and recompile.
 * Ends at one page, after MAX_EXTRA_TRIMS, or when floors leave nothing removable (D211).
 */
export async function fitToPage(
  build: (extraRemovals: number) => TailoredSelection,
  render: (model: DocumentModel) => string,
  compiler: TexCompiler | null
): Promise<FitResult> {
  for (let extra = 0; ; extra++) {
    const selection = build(extra);
    const tex = render(selection.model);
    if (compiler === null) return { selection, tex, compiled: null };
    const compiled = await compiler.compile(tex);
    if (compiled.pageCount <= 1 || extra >= MAX_EXTRA_TRIMS || selection.exhausted) return { selection, tex, compiled };
  }
}
