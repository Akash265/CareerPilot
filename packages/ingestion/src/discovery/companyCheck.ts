import { companyKey } from "../normalize/keys";

export type BoardFoundVia = "posting_link" | "pasted" | "name_probe" | "web_search";
export type CompanyCheck = "ok" | "company_mismatch" | "company_unverified";

const startsWithTokens = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);

/**
 * Phase 13a: a board guessed from an employer name (name_probe) or read from a web-search result (web_search) must
 * belong to that employer -- `apex` on Lever is not necessarily the Apex the user's results named. Boards linked
 * from postings or pasted by the user are taken as given (D186).
 * Several platforms' records carry no company name (normalization then falls back to the slug): that is "unknown".
 * An unknown probe is accepted only if the first job's description names the company; an unknown web-search board
 * is accepted, because the search result that linked it is the evidence.
 */
export function checkCompany(input: {
  foundVia: BoardFoundVia;
  expectedCompany: string | null;
  slug: string;
  companyName: string | null;
  descriptionText: string | null;
}): CompanyCheck {
  if (input.foundVia === "posting_link" || input.foundVia === "pasted" || !input.expectedCompany) return "ok";
  const expected = companyKey(input.expectedCompany);
  if (!expected) return "ok";
  const unknown = !input.companyName || input.companyName.toLowerCase() === input.slug.toLowerCase();
  if (!unknown) return startsWithTokens(companyKey(input.companyName!), expected) ? "ok" : "company_mismatch";
  if (input.foundVia === "web_search") return "ok";
  const text = ` ${companyKey(input.descriptionText ?? "")} `;
  return text.includes(` ${expected} `) ? "ok" : "company_unverified";
}
