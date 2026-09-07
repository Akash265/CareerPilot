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
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000000c",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../../packages/db/migrations");
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

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/profile/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validProfile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: 5,
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
  workExperiences: [
    { company: "Acme", title: "Engineer", location: null, employmentType: null, startDate: null, endDate: null, bullets: ["Built the analytical engine"] },
  ],
  skills: [{ name: "SQL", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("POST /api/profile/confirm", () => {
  it("persists the profile and generates one profile_fact per atomic item", async () => {
    const res = await POST(makeRequest(validProfile));
    const body = await res.json();

    expect(res.status).toBe(200);
    // 1 work-experience bullet + 1 skill = 2 facts
    expect(body.factsGenerated).toBe(2);
  });

  it("rejects a malformed payload with 400", async () => {
    const res = await POST(makeRequest({ contact: { fullName: 123 } }));
    expect(res.status).toBe(400);
  });
});
