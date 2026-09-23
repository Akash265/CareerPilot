import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureJobRequirements } from "./ensureJobRequirements";

vi.mock("./extractJobRequirements", () => ({ extractJobRequirements: vi.fn() }));
import { extractJobRequirements } from "./extractJobRequirements";

// Not e2/e6 (already used by packages/ingestion and packages/matching's own test-user ids sharing
// the same test database under `turbo run test`'s cross-package parallelism -- see
// packages/matching/src/embeddings/ensureJobEmbeddings.test.ts's comment on this exact bug class).
const USER = "00000000-0000-0000-0000-0000000000f7";
const ENV = { ANTHROPIC_MODEL_FAST: "test-model" };
const FAKE_CLIENT = {} as Pick<Anthropic, "messages">;
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(extractJobRequirements).mockReset();
  await wipeUser(testDb.adminSql, USER);
});

async function seedJob(descriptionHash: string): Promise<string> {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'We use SQL.', ${descriptionHash}, now(), now())
    RETURNING id`;
  return job.id as string;
}

describe("ensureJobRequirements", () => {
  it("extracts and stores requirements for a job with none yet", async () => {
    vi.mocked(extractJobRequirements).mockResolvedValue({
      requirements: [{ termText: "SQL", termType: "skill", requirementLevel: "required", evidenceQuote: "SQL" }],
    });
    const jobId = await seedJob("hash-1");

    const result = await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "We use SQL.", descriptionHash: "hash-1" })
    );

    expect(result).toHaveLength(1);
    expect(result[0].termText).toBe("SQL");
    expect(result[0].extractionSourceDescriptionHash).toBe("hash-1");
    expect(extractJobRequirements).toHaveBeenCalledTimes(1);
  });

  it("skips extraction when a fresh row already matches the job's descriptionHash", async () => {
    vi.mocked(extractJobRequirements).mockResolvedValue({
      requirements: [{ termText: "SQL", termType: "skill", requirementLevel: "required", evidenceQuote: null }],
    });
    const jobId = await seedJob("hash-1");
    await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "We use SQL.", descriptionHash: "hash-1" })
    );
    vi.mocked(extractJobRequirements).mockClear();

    const result = await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "We use SQL.", descriptionHash: "hash-1" })
    );

    expect(extractJobRequirements).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("re-extracts and replaces rows when descriptionHash has changed", async () => {
    vi.mocked(extractJobRequirements).mockResolvedValue({
      requirements: [{ termText: "SQL", termType: "skill", requirementLevel: "required", evidenceQuote: null }],
    });
    const jobId = await seedJob("hash-1");
    await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "old", descriptionHash: "hash-1" })
    );

    vi.mocked(extractJobRequirements).mockResolvedValue({
      requirements: [{ termText: "Python", termType: "skill", requirementLevel: "required", evidenceQuote: null }],
    });
    const result = await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "new", descriptionHash: "hash-2" })
    );

    expect(result).toHaveLength(1);
    expect(result[0].termText).toBe("Python");
    const allRows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobRequirements).where(eq(schema.jobRequirements.jobId, jobId)));
    expect(allRows).toHaveLength(1);
  });

  it("stores an empty result without error when the model finds no requirements", async () => {
    vi.mocked(extractJobRequirements).mockResolvedValue({ requirements: [] });
    const jobId = await seedJob("hash-1");
    const result = await withUserContext(testDb.db, USER, (tx) =>
      ensureJobRequirements(tx, ENV, FAKE_CLIENT, { id: jobId, title: "Engineer", descriptionText: "text", descriptionHash: "hash-1" })
    );
    expect(result).toEqual([]);
  });
});
