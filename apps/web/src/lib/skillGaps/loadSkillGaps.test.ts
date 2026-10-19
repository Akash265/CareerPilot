import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { createDbClient, closeDbClient, withUserContext, type DbClient } from "@ai-career/db";
import { openAdminDb, wipeMatchingData, insertCareerGoal, insertJob, insertMatch } from "../../test/jobsDb";
import { loadJobSkillGaps, loadSkillGapsOverview } from "./loadSkillGaps";

// Phase 13b test user (…0d13); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d13";
let admin: postgres.Sql;
let db: DbClient;
const wipe = async () => {
  await admin`DELETE FROM skills WHERE user_id = ${USER}`;
  await wipeMatchingData(admin, USER);
};
beforeAll(async () => {
  admin = await openAdminDb();
  db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
});
beforeEach(wipe);
afterAll(async () => { await wipe(); await admin.end(); await closeDbClient(db); });

async function jobWith(title: string, score: number, terms: string[]) {
  const goal = await insertCareerGoal(admin, USER, { isActive: false });
  const jobId = await insertJob(admin, USER, { title });
  await insertMatch(admin, USER, jobId, goal, { overallScore: score });
  for (const term of terms) {
    await admin`
      INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model, extraction_source_description_hash)
      VALUES (${USER}, ${jobId}, ${term}, 'tool', 'required', 'm', ${"hash-" + title})`;
  }
  return jobId;
}

describe("loadSkillGapsOverview", () => {
  it("groups unanswered gaps across top jobs, most-blocking first, and counts jobs without requirements", async () => {
    const a = await jobWith("A", 90, ["Kubernetes", "dbt"]);
    const b = await jobWith("B", 80, ["kubernetes "]);
    await jobWith("C", 70, []);
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Postgres')`;
    await admin`INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have')`;

    const o = await withUserContext(db, USER, (tx) => loadSkillGapsOverview(tx, 25));

    expect(o.unanswered).toEqual([{
      termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null, jobCount: 2,
      jobs: [{ jobId: a, title: "A", companyName: "Acme" }, { jobId: b, title: "B", companyName: "Acme" }],
    }]);
    expect(o.answered).toEqual([expect.objectContaining({ termKey: "dbt", status: "dont_have" })]);
    expect(o).toMatchObject({ topN: 25, jobsWithoutRequirements: 1, profileSkills: ["Postgres"] });
  });

  it("treats requirements extracted from an older description as missing", async () => {
    const id = await jobWith("A", 90, ["Kubernetes"]);
    await admin`UPDATE jobs SET description_hash = 'changed' WHERE id = ${id}`;
    const o = await withUserContext(db, USER, (tx) => loadSkillGapsOverview(tx, 25));
    expect(o).toMatchObject({ unanswered: [], jobsWithoutRequirements: 1 });
  });
});

describe("zero-requirement jobs (D205)", () => {
  it("counts a job extracted with zero requirements as ready, not as missing", async () => {
    const id = await jobWith("Z", 90, []);
    await admin`UPDATE jobs SET requirements_extracted_hash = description_hash WHERE id = ${id}`;
    const o = await withUserContext(db, USER, (tx) => loadSkillGapsOverview(tx, 25));
    expect(o).toMatchObject({ unanswered: [], jobsWithoutRequirements: 0 });
    expect(await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, id))).toMatchObject({
      requirementsStatus: "ready", unanswered: [], coveredCount: 0, declinedCount: 0,
    });
  });
});

describe("loadJobSkillGaps", () => {
  it("returns one job's unanswered gaps with covered and declined counts", async () => {
    const id = await jobWith("A", 90, ["Kubernetes", "dbt", "PostgreSQL", "Python"]);
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Python'), (${USER}, 'Postgres')`;
    await admin`INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have')`;
    const v = await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, id));
    expect(v).toEqual({
      requirementsStatus: "ready",
      unanswered: [
        { termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null },
        { termKey: "postgresql", termDisplay: "PostgreSQL", suggestion: "Postgres" },
      ],
      coveredCount: 1, declinedCount: 1, profileSkills: ["Postgres", "Python"],
    });
  });

  it("says requirements are missing, and returns null for a job without a match", async () => {
    const id = await jobWith("A", 90, []);
    expect(await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, id))).toMatchObject({ requirementsStatus: "missing", unanswered: [] });
    const lone = await insertJob(admin, USER, { title: "Lone" });
    expect(await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, lone))).toBeNull();
  });
});
