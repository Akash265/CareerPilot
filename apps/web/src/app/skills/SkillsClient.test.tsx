// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SkillsClient } from "./SkillsClient";
import { SKILL_GAPS_CHANGED_EVENT } from "./SkillAnswerForm";

const overview = {
  topN: 25, jobsWithoutRequirements: 2, profileSkills: ["Postgres"],
  unanswered: [{ termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null, jobCount: 7,
    jobs: [{ jobId: "j1", title: "Data Engineer", companyName: "Acme" }] }],
  answered: [{ id: "v1", termKey: "dbt", termDisplay: "dbt", status: "dont_have", evidence: null, aliasSkillName: null, updatedAt: "2026-10-19T00:00:00Z" }],
};
const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
beforeEach(() => vi.unstubAllGlobals());

describe("SkillsClient", () => {
  it("lists unanswered skills by how many top jobs they block, and the answered ones", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(overview)));
    render(<SkillsClient />);
    expect(await screen.findByText("Required by 7 of your top 25 matches")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acme — Data Engineer" })).toHaveAttribute("href", "/matches/j1");
    expect(screen.getByText("2 top matches have no requirements checked yet.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Your answers" })).getByText(/dbt — you don't have it/)).toBeInTheDocument();
  });

  it("undoes an answer and reloads", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(respond(overview)).mockResolvedValueOnce(respond(null, 204)).mockResolvedValueOnce(respond({ ...overview, answered: [] }));
    vi.stubGlobal("fetch", fetchFn);
    render(<SkillsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo dbt" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    expect(fetchFn.mock.calls[1]).toEqual(["/api/skill-verifications/v1", { method: "DELETE" }]);
  });

  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...overview, unanswered: [], answered: [], jobsWithoutRequirements: 0 })));
    render(<SkillsClient />);
    expect(await screen.findByText(/no unanswered required skills/i)).toBeInTheDocument();
  });

  it("shows an error and does not announce a change when undo fails", async () => {
    const listener = vi.fn();
    window.addEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
    const fetchFn = vi.fn().mockResolvedValueOnce(respond(overview)).mockResolvedValueOnce(respond({ error: "x" }, 500));
    vi.stubGlobal("fetch", fetchFn);
    render(<SkillsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo dbt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not undo your answer.");
    expect(listener).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    window.removeEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
  });

  it("opens the answer form for an existing answer without labelling it a suggestion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...overview, unanswered: [], answered: [{ ...overview.answered[0], status: "alias", aliasSkillName: "Postgres" }] })));
    render(<SkillsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Change dbt" }));
    expect(screen.getByRole("button", { name: "I have it" })).toBeInTheDocument();
    expect(screen.queryByText(/suggested/i)).not.toBeInTheDocument();
  });

describe("SkillsClient wording and edit seeding", () => {
  it("uses the singular for one top match without requirements", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...overview, jobsWithoutRequirements: 1 })));
    render(<SkillsClient />);
    expect(await screen.findByText("1 top match has no requirements checked yet.")).toBeInTheDocument();
  });

  it("starts the edit form of a 'have' answer with its saved evidence", async () => {
    const have = { id: "v2", termKey: "k8s", termDisplay: "Kubernetes", status: "have", evidence: "Ran staging.", aliasSkillName: null, updatedAt: "2026-10-19T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...overview, answered: [have] })));
    render(<SkillsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Change Kubernetes" }));
    const answers = screen.getByRole("list", { name: "Your answers" });
    fireEvent.click(within(answers).getByRole("button", { name: "I have it" }));
    expect(within(answers).getByLabelText("Where you used Kubernetes")).toHaveValue("Ran staging.");
  });
});
});
