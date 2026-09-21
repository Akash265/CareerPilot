// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { JobsClient } from "./JobsClient";

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", status: "open",
  postedAt: "2026-09-10T00:00:00Z", firstSeenAt: "2026-09-12T00:00:00Z",
  salary: { raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
  sponsorship: "not_offered", minExperienceYears: 5, ...over,
});
const page = (jobs: unknown[], total = jobs.length, pageNo = 1) => ({ jobs, page: pageNo, pageSize: 25, total });

function mockJobs(respond: (url: string) => unknown) {
  const fn = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => respond(url) }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => vi.unstubAllGlobals());

describe("JobsClient", () => {
  it("shows what was read from each posting — and says 'not stated' rather than inventing values", async () => {
    mockJobs(() => page([
      job(),
      job({ id: "j2", title: "Analyst", workMode: "unknown", postedAt: null, sponsorship: "unknown", minExperienceYears: null,
        salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false } }),
    ]));
    render(<JobsClient />);
    expect(await screen.findByRole("link", { name: "Data Engineer" })).toHaveAttribute("href", "/jobs/j1");
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText(/5\+ years experience/)).toBeInTheDocument();
    expect(screen.getByText("Posted Sep 10, 2026")).toBeInTheDocument();

    expect(screen.getByText(/Not stated · Sponsorship not stated/)).toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
    expect(screen.getByText(/Work mode not stated/)).toBeInTheDocument();
  });

  it("searches and filters by status, resetting to page 1", async () => {
    const fn = mockJobs(() => page([job()]));
    render(<JobsClient />);
    await screen.findByText("Data Engineer");
    expect(fn.mock.calls[0][0]).toBe("/api/jobs?status=open&page=1");

    fireEvent.change(screen.getByLabelText("Title or company"), { target: { value: " data " } });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fn.mock.calls.at(-1)?.[0]).toBe("/api/jobs?status=all&page=1&q=data"));
  });

  it("pages through results", async () => {
    const fn = mockJobs((url) => (url.includes("page=2") ? page([job({ id: "j26", title: "Job 26" })], 26, 2) : page([job()], 26, 1)));
    render(<JobsClient />);
    expect(await screen.findByText("Showing 1–25 of 26")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(fn.mock.calls.at(-1)?.[0]).toContain("page=2");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("points to the sources page when there are no jobs, and offers a retry on failure", async () => {
    mockJobs(() => page([]));
    const { unmount } = render(<JobsClient />);
    expect(await screen.findByRole("link", { name: /Add a source and run it/ })).toHaveAttribute("href", "/sources");
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<JobsClient />);
    expect(await screen.findByText(/Could not load jobs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
