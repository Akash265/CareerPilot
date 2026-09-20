// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GoalReviewForm, type CareerGoalConstraintsDraft } from "./GoalReviewForm";

const initialDraft: CareerGoalConstraintsDraft = {
  targetRoles: ["Data Engineer"],
  seniority: null,
  locations: [],
  workMode: "any",
  minExperienceYears: null,
  employmentType: null,
  salaryFloorRaw: "minimum €60k",
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
};

function sentBody() {
  const [, requestInit] = vi.mocked(fetch).mock.calls[0];
  return JSON.parse(requestInit?.body as string);
}

describe("GoalReviewForm", () => {
  it("shows the raw text and a warning when the salary phrase could not be parsed", () => {
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs, minimum €60k" initialDraft={initialDraft} onConfirmed={vi.fn()} onBack={vi.fn()} />
    );
    expect(screen.getByText("Data jobs, minimum €60k")).toBeInTheDocument();
    expect(screen.getByText(/could not confidently read a number/i)).toBeInTheDocument();
  });

  it("marks the salary as parsed once both an amount and currency are entered by hand", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} onBack={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText(/^minimum salary amount$/i), { target: { value: "60000" } });
    fireEvent.change(screen.getByLabelText(/^minimum salary currency$/i), { target: { value: "EUR" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(sentBody().constraints.salaryIsParsed).toBe(true);
    expect(sentBody().constraints.salaryFloorNormalized).toBe(60000);
  });

  it("edits target roles and drops empty entries on submit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} onBack={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText(/target roles/i), {
      target: { value: "Data Engineer, Analytics Engineer, " },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(sentBody().constraints.targetRoles).toEqual(["Data Engineer", "Analytics Engineer"]);
  });

  it("sets visa sponsorship from the tri-state select", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} onBack={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText(/visa sponsorship/i), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(sentBody().constraints.visaSponsorshipRequired).toBe(true);
  });

  it("shows an error and does not call onConfirmed when the server rejects the save", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ error: "Invalid goal" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} onBack={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(screen.getByText("Invalid goal")).toBeInTheDocument());
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  describe("preferred salary", () => {
    const withTarget: CareerGoalConstraintsDraft = {
      ...initialDraft,
      salaryFloorRaw: null,
      salaryTargetRaw: "ideally around 80k",
    };

    it("warns about an unparsed preferred-salary phrase separately from the minimum's", () => {
      render(
        <GoalReviewForm goalId="g" version={1} rawText="x" initialDraft={{ ...withTarget, salaryFloorRaw: "minimum 60k" }} onConfirmed={vi.fn()} onBack={vi.fn()} />
      );
      expect(screen.getByText(/could not confidently read a number from "minimum 60k"/i)).toBeInTheDocument();
      expect(screen.getByText(/could not confidently read a number from "ideally around 80k"/i)).toBeInTheDocument();
    });

    it("marks the preferred salary parsed once both amount and currency are entered, without touching the minimum", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
      const onConfirmed = vi.fn();
      render(<GoalReviewForm goalId="g" version={1} rawText="x" initialDraft={withTarget} onConfirmed={onConfirmed} onBack={vi.fn()} />);

      fireEvent.change(screen.getByLabelText(/^preferred salary amount$/i), { target: { value: "80000" } });
      fireEvent.change(screen.getByLabelText(/^preferred salary currency$/i), { target: { value: "EUR" } });
      fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

      await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
      const constraints = sentBody().constraints;
      expect(constraints).toMatchObject({
        salaryTargetNormalized: 80000,
        salaryTargetCurrency: "EUR",
        salaryTargetIsParsed: true,
        salaryFloorNormalized: null,
        salaryCurrency: null,
        salaryIsParsed: false,
      });
    });

    it("shows the server's rejection when the preferred salary is below the minimum", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          json: async () => ({ error: "constraints.salaryTargetNormalized: Preferred salary cannot be lower than the minimum salary" }),
        })
      );
      render(<GoalReviewForm goalId="g" version={1} rawText="x" initialDraft={withTarget} onConfirmed={vi.fn()} onBack={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

      expect(await screen.findByText(/preferred salary cannot be lower than the minimum/i)).toBeInTheDocument();
    });
  });

  it("lets the user go back and edit their statement without saving anything", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onBack = vi.fn();
    render(<GoalReviewForm goalId="g" version={1} rawText="x" initialDraft={initialDraft} onConfirmed={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: /edit my statement/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
