// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileDashboard } from "./ProfileDashboard";
import type { EditableProfile } from "./ReviewForm";

const profile: EditableProfile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: null,
  workModePreference: "any",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: false,
  workAuthorizationNotes: null,
  preferredRoleTitles: [],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  education: [],
  workExperiences: [],
  skills: [{ name: "SQL", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

describe("ProfileDashboard", () => {
  it("renders the saved profile's name and skills", () => {
    render(<ProfileDashboard profile={profile} onEdit={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("calls onEdit when the Edit button is clicked", () => {
    const onEdit = vi.fn();
    render(<ProfileDashboard profile={profile} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
