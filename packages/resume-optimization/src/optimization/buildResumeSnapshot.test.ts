import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { buildResumeSnapshot } from "./buildResumeSnapshot";

const USER = "00000000-0000-0000-0000-0000000000f8";
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

describe("buildResumeSnapshot", () => {
  it("returns an empty catalog and a stable hash when the user has no profile data", async () => {
    const snapshot = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    expect(snapshot.catalog).toEqual([]);
    expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes a work experience bullet with its role as context", async () => {
    const [exp] = await testDb.adminSql`
      INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${USER}, 'Acme', 'Engineer', 0) RETURNING id`;
    await testDb.adminSql`
      INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
      VALUES (${USER}, ${exp.id}, 'Built a data pipeline', 0)`;

    const snapshot = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    expect(snapshot.catalog).toHaveLength(1);
    expect(snapshot.catalog[0]).toMatchObject({ sourceType: "work_experience_bullet", text: "Built a data pipeline", context: "Acme — Engineer" });
  });

  it("includes achievements, projects, certifications, education, and skills", async () => {
    await testDb.adminSql`INSERT INTO achievements (user_id, description, display_order) VALUES (${USER}, 'Won a hackathon', 0)`;
    await testDb.adminSql`INSERT INTO projects (user_id, name, description) VALUES (${USER}, 'Side Project', 'A tool for X')`;
    await testDb.adminSql`INSERT INTO certifications (user_id, name, issuer) VALUES (${USER}, 'AWS SA', 'Amazon')`;
    await testDb.adminSql`INSERT INTO education (user_id, institution, degree, field_of_study, display_order) VALUES (${USER}, 'MIT', 'BS', 'CS', 0)`;
    await testDb.adminSql`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Python')`;

    const snapshot = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    const byType = Object.fromEntries(snapshot.catalog.map((e) => [e.sourceType, e]));
    expect(byType.achievement).toMatchObject({ text: "Won a hackathon", context: null });
    expect(byType.project).toMatchObject({ text: "A tool for X", context: "Side Project" });
    expect(byType.certification).toMatchObject({ text: "AWS SA", context: "Amazon" });
    expect(byType.education).toMatchObject({ text: "BS in CS", context: "MIT" });
    expect(byType.skill).toMatchObject({ text: "Python", context: null });
  });

  it("orders projects, certifications, and skills by their own displayOrder, not insertion order", async () => {
    await testDb.adminSql`INSERT INTO projects (user_id, name, description, display_order) VALUES (${USER}, 'Second Project', 'B', 1), (${USER}, 'First Project', 'A', 0)`;
    await testDb.adminSql`INSERT INTO certifications (user_id, name, issuer, display_order) VALUES (${USER}, 'Second Cert', 'X', 1), (${USER}, 'First Cert', 'Y', 0)`;
    await testDb.adminSql`INSERT INTO skills (user_id, name, display_order) VALUES (${USER}, 'SQL', 1), (${USER}, 'Python', 0)`;

    const snapshot = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    const projectTexts = snapshot.catalog.filter((e) => e.sourceType === "project").map((e) => e.context);
    const certTexts = snapshot.catalog.filter((e) => e.sourceType === "certification").map((e) => e.text);
    const skillTexts = snapshot.catalog.filter((e) => e.sourceType === "skill").map((e) => e.text);
    expect(projectTexts).toEqual(["First Project", "Second Project"]);
    expect(certTexts).toEqual(["First Cert", "Second Cert"]);
    expect(skillTexts).toEqual(["Python", "SQL"]);
  });

  it("is idempotent: re-running against unchanged data produces the same contentHash", async () => {
    await testDb.adminSql`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Python'), (${USER}, 'SQL')`;

    const first = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    const second = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    expect(second.contentHash).toBe(first.contentHash);
  });

  it("changes contentHash when the underlying data changes", async () => {
    await testDb.adminSql`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Python')`;
    const before = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    await testDb.adminSql`INSERT INTO skills (user_id, name) VALUES (${USER}, 'SQL')`;
    const after = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    expect(after.contentHash).not.toBe(before.contentHash);
  });
});
