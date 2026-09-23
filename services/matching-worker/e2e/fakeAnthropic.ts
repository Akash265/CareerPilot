// A minimal stand-in for POST https://api.anthropic.com/v1/messages, answering every request with a
// fixed tool_use block so AI-dependent steps can run without a paid ANTHROPIC_API_KEY. Point a process
// at it with ANTHROPIC_BASE_URL (the Anthropic SDK reads this env var) -- same recipe used for Phase
// 2/3's manual E2E checks (see MEMORY.md).
//
// The full smoke test exercises two different Anthropic-backed tool calls against this same server:
// the matching worker's explanation step (packages/matching/src/explanation/generateMatchExplanation.ts,
// tool `record_match_explanation`) AND the web app's career-goal parse step
// (packages/ai/src/extractCareerGoal.ts, tool `record_career_goal_extraction`), since
// /api/career-goal/parse calls Anthropic directly rather than through the matching worker. Each
// tool's required input shape is different, so the response is keyed off the requested tool's name
// rather than a single fixed body.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4012);

const FAKE_INPUTS: Record<string, unknown> = {
  record_match_explanation: {
    strongMatches: ["Fake strong match"],
    partialMatches: [],
    gaps: ["Fake gap"],
    summary: "Fake explanation from the E2E stand-in server.",
  },
  record_career_goal_extraction: {
    targetRoles: ["Data Engineer"],
    seniority: null,
    locations: [],
    workMode: "remote",
    minExperienceYears: 2,
    employmentType: null,
    salaryFloorRaw: null,
    salaryTargetRaw: null,
    visaSponsorshipRequired: null,
    skills: ["SQL", "Python"],
    preferredIndustries: [],
    excludedIndustries: [],
    preferredCompanies: [],
    excludedCompanies: [],
    hardConstraints: [],
  },
};

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const toolName = parsed.tools?.[0]?.name ?? "unknown_tool";
    const input = FAKE_INPUTS[toolName] ?? FAKE_INPUTS.record_match_explanation;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_fake",
            name: toolName,
            input,
          },
        ],
        model: parsed.model,
        stop_reason: "tool_use",
      })
    );
  });
});

server.listen(PORT, () => console.log(`fake Anthropic server listening on :${PORT}`));
