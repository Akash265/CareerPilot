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

function confirm() {
  fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));
}

function sentBody() {
  const [, requestInit] = vi.mocked(fetch).mock.calls[0];
  return JSON.parse(requestInit?.body as string);
}

describe("ReviewForm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "saved", factsGenerated: 1 }) }));
  });

  it("lets the user edit the full name before confirming", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/^full name$/i), { target: { value: "Grace Hopper" } });
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody().contact.fullName).toBe("Grace Hopper");
  });

  it("edits the work mode preference through the select", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/work mode preference/i), { target: { value: "hybrid" } });
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody().workModePreference).toBe("hybrid");
  });

  it("converts blank nullable text inputs to null and numeric inputs to numbers", async () => {
    const onSaved = vi.fn();
    render(
      <ReviewForm
        initialProfile={{
          ...initialProfile,
          contact: { ...initialProfile.contact, phoneNumber: "555-0100" },
        }}
        onSaved={onSaved}
      />
    );

    fireEvent.change(screen.getByLabelText(/phone number/i), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText(/years of experience/i), { target: { value: "7" } });
    fireEvent.click(screen.getByLabelText(/visa sponsorship required/i));
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = sentBody();
    expect(body.contact.phoneNumber).toBeNull();
    expect(body.yearsOfExperience).toBe(7);
    expect(body.visaSponsorshipRequired).toBe(true);
  });

  it("adds an education entry and sends its edited fields", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: /add education/i }));
    fireEvent.change(screen.getByLabelText(/institution 1/i), { target: { value: "Cambridge" } });
    fireEvent.change(screen.getByLabelText(/degree 1/i), { target: { value: "BSc" } });
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody().education).toEqual([
      { institution: "Cambridge", degree: "BSc", fieldOfStudy: null, startDate: null, endDate: null, gpa: null },
    ]);
  });

  it("adds a work experience whose bullets are split per line, dropping blank lines", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole("button", { name: /add work experience/i }));
    fireEvent.change(screen.getByLabelText(/company 1/i), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/job title 1/i), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText(/bullets 1/i), {
      target: { value: "Shipped the thing\n\nMeasured the thing" },
    });
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [experience] = sentBody().workExperiences;
    expect(experience.company).toBe("Acme");
    expect(experience.bullets).toEqual(["Shipped the thing", "Measured the thing"]);
  });

  it("parses comma-separated preference lists and drops empty entries", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/preferred role titles/i), {
      target: { value: "Data Engineer, Analytics Engineer, " },
    });
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody().preferredRoleTitles).toEqual(["Data Engineer", "Analytics Engineer"]);
  });

  it("removes a skill row", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    expect(screen.getByLabelText(/skill name 1/i)).toHaveValue("Analytical Engines");
    fireEvent.click(screen.getByRole("button", { name: /remove skill 1/i }));
    confirm();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody().skills).toEqual([]);
  });
});
