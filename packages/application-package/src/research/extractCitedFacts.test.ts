import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { extractCitedFacts, MAX_FACT_CHARS, MAX_WEB_FACTS } from "./extractCitedFacts";

function citation(url: string, title: string | null = "Acme — About", citedText = "Acme builds rockets.") {
  return { type: "web_search_result_location", url, title, cited_text: citedText, encrypted_index: "e" };
}
function cited(text: string, url = "https://acme.example/about", extra: Partial<Record<string, unknown>> = {}) {
  return { type: "text", text, citations: [citation(url)], ...extra };
}
const blocks = (...b: unknown[]) => b as unknown as Anthropic.ContentBlock[];

describe("extractCitedFacts", () => {
  it("turns a cited text block into a web fact with its source", () => {
    const facts = extractCitedFacts(blocks(cited("  Acme builds reusable rockets.  ")));
    expect(facts).toEqual([
      {
        sourceKind: "web",
        factText: "Acme builds reusable rockets.",
        sourceUrl: "https://acme.example/about",
        sourceTitle: "Acme — About",
        citedText: "Acme builds rockets.",
      },
    ]);
  });

  it("discards text blocks without citations (null or empty)", () => {
    const facts = extractCitedFacts(
      blocks(
        { type: "text", text: "Acme is the best company in the world.", citations: null },
        { type: "text", text: "Uncited claim.", citations: [] },
        cited("Acme was founded in 2010.")
      )
    );
    expect(facts.map((f) => f.factText)).toEqual(["Acme was founded in 2010."]);
  });

  it("ignores non-text blocks such as server_tool_use and web_search_tool_result", () => {
    const facts = extractCitedFacts(
      blocks(
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Acme" } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
        cited("Acme is headquartered in Berlin.")
      )
    );
    expect(facts).toHaveLength(1);
  });

  it("uses the first web_search_result_location citation, skipping other citation types", () => {
    const facts = extractCitedFacts(
      blocks({
        type: "text",
        text: "Acme ships weekly.",
        citations: [{ type: "char_location", cited_text: "x", document_index: 0, document_title: null, start_char_index: 0, end_char_index: 1 }, citation("https://news.example/acme", "News")],
      })
    );
    expect(facts[0].sourceUrl).toBe("https://news.example/acme");
    expect(facts[0].sourceTitle).toBe("News");
  });

  it("drops a block whose only citations are not web_search_result_location", () => {
    const facts = extractCitedFacts(
      blocks({ type: "text", text: "Doc claim.", citations: [{ type: "char_location", cited_text: "x", document_index: 0, document_title: null, start_char_index: 0, end_char_index: 1 }] })
    );
    expect(facts).toEqual([]);
  });

  it("drops facts whose source URL is not http/https", () => {
    const facts = extractCitedFacts(
      blocks(cited("Bad one.", "javascript:alert(1)"), cited("Bad two.", "data:text/html,x"), cited("Bad three.", "not a url"), cited("Good.", "https://ok.example"))
    );
    expect(facts.map((f) => f.factText)).toEqual(["Good."]);
  });

  it("drops facts containing a NUL byte or a lone surrogate anywhere (text, title or cited text)", () => {
    const facts = extractCitedFacts(
      blocks(
        cited("Has \u0000 NUL."),
        cited("Lone \uD800 surrogate."),
        { type: "text", text: "Bad title.", citations: [citation("https://ok.example", "T\uDC00")] },
        cited("Clean.")
      )
    );
    expect(facts.map((f) => f.factText)).toEqual(["Clean."]);
  });

  it("drops blocks that are empty after trimming, and exact-duplicate fact text", () => {
    const facts = extractCitedFacts(blocks(cited("   "), cited("Same."), cited("Same.", "https://other.example")));
    expect(facts.map((f) => f.factText)).toEqual(["Same."]);
  });

  it(`keeps at most ${MAX_WEB_FACTS} facts and caps each at ${MAX_FACT_CHARS} chars without splitting an emoji`, () => {
    const many = Array.from({ length: MAX_WEB_FACTS + 5 }, (_, i) => cited(`Fact ${i}.`));
    expect(extractCitedFacts(blocks(...many))).toHaveLength(MAX_WEB_FACTS);

    const long = "a".repeat(MAX_FACT_CHARS - 1) + "😀" + "tail";
    const [fact] = extractCitedFacts(blocks(cited(long)));
    expect(fact.factText).toBe("a".repeat(MAX_FACT_CHARS - 1));
  });

  it("keeps a null citation title as null", () => {
    const [fact] = extractCitedFacts(blocks({ type: "text", text: "No title.", citations: [citation("https://ok.example", null)] }));
    expect(fact.sourceTitle).toBeNull();
  });
});
