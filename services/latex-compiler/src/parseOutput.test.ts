import { describe, it, expect } from "vitest";
import { parseErrorLine, parsePageCount } from "./parseOutput";

describe("parseOutput", () => {
  it("reads the page count, singular or plural", () => {
    expect(parsePageCount("...\nOutput written on resume.pdf (1 page, 34567 bytes).\n")).toBe(1);
    expect(parsePageCount("Output written on resume.pdf (2 pages, 50000 bytes).")).toBe(2);
    expect(parsePageCount("No pages of output.")).toBeNull();
  });
  it("reads the file-line-error line number", () => {
    expect(parseErrorLine("./resume.tex:42: Undefined control sequence.")).toBe(42);
    expect(parseErrorLine("! Emergency stop.")).toBeUndefined();
  });
});
