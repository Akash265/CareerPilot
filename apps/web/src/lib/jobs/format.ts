import type { JobListItem } from "./listJobs";

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/**
 * Missing salary is "Not stated", never zero. An unparsed span is shown as-is and flagged, so the user
 * sees exactly what the parser saw (D6). Hourly/monthly values were annualized at ingest; say so.
 */
export function formatSalary(salary: JobListItem["salary"]): string {
  if (salary.isParsed && salary.min !== null && salary.max !== null) {
    const range =
      salary.min === salary.max ? NUMBER.format(salary.min) : `${NUMBER.format(salary.min)}–${NUMBER.format(salary.max)}`;
    const note = salary.period && salary.period !== "year" ? ` (annualized from ${salary.period}ly pay)` : "";
    return `${salary.currency} ${range} / year${note}`;
  }
  if (salary.raw) return `Unclear: “${salary.raw}”`;
  return "Not stated";
}

/** The source's posted date when it gives one; otherwise say plainly that this is only when we first saw it. */
export function formatPosted(job: Pick<JobListItem, "postedAt" | "firstSeenAt">): string {
  return job.postedAt ? `Posted ${formatDate(job.postedAt)}` : `First seen ${formatDate(job.firstSeenAt)} (no posted date)`;
}

const WORK_MODE: Record<JobListItem["workMode"], string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Work mode not stated",
};
export const formatWorkMode = (mode: JobListItem["workMode"]): string => WORK_MODE[mode];

const SPONSORSHIP: Record<JobListItem["sponsorship"], string> = {
  offered: "Visa sponsorship offered",
  not_offered: "No visa sponsorship",
  unknown: "Sponsorship not stated",
};
export const formatSponsorship = (value: JobListItem["sponsorship"]): string => SPONSORSHIP[value];

const ERROR_CLASS: Record<string, string> = {
  not_found: "Board not found — check the board token",
  invalid_slug: "The board token is not valid",
  rate_limited: "Rate limited by the source — it will retry",
  server_error: "The source had a server error — it will retry",
  network: "Could not reach the source — it will retry",
  timeout: "The source timed out — it will retry",
  http_error: "The source refused the request",
  response_too_large: "The source's response was too large",
  schema_mismatch: "The source returned data in an unexpected format",
  consent_missing: "Terms-of-Service confirmation is missing",
  source_disabled: "The source is disabled",
  empty_result: "The last fetch returned no jobs, so nothing was closed",
  unknown: "Something went wrong — it will retry",
};
export const formatErrorClass = (errorClass: string): string => ERROR_CLASS[errorClass] ?? ERROR_CLASS.unknown;

/** Posting URLs come from third-party data: only ever render http(s) links (never `javascript:` and friends). */
export function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
