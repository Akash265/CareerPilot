import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseErrorLine, parsePageCount } from "./parseOutput";

export type PdflatexRunner = (workDir: string, timeoutMs: number) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
export type CompileOutcome = { kind: "ok"; pdf: Buffer; pageCount: number } | { kind: "failed"; line?: number } | { kind: "timeout" };

export const COMPILE_TIMEOUT_MS = 20_000;

/** One pass in a fresh directory that is always removed. pdflatex's log never leaves this function -- only a line number. */
export async function compileTex(tex: string, runner: PdflatexRunner, opts: { tmpRoot?: string; timeoutMs?: number } = {}): Promise<CompileOutcome> {
  const dir = await mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), "tex-"));
  try {
    await writeFile(path.join(dir, "resume.tex"), tex, "utf8");
    const run = await runner(dir, opts.timeoutMs ?? COMPILE_TIMEOUT_MS);
    if (run.timedOut) return { kind: "timeout" };
    const pageCount = parsePageCount(run.output);
    if (run.exitCode !== 0 || pageCount === null) return { kind: "failed", line: parseErrorLine(run.output) };
    return { kind: "ok", pdf: await readFile(path.join(dir, "resume.pdf")), pageCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
