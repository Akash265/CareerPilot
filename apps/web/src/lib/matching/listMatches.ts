import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";
import { toMatchView, type MatchView } from "./serializeMatch";

const { jobMatches, jobs } = schema;

export const PAGE_SIZE = 25;

export const ListMatchesQuerySchema = z.object({
  eligible: z.enum(["true", "false"]).default("true"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ListMatchesQuery = z.infer<typeof ListMatchesQuerySchema>;

export interface MatchListItem {
  jobId: string;
  jobTitle: string;
  companyName: string;
  locationRaw: string | null;
  workMode: (typeof jobs.$inferSelect)["workMode"];
  match: MatchView;
}

export async function listMatches(
  tx: DbClient,
  query: ListMatchesQuery
): Promise<{ matches: MatchListItem[]; page: number; pageSize: number; total: number }> {
  const eligible = query.eligible === "true";
  const where = eq(jobMatches.eligible, eligible);

  const rows = await tx
    .select({
      id: jobMatches.id,
      jobId: jobMatches.jobId,
      eligible: jobMatches.eligible,
      ineligibleReason: jobMatches.ineligibleReason,
      skillsScore: jobMatches.skillsScore,
      experienceScore: jobMatches.experienceScore,
      locationScore: jobMatches.locationScore,
      sponsorshipScore: jobMatches.sponsorshipScore,
      roleScore: jobMatches.roleScore,
      salaryScore: jobMatches.salaryScore,
      industryScore: jobMatches.industryScore,
      freshnessScore: jobMatches.freshnessScore,
      semanticScore: jobMatches.semanticScore,
      overallScore: jobMatches.overallScore,
      explanation: jobMatches.explanation,
      explanationModel: jobMatches.explanationModel,
      explanationDescriptionHash: jobMatches.explanationDescriptionHash,
      explanationGeneratedAt: jobMatches.explanationGeneratedAt,
      userAction: jobMatches.userAction,
      userActionAt: jobMatches.userActionAt,
      computedAt: jobMatches.computedAt,
      createdAt: jobMatches.createdAt,
      userId: jobMatches.userId,
      careerGoalId: jobMatches.careerGoalId,
      jobTitle: jobs.title,
      companyName: jobs.companyName,
      locationRaw: jobs.locationRaw,
      workMode: jobs.workMode,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(where)
    .orderBy(eligible ? sql`${jobMatches.overallScore} DESC NULLS LAST` : desc(jobMatches.computedAt), jobMatches.id)
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await tx.select({ total: count() }).from(jobMatches).where(where);

  return {
    matches: rows.map((row) => ({
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      companyName: row.companyName,
      locationRaw: row.locationRaw,
      workMode: row.workMode,
      match: toMatchView(row),
    })),
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
  };
}
