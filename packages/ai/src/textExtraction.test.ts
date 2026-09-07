import { describe, it, expect, vi } from "vitest";

vi.mock("pdf-parse", () => ({ default: vi.fn().mockResolvedValue({ text: "Extracted PDF text" }) }));
vi.mock("mammoth", () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: "Extracted DOCX text" }) },
}));

import { extractText } from "./textExtraction";

describe("extractText", () => {
  it("extracts text from a PDF buffer via pdf-parse", async () => {
    expect(await extractText(Buffer.from("pdf-bytes"), "pdf")).toBe("Extracted PDF text");
  });

  it("extracts text from a DOCX buffer via mammoth", async () => {
    expect(await extractText(Buffer.from("docx-bytes"), "docx")).toBe("Extracted DOCX text");
  });

  it("reads a .tex buffer as raw UTF-8 text", async () => {
    const text = "\\documentclass{article}";
    expect(await extractText(Buffer.from(text, "utf-8"), "tex")).toBe(text);
  });
});
