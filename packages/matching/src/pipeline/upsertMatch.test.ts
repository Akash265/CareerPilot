import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { upsertMatchRow } from "./upsertMatch";
import type { FactorScores } from "../types";

const USER = "00000000-0000-0000-0000-0000000000e4";
let testDb: TestDb;

const factors: FactorScores = {
  skillsScore: 0.8, experienceScore: 1, locationScore: 1, sponsorshipScore: 1,
  roleScore: 0.9, salaryScore: null, industryScore: 1, freshnessScore: 1, semanticScore: 0.7,
};

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function seed() {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  return { goalId: goal.id as string, jobId: job.id as string };
}

describe("upsertMatchRow", () => {
  it("inserts a new eligible row with its factor scores and overall score", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 87.5, computedAt: new Date(), existing: undefined })
    );
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.eligible).toBe(true);
    expect(Number(row.overallScore)).toBe(87.5);
    expect(row.salaryScore).toBeNull();
    expect(row.userAction).toBe("none");
  });

  it("inserts an ineligible row with a reason and null scores", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: false, ineligibleReason: "Dismissed", factors: null, overallScore: null, computedAt: new Date(), existing: undefined })
    );
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.eligible).toBe(false);
    expect(row.ineligibleReason).toBe("Dismissed");
    expect(row.overallScore).toBeNull();
  });

  it("overwrites an existing row in place on a second call (no duplicate rows)", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 50, computedAt: new Date(), existing: undefined })
    );
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 90, computedAt: new Date(), existing: undefined })
    );
    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].overallScore)).toBe(90);
  });

  it("carries forward the prior row's userAction, userActionAt and explanation fields (Refinement #4)", async () => {
    const { goalId, jobId } = await seed();
    const userActionAt = new Date("2026-09-20T00:00:00Z");
    const explanationGeneratedAt = new Date("2026-09-20T01:00:00Z");
    await withUserContext(testDb.db, USER, (tx) =>
      tx.insert(schema.jobMatches).values({
        jobId, careerGoalId: goalId, eligible: true, computedAt: new Date(),
        userAction: "dismissed", userActionAt,
        explanation: { strongMatches: ["x"], partialMatches: [], gaps: [], summary: "s" },
        explanationModel: "test-model", explanationDescriptionHash: "dh", explanationGeneratedAt,
      })
    );
    const [existing] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));

    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: false, ineligibleReason: "You dismissed this job.", factors: null, overallScore: null, computedAt: new Date(), existing })
    );

    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.userAction).toBe("dismissed");
    expect(row.userActionAt).toEqual(userActionAt);
    expect(row.explanationModel).toBe("test-model");
    expect(row.explanationGeneratedAt).toEqual(explanationGeneratedAt);
  });
});
