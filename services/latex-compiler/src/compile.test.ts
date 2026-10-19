import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileTex, type PdflatexRunner } from "./compile";

const tmpRoot = async () => mkdtemp(path.join(os.tmpdir(), "compile-test-"));

describe("compileTex", () => {
  it("writes resume.tex, returns the PDF and page count, and removes the work dir", async () => {
    const root = await tmpRoot();
    let seenTex = "";
    const runner: PdflatexRunner = async (dir) => {
      seenTex = await readFile(path.join(dir, "resume.tex"), "utf8");
      await writeFile(path.join(dir, "resume.pdf"), "%PDF");
      return { exitCode: 0, timedOut: false, output: "Output written on resume.pdf (1 page, 4 bytes)." };
    };
    const out = await compileTex("\\documentclass{article}", runner, { tmpRoot: root });
    expect(out).toEqual({ kind: "ok", pdf: Buffer.from("%PDF"), pageCount: 1 });
    expect(seenTex).toBe("\\documentclass{article}");
    expect(await readdir(root)).toEqual([]);
  });
  it("reports failure with only the line number, and timeout", async () => {
    const root = await tmpRoot();
    const failed: PdflatexRunner = async () => ({ exitCode: 1, timedOut: false, output: "./resume.tex:7: Undefined control sequence. SECRET RESUME TEXT" });
    expect(await compileTex("x", failed, { tmpRoot: root })).toEqual({ kind: "failed", line: 7 });
    const slow: PdflatexRunner = async () => ({ exitCode: null, timedOut: true, output: "" });
    expect(await compileTex("x", slow, { tmpRoot: root })).toEqual({ kind: "timeout" });
    expect(await readdir(root)).toEqual([]);
  });
  it("treats exit 0 without an 'Output written' line as a failure", async () => {
    const root = await tmpRoot();
    expect(await compileTex("x", async () => ({ exitCode: 0, timedOut: false, output: "No pages of output." }), { tmpRoot: root })).toEqual({ kind: "failed", line: undefined });
  });
});
