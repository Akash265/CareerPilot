import { describe, it, expect } from "vitest";
import { decodeEntities, hasUnsafeText, htmlToText, escapedHtmlToText, MAX_HTML_CHARS } from "./text";
import { greenhouseJobFixture } from "../fixtures";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &nbsp;f")).toBe('a & b <c> "d" \'e\' A  f');
    expect(decodeEntities("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
  });
});

describe("htmlToText", () => {
  it("turns block tags into newlines and list items into dashes", () => {
    expect(htmlToText("<p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>")).toBe("One\nTwo\n\n- a\n- b");
  });

  it("drops script and style content entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><script>alert(1)</script><p>Hi</p>")).toBe("Hi");
  });

  it("collapses runs of spaces, and runs of blank lines down to one paragraph break", () => {
    expect(htmlToText("<p>a   b</p>\n\n\n\n<p>c</p>")).toBe("a b\n\nc");
  });
});

describe("htmlToText on hostile input (untrusted posting content)", () => {
  function elapsedMs(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }

  it("does not go quadratic on a long run of '<' with no '>'", () => {
    const input = "<".repeat(200_000);
    let out = "";
    expect(elapsedMs(() => (out = htmlToText(input)))).toBeLessThan(1000);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not go quadratic on many unclosed <script openers", () => {
    const input = "<script".repeat(200_000);
    let out = "x";
    expect(elapsedMs(() => (out = htmlToText(input)))).toBeLessThan(1000);
    expect(out).toBe("");
  });

  it("does not go quadratic on many unclosed <br or <li openers", () => {
    for (const opener of ["<br", "<li", "</p", "< "]) {
      const input = opener.repeat(200_000);
      expect(elapsedMs(() => htmlToText(input))).toBeLessThan(1000);
    }
  });

  it("does not go quadratic on many closed <script>...</script> pairs", () => {
    const input = "<script>a</script>".repeat(50_000) + "<p>Hi</p>";
    let out = "";
    expect(elapsedMs(() => (out = htmlToText(input)))).toBeLessThan(1000);
    expect(out).toBe("Hi");
  });

  it("drops an unclosed script through to the end of input but keeps the text before it", () => {
    expect(htmlToText("Hi<script>alert(1)")).toBe("Hi");
  });

  it("still drops well-formed style and script blocks (case-insensitively) and keeps the rest", () => {
    expect(htmlToText("<style>p{color:red}</style><script>alert(1)</script><p>Hi</p>")).toBe("Hi");
    expect(htmlToText("<STYLE>x</STYLE><p>a</p><Script type='x'>y</SCRIPT><p>b</p>")).toBe("a\nb");
  });

  it("does not treat lookalike tags such as <scripts> or <styled> as script/style blocks", () => {
    expect(htmlToText("<scripts>keep</scripts><styled>me</styled>")).toBe("keep me");
    expect(htmlToText("<scripts>keep</scripts><script>x</script>me")).toBe("keep me");
  });

  it("caps the amount of input it will process", () => {
    const input = "a".repeat(MAX_HTML_CHARS + 500);
    expect(htmlToText(input).length).toBe(MAX_HTML_CHARS);
  });

  it("treats a non-breaking space as ordinary whitespace", () => {
    expect(htmlToText("<p>a\u00a0\u00a0b</p>")).toBe("a b");
  });
});

// jsonb rejects a NUL byte and a lone (unpaired) UTF-16 surrogate outright, where a text column
// silently substitutes U+FFFD. This is the one predicate the repo uses for "safe to store as jsonb".
describe("hasUnsafeText", () => {
  it("is true for a NUL byte and for either half of a surrogate pair on its own", () => {
    expect(hasUnsafeText("a\u0000b")).toBe(true);
    expect(hasUnsafeText("\ud800")).toBe(true); // lone high surrogate
    expect(hasUnsafeText("\udc00")).toBe(true); // lone low surrogate
    expect(hasUnsafeText("lead \udbff trail")).toBe(true);
  });

  it("is false for ordinary text and for a real emoji (a VALID surrogate pair)", () => {
    expect(hasUnsafeText("")).toBe(false);
    expect(hasUnsafeText("Senior Data Engineer — Berlin")).toBe(false);
    expect(hasUnsafeText("😀")).toBe(false);
    expect(hasUnsafeText("a 😀 b 👍🏽 c")).toBe(false);
  });

  it("is false for non-strings, including Dates, null and numbers", () => {
    expect(hasUnsafeText(null)).toBe(false);
    expect(hasUnsafeText(undefined)).toBe(false);
    expect(hasUnsafeText(42)).toBe(false);
    expect(hasUnsafeText(new Date("2026-08-01"))).toBe(false);
  });

  it("recurses through nested objects and arrays", () => {
    expect(hasUnsafeText({ a: { b: ["ok", "\ud800"] } })).toBe(true);
    expect(hasUnsafeText({ a: { b: ["ok", "fine"] }, c: [1, null, new Date(0)] })).toBe(false);
    expect(hasUnsafeText([{ x: "ok" }, { y: { z: "bad\u0000" } }])).toBe(true);
  });
});

describe("escapedHtmlToText (Greenhouse content is entity-escaped HTML)", () => {
  it("decodes then strips, keeping apostrophes and list structure", () => {
    const text = escapedHtmlToText(greenhouseJobFixture.content);
    expect(text).toContain("What You'll Do");
    expect(text).toContain("- 5+ years of experience in software engineering");
    expect(text).not.toMatch(/[<>]|&lt;|&gt;/);
  });

  it("decodes double-escaped content exactly twice, with tags stripped only between the passes", () => {
    // "&amp;lt;b&amp;gt;" -> "&lt;b&gt;" (pass 1) -> "<b>" (pass 2 decode, after its strip): literal text, never HTML.
    expect(escapedHtmlToText("&amp;lt;b&amp;gt;")).toBe("<b>");
  });
});
