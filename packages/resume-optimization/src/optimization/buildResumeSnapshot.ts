import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { normalizeTermKey } from "../gaps/normalizeTermKey";

const { workExperiences, workExperienceBullets, achievements, projects, certifications, education, skills, skillVerifications } = schema;


export type EvidenceSourceType =
  | "work_experience_bullet" | "achievement" | "project" | "certification" | "education" | "skill" | "verified_skill";

export interface EvidenceCatalogEntry {
  sourceFactId: string;
  sourceType: EvidenceSourceType;
  text: string;
  /** Extra context for the optimizer prompt only (e.g. "Acme — Engineer"); null when the evidence
   * item has no natural parent to name. Never used by applyDeterministicGuard (Task 6). */
  context: string | null;
}

export interface ResumeSnapshot {
  catalog: EvidenceCatalogEntry[];
  contentHash: string;
}

function stableStringifyCatalog(entries: EvidenceCatalogEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.sourceFactId.localeCompare(b.sourceFactId));
  return JSON.stringify(sorted.map((e) => ({ id: e.sourceFactId, type: e.sourceType, text: e.text })));
}

/**
 * Builds the flat evidence catalog the optimizer may select/reword from (design doc §4) directly
 * from the user's structured profile tables -- not from profile_facts -- so every sourceFactId
 * applyDeterministicGuard (Task 6) checks is a real row id in one of the six profile tables plus skill_verifications (Phase 13b), not an
 * indirection through another cache (D60). Order follows each of the six tables' own displayOrder
 * column, matching the order a resume would actually present them in. (A tied displayOrder, e.g.
 * the common default of 0, leaves Postgres free to return those rows in any order -- this only
 * affects the optimizer prompt's presentation order, never contentHash, which sorts by
 * sourceFactId before hashing.)
 */
export async function buildResumeSnapshot(tx: DbClient): Promise<ResumeSnapshot> {
  const [expRows, bulletRows, achievementRows, projectRows, certRows, eduRows, skillRows, verificationRows] = await Promise.all([
    tx.select().from(workExperiences).orderBy(asc(workExperiences.displayOrder)),
    tx.select().from(workExperienceBullets).orderBy(asc(workExperienceBullets.displayOrder)),
    tx.select().from(achievements).orderBy(asc(achievements.displayOrder)),
    tx.select().from(projects).orderBy(asc(projects.displayOrder)),
    tx.select().from(certifications).orderBy(asc(certifications.displayOrder)),
    tx.select().from(education).orderBy(asc(education.displayOrder)),
    tx.select().from(skills).orderBy(asc(skills.displayOrder)),
    tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey)),
  ]);

  const experienceById = new Map(expRows.map((e) => [e.id, e]));
  const catalog: EvidenceCatalogEntry[] = [];

  for (const bullet of bulletRows) {
    const exp = experienceById.get(bullet.workExperienceId);
    catalog.push({
      sourceFactId: bullet.id,
      sourceType: "work_experience_bullet",
      text: bullet.text,
      context: exp ? `${exp.company} — ${exp.title}` : null,
    });
  }
  for (const a of achievementRows) {
    catalog.push({ sourceFactId: a.id, sourceType: "achievement", text: a.description, context: null });
  }
  for (const p of projectRows) {
    catalog.push({ sourceFactId: p.id, sourceType: "project", text: p.description, context: p.name });
  }
  for (const c of certRows) {
    catalog.push({ sourceFactId: c.id, sourceType: "certification", text: c.name, context: c.issuer });
  }
  for (const e of eduRows) {
    catalog.push({
      sourceFactId: e.id,
      sourceType: "education",
      text: [e.degree, e.fieldOfStudy].filter(Boolean).join(" in "),
      context: e.institution,
    });
  }
  for (const s of skillRows) {
    catalog.push({ sourceFactId: s.id, sourceType: "skill", text: s.name, context: null });
  }

  // Phase 13b: the user's own answers. A "have" carries their evidence sentence; an alias counts only while the
  // profile skill it names still exists (saveProfile re-creates skills, so it is matched by name, not id).
  const profileSkillKeys = new Set(skillRows.map((s) => normalizeTermKey(s.name)));
  for (const v of verificationRows) {
    if (v.status === "have" && v.evidence) {
      catalog.push({ sourceFactId: v.id, sourceType: "verified_skill", text: `${v.termDisplay}: ${v.evidence}`, context: "Verified by you" });
    } else if (v.status === "alias" && v.aliasSkillName && profileSkillKeys.has(normalizeTermKey(v.aliasSkillName))) {
      catalog.push({ sourceFactId: v.id, sourceType: "verified_skill", text: `${v.termDisplay} (same as ${v.aliasSkillName})`, context: "Verified by you" });
    }
  }

  const contentHash = createHash("sha256").update(stableStringifyCatalog(catalog)).digest("hex");
  return { catalog, contentHash };
}
