import { hasUnsafeText } from "@ai-career/ingestion/text";
import type { ResearchFactDraft } from "../types";
import { capText } from "./text";
import { MAX_FACT_CHARS } from "./extractCitedFacts";

export interface InternalJobSummary {
  title: string;
  locationRaw: string | null;
  workMode: "remote" | "hybrid" | "onsite" | "unknown";
}

const MAX_LISTED = 5;

/** Plain code-unit sort, not localeCompare, so output never depends on the host's ICU locale. */
function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort();
}

function listWithMore(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  const more = items.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

/**
 * Deterministic facts from data the system already holds (design doc §4.3) -- no LLM. The caller
 * always includes the job the pitch is for, so a real call never yields zero facts, which is what lets
 * the company bullet cite *something* even when web research failed. Says "in your job data", not
 * "open", because the triggering job may itself be closed.
 */
export function deriveInternalFacts(companyName: string, jobs: InternalJobSummary[]): ResearchFactDraft[] {
  if (jobs.length === 0) return [];

  const sentences: string[] = [];
  const titles = uniqueSorted(jobs.map((j) => j.title));
  if (titles.length > 0) {
    sentences.push(`${companyName} has ${jobs.length} ${jobs.length === 1 ? "role" : "roles"} in your job data: ${listWithMore(titles)}.`);
  }
  const locations = uniqueSorted(jobs.map((j) => j.locationRaw ?? ""));
  if (locations.length > 0) sentences.push(`Listed locations: ${listWithMore(locations)}.`);
  const modes = uniqueSorted(jobs.map((j) => j.workMode).filter((m) => m !== "unknown"));
  if (modes.length > 0) sentences.push(`Work arrangements in these postings: ${modes.join(", ")}.`);

  return sentences
    .map((s) => capText(s, MAX_FACT_CHARS))
    .filter((s) => !hasUnsafeText(s))
    .map((factText) => ({ sourceKind: "internal", factText, sourceUrl: null, sourceTitle: null, citedText: null }));
}
