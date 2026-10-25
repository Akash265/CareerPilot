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

  it("keeps the D84 checks (profile_changed)", async () => {
    const { jobId, optimizationId } = await seed();
    await testDb.adminSql`UPDATE work_experience_bullets SET text = 'Changed' WHERE user_id = ${USER} AND text = 'Built A'`;
    await expect(exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "profile_changed" });
  });
});
