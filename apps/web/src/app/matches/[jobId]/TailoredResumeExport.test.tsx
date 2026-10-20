// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TailoredResumeExport, tailoredSummary } from "./TailoredResumeExport";

beforeEach(() => vi.unstubAllGlobals());

describe("tailoredSummary", () => {
  it("describes counts and page state", () => {
    expect(tailoredSummary({ pageCount: 1, pageVerified: true, includedCount: 11, totalCount: 19 })).toBe("Included 11 of 19 items · 1 page");
    expect(tailoredSummary({ pageCount: 2, pageVerified: true, includedCount: 9, totalCount: 9 })).toBe("Included 9 of 9 items · 2 pages — couldn't fit to one");
    expect(tailoredSummary({ pageCount: null, pageVerified: false, includedCount: 5, totalCount: 6 })).toBe("Included 5 of 6 items · page count not verified");
  });
});

describe("TailoredResumeExport", () => {
  it("offers PDF and .tex, then shows the summary and the left-out items with reasons", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return Promise.resolve({ ok: true, status: 200 } as Response);
      return Promise.resolve({
        ok: true, status: 201,
        json: async () => ({
          document: { downloadUrl: "/api/documents/t1/download", details: { pageCount: 1, pageVerified: true, includedCount: 2, totalCount: 4 } },
          omittedItems: [{ sourceType: "project", text: "Blog: Cooking blog", reason: "no_requirement_match" }, { sourceType: "work_experience_bullet", text: "Wrote docs", reason: "page_limit" }],
        }),
      } as Response);
    }));
    render(<TailoredResumeExport jobId="j1" optimizationId="o1" navigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Tailored resume (LaTeX, 1 page)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download tailored .tex" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download tailored PDF" }));
    await waitFor(() => expect(screen.getByText("Included 2 of 4 items · 1 page")).toBeTruthy());
    fireEvent.click(screen.getByText("Left out (2)"));
    expect(screen.getByText("Blog: Cooking blog")).toBeTruthy();
    expect(screen.getByText("no matching job requirement")).toBeTruthy();
    expect(screen.getByText("page limit")).toBeTruthy();
  });
});
