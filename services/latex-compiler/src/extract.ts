import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Test mode only: the PDF's text layer, as an ATS would read it. */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "extract-"));
  try {
    await writeFile(path.join(dir, "in.pdf"), pdf);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", "in.pdf", "-"], { cwd: dir, timeout: 10_000, maxBuffer: 5_000_000 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
