// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { DocumentsList } from "./DocumentsList";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

const doc = { id: "d1", kind: "resume", format: "pdf", sourceVersion: 3, downloadFilename: "Jane - Acme - Resume.pdf",
  byteSize: 1000, createdAt: "2026-09-24T00:00:00Z", downloadUrl: "/api/documents/d1/download" };

beforeEach(() => vi.unstubAllGlobals());

/** GET /api/documents (list load) resolves with `documents`; HEAD preflights on a download resolve `headOk`. */
function mockListAndHead(documents: unknown[], headOk: boolean) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") return Promise.resolve({ ok: headOk, status: headOk ? 200 : 404 } as Response);
    return Promise.resolve({ ok: true, json: async () => ({ documents }) } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("DocumentsList", () => {
  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [] }) } as Response));
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/no documents exported yet/i)).toBeInTheDocument();
  });

  it("lists documents with kind, version, format and a Download button", async () => {
    mockListAndHead([doc], true);
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("preflights with HEAD then navigates on a successful download", async () => {
    const fetchMock = mockListAndHead([doc], true);
    const navigate = vi.fn();
    render(<DocumentsList jobId="j1" navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /download/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/api/documents/d1/download"));
    expect(fetchMock).toHaveBeenCalledWith("/api/documents/d1/download", { method: "HEAD" });
  });

  it("shows an inline error and does not navigate when the HEAD preflight fails", async () => {
    mockListAndHead([doc], false);
    const navigate = vi.fn();
    render(<DocumentsList jobId="j1" navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: /download/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not download/i);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("labels cover letter and interview prep documents", async () => {
    mockListAndHead([{ ...doc, id: "d2", kind: "cover_letter", sourceVersion: 2 }, { ...doc, id: "d3", kind: "interview_prep", sourceVersion: 1 }], true);
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/Cover letter v2 · PDF/)).toBeInTheDocument();
    expect(screen.getByText(/Interview prep v1 · PDF/)).toBeInTheDocument();
  });

  it("labels a tailored LaTeX resume and shows its page summary", async () => {
    mockListAndHead([{ ...doc, id: "d4", kind: "tailored_resume", format: "tex", details: { pageCount: null, pageVerified: false, includedCount: 5, totalCount: 6 } }], true);
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/Tailored resume \(LaTeX\)/)).toBeInTheDocument();
    expect(screen.getByText(/page count not verified/)).toBeInTheDocument();
  });

  it("reloads when a documents-changed event fires", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [doc] }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsList jobId="j1" />);
    await screen.findByText(/no documents exported yet/i);
    act(() => { window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT)); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
  });
});
