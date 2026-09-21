import { and, count, desc, eq, exists, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";

const { jobs, jobPostings } = schema;

export const PAGE_SIZE = 25;

export const ListJobsQuerySchema = z.object({
  // A NUL character is valid in a URL (%00) but Postgres rejects it in text (22021), which would be a 500.
  q: z.string().trim().max(100).regex(/^[^\u0000]*$/, "Search text may not contain null characters").optional(),
  status: z.enum(["open", "closed", "all"]).default("open"),
  sourceId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

type JobRow = typeof jobs.$inferSelect;

export interface JobListItem {
  id: string;
  title: string;
  companyName: string;
  locationRaw: string | null;
  workMode: JobRow["workMode"];
  status: JobRow["status"];
  /** Source-reported posted date; null when the source does not give one. */
  postedAt: string | null;
  firstSeenAt: string;
  salary: {
    raw: string | null;
    min: number | null;
    max: number | null;
    currency: string | null;
    period: JobRow["salaryPeriod"];
    isParsed: boolean;
  };
  sponsorship: JobRow["sponsorship"];
  minExperienceYears: number | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

export function toJobListItem(row: JobRow): JobListItem {
  return {
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    locationRaw: row.locationRaw,
    workMode: row.workMode,
    status: row.status,
    postedAt: row.postedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    salary: {
      raw: row.salaryRaw,
      min: num(row.salaryMin),
      max: num(row.salaryMax),
      currency: row.salaryCurrency,
      period: row.salaryPeriod,
      isParsed: row.salaryIsParsed,
    },
    sponsorship: row.sponsorship,
    minExperienceYears: row.minExperienceYears,
  };
}

/** So a user typing "100%" or "a_b" searches for those characters instead of a wildcard. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listJobs(
  tx: DbClient,
  query: ListJobsQuery
): Promise<{ jobs: JobListItem[]; page: number; pageSize: number; total: number }> {
  const conditions: SQL[] = [];
  if (query.status !== "all") conditions.push(eq(jobs.status, query.status));
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(or(ilike(jobs.title, pattern), ilike(jobs.companyName, pattern)) as SQL);
  }
  if (query.sourceId) {
    conditions.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(jobPostings)
          .where(and(eq(jobPostings.jobId, jobs.id), eq(jobPostings.sourceId, query.sourceId)))
      )
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await tx
    .select()
    .from(jobs)
    .where(where)
    .orderBy(sql`${jobs.postedAt} DESC NULLS LAST`, desc(jobs.firstSeenAt), jobs.id)
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await tx.select({ total: count() }).from(jobs).where(where);

  return { jobs: rows.map(toJobListItem), page: query.page, pageSize: PAGE_SIZE, total };
}
