import {
  AshbyJobSchema,
  GreenhouseJobSchema,
  LeverPostingSchema,
  RecruiteeOfferSchema,
  SmartRecruitersPostingSchema,
  UploadRowSchema,
  WorkableJobSchema,
  AdzunaJobSchema,
  ArbeitnowJobSchema,
  HnCommentSchema,
  JoobleJobSchema,
  MuseJobSchema,
  RemoteOkJobSchema,
  RemotiveJobSchema,
  UsaJobsItemSchema,
} from "../sourceSchemas";
import { hnFirstLine, parseHnFirstLine } from "../adapters/search";
import { NormalizeError, type NormalizedJob, type RawRecord, type SourceRef } from "../types";
import { companyKey, descriptionHash, locationKey, titleKey } from "./keys";
import { extractMinExperience } from "./experience";
import { extractSalary } from "./salary";
import { extractSponsorship } from "./sponsorship";
import { escapedHtmlToText, hasUnsafeText, htmlToText } from "./text";
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

const HTTP_URL_RE = /^https?:\/\//i;
/** Posting URLs are untrusted third-party data; only http(s) is safe to store (closes D113's known gap). */
function safeHttpUrl(url: string | null): string | null {
  return url && HTTP_URL_RE.test(url) ? url : null;
}

/** Longest stored identity string. Their keys are btree-indexed, and Postgres rejects an index row over ~2.7KB. */
const MAX_IDENTITY_CHARS = 500;
/**
 * External ids come from third-party APIs (uploads hash long ids already); one longer than this is rejected.
 * runIngestion checks it too, BEFORE the raw upsert: the raw table's (source_id, external_id) btree index
 * rejects an over-long value with a database error that would fail every run of the source.
 */
export const MAX_EXTERNAL_ID_CHARS = 200;

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
  const job: NormalizedJob = {
    externalId: c.externalId,
    url: safeHttpUrl(c.url),
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
  // Every field above is DERIVED text: entity decoding, the 500-char caps, htmlToText's input cap and the
  // extractors' evidence windows can each leave a NUL byte or half a surrogate pair behind, even for input
  // that was perfectly clean (an emoji landing on a slice boundary is enough). persistPosting writes this
  // whole object into a jsonb column, which rejects both outright -- in the OUTER transaction, so the throw
  // would doom the per-record transaction and fail every later run of the source. One check here covers all
  // of those producers and any added later; rejecting the record routes it into runIngestion's existing
  // normalize-failure branch, which counts it, keeps a tracked posting open, and carries on.
  if (hasUnsafeText(job)) throw new NormalizeError();
  return job;
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

const ISO2 = /^[A-Z]{2}$/;
const iso2 = (value: string | null | undefined): string | null => {
  const v = value?.trim().toUpperCase();
  return v && ISO2.test(v) ? v : null;
};
/** "remote" / "hybrid" / "onsite" from a provider's flags, in that order of precedence; null when it says nothing. */
const modeFrom = (flags: { remote?: boolean | null; hybrid?: boolean | null; onsite?: boolean | null }): string | null =>
  flags.remote ? "remote" : flags.hybrid ? "hybrid" : flags.onsite ? "onsite" : null;
const joinText = (...parts: (string | null | undefined)[]) => parts.map((p) => nonEmpty(p)).filter(Boolean).join(", ") || null;

function fromAshby(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = AshbyJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  const workplace = j.workplaceType?.toLowerCase().replace(/[^a-z]/g, "") ?? null; // "Remote" | "Hybrid" | "OnSite"
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(j.jobUrl),
    companyName: nonEmpty(source.config.companyName) ?? source.label, // Ashby postings carry no company name
    title: j.title.trim(),
    locationRaw: nonEmpty(j.location),
    countryCode: null,
    structuredWorkMode: workplace ?? (j.isRemote ? "remote" : null),
    employmentType: nonEmpty(j.employmentType),
    descriptionText: nonEmpty(j.descriptionPlain) ?? htmlToText(j.descriptionHtml ?? ""),
    postedAt: parseDate(j.publishedAt),
    salaryHint: nonEmpty(j.compensation?.scrapeableCompensationSalarySummary) ?? nonEmpty(j.compensation?.compensationTierSummary),
  });
}

function fromWorkable(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = WorkableJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(j.url),
    companyName: nonEmpty(j.account_name) ?? nonEmpty(source.config.companyName) ?? source.label,
    title: j.title.trim(),
    locationRaw: joinText(j.city, j.state, j.country),
    countryCode: iso2(j.locations?.[0]?.countryCode),
    structuredWorkMode: j.telecommuting ? "remote" : null,
    employmentType: nonEmpty(j.employment_type),
    descriptionText: htmlToText(j.description ?? ""),
    postedAt: parseDate(j.published_on),
  });
}

function fromRecruitee(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = RecruiteeOfferSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const o = parsed.data;
  const salary = o.salary && (o.salary.min ?? o.salary.max) != null
    ? [o.salary.currency, o.salary.min, o.salary.max != null ? `- ${o.salary.max}` : null, o.salary.period ? `per ${o.salary.period}` : null]
      .filter((x) => x != null && x !== "").join(" ")
    : null;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(o.careers_url),
    companyName: nonEmpty(o.company_name) ?? nonEmpty(source.config.companyName) ?? source.label,
    title: o.title.trim(),
    locationRaw: nonEmpty(o.location),
    countryCode: iso2(o.country_code),
    structuredWorkMode: modeFrom({ remote: o.remote, hybrid: o.hybrid, onsite: o.on_site }),
    employmentType: nonEmpty(o.employment_type_code),
    descriptionText: [htmlToText(o.description ?? ""), htmlToText(o.requirements ?? "")].filter(Boolean).join("\n\n"),
    postedAt: parseDate(o.published_at),
    salaryHint: salary,
  });
}

function fromSmartRecruiters(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = SmartRecruitersPostingSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const p = parsed.data;
  const sections = p.jobAd?.sections ?? {};
  const order = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"];
  const text = [...order, ...Object.keys(sections).filter((k) => !order.includes(k))]
    .map((k) => sections[k]?.text).filter(Boolean).map((html) => htmlToText(html!)).join("\n\n");
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(p.postingUrl),
    companyName: nonEmpty(p.company?.name) ?? nonEmpty(source.config.companyName) ?? source.label,
    title: p.name.trim(),
    locationRaw: nonEmpty(p.location?.fullLocation) ?? joinText(p.location?.city, p.location?.country),
    countryCode: iso2(p.location?.country),
    structuredWorkMode: modeFrom({ remote: p.location?.remote, hybrid: p.location?.hybrid }),
    employmentType: nonEmpty(p.typeOfEmployment?.label),
    descriptionText: text,
    postedAt: parseDate(p.releasedDate),
  });
}

/** A date-time with no zone designator ("2026-10-08T21:47:32") is UTC, not the server's local time. */
function parseUtc(value: string | null | undefined): Date | null {
  const v = value?.trim();
  if (!v) return null;
  return parseDate(/(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.replace(" ", "T")}Z`);
}
const ADZUNA_CURRENCY: Record<string, string> = {
  gb: "GBP", us: "USD", ca: "CAD", au: "AUD", nz: "NZD", in: "INR", sg: "SGD", za: "ZAR", br: "BRL", mx: "MXN", pl: "PLN", ch: "CHF",
  de: "EUR", fr: "EUR", nl: "EUR", at: "EUR", be: "EUR", es: "EUR", it: "EUR",
};
const range = (currency: string, min: number | null | undefined, max: number | null | undefined, period: string) =>
  min && min > 0 ? `${currency} ${min}${max && max > 0 ? ` - ${currency} ${max}` : ""} per ${period}` : null;

function fromRemotive(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = RemotiveJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.url), companyName: j.company_name.trim(), title: j.title.trim(),
    locationRaw: nonEmpty(j.candidate_required_location), countryCode: null, structuredWorkMode: "remote",
    employmentType: nonEmpty(j.job_type), descriptionText: htmlToText(j.description ?? ""), postedAt: parseUtc(j.publication_date),
    salaryHint: nonEmpty(j.salary),
  });
}

function fromRemoteOk(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = RemoteOkJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.url) ?? nonEmpty(j.apply_url), companyName: j.company.trim(), title: j.position.trim(),
    locationRaw: nonEmpty(j.location), countryCode: null, structuredWorkMode: "remote", employmentType: null,
    descriptionText: htmlToText(j.description ?? ""), postedAt: parseUtc(j.date),
    salaryHint: range("USD", j.salary_min, j.salary_max, "year"),
  });
}

function fromArbeitnow(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = ArbeitnowJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.url), companyName: j.company_name.trim(), title: j.title.trim(),
    locationRaw: nonEmpty(j.location), countryCode: null, structuredWorkMode: j.remote ? "remote" : null,
    employmentType: nonEmpty(j.job_types?.join(", ")), descriptionText: htmlToText(j.description ?? ""),
    postedAt: typeof j.created_at === "number" ? validDate(j.created_at * 1000) : null, // epoch seconds
  });
}

function fromMuse(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = MuseJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  const places = (j.locations ?? []).map((l) => nonEmpty(l.name)).filter((n): n is string => n !== null);
  const remote = places.some((p) => /flexible \/ remote/i.test(p));
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.refs?.landing_page), companyName: j.company.name.trim(), title: j.name.trim(),
    locationRaw: places.filter((p) => !/flexible \/ remote/i.test(p)).join("; ") || (remote ? "Remote" : null), countryCode: null,
    structuredWorkMode: remote ? "remote" : null, employmentType: null, descriptionText: htmlToText(j.contents ?? ""),
    postedAt: parseUtc(j.publication_date),
  });
}

function fromHn(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = HnCommentSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const c = parsed.data;
  const head = parseHnFirstLine(hnFirstLine(c.text));
  return assemble({
    externalId: record.externalId, url: `https://news.ycombinator.com/item?id=${c.id}`, companyName: head.company, title: head.title,
    locationRaw: head.location, countryCode: null, structuredWorkMode: head.workMode, employmentType: null,
    descriptionText: htmlToText(c.text), postedAt: parseUtc(c.created_at),
  });
}

function fromAdzuna(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = AdzunaJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  const company = nonEmpty(j.company?.display_name);
  if (!company) throw new NormalizeError();
  const currency = ADZUNA_CURRENCY[j.search_country];
  // Adzuna fills in an estimate when the advert has no salary; only a stated salary is kept.
  const stated = String(j.salary_is_predicted ?? "0") === "0";
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.redirect_url), companyName: company, title: htmlToText(j.title),
    locationRaw: nonEmpty(j.location?.display_name), countryCode: iso2(j.search_country), structuredWorkMode: null,
    employmentType: nonEmpty(j.contract_time), descriptionText: htmlToText(j.description ?? ""), postedAt: parseUtc(j.created),
    salaryHint: stated && currency ? range(currency, j.salary_min, j.salary_max, "year") : null,
  });
}

function fromJooble(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = JoobleJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const j = parsed.data;
  return assemble({
    externalId: record.externalId, url: nonEmpty(j.link), companyName: j.company.trim(), title: htmlToText(j.title),
    locationRaw: nonEmpty(j.location), countryCode: null, structuredWorkMode: null, employmentType: nonEmpty(j.type),
    descriptionText: htmlToText(j.snippet ?? ""), postedAt: parseUtc(j.updated), salaryHint: nonEmpty(j.salary),
  });
}

function fromUsaJobs(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = UsaJobsItemSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const d = parsed.data.MatchedObjectDescriptor;
  const pay = d.PositionRemuneration?.[0];
  const period = pay?.RateIntervalCode === "PH" ? "hour" : pay?.RateIntervalCode === "PA" ? "year" : null;
  return assemble({
    externalId: record.externalId, url: nonEmpty(d.PositionURI), companyName: d.OrganizationName.trim(), title: d.PositionTitle.trim(),
    // USAJobs also lists overseas posts; its CountryCode is a country name ("United States").
    locationRaw: nonEmpty(d.PositionLocationDisplay),
    countryCode: (d.PositionLocation ?? []).every((l) => l.CountryCode === "United States") && (d.PositionLocation ?? []).length > 0 ? "US" : null,
    structuredWorkMode: null,
    employmentType: nonEmpty(d.PositionSchedule?.[0]?.Name), descriptionText: htmlToText(d.UserArea?.Details?.JobSummary ?? ""),
    postedAt: parseUtc(d.PublicationStartDate),
    salaryHint: period ? range("USD", Number(pay?.MinimumRange), Number(pay?.MaximumRange), period) : null,
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
    case "ashby":
      return fromAshby(source, record);
    case "workable":
      return fromWorkable(source, record);
    case "recruitee":
      return fromRecruitee(source, record);
    case "smartrecruiters":
      return fromSmartRecruiters(source, record);
    case "remotive":
      return fromRemotive(source, record);
    case "remoteok":
      return fromRemoteOk(source, record);
    case "arbeitnow":
      return fromArbeitnow(source, record);
    case "themuse":
      return fromMuse(source, record);
    case "hn_hiring":
      return fromHn(source, record);
    case "adzuna":
      return fromAdzuna(source, record);
    case "jooble":
      return fromJooble(source, record);
    case "usajobs":
      return fromUsaJobs(source, record);
    default:
      throw new NormalizeError(); // an unknown kind must never return undefined
  }
}
