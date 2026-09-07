import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { embedTexts } from "@ai-career/ai";
import type { Env } from "@ai-career/config";
import type { ConfirmedProfile } from "./confirmedProfileSchema";
import { deriveFact, type DerivedFact } from "./deriveFacts";

export async function saveConfirmedProfile(
  env: Env,
  profile: ConfirmedProfile
): Promise<{ factsGenerated: number }> {
  const db = createDbClient(env);

  return withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
    await tx
      .insert(schema.candidateProfiles)
      .values({
        fullName: profile.contact.fullName,
        email: profile.contact.email,
        phoneNumber: profile.contact.phoneNumber,
        linkedinUrl: profile.contact.linkedinUrl,
        addressLine1: profile.contact.addressLine1,
        yearsOfExperience: profile.yearsOfExperience,
        workModePreference: profile.workModePreference,
        salaryExpectationMin:
          profile.salaryExpectationMin === null ? null : String(profile.salaryExpectationMin),
        salaryExpectationMax:
          profile.salaryExpectationMax === null ? null : String(profile.salaryExpectationMax),
        salaryCurrency: profile.salaryCurrency,
        visaSponsorshipRequired: profile.visaSponsorshipRequired,
        workAuthorizationNotes: profile.workAuthorizationNotes,
        preferredRoleTitles: profile.preferredRoleTitles,
        preferredIndustries: profile.preferredIndustries,
        excludedIndustries: profile.excludedIndustries,
      })
      .onConflictDoUpdate({
        target: schema.candidateProfiles.userId,
        set: {
          fullName: profile.contact.fullName,
          email: profile.contact.email,
          phoneNumber: profile.contact.phoneNumber,
          linkedinUrl: profile.contact.linkedinUrl,
          addressLine1: profile.contact.addressLine1,
          yearsOfExperience: profile.yearsOfExperience,
          workModePreference: profile.workModePreference,
          salaryExpectationMin:
            profile.salaryExpectationMin === null ? null : String(profile.salaryExpectationMin),
          salaryExpectationMax:
            profile.salaryExpectationMax === null ? null : String(profile.salaryExpectationMax),
          salaryCurrency: profile.salaryCurrency,
          visaSponsorshipRequired: profile.visaSponsorshipRequired,
          workAuthorizationNotes: profile.workAuthorizationNotes,
          preferredRoleTitles: profile.preferredRoleTitles,
          preferredIndustries: profile.preferredIndustries,
          excludedIndustries: profile.excludedIndustries,
          updatedAt: new Date(),
        },
      });

    await tx.delete(schema.education);
    await tx.delete(schema.workExperienceBullets);
    await tx.delete(schema.workExperiences);
    await tx.delete(schema.skills);
    await tx.delete(schema.projects);
    await tx.delete(schema.certifications);
    await tx.delete(schema.achievements);
    await tx.delete(schema.companyPreferences);

    const facts: DerivedFact[] = [];

    for (const edu of profile.education) {
      const [row] = await tx.insert(schema.education).values(edu).returning({ id: schema.education.id });
      const factText = `${edu.degree} in ${edu.fieldOfStudy ?? "unspecified field"} from ${edu.institution}`;
      facts.push(deriveFact("education", row.id as string, factText));
    }

    for (const exp of profile.workExperiences) {
      const [row] = await tx
        .insert(schema.workExperiences)
        .values({
          company: exp.company,
          title: exp.title,
          location: exp.location,
          employmentType: exp.employmentType,
          startDate: exp.startDate,
          endDate: exp.endDate,
        })
        .returning({ id: schema.workExperiences.id });
      for (const [index, bulletText] of exp.bullets.entries()) {
        const [bulletRow] = await tx
          .insert(schema.workExperienceBullets)
          .values({ workExperienceId: row.id as string, text: bulletText, displayOrder: index })
          .returning({ id: schema.workExperienceBullets.id });
        facts.push(deriveFact("work_experience_bullet", bulletRow.id as string, bulletText));
      }
    }

    for (const skill of profile.skills) {
      const [row] = await tx.insert(schema.skills).values(skill).returning({ id: schema.skills.id });
      facts.push(deriveFact("skill", row.id as string, skill.name));
    }

    for (const project of profile.projects) {
      const [row] = await tx.insert(schema.projects).values(project).returning({ id: schema.projects.id });
      facts.push(deriveFact("project", row.id as string, `${project.name}: ${project.description}`));
    }

    for (const cert of profile.certifications) {
      const [row] = await tx
        .insert(schema.certifications)
        .values(cert)
        .returning({ id: schema.certifications.id });
      facts.push(deriveFact("certification", row.id as string, `${cert.name} (${cert.issuer})`));
    }

    for (const achievement of profile.achievements) {
      const [row] = await tx
        .insert(schema.achievements)
        .values({ description: achievement })
        .returning({ id: schema.achievements.id });
      facts.push(deriveFact("achievement", row.id as string, achievement));
    }

    for (const companyName of profile.preferredCompanies) {
      await tx.insert(schema.companyPreferences).values({ companyName, listType: "preferred" });
    }
    for (const companyName of profile.excludedCompanies) {
      await tx.insert(schema.companyPreferences).values({ companyName, listType: "excluded" });
    }

    const existingFacts = await tx.select().from(schema.profileFacts);
    const existingByHash = new Map(existingFacts.map((f) => [f.contentHash, f]));

    const factsNeedingEmbedding = facts.filter((f) => !existingByHash.has(f.contentHash));
    const newEmbeddings = await embedTexts(env, factsNeedingEmbedding.map((f) => f.factText));
    const embeddingByHash = new Map(
      factsNeedingEmbedding.map((f, i) => [f.contentHash, newEmbeddings[i]])
    );

    await tx.delete(schema.profileFacts);
    for (const fact of facts) {
      const reused = existingByHash.get(fact.contentHash);
      const embedding = reused?.embedding ?? embeddingByHash.get(fact.contentHash) ?? null;
      await tx.insert(schema.profileFacts).values({
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        factText: fact.factText,
        embedding,
        embeddingModel: reused?.embeddingModel ?? env.VOYAGE_EMBEDDING_MODEL,
        contentHash: fact.contentHash,
      });
    }

    return { factsGenerated: facts.length };
  });
}
