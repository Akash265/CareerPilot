// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourcesClient } from "./SourcesClient";

const source = (over: Record<string, unknown> = {}) => ({
  id: "s1", kind: "greenhouse", label: "GitLab", slug: "gitlab", companyName: "GitLab", enabled: false,
  consentConfirmedAt: null, lastRunAt: null, lastRunStatus: null, lastErrorClass: null, lastRun: null,
  createdAt: "2026-09-01T00:00:00Z", ...over,
});

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
function mockFetch(handlers: Record<string, Handler>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unhandled request: ${init?.method ?? "GET"} ${url}`);
    const { status = 200, body } = handler(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const list = (sources: unknown[]) => ({ "GET /api/job-sources": () => ({ body: { sources } }) });
const calls = (fn: ReturnType<typeof mockFetch>, key: string) =>
  fn.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}` === key);

beforeEach(() => vi.unstubAllGlobals());

describe("SourcesClient", () => {
  it("shows a helpful empty state", async () => {
    mockFetch(list([]));
    render(<SourcesClient />);
    expect(await screen.findByText(/No sources yet/)).toBeInTheDocument();
  });

  it("lists sources with their status and last run, and explains failures in words", async () => {
    mockFetch(list([
      source({ id: "a", label: "GitLab", enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z", lastRunStatus: "succeeded", lastRunAt: "2026-09-20T00:00:00Z",
        lastRun: { complete: true, fetched: 209, created: 12, updated: 3, unchanged: 190, closed: 4, failed: 0 } }),
      source({ id: "b", label: "Nope", slug: "nope", enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z", lastRunStatus: "failed", lastRunAt: "2026-09-20T00:00:00Z", lastErrorClass: "not_found" }),
      source({ id: "c", label: "Never", slug: "never" }),
    ]));
    render(<SourcesClient />);
    expect(await screen.findByText(/209 fetched · 12 new · 3 updated · 4 closed/)).toBeInTheDocument();
    expect(screen.getByText(/Board not found — check the board token/)).toBeInTheDocument();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
  });

  it("cannot enable a source until its Terms of Service confirmation is ticked, then sends it", async () => {
    let listed = [source()];
    const fn = mockFetch({
      "GET /api/job-sources": () => ({ body: { sources: listed } }),
      "PATCH /api/job-sources/s1": () => {
        listed = [source({ enabled: true, consentConfirmedAt: "2026-09-21T00:00:00Z" })];
        return { body: { source: listed[0] } };
      },
    });
    render(<SourcesClient />);
    const enable = await screen.findByRole("button", { name: "Enable" });
    expect(enable).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/reviewed this source's Terms of Service/));
    expect(enable).toBeEnabled();
    fireEvent.click(enable);

    await waitFor(() => expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument());
    const [, init] = calls(fn, "PATCH /api/job-sources/s1")[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ enabled: true, consentConfirmed: true });
    expect(screen.queryByLabelText(/reviewed this source's Terms of Service/)).not.toBeInTheDocument();
  });

  it("does not ask again for a source that already has the confirmation, and can disable it", async () => {
    const fn = mockFetch({
      ...list([source({ enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z" })]),
      "PATCH /api/job-sources/s1": () => ({ body: {} }),
    });
    render(<SourcesClient />);
    expect(screen.queryByLabelText(/Terms of Service/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls(fn, "PATCH /api/job-sources/s1")).toHaveLength(1));
    expect(JSON.parse((calls(fn, "PATCH /api/job-sources/s1")[0][1] as RequestInit).body as string)).toEqual({ enabled: false, consentConfirmed: false });
  });

  it("queues a run and says so; shows the server's reason when a run is refused", async () => {
    const ok = { enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z" };
    let status = 202;
    mockFetch({
      ...list([source(ok)]),
      "POST /api/job-sources/s1/run": () => (status === 202 ? { status, body: { status: "queued" } } : { status, body: { error: "A run for this source is already queued or running" } }),
    });
    render(<SourcesClient />);
    const run = await screen.findByRole("button", { name: "Run now" });
    fireEvent.click(run);
    expect(await screen.findByRole("status")).toHaveTextContent(/Queued a run for GitLab/);

    status = 409;
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already queued or running/);
  });

  it("disables 'Run now' for a source that is not enabled", async () => {
    mockFetch(list([source()]));
    render(<SourcesClient />);
    expect(await screen.findByRole("button", { name: "Run now" })).toBeDisabled();
  });

  it("adds a board, shows the server's error for a duplicate, and clears the form on success", async () => {
    let status = 409;
    const fn = mockFetch({
      ...list([]),
      "POST /api/job-sources": () => (status === 201 ? { status, body: { source: source() } } : { status, body: { error: "That board is already on your list" } }),
    });
    render(<SourcesClient />);
    fireEvent.change(await screen.findByLabelText("Board token"), { target: { value: "gitlab" } });
    fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: "GitLab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add board" }));
    expect(await screen.findByText(/already on your list/)).toBeInTheDocument();
    expect(JSON.parse((calls(fn, "POST /api/job-sources")[0][1] as RequestInit).body as string)).toEqual({ kind: "greenhouse", slug: "gitlab", companyName: "GitLab" });

    status = 201;
    fireEvent.click(screen.getByRole("button", { name: "Add board" }));
    await waitFor(() => expect(screen.getByLabelText("Board token")).toHaveValue(""));
  });

  it("uploads a file only with a file and the confirmation, and reports how many jobs were stored", async () => {
    const fn = mockFetch({
      ...list([]),
      "POST /api/job-sources/upload": () => ({ status: 201, body: { sourceId: "u1", count: 2, queued: true } }),
    });
    render(<SourcesClient />);
    const button = await screen.findByRole("button", { name: "Upload" });

    fireEvent.click(button);
    expect(screen.getByText("Select a file first.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Job file/), { target: { files: [new File(["title,company\nA,B"], "jobs.csv")] } });
    fireEvent.click(button);
    expect(screen.getByText(/Confirm that you are permitted/)).toBeInTheDocument();
    expect(calls(fn, "POST /api/job-sources/upload")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText(/permitted to use the data/));
    fireEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("Uploaded 2 jobs — they are being processed.");
    const form = (calls(fn, "POST /api/job-sources/upload")[0][1] as RequestInit).body as FormData;
    expect(form.get("consentConfirmed")).toBe("true");
    expect((form.get("file") as File).name).toBe("jobs.csv");
  });

  it("offers a retry when the list cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<SourcesClient />);
    expect(await screen.findByText(/Could not load your sources/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
