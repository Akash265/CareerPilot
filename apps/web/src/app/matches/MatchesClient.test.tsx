// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MatchesClient } from "./MatchesClient";

const matchItem = (over: Record<string, unknown> = {}) => ({
  jobId: "j1", jobTitle: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote",
  match: {
    matchId: "m1", eligible: true, ineligibleReason: null, overallScore: 82,
    factors: { skills: 80, experience: 100, location: 100, sponsorship: 100, role: 90, salary: null, industry: 100, freshness: 100, semantic: 70 },
    explanation: { strongMatches: ["Strong SQL"], partialMatches: [], gaps: [], summary: "A strong overall match." },
    userAction: "none", computedAt: "2026-09-22T00:00:00Z",
    ...over,
  },
});

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
function mockFetch(handlers: Record<string, Handler>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unhandled request: ${init?.method ?? "GET"} ${url}`);
    const { status = 200, body } = handler(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("MatchesClient", () => {
  it("shows a helpful empty state", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText(/No matches yet/)).toBeInTheDocument();
  });

  it("lists eligible matches with score and factor chips", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [matchItem()], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Skills: 80%")).toBeInTheDocument();
    expect(screen.getByText("A strong overall match.")).toBeInTheDocument();
  });

  it("queues a matching run and shows a notice", async () => {
    const fn = mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
      "POST /api/matches/run": () => ({ status: 202, body: { status: "queued" } }),
    });
    render(<MatchesClient />);
    const button = await screen.findByRole("button", { name: "Find Matches" });
    fireEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent(/Queued a matching run/);
    expect(fn).toHaveBeenCalledWith("/api/matches/run", expect.objectContaining({ method: "POST" }));
  });

  it("dismisses a match and removes it from the eligible list", async () => {
    let matches = [matchItem()];
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches, page: 1, pageSize: 25, total: matches.length } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
      "PATCH /api/matches/j1": () => {
        matches = [];
        return { body: { match: { ...matchItem().match, eligible: false, userAction: "dismissed" } } };
      },
    });
    render(<MatchesClient />);
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByText("Data Engineer")).not.toBeInTheDocument());
  });

  it("shows an alert when the polled run has failed", async () => {
    let queued = false;
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () =>
        queued
          ? {
              body: {
                run: { status: "failed", errorClass: "no_active_goal", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:05Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 },
              },
            }
          : { body: { run: null } },
      "POST /api/matches/run": () => {
        queued = true;
        return { status: 202, body: { status: "queued" } };
      },
    });
    render(<MatchesClient />);
    const button = await screen.findByRole("button", { name: "Find Matches" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/last matching run failed \(no_active_goal\)/i);
  });

  it("toggles to show ineligible matches with their reason", async () => {
    const ineligible = matchItem({ eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null });
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches?eligible=false&page=1": () => ({ body: { matches: [ineligible], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    await screen.findByText(/No matches yet/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show excluded jobs/ }));
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
  });
});
