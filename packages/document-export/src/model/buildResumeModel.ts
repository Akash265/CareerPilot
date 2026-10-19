import { normalizeTermKey, type AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentBlock, DocumentModel } from "./types";
import { certDates, contactLine, dateRange, present, type ResumeProfile } from "./resumeProfile";

/** Items the optimizer selected (in its order) with its text, then the rest (in profile order) with their own text. */
function selectedFirst<T extends { id: string }>(
  items: T[],
  applied: AppliedBullet[],
  sourceType: AppliedBullet["sourceType"],
  originalText: (item: T) => string
): { item: T; text: string }[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen: { item: T; text: string }[] = [];
  const used = new Set<string>();
  for (const a of applied) {
    if (a.sourceType !== sourceType) continue;
    const item = byId.get(a.sourceFactId);
    if (!item || used.has(item.id)) continue; // wrong group, or a duplicate applied entry -- first occurrence wins
    // Phase 6's AppliedBullet schema allows optimizedText: z.string(), so a blank/whitespace-only value can
    // reach here; fall back to the item's original text rather than rendering an empty bullet/paragraph.
    // The item is still "selected" -- it keeps its place at the front of selection order -- only its text
    // falls back.
    chosen.push({ item, text: present(a.optimizedText) ? a.optimizedText : originalText(item) });
    used.add(item.id);
  }
  for (const item of items) if (!used.has(item.id)) chosen.push({ item, text: originalText(item) });
  return chosen;
}

/** Joins the non-blank parts with " · ", or null if none are present. */
function joinPresent(parts: (string | null)[]): string | null {
  const kept = parts.filter(present);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/**
 * The resume document (Phase 7b design §4.2, D82): the full profile, with the optimizer's guard-applied
 * rewordings replacing their originals and ordered first. Education, certifications, skill names and verified skill terms are
 * never reworded. rejectedClaims are never an input. No street address.
 */
export function buildResumeModel(profile: ResumeProfile, applied: AppliedBullet[]): DocumentModel {
  // Keyed by "sourceType:id" so an id that only exists under a different source type is treated as unknown, not
  // silently matched against the wrong collection (an id is only unique within its own source type).
  const knownIds = new Set<string>([
    ...profile.experiences.flatMap((e) => e.bullets.map((b) => `work_experience_bullet:${b.id}`)),
    ...profile.achievements.map((a) => `achievement:${a.id}`),
    ...profile.projects.map((p) => `project:${p.id}`),
    ...profile.certifications.map((c) => `certification:${c.id}`),
    ...profile.education.map((e) => `education:${e.id}`),
    ...profile.skills.map((s) => `skill:${s.id}`),
    ...profile.verifiedSkills.map((v) => `verified_skill:${v.id}`),
  ]);
  for (const a of applied) {
    if (!knownIds.has(`${a.sourceType}:${a.sourceFactId}`)) {
      throw new Error(`applied bullet cites unknown source fact ${a.sourceFactId}`);
    }
  }

  const blocks: DocumentBlock[] = [];

  if (profile.experiences.length > 0) {
    blocks.push({ type: "heading", text: "Experience" });
    for (const exp of profile.experiences) {
      blocks.push({
        type: "entry",
        title: exp.title,
        subtitle: joinPresent([exp.company, exp.location]),
        meta: dateRange(exp.startDate, exp.endDate),
      });
      const bullets = selectedFirst(exp.bullets, applied, "work_experience_bullet", (b) => b.text);
      if (bullets.length > 0) blocks.push({ type: "bullets", items: bullets.map((b) => b.text) });
    }
  }

  if (profile.projects.length > 0) {
    blocks.push({ type: "heading", text: "Projects" });
    for (const { item, text } of selectedFirst(profile.projects, applied, "project", (p) => p.description)) {
      blocks.push({ type: "entry", title: item.name, subtitle: present(item.url) ? item.url : null, meta: null });
      blocks.push({ type: "paragraph", text });
    }
  }

  if (profile.achievements.length > 0) {
    blocks.push({ type: "heading", text: "Achievements" });
    blocks.push({ type: "bullets", items: selectedFirst(profile.achievements, applied, "achievement", (a) => a.description).map((a) => a.text) });
  }

  if (profile.education.length > 0) {
    blocks.push({ type: "heading", text: "Education" });
    for (const e of profile.education) {
      blocks.push({
        type: "entry",
        title: present(e.fieldOfStudy) ? `${e.degree} in ${e.fieldOfStudy}` : e.degree,
        subtitle: present(e.gpa) ? `${e.institution} · GPA ${e.gpa}` : e.institution,
        meta: dateRange(e.startDate, e.endDate),
      });
    }
  }

  if (profile.certifications.length > 0) {
    blocks.push({ type: "heading", text: "Certifications" });
    for (const c of profile.certifications) {
      blocks.push({
        type: "entry",
        title: c.name,
        subtitle: c.issuer,
        meta: certDates(c.issueDate, c.expiryDate),
      });
    }
  }

  if (profile.skills.length > 0 || profile.verifiedSkills.length > 0) {
    blocks.push({ type: "heading", text: "Skills" });
    // Names only, never the optimizer's text: profile skills in selection order, then verified skills (Phase 13b, R4)
    // in selection order, each list followed by its unselected items.
    const profileNames = selectedFirst(profile.skills, applied, "skill", (s) => s.name).map(({ item }) => item.name);
    const listed = new Set(profileNames.map(normalizeTermKey));
    // A verified term that normalizes to a skill already listed is not rendered twice.
    const verifiedNames = selectedFirst(profile.verifiedSkills, applied, "verified_skill", (v) => v.term)
      .map(({ item }) => item.term)
      .filter((term) => !listed.has(normalizeTermKey(term)));
    const ordered = [...profileNames, ...verifiedNames];
    blocks.push({ type: "paragraph", text: ordered.join(", ") });
  }

  return { title: profile.contact.fullName, contactLine: contactLine(profile.contact), blocks };
}
