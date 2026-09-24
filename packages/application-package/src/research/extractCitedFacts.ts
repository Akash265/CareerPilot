import type Anthropic from "@anthropic-ai/sdk";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { ResearchFactDraft } from "../types";
import { capText, normalizeHttpUrl } from "./text";

export const MAX_WEB_FACTS = 15;
export const MAX_FACT_CHARS = 500;
const MAX_TITLE_CHARS = 300;

/**
 * The grounding mechanism for web research (design doc §4.2): a web fact exists ONLY if the API
 * attached a web_search_result_location citation to the text block -- the citation is produced by the
 * API from a real search result, not self-reported by the model. Uncited text is discarded here in
 * code; the research prompt asking the model to cite is a request, never the guarantee.
 */
export function extractCitedFacts(content: Anthropic.ContentBlock[]): ResearchFactDraft[] {
  const facts: ResearchFactDraft[] = [];
  const seen = new Set<string>();

  for (const block of content) {
    if (facts.length >= MAX_WEB_FACTS) break;
    if (block.type !== "text" || !block.citations || block.citations.length === 0) continue;

    const citation = block.citations.find(
      (c): c is Anthropic.CitationsWebSearchResultLocation => c.type === "web_search_result_location"
    );
    if (!citation) continue;
    const sourceUrl = normalizeHttpUrl(citation.url);
    if (!sourceUrl) continue;

    const factText = capText(block.text.trim(), MAX_FACT_CHARS);
    if (factText.length === 0 || seen.has(factText)) continue;

    // Citation fields are API response data (typed, but not guaranteed present -- a malformed or
    // future-shaped citation must degrade to null, never throw: a research failure must never fail
    // the whole pitch.
    const fact: ResearchFactDraft = {
      sourceKind: "web",
      factText,
      sourceUrl,
      sourceTitle: typeof citation.title === "string" ? capText(citation.title, MAX_TITLE_CHARS) : null,
      citedText: typeof citation.cited_text === "string" ? capText(citation.cited_text, MAX_FACT_CHARS) : null,
    };
    // D44 choke point: one check on the assembled record covers every field (NUL / lone surrogate).
    if (hasUnsafeText(fact)) continue;

    seen.add(factText);
    facts.push(fact);
  }
  return facts;
}
