import { createHttpTexCompiler, type TexCompiler } from "@ai-career/document-export";

/** The compiler the export route uses; null (→ PDF 503, .tex estimate-only) when it is not configured. */
export function texCompilerFromEnv(env: { LATEX_COMPILER_URL?: string; LATEX_COMPILER_TOKEN?: string }): TexCompiler | null {
  if (!env.LATEX_COMPILER_URL || !env.LATEX_COMPILER_TOKEN) return null;
  return createHttpTexCompiler({ url: env.LATEX_COMPILER_URL, token: env.LATEX_COMPILER_TOKEN });
}
