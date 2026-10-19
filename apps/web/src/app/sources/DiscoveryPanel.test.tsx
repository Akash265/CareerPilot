// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { DiscoveryPanel } from "./DiscoveryPanel";

const providers = [
  { kind: "remotive", label: "Remotive", keyRequired: false, keyConfigured: true, missingKeys: [], enabled: false, sourceId: null },
  { kind: "adzuna", label: "Adzuna", keyRequired: true, keyConfigured: false, missingKeys: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"], enabled: false, sourceId: null },
];
const viewOf = (over: Record<string, unknown> = {}) => ({
  settings: { consentedAt: null, autoDiscover: false },
  providers,
  boards: { counts: { pending: 0, enabled: 0, rejected: 0, gone: 0 }, recent: [] },
  ...over,
});

function mockFetch(view: unknown, responses: Record<string, unknown> = {}) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    if (key in responses) {
      const r = responses[key] as { status?: number; body?: unknown };
      return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status ?? 200 });
    }
    return new Response(JSON.stringify(view), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const sent = (fn: ReturnType<typeof mockFetch>, method: string, url: string) =>
  fn.mock.calls.filter(([u, init]) => u === url && init?.method === method).map(([, init]) => JSON.parse(String(init?.body)));

describe("DiscoveryPanel (Phase 12)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("asks for the standing permission first; providers and pasting are off until it is given", async () => {
    const fn = mockFetch(viewOf());
    render(<DiscoveryPanel />);
    const consent = await screen.findByRole("checkbox", { name: /permission to collect job postings/i });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Remotive/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /add boards/i })).toBeDisabled();
    fireEvent.click(consent);
    await waitFor(() => expect(sent(fn, "PUT", "/api/discovery/settings")).toEqual([{ consent: true, autoDiscover: false }]));
  });

  it("toggles a provider, and shows which .env keys a keyed provider still needs", async () => {
    const fn = mockFetch(viewOf({ settings: { consentedAt: "2026-10-12T09:00:00.000Z", autoDiscover: true } }));
    render(<DiscoveryPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Remotive/ }));
    await waitFor(() => expect(sent(fn, "PUT", "/api/discovery/providers/remotive")).toEqual([{ enabled: true }]));
    expect(screen.getByRole("checkbox", { name: /Adzuna/ })).toBeDisabled();
    expect(screen.getByText(/ADZUNA_APP_ID and ADZUNA_APP_KEY/)).toBeInTheDocument();
  });

  it("pastes board links and reports how many were new", async () => {
    const fn = mockFetch(viewOf({ settings: { consentedAt: "2026-10-12T09:00:00.000Z", autoDiscover: true } }), {
      "POST /api/discovery/boards": { body: { recognized: 3, added: 2 } },
    });
    render(<DiscoveryPanel />);
    fireEvent.change(await screen.findByLabelText(/paste board links/i), { target: { value: "https://jobs.ashbyhq.com/linear" } });
    fireEvent.click(screen.getByRole("button", { name: /add boards/i }));
    expect(await screen.findByText(/3 boards recognized, 2 new/i)).toBeInTheDocument();
    expect(sent(fn, "POST", "/api/discovery/boards")).toEqual([{ text: "https://jobs.ashbyhq.com/linear" }]);
  });

  it("shows the board counts and recent boards with where each was found", async () => {
    mockFetch(viewOf({
      settings: { consentedAt: "2026-10-12T09:00:00.000Z", autoDiscover: true },
      boards: {
        counts: { pending: 1, enabled: 2, rejected: 1, gone: 0 },
        recent: [
          { kind: "ashby", slug: "linear", status: "enabled", label: "Linear", foundVia: "HN Who is hiring", origin: "posting_link", rejectReason: null, firstSeenAt: "2026-10-12T09:00:00.000Z" },
          { kind: "lever", slug: "globex", status: "rejected", label: null, foundVia: null, origin: "name_probe", rejectReason: "company_mismatch", firstSeenAt: "2026-10-12T09:00:00.000Z" },
          { kind: "ashby", slug: "initech", status: "pending", label: null, foundVia: null, origin: "web_search", rejectReason: null, firstSeenAt: "2026-10-12T09:00:00.000Z" },
          { kind: "lever", slug: "umbrella", status: "rejected", label: null, foundVia: null, origin: "pasted", rejectReason: "no_jobs", firstSeenAt: "2026-10-12T09:00:00.000Z" },
        ],
      },
    }));
    render(<DiscoveryPanel />);
    expect(await screen.findByText(/2 enabled · 1 waiting · 1 rejected · 0 gone/)).toBeInTheDocument();
    const items = within(screen.getByRole("list", { name: /recently discovered boards/i })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/Linear.*found in a job posting via HN Who is hiring/);
    expect(items[1]).toHaveTextContent(/globex.*rejected: different company.*found by name guess/);
    expect(items[2]).toHaveTextContent(/initech.*waiting to be checked.*found by web search/);
    expect(items[3]).toHaveTextContent(/umbrella.*rejected: no open jobs.*added by you/);
  });

  it("shows a server's refusal", async () => {
    mockFetch(viewOf({ settings: { consentedAt: "2026-10-12T09:00:00.000Z", autoDiscover: true } }), {
      "PUT /api/discovery/providers/remotive": { status: 409, body: { error: "Give permission for discovery on this page first" } },
    });
    render(<DiscoveryPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Remotive/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/give permission/i);
  });
});
