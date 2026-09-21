// End-to-end smoke test over real HTTP, the real queue and the real worker.
// Prerequisites (three terminals, see the plan's Task 19):
//   1. fake ATS:  pnpm --filter @ai-career/job-ingestion e2e:fake-ats
//   2. worker:    GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011 pnpm --filter @ai-career/job-ingestion start
//   3. web:       pnpm --filter web start     (after `pnpm --filter web build`)
// Then: pnpm --filter @ai-career/job-ingestion e2e:smoke
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ATS = process.env.FAKE_ATS_URL ?? "http://localhost:4011";

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

interface Source { id: string; kind: string; lastRunStatus: string | null; lastRun: { fetched: number; created: number; closed: number } | null }
async function sources(): Promise<Source[]> {
  return (await call("/api/job-sources")).body.sources;
}
async function waitForRun(id: string, previousRunAt: string | null): Promise<Source> {
  for (let i = 0; i < 60; i++) {
    const s = (await sources()).find((x) => x.id === id) as (Source & { lastRunAt: string | null }) | undefined;
    if (s && s.lastRunAt && s.lastRunAt !== previousRunAt && s.lastRunStatus !== "running") return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the run to finish (is the worker running?)");
}
async function ensureSource(kind: "greenhouse" | "lever"): Promise<string> {
  const created = await post("/api/job-sources", { kind, slug: "fakeco", companyName: "FakeCo" });
  if (created.status === 201) return created.body.source.id;
  const existing = (await sources()).find((s) => s.kind === kind);
  if (!existing) throw new Error(`could not create or find the ${kind} source`);
  return existing.id;
}
async function runAndWait(id: string) {
  const before = ((await sources()).find((s) => s.id === id) as { lastRunAt?: string | null }).lastRunAt ?? null;
  const queued = await post(`/api/job-sources/${id}/run`);
  if (queued.status !== 202) throw new Error(`run was not queued: ${queued.status}`);
  return waitForRun(id, before);
}

async function main() {
  await fetch(`${ATS}/__admin/reset`, { method: "POST" });
  const gh = await ensureSource("greenhouse");
  const lv = await ensureSource("lever");

  const refused = await post(`/api/job-sources/${gh}/run`);
  check("a source cannot run before it is enabled and consented (D3)", refused.status === 409);
  const noConsent = await patch(`/api/job-sources/${gh}`, { enabled: true });
  check("enabling without the Terms-of-Service confirmation is refused", noConsent.status === 400);

  for (const id of [gh, lv]) await patch(`/api/job-sources/${id}`, { enabled: true, consentConfirmed: true });
  const ghRun = await runAndWait(gh);
  const lvRun = await runAndWait(lv);
  check("greenhouse run fetched 5 and created 5", ghRun.lastRunStatus === "succeeded" && ghRun.lastRun?.fetched === 5 && ghRun.lastRun.created === 5, JSON.stringify(ghRun.lastRun));
  check("lever run fetched 3 and created 3 (one of them links to an existing job)", lvRun.lastRunStatus === "succeeded" && lvRun.lastRun?.fetched === 3, JSON.stringify(lvRun.lastRun));

  const list = (await call("/api/jobs?status=all")).body;
  const byTitle = (t: string) => list.jobs.find((j: { title: string }) => j.title === t);
  check("7 canonical jobs (8 postings, one cross-source duplicate merged)", list.total === 7, `total=${list.total}`);

  const senior = byTitle("Senior Data Engineer");
  check("salary parsed from text: EUR 70,000-90,000 / year", senior?.salary.isParsed && senior.salary.min === 70000 && senior.salary.max === 90000 && senior.salary.currency === "EUR", JSON.stringify(senior?.salary));
  check("nice-to-have experience ignored: minimum is 5 years", senior?.minExperienceYears === 5);
  check("sponsorship offered", senior?.sponsorship === "offered");
  check("posted date comes from first_published", senior?.postedAt?.startsWith("2026-08-01"), senior?.postedAt);

  const designer = byTitle("Product Designer");
  check("market-size figures ($100B, $1.4T) are not read as a salary", designer && !designer.salary.isParsed && designer.salary.raw === null, JSON.stringify(designer?.salary));
  check("'cannot sponsor work visas' -> not_offered", designer?.sponsorship === "not_offered");

  const analyst = byTitle("Security Analyst");
  check("MXN monthly pay annualized and kept in pesos", analyst?.salary.currency === "MXN" && analyst.salary.period === "month" && analyst.salary.min === 43500 * 12, JSON.stringify(analyst?.salary));

  const sre = byTitle("Site Reliability Engineer");
  check("lever list text is read (3+ years) and its salary parsed in GBP", sre?.minExperienceYears === 3 && sre.salary.currency === "GBP" && sre.workMode === "hybrid", JSON.stringify(sre));

  const merged = (await call(`/api/jobs/${byTitle("Data Engineer").id}`)).body.job;
  check("the same job on both boards is ONE job with two postings", merged.postings.length === 2, `postings=${merged.postings.length}`);
  check("the near-duplicate 'Staff Data Engineer' is flagged, not merged", merged.duplicateCandidates.some((d: { title: string }) => d.title === "Staff Data Engineer"), JSON.stringify(merged.duplicateCandidates));

  await fetch(`${ATS}/__admin/drop/1005`, { method: "POST" });
  const second = await runAndWait(gh);
  check("a job removed from a complete fetch is closed", second.lastRun?.closed === 1, JSON.stringify(second.lastRun));
  const closed = (await call("/api/jobs?status=closed")).body;
  check("it appears under closed jobs, and open jobs drop to 6", closed.total === 1 && closed.jobs[0].title === "Office Chef" && (await call("/api/jobs")).body.total === 6);

  const form = new FormData();
  form.set("file", new File(["title,company,location\nWarehouse Lead,Beta,Leeds\nWarehouse Lead,Beta,Leeds"], "beta.csv"));
  form.set("consentConfirmed", "true");
  const up = await call("/api/job-sources/upload", { method: "POST", body: form });
  check("an uploaded CSV is stored (duplicate row dropped) and queued", up.status === 201 && up.body.count === 1 && up.body.queued === true, JSON.stringify(up.body));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
