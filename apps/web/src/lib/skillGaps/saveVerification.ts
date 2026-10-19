import { sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { normalizeTermKey } from "@ai-career/resume-optimization";
import { toVerificationView, type VerificationView } from "./loadSkillGaps";
import type { SkillVerificationBody } from "./verificationBody";

const { skills, skillVerifications } = schema;

/** Upsert by (user, term_key): the last answer wins. An alias must name a current profile skill; its spelling is stored. */
export async function saveVerification(
  tx: DbClient,
  body: SkillVerificationBody
): Promise<{ kind: "saved"; verification: VerificationView } | { kind: "unknown_skill" }> {
  let aliasSkillName: string | null = null;
  if (body.status === "alias") {
    const wanted = normalizeTermKey(body.aliasSkillName);
    const match = (await tx.select({ name: skills.name }).from(skills)).find((s) => normalizeTermKey(s.name) === wanted);
    if (!match) return { kind: "unknown_skill" };
    aliasSkillName = match.name;
  }
  const values = {
    termKey: normalizeTermKey(body.termDisplay),
    termDisplay: body.termDisplay,
    status: body.status,
    evidence: body.status === "have" ? body.evidence : null,
    aliasSkillName,
  };
  const [row] = await tx
    .insert(skillVerifications)
    .values(values)
    .onConflictDoUpdate({
      target: [skillVerifications.userId, skillVerifications.termKey],
      set: { termDisplay: values.termDisplay, status: values.status, evidence: values.evidence, aliasSkillName: values.aliasSkillName, updatedAt: sql`now()` },
    })
    .returning();
  return { kind: "saved", verification: toVerificationView(row) };
}
