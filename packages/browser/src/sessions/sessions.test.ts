import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "../testing";
import {
  createSession, transitionSession, failSession, requestCancel, isCancelRequested, sweepInterruptedSessions,
  getSession, getJobAutofillOverview, loadAutofillContext,
} from "../index";
import { AutomationError } from "../errors";

const USER = "00000000-0000-0000-0000-0000000008a3";
const OTHER = "00000000-0000-0000-0000-0000000008a4";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER);
  await t.close();
});

const errorClass = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof AutomationError ? `${e.errorClass}${e.detail ? `:${e.detail}` : ""}` : String(e);
  }
};

describe("createSession", () => {
  it("creates a queued session with the built form URL", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { sourceKind: "lever", slug: "acme", externalId: "abc-1" });
    const row = await createSession(t.db, USER, jobId);
    expect(row).toMatchObject({ jobId, status: "queued", portal: "lever", adapterVersion: "lever-v1", formUrl: "https://jobs.lever.co/acme/abc-1/apply" });
  });

  it("rejects an unknown job, a missing profile, an unsupported job and a second active session", async () => {
    expect(await errorClass(createSession(t.db, USER, "11111111-1111-4111-8111-111111111111"))).toBe("job_not_found");
    const noProfile = await seedAutofillJob(t.adminSql, USER, { withProfile: false });
    expect(await errorClass(createSession(t.db, USER, noProfile.jobId))).toBe("profile_missing");
    await wipeUser(t.adminSql, USER);
    const upload = await seedAutofillJob(t.adminSql, USER, { sourceKind: "upload" });
    expect(await errorClass(createSession(t.db, USER, upload.jobId))).toBe("unsupported:no_supported_posting");
    await wipeUser(t.adminSql, USER);
    const ok = await seedAutofillJob(t.adminSql, USER);
    await createSession(t.db, USER, ok.jobId);
    expect(await errorClass(createSession(t.db, USER, ok.jobId))).toBe("session_active");
  });

  it("does not see another user's job", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, OTHER);
    await seedAutofillJob(t.adminSql, USER);
    expect(await errorClass(createSession(t.db, USER, jobId))).toBe("job_not_found");
  });
});

describe("transitions", () => {
  it("moves only from the expected statuses and stamps ended_at on terminal ones", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId);
    expect(await transitionSession(t.db, USER, id, ["filling"], "awaiting_user")).toBeNull();
    const launching = await transitionSession(t.db, USER, id, ["queued"], "launching", { startedAt: new Date() });
    expect(launching).toMatchObject({ status: "launching", endedAt: null });
    expect(launching!.startedAt).not.toBeNull();
    const audit = [{ key: "f0", label: "Email", required: true, canonical: "email" as const, action: "filled" as const, reason: null, valueSource: "profile.email", verified: true }];
    const done = await transitionSession(t.db, USER, id, ["launching"], "needs_manual", { fieldAudit: audit, errorCode: "health_check_failed" });
    expect(done).toMatchObject({ status: "needs_manual", errorCode: "health_check_failed", fieldAudit: audit });
    expect(done!.endedAt).not.toBeNull();
    expect(await failSession(t.db, USER, id, "x")).toBeNull(); // already terminal
  });

  it("cancels a queued session immediately and flags an active one", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const queued = await insertSessionRow(t.adminSql, USER, jobId);
    expect(await requestCancel(t.db, USER, queued)).toMatchObject({ status: "abandoned", errorCode: "cancelled" });
    expect(await errorClass(requestCancel(t.db, USER, queued))).toBe("not_cancellable");
    const active = await insertSessionRow(t.adminSql, USER, jobId, { status: "awaiting_user" });
    expect(await isCancelRequested(t.db, USER, active)).toBe(false);
    const flagged = await requestCancel(t.db, USER, active);
    expect(flagged.status).toBe("awaiting_user");
    expect(await isCancelRequested(t.db, USER, active)).toBe(true);
    expect(await errorClass(requestCancel(t.db, USER, "11111111-1111-4111-8111-111111111111"))).toBe("not_found");
  });

  it("sweeps launching/filling/awaiting_user to failed but leaves queued alone", async () => {
    const a = await seedAutofillJob(t.adminSql, USER);
    const awaiting = await insertSessionRow(t.adminSql, USER, a.jobId, { status: "awaiting_user" });
    expect(await sweepInterruptedSessions(t.db, USER)).toBe(1);
    expect(await getSession(t.db, USER, awaiting)).toMatchObject({ status: "failed", errorCode: "worker_restart" });
    const queued = await insertSessionRow(t.adminSql, USER, a.jobId);
    expect(await sweepInterruptedSessions(t.db, USER)).toBe(0);
    expect((await getSession(t.db, USER, queued))!.status).toBe("queued");
  });
});

describe("reads", () => {
  it("summarizes a job's autofill state", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    await insertSessionRow(t.adminSql, USER, jobId, { status: "failed" });
    const overview = await getJobAutofillOverview(t.db, USER, jobId);
    expect(overview).toMatchObject({
      support: { supported: true, portal: "greenhouse", formUrl: "https://job-boards.greenhouse.io/acme/jobs/1234567" },
      resumeAvailable: true,
      applicationId: null,
    });
    expect(overview!.sessions).toHaveLength(1);
    expect(await getJobAutofillOverview(t.db, USER, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("loads the autofill context: profile, active goal constraints and the newest PDFs", async () => {
    const { jobId, resumeDocumentId, coverLetterDocumentId } = await seedAutofillJob(t.adminSql, USER, { withCoverLetter: true });
    const id = await insertSessionRow(t.adminSql, USER, jobId);
    const ctx = await loadAutofillContext(t.db, USER, id);
    expect(ctx.profile).toEqual({
      fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin",
    });
    expect(ctx.goal).toMatchObject({ visaSponsorshipRequired: false, salaryTargetCurrency: "EUR", salaryTargetIsParsed: true });
    expect(Number(ctx.goal!.salaryTargetNormalized)).toBe(85000);
    expect(ctx.resumeDocument?.id).toBe(resumeDocumentId);
    expect(ctx.coverLetterDocument?.id).toBe(coverLetterDocumentId);
  });

  it("prefers the newest tailored resume PDF for autofill, falling back to the full resume", async () => {
    const { jobId, resumeDocumentId, tailoredResumeDocumentId } = await seedAutofillJob(t.adminSql, USER, { withTailoredResume: true });
    const id = await insertSessionRow(t.adminSql, USER, jobId);
    const ctx = await loadAutofillContext(t.db, USER, id);
    expect(ctx.resumeDocument?.id).toBe(tailoredResumeDocumentId);
    expect(ctx.resumeDocument?.id).not.toBe(resumeDocumentId);
  });

  it("counts a tailored resume as an available resume", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { withResume: false, withTailoredResume: true });
    expect((await getJobAutofillOverview(t.db, USER, jobId))?.resumeAvailable).toBe(true);
  });

  it("loads a null goal when there is no active goal", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { goal: null, withResume: false });
    const ctx = await loadAutofillContext(t.db, USER, await insertSessionRow(t.adminSql, USER, jobId));
    expect(ctx.goal).toBeNull();
    expect(ctx.resumeDocument).toBeNull();
  });
});
