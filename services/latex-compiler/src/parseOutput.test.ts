import { describe, it, expect } from "vitest";
import { parseErrorLine, parseFreeSpacePt, parsePageCount } from "./parseOutput";

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
  it("reads the template's free-space marker in points, rounded down", () => {
    expect(parseFreeSpacePt("x\nCAREERPILOT-FREE-SPACE=736.32199pt\nOutput written on resume.pdf (1 page, 1 bytes).\n")).toBe(736);
    expect(parseFreeSpacePt("CAREERPILOT-FREE-SPACE=0.0pt")).toBe(0);
    expect(parseFreeSpacePt("no marker here")).toBeNull();
  });

  it("only trusts a marker at the start of a line, and the last one", () => {
    // A look-alike not at line start is ignored; at line start, the template's own marker (printed last) wins.
    expect(parseFreeSpacePt("[]\\T1/lmr/m/n/10 CAREERPILOT-FREE-SPACE=9999pt\n")).toBeNull();
    expect(parseFreeSpacePt("CAREERPILOT-FREE-SPACE=500pt\nCAREERPILOT-FREE-SPACE=12.5pt\n")).toBe(12);
  });

  it("rejects negative or implausible values", () => {
    expect(parseFreeSpacePt("CAREERPILOT-FREE-SPACE=-3.0pt")).toBeNull();
    expect(parseFreeSpacePt("CAREERPILOT-FREE-SPACE=16383.99998pt")).toBeNull(); // \maxdimen: empty page
  });

  it("reads the file-line-error line number", () => {
    expect(parseErrorLine("./resume.tex:42: Undefined control sequence.")).toBe(42);
    expect(parseErrorLine("! Emergency stop.")).toBeUndefined();
  });
});
