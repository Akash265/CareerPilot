// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileDashboard } from "./ProfileDashboard";

const profile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  skills: [{ name: "SQL", category: null }],
  workExperiences: [],
  education: [],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("ProfileDashboard", () => {
  it("renders the saved profile's name and skills", () => {
    render(<ProfileDashboard profile={profile as any} onEdit={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("calls onEdit when the Edit button is clicked", () => {
    const onEdit = vi.fn();
    render(<ProfileDashboard profile={profile as any} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
