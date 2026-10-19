// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FindJobsPanel } from "./FindJobsPanel";

type Reply = { status?: number; body: unknown };
function mockFetch(routes: Record<string, () => Reply>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unhandled ${key}`);
    const { status = 200, body } = route();
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const run = (over: Record<string, unknown> = {}) => ({
  id: "r1", status: "running", errorCode: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  sources: [{ sourceId: "s1", name: "Remotive", kind: "remotive", state: "done", newCount: 2 }], seeding: {}, ...over,
});

beforeEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterEach(() => vi.useRealTimers());

describe("FindJobsPanel (Phase 13a)", () => {
  it("shows the consent panel on first use and starts the run after quick-start", async () => {
    let started = 0;
    const fn = mockFetch({
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "POST /api/search-runs": () => (started++ === 0
        ? { status: 409, body: { error: "Give permission", code: "consent_required" } }
        : { status: 202, body: { run: run({ status: "queued", sources: [] }) } }),
      "POST /api/discovery/quick-start": () => ({ body: { enabled: ["remotive"], skipped: [{ kind: "adzuna", missingKeys: ["ADZUNA_APP_ID"] }] } }),
    });
    render(<FindJobsPanel onResultsChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find matching jobs" }));
    expect(await screen.findByRole("checkbox", { name: /I confirm I may use these job sources/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
    fireEvent.click(screen.getByRole("button", { name: "Allow and search" }));
    expect(await screen.findByText(/Searching/)).toBeInTheDocument();
    expect(fn).toHaveBeenCalledWith("/api/discovery/quick-start", expect.objectContaining({ method: "POST" }));
  });

  it("links to the career goal page when no goal is confirmed", async () => {
    mockFetch({
      "GET /api/search-runs/latest": () => ({ body: { run: null } }),
      "POST /api/search-runs": () => ({ status: 409, body: { error: "Confirm a career goal before finding jobs", code: "no_active_goal" } }),
    });
    render(<FindJobsPanel onResultsChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find matching jobs" }));
    expect(await screen.findByRole("link", { name: /career goal/i })).toHaveAttribute("href", "/career-goal");
  });

  it("shows per-source progress, then reloads results when the run completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let latest = run();
    mockFetch({
      "GET /api/search-runs/latest": () => ({ body: { run: latest } }),
      "POST /api/search-runs": () => ({ status: 202, body: { run: latest } }),
    });
    const onResultsChanged = vi.fn();
    render(<FindJobsPanel onResultsChanged={onResultsChanged} />);
    expect(await screen.findByText("Remotive — 2 new jobs")).toBeInTheDocument();
    latest = run({ status: "completed", sources: [...latest.sources, { sourceId: "s2", name: "Lever: acme", kind: "lever", state: "late" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText(/Lever: acme — still running/)).toBeInTheDocument();
    expect(onResultsChanged).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Find matching jobs" })).toBeEnabled();
  });

  it("says the worker may not be running when a run stays queued for 30 s, and explains a stalled run", async () => {
    const created = new Date(Date.now() - 31_000).toISOString();
    mockFetch({ "GET /api/search-runs/latest": () => ({ body: { run: run({ status: "queued", createdAt: created, sources: [] }) } }) });
    const { unmount } = render(<FindJobsPanel onResultsChanged={vi.fn()} />);
    expect(await screen.findByText(/job-ingestion worker may not be running/)).toBeInTheDocument();
    unmount();
    mockFetch({ "GET /api/search-runs/latest": () => ({ body: { run: run({ status: "failed", errorCode: "stalled" }) } }) });
    render(<FindJobsPanel onResultsChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/stopped responding/);
  });
});
