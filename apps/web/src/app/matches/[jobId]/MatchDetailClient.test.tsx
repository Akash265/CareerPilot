// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchDetailClient } from "./MatchDetailClient";

const job = { id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", descriptionText: "We use SQL." };
const match = {
  matchId: "m1", eligible: true, ineligibleReason: null, overallScore: 82,
  factors: { skills: 80, experience: 100, location: 100, sponsorship: 100, role: 90, salary: null, industry: 100, freshness: 100, semantic: 70 },
  explanation: { strongMatches: ["Strong SQL alignment"], partialMatches: ["Slightly under target salary"], gaps: ["Tableau requested, not found"], summary: "A strong overall match." },
  userAction: "none", computedAt: "2026-09-22T00:00:00Z",
};

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response));
}
beforeEach(() => vi.unstubAllGlobals());

describe("MatchDetailClient", () => {
  it("shows the job, score, and the strong/partial/gap breakdown", async () => {
    mockFetch({ job, match });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Strong SQL alignment")).toBeInTheDocument();
    expect(screen.getByText("Slightly under target salary")).toBeInTheDocument();
    expect(screen.getByText("Tableau requested, not found")).toBeInTheDocument();
  });

  it("shows the ineligible reason instead of scores when excluded", async () => {
    mockFetch({ job, match: { ...match, eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null } });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
  });

  it("shows a not-found state for a 404", async () => {
    mockFetch({ error: "Match not found" }, 404);
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it("never shows a carried-forward score or explanation once a match becomes ineligible", async () => {
    // upsertMatchRow deliberately carries explanation/overallScore-shaped fields forward from the previous
    // row on recompute in some paths; the UI must still gate their *display* on eligible, not just presence.
    mockFetch({
      job,
      match: { ...match, eligible: false, ineligibleReason: "You dismissed this job." },
    });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
    expect(screen.queryByText("82/100")).not.toBeInTheDocument();
    expect(screen.queryByText("Strong SQL alignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Slightly under target salary")).not.toBeInTheDocument();
    expect(screen.queryByText("Tableau requested, not found")).not.toBeInTheDocument();
    expect(screen.queryByText("A strong overall match.")).not.toBeInTheDocument();
  });
});
