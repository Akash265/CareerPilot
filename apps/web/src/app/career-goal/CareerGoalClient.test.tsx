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
              salaryTargetRaw: null,
              salaryTargetNormalized: null,
              salaryTargetCurrency: null,
              salaryTargetIsParsed: false,
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

  describe("across the whole flow", () => {
    const baseConstraints = {
      targetRoles: ["Data Engineer"], seniority: null, locations: ["Germany"], workMode: "remote",
      minExperienceYears: 3, employmentType: null,
      salaryFloorRaw: "minimum €60k", salaryFloorNormalized: 60000, salaryCurrency: "EUR", salaryIsParsed: true,
      salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false,
      visaSponsorshipRequired: null, skills: [], preferredIndustries: [], excludedIndustries: [],
      preferredCompanies: [], excludedCompanies: [], hardConstraints: [],
    };
    const goalState = (version: number, rawText: string, history: number[]) => ({
      activeGoal: { id: `goal-${version}`, version, rawText, confirmedAt: "2026-09-20T09:30:00.000Z", constraints: baseConstraints },
      history: history.map((v) => ({ id: `goal-${v}`, version: v, rawText: `statement ${v}`, confirmedAt: "2026-09-20T09:30:00.000Z" })),
    });

    it("lets the user go back from the review screen to their statement, unchanged, without saving", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push(`${init?.method ?? "GET"} ${url}`);
          if (url === "/api/career-goal") return { ok: true, json: async () => ({ activeGoal: null, history: [] }) };
          return { ok: true, json: async () => ({ goalId: "goal-1", version: 1, rawText: "Data jobs in Germany", status: "parsed", draft: baseConstraints }) };
        })
      );
      render(<CareerGoalClient />);

      fireEvent.change(await screen.findByLabelText(/describe the roles/i), { target: { value: "Data jobs in Germany" } });
      fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));
      fireEvent.click(await screen.findByRole("button", { name: /edit my statement/i }));

      expect(await screen.findByLabelText(/describe the roles/i)).toHaveValue("Data jobs in Germany");
      expect(calls).toEqual(["GET /api/career-goal", "POST /api/career-goal/parse"]);
    });

    it("runs enter -> review -> confirm -> dashboard, then edit -> review -> confirm -> a second version", async () => {
      let confirmed = 0;
      const posted: Array<{ url: string; body: { rawText?: string; goalId?: string } }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (init?.method === "POST") posted.push({ url, body: JSON.parse(init.body as string) });
          if (url === "/api/career-goal/parse") {
            const version = confirmed + 1;
            return { ok: true, json: async () => ({ goalId: `goal-${version}`, version, rawText: JSON.parse(init!.body as string).rawText, status: "parsed", draft: baseConstraints }) };
          }
          if (url === "/api/career-goal/confirm") {
            confirmed += 1;
            return { ok: true, json: async () => ({ status: "confirmed" }) };
          }
          return {
            ok: true,
            json: async () =>
              confirmed === 0
                ? { activeGoal: null, history: [] }
                : goalState(confirmed, posted.filter((p) => p.url.endsWith("/parse"))[confirmed - 1].body.rawText ?? "", Array.from({ length: confirmed }, (_, i) => confirmed - i)),
          };
        })
      );
      render(<CareerGoalClient />);

      // first goal
      fireEvent.change(await screen.findByLabelText(/describe the roles/i), { target: { value: "first statement" } });
      fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));
      expect(await screen.findByText("Version 1 — your original statement")).toBeInTheDocument();
      expect(screen.getByText("first statement")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));
      expect(await screen.findByText("Version 1")).toBeInTheDocument();
      expect(screen.getByText("Confirmed 2026-09-20")).toBeInTheDocument();

      // edit -> a new parse, prefilled with the current statement
      fireEvent.click(screen.getByRole("button", { name: /edit goal/i }));
      const box = await screen.findByLabelText(/describe the roles/i);
      expect(box).toHaveValue("first statement");
      fireEvent.change(box, { target: { value: "second statement" } });
      fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));
      expect(await screen.findByText("Version 2 — your original statement")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

      expect(await screen.findByText("Version 2")).toBeInTheDocument();
      expect(screen.getByText(/version 1 — statement 1/i)).toBeInTheDocument();
      expect(posted.filter((p) => p.url.endsWith("/confirm")).map((p) => p.body.goalId)).toEqual(["goal-1", "goal-2"]);
    });
  });
});
