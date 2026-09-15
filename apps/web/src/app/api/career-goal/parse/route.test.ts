import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  extractCareerGoal,
  CareerGoalExtractionValidationError,
  type CareerGoalExtractionDraft,
} from "@ai-career/ai";

vi.mock("@ai-career/ai", async () => {
  const actual = await vi.importActual<typeof import("@ai-career/ai")>("@ai-career/ai");
  return {
    ...actual,
    extractCareerGoal: vi.fn(),
    createAnthropicClient: () => ({}),
  };
});

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000000f",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    ANTHROPIC_MODEL_FAST: "test-model",
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
  return new Request("http://localhost/api/career-goal/parse", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validExtraction: CareerGoalExtractionDraft = {
  targetRoles: ["Data Engineer"],
  seniority: null,
  locations: ["Germany"],
  workMode: "remote",
  minExperienceYears: 3,
  employmentType: null,
  salaryFloorRaw: "minimum €60k",
  visaSponsorshipRequired: true,
  skills: [],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  hardConstraints: [],
};

describe("POST /api/career-goal/parse", () => {
  // vitest doesn't clear mocks between `it` blocks by default (no
  // `clearMocks` in vitest.config.ts), so the vi.fn() from the vi.mock
  // factory above accumulates call history across tests in this file.
  // Reset it before each test so per-test assertions on call count/args
  // (e.g. "not.toHaveBeenCalled()") reflect only that test's own POST calls.
  beforeEach(() => {
    vi.mocked(extractCareerGoal).mockReset();
  });

  it("creates a career_goals row, extracts a draft, and merges in the deterministically parsed salary", async () => {
    vi.mocked(extractCareerGoal).mockResolvedValue(validExtraction);

    const res = await POST(makeRequest({ rawText: "Data jobs in Germany, remote, visa sponsorship, minimum €60k" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("parsed");
    expect(body.version).toBe(1);
    expect(body.draft.targetRoles).toEqual(["Data Engineer"]);
    expect(body.draft.salaryFloorNormalized).toBe(60000);
    expect(body.draft.salaryCurrency).toBe("EUR");
    expect(body.draft.salaryIsParsed).toBe(true);

    const [row] = await adminSql`SELECT parse_status, version FROM career_goals WHERE id = ${body.goalId}`;
    expect(row.parse_status).toBe("parsed");
    expect(row.version).toBe(1);
  });

  it("increments version on a second goal for the same user", async () => {
    vi.mocked(extractCareerGoal).mockResolvedValue(validExtraction);

    const first = await (await POST(makeRequest({ rawText: "First goal statement" }))).json();
    const second = await (await POST(makeRequest({ rawText: "Second goal statement" }))).json();

    expect(second.version).toBe(first.version + 1);
  });

  it("rejects an empty rawText with 400 before touching the database or Anthropic", async () => {
    const res = await POST(makeRequest({ rawText: "   " }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/empty/i);
    expect(extractCareerGoal).not.toHaveBeenCalled();
  });

  it("marks the row failed (without a server error) when extraction fails", async () => {
    vi.mocked(extractCareerGoal).mockRejectedValue(new CareerGoalExtractionValidationError("bad output"));

    const res = await POST(makeRequest({ rawText: "Some goal text" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");

    const [row] = await adminSql`SELECT parse_status, parse_error FROM career_goals WHERE id = ${body.goalId}`;
    expect(row.parse_status).toBe("failed");
    expect(row.parse_error).toBe("bad output");
  });
});
