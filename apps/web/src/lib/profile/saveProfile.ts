import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { embedTexts } from "@ai-career/ai";
import type { Env } from "@ai-career/config";
import type { ConfirmedProfile } from "./confirmedProfileSchema";
import { deriveFact, type DerivedFact } from "./deriveFacts";

type ExistingFact = {
  contentHash: string;
  embedding: number[] | null;
  embeddingModel: string | null;
};

/**
 * Persists a confirmed profile and (re)derives its `profile_facts` rows.
 *
 * Split into two transactions with the Voyage embedding call in between, per
 * the design spec's §7 error-handling rule: "Voyage embedding failure during
 * confirm → the profile data still commits; affected profile_facts rows are
 * left without an embedding." Keeping the network call inside the write
 * transaction would (a) roll the whole profile back when Voyage is down and
 * (b) hold a Postgres transaction (and its RLS session setting) open for the
 * duration of an external HTTP request.
 *
 * Transaction 1 writes the profile + child tables and reads the existing
 * facts; the embedding call runs outside any transaction and degrades to
 * nulls on failure; transaction 2 replaces the profile_facts set.
 */
export async function saveConfirmedProfile(
  env: Env,
  profile: ConfirmedProfile
): Promise<{ factsGenerated: number }> {
  const db = createDbClient(env);

  try {
    // --- Transaction 1: profile + child tables, and read existing facts ---
    const { facts, existingByHash } = await withUserContext(
      db,
      env.DEFAULT_USER_ID,
      async (tx) => {
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

        const derived: DerivedFact[] = [];

        for (const edu of profile.education) {
          const [row] = await tx
            .insert(schema.education)
            .values(edu)
            .returning({ id: schema.education.id });
          const factText = `${edu.degree} in ${edu.fieldOfStudy ?? "unspecified field"} from ${edu.institution}`;
          derived.push(deriveFact("education", row.id as string, factText));
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
            derived.push(deriveFact("work_experience_bullet", bulletRow.id as string, bulletText));
          }
        }

        for (const skill of profile.skills) {
          const [row] = await tx.insert(schema.skills).values(skill).returning({ id: schema.skills.id });
          derived.push(deriveFact("skill", row.id as string, skill.name));
        }

        for (const project of profile.projects) {
          const [row] = await tx
            .insert(schema.projects)
            .values(project)
            .returning({ id: schema.projects.id });
          derived.push(deriveFact("project", row.id as string, `${project.name}: ${project.description}`));
        }

        for (const cert of profile.certifications) {
          const [row] = await tx
            .insert(schema.certifications)
            .values(cert)
            .returning({ id: schema.certifications.id });
          derived.push(deriveFact("certification", row.id as string, `${cert.name} (${cert.issuer})`));
        }

        for (const achievement of profile.achievements) {
          const [row] = await tx
            .insert(schema.achievements)
            .values({ description: achievement })
            .returning({ id: schema.achievements.id });
          derived.push(deriveFact("achievement", row.id as string, achievement));
        }

        for (const companyName of profile.preferredCompanies) {
          await tx.insert(schema.companyPreferences).values({ companyName, listType: "preferred" });
        }
        for (const companyName of profile.excludedCompanies) {
          await tx.insert(schema.companyPreferences).values({ companyName, listType: "excluded" });
        }

        const existingFacts = await tx.select().from(schema.profileFacts);
        return {
          facts: derived,
          existingByHash: new Map<string, ExistingFact>(
            existingFacts.map((f) => [
              f.contentHash,
              { contentHash: f.contentHash, embedding: f.embedding, embeddingModel: f.embeddingModel },
            ])
          ),
        };
      }
    );

    // --- Outside any transaction: embed only the new/changed fact text ---
    // D16's content-hash cache: a fact whose text is unchanged reuses its
    // stored embedding and never hits Voyage again.
    const factsNeedingEmbedding = facts.filter((f) => !existingByHash.has(f.contentHash));
    let newEmbeddings: (number[] | null)[];
    try {
      newEmbeddings = await embedTexts(
        env,
        factsNeedingEmbedding.map((f) => f.factText)
      );
    } catch {
      // Spec §7: a Voyage failure must not lose the confirmed profile (already
      // committed above). The affected facts are written with a null embedding
      // -- the column is nullable precisely so they can be back-filled later.
      // The error itself is swallowed rather than logged because it may embed
      // fact text (profile PII) in its message, which §6 forbids logging.
      newEmbeddings = factsNeedingEmbedding.map(() => null);
    }
    const embeddingByHash = new Map(
      factsNeedingEmbedding.map((f, i) => [f.contentHash, newEmbeddings[i] ?? null])
    );

    // --- Transaction 2: replace the profile_facts set ---
    await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
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
    });

    return { factsGenerated: facts.length };
  } finally {
    // createDbClient opens a fresh postgres connection pool per call (see
    // packages/db/src/client.ts); without this the pool leaks on every save
    // and eventually exhausts Postgres's max_connections. Same best-effort
    // pattern as apps/web/src/app/api/health/route.ts.
    try {
      await db.$client?.end();
    } catch {
      // Best-effort cleanup only; must not mask the save's own result/error.
    }
  }
}
