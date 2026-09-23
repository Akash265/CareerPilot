// apps/web/src/lib/resumeOptimization/listOptimizations.ts
import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toOptimizationView, type OptimizationView } from "./serializeOptimization";

const { resumeOptimizations, atsEvaluations } = schema;

export async function listOptimizations(tx: DbClient, jobId: string): Promise<OptimizationView[]> {
  const rows = await tx
    .select({ optimization: resumeOptimizations, evaluation: atsEvaluations })
    .from(resumeOptimizations)
    .innerJoin(atsEvaluations, eq(atsEvaluations.resumeOptimizationId, resumeOptimizations.id))
    .where(eq(resumeOptimizations.jobId, jobId))
    .orderBy(desc(resumeOptimizations.version));
  return rows.map(({ optimization, evaluation }) => toOptimizationView(optimization, evaluation));
}
