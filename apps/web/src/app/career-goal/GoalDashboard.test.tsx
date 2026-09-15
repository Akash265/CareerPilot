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
