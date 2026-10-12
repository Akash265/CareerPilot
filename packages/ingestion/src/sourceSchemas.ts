import { z } from "zod";
import { hasUnsafeText } from "./normalize/text";

// Shapes verified against live boards on 2026-09-21 (see plan "Refinements").
// Schemas are deliberately lenient (`passthrough`, optional fields): they pin
// only what normalization reads, so an upstream field addition never breaks a run.

export const GreenhouseBoardResponseSchema = z.object({
  jobs: z.array(z.unknown()),
});

export const GreenhouseJobSchema = z
  .object({
    id: z.number(),
    title: z.string().trim().min(1),
    absolute_url: z.string().nullable().optional(),
    company_name: z.string().nullable().optional(),
    location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    // HTML, entity-escaped ("&lt;div&gt;...") -- see normalize/text.ts.
    content: z.string().nullable().optional(),
    first_published: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

export const LeverPostingsResponseSchema = z.array(z.unknown());

export const LeverPostingSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1),
    hostedUrl: z.string().nullable().optional(),
    // Epoch milliseconds.
    createdAt: z.number().nullable().optional(),
    // ISO-3166 alpha-2 when Lever knows it.
    country: z.string().nullable().optional(),
    // "remote" | "hybrid" | "onsite" | "unspecified"
    workplaceType: z.string().nullable().optional(),
    openingPlain: z.string().nullable().optional(),
    descriptionPlain: z.string().nullable().optional(),
    descriptionBodyPlain: z.string().nullable().optional(),
    additionalPlain: z.string().nullable().optional(),
    categories: z
      .object({
        commitment: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        allLocations: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    lists: z
      .array(z.object({ text: z.string().nullable().optional(), content: z.string().nullable().optional() }))
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * The canonical row the upload parser produces from any CSV/JSON header spelling.
 *
 * Every field also rejects an unpaired UTF-16 surrogate, which is legal JSON text (so it survives the
 * upload parser) but which the jsonb payload column rejects. storeUpload inserts in 500-row chunks with
 * no savepoint, so one such row aborts a whole chunk and escapes as a raw PostgresError -- whose .detail
 * carries the offending row's content into the server log (CLAUDE.md §9). It is rejected here instead,
 * as an ordinary invalid row, before it reaches the database.
 */
export const UploadRowSchema = z.object({
  title: z.string().trim().min(1).max(500).regex(/^[^\u0000]*$/, "Title may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Title may not contain invalid Unicode characters"),
  company: z.string().trim().min(1).max(500).regex(/^[^\u0000]*$/, "Company may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Company may not contain invalid Unicode characters"),
  location: z.string().trim().max(500).regex(/^[^\u0000]*$/, "Location may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Location may not contain invalid Unicode characters").nullable().optional(),
  // No cap: the 10 MB file cap bounds it, and it is never indexed.
  description: z.string().regex(/^[^\u0000]*$/, "Description may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Description may not contain invalid Unicode characters").nullable().optional(),
  url: z.string().trim().max(2000).regex(/^[^\u0000]*$/, "URL may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "URL may not contain invalid Unicode characters").nullable().optional(),
  postedAt: z.string().trim().max(100).regex(/^[^\u0000]*$/, "Posted date may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Posted date may not contain invalid Unicode characters").nullable().optional(),
  employmentType: z.string().trim().max(100).regex(/^[^\u0000]*$/, "Employment type may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Employment type may not contain invalid Unicode characters").nullable().optional(),
  salary: z.string().trim().max(200).regex(/^[^\u0000]*$/, "Salary may not contain null characters")
    .refine((s) => !hasUnsafeText(s), "Salary may not contain invalid Unicode characters").nullable().optional(),
});
export type UploadRow = z.infer<typeof UploadRowSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Phase 12 (D184): shapes verified against the live APIs on 2026-10-12 (fixtures in adapters/__fixtures__).
// Same rules as above: lenient, pin only what normalization reads.
const str = z.string().nullable().optional();
const bool = z.boolean().nullable().optional();

export const AshbyBoardResponseSchema = z.object({ jobs: z.array(z.unknown()) });
export const AshbyJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1),
    location: str,
    secondaryLocations: z.array(z.object({ location: str }).passthrough()).nullable().optional(),
    workplaceType: str, // "Remote" | "Hybrid" | "OnSite"
    isRemote: bool,
    isListed: bool,
    employmentType: str,
    publishedAt: str,
    jobUrl: str,
    descriptionPlain: str,
    descriptionHtml: str,
    compensation: z.object({ scrapeableCompensationSalarySummary: str, compensationTierSummary: str }).passthrough().nullable().optional(),
  })
  .passthrough();

export const WorkableAccountResponseSchema = z.object({ name: str, jobs: z.array(z.unknown()) });
export const WorkableJobSchema = z
  .object({
    shortcode: z.string().min(1),
    title: z.string().trim().min(1),
    employment_type: str,
    telecommuting: bool,
    url: str,
    published_on: str,
    city: str,
    state: str,
    country: str,
    locations: z.array(z.object({ countryCode: str }).passthrough()).nullable().optional(),
    description: str,
    /** Not in Workable's job object: the adapter copies the account name in (a raw-first exception, D184). */
    account_name: str,
  })
  .passthrough();

export const RecruiteeOffersResponseSchema = z.object({ offers: z.array(z.unknown()) });
export const RecruiteeOfferSchema = z
  .object({
    id: z.number(),
    title: z.string().trim().min(1),
    company_name: str,
    location: str,
    country_code: str,
    remote: bool,
    hybrid: bool,
    on_site: bool,
    employment_type_code: str,
    published_at: str,
    careers_url: str,
    description: str,
    requirements: str,
    salary: z.object({ min: z.union([z.string(), z.number()]).nullable().optional(), max: z.union([z.string(), z.number()]).nullable().optional(), currency: str, period: str }).passthrough().nullable().optional(),
  })
  .passthrough();

export const SmartRecruitersListSchema = z.object({ totalFound: z.number(), content: z.array(z.unknown()) });
export const SmartRecruitersListItemSchema = z.object({ id: z.string().min(1), releasedDate: str }).passthrough();
export const SmartRecruitersPostingSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    releasedDate: str,
    postingUrl: str,
    company: z.object({ name: str }).passthrough().nullable().optional(),
    location: z.object({ fullLocation: str, city: str, country: str, remote: bool, hybrid: bool }).passthrough().nullable().optional(),
    typeOfEmployment: z.object({ label: str }).passthrough().nullable().optional(),
    jobAd: z.object({ sections: z.record(z.object({ text: str }).passthrough()) }).passthrough().nullable().optional(),
  })
  .passthrough();

// Search providers (D187). Envelopes first, then one schema per job record.
export const RemotiveResponseSchema = z.object({ jobs: z.array(z.unknown()) });
export const RemotiveJobSchema = z
  .object({ id: z.number(), url: str, title: z.string().trim().min(1), company_name: z.string().trim().min(1), job_type: str,
    publication_date: str, candidate_required_location: str, salary: str, description: str })
  .passthrough();

export const RemoteOkResponseSchema = z.array(z.unknown());
export const RemoteOkJobSchema = z
  .object({ id: z.union([z.string(), z.number()]), position: z.string().trim().min(1), company: z.string().trim().min(1), location: str,
    date: str, url: str, apply_url: str, salary_min: z.number().nullable().optional(), salary_max: z.number().nullable().optional(), description: str })
  .passthrough();

export const ArbeitnowResponseSchema = z.object({ data: z.array(z.unknown()) });
export const ArbeitnowJobSchema = z
  .object({ slug: z.string().min(1), title: z.string().trim().min(1), company_name: z.string().trim().min(1), location: str, remote: bool,
    job_types: z.array(z.string()).nullable().optional(), created_at: z.number().nullable().optional(), url: str, description: str })
  .passthrough();

export const MuseResponseSchema = z.object({ results: z.array(z.unknown()) });
export const MuseJobSchema = z
  .object({ id: z.number(), name: z.string().trim().min(1), contents: str, publication_date: str,
    locations: z.array(z.object({ name: str }).passthrough()).nullable().optional(),
    refs: z.object({ landing_page: str }).passthrough().nullable().optional(),
    company: z.object({ name: z.string().trim().min(1) }).passthrough() })
  .passthrough();

export const HnSearchResponseSchema = z.object({ hits: z.array(z.object({ objectID: z.string(), title: str }).passthrough()) });
export const HnItemSchema = z.object({ id: z.number(), children: z.array(z.unknown()) }).passthrough();
/** One top-level "Who is hiring?" comment, as the adapter stores it. */
export const HnCommentSchema = z.object({ id: z.number(), text: z.string().min(1), created_at: str }).passthrough();

export const AdzunaResponseSchema = z.object({ results: z.array(z.unknown()) });
export const AdzunaJobSchema = z
  .object({ id: z.union([z.string(), z.number()]), title: z.string().trim().min(1), description: str, redirect_url: str, created: str,
    company: z.object({ display_name: str }).passthrough().nullable().optional(),
    location: z.object({ display_name: str }).passthrough().nullable().optional(),
    salary_min: z.number().nullable().optional(), salary_max: z.number().nullable().optional(),
    salary_is_predicted: z.union([z.string(), z.number()]).nullable().optional(), contract_time: str,
    /** Not in Adzuna's record: the adapter copies in the country it searched (D187), for currency and country code. */
    search_country: z.string().regex(/^[a-z]{2}$/) })
  .passthrough();

export const JoobleResponseSchema = z.object({ jobs: z.array(z.unknown()) });
export const JoobleJobSchema = z
  .object({ title: z.string().trim().min(1), company: z.string().trim().min(1), location: str, snippet: str, salary: str, type: str, link: str, updated: str })
  .passthrough();

export const UsaJobsResponseSchema = z.object({ SearchResult: z.object({ SearchResultItems: z.array(z.unknown()) }).passthrough() });
export const UsaJobsItemSchema = z
  .object({
    MatchedObjectId: z.union([z.string(), z.number()]),
    MatchedObjectDescriptor: z.object({
      PositionTitle: z.string().trim().min(1), PositionURI: str, PositionLocationDisplay: str, OrganizationName: z.string().trim().min(1),
      PublicationStartDate: str, PositionSchedule: z.array(z.object({ Name: str }).passthrough()).nullable().optional(),
      PositionRemuneration: z.array(z.object({ MinimumRange: str, MaximumRange: str, RateIntervalCode: str }).passthrough()).nullable().optional(),
      UserArea: z.object({ Details: z.object({ JobSummary: str }).passthrough().nullable().optional() }).passthrough().nullable().optional(),
    }).passthrough(),
  })
  .passthrough();
