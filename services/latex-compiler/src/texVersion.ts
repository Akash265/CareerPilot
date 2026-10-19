import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** First line of `pdflatex --version`, e.g. "pdfTeX 3.141592653-2.6-1.40.24 (TeX Live 2022/Debian)" (ASCII; sent as a header). */
export async function readTexVersion(): Promise<string> {
  const { stdout } = await execFileAsync("pdflatex", ["--version"], { timeout: 10_000 });
  return stdout.split("\n")[0].trim().replace(/[^\x20-\x7e]/g, "");
}
