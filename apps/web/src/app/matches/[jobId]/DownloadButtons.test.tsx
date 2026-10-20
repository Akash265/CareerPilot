// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DownloadButtons, DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

beforeEach(() => vi.unstubAllGlobals());

function mockPost(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** POST /api/documents succeeds, then a HEAD preflight against the returned downloadUrl. */
function mockPostThenHead(postStatus: number, postBody: unknown, headOk: boolean) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") return Promise.resolve({ ok: headOk, status: headOk ? 200 : 404 } as Response);
    return Promise.resolve({ ok: postStatus < 400, status: postStatus, json: async () => postBody } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("DownloadButtons", () => {
  it("POSTs the export, announces the change, preflights with HEAD, then navigates to the download URL", async () => {
    const fetchMock = mockPostThenHead(201, { document: { downloadUrl: "/api/documents/d1/download" } }, true);
    const navigate = vi.fn();
    const changed = vi.fn();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, changed);
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/api/documents/d1/download"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents");
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ kind: "resume", jobId: "j1", sourceId: "o1", format: "pdf" });
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/d1/download", { method: "HEAD" });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, changed);
  });

  it("sends format docx for the DOCX button", async () => {
    const fetchMock = mockPostThenHead(201, { document: { downloadUrl: "/x" } }, true);
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Download DOCX" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ kind: "pitch", format: "docx" });
  });

  it("shows the server's message on an error and does not navigate", async () => {
    mockPost(409, { error: "Your profile changed since this optimization. Regenerate it first." });
    const navigate = vi.fn();
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your profile changed since this optimization");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows an inline error and does not navigate when the HEAD preflight on the download URL fails", async () => {
    const fetchMock = mockPostThenHead(201, { document: { downloadUrl: "/api/documents/d1/download" } }, false);
    const navigate = vi.fn();
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not download/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/d1/download", { method: "HEAD" });
  });

  it("shows the preflight error (not the generic export error) and does not navigate when the HEAD fetch itself throws", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return Promise.reject(new Error("network error"));
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ document: { downloadUrl: "/api/documents/d1/download" } }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not download/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses a custom label prefix for the accessible names", () => {
    render(<DownloadButtons jobId="j1" kind="tailored_resume" sourceId="o1" formats={["pdf", "tex"]} labelPrefix="Download tailored" navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download tailored PDF" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download tailored .tex" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
  });

  it("disables both buttons when disabled", () => {
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" disabled navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download DOCX" })).toBeDisabled();
  });

  it("renders only the requested formats, labels tex as .tex, and reports the export body", async () => {
    const body = { document: { downloadUrl: "/api/documents/t1/download", details: { pageCount: 1, pageVerified: true, includedCount: 3, totalCount: 4, omitted: [] } }, omittedItems: [] };
    const fetchMock = mockPostThenHead(201, body, true);
    const onExported = vi.fn();
    render(<DownloadButtons jobId="j1" kind="tailored_resume" sourceId="o1" formats={["pdf", "tex"]} onExported={onExported} navigate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Download DOCX" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download .tex" }));
    await waitFor(() => expect(onExported).toHaveBeenCalledWith(body));
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ kind: "tailored_resume", jobId: "j1", sourceId: "o1", format: "tex" });
  });
});
