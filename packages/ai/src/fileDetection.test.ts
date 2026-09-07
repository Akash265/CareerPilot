import { describe, it, expect, vi } from "vitest";

vi.mock("file-type", () => ({ fileTypeFromBuffer: vi.fn() }));

import { fileTypeFromBuffer } from "file-type";
import { detectResumeFileType, UnsupportedFileTypeError } from "./fileDetection";

describe("detectResumeFileType", () => {
  it("maps a detected PDF mime type to 'pdf'", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: "application/pdf", ext: "pdf" } as any);
    expect(await detectResumeFileType(Buffer.from("x"), "resume.pdf")).toBe("pdf");
  });

  it("maps a detected DOCX mime type to 'docx'", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
    } as any);
    expect(await detectResumeFileType(Buffer.from("x"), "resume.docx")).toBe("docx");
  });

  it("accepts a .tex file with no binary signature as valid UTF-8 text", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const buf = Buffer.from("\\documentclass{article}\\begin{document}Hi\\end{document}", "utf-8");
    expect(await detectResumeFileType(buf, "resume.tex")).toBe("tex");
  });

  it("rejects a .tex-named file containing binary data", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await expect(detectResumeFileType(binaryBuffer, "resume.tex")).rejects.toThrow(
      UnsupportedFileTypeError
    );
  });

  it("rejects an undetectable, non-.tex file", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    await expect(detectResumeFileType(Buffer.from("random"), "resume.exe")).rejects.toThrow(
      UnsupportedFileTypeError
    );
  });
});
