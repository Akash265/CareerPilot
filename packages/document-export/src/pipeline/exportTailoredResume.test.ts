import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withUserContext } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, insertOptimization, insertRequirement, type TestDb } from "../testing/db";
import { exportTailoredResume } from "./exportTailoredResume";
import { DocumentExportError } from "../errors";
import type { TexCompiler } from "../render/compileTex";
import { TEX_TEMPLATE_VERSION } from "../model/types";

const USER = "00000000-0000-0000-0000-000000000d20";
const storage = testStorageClient();
let testDb: TestDb;

const fakeCompiler = (pages: number[] = [1]) => {
  const calls: string[] = [];
  const compiler: TexCompiler = {
    async compile(tex) { calls.push(tex); return { pdf: Buffer.from(`%PDF fake ${calls.length}`), pageCount: pages.shift() ?? 1, texVersion: "pdfTeX test", freeSpacePt: null }; },
  };
  return { compiler, calls };
};
const failing = (errorClass: "compiler_unavailable" | "compiler_busy" | "compile_failed"): TexCompiler => ({
  async compile() { throw new DocumentExportError(errorClass); },
});

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

async function seed() {
  const { jobId, goalId } = await seedResumeFixture(testDb, USER);
  await insertRequirement(testDb, USER, jobId, "Python", "required");
  const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
  const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [], contentHash);
  return { jobId, optimizationId };
}

beforeAll(async () => { testDb = await openTestDb(); });
afterAll(async () => {
  const keys = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(() => wipeUser(testDb.adminSql, USER));

describe("exportTailoredResume", () => {
  it("refuses a PDF without a compiler before touching the DB", async () => {
    await expect(exportTailoredResume(testDb.db, storage, null, { userId: USER, jobId: "00000000-0000-0000-0000-000000000000", optimizationId: "00000000-0000-0000-0000-000000000000", format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compiler_unavailable" });
  });

  it("stores a compiled PDF with details and returns omitted item text", async () => {
    const { jobId, optimizationId } = await seed();
    const { compiler, calls } = fakeCompiler([1]);
    const { document, omittedItems } = await exportTailoredResume(testDb.db, storage, compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    expect(document).toMatchObject({ kind: "tailored_resume", format: "pdf", resumeOptimizationId: optimizationId, rendererVersion: `tex-${TEX_TEMPLATE_VERSION}`, downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(document.details).toEqual({ pageCount: 1, pageVerified: true, includedCount: 2, totalCount: 2, omitted: [] });
    expect(omittedItems).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("\\item Built A");
    expect((await readAll(await getGeneratedDocument(storage, document.objectKey))).toString()).toBe("%PDF fake 1");
  });

  it("stores .tex source; without a compiler it is estimate-only (pageVerified false)", async () => {
    const { jobId, optimizationId } = await seed();
    const { document } = await exportTailoredResume(testDb.db, storage, null, { userId: USER, jobId, optimizationId, format: "tex", paperSize: "letter" });
    expect(document).toMatchObject({ kind: "tailored_resume", format: "tex", downloadFilename: "Jane Doe - GitLab - Resume.tex" });
    expect(document.details).toMatchObject({ pageCount: null, pageVerified: false });
    const tex = (await readAll(await getGeneratedDocument(storage, document.objectKey))).toString("utf8");
    expect(tex).toContain("\\usepackage[letterpaper,margin=0.6in]{geometry}");
    expect(tex).not.toContain("1 Secret Street");
  });

  it("falls back to the estimate for .tex when the configured compiler is down, but not for PDF", async () => {
    const { jobId, optimizationId } = await seed();
    const { document } = await exportTailoredResume(testDb.db, storage, failing("compiler_busy"), { userId: USER, jobId, optimizationId, format: "tex", paperSize: "a4" });
    expect(document.details).toMatchObject({ pageVerified: false });
    await expect(exportTailoredResume(testDb.db, storage, failing("compiler_unavailable"), { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compiler_unavailable" });
    await expect(exportTailoredResume(testDb.db, storage, failing("compile_failed"), { userId: USER, jobId, optimizationId, format: "tex", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compile_failed" });
  });

  it("reuses the stored row for an identical export (hash includes details)", async () => {
    const { jobId, optimizationId } = await seed();
    const first = await exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    const second = await exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    expect(second.document.id).toBe(first.document.id);
  });

  it("refuses an unsupported character with its location, before compiling", async () => {
    // Not seed(): insertOptimization always writes version 1, so a second optimization for the job would collide.
    const { jobId, goalId } = await seedResumeFixture(testDb, USER);
    await testDb.adminSql`UPDATE work_experience_bullets SET text = 'Built 中文 search' WHERE user_id = ${USER} AND text = 'Built B'`;
    const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [], contentHash);
    const { compiler, calls } = fakeCompiler();
    await expect(exportTailoredResume(testDb.db, storage, compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "unsupported_character", detail: "Experience, entry 1, bullet 2" });
    expect(calls).toHaveLength(0);
  });

  describe("refill from the real page (D217)", () => {
    // A long single role: the estimate cuts its lowest-ranked bullets; each bullet is two estimated lines.
    const longBullet = (i: number) => `Built and ran a reporting pipeline number ${i} for the finance team, cutting the monthly close from five days to two days`;
    async function seedLong(lastBullet?: string) {
      const { jobId, goalId } = await seedResumeFixture(testDb, USER);
      await insertRequirement(testDb, USER, jobId, "Python", "required");
      const [exp] = await testDb.adminSql`SELECT id FROM work_experiences WHERE user_id = ${USER}`;
      for (let i = 0; i < 40; i++) {
        const text = i === 39 && lastBullet ? lastBullet : longBullet(i);
        await testDb.adminSql`INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order) VALUES (${USER}, ${exp.id}, ${text}, ${10 + i})`;
      }
      const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
      return { jobId, optimizationId: await insertOptimization(testDb, USER, jobId, goalId, [], contentHash) };
    }
    const itemsIn = (tex: string) => tex.split("\\item ").length - 1;

    it("stores the refilled page: two more bullets than the estimate fit, with matching details", async () => {
      const { jobId, optimizationId } = await seedLong();
      const baseline = await exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
      const fitted = baseline.document.details!.includedCount;
      expect(fitted).toBeLessThan(baseline.document.details!.totalCount); // the estimate did cut something

      // The real page holds exactly two more bullets than the estimate allowed; each takes 30pt.
      const capacity = itemsIn("") + fitted + 2;
      const calls: string[] = [];
      const page: TexCompiler = {
        async compile(tex) {
          calls.push(tex);
          const k = itemsIn(tex);
          return { pdf: Buffer.from(`%PDF ${k}`), pageCount: k <= capacity ? 1 : 2, texVersion: "pdfTeX test", freeSpacePt: Math.max(0, capacity - k) * 30 };
        },
      };
      const { document, omittedItems } = await exportTailoredResume(testDb.db, storage, page, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
      expect(document.details).toMatchObject({ pageCount: 1, pageVerified: true, includedCount: fitted + 2 });
      expect(document.details!.omitted.length).toBe(baseline.document.details!.omitted.length - 2);
      expect(omittedItems.length).toBe(baseline.omittedItems.length - 2);
      expect(document.id).not.toBe(baseline.document.id);
      expect((await readAll(await getGeneratedDocument(storage, document.objectKey))).toString()).toBe(`%PDF ${fitted + 2}`);
      expect(calls.length).toBe(3); // the fit, then two refills; a third does not fit the 0pt left and is not compiled
    });

    it("never compiles a cut item pdflatex cannot typeset, and still exports", async () => {
      // The only removable item is a project far longer than the page, holding a character pdflatex cannot typeset.
      // The estimate cuts it (so the 422 check never sees it); the page reports room, so the refill reaches it first.
      const { jobId, goalId } = await seedResumeFixture(testDb, USER);
      await insertRequirement(testDb, USER, jobId, "Python", "required");
      await testDb.adminSql`INSERT INTO projects (user_id, name, description, display_order)
                            VALUES (${USER}, 'Search', ${"中文 search in Python. ".repeat(320)}, 0)`;
      const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
      const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [], contentHash);
      const calls: string[] = [];
      const roomy: TexCompiler = {
        async compile(tex) { calls.push(tex); return { pdf: Buffer.from("%PDF"), pageCount: 1, texVersion: "pdfTeX test", freeSpacePt: 2000 }; },
      };
      const { document } = await exportTailoredResume(testDb.db, storage, roomy, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
      expect(document.details).toMatchObject({ pageCount: 1, omitted: [{ sourceType: "project", reason: "page_limit" }] });
      expect(calls).toHaveLength(1); // the fit only: the project's refill page is refused before compiling
      expect(calls.some((tex) => tex.includes("中"))).toBe(false);
    });
  });

  it("keeps the D84 checks (profile_changed)", async () => {
    const { jobId, optimizationId } = await seed();
    await testDb.adminSql`UPDATE work_experience_bullets SET text = 'Changed' WHERE user_id = ${USER} AND text = 'Built A'`;
    await expect(exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "profile_changed" });
  });
});
