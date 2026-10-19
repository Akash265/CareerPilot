import { describe, it, expect } from "vitest";
import { parseErrorLine, parsePageCount } from "./parseOutput";

describe("parseOutput", () => {
  it("reads the page count, singular or plural", () => {
    expect(parsePageCount("...\nOutput written on resume.pdf (1 page, 34567 bytes).\n")).toBe(1);
    expect(parsePageCount("Output written on resume.pdf (2 pages, 50000 bytes).")).toBe(2);
    expect(parsePageCount("No pages of output.")).toBeNull();
  });

  it("uses the last match so box-warning text cannot spoof the count", () => {
    const out = "Overfull \\hbox in paragraph at lines 3--4\n[]\\T1/cmr/m/n/10 Output written on x.pdf (9 pages, 1 bytes)\nOutput written on resume.pdf (1 page, 34567 bytes).\n";
    expect(parsePageCount(out)).toBe(1);
  });
  it("reads the file-line-error line number", () => {
    expect(parseErrorLine("./resume.tex:42: Undefined control sequence.")).toBe(42);
    expect(parseErrorLine("! Emergency stop.")).toBeUndefined();
  });
});
