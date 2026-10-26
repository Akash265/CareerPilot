// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MatchesClient } from "./MatchesClient";
import { resetRankPreferenceForTests, writeRankPreference } from "../../lib/insights/rankPreference";

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

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetRankPreferenceForTests();
});

const MODEL_OFF = { status: "insufficient_data", decided: 12, responses: 3, nonResponses: 9, minDecided: 30, minPerClass: 8, blendWeight: null };
const MODEL_ON = { status: "active", decided: 40, responses: 20, nonResponses: 20, minDecided: 30, minPerClass: 8, blendWeight: 0.2 };
const PERSONAL = { probability: 0.354, low: 0.221, high: 0.498, raises: ["Skills"], lowers: [] };

describe("MatchesClient", () => {
  it("shows a helpful empty state", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText(/No matches yet/)).toBeInTheDocument();
  });

  it("lists eligible matches with score and factor chips", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [matchItem()], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Skills: 80%")).toBeInTheDocument();
    expect(screen.getByText("A strong overall match.")).toBeInTheDocument();
  });

  it("dismisses a match: it stays in the eligible list (no recompute has run yet) but the row shows dismissed feedback", async () => {
    // Per design spec §8, a dismissal only takes effect on the NEXT matching recompute --
    // evaluateEligibility's previouslyDismissed check runs during runMatching, not retroactively. So
    // the real, immediate behavior after a successful dismiss PATCH is: the job stays eligible=true in
    // the list (GET /api/matches?eligible=true still returns it) until "Find matching jobs" is run again.
    let match = matchItem().match;
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [{ ...matchItem(), match }], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
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
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({
        body: { run: { status: "failed", errorClass: "no_active_goal", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:05Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 } },
      }),
    });
    render(<MatchesClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/last matching run failed \(no_active_goal\)/i);
  });

  it("shows no failure alert for a run interrupted by a stop (D219): the worker re-runs it on its own", async () => {
    const fetchFn = mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({
        body: { run: { status: "failed", errorClass: "interrupted", startedAt: "2026-10-26T08:00:00Z", finishedAt: "2026-10-26T09:00:00Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 } },
      }),
    });
    render(<MatchesClient />);
    await waitFor(() => expect(fetchFn.mock.calls.some(([url]) => url === "/api/matches/runs/latest")).toBe(true));
    await act(async () => {}); // let the status response settle
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["matching_failed", "matching_timeout"])(
    "shows one alert, the search panel's, when the latest search run already explains the matching failure (%s)",
    async (errorCode) => {
      mockFetch({
        "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
        "GET /api/search-runs/latest": () => ({
          body: { run: { id: "r1", status: "failed", errorCode, createdAt: "2026-09-22T00:00:00Z", startedAt: null, finishedAt: "2026-09-22T00:01:00Z", sources: [], seeding: {} } },
        }),
        "GET /api/matches/runs/latest": () => ({
          body: { run: { status: "failed", errorClass: "llm_error", startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:05Z", jobsEvaluated: 0, jobsEligible: 0, jobsExplained: 0 } },
        }),
      });
      render(<MatchesClient />);
      expect(await screen.findByText(/Jobs were fetched, but ranking/)).toBeInTheDocument();
      // Let the matching-run check settle too, then expect exactly one alert.
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(/last matching run failed/i)).not.toBeInTheDocument();
    },
  );

  it("toggles to show ineligible matches with their reason", async () => {
    const ineligible = matchItem({ eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null });
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches?eligible=false&page=1": () => ({ body: { matches: [ineligible], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
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
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    await screen.findByText(/No matches yet/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show excluded jobs/ }));
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
    expect(screen.queryByText("A strong overall match.")).not.toBeInTheDocument();
  });

  it("disables Rank with my history and says why while the model is not active", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [matchItem()], page: 1, pageSize: 25, total: 1, ranking: "default", model: MODEL_OFF } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Needs 30 decided applications with at least 8 responses and 8 without. You have 12 (3 with a response)."))
      .toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: "Rank with my history" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(
      "Needs 30 decided applications with at least 8 responses and 8 without. You have 12 (3 with a response)."
    );
  });

  it("links no description to the toggle while the model is active", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [matchItem()], page: 1, pageSize: 25, total: 1, ranking: "default", model: MODEL_ON } }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    await screen.findByText("Data Engineer");
    expect(screen.getByRole("checkbox", { name: "Rank with my history" })).not.toHaveAttribute("aria-describedby");
  });

  it("disables Rank with my history while excluded jobs are shown, keeping the stored choice", async () => {
    window.localStorage.setItem("careerpilot.rankWithHistory", "1");
    const ineligible = matchItem({ eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null });
    mockFetch({
      "GET /api/matches?eligible=true&page=1&rank=personal": () => ({
        body: { matches: [matchItem({ personal: PERSONAL })], page: 1, pageSize: 25, total: 1, ranking: "personal", model: MODEL_ON },
      }),
      "GET /api/matches?eligible=false&page=1": () => ({
        body: { matches: [ineligible], page: 1, pageSize: 25, total: 1, ranking: "default", model: MODEL_ON },
      }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Ranked with your history (weight 20%)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show excluded jobs/ }));
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: "Rank with my history" });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription("Excluded jobs are always listed in the default order.");
    expect(window.localStorage.getItem("careerpilot.rankWithHistory")).toBe("1");
  });

  it("shows each match's likely response and ranks with history when turned on, remembering the choice", async () => {
    const fetchMock = mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({
        body: { matches: [matchItem({ personal: PERSONAL })], page: 1, pageSize: 25, total: 1, ranking: "default", model: MODEL_ON },
      }),
      "GET /api/matches?eligible=true&page=1&rank=personal": () => ({
        body: { matches: [matchItem({ personal: PERSONAL })], page: 1, pageSize: 25, total: 1, ranking: "personal", model: MODEL_ON },
      }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Your history: likely response 35% (22–50%)")).toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: "Rank with my history" });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(await screen.findByText("Ranked with your history (weight 20%)")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/matches?eligible=true&page=1&rank=personal");
    expect(window.localStorage.getItem("careerpilot.rankWithHistory")).toBe("1");
  });

  it("requests the personal ranking from the start when it was turned on before", async () => {
    window.localStorage.setItem("careerpilot.rankWithHistory", "1");
    mockFetch({
      "GET /api/matches?eligible=true&page=1&rank=personal": () => ({
        body: { matches: [matchItem({ personal: PERSONAL })], page: 1, pageSize: 25, total: 1, ranking: "personal", model: MODEL_ON },
      }),
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Ranked with your history (weight 20%)")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Rank with my history" })).toBeChecked();
  });

  it("ignores a slower, older response: only the latest request may update the list", async () => {
    let releaseDefault: () => void = () => undefined;
    const defaultBody = { matches: [matchItem({ personal: PERSONAL })], page: 1, pageSize: 25, total: 1, ranking: "default", model: MODEL_ON };
    const personalBody = { ...defaultBody, ranking: "personal" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/search-runs/latest") return { ok: true, status: 200, json: async () => ({ run: null }) } as Response;
      if (url === "/api/matches/runs/latest") return { ok: true, status: 200, json: async () => ({ run: null }) } as Response;
      if (url === "/api/matches?eligible=true&page=1") {
        await new Promise<void>((resolve) => {
          releaseDefault = resolve;
        });
        return { ok: true, status: 200, json: async () => defaultBody } as Response;
      }
      return { ok: true, status: 200, json: async () => personalBody } as Response;
    }));

    render(<MatchesClient />);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Rank with my history" })).toBeInTheDocument());
    // The default request is still in flight; the user's choice issues a newer personal request.
    act(() => writeRankPreference(true));
    expect(await screen.findByText("Ranked with your history (weight 20%)")).toBeInTheDocument();

    await act(async () => {
      releaseDefault();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Ranked with your history (weight 20%)")).toBeInTheDocument();
  });
});
