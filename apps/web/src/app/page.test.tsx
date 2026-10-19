// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@ai-career/config", () => ({ loadEnv: () => ({ NODE_ENV: "test" }) }));

import Home from "./page";

function serveUsage(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)));
}
const usage = (spentUsd: number, state: string, ceilingUsd: number | null = 20) => ({ spentUsd, state, ceilingUsd });

beforeEach(() => {
  vi.unstubAllGlobals();
  serveUsage(usage(1, "ok"));
});

describe("Home", () => {
  it("links to each step of the user journey, in order", () => {
    render(<Home />);

    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/profile", "/career-goal", "/sources", "/jobs", "/matches", "/skills", "/applications", "/insights", "/usage", "/status"]);
    expect(screen.getByRole("link", { name: /candidate profile/i })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("link", { name: /describe the roles you want/i })).toHaveAttribute("href", "/career-goal");
    expect(screen.getByRole("link", { name: /job sources/i })).toHaveAttribute("href", "/sources");
    expect(screen.getByRole("link", { name: /browse what was ingested/i })).toHaveAttribute("href", "/jobs");
    expect(screen.getByRole("link", { name: /jobs ranked against your career goal/i })).toHaveAttribute("href", "/matches");
    expect(screen.getByRole("link", { name: "5a. Verify skills — confirm the skills your top matches require" })).toHaveAttribute("href", "/skills");
    expect(screen.getByRole("link", { name: /track what you've applied to/i })).toHaveAttribute("href", "/applications");
    expect(screen.getByRole("link", { name: /which applications get responses/i })).toHaveAttribute("href", "/insights");
    expect(screen.getByRole("link", { name: /estimated spend against your monthly budget/i })).toHaveAttribute("href", "/usage");
    expect(screen.getByRole("link", { name: "9. System status — workers and queues" })).toHaveAttribute("href", "/status");
  });

  it("shows no AI budget badge while spend is under the warn threshold", async () => {
    render(<Home />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/usage"));
    expect(screen.queryByText(/AI budget/)).not.toBeInTheDocument();
  });

  it("badges the AI usage link with the floored percentage once spend passes the warn threshold", async () => {
    serveUsage(usage(16.99, "warn"));
    render(<Home />);
    expect(await screen.findByText("84% of AI budget")).toBeInTheDocument();
  });

  it("badges the AI usage link when the budget is reached", async () => {
    serveUsage(usage(20, "over"));
    render(<Home />);
    expect(await screen.findByText("AI budget reached")).toBeInTheDocument();
  });

  it("shows no badge with no ceiling, or when usage cannot be loaded", async () => {
    serveUsage(usage(500, "unlimited", null));
    const { unmount } = render(<Home />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/AI budget/)).not.toBeInTheDocument();
    unmount();
    serveUsage({}, false);
    render(<Home />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/AI budget/)).not.toBeInTheDocument();
  });

  it("no longer describes the app as a foundation-phase shell", () => {
    render(<Home />);
    expect(screen.queryByText(/foundation phase/i)).not.toBeInTheDocument();
  });
});
