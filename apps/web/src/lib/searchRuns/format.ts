import type { schema } from "@ai-career/db";

type SearchRunSource = schema.SearchRunSource;
type SearchRunSeeding = schema.SearchRunSeeding;

const REASONS: Record<string, string> = {
  rate_limited: "the site asked us to slow down; it will be retried later",
  timeout: "the site took too long to answer",
  network: "the site could not be reached",
  server_error: "the site had an error",
  not_found: "the job board no longer exists",
  interrupted: "cut off when CarrierPilot stopped", // D219
  missing_api_key: "its API key is not set in .env",
  no_active_goal: "no confirmed career goal",
  no_search_terms: "the career goal has no target roles",
  consent_missing: "permission for discovery was withdrawn",
  queue_unavailable: "the job queue is unavailable",
  schema_mismatch: "the site's response format changed",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function sourceLine(s: SearchRunSource): string {
  switch (s.state) {
    case "reused": return `${s.name} — up to date, reused`;
    case "queued": return `${s.name} — waiting`;
    case "running": return `${s.name} — fetching…`;
    case "done": return `${s.name} — ${plural(s.newCount ?? 0, "new job")}`;
    case "late": return `${s.name} — still running; results will update automatically`;
    case "failed": {
      const reason = s.reason ? REASONS[s.reason] : undefined;
      return reason ? `${s.name} — failed: ${reason}` : `${s.name} — failed${s.reason ? ` (${s.reason})` : ""}`;
    }
  }
}

const WEB: Record<string, string> = {
  skipped_recent: "Web search: skipped (searched recently for this goal).",
  skipped_disabled: "Web search: off.",
  skipped_budget: "Web search: skipped (monthly AI budget reached).",
  failed: "Web search: failed this time; it will be tried again next run.",
};

export function seedingLine(seeding: SearchRunSeeding): string {
  const parts: string[] = [];
  if (seeding.probe?.state === "ran" && seeding.probe.names > 0) {
    parts.push(`Checked ${plural(seeding.probe.names, "employer name")} (${plural(seeding.probe.boardsQueued, "possible job board")}).`);
  }
  const w = seeding.webSearch;
  if (w?.state === "ran") {
    parts.push(`Web search found ${plural(w.boardsQueued, "job board")}${w.unsupported ? ` (${plural(w.unsupported, "other career site")} ${w.unsupported === 1 ? "is" : "are"} not supported yet)` : ""}.`);
  } else if (w) {
    parts.push(WEB[w.state]);
  }
  return parts.join(" ");
}

const FAILURES: Record<string, string> = {
  stalled: "The search stopped responding. Make sure the job-ingestion worker is running (pnpm --filter @ai-career/job-ingestion start), then try again.",
  matching_failed: "Jobs were fetched, but ranking them failed. Try again, or check the matching worker.",
  matching_timeout: "Jobs were fetched, but ranking took too long. Make sure the matching worker is running, then use Find matching jobs again.",
  queue_unavailable: "The job queue is unavailable. Is Redis running?",
  no_active_goal: "Confirm a career goal first.",
  consent_missing: "Permission for discovery was withdrawn.",
  // D219: marked by the job-ingestion worker on startup -- a cut-off search is never resumed.
  interrupted: "The search was cut off when CarrierPilot stopped. Click Find matching jobs to start a new one.",
};

/** A failed search run with one of these codes already explains a failed matching run (MatchesClient's own alert). */
export const explainsMatchingFailure = (run: { status: string; errorCode: string | null } | null): boolean =>
  run?.status === "failed" && (run.errorCode === "matching_failed" || run.errorCode === "matching_timeout");

export const runFailureText =(code: string | null): string =>
  (code && FAILURES[code]) ?? "Something went wrong with this search. Try again.";
