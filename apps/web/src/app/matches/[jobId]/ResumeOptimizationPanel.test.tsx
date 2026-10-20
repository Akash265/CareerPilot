// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ResumeOptimizationPanel } from "./ResumeOptimizationPanel";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

const optimization = {
  id: "opt1", version: 1,
  selectedBullets: [{ sourceFactId: "b1", sourceType: "work_experience_bullet", originalText: "Built X", optimizedText: "Built X using SQL", changeType: "reworded", justification: "adds SQL" }],
  addedTerms: ["SQL"], unsupportedClaimsDetected: [], rejectedClaims: [], requiresReview: false,
  generationModel: "test-model", createdAt: "2026-09-23T00:00:00Z",
  evaluation: { requiredKeywordCoverage: 100, preferredKeywordCoverage: 50, semanticSimilarity: 82, factualConsistency: 100, actionVerbScore: 100, machineReadabilityScore: 100, overallScore: 92.5, evaluatorVersion: "v1" },
};

function mockFetchSequence(responses: { body: unknown; status?: number }[]) {
  const fn = vi.fn();
  for (const { body, status = 200 } of responses) {
    fn.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as Response);
  }
  // Phase 13b: the panel also GETs /api/skill-gaps/ on mount; route that away so `fn` only sees the optimization calls.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    url.startsWith("/api/skill-gaps/") ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response) : fn(url, init));
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

/** Counts DOCUMENTS_CHANGED_EVENT dispatches (ApplicationPanel refreshes its version options on it). */
function listenForDocumentsChanged() {
  const listener = vi.fn();
  window.addEventListener(DOCUMENTS_CHANGED_EVENT, listener);
  return listener;
}

describe("ResumeOptimizationPanel", () => {
  it("shows an empty state and an Optimize Resume button when nothing has been generated yet", async () => {
    mockFetchSequence([{ body: { optimizations: [] } }]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByText(/no optimized resume generated yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeInTheDocument();
  });

  it("renders the latest optimization's scorecard and bullets", async () => {
    mockFetchSequence([{ body: { optimizations: [optimization] } }]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByText("92.5/100")).toBeInTheDocument();
    expect(screen.getByText("Built X using SQL")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tailored resume (LaTeX, 1 page)" })).toBeTruthy();
  });

  it("shows a review banner when requiresReview is true", async () => {
    mockFetchSequence([{ body: { optimizations: [{ ...optimization, requiresReview: true, rejectedClaims: [{ sourceFactId: "x", reason: "not found" }] }] } }]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/review needed/i);
  });

  it("calls the run endpoint and reloads the list when Regenerate is clicked", async () => {
    const changed = listenForDocumentsChanged();
    const fetchMock = mockFetchSequence([
      { body: { optimizations: [optimization] } },
      { body: { optimization: { ...optimization, id: "opt2", version: 2 } }, status: 201 },
      { body: { optimizations: [{ ...optimization, id: "opt2", version: 2 }, optimization] } },
    ]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    await screen.findByText("92.5/100");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/resume-optimizations/j1/run");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, changed);
  });

  it("shows the 'Was:' evidence line when originalText differs from optimizedText, even if changeType is mislabeled 'unchanged'", async () => {
    mockFetchSequence([{
      body: {
        optimizations: [{
          ...optimization,
          selectedBullets: [{ ...optimization.selectedBullets[0], changeType: "unchanged" }],
        }],
      },
    }]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByText("Built X using SQL")).toBeInTheDocument();
    expect(screen.getByText("Was: Built X")).toBeInTheDocument();
  });

  it("hides the 'Was:' evidence line when originalText and optimizedText are genuinely identical", async () => {
    mockFetchSequence([{
      body: {
        optimizations: [{
          ...optimization,
          selectedBullets: [{ ...optimization.selectedBullets[0], optimizedText: "Built X", changeType: "unchanged" }],
        }],
      },
    }]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    await screen.findByText("Built X");
    expect(screen.queryByText(/^Was:/)).not.toBeInTheDocument();
  });

  it("clears a stale DownloadButtons error message when the selected version changes (fix wave item C: key={selected.id})", async () => {
    const optV2 = { ...optimization, id: "opt2", version: 2 };
    mockFetchSequence([
      { body: { optimizations: [optimization, optV2] } },
      { status: 409, body: { error: "Your profile changed since this optimization. Regenerate it first." } },
    ]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    await screen.findByText("92.5/100");

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your profile changed since this optimization");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "opt2" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an error message when generation fails", async () => {
    mockFetchSequence([
      { body: { optimizations: [] } },
      { body: { error: "This job is not an eligible match" }, status: 400 },
    ]);
    render(<ResumeOptimizationPanel jobId="j1" />);
    await screen.findByRole("button", { name: "Optimize Resume" });

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    expect(await screen.findByText("This job is not an eligible match")).toBeInTheDocument();
  });

  it("notes unanswered required skills without blocking optimization", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("/api/skill-gaps/")
        ? ({ ok: true, status: 200, json: async () => ({ requirementsStatus: "ready", unanswered: [{ termKey: "a" }, { termKey: "b" }], coveredCount: 0, declinedCount: 0, profileSkills: [] }) } as Response)
        : ({ ok: true, status: 200, json: async () => ({ optimizations: [] }) } as Response)));
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByText(/2 required skills are unanswered/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "answer them" })).toHaveAttribute("href", "#skill-gaps");
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeEnabled();
  });
});
