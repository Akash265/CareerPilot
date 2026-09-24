/**
 * Manual research smoke test. Runs the real research call for a few well-known companies and reports:
 * status, searches used, web fact count, citation coverage (100% by construction -- anything else is a
 * bug in extractCitedFacts), and the share of facts sourced from the company's own domain (reported,
 * not asserted -- the input to any future allowed_domains/blocked_domains tuning).
 * Costs up to COMPANY_RESEARCH_MAX_SEARCHES searches per company plus research-tier tokens.
 *
 * Usage (from packages/application-package, real ANTHROPIC_API_KEY in the repo root .env): `pnpm eval:research`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { runCompanyResearch } from "../src/research/runCompanyResearch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SmokeCompany {
  companyName: string;
  jobTitle: string;
  postingUrl: string | null;
  officialDomains: string[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);
  const companies: SmokeCompany[] = JSON.parse(readFileSync(path.join(__dirname, "research-companies.json"), "utf-8"));

  for (const c of companies) {
    const started = Date.now();
    const result = await runCompanyResearch(client, env, { companyName: c.companyName, jobTitle: c.jobTitle, postingUrl: c.postingUrl });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const withUrl = result.webFacts.filter((f) => f.sourceUrl !== null).length;
    const official = result.webFacts.filter((f) => f.sourceUrl && c.officialDomains.some((d) => hostOf(f.sourceUrl!) === d || hostOf(f.sourceUrl!).endsWith(`.${d}`))).length;

    console.log(`\n${c.companyName}: status=${result.status}${result.errorCode ? ` (${result.errorCode})` : ""} searches=${result.searchCount} facts=${result.webFacts.length} time=${seconds}s`);
    console.log(`  citation coverage: ${withUrl}/${result.webFacts.length} (must be all)`);
    console.log(`  from official domain: ${official}/${result.webFacts.length}`);
    for (const f of result.webFacts.slice(0, 3)) console.log(`  - ${f.factText} [${hostOf(f.sourceUrl ?? "")}]`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
