import {
  GreenhouseJobSchema,
  LeverPostingSchema,
  UploadRowSchema,
} from "../sourceSchemas";
import { NormalizeError, type NormalizedJob, type RawRecord, type SourceRef } from "../types";
import { companyKey, descriptionHash, locationKey, titleKey } from "./keys";
import { extractMinExperience } from "./experience";
import { extractSalary } from "./salary";
import { extractSponsorship } from "./sponsorship";
import { escapedHtmlToText, htmlToText } from "./text";
import { detectWorkMode } from "./workMode";

interface Common {
  externalId: string;
  url: string | null;
  companyName: string;
  title: string;
  locationRaw: string | null;
  countryCode: string | null;
  structuredWorkMode: string | null;
  employmentType: string | null;
  descriptionText: string;
  postedAt: Date | null;
  /** A structured salary cell (upload). Prefixed with "Salary:" so the extractor sees context. */
  salaryHint?: string | null;
}

/** A Date for epoch milliseconds, or null when out of range (|t| > 8.64e15) or not finite: never an Invalid Date. */
function validDate(epochMs: number): Date | null {
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDate(value: string | null | undefined): Date | null {
  return value ? validDate(Date.parse(value)) : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Longest stored identity string. Their keys are btree-indexed, and Postgres rejects an index row over ~2.7KB. */
const MAX_IDENTITY_CHARS = 500;
/** External ids come from third-party APIs (uploads hash long ids already); one longer than this is rejected. */
const MAX_EXTERNAL_ID_CHARS = 200;

function cap(value: string): string {
  return value.slice(0, MAX_IDENTITY_CHARS).trim();
}

function assemble(input: Common): NormalizedJob {
  if (input.externalId.length > MAX_EXTERNAL_ID_CHARS) throw new NormalizeError();
  // Truncate BEFORE computing keys, so the keys are bounded too; trim after, so a cut never leaves trailing space.
  const c: Common = {
    ...input,
    companyName: cap(input.companyName),
    title: cap(input.title),
    locationRaw: input.locationRaw === null ? null : nonEmpty(cap(input.locationRaw)),
  };
  if (!c.companyName || !c.title) throw new NormalizeError();
  const companyKeyValue = companyKey(c.companyName);
  const tk = titleKey(c.title);
  // A name made only of punctuation normalizes to an empty key, which would collapse unrelated jobs together.
  if (!companyKeyValue || !tk.titleKey) throw new NormalizeError();
  const salaryText = c.salaryHint ? `Salary: ${c.salaryHint}\n${c.descriptionText}` : c.descriptionText;
  return {
    externalId: c.externalId,
    url: c.url,
    companyName: c.companyName,
    companyKey: companyKeyValue,
    title: c.title,
    titleKey: tk.titleKey,
    seniority: tk.seniority,
    locationRaw: c.locationRaw,
    locationKey: locationKey(c.locationRaw),
    countryCode: c.countryCode,
    workMode: detectWorkMode({ structured: c.structuredWorkMode, location: c.locationRaw, title: c.title }),
    employmentType: c.employmentType,
    descriptionText: c.descriptionText,
    descriptionHash: descriptionHash(c.descriptionText),
    salary: extractSalary(salaryText, { countryCode: c.countryCode }),
    minExperience: extractMinExperience(c.descriptionText),
    sponsorship: extractSponsorship(c.descriptionText),
    postedAt: c.postedAt,
  };
}

function fromGreenhouse(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = GreenhouseJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const job = parsed.data;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(job.absolute_url),
    companyName: nonEmpty(job.company_name) ?? nonEmpty(source.config.companyName) ?? source.label,
    title: job.title.trim(),
    locationRaw: nonEmpty(job.location?.name),
    countryCode: null, // Greenhouse has only free-text location
    structuredWorkMode: null,
    employmentType: null,
    descriptionText: escapedHtmlToText(job.content ?? ""),
    // first_published is the real posted date; updated_at changes on every edit and is NOT a posted date.
    postedAt: parseDate(job.first_published),
  });
}

function fromLever(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = LeverPostingSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const p = parsed.data;

  // descriptionPlain alone omits the requirement lists ("Who You Are"), where experience/visa text lives.
  const lists = (p.lists ?? []).map((l) => [l.text, l.content ? htmlToText(l.content) : null].filter(Boolean).join("\n"));
  const body =
    p.descriptionPlain ?? [p.openingPlain, p.descriptionBodyPlain].filter(Boolean).join("\n");
  const descriptionText = [body, ...lists, p.additionalPlain].filter(Boolean).join("\n\n").trim();

  const all = p.categories?.allLocations?.filter(Boolean) ?? [];
  const locationRaw = all.length > 0 ? all.join("; ") : nonEmpty(p.categories?.location);
  const country = p.country?.trim().toUpperCase();

  return assemble({
    externalId: record.externalId,
    url: nonEmpty(p.hostedUrl),
    companyName: nonEmpty(source.config.companyName) ?? source.label, // Lever postings carry no company name
    title: p.text.trim(),
    locationRaw,
    countryCode: country && /^[A-Z]{2}$/.test(country) ? country : null,
    structuredWorkMode: p.workplaceType ?? null,
    employmentType: nonEmpty(p.categories?.commitment),
    descriptionText,
    postedAt: typeof p.createdAt === "number" ? validDate(p.createdAt) : null, // epoch milliseconds
  });
}

function fromUpload(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = UploadRowSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const row = parsed.data;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(row.url),
    companyName: row.company.trim(),
    title: row.title.trim(),
    locationRaw: nonEmpty(row.location),
    countryCode: null,
    structuredWorkMode: null,
    employmentType: nonEmpty(row.employmentType),
    descriptionText: htmlToText(row.description ?? ""),
    postedAt: parseDate(row.postedAt),
    salaryHint: nonEmpty(row.salary),
  });
}

export function normalizeRecord(source: SourceRef, record: RawRecord): NormalizedJob {
  switch (source.kind) {
    case "greenhouse":
      return fromGreenhouse(source, record);
    case "lever":
      return fromLever(source, record);
    case "upload":
      return fromUpload(source, record);
    default:
      throw new NormalizeError(); // an unknown kind must never return undefined
  }
}
