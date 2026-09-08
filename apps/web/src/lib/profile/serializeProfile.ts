import { schema, type DbClient } from "@ai-career/db";
import { asc } from "drizzle-orm";

// Every array field is mapped to a plain, ID-free shape — the same shape
// ConfirmedProfileSchema accepts — so the UI (ReviewForm/ProfileDashboard)
// and API consumers never depend on internal row identifiers, and this
// response can be fed straight back into PATCH /api/profile unchanged.
export async function serializeProfile(tx: DbClient) {
  const [profileRow] = await tx.select().from(schema.candidateProfiles);
  if (!profileRow) return null;

  const workExperiences = await tx
    .select()
    .from(schema.workExperiences)
    .orderBy(asc(schema.workExperiences.displayOrder));
  const bullets = await tx.select().from(schema.workExperienceBullets);
  const companyPreferences = await tx.select().from(schema.companyPreferences);

  return {
    contact: {
      fullName: profileRow.fullName,
      email: profileRow.email,
      phoneNumber: profileRow.phoneNumber,
      linkedinUrl: profileRow.linkedinUrl,
      addressLine1: profileRow.addressLine1,
    },
    yearsOfExperience: profileRow.yearsOfExperience,
    workModePreference: profileRow.workModePreference,
    // Postgres `numeric` columns commonly round-trip through drizzle-orm's
    // postgres-js driver as strings (to avoid float precision loss), but
    // ConfirmedProfileSchema/EditableProfile require `number` — coerce
    // explicitly so a GET -> edit -> POST /api/profile/confirm round-trip
    // doesn't fail schema validation on the way back in.
    salaryExpectationMin:
      profileRow.salaryExpectationMin === null ? null : Number(profileRow.salaryExpectationMin),
    salaryExpectationMax:
      profileRow.salaryExpectationMax === null ? null : Number(profileRow.salaryExpectationMax),
    salaryCurrency: profileRow.salaryCurrency,
    visaSponsorshipRequired: profileRow.visaSponsorshipRequired,
    workAuthorizationNotes: profileRow.workAuthorizationNotes,
    preferredRoleTitles: profileRow.preferredRoleTitles,
    preferredIndustries: profileRow.preferredIndustries,
    excludedIndustries: profileRow.excludedIndustries,
    education: (
      await tx.select().from(schema.education).orderBy(asc(schema.education.displayOrder))
    ).map((e) => ({
      institution: e.institution,
      degree: e.degree,
      fieldOfStudy: e.fieldOfStudy,
      startDate: e.startDate,
      endDate: e.endDate,
      gpa: e.gpa,
    })),
    workExperiences: workExperiences.map((exp) => ({
      company: exp.company,
      title: exp.title,
      location: exp.location,
      employmentType: exp.employmentType,
      startDate: exp.startDate,
      endDate: exp.endDate,
      bullets: bullets
        .filter((b) => b.workExperienceId === exp.id)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((b) => b.text),
    })),
    skills: (
      await tx.select().from(schema.skills).orderBy(asc(schema.skills.displayOrder))
    ).map((s) => ({ name: s.name, category: s.category })),
    projects: (
      await tx.select().from(schema.projects).orderBy(asc(schema.projects.displayOrder))
    ).map((p) => ({
      name: p.name,
      description: p.description,
      url: p.url,
    })),
    certifications: (
      await tx
        .select()
        .from(schema.certifications)
        .orderBy(asc(schema.certifications.displayOrder))
    ).map((c) => ({
      name: c.name,
      issuer: c.issuer,
      issueDate: c.issueDate,
      expiryDate: c.expiryDate,
    })),
    achievements: (
      await tx.select().from(schema.achievements).orderBy(asc(schema.achievements.displayOrder))
    ).map((a) => a.description),
    preferredCompanies: companyPreferences.filter((c) => c.listType === "preferred").map((c) => c.companyName),
    excludedCompanies: companyPreferences.filter((c) => c.listType === "excluded").map((c) => c.companyName),
  };
}
