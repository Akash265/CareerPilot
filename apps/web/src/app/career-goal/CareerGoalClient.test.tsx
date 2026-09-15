// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CareerGoalClient } from "./CareerGoalClient";

describe("CareerGoalClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an error and a retry button when GET /api/career-goal fails, and recovers on retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ activeGoal: null, history: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<CareerGoalClient />);

    await waitFor(() => expect(screen.getByText(/could not load your career goal/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(screen.getByLabelText(/describe the roles/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows an error on a non-2xx GET response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

    render(<CareerGoalClient />);

    await waitFor(() => expect(screen.getByText(/could not load your career goal/i)).toBeInTheDocument());
  });

  it("shows the goal form when there is no active goal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ activeGoal: null, history: [] }) }));

    render(<CareerGoalClient />);

    await waitFor(() => expect(screen.getByLabelText(/describe the roles/i)).toBeInTheDocument());
  });

  it("shows the dashboard when an active goal exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          activeGoal: {
            id: "goal-1",
            version: 1,
            rawText: "Data jobs in Germany",
            confirmedAt: "2026-09-10T00:00:00.000Z",
            constraints: {
              targetRoles: ["Data Engineer"],
              seniority: null,
              locations: [],
              workMode: "any",
              minExperienceYears: null,
              employmentType: null,
              salaryFloorRaw: null,
              salaryFloorNormalized: null,
              salaryCurrency: null,
              salaryIsParsed: false,
              visaSponsorshipRequired: null,
              skills: [],
              preferredIndustries: [],
              excludedIndustries: [],
              preferredCompanies: [],
              excludedCompanies: [],
              hardConstraints: [],
            },
          },
          history: [],
        }),
      })
    );

    render(<CareerGoalClient />);

    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
  });
});
