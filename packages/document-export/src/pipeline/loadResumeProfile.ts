import { asc } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { normalizeTermKey } from "@ai-career/resume-optimization";
import type { ResumeProfile } from "../model/resumeProfile";

const { candidateProfiles, workExperiences, workExperienceBullets, achievements, projects, certifications, education, skills, skillVerifications } = schema;

/** Call inside withUserContext. Null when the user has no confirmed profile. Street address is not read. */
export async function loadResumeProfile(tx: DbClient): Promise<ResumeProfile | null> {
  const [contact] = await tx
    .select({ fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber, linkedinUrl: candidateProfiles.linkedinUrl })
    .from(candidateProfiles)
    .limit(1);
  if (!contact) return null;

  const [exps, bullets, achs, projs, certs, edus, skls, verifs] = await Promise.all([
    tx.select().from(workExperiences).orderBy(asc(workExperiences.displayOrder), asc(workExperiences.id)),
    tx.select().from(workExperienceBullets).orderBy(asc(workExperienceBullets.displayOrder), asc(workExperienceBullets.id)),
    tx.select().from(achievements).orderBy(asc(achievements.displayOrder), asc(achievements.id)),
    tx.select().from(projects).orderBy(asc(projects.displayOrder), asc(projects.id)),
    tx.select().from(certifications).orderBy(asc(certifications.displayOrder), asc(certifications.id)),
    tx.select().from(education).orderBy(asc(education.displayOrder), asc(education.id)),
    tx.select().from(skills).orderBy(asc(skills.displayOrder), asc(skills.id)),
    tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey)),
  ]);

  return {
    contact,
    experiences: exps.map((e) => ({
      id: e.id, company: e.company, title: e.title, location: e.location, startDate: e.startDate, endDate: e.endDate,
      bullets: bullets.filter((b) => b.workExperienceId === e.id).map((b) => ({ id: b.id, text: b.text })),
    })),
    achievements: achs.map((a) => ({ id: a.id, description: a.description })),
    projects: projs.map((p) => ({ id: p.id, name: p.name, description: p.description, url: p.url })),
    certifications: certs.map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, issueDate: c.issueDate, expiryDate: c.expiryDate })),
    education: edus.map((e) => ({
      id: e.id, institution: e.institution, degree: e.degree, fieldOfStudy: e.fieldOfStudy, startDate: e.startDate, endDate: e.endDate, gpa: e.gpa,
    })),
    skills: skls.map((s) => ({ id: s.id, name: s.name })),
    // Same set buildResumeSnapshot puts in the catalog (have rows and live aliases), so applied ids always resolve.
    verifiedSkills: verifs
      .filter((v) => (v.status === "have" && v.evidence !== null)
        || (v.status === "alias" && v.aliasSkillName !== null && skls.some((s) => normalizeTermKey(s.name) === normalizeTermKey(v.aliasSkillName!))))
      .map((v) => ({ id: v.id, term: v.termDisplay })),
  };
}
