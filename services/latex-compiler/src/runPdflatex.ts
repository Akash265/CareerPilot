import { spawn } from "node:child_process";
import type { PdflatexRunner } from "./compile";

export const PDFLATEX_ARGS = ["-no-shell-escape", "-halt-on-error", "-interaction=nonstopmode", "-file-line-error", "resume.tex"];
const MAX_OUTPUT_CHARS = 1_000_000;

/** kpathsea paranoid modes: no absolute paths, no "..", no dotfiles for \input/\openout; writes only in the work dir. */
export function pdflatexEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workDir,
    TEXMFOUTPUT: workDir,
    TEXMFVAR: workDir,
    openin_any: "p",
    openout_any: "p",
    shell_escape: "f",
    max_print_line: "10000",
  };
}

export const runPdflatex: PdflatexRunner = (workDir, timeoutMs) =>
  new Promise((resolve, reject) => {
    // detached: its own process group, so the timeout kills pdflatex and anything it started.
    const child = spawn("pdflatex", PDFLATEX_ARGS, { cwd: workDir, env: pdflatexEnv(workDir), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output });
    });
  });
