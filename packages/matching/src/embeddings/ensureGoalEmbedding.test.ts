import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureGoalEmbedding } from "./ensureGoalEmbedding";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn() }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e1";
const ENV = { EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" };
let testDb: TestDb;

// jobs.embedding / career_goal_constraints.embedding are vector(1024) columns (Task 3's migration):
// Postgres rejects a shorter vector outright, so every fixture embedding must be exactly 1024 long.
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

async function seedConstraints(): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles in Berlin', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [constraints] = await testDb.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, skills)
    VALUES (${USER}, ${goal.id}, ARRAY['Data Engineer'], ARRAY['SQL','Python']) RETURNING id`;
  return constraints.id as string;
}

describe("ensureGoalEmbedding", () => {
  it("embeds targetRoles + skills + rawText and stores the result", async () => {
    vi.mocked(embedTexts).mockResolvedValue([vec(0.1, 0.2, 0.3)]);
    const constraintsId = await seedConstraints();
    const embedding = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(embedding).toEqual(vec(0.1, 0.2, 0.3));
    expect(embedTexts).toHaveBeenCalledWith(ENV, [expect.stringContaining("Data Engineer")]);
    const [row] = await withUserContext(testDb.db, USER, (tx) =>
      tx.select().from(schema.careerGoalConstraints).where(eq(schema.careerGoalConstraints.id, constraintsId))
    );
    expect(row.embedding).toEqual(vec(0.1, 0.2, 0.3));
    expect(row.embeddingModel).toBe("voyage-3.5");
  });

  it("returns the existing embedding without calling Voyage again when already set", async () => {
    vi.mocked(embedTexts).mockResolvedValue([vec(0.9, 0.9, 0.9)]);
    const constraintsId = await seedConstraints();
    await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    vi.mocked(embedTexts).mockClear();
    const second = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(second).toEqual(vec(0.9, 0.9, 0.9));
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("returns null and leaves the row unembedded when Voyage fails, without throwing", async () => {
    vi.mocked(embedTexts).mockRejectedValue(new Error("voyage down"));
    const constraintsId = await seedConstraints();
    const embedding = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(embedding).toBeNull();
  });
});
