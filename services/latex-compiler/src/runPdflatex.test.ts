import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pdflatexEnv, runPdflatex } from "./runPdflatex";

// A fake `pdflatex` on PATH: the runner's spawn, env, output capture and process-group kill are real.
let binDir: string;
const originalPath = process.env.PATH;
beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "fake-pdflatex-"));
  await writeFile(path.join(binDir, "pdflatex"), `#!/bin/sh
if [ -f "$HOME/sleep" ]; then sleep 30 & wait; fi
echo "openin=$openin_any openout=$openout_any out=$TEXMFOUTPUT"
echo "args=$*"
echo "Output written on resume.pdf (1 page, 4 bytes)."
exit 3
`);
  await chmod(path.join(binDir, "pdflatex"), 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
});
afterAll(() => { process.env.PATH = originalPath; });

describe("runPdflatex", () => {
  it("runs with the paranoid env and safe flags, capturing output and exit code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "work-"));
    const out = await runPdflatex(dir, 5_000);
    expect(out.exitCode).toBe(3);
    expect(out.timedOut).toBe(false);
    expect(out.output).toContain(`openin=p openout=p out=${dir}`);
    expect(out.output).toContain("args=-no-shell-escape -halt-on-error -interaction=nonstopmode -file-line-error resume.tex");
  });
  it("kills the whole process group on timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "work-"));
    // HOME is the work dir (pdflatexEnv passes no other variables), so a marker file switches the fake to "hang".
    await writeFile(path.join(dir, "sleep"), "");
    const started = Date.now();
    const out = await runPdflatex(dir, 200);
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("passes no other environment through", () => {
    const env = pdflatexEnv("/tmp/w");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TEXMFOUTPUT", "TEXMFVAR", "max_print_line", "openin_any", "openout_any", "shell_escape"].sort());
  });
});
