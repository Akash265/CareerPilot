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

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
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
});
