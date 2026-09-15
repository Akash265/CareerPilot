// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GoalForm } from "./GoalForm";

const validDraft = {
  targetRoles: ["Data Engineer"],
  seniority: null,
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
};

describe("GoalForm", () => {
  it("shows an error and does not parse when the text is empty", async () => {
    const onParsed = vi.fn();
    render(<GoalForm onParsed={onParsed} />);

    fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));

    expect(await screen.findByText(/please enter a career goal/i)).toBeInTheDocument();
    expect(onParsed).not.toHaveBeenCalled();
  });

  it("submits the raw text and calls onParsed with the parsed draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          goalId: "goal-1",
          version: 1,
          rawText: "Data jobs in Germany",
          status: "parsed",
          draft: validDraft,
        }),
      })
    );
    const onParsed = vi.fn();
    render(<GoalForm onParsed={onParsed} />);

    fireEvent.change(screen.getByLabelText(/describe the roles/i), {
      target: { value: "Data jobs in Germany" },
    });
    fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));

    await waitFor(() =>
      expect(onParsed).toHaveBeenCalledWith({
        goalId: "goal-1",
        version: 1,
        rawText: "Data jobs in Germany",
        draft: validDraft,
      })
    );
  });

  it("shows the server error when parsing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ json: async () => ({ status: "failed", error: "Extraction failed" }) })
    );
    const onParsed = vi.fn();
    render(<GoalForm onParsed={onParsed} />);

    fireEvent.change(screen.getByLabelText(/describe the roles/i), { target: { value: "Something" } });
    fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));

    await waitFor(() => expect(screen.getByText("Extraction failed")).toBeInTheDocument());
    expect(onParsed).not.toHaveBeenCalled();
  });

  it("shows a network-error message when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<GoalForm onParsed={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/describe the roles/i), { target: { value: "Something" } });
    fireEvent.click(screen.getByRole("button", { name: /understand my goal/i }));

    await waitFor(() => expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument());
  });

  it("prefills the textarea from initialRawText", () => {
    render(<GoalForm initialRawText="Existing goal text" onParsed={vi.fn()} />);
    expect(screen.getByLabelText(/describe the roles/i)).toHaveValue("Existing goal text");
  });
});
