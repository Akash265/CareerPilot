// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { PitchPanel, researchAgeLabel } from "./PitchPanel";

const NOW_ISO = new Date().toISOString();
const bullets = [
  { kind: "company", text: "Acme's rocket work excites me.", supported: true, unsupportedReason: null,
    evidence: [{ id: "r:1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" }] },
  { kind: "role", text: "The role centres on SQL.", supported: true, unsupportedReason: null,
    evidence: [{ id: "q:1", kind: "requirement", text: "[required] SQL", sourceUrl: null }] },
  { kind: "candidate", text: "I built SQL pipelines.", supported: true, unsupportedReason: null,
    evidence: [{ id: "p:1", kind: "profile", text: "Built SQL pipelines", sourceUrl: null }] },
];
const pitch = {
  id: "p1", version: 1, origin: "generated", parentPitchId: null, bullets, requiresReview: false,
  researchStatus: "ok", researchedAt: NOW_ISO, generationModel: "fast-model", createdAt: NOW_ISO,
};
const research = { id: "r1", companyName: "Acme", status: "ok", researchedAt: NOW_ISO, searchCount: 2, facts: [] };

function mockFetchSequence(responses: { body: unknown; status?: number }[]) {
  const fn = vi.fn();
  for (const { body, status = 200 } of responses) {
    fn.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as Response);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("researchAgeLabel", () => {
  it("formats today, one day and several days", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(researchAgeLabel("2026-09-24T01:00:00Z", now)).toBe("today");
    expect(researchAgeLabel("2026-09-23T01:00:00Z", now)).toBe("1 day ago");
    expect(researchAgeLabel("2026-09-12T12:00:00Z", now)).toBe("12 days ago");
  });
});

describe("PitchPanel", () => {
  it("shows a Retry button on load failure and recovers when clicked", async () => {
    const fetchMock = mockFetchSequence([
      { body: {}, status: 500 },
      { body: { versions: [pitch], research } },
    ]);
    render(<PitchPanel jobId="j1" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not load the pitch/i);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Acme's rocket work excites me.")).toBeInTheDocument();
  });

  it("ignores a stale load response for a jobId that is no longer current", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ versions: [{ ...pitch, id: "p-j2" }], research }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<PitchPanel jobId="j1" />);
    rerender(<PitchPanel jobId="j2" />);

    expect(await screen.findByText("Acme's rocket work excites me.")).toBeInTheDocument();

    // The stale j1 fetch resolves after j2's request already settled -- it must be ignored, not
    // revert the panel to j1's (empty) state.
    await act(async () => {
      resolveFirst({ ok: true, status: 200, json: async () => ({ versions: [], research: null }) } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/no pitch generated yet/i)).not.toBeInTheDocument();
    expect(screen.getByText("Acme's rocket work excites me.")).toBeInTheDocument();
  });

  it("shows an empty state and a Generate Pitch button", async () => {
    mockFetchSequence([{ body: { versions: [], research: null } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findByText(/no pitch generated yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Pitch" })).toBeInTheDocument();
  });

  it("renders the three labelled bullets and the research age", async () => {
    mockFetchSequence([{ body: { versions: [pitch], research } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findByText("Acme's rocket work excites me.")).toBeInTheDocument();
    expect(screen.getByText("Why this company")).toBeInTheDocument();
    expect(screen.getByText("Why this role")).toBeInTheDocument();
    expect(screen.getByText("Why me")).toBeInTheDocument();
    expect(screen.getByText(/company researched today/i)).toBeInTheDocument();
  });

  it("shows a review banner naming each unsupported bullet and its reason", async () => {
    const flagged = { ...pitch, requiresReview: true, bullets: [bullets[0], { ...bullets[1], supported: false, unsupportedReason: "cites no job requirement" }, bullets[2]] };
    mockFetchSequence([{ body: { versions: [flagged], research } }]);
    render(<PitchPanel jobId="j1" />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/review needed/i);
    expect(banner).toHaveTextContent("Why this role: cites no job requirement");
  });

  it("labels an edited version's bullets as your wording", async () => {
    const edited = { ...pitch, id: "p2", version: 2, origin: "user_edited", bullets: bullets.map((b) => ({ ...b, supported: null })) };
    mockFetchSequence([{ body: { versions: [edited, pitch], research } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findAllByText("your wording")).toHaveLength(3);
    expect(screen.getByRole("combobox")).toHaveDisplayValue(/v2 · edited/);
  });

  it("says web research is unavailable when the selected pitch's own research failed", async () => {
    mockFetchSequence([{ body: { versions: [{ ...pitch, researchStatus: "failed" }], research: { ...research, status: "failed" } } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findByText(/web research unavailable/i)).toBeInTheDocument();
  });

  it("shows the posting-data-only note when the selected pitch's own research failed, even if current research is ok", async () => {
    mockFetchSequence([{ body: { versions: [{ ...pitch, researchStatus: "failed" }], research } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findByText(/web research unavailable/i)).toBeInTheDocument();
  });

  it("shows the research age when the selected pitch's own research succeeded, even if current research failed", async () => {
    mockFetchSequence([{ body: { versions: [{ ...pitch, researchStatus: "ok" }], research: { ...research, status: "failed" } } }]);
    render(<PitchPanel jobId="j1" />);
    expect(await screen.findByText(/company researched today/i)).toBeInTheDocument();
  });

  it("keeps the age text and Refresh button driven by current research when there is no selected pitch", async () => {
    mockFetchSequence([{ body: { versions: [], research } }]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText(/no pitch generated yet/i);
    expect(screen.getByText(/company researched today/i)).toBeInTheDocument();
  });

  it("links only http(s) evidence sources, with safe rel attributes", async () => {
    const withBadUrl = { ...pitch, bullets: [{ ...bullets[0], evidence: [...bullets[0].evidence, { id: "r:2", kind: "research", text: "Sneaky.", sourceUrl: "javascript:alert(1)" }] }, bullets[1], bullets[2]] };
    mockFetchSequence([{ body: { versions: [withBadUrl], research } }]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    const links = screen.getAllByRole("link", { hidden: true });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://acme.example");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(links[0]).toHaveAttribute("target", "_blank");
  });

  it("calls the run endpoint then reloads when Regenerate is clicked", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [pitch], research } },
      { body: { pitch: { ...pitch, id: "p2", version: 2 }, research }, status: 201 },
      { body: { versions: [{ ...pitch, id: "p2", version: 2 }, pitch], research } },
    ]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/application-pitches/j1/run");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("shows the server's error message when generation fails", async () => {
    mockFetchSequence([
      { body: { versions: [], research: null } },
      { body: { error: "Confirm your profile first" }, status: 409 },
    ]);
    render(<PitchPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate Pitch" }));
    expect(await screen.findByText("Confirm your profile first")).toBeInTheDocument();
  });

  it("saves an edit as a new version with the base id and three bullets", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [pitch], research } },
      { body: { pitch: { ...pitch, id: "p2", version: 2, origin: "user_edited" } }, status: 201 },
      { body: { versions: [{ ...pitch, id: "p2", version: 2, origin: "user_edited" }, pitch], research } },
    ]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Why this role" }), { target: { value: "My own role bullet." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/application-pitches/j1/edit");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      baseVersionId: "p1",
      bullets: ["Acme's rocket work excites me.", "My own role bullet.", "I built SQL pipelines."],
    });
  });

  it("refreshes research via the refresh endpoint", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [pitch], research } },
      { body: { research } },
      { body: { versions: [pitch], research } },
    ]);
    render(<PitchPanel jobId="j1" />);
    const line = await screen.findByText(/company researched today/i);
    fireEvent.click(within(line.parentElement!).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/application-pitches/j1/research/refresh");
  });

  it("copies the three bullets as plain text", async () => {
    mockFetchSequence([{ body: { versions: [pitch], research } }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "• Acme's rocket work excites me.\n• The role centres on SQL.\n• I built SQL pipelines."
    ));
  });

  it("disables Regenerate and Refresh while editing", async () => {
    mockFetchSequence([{ body: { versions: [pitch], research } }]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("keeps the previously selected (non-newest) version selected after a Refresh reload", async () => {
    const v2 = { ...pitch, id: "p2", version: 2, bullets: bullets.map((b) => ({ ...b, text: `${b.text} v2` })) };
    const fetchMock = mockFetchSequence([
      { body: { versions: [v2, pitch], research } },
      { body: { research } },
      { body: { versions: [v2, pitch], research } },
    ]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me. v2");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p1" } });
    await screen.findByText("Acme's rocket work excites me.");
    const line = screen.getByText(/company researched today/i);
    fireEvent.click(within(line.parentElement!).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Acme's rocket work excites me.")).toBeInTheDocument();
    expect(screen.queryByText("Acme's rocket work excites me. v2")).not.toBeInTheDocument();
  });

  it("selects the newest version and closes edit mode after Save", async () => {
    const fetchMock = mockFetchSequence([
      { body: { versions: [pitch], research } },
      { body: { pitch: { ...pitch, id: "p2", version: 2, origin: "user_edited" } }, status: 201 },
      {
        body: {
          versions: [
            { ...pitch, id: "p2", version: 2, origin: "user_edited", bullets: bullets.map((b) => ({ ...b, supported: null })) },
            pitch,
          ],
          research,
        },
      },
    ]);
    render(<PitchPanel jobId="j1" />);
    await screen.findByText("Acme's rocket work excites me.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getAllByText("your wording")).toHaveLength(3);
  });
});
