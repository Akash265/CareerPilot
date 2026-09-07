// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewForm, type EditableProfile } from "./ReviewForm";

const initialProfile: EditableProfile = {
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
  skills: [{ name: "Analytical Engines", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

describe("ReviewForm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "saved", factsGenerated: 1 }) }));
  });

  it("lets the user edit the full name before confirming", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    const nameInput = screen.getByLabelText(/full name/i);
    fireEvent.change(nameInput, { target: { value: "Grace Hopper" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, requestInit] = (fetch as any).mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.contact.fullName).toBe("Grace Hopper");
  });
});
