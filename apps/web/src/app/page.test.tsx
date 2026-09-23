// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@ai-career/config", () => ({ loadEnv: () => ({ NODE_ENV: "test" }) }));

import Home from "./page";

describe("Home", () => {
  it("links to each step of the user journey, in order", () => {
    render(<Home />);

    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/profile", "/career-goal", "/sources", "/jobs", "/matches"]);
    expect(screen.getByRole("link", { name: /candidate profile/i })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("link", { name: /describe the roles you want/i })).toHaveAttribute("href", "/career-goal");
    expect(screen.getByRole("link", { name: /job sources/i })).toHaveAttribute("href", "/sources");
    expect(screen.getByRole("link", { name: /browse what was ingested/i })).toHaveAttribute("href", "/jobs");
    expect(screen.getByRole("link", { name: /jobs ranked against your career goal/i })).toHaveAttribute("href", "/matches");
  });

  it("no longer describes the app as a foundation-phase shell", () => {
    render(<Home />);
    expect(screen.queryByText(/foundation phase/i)).not.toBeInTheDocument();
  });
});
