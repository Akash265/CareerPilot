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
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs, minimum €60k" initialDraft={initialDraft} onConfirmed={vi.fn()} />
    );
    expect(screen.getByText("Data jobs, minimum €60k")).toBeInTheDocument();
    expect(screen.getByText(/could not confidently read a number/i)).toBeInTheDocument();
  });

  it("marks the salary as parsed once both an amount and currency are entered by hand", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} />
    );

    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: "60000" } });
    fireEvent.change(screen.getByLabelText(/^currency$/i), { target: { value: "EUR" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(sentBody().constraints.salaryIsParsed).toBe(true);
    expect(sentBody().constraints.salaryFloorNormalized).toBe(60000);
  });

  it("edits target roles and drops empty entries on submit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "confirmed" }) }));
    const onConfirmed = vi.fn();
    render(
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} />
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
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} />
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
      <GoalReviewForm goalId="goal-1" version={1} rawText="Data jobs" initialDraft={initialDraft} onConfirmed={onConfirmed} />
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(screen.getByText("Invalid goal")).toBeInTheDocument());
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
