import { describe, it, expect } from "vitest";
import { escapeTex, findUnsupportedCharacter, isSupportedChar, SUPPORTED_SAMPLE } from "./escapeTex";
import type { DocumentModel } from "../../model/types";

describe("escapeTex", () => {
  it.each([
    ["\\", "\\textbackslash{}"],
    ["{", "\\{"],
    ["}", "\\}"],
    ["$", "\\$"],
    ["&", "\\&"],
    ["#", "\\#"],
    ["_", "\\_"],
    ["%", "\\%"],
    ["^", "\\textasciicircum{}"],
    ["~", "\\textasciitilde{}"],
    ["[", "{[}"],
    ["]", "{]}"],
    ["`", "\\textasciigrave{}"],
    ["\"", "\\textquotedbl{}"],
    ["|", "\\textbar{}"],
    ["–", "\\textendash{}"],
    ["—", "\\textemdash{}"],
    ["‘", "\\textquoteleft{}"],
    ["’", "\\textquoteright{}"],
    ["“", "\\textquotedblleft{}"],
    ["”", "\\textquotedblright{}"],
    ["•", "\\textbullet{}"],
    ["…", "\\ldots{}"],
    ["€", "\\texteuro{}"],
    ["£", "\\pounds{}"],
    ["−", "-"],
    ["→", "\\textrightarrow{}"],
    ["\u00a0", "~"],
  ])("escapes %j", (input, expected) => {
    expect(escapeTex(input)).toBe(expected);
  });

  it("neutralises command-looking text", () => {
    expect(escapeTex("\\input{/etc/passwd}")).toBe("\\textbackslash{}input\\{/etc/passwd\\}");
    expect(escapeTex("\\write18{id}")).toBe("\\textbackslash{}write18\\{id\\}");
  });

  it("breaks ligatures of repeated - ' , < > so they render literally", () => {
    expect(escapeTex("a--b")).toBe("a-{}-b");
    expect(escapeTex("it''s")).toBe("it'{}'s");
    expect(escapeTex(",,x")).toBe(",{},x");
    expect(escapeTex("<<>>")).toBe("<{}<>{}>");
  });

  it("breaks the en-dash ligature when U+2212 maps to a hyphen next to another hyphen", () => {
    expect(escapeTex("a\u2212\u2212b")).toBe("a-{}-b");
    expect(escapeTex("a-\u2212b")).toBe("a-{}-b");
    expect(escapeTex("a\u2212-b")).toBe("a-{}-b");
  });

  it("turns tabs/newlines into spaces and strips control and zero-width characters", () => {
    expect(escapeTex("a\tb\nc\r\nd")).toBe("a b c d");
    expect(escapeTex("a\u0007b\u200bc\u00add\ufeff")).toBe("abcd");
  });

  it("keeps Latin letters as UTF-8", () => {
    expect(escapeTex("Müller Łukasz Ørsted ß")).toBe("Müller Łukasz Ørsted ß");
  });

  it("never leaves a raw TeX special character in its output (randomised)", () => {
    const alphabet = "\\{}$&#_%^~[]`\"|abc -',<>\n\t";
    for (let n = 0; n < 500; n++) {
      let s = "";
      for (let i = 0; i < 20; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
      const out = escapeTex(s);
      // Every backslash in the output starts one of our own macros; every { } is either escaped or one of our groups.
      const withoutOurs = out
        .replace(/\\(textbackslash|textasciicircum|textasciitilde|textasciigrave|textquotedbl|textbar)\{\}/g, "")
        .replace(/\\[{}$&#_%]/g, "")
        .replace(/\{\[\}|\{\]\}/g, "")
        .replace(/\{\}/g, "");
      expect(withoutOurs).not.toMatch(/[\\{}$&#_%^~]/);
    }
  });
});

describe("isSupportedChar", () => {
  it("accepts ASCII, Latin-1, Latin Extended-A and mapped characters", () => {
    for (const ch of ["a", "~", "é", "ß", "ÿ", "Ł", "ő", "€", "–", "•"]) expect(isSupportedChar(ch)).toBe(true);
  });
  it("rejects characters pdflatex+T1 cannot typeset", () => {
    for (const ch of ["Ħ", "ŉ", "ſ", "Ŀ", "中", "😀", "Ω", "✓"]) expect(isSupportedChar(ch)).toBe(false);
  });
  it("SUPPORTED_SAMPLE contains only supported characters and includes the mapped ones", () => {
    expect([...SUPPORTED_SAMPLE].every(isSupportedChar)).toBe(true);
    expect(SUPPORTED_SAMPLE).toContain("€");
    expect(SUPPORTED_SAMPLE).toContain("Ł");
  });
});

describe("findUnsupportedCharacter", () => {
  const model = (blocks: DocumentModel["blocks"], title = "Jane Doe", contactLine: string | null = "jane@example.com"): DocumentModel =>
    ({ title, contactLine, blocks });

  it("returns null for a clean model", () => {
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Experience" }, { type: "bullets", items: ["Built ü"] }]))).toBeNull();
  });
  it("locates the name and contact line", () => {
    expect(findUnsupportedCharacter(model([], "Jane 😀"))).toBe("Name");
    expect(findUnsupportedCharacter(model([], "Jane", "中"))).toBe("Contact details");
  });
  it("locates entries, entry bullets and plain items without echoing text", () => {
    const blocks: DocumentModel["blocks"] = [
      { type: "heading", text: "Experience" },
      { type: "entry", title: "Engineer", subtitle: "Globex", meta: null },
      { type: "bullets", items: ["ok"] },
      { type: "entry", title: "Lead", subtitle: null, meta: null },
      { type: "bullets", items: ["ok", "ok", "bad ✓"] },
    ];
    expect(findUnsupportedCharacter(model(blocks))).toBe("Experience, entry 2, bullet 3");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Achievements" }, { type: "bullets", items: ["Ω"] }]))).toBe("Achievements, item 1");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Skills" }, { type: "paragraph", text: "Go, 中文" }]))).toBe("Skills");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Projects" }, { type: "entry", title: "Ħ", subtitle: null, meta: null }]))).toBe("Projects, entry 1");
  });
});
