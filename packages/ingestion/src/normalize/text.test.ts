import { describe, it, expect } from "vitest";
import { decodeEntities, htmlToText, escapedHtmlToText } from "./text";
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

describe("escapedHtmlToText (Greenhouse content is entity-escaped HTML)", () => {
  it("decodes then strips, keeping apostrophes and list structure", () => {
    const text = escapedHtmlToText(greenhouseJobFixture.content);
    expect(text).toContain("What You'll Do");
    expect(text).toContain("- 5+ years of experience in software engineering");
    expect(text).not.toMatch(/[<>]|&lt;|&gt;/);
  });
});
