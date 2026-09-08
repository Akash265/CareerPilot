import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("@ai-career/ai", () => ({
  embedTexts: vi.fn(async (_env: unknown, texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
}));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000000d",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../packages/db/migrations");
const adminSql = postgres(
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
    "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
);

// Must match the DEFAULT_USER_ID returned by the mocked loadEnv() above.
const TEST_USER_ID = "00000000-0000-0000-0000-00000000000d";

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });

  // Clean slate for this test file's fixture user, same pattern as
  // packages/db/src/rls.test.ts / profileTables.rls.test.ts. Without this,
  // the "returns profile: null before any profile has been saved" assertion
  // only holds on a fresh database -- a second local run (against the same
  // Postgres container, no reset in between) would find the
  // candidate_profiles row this file's own PATCH test left behind and fail.
  // child tables first (work_experience_bullets has a cascading FK to
  // work_experiences, but every row is deleted explicitly here anyway for
  // clarity/robustness against future schema changes), then the parent row.
  await adminSql`DELETE FROM work_experience_bullets WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM work_experiences WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM education WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM skills WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM projects WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM certifications WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM achievements WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM company_preferences WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM profile_facts WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${TEST_USER_ID}`;
});

afterAll(async () => {
  await adminSql.end();
});

const { GET, PATCH } = await import("./route");

const baseProfile = {
  contact: { fullName: "Grace Hopper", email: "grace@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: 10,
  workModePreference: "remote",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: false,
  workAuthorizationNotes: null,
  preferredRoleTitles: [],
  preferredIndustries: [],
  excludedIndustries: [],
  education: [],
  workExperiences: [],
  skills: [{ name: "COBOL", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("GET/PATCH /api/profile", () => {
  it("returns profile: null before any profile has been saved", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.profile).toBeNull();
  });

  it("returns the saved profile after PATCH persists it", async () => {
    const patchRes = await PATCH(
      new Request("http://localhost/api/profile", { method: "PATCH", body: JSON.stringify(baseProfile) })
    );
    expect(patchRes.status).toBe(200);

    const getRes = await GET();
    const body = await getRes.json();
    expect(body.profile.contact.fullName).toBe("Grace Hopper");
    expect(body.profile.skills).toEqual([{ name: "COBOL", category: null }]);
  });

  it("preserves list order across a save (Postgres gives no ordering guarantee without ORDER BY)", async () => {
    const profileWithOrderedLists = {
      ...baseProfile,
      skills: [
        { name: "Zebra skill", category: null },
        { name: "Apple skill", category: null },
        { name: "Mango skill", category: null },
      ],
      education: [
        { institution: "Second University", degree: "MSc", fieldOfStudy: null, startDate: null, endDate: null, gpa: null },
        { institution: "First University", degree: "BSc", fieldOfStudy: null, startDate: null, endDate: null, gpa: null },
      ],
      // company_preferences shares one table across both list types --
      // exercising both here (rather than leaving them [] like every other
      // fixture in this file) is what actually runs the displayOrder
      // insert/order code path for this table at all.
      preferredCompanies: ["Preferred B", "Preferred A"],
      excludedCompanies: ["Excluded Y", "Excluded X"],
    };

    await PATCH(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        body: JSON.stringify(profileWithOrderedLists),
      })
    );

    const body = await (await GET()).json();
    expect(body.profile.skills.map((s: { name: string }) => s.name)).toEqual([
      "Zebra skill",
      "Apple skill",
      "Mango skill",
    ]);
    expect(body.profile.education.map((e: { institution: string }) => e.institution)).toEqual([
      "Second University",
      "First University",
    ]);
    expect(body.profile.preferredCompanies).toEqual(["Preferred B", "Preferred A"]);
    expect(body.profile.excludedCompanies).toEqual(["Excluded Y", "Excluded X"]);
  });

  it("orders skills by display_order, not by physical/insertion order", async () => {
    // The previous test alone doesn't prove serializeProfile's ORDER BY
    // matters: rows freshly inserted (dead tuples not yet reclaimed) tend
    // to come back from an unordered `SELECT *` in insertion order anyway,
    // so that test would still pass even if `.orderBy(...)` were deleted.
    // Scrambling display_order directly via SQL -- independent of insertion
    // order -- means this test can only pass if the ORDER BY is real.
    await PATCH(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        body: JSON.stringify({
          ...baseProfile,
          skills: [
            { name: "Skill A", category: null },
            { name: "Skill B", category: null },
            { name: "Skill C", category: null },
          ],
        }),
      })
    );

    // Inserted in physical order A, B, C -- rewrite display_order so the
    // intended logical order is C, A, B, the opposite of physical order.
    await adminSql`UPDATE skills SET display_order = 1 WHERE user_id = ${TEST_USER_ID} AND name = 'Skill A'`;
    await adminSql`UPDATE skills SET display_order = 2 WHERE user_id = ${TEST_USER_ID} AND name = 'Skill B'`;
    await adminSql`UPDATE skills SET display_order = 0 WHERE user_id = ${TEST_USER_ID} AND name = 'Skill C'`;

    const body = await (await GET()).json();
    expect(body.profile.skills.map((s: { name: string }) => s.name)).toEqual([
      "Skill C",
      "Skill A",
      "Skill B",
    ]);
  });
});
