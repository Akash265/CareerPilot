// Phase 11d (D182). The smoke checks `run.mjs` runs: the 11c request gate and rate limits, the main user flow
// (profile → goal → jobs → matching → application) with the AI stand-ins, the main pages, and the 11b error path.
// Prints one JSON line per check and throws on the first failure (after saving a screenshot).
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** isVisible() never waits; pages that load their data on the client need a waiting check. */
const visible = (locator) => locator.first().waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);

/** A raw request, so the Host and Origin headers are exactly what a hostile page would send. */
function raw(base, { method = "GET", path: p = "/", headers = {} } = {}) {
  const url = new URL(p, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(what, fn, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

const PROFILE = {
  contact: { fullName: "E2E Candidate", email: "e2e.candidate@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: 4,
  workAuthorizationNotes: null,
  education: [],
  workExperiences: [
    { company: "Acme Data", title: "Data Engineer", location: null, employmentType: null, startDate: null, endDate: null, bullets: ["Built SQL and Python pipelines"] },
  ],
  skills: [{ name: "SQL", category: null }, { name: "Python", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

const CONSTRAINTS = {
  targetRoles: ["Data Engineer"], seniority: null, locations: [], workMode: "remote", minExperienceYears: 2,
  employmentType: null, salaryFloorRaw: null, salaryFloorNormalized: null, salaryCurrency: null, salaryIsParsed: false,
  salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false,
  visaSponsorshipRequired: null, skills: ["SQL", "Python"], preferredIndustries: [], excludedIndustries: [],
  preferredCompanies: [], excludedCompanies: ["Excluded Co"], hardConstraints: [],
};

const JOBS = [
  { id: "e2e-1", title: "Senior Data Engineer", company: "Acme", location: "Remote", description: "We use SQL and Python daily. 3+ years experience.", url: "https://example.com/1" },
  { id: "e2e-2", title: "Data Engineer", company: "Excluded Co", location: "Remote", description: "SQL required.", url: "https://example.com/2" },
  { id: "e2e-3", title: "Analytics Engineer", company: "Globex", location: "Remote", description: "SQL, Python and dbt. 2+ years.", url: "https://example.com/3" },
];

export async function runSmoke(ctx) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || (existsSync(MAC_CHROME) ? MAC_CHROME : undefined),
  });
  const page = await browser.newPage();
  const check = async (name, ok, detail) => {
    console.log(JSON.stringify({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }));
    if (!ok) {
      await page.screenshot({ path: path.join(ctx.out, "failure.png"), fullPage: true }).catch(() => undefined);
      throw new Error(`check failed: ${name}`);
    }
  };
  const api = page.request;
  const json = async (res) => res.json().catch(() => null);

  try {
    // --- 11c request gate -------------------------------------------------------------------------------------
    const foreign = await raw(ctx.base, { path: "/api/health", headers: { host: "evil.example" } });
    await check("an unknown Host header is refused (DNS rebinding)", foreign.status === 421, foreign.status);
    const csrf = await raw(ctx.base, { method: "POST", path: "/api/matches/run", headers: { origin: "https://evil.example", authorization: `Bearer ${ctx.token}` } });
    await check("a cross-site POST is blocked even with a valid token", csrf.status === 403, csrf.status);
    const anon = await raw(ctx.base, { path: "/api/profile" });
    await check("the API needs the access token", anon.status === 401, anon.status);
    const health = await raw(ctx.base, { path: "/api/health" });
    await check("/api/health stays reachable without a token", health.status === 200, health.status);

    const first = await page.goto(`${ctx.base}/matches`);
    await check("a page without the token redirects to /unlock", page.url().endsWith("/unlock?next=%2Fmatches"), page.url());
    const headers = (await first.allHeaders()) ?? {};
    await check("security headers are set and X-Powered-By is not", headers["x-frame-options"] === "DENY"
      && headers["x-content-type-options"] === "nosniff" && /frame-ancestors 'none'/.test(headers["content-security-policy"] ?? "")
      && headers["x-powered-by"] === undefined, headers);

    await page.getByLabel("Access token").fill("wrong-token");
    await page.getByRole("button", { name: "Unlock" }).click();
    // Waits for the form's own message (Next.js also renders an empty role="alert" route announcer).
    await check("a wrong token is rejected", await page.getByText("Wrong access token").waitFor({ timeout: 10_000 }).then(() => true, () => false));
    await page.getByLabel("Access token").fill(ctx.token);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.waitForURL(`${ctx.base}/matches`, { timeout: 15_000 });
    await check("the right token unlocks and returns to the page asked for", await visible(page.getByRole("heading", { name: "Matches" })));

    // --- Main flow ----------------------------------------------------------------------------------------------
    const profile = await api.post(`${ctx.base}/api/profile/confirm`, { data: PROFILE });
    const profileBody = await json(profile);
    await check("a confirmed profile is saved with its facts", profile.status() === 200 && profileBody?.factsGenerated >= 3, { status: profile.status(), body: profileBody });

    const parse = await api.post(`${ctx.base}/api/career-goal/parse`, { data: { rawText: "Remote Data Engineer roles, at least 2 years, SQL and Python." } });
    const parsed = await json(parse);
    await check("the career goal is parsed by the AI stand-in", parse.status() === 200 && parsed?.status === "parsed", { status: parse.status(), body: parsed });
    const confirm = await api.post(`${ctx.base}/api/career-goal/confirm`, { data: { goalId: parsed.goalId, constraints: CONSTRAINTS } });
    await check("the career goal is confirmed", confirm.status() === 200, await json(confirm));

    const upload = await api.post(`${ctx.base}/api/job-sources/upload`, {
      multipart: { file: { name: "e2e-jobs.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(JOBS)) }, consentConfirmed: "true" },
    });
    await check("a job file is uploaded and queued", upload.status() === 201, await json(upload));
    await waitFor("the uploaded jobs to be ingested", async () => (await json(await api.get(`${ctx.base}/api/jobs?status=all`)))?.total >= JOBS.length);
    await check("the ingestion worker turned the upload into jobs", true);

    const run = await api.post(`${ctx.base}/api/matches/run`);
    await check("a matching run is queued", run.status() === 202, await json(run));
    const finished = await waitFor("the matching run to finish", async () => {
      const latest = await json(await api.get(`${ctx.base}/api/matches/runs/latest`));
      return latest?.run && latest.run.status !== "running" ? latest.run : null;
    });
    await check("the matching run completed", finished.status === "completed", finished);
    const eligible = await json(await api.get(`${ctx.base}/api/matches?eligible=true`));
    const best = eligible?.matches?.[0];
    await check("eligible matches carry an explanation from the AI stand-in",
      eligible?.matches?.length >= 1 && best?.match?.explanation?.summary === "Fake explanation from the E2E stand-in server.", eligible);
    const ineligible = await json(await api.get(`${ctx.base}/api/matches?eligible=false`));
    await check("the excluded company's job is ineligible, with the reason",
      ineligible?.matches?.some((m) => m.match.ineligibleReason?.includes("Excluded Co")), ineligible);
    const calls = await (await fetch(`${ctx.fake}/__calls`)).json();
    await check("embeddings and AI calls went to the local stand-ins only", calls.embeddings > 0 && calls.tools.record_match_explanation > 0, calls);

    const application = await api.post(`${ctx.base}/api/applications`, { data: { jobId: best.jobId } });
    await check("an application is recorded for the best match", application.status() === 201, await json(application));
    await page.goto(`${ctx.base}/applications`);
    await check("the application appears on /applications", await visible(page.getByRole("link", { name: `${best.companyName} — ${best.jobTitle}` })));

    for (const [route, heading] of [["/insights", "Insights"], ["/usage", "AI usage"], ["/status", "System status"], ["/", "AI Career Intelligence"]]) {
      await page.goto(`${ctx.base}${route}`);
      await check(`${route} renders`, await visible(page.getByRole("heading", { name: heading })));
    }
    await page.goto(`${ctx.base}/status`);
    const matchingRow = page.getByRole("table", { name: "Workers" }).getByRole("row").filter({ hasText: "Matching" });
    await check("/status shows the matching worker running",
      (await matchingRow.getByRole("cell").nth(1).textContent({ timeout: 15_000 }))?.trim() === "Running", await matchingRow.textContent());

    // --- Phase 12 discovery ---------------------------------------------------------------------------------------
    const discovery = async () => json(await api.get(`${ctx.base}/api/discovery`));
    const refused = await api.put(`${ctx.base}/api/discovery/providers/remotive`, { data: { enabled: true } });
    await check("a search provider cannot be switched on before the standing permission", refused.status() === 409, await json(refused));
    const settings = await api.put(`${ctx.base}/api/discovery/settings`, { data: { consent: true, autoDiscover: true } });
    await check("the standing permission and auto-discovery are recorded", settings.status() === 200 && (await discovery())?.settings?.consentedAt, await json(settings));
    const enable = await api.put(`${ctx.base}/api/discovery/providers/remotive`, { data: { enabled: true } });
    await check("Remotive is switched on as a search source", enable.status() === 200, await json(enable));
    const remotiveId = (await discovery()).providers.find((p) => p.kind === "remotive")?.sourceId;
    const queued = await api.post(`${ctx.base}/api/job-sources/${remotiveId}/run`);
    await check("a run of the search source is queued", queued.status() < 300, await json(queued));
    const searched = await waitFor("the search result to be ingested", async () =>
      ((await json(await api.get(`${ctx.base}/api/jobs?status=all&q=Discovery%20Data%20Engineer`)))?.total ?? 0) >= 1);
    await check("the goal-driven search ingested the provider's job", searched);
    const board = await waitFor("the linked Ashby board to be discovered and validated", async () => {
      const recent = (await discovery())?.boards?.recent ?? [];
      return recent.find((b) => b.kind === "ashby" && b.slug === "acmeco" && b.status === "enabled") ?? null;
    });
    await check("the board linked from the posting became an enabled source named after it", board.foundVia === "Remotive", board);
    const discoveredSource = (await json(await api.get(`${ctx.base}/api/job-sources`))).sources.find((s) => s.origin === "discovered" && s.slug === "acmeco");
    await check("the discovered source is enabled and consented", discoveredSource?.enabled === true && discoveredSource?.consentConfirmedAt, discoveredSource);
    await api.post(`${ctx.base}/api/job-sources/${discoveredSource.id}/run`);
    const boardJobs = await waitFor("the discovered board's jobs to be ingested", async () =>
      ((await json(await api.get(`${ctx.base}/api/jobs?status=all&q=Acme%20Platform%20Engineer`)))?.total ?? 0) >= 1);
    await check("the discovered board was fetched like any other source", boardJobs);
    const fake = await (await fetch(`${ctx.fake}/__calls`)).json();
    await check("every job API call went to the local stand-in", fake.jobApis["/api/remote-jobs"] >= 1 && fake.jobApis["/posting-api/job-board/acmeco"] >= 2, fake.jobApis);
    await page.goto(`${ctx.base}/sources`);
    await check("/sources shows the discovery panel and the discovered board",
      await visible(page.getByRole("heading", { name: "Discover jobs automatically" })) && await visible(page.getByText("Discovered boards (1)")));

    // --- Phase 13a one-click discovery --------------------------------------------------------------------------
    const start = await api.post(`${ctx.base}/api/search-runs`);
    await check("Find matching jobs starts a search run", start.status() === 202, await json(start));
    const again = await api.post(`${ctx.base}/api/search-runs`);
    await check("a second click returns the same run", again.status() === 200, await json(again));
    const searchRun = await waitFor("the search run to finish", async () => {
      const latest = (await json(await api.get(`${ctx.base}/api/search-runs/latest`)))?.run;
      return latest && !["queued", "running", "matching"].includes(latest.status) ? latest : null;
    }, 240_000);
    await check("the search run completed", searchRun.status === "completed", searchRun);
    await check("the web search ran and queued the Globex board, ignoring model text and counting the unsupported site",
      searchRun.seeding?.webSearch?.state === "ran" && searchRun.seeding.webSearch.boardsQueued === 1 && searchRun.seeding.webSearch.unsupported === 1, searchRun.seeding);
    const globex = await waitFor("the web-searched board to be validated", async () =>
      ((await discovery())?.boards?.recent ?? []).find((b) => b.kind === "ashby" && b.slug === "globex" && b.status === "enabled") ?? null);
    await check("the Globex board became a source", Boolean(globex));
    await check("the planted lever URL was never recorded",
      !((await discovery())?.boards?.recent ?? []).some((b) => b.slug === "evil"));
    const appliedJobId = best.jobId;
    const ranked = await json(await api.get(`${ctx.base}/api/matches?eligible=true`));
    await check("the job already applied to is not in the ranked results", !ranked?.matches?.some((m) => m.jobId === appliedJobId), ranked);
    await page.goto(`${ctx.base}/matches`);
    await check("/matches shows the Find matching jobs button", await visible(page.getByRole("button", { name: "Find matching jobs" })));

    // --- 11c rate limits ----------------------------------------------------------------------------------------
    // 2 x limit + 2 calls: even if a 60 s window rolls over mid-loop, one of the two windows sees limit + 1.
    let limited = null;
    for (let i = 0; i < 2 * ctx.aiLimit + 2 && !limited; i++) {
      const res = await api.post(`${ctx.base}/api/career-goal/parse`, { data: { rawText: "Remote Data Engineer roles." } });
      if (res.status() === 429) limited = res;
    }
    const retryAfter = Number(limited?.headers()["retry-after"]);
    await check("an AI route answers 429 with Retry-After once over its per-minute limit",
      limited !== null && retryAfter >= 1 && retryAfter <= 60, limited ? { retryAfter, body: await json(limited) } : "never limited");
    let unlockLimited = false;
    for (let i = 0; i < 2 * 5 + 2 && !unlockLimited; i++) { // /api/unlock allows 5 a minute
      unlockLimited = (await api.post(`${ctx.base}/api/unlock`, { data: { token: "guess" } })).status() === 429;
    }
    await check("guessing the access token is rate limited", unlockLimited);

    // --- 11b error path -----------------------------------------------------------------------------------------
    const broken = await raw(ctx.broken, { path: "/api/insights", headers: { authorization: `Bearer ${ctx.token}` } });
    const brokenBody = JSON.parse(broken.body || "{}");
    await check("an escaped route error answers 500 with a request id", broken.status === 500 && /^[0-9a-f]{8}$/.test(brokenBody.requestId ?? ""), broken);
    const line = await waitFor("the request_failed log line", async () => {
      const lines = readFileSync(ctx.brokenLog, "utf8").split("\n").filter((l) => l.includes(`"requestId":"${brokenBody.requestId}"`));
      return lines.length ? lines : null;
    }, 10_000);
    const entry = JSON.parse(line[0]);
    await check("exactly one message-free request_failed line names the route",
      line.length === 1 && entry.event === "request_failed" && entry.route === "/api/insights" && entry.error?.name
        && !("message" in entry.error) && !/ECONNREFUSED 127|connect /.test(line[0]), entry);
  } finally {
    await browser.close();
  }
}
