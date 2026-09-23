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

  it("dismisses a match: it stays in the eligible list (no recompute has run yet) but the row shows dismissed feedback", async () => {
    // Per design spec §8, a dismissal only takes effect on the NEXT matching recompute --
    // evaluateEligibility's previouslyDismissed check runs during runMatching, not retroactively. So
    // the real, immediate behavior after a successful dismiss PATCH is: the job stays eligible=true in
    // the list (GET /api/matches?eligible=true still returns it) until "Find Matches" is run again.
    let match = matchItem().match;
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [{ ...matchItem(), match }], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
      "PATCH /api/matches/j1": () => {
        match = { ...match, userAction: "dismissed" };
        return { body: { match } };
      },
    });
    render(<MatchesClient />);
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    fireEvent.click(dismiss);

    // Still in the list -- not immediately removed.
    await waitFor(() => expect(screen.getByText("Data Engineer")).toBeInTheDocument());
    // Visible acknowledgment that the dismiss was recorded.
    expect(await screen.findByRole("button", { name: "Dismissed" })).toBeInTheDocument();
  });

  it("shows an alert for a run that already failed before this page loaded", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({
        body: { run: { status: "failed", errorClass: "no_active_goal", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:05Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 } },
      }),
    });
    render(<MatchesClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/last matching run failed \(no_active_goal\)/i);
  });

  it("does not resurface a stale failed run's alert immediately after a successful re-queue", async () => {
    // POST /api/matches/run only pushes a queue job — it does not create the matching_runs row. That row is
    // only created later by the worker once it dequeues the job. So immediately after a successful re-queue,
    // GET /api/matches/runs/latest can still legitimately report the *previous* (failed) run for a while, as
    // simulated here by always returning "failed" regardless of whether a new run was queued. The regression
    // this guards against: MatchesClient must not re-check run status synchronously right after enqueuing —
    // doing so would read this still-stale "failed" row and resurface the old failure as if the retry had
    // already failed too, even though the new run has barely started.
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({
        body: { run: { status: "failed", errorClass: "no_active_goal", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:05Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 } },
      }),
      "POST /api/matches/run": () => ({ status: 202, body: { status: "queued" } }),
    });
    render(<MatchesClient />);
    // The prior failure is surfaced on mount, same as the test above.
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Find Matches" }));
    // findMatches() clears the banner immediately and only the poll loop (not started synchronously by this
    // click) re-checks run status, so the stale "failed" row must not reappear right after the notice shows.
    expect(await screen.findByRole("status")).toHaveTextContent(/Queued a matching run/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("never shows a carried-forward explanation for an ineligible match", async () => {
    // upsertMatchRow carries explanation forward from the previous row on recompute regardless of the new
    // eligibility outcome (overallScore is not carried forward — it's always explicitly nulled on an
    // ineligible write), so a row can legitimately have eligible: false with a stale non-null explanation.
    const ineligibleWithStaleExplanation = matchItem({
      eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null,
    });
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches?eligible=false&page=1": () => ({ body: { matches: [ineligibleWithStaleExplanation], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    await screen.findByText(/No matches yet/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show excluded jobs/ }));
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
    expect(screen.queryByText("A strong overall match.")).not.toBeInTheDocument();
  });
});
