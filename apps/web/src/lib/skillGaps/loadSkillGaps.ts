import { asc, eq, inArray } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import {
  buildResumeSnapshot, computeSkillGaps, selectTopMatchJobs, type SkillGap,
} from "@ai-career/resume-optimization";

const { jobMatches, jobs, jobRequirements, skills, skillVerifications } = schema;

export interface GapJobRef { jobId: string; title: string; companyName: string }
export interface UnansweredGapView { termKey: string; termDisplay: string; suggestion: string | null; jobCount: number; jobs: GapJobRef[] }
export interface VerificationView {
  id: string; termKey: string; termDisplay: string; status: "have" | "dont_have" | "alias";
  evidence: string | null; aliasSkillName: string | null; updatedAt: string;
}
export interface SkillGapsOverview {
  topN: number; unanswered: UnansweredGapView[]; answered: VerificationView[]; jobsWithoutRequirements: number; profileSkills: string[];
}
export interface JobSkillGapsView {
  requirementsStatus: "ready" | "missing";
  unanswered: { termKey: string; termDisplay: string; suggestion: string | null }[];
  coveredCount: number; declinedCount: number; profileSkills: string[];
}

type RequirementRow = typeof jobRequirements.$inferSelect;

export function toVerificationView(row: typeof skillVerifications.$inferSelect): VerificationView {
  return {
    id: row.id, termKey: row.termKey, termDisplay: row.termDisplay, status: row.status,
    evidence: row.evidence, aliasSkillName: row.aliasSkillName, updatedAt: row.updatedAt.toISOString(),
  };
}

/** Everything computeSkillGaps needs besides the requirements; one read per request. */
async function loadAnswerContext(tx: DbClient) {
  const [snapshot, verifications, skillRows] = await Promise.all([
    buildResumeSnapshot(tx),
    tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey)),
    tx.select({ name: skills.name }).from(skills).orderBy(asc(skills.name)),
  ]);
  return { catalog: snapshot.catalog, verifications, profileSkills: skillRows.map((s) => s.name) };
}

/** Requirements count only when every row was extracted from the job's current description (ensureJobRequirements' rule). */
function freshRequirements(
  rows: RequirementRow[], job: { descriptionHash: string; requirementsExtractedHash?: string | null }
): RequirementRow[] | null {
  if (rows.length === 0) return job.requirementsExtractedHash === job.descriptionHash ? [] : null; // D205: zero-requirement job
  return rows.every((r) => r.extractionSourceDescriptionHash === job.descriptionHash) ? rows : null;
}

function gapsFor(rows: RequirementRow[], ctx: Awaited<ReturnType<typeof loadAnswerContext>>): SkillGap[] {
  return computeSkillGaps(rows, ctx.catalog, ctx.verifications, ctx.profileSkills);
}

/** Phase 13b design §6.2: the /skills page. Unanswered gaps across the top N matches, most-blocking first. */
export async function loadSkillGapsOverview(tx: DbClient, topN: number): Promise<SkillGapsOverview> {
  const ctx = await loadAnswerContext(tx);
  const top = await selectTopMatchJobs(tx, topN);
  const rows = top.length === 0 ? [] : await tx.select().from(jobRequirements).where(inArray(jobRequirements.jobId, top.map((j) => j.id)));

  let jobsWithoutRequirements = 0;
  const byKey = new Map<string, UnansweredGapView>();
  for (const job of top) {
    const fresh = freshRequirements(rows.filter((r) => r.jobId === job.id), job);
    if (!fresh) {
      jobsWithoutRequirements++;
      continue;
    }
    for (const gap of gapsFor(fresh, ctx)) {
      if (gap.state !== "unanswered") continue;
      const view = byKey.get(gap.termKey) ?? { termKey: gap.termKey, termDisplay: gap.termDisplay, suggestion: gap.suggestion, jobCount: 0, jobs: [] };
      view.jobCount++;
      view.jobs.push({ jobId: job.id, title: job.title, companyName: job.companyName });
      byKey.set(gap.termKey, view);
    }
  }
  const unanswered = [...byKey.values()].sort((a, b) => b.jobCount - a.jobCount || (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : 0));
  return { topN, unanswered, answered: ctx.verifications.map(toVerificationView), jobsWithoutRequirements, profileSkills: ctx.profileSkills };
}

/** Phase 13b design §6.2: one job's gaps (any job with a match row, not only the top N). Null when there is no match row. */
export async function loadJobSkillGaps(tx: DbClient, jobId: string): Promise<JobSkillGapsView | null> {
  const [job] = await tx
    .select({ descriptionHash: jobs.descriptionHash, requirementsExtractedHash: jobs.requirementsExtractedHash })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobMatches.jobId, jobs.id))
    .where(eq(jobMatches.jobId, jobId))
    .limit(1);
  if (!job) return null;
  const ctx = await loadAnswerContext(tx);
  const fresh = freshRequirements(await tx.select().from(jobRequirements).where(eq(jobRequirements.jobId, jobId)), job);
  if (!fresh) return { requirementsStatus: "missing", unanswered: [], coveredCount: 0, declinedCount: 0, profileSkills: ctx.profileSkills };
  const gaps = gapsFor(fresh, ctx);
  return {
    requirementsStatus: "ready",
    unanswered: gaps.filter((g) => g.state === "unanswered").map(({ termKey, termDisplay, suggestion }) => ({ termKey, termDisplay, suggestion })),
    coveredCount: gaps.filter((g) => g.state === "covered").length,
    declinedCount: gaps.filter((g) => g.state === "declined").length,
    profileSkills: ctx.profileSkills,
  };
}
