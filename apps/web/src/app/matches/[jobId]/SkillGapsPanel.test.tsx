// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillGapsPanel } from "./SkillGapsPanel";

const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const ready = {
  requirementsStatus: "ready", coveredCount: 3, declinedCount: 1, profileSkills: ["Postgres"],
  unanswered: [{ termKey: "postgresql", termDisplay: "PostgreSQL", suggestion: "Postgres" }],
};
beforeEach(() => vi.unstubAllGlobals());

describe("SkillGapsPanel", () => {
  it("lists this job's unanswered skills with the answer controls and the counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(ready)));
    render(<SkillGapsPanel jobId="j1" />);
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I have it" })).toBeInTheDocument();
    expect(screen.getByText("3 covered by your profile · 1 you don't have")).toBeInTheDocument();
  });

  it("offers to check requirements when they are missing", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(respond({ ...ready, requirementsStatus: "missing", unanswered: [], coveredCount: 0, declinedCount: 0 }))
      .mockResolvedValueOnce(respond(ready));
    vi.stubGlobal("fetch", fetchFn);
    render(<SkillGapsPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check requirements" }));
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    expect(fetchFn.mock.calls[1]).toEqual(["/api/skill-gaps/j1/requirements", { method: "POST" }]);
  });

  it("says when every required skill is answered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...ready, unanswered: [] })));
    render(<SkillGapsPanel jobId="j1" />);
    expect(await screen.findByText("Every required skill is covered or answered.")).toBeInTheDocument();
  });

  it("shows a failed check's error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(respond({ ...ready, requirementsStatus: "missing", unanswered: [] }))
      .mockResolvedValueOnce(respond({ error: "Could not check this job's requirements. Try again." }, 502)));
    render(<SkillGapsPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check requirements" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check this job's requirements");
  });
});
