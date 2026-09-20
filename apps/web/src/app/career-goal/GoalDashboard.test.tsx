// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GoalDashboard, type ActiveGoal, type GoalHistoryEntry } from "./GoalDashboard";

const activeGoal: ActiveGoal = {
  id: "goal-2",
  version: 2,
  rawText: "Data jobs in Germany, remote, visa sponsorship",
  confirmedAt: "2026-09-10T00:00:00.000Z",
  constraints: {
    targetRoles: ["Data Engineer"],
    seniority: "Senior",
    locations: ["Germany"],
    workMode: "remote",
    minExperienceYears: 3,
    employmentType: null,
    salaryFloorRaw: "minimum €60k",
    salaryFloorNormalized: 60000,
    salaryCurrency: "EUR",
    salaryIsParsed: true,
    salaryTargetRaw: "ideally €80k",
    salaryTargetNormalized: 80000,
    salaryTargetCurrency: "EUR",
    salaryTargetIsParsed: true,
    visaSponsorshipRequired: true,
    skills: [],
    preferredIndustries: [],
    excludedIndustries: [],
    preferredCompanies: [],
    excludedCompanies: [],
    hardConstraints: [],
  },
};

const history: GoalHistoryEntry[] = [
  { id: "goal-1", version: 1, rawText: "Data jobs anywhere", confirmedAt: "2026-09-01T00:00:00.000Z" },
  { id: "goal-2", version: 2, rawText: activeGoal.rawText, confirmedAt: activeGoal.confirmedAt },
];

describe("GoalDashboard", () => {
  it("renders the active goal's constraints", () => {
    render(<GoalDashboard activeGoal={activeGoal} history={history} onEdit={vi.fn()} />);
    expect(screen.getByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("remote")).toBeInTheDocument();
    expect(screen.getByText(/60000 eur/i)).toBeInTheDocument();
  });

  it("shows when the active goal was confirmed", () => {
    render(<GoalDashboard activeGoal={activeGoal} history={history} onEdit={vi.fn()} />);
    expect(screen.getByText("Confirmed 2026-09-10")).toBeInTheDocument();
  });

  it("shows when each version in the history was confirmed", () => {
    render(<GoalDashboard activeGoal={activeGoal} history={history} onEdit={vi.fn()} />);
    expect(screen.getByText(/version 1 — data jobs anywhere \(confirmed 2026-09-01\)/i)).toBeInTheDocument();
  });

  it("shows the minimum and the preferred salary, each with the phrase it came from", () => {
    render(<GoalDashboard activeGoal={activeGoal} history={history} onEdit={vi.fn()} />);
    expect(screen.getByText(/60000 EUR — from "minimum €60k"/)).toBeInTheDocument();
    expect(screen.getByText(/80000 EUR — from "ideally €80k"/)).toBeInTheDocument();
  });

  it("marks a salary the parser could not fully resolve as unconfirmed", () => {
    const unresolved: ActiveGoal = {
      ...activeGoal,
      constraints: { ...activeGoal.constraints, salaryFloorNormalized: 5000, salaryIsParsed: false, salaryFloorRaw: "5000 per month" },
    };
    render(<GoalDashboard activeGoal={unresolved} history={[]} onEdit={vi.fn()} />);
    expect(screen.getByText(/5000 EUR \(unconfirmed\) — from "5000 per month"/)).toBeInTheDocument();
  });

  it("shows the phrase, and says no number was recognised, when a salary was never converted", () => {
    const noNumber: ActiveGoal = {
      ...activeGoal,
      constraints: { ...activeGoal.constraints, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false, salaryTargetRaw: "competitive" },
    };
    render(<GoalDashboard activeGoal={noNumber} history={[]} onEdit={vi.fn()} />);
    expect(screen.getByText(/"competitive" — no number recognised/)).toBeInTheDocument();
  });

  it("shows a dash for a salary that was never mentioned", () => {
    const none: ActiveGoal = {
      ...activeGoal,
      constraints: { ...activeGoal.constraints, salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false },
    };
    render(<GoalDashboard activeGoal={none} history={[]} onEdit={vi.fn()} />);
    const preferred = screen.getByText("Preferred salary:").parentElement as HTMLElement;
    expect(preferred).toHaveTextContent("Preferred salary: —");
  });

  it("says the date is unknown rather than printing nothing when a confirmation date is missing", () => {
    render(<GoalDashboard activeGoal={{ ...activeGoal, confirmedAt: null }} history={[]} onEdit={vi.fn()} />);
    expect(screen.getByText("Confirmed (date unknown)")).toBeInTheDocument();
  });

  it("renders version history when more than one version exists", () => {
    render(<GoalDashboard activeGoal={activeGoal} history={history} onEdit={vi.fn()} />);
    expect(screen.getByText(/version 1 — data jobs anywhere/i)).toBeInTheDocument();
  });

  it("calls onEdit when the Edit Goal button is clicked", () => {
    const onEdit = vi.fn();
    render(<GoalDashboard activeGoal={activeGoal} history={[]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit goal/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
