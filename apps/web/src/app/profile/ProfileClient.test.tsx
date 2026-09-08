// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProfileClient } from "./ProfileClient";

describe("ProfileClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an error and a retry button when GET /api/profile fails, and recovers on retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ json: async () => ({ profile: null }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProfileClient />);

    await waitFor(() => expect(screen.getByText(/could not load your profile/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(screen.getByLabelText(/resume file/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("goes straight to the review form when the user starts a blank profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ profile: null }) }));

    render(<ProfileClient />);

    await waitFor(() => expect(screen.getByLabelText(/resume file/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /start with a blank profile/i }));

    expect(await screen.findByLabelText(/^full name$/i)).toHaveValue("");
  });
});
