export type SourceKind = "greenhouse" | "lever" | "upload";
export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type SponsorshipValue = "offered" | "not_offered" | "unknown";
export type SalaryPeriod = "year" | "month" | "hour";

export interface SourceRef {
  id: string;
  kind: SourceKind;
  label: string;
  config: { slug?: string; companyName?: string };
}

/** One record as the source gave it. `payload` is validated later, per record. */
export interface RawRecord {
  externalId: string;
  payload: unknown;
}

export interface SourceAdapter {
  fetch(source: SourceRef): AsyncIterable<RawRecord>;
}

export interface SalaryResult {
  /** The matched span, kept even when it could not be parsed. */
  raw: string | null;
  /** Annualized when the period is hour/month; null when unparsed. */
  min: number | null;
  max: number | null;
  currency: string | null;
  /** The period the source stated (or "year" inferred for amounts >= 10,000). */
  period: SalaryPeriod | null;
  isParsed: boolean;
}

export interface NormalizedJob {
  externalId: string;
  url: string | null;
  companyName: string;
  companyKey: string;
  title: string;
  titleKey: string;
  seniority: string | null;
  locationRaw: string | null;
  locationKey: string;
  countryCode: string | null;
  workMode: WorkMode;
  employmentType: string | null;
  descriptionText: string;
  descriptionHash: string;
  salary: SalaryResult;
  minExperience: { years: number | null; evidence: string | null };
  sponsorship: { value: SponsorshipValue; evidence: string | null; conflict: boolean };
  postedAt: Date | null;
}

export type IngestErrorClass =
  | "consent_missing"
  | "source_disabled"
  | "invalid_slug"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "network"
  | "timeout"
  | "http_error"
  | "response_too_large"
  | "schema_mismatch"
  | "unknown";

const RETRYABLE: ReadonlySet<IngestErrorClass> = new Set([
  "rate_limited",
  "server_error",
  "network",
  "timeout",
  "unknown",
]);

/**
 * The only failure type that crosses the adapter/pipeline/worker boundary.
 * The message is the class alone -- never posting content, URLs with tokens,
 * or a wrapped exception message (CLAUDE.md §9, D29).
 */
export class IngestError extends Error {
  constructor(public readonly errorClass: IngestErrorClass) {
    super(errorClass);
    this.name = "IngestError";
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.errorClass);
  }
}

/** A single record could not be normalized. Counted and skipped, never fatal to a run. */
export class NormalizeError extends Error {
  constructor() {
    super("record could not be normalized");
    this.name = "NormalizeError";
  }
}
