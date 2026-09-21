// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { JobsClient } from "./JobsClient";

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", status: "open",
  postedAt: "2026-09-10T00:00:00Z", firstSeenAt: "2026-09-12T00:00:00Z",
  salary: { raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
  sponsorship: "not_offered", minExperienceYears: 5, ...over,
});
const page = (jobs: unknown[], total = jobs.length, pageNo = 1) => ({ jobs, page: pageNo, pageSize: 25, total });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// Every fetch must hit a URL the test declared; anything else is recorded and fails the test in afterEach.
let unexpected: string[] = [];
function mockJobs(routes: Record<string, () => unknown>) {
  const fn = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) {
      unexpected.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }
    const body = await route();
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => {
  vi.unstubAllGlobals();
  unexpected = [];
});
afterEach(() => {
  // Unmount first: a throwing assertion below would otherwise skip the shared cleanup and leak the DOM into the next test.
  cleanup();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

describe("JobsClient", () => {
  it("shows what was read from each posting — and says 'not stated' rather than inventing values", async () => {
    mockJobs({
      "/api/jobs?status=open&page=1": () => page([
        job(),
        job({ id: "j2", title: "Analyst", workMode: "unknown", postedAt: null, sponsorship: "unknown", minExperienceYears: null,
          salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false } }),
      ]),
    });
    render(<JobsClient />);
    expect(await screen.findByRole("link", { name: "Data Engineer" })).toHaveAttribute("href", "/jobs/j1");
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText(/5\+ years experience/)).toBeInTheDocument();
    expect(screen.getByText("Posted Sep 10, 2026")).toBeInTheDocument();

    expect(screen.getByText(/Not stated · Sponsorship not stated/)).toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
    expect(screen.getByText(/Work mode not stated/)).toBeInTheDocument();
  });

  it("searches and filters by status, resetting to page 1", async () => {
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => page([job()]),
      "/api/jobs?status=all&page=1&q=data": () => page([job()]),
    });
    render(<JobsClient />);
    await screen.findByText("Data Engineer");
    expect(fn.mock.calls[0][0]).toBe("/api/jobs?status=open&page=1");

    fireEvent.change(screen.getByLabelText("Title or company"), { target: { value: " data " } });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fn.mock.calls.at(-1)?.[0]).toBe("/api/jobs?status=all&page=1&q=data"));
  });

  it("pages through results", async () => {
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => page([job()], 26, 1),
      "/api/jobs?status=open&page=2": () => page([job({ id: "j26", title: "Job 26" })], 26, 2),
    });
    render(<JobsClient />);
    expect(await screen.findByText("Showing 1–25 of 26")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(fn.mock.calls.at(-1)?.[0]).toBe("/api/jobs?status=open&page=2");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("disables paging while another page is loading, so a double click cannot request a page past the end", async () => {
    const second = deferred<unknown>();
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => page([job()], 26, 1),
      "/api/jobs?status=open&page=2": () => second.promise,
    });
    render(<JobsClient />);
    await screen.findByText("Showing 1–25 of 26");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(fn.mock.calls.map((c) => c[0])).toEqual(["/api/jobs?status=open&page=1", "/api/jobs?status=open&page=2"]);

    second.resolve(page([job({ id: "j26", title: "Job 26" })], 26, 2));
    expect(await screen.findByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("also disables paging while a new search is loading, since the old total no longer applies", async () => {
    const searched = deferred<unknown>();
    mockJobs({
      "/api/jobs?status=open&page=1": () => page([job()], 26, 1),
      "/api/jobs?status=open&page=1&q=rare": () => searched.promise,
    });
    render(<JobsClient />);
    await screen.findByText("Showing 1–25 of 26");

    fireEvent.change(screen.getByLabelText("Title or company"), { target: { value: "rare" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    searched.resolve(page([job({ id: "j5", title: "Rare Role" })], 1, 1));
    expect(await screen.findByText("Rare Role")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText("Showing 1–1 of 1")).toBeInTheDocument();
  });

  it("points to the sources page when there are no jobs, and offers a retry on failure", async () => {
    mockJobs({ "/api/jobs?status=open&page=1": () => page([]) });
    const { unmount } = render(<JobsClient />);
    expect(await screen.findByRole("link", { name: /Add a source and run it/ })).toHaveAttribute("href", "/sources");
    unmount();

    mockJobs({
      "/api/jobs?status=open&page=1": () => {
        throw new Error("offline");
      },
    });
    render(<JobsClient />);
    expect(await screen.findByText(/Could not load jobs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retries a failed load when Retry is clicked", async () => {
    let calls = 0;
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return page([job()]);
      },
    });
    render(<JobsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("link", { name: "Data Engineer" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("marks closed jobs, and asks for closed jobs when that filter is chosen", async () => {
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => page([job()]),
      "/api/jobs?status=closed&page=1": () => page([job({ id: "j3", title: "Old Role", status: "closed" })]),
    });
    render(<JobsClient />);
    await screen.findByText("Data Engineer");
    expect(screen.queryByText("Closed")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("link", { name: "Old Role" })).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(fn.mock.calls.at(-1)?.[0]).toBe("/api/jobs?status=closed&page=1");
  });

  it("ignores a response that arrives after a newer request was made", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const fn = mockJobs({
      "/api/jobs?status=open&page=1": () => older.promise,
      "/api/jobs?status=open&page=1&q=newer": () => newer.promise,
    });
    render(<JobsClient />);
    fireEvent.change(screen.getByLabelText("Title or company"), { target: { value: "newer" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));

    newer.resolve(page([job({ id: "j2", title: "Newer result" })]));
    expect(await screen.findByText("Newer result")).toBeInTheDocument();

    older.resolve(page([job({ id: "j1", title: "Older result" })]));
    await flush();
    expect(screen.getByText("Newer result")).toBeInTheDocument();
    expect(screen.queryByText("Older result")).not.toBeInTheDocument();
  });

  it("does not update or warn when unmounted before the response arrives", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<unknown>();
    mockJobs({ "/api/jobs?status=open&page=1": () => pending.promise });
    const { unmount } = render(<JobsClient />);
    unmount();

    pending.resolve(page([job()]));
    await flush();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
