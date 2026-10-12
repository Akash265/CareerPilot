// Phase 11d (D182, D183). Local stand-ins for the two paid APIs, so the E2E suite never spends money or needs a key:
//   POST /v1/messages    -- Anthropic: a fixed tool_use answer per tool the smoke flow calls; any other tool is a
//                           400, so a flow change that reaches a new AI step fails loudly instead of passing on junk.
//   POST /v1/embeddings  -- Voyage: deterministic 1024-dim bag-of-words vectors (similar text → similar vectors).
//   GET  /__calls        -- how many calls each endpoint and tool received (the smoke checks the stand-ins were used).
//   GET  job APIs        -- Phase 12: a Remotive search and the Ashby board it links to (see JOB_APIS).
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4012);
const DIM = 1024;

const TOOL_INPUTS = {
  record_career_goal_extraction: {
    targetRoles: ["Data Engineer"], seniority: null, locations: [], workMode: "remote", minExperienceYears: 2,
    employmentType: null, salaryFloorRaw: null, salaryTargetRaw: null, visaSponsorshipRequired: null,
    skills: ["SQL", "Python"], preferredIndustries: [], excludedIndustries: [], preferredCompanies: [],
    excludedCompanies: [], hardConstraints: [],
  },
  record_match_explanation: {
    strongMatches: ["SQL and Python, both required"], partialMatches: [], gaps: ["No dbt experience listed"],
    summary: "Fake explanation from the E2E stand-in server.",
  },
};

const calls = { messages: 0, embeddings: 0, tools: {}, jobApis: {} };

// Phase 12 job APIs (D184-D187): one Remotive search hit whose description links to an Ashby board, and that board.
// Every other job-API path is a 404, so a provider the smoke did not expect fails loudly.
const JOB_APIS = {
  "/api/remote-jobs": {
    jobs: [{
      id: 990001, url: "https://remotive.com/remote-jobs/data/discovery-data-engineer-990001", title: "Discovery Data Engineer",
      company_name: "Acme Co", job_type: "full_time", publication_date: "2026-10-10T10:00:00", candidate_required_location: "Worldwide",
      salary: "", description: '<p>Apply on <a href="https://jobs.ashbyhq.com/acmeco">our board</a>. SQL and Python, 3+ years.</p>',
    }],
  },
  "/posting-api/job-board/acmeco": {
    jobs: [{
      id: "acme-1", title: "Acme Platform Engineer", location: "Remote", isListed: true, workplaceType: "Remote", employmentType: "FullTime",
      publishedAt: "2026-10-10T10:00:00Z", jobUrl: "https://jobs.ashbyhq.com/acmeco/acme-1",
      descriptionPlain: "Build data platforms with SQL and Python. 3+ years of experience.",
    }],
  },
};

function embed(text) {
  const v = new Array(DIM).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[createHash("sha256").update(word).digest().readUInt32BE(0) % DIM] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__calls") return send(res, 200, calls);
  if (req.method === "GET") {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    calls.jobApis[path] = (calls.jobApis[path] ?? 0) + 1;
    return path in JOB_APIS ? send(res, 200, JOB_APIS[path]) : send(res, 404, { error: "not found" });
  }
  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  const body = await readJson(req);
  if (req.url?.startsWith("/v1/messages")) {
    calls.messages++;
    const tool = body.tools?.[0]?.name ?? "none";
    calls.tools[tool] = (calls.tools[tool] ?? 0) + 1;
    const input = TOOL_INPUTS[tool];
    if (!input) {
      console.log(`fakeProviders: unexpected Anthropic tool ${tool}`);
      return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `E2E stand-in has no answer for tool ${tool}` } });
    }
    return send(res, 200, {
      id: "msg_e2e", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_e2e", name: tool, input }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    });
  }
  if (req.url?.startsWith("/v1/embeddings")) {
    calls.embeddings++;
    const input = Array.isArray(body.input) ? body.input : [body.input];
    return send(res, 200, { data: input.map((t, i) => ({ index: i, embedding: embed(t) })), usage: { total_tokens: input.join(" ").length / 4 | 0 } });
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`fakeProviders listening on 127.0.0.1:${PORT}`));
