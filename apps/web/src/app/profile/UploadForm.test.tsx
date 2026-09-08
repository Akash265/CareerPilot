// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UploadForm } from "./UploadForm";

describe("UploadForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ status: "extracted", draft: { contact: { fullName: "Ada" } } }),
      })
    );
  });

  it("uploads the selected file and reports the draft on success", async () => {
    const onExtracted = vi.fn();
    render(<UploadForm onExtracted={onExtracted} onStartBlank={vi.fn()} />);

    const file = new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/resume file/i);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    await waitFor(() => expect(onExtracted).toHaveBeenCalledWith({ contact: { fullName: "Ada" } }));
  });

  it("shows an error message when no file is selected", () => {
    render(<UploadForm onExtracted={vi.fn()} onStartBlank={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it("shows an error message when the upload request itself fails (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<UploadForm onExtracted={vi.fn()} onStartBlank={vi.fn()} />);

    const file = new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/resume file/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    await waitFor(() => expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument());
  });

  it("calls onStartBlank when the blank-profile link is clicked", () => {
    const onStartBlank = vi.fn();
    render(<UploadForm onExtracted={vi.fn()} onStartBlank={onStartBlank} />);
    fireEvent.click(screen.getByRole("button", { name: /start with a blank profile/i }));
    expect(onStartBlank).toHaveBeenCalled();
  });
});
