import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../test/documentsDb";

const USER = "00000000-0000-0000-0000-000000000d21";
const TOKEN = "z".repeat(32);
const envState = vi.hoisted(() => ({ compilerUrl: undefined as string | undefined }));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d21",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
    RESUME_PAPER_SIZE: "a4",
    LATEX_COMPILER_URL: envState.compilerUrl,
    LATEX_COMPILER_TOKEN: envState.compilerUrl ? "z".repeat(32) : undefined,
  }),
}));

let admin: postgres.Sql;
let fake: http.Server | undefined;
const seen: { auth?: string; body?: string }[] = [];

async function startFakeCompiler(status = 200): Promise<void> {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      if (status !== 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: "x", line: 3 })); return; }
      res.writeHead(200, { "Content-Type": "application/pdf", "X-Page-Count": "1", "X-Tex-Version": "pdfTeX fake" });
      res.end("%PDF-fake");
    });
  });
  await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
  envState.compilerUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}

beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(() => wipeDocumentsUser(admin, USER));
afterEach(async () => {
  envState.compilerUrl = undefined;
  seen.length = 0;
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = undefined;
});
afterAll(async () => { await wipeDocumentsUser(admin, USER); await admin.end(); });

const { POST } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/documents", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

describe("POST /api/documents — tailored_resume", () => {
  it("rejects tex for other kinds and docx for tailored_resume (400)", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    expect((await post({ kind: "resume", jobId, sourceId: optimizationId, format: "tex" })).status).toBe(400);
    expect((await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "docx" })).status).toBe(400);
  });

  it("returns 503 with the start command for a PDF when no compiler is configured", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("--profile latex up -d latex-compiler");
  });

  it("exports .tex without a compiler (201, page count not verified)", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "tex" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document).toMatchObject({ kind: "tailored_resume", format: "tex", sourceVersion: 2, downloadFilename: "Jane Doe - GitLab - Resume.tex" });
    expect(body.document.details).toMatchObject({ pageVerified: false, pageCount: null, includedCount: 1, totalCount: 1 });
    expect(body.omittedItems).toEqual([]);
  });

  it("exports a PDF through the configured compiler with the bearer token", async () => {
    await startFakeCompiler();
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(201);
    expect((await res.json()).document.details).toMatchObject({ pageVerified: true, pageCount: 1 });
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body).toContain("\\item Built A");
  });

  it("maps a compile failure to 502 without exposing compiler output", async () => {
    await startFakeCompiler(422);
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("The resume could not be typeset. This is a bug; the compiler log has the line number.");
  });

  it("returns 422 naming where an unsupported character is", async () => {
    const { jobId } = await seedResumeExport(admin, USER);
    await admin`UPDATE work_experience_bullets SET text = 'Built 😀' WHERE user_id = ${USER}`;
    // seedResumeExport's optimization hash is now stale; re-seed one matching the edited profile.
    await admin`DELETE FROM resume_optimizations WHERE user_id = ${USER}`;
    const { createDbClient, closeDbClient, withUserContext } = await import("@ai-career/db");
    const { buildResumeSnapshot } = await import("@ai-career/resume-optimization");
    const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
    const { contentHash } = await withUserContext(db, USER, (tx) => buildResumeSnapshot(tx));
    await closeDbClient(db);
    const [goal] = await admin`SELECT id FROM career_goals WHERE user_id = ${USER}`;
    const [opt] = await admin`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${USER}, ${jobId}, ${goal.id}, 3, ${contentHash}, '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    const res = await post({ kind: "tailored_resume", jobId, sourceId: opt.id, format: "tex" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Your profile contains a character the LaTeX resume can't typeset (Experience, entry 1, bullet 1). Edit your profile to remove it.");
  });
});
