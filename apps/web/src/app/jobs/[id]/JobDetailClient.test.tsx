// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response));
beforeEach(() => vi.unstubAllGlobals());

describe("JobDetailClient", () => {
  it("shows each extracted fact next to the text it was read from", async () => {
    respond(200, { job: detail() });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("heading", { name: "AI Engineer" })).toBeInTheDocument();
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText("Source text: “$150,000 - $200,000 per year”")).toBeInTheDocument();
    expect(screen.getByText("No visa sponsorship")).toBeInTheDocument();
    expect(screen.getByText("“Visa sponsorship is not available.”")).toBeInTheDocument();
    expect(screen.getByText("5+ years")).toBeInTheDocument();
    expect(screen.getByText("“5+ years of experience in software engineering”")).toBeInTheDocument();
    expect(screen.getByText("Build agents.")).toBeInTheDocument();
  });

  it("only renders http(s) links for postings — third-party data never becomes a script link", async () => {
    respond(200, { job: detail() });
    render(<JobDetailClient id="j1" />);
    await screen.findByText(/GitLab \(greenhouse\)/);
    const links = screen.getAllByRole("link", { name: "View posting" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://boards.example/1");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/jobs\.csv \(upload\) · closed/)).toBeInTheDocument();
  });

  it("lists possible duplicates as read-only links, and warns about a sponsorship conflict", async () => {
    respond(200, { job: detail({ sponsorship: "unknown", sponsorshipConflict: true }) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("link", { name: "AI Engineers" })).toHaveAttribute("href", "/jobs/j9");
    expect(screen.getByText(/91% title match/)).toBeInTheDocument();
    expect(screen.getByText(/were not merged automatically/)).toBeInTheDocument();
    expect(screen.getByText(/conflicting statements/)).toBeInTheDocument();
  });

  it("hides the duplicates section when there are none, and says when there is no posted date", async () => {
    respond(200, { job: detail({ duplicateCandidates: [], postedAt: null }) });
    render(<JobDetailClient id="j1" />);
    await screen.findByRole("heading", { name: "AI Engineer" });
    expect(screen.queryByText("Possible duplicates")).not.toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
  });

  it("handles a missing job and a failed load", async () => {
    respond(404, { error: "Job not found" });
    const { unmount } = render(<JobDetailClient id="nope" />);
    expect(await screen.findByText("Job not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All jobs/ })).toHaveAttribute("href", "/jobs");
    unmount();

    respond(500, {});
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this job.");
  });
});
