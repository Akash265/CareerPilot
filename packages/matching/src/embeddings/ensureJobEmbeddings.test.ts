import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureJobEmbeddings, EMBEDDING_BATCH_SIZE } from "./ensureJobEmbeddings";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn() }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e2";
const ENV = { EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" };
let testDb: TestDb;

// jobs.embedding is a vector(1024) column (Task 3's migration): Postgres rejects a shorter vector
// outright, so every fixture/mock embedding must be exactly 1024 long.
function vec(...head: number[]): number[] {
  return [...head, ...new Array(1024 - head.length).fill(0)];
}

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(embedTexts).mockReset();
  await wipeUser(testDb.adminSql, USER);
});

async function seedJob(descriptionHash: string, embedding: number[] | null = null, embeddingContentHash: string | null = null) {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       first_seen_at, last_verified_at, embedding, embedding_content_hash, embedding_model)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'We use SQL.', ${descriptionHash}, now(), now(),
            ${embedding ? testDb.adminSql`${JSON.stringify(embedding)}::vector` : null}, ${embeddingContentHash}, ${embedding ? "voyage-3.5" : null})
    RETURNING id`;
  return job.id as string;
}

async function seedManyJobs(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await seedJob(`hash-${i}`));
  return ids;
}

describe("ensureJobEmbeddings", () => {
  it("embeds a job with no embedding yet", async () => {
    vi.mocked(embedTexts).mockResolvedValue([vec(0.1, 0.2)]);
    const jobId = await seedJob("hash-1");
    const result = await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toEqual(vec(0.1, 0.2));
    expect(row.embeddingContentHash).toBe("hash-1");
    expect(result).toEqual({ embedded: 1, failed: 0 });
  });

  it("skips a job whose embeddingContentHash already matches its current descriptionHash", async () => {
    const jobId = await seedJob("hash-1", vec(0.9, 0.9), "hash-1");
    const result = await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    expect(embedTexts).not.toHaveBeenCalled();
    expect(result).toEqual({ embedded: 0, failed: 0 });
  });

  it("re-embeds a job whose descriptionHash changed since its stored embeddingContentHash", async () => {
    vi.mocked(embedTexts).mockResolvedValue([vec(0.5, 0.5)]);
    const jobId = await seedJob("hash-2", vec(0.1, 0.1), "hash-1");
    await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toEqual(vec(0.5, 0.5));
    expect(row.embeddingContentHash).toBe("hash-2");
  });

  it("leaves a job's embedding untouched and does not throw when Voyage fails", async () => {
    vi.mocked(embedTexts).mockRejectedValue(new Error("voyage down"));
    const jobId = await seedJob("hash-1");
    const result = await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toBeNull();
    expect(result).toEqual({ embedded: 0, failed: 1 });
  });

  it("chunks stale jobs into EMBEDDING_BATCH_SIZE-sized batches, calling embedTexts once per chunk", async () => {
    const total = EMBEDDING_BATCH_SIZE + 5;
    vi.mocked(embedTexts).mockImplementation(async (_env, texts: string[]) => texts.map(() => vec(0.3, 0.3)));
    const ids = await seedManyJobs(total);

    const result = await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, ids));

    expect(embedTexts).toHaveBeenCalledTimes(2);
    const callSizes = vi.mocked(embedTexts).mock.calls.map(([, texts]) => (texts as string[]).length).sort((a, b) => b - a);
    expect(callSizes).toEqual([EMBEDDING_BATCH_SIZE, 5]);
    expect(result).toEqual({ embedded: total, failed: 0 });
  });

  it("does not let one chunk's failure prevent other chunks from succeeding", async () => {
    const total = EMBEDDING_BATCH_SIZE + 5;
    vi.mocked(embedTexts)
      .mockImplementationOnce(async () => {
        throw new Error("voyage down for this chunk");
      })
      .mockImplementationOnce(async (_env, texts: string[]) => texts.map(() => vec(0.4, 0.4)));
    const ids = await seedManyJobs(total);

    const result = await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, ids));

    // chunk() always fills the first chunk to full size before starting the second, so the failing
    // (first) call always covers exactly EMBEDDING_BATCH_SIZE jobs, regardless of row order.
    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ embedded: 5, failed: EMBEDDING_BATCH_SIZE });

    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(inArray(schema.jobs.id, ids)));
    const embeddedCount = rows.filter((r) => r.embedding !== null).length;
    expect(embeddedCount).toBe(5);
  });
});
