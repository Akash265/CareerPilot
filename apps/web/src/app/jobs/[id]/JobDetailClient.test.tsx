// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { JobDetailClient } from "./JobDetailClient";

const detail = (over: Record<string, unknown> = {}) => ({
  id: "j1", title: "AI Engineer", companyName: "GitLab", locationRaw: "Remote, United States", workMode: "remote", status: "open",
  postedAt: "2026-05-22T13:16:29Z", firstSeenAt: "2026-09-12T00:00:00Z", lastVerifiedAt: "2026-09-20T00:00:00Z", closedAt: null,
  salary: { raw: "$150,000 - $200,000 per year", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
  sponsorship: "not_offered", sponsorshipEvidence: "Visa sponsorship is not available.", sponsorshipConflict: false,
  minExperienceYears: 5, minExperienceEvidence: "5+ years of experience in software engineering",
  seniority: null, employmentType: null, countryCode: null, descriptionText: "Build agents.", fieldProvenance: {},
  postings: [
    { id: "p1", sourceId: "s1", sourceKind: "greenhouse", sourceLabel: "GitLab", url: "https://boards.example/1", status: "open", firstSeenAt: "2026-09-12T00:00:00Z", lastSeenAt: "2026-09-20T00:00:00Z" },
    { id: "p2", sourceId: "s2", sourceKind: "upload", sourceLabel: "jobs.csv", url: "javascript:alert(1)", status: "closed", firstSeenAt: "2026-09-12T00:00:00Z", lastSeenAt: "2026-09-13T00:00:00Z" },
  ],
  duplicateCandidates: [{ jobId: "j9", title: "AI Engineers", companyName: "GitLab", locationRaw: "Remote", status: "open", similarity: 0.91, review: "pending" }],
  ...over,
});

interface Reply {
  status: number;
  body: unknown;
}
const reply = (status: number, body: unknown): Reply => ({ status, body });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// Every fetch must hit a URL the test declared; anything else is recorded and fails the test in afterEach.
let unexpected: string[] = [];
function respond(routes: Record<string, Reply | Promise<Reply>>) {
  const fn = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) {
      unexpected.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }
    const { status, body } = await route;
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => {
  vi.unstubAllGlobals();
  unexpected = [];
});
afterEach(() => {
  // Unmount first: a throwing assertion below would otherwise skip the shared cleanup and leak the DOM into the next test.
  cleanup();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

describe("JobDetailClient", () => {
  it("shows each extracted fact next to the text it was read from", async () => {
    const fn = respond({ "/api/jobs/j1": reply(200, { job: detail() }) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("heading", { name: "AI Engineer" })).toBeInTheDocument();
    expect(fn).toHaveBeenCalledWith("/api/jobs/j1");
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText("Source text: “$150,000 - $200,000 per year”")).toBeInTheDocument();
    expect(screen.getByText("No visa sponsorship")).toBeInTheDocument();
    expect(screen.getByText("“Visa sponsorship is not available.”")).toBeInTheDocument();
    expect(screen.getByText("5+ years")).toBeInTheDocument();
    expect(screen.getByText("“5+ years of experience in software engineering”")).toBeInTheDocument();
    expect(screen.getByText("Build agents.")).toBeInTheDocument();
  });

  it("only renders http(s) links for postings — third-party data never becomes a script link", async () => {
    respond({ "/api/jobs/j1": reply(200, { job: detail() }) });
    render(<JobDetailClient id="j1" />);
    await screen.findByText(/GitLab \(greenhouse\)/);
    const links = screen.getAllByRole("link", { name: "View posting" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://boards.example/1");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/jobs\.csv \(upload\) · closed/)).toBeInTheDocument();
  });

  it("lists possible duplicates as read-only links, and warns about a sponsorship conflict", async () => {
    respond({ "/api/jobs/j1": reply(200, { job: detail({ sponsorship: "unknown", sponsorshipConflict: true }) }) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("link", { name: "AI Engineers" })).toHaveAttribute("href", "/jobs/j9");
    expect(screen.getByText(/91% title match/)).toBeInTheDocument();
    expect(screen.getByText(/were not merged automatically/)).toBeInTheDocument();
    expect(screen.getByText(/conflicting statements/)).toBeInTheDocument();
  });

  it("hides the duplicates section when there are none, and says when there is no posted date", async () => {
    respond({ "/api/jobs/j1": reply(200, { job: detail({ duplicateCandidates: [], postedAt: null }) }) });
    render(<JobDetailClient id="j1" />);
    await screen.findByRole("heading", { name: "AI Engineer" });
    expect(screen.queryByText("Possible duplicates")).not.toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
  });

  it("handles a missing job and a failed load", async () => {
    const missing = respond({ "/api/jobs/nope": reply(404, { error: "Job not found" }) });
    const { unmount } = render(<JobDetailClient id="nope" />);
    expect(await screen.findByText("Job not found.")).toBeInTheDocument();
    expect(missing).toHaveBeenCalledWith("/api/jobs/nope");
    expect(screen.getByRole("link", { name: /All jobs/ })).toHaveAttribute("href", "/jobs");
    unmount();

    const failed = respond({ "/api/jobs/j1": reply(500, {}) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this job.");
    expect(failed).toHaveBeenCalledWith("/api/jobs/j1");
  });

  it("URL-encodes the id it was given", async () => {
    const fn = respond({ "/api/jobs/a%20b": reply(404, { error: "Job not found" }) });
    render(<JobDetailClient id="a b" />);
    expect(await screen.findByText("Job not found.")).toBeInTheDocument();
    expect(fn).toHaveBeenCalledWith("/api/jobs/a%20b");
  });

  it("treats a 200 response without a job as a failed load", async () => {
    respond({ "/api/jobs/j1": reply(200, {}) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this job.");
  });

  it("shows loading, not the previous job, when the id changes", async () => {
    const second = deferred<Reply>();
    respond({
      "/api/jobs/j1": reply(200, { job: detail() }),
      "/api/jobs/j2": second.promise,
    });
    const { rerender } = render(<JobDetailClient id="j1" />);
    await screen.findByRole("heading", { name: "AI Engineer" });

    rerender(<JobDetailClient id="j2" />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI Engineer" })).not.toBeInTheDocument();

    second.resolve(reply(200, { job: detail({ id: "j2", title: "Other Job" }) }));
    expect(await screen.findByRole("heading", { name: "Other Job" })).toBeInTheDocument();
  });

  it("does not update or warn when unmounted before the response arrives", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<Reply>();
    respond({ "/api/jobs/j1": pending.promise });
    const { unmount } = render(<JobDetailClient id="j1" />);
    unmount();

    pending.resolve(reply(200, { job: detail() }));
    await flush();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
