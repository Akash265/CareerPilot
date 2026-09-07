// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileDashboard } from "./ProfileDashboard";
import type { EditableProfile } from "./ReviewForm";

const profile: EditableProfile = {
  contact: {
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phoneNumber: "555-0100",
    linkedinUrl: null,
    addressLine1: null,
  },
  yearsOfExperience: 7,
  workModePreference: "remote",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: true,
  workAuthorizationNotes: null,
  preferredRoleTitles: ["Data Engineer"],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  education: [
    {
      institution: "Cambridge",
      degree: "BSc",
      fieldOfStudy: "Mathematics",
      startDate: "2018-09",
      endDate: "2021-06",
      gpa: null,
    },
  ],
  workExperiences: [
    {
      company: "Acme",
      title: "Engineer",
      location: "Berlin",
      employmentType: null,
      startDate: "2021-07",
      endDate: null,
      bullets: ["Built the analytical engine"],
    },
  ],
  skills: [{ name: "SQL", category: null }],
  projects: [{ name: "Bernoulli Notes", description: "Notes on the engine", url: null }],
  certifications: [{ name: "AWS SAA", issuer: "Amazon", issueDate: "2023-01", expiryDate: null }],
  achievements: ["First published algorithm"],
};

describe("ProfileDashboard", () => {
  it("renders the saved profile's name and skills", () => {
    render(<ProfileDashboard profile={profile} onEdit={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("renders education, work experience, projects, certifications and achievements", () => {
    render(<ProfileDashboard profile={profile} onEdit={vi.fn()} />);

    expect(screen.getByText("Cambridge")).toBeInTheDocument();
    expect(screen.getByText("BSc, Mathematics")).toBeInTheDocument();
    expect(screen.getByText("Engineer — Acme")).toBeInTheDocument();
    expect(screen.getByText("Built the analytical engine")).toBeInTheDocument();
    expect(screen.getByText("Bernoulli Notes")).toBeInTheDocument();
    expect(screen.getByText("AWS SAA")).toBeInTheDocument();
    expect(screen.getByText("First published algorithm")).toBeInTheDocument();
  });

  it("renders contact and preference details, including nullable and boolean fields", () => {
    render(<ProfileDashboard profile={profile} onEdit={vi.fn()} />);

    expect(screen.getByText("555-0100")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("remote")).toBeInTheDocument();
    // visaSponsorshipRequired: true renders as a human-readable "Yes".
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("Data Engineer")).toBeInTheDocument();
  });

  it("calls onEdit when the Edit button is clicked", () => {
    const onEdit = vi.fn();
    render(<ProfileDashboard profile={profile} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
