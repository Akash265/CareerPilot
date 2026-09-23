// End-to-end smoke test over real HTTP, the real queue, and the real matching + ingestion workers.
// Prerequisites (four terminals):
//   1. fake Anthropic: pnpm --filter @ai-career/matching-worker e2e:fake-anthropic
//   2. ingestion worker (to process the upload below): pnpm --filter @ai-career/job-ingestion start
//   3. matching worker: ANTHROPIC_BASE_URL=http://localhost:4012 pnpm --filter @ai-career/matching-worker start
//   4. web: ANTHROPIC_BASE_URL=http://localhost:4012 pnpm --filter web start   (after `pnpm --filter web build`)
//      -- web also needs the fake server: /api/career-goal/parse calls Anthropic directly (Phase 3),
//      not through the matching worker.
// Then: pnpm --filter @ai-career/matching-worker e2e:smoke
//
// Expects a database where a candidate profile already exists (Phase 2's flow) but no confirmed
// career goal and no jobs -- point it at a scratch database, same convention as
// services/job-ingestion/e2e/smoke.ts, and seed the profile first via the web UI or API.
const WEB = process.env.WEB_URL ?? "http://localhost:3000";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${WEB}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (path: string, body?: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const patch = (path: string, body: unknown) =>
  call(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutSeconds = 60): Promise<T> {
  for (let i = 0; i < timeoutSeconds; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  // 1. Career goal: parse + confirm with a remote Data Engineer preference and SQL/Python skills.
  const parsed = await post("/api/career-goal/parse", { rawText: "Remote Data Engineer roles, at least 2 years experience, skills SQL and Python." });
  // Detail is narrowed to status + error class only (never `body.draft`, the AI-extracted goal
  // content) -- this file's own binding logging constraint: error classes, ids and counts only.
  check(
    "career goal parsed",
    parsed.status === 200 && parsed.body?.status === "parsed",
    JSON.stringify({ httpStatus: parsed.status, bodyStatus: parsed.body?.status, error: parsed.body?.error })
  );
  const goalId = parsed.body.goalId;
  const confirmed = await post("/api/career-goal/confirm", {
    goalId,
    constraints: {
      targetRoles: ["Data Engineer"], seniority: null, locations: [], workMode: "remote", minExperienceYears: 2,
      employmentType: null, salaryFloorRaw: null, salaryFloorNormalized: null, salaryCurrency: null, salaryIsParsed: false,
      salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false,
      visaSponsorshipRequired: null, skills: ["SQL", "Python"], preferredIndustries: [], excludedIndustries: [],
      preferredCompanies: [], excludedCompanies: ["Excluded Co"], hardConstraints: [],
    },
  });
  check("career goal confirmed", confirmed.status === 200, JSON.stringify(confirmed.body));

  // 2. Seed two jobs via the existing multipart upload path (Phase 4, .json file + consentConfirmed
  //    form field -- see services/job-ingestion/e2e/smoke.ts for the same recipe): one clearly
  //    eligible and strong, one excluded by company. Field names match packages/ingestion's upload
  //    header aliases (title, company, location, description, url, id).
  const uploadRecords = [
    { id: "e2e-1", title: "Senior Data Engineer", company: "Acme", location: "Remote", description: "We use SQL and Python daily. 3+ years experience.", url: "https://example.com/1" },
    { id: "e2e-2", title: "Data Engineer", company: "Excluded Co", location: "Remote", description: "SQL required.", url: "https://example.com/2" },
  ];
  const uploadForm = new FormData();
  uploadForm.set("file", new File([JSON.stringify(uploadRecords)], "e2e-jobs.json"));
  uploadForm.set("consentConfirmed", "true");
  const upload = await fetch(`${WEB}/api/job-sources/upload`, { method: "POST", body: uploadForm });
  check("jobs uploaded", upload.status === 201, await upload.text());

  await waitFor("uploaded jobs to appear", async () => {
    const jobs = await call("/api/jobs?status=all");
    return jobs.body.total >= 2 ? jobs.body : null;
  });

  // 3. Trigger matching and wait for a completed run.
  const run = await post("/api/matches/run");
  check("matching run queued", run.status === 202, JSON.stringify(run.body));
  const finished = await waitFor("matching run to finish", async () => {
    const latest = await call("/api/matches/runs/latest");
    return latest.body.run && latest.body.run.status !== "running" ? latest.body.run : null;
  });
  check("matching run completed", finished.status === "completed", JSON.stringify(finished));

  // 4. Ranked list: the eligible job should be ranked with a score and a fake explanation; the
  //    excluded-company job should not appear in the eligible list.
  const eligible = await call("/api/matches?eligible=true");
  // Detail is count + job ids only -- never the full match body, which carries job title/company/
  // location and match.explanation (AI-generated summary/strongMatches/gaps) text.
  check(
    "exactly one eligible match",
    eligible.body.matches.length === 1,
    JSON.stringify({ count: eligible.body.matches.length, jobIds: eligible.body.matches.map((m: { jobId: string }) => m.jobId) })
  );
  const match = eligible.body.matches[0];
  check("eligible match has an overall score", typeof match?.match?.overallScore === "number");
  check("eligible match has the fake explanation summary", match?.match?.explanation?.summary === "Fake explanation from the E2E stand-in server.");

  const ineligible = await call("/api/matches?eligible=false");
  check("excluded-company job is listed as ineligible with a reason", ineligible.body.matches.some((m: { match: { ineligibleReason: string | null } }) => m.match.ineligibleReason?.includes("Excluded Co")));

  // 5. Dismiss the eligible match and confirm a recompute keeps it ineligible.
  const dismissed = await patch(`/api/matches/${match.jobId}`, { userAction: "dismissed" });
  check("dismiss accepted", dismissed.status === 200);
  await post("/api/matches/run");
  await waitFor("second matching run to finish", async () => {
    const latest = await call("/api/matches/runs/latest");
    return latest.body.run && latest.body.run.status !== "running" ? latest.body.run : null;
  });
  const afterDismiss = await call("/api/matches?eligible=true");
  // Same narrowing as above: total + job ids only, never the full match body.
  check(
    "dismissed job no longer appears as eligible after a recompute",
    afterDismiss.body.total === 0,
    JSON.stringify({ total: afterDismiss.body.total, jobIds: afterDismiss.body.matches.map((m: { jobId: string }) => m.jobId) })
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
