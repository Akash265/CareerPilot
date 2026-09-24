import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { runCompanyResearch, MAX_PAUSE_CONTINUATIONS, type CompanyResearchInput } from "./runCompanyResearch";

const ENV = { ANTHROPIC_MODEL_RESEARCH: "research-model", COMPANY_RESEARCH_MAX_SEARCHES: 4 };
const INPUT: CompanyResearchInput = { companyName: "Acme", jobTitle: "Data Engineer", postingUrl: "https://boards.example/acme/1" };

const citedText = (text: string, url = "https://acme.example") => ({
  type: "text", text, citations: [{ type: "web_search_result_location", url, title: "Acme", cited_text: text, encrypted_index: "e" }],
});
const response = (content: unknown[], stopReason = "end_turn", searches = 1) => ({
  content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } },
});
function clientReturning(...responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { messages: { create } as unknown as Anthropic["messages"] }, create };
}

describe("runCompanyResearch", () => {
  it("returns ok with cited facts, the model and the summed search count", async () => {
    const { client } = clientReturning(response([citedText("Acme builds rockets.")], "end_turn", 3));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toEqual({
      status: "ok", errorCode: null, researchModel: "research-model", searchCount: 3,
      webFacts: [expect.objectContaining({ factText: "Acme builds rockets.", sourceUrl: "https://acme.example/" })],
    });
  });

  it("sends only company name, job title and posting URL -- no candidate data -- inside a random delimiter", async () => {
    const { client, create } = clientReturning(response([citedText("x.")]));
    await runCompanyResearch(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(Object.keys(call).sort()).toEqual(["max_tokens", "messages", "model", "system", "tools"]);
    expect(call.model).toBe("research-model");
    expect(call.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 4 }]);
    expect(call.messages).toHaveLength(1);
    const content = call.messages[0].content as string;
    expect(content).toMatch(/<company_[0-9a-f]{16}>/);
    expect(content).toContain("Company: Acme");
    expect(content).toContain("Hiring for: Data Engineer");
    expect(content).toContain("Job posting URL: https://boards.example/acme/1");
    expect(call.system.toLowerCase()).toContain("untrusted");
  });

  it("omits the posting URL line when there is none", async () => {
    const { client, create } = clientReturning(response([citedText("x.")]));
    await runCompanyResearch(client, ENV, { ...INPUT, postingUrl: null });
    expect(create.mock.calls[0][0].messages[0].content).not.toContain("Job posting URL");
  });

  it("continues after pause_turn by re-sending the conversation, and collects facts from every turn", async () => {
    const first = response([citedText("Fact one.")], "pause_turn", 2);
    const { client, create } = clientReturning(first, response([citedText("Fact two.")], "end_turn", 1));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1][0];
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: "assistant", content: first.content });
    expect(result.webFacts.map((f) => f.factText)).toEqual(["Fact one.", "Fact two."]);
    expect(result.searchCount).toBe(3);
  });

  it(`stops after ${MAX_PAUSE_CONTINUATIONS} continuations and keeps what it collected`, async () => {
    const paused = (t: string) => response([citedText(t)], "pause_turn");
    const { client, create } = clientReturning(paused("A."), paused("B."), paused("C."), paused("D."));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(create).toHaveBeenCalledTimes(1 + MAX_PAUSE_CONTINUATIONS);
    expect(result.status).toBe("ok");
    expect(result.webFacts.map((f) => f.factText)).toEqual(["A.", "B.", "C."]);
  });

  it("returns failed/refusal and no facts on a refusal stop reason", async () => {
    const { client } = clientReturning(response([citedText("partial.")], "refusal"));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toMatchObject({ status: "failed", errorCode: "refusal", webFacts: [] });
  });

  it("returns no_results when the search ran but nothing was cited", async () => {
    const { client } = clientReturning(response([{ type: "text", text: "I could not identify this company.", citations: null }]));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toMatchObject({ status: "no_results", errorCode: null, webFacts: [] });
  });

  it("returns failed/max_tokens (not no_results) when the response was truncated and nothing was cited, so it is retried", async () => {
    const { client } = clientReturning(response([{ type: "text", text: "Acme is a compan", citations: null }], "max_tokens"));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toMatchObject({ status: "failed", errorCode: "max_tokens", webFacts: [] });
  });

  it("keeps ok when the response was truncated but cited facts were already extracted", async () => {
    const { client } = clientReturning(response([citedText("Acme builds rockets.")], "max_tokens"));
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toMatchObject({ status: "ok", errorCode: null });
    expect(result.webFacts.map((f) => f.factText)).toEqual(["Acme builds rockets."]);
  });

  it("returns failed with the web search error code when a search errored and nothing was cited", async () => {
    const { client } = clientReturning(
      response([{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }])
    );
    const result = await runCompanyResearch(client, ENV, INPUT);
    expect(result).toMatchObject({ status: "failed", errorCode: "too_many_requests", webFacts: [] });
  });

  it("is ok when a later search hit max_uses but earlier results were cited", async () => {
    const { client } = clientReturning(
      response([
        citedText("Acme builds rockets."),
        { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      ])
    );
    expect((await runCompanyResearch(client, ENV, INPUT)).status).toBe("ok");
  });

  it("maps an Anthropic.APIError to failed/api_error without throwing", async () => {
    const create = vi.fn().mockRejectedValue(new Anthropic.APIError(500, {}, "boom", undefined));
    const result = await runCompanyResearch({ messages: { create } as unknown as Anthropic["messages"] }, ENV, INPUT);
    expect(result).toEqual({ status: "failed", errorCode: "api_error", researchModel: null, searchCount: 0, webFacts: [] });
  });

  it("rethrows an error that is not an Anthropic.APIError", async () => {
    const create = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(runCompanyResearch({ messages: { create } as unknown as Anthropic["messages"] }, ENV, INPUT)).rejects.toThrow(TypeError);
  });

  it("treats a missing server_tool_use usage block as zero searches", async () => {
    const { client } = clientReturning({ content: [citedText("x.")], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, server_tool_use: null } });
    expect((await runCompanyResearch(client, ENV, INPUT)).searchCount).toBe(0);
  });
});
