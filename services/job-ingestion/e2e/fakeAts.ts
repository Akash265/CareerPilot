// A tiny fake Greenhouse + Lever for local end-to-end runs. Field names and shapes match the real
// APIs (verified 2026-09-21); job text is synthetic. Point the worker at it with
//   GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011
// Both boards are called "fakeco".
//   POST /__admin/drop/<greenhouse job id>   removes a job (to exercise closing)
//   POST /__admin/reset                      restores the original board
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_ATS_PORT ?? 4011);

const escape = (html: string) =>
  html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface GhJob { id: number; title: string; location: string; html: string; first_published: string }
const GREENHOUSE_ORIGINAL: GhJob[] = [
  {
    id: 1001, title: "Senior Data Engineer", location: "Berlin", first_published: "2026-08-01T09:00:00-04:00",
    html:
      "<p>Build the data platform.</p><ul><li>5+ years of experience with SQL</li>" +
      "<li>2+ years of experience with dbt (nice to have)</li></ul>" +
      "<p>The base salary range is €70,000 - €90,000 per year. Visa sponsorship is available.</p>",
  },
  {
    id: 1002, title: "Product Designer", location: "Remote, United States", first_published: "2026-09-01T09:00:00-04:00",
    html:
      "<p>We are attacking a $100B market opportunity and processed $1.4T in annual volume.</p>" +
      "<p>We cannot sponsor work visas at this time.</p>",
  },
  {
    id: 1003, title: "Security Analyst", location: "Mexico City", first_published: "2026-09-05T09:00:00-04:00",
    html: "<p>Protect our systems.</p><p>Mexico Monthly Pay Range<br>$43,500 — $48,333 MXN</p>",
  },
  { id: 1004, title: "Data Engineer", location: "Berlin", first_published: "2026-09-10T09:00:00-04:00", html: "<p>Shared description text.</p>" },
  { id: 1005, title: "Office Chef", location: "Paris", first_published: "2026-09-12T09:00:00-04:00", html: "<p>Feed the team.</p>" },
];

const LEVER = [
  {
    id: "lv-0001", text: "Data Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0001", createdAt: Date.UTC(2026, 8, 11),
    country: "DE", workplaceType: "onsite", categories: { commitment: "Permanent", location: "Berlin", allLocations: ["Berlin"] },
    descriptionPlain: "Shared description text.", lists: [], additionalPlain: "",
  },
  {
    id: "lv-0002", text: "Site Reliability Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0002", createdAt: Date.UTC(2026, 8, 13),
    country: "GB", workplaceType: "hybrid", categories: { commitment: "Permanent", location: "London", allLocations: ["London"] },
    descriptionPlain: "Keep the lights on.",
    lists: [{ text: "Who You Are", content: "<li>3+ years of experience with Kubernetes</li>" }],
    additionalPlain: "The salary range is £60,000 - £80,000 per year.",
  },
  {
    id: "lv-0003", text: "Staff Data Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0003", createdAt: Date.UTC(2026, 8, 14),
    country: "DE", workplaceType: "unspecified", categories: { commitment: "Permanent", location: "Berlin", allLocations: ["Berlin"] },
    descriptionPlain: "A different description.", lists: [], additionalPlain: "",
  },
];

let greenhouse = [...GREENHOUSE_ORIGINAL];

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/v1/boards/fakeco/jobs") {
    return json(res, 200, {
      jobs: greenhouse.map((j) => ({
        id: j.id, internal_job_id: j.id + 5000000, title: j.title, company_name: "FakeCo",
        absolute_url: `https://boards.greenhouse.io/fakeco/jobs/${j.id}`, location: { name: j.location },
        first_published: j.first_published, updated_at: "2026-09-20T10:00:00-04:00", language: "en", content: escape(j.html),
      })),
      meta: { total: greenhouse.length },
    });
  }
  if (req.method === "GET" && path === "/v0/postings/fakeco") return json(res, 200, LEVER);

  if (req.method === "POST" && path.startsWith("/__admin/drop/")) {
    const id = Number(path.split("/").pop());
    greenhouse = greenhouse.filter((j) => j.id !== id);
    return json(res, 200, { remaining: greenhouse.length });
  }
  if (req.method === "POST" && path === "/__admin/reset") {
    greenhouse = [...GREENHOUSE_ORIGINAL];
    return json(res, 200, { remaining: greenhouse.length });
  }
  // Mirror the real 404 bodies.
  if (path.startsWith("/v0/postings/")) return json(res, 404, { ok: false, error: "Document not found" });
  return json(res, 404, {});
}).listen(PORT, () => console.log(`fake ATS listening on http://localhost:${PORT} (boards: fakeco)`));
