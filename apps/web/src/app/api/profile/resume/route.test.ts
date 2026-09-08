import { describe, it, expect, vi, beforeEach } from "vitest";

// Each Drizzle-style chain link returns an object exposing only the next
// link the route actually calls, so `.update().set().where()` and
// `.insert().values().returning()` both resolve correctly through the mock.
//
// These are declared via vi.hoisted() (rather than plain top-level consts)
// because vi.mock() factories only have the vi.mock() call itself hoisted
// above them, not ordinary variable declarations — without this wrapper the
// factories below would reference the mocks before they're initialized.
const {
  dbUpdateMock,
  dbInsertMock,
  dbValuesMock,
  extractProfileFromResumeMock,
  dbSelectWhereMock,
  dbSelectFromMock,
  dbSelectMock,
  dbDeleteWhereMock,
  dbDeleteMock,
  deleteResumeMock,
} = vi.hoisted(() => {
  const dbWhereMock = vi.fn().mockResolvedValue(undefined);
  const dbSetMock = vi.fn(() => ({ where: dbWhereMock }));
  const dbUpdateMock = vi.fn(() => ({ set: dbSetMock }));
  const dbInsertReturningMock = vi.fn().mockResolvedValue([{ id: "resume-doc-1" }]);
  const dbValuesMock = vi.fn(() => ({ returning: dbInsertReturningMock }));
  const dbInsertMock = vi.fn(() => ({ values: dbValuesMock }));
  const extractProfileFromResumeMock = vi.fn();

  // Chain shapes for the DELETE handler: `.select().from(...).where(...)`
  // and `.delete(...).where(...)`, each mirroring the same "one link
  // returns the next" convention as the update/insert chains above.
  const dbSelectWhereMock = vi.fn().mockResolvedValue([]);
  const dbSelectFromMock = vi.fn(() => ({ where: dbSelectWhereMock }));
  const dbSelectMock = vi.fn(() => ({ from: dbSelectFromMock }));
  const dbDeleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const dbDeleteMock = vi.fn(() => ({ where: dbDeleteWhereMock }));

  const deleteResumeMock = vi.fn().mockResolvedValue(undefined);

  return {
    dbUpdateMock,
    dbInsertMock,
    dbValuesMock,
    extractProfileFromResumeMock,
    dbSelectWhereMock,
    dbSelectFromMock,
    dbSelectMock,
    dbDeleteWhereMock,
    dbDeleteMock,
    deleteResumeMock,
  };
});

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({}),
  closeDbClient: vi.fn().mockResolvedValue(undefined),
  withUserContext: async (_db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn({ update: dbUpdateMock, insert: dbInsertMock, select: dbSelectMock, delete: dbDeleteMock }),
  schema: { resumeDocuments: { isActive: "isActive", id: "id" } },
}));

vi.mock("@ai-career/storage", () => ({
  createStorageClient: () => ({}),
  uploadResume: vi.fn().mockResolvedValue({ objectKey: "user-1/file.pdf" }),
  deleteResume: deleteResumeMock,
}));

vi.mock("@ai-career/ai", () => ({
  detectResumeFileType: vi.fn().mockResolvedValue("pdf"),
  extractText: vi.fn().mockResolvedValue("plain resume text"),
  extractProfileFromResume: extractProfileFromResumeMock,
  createAnthropicClient: () => ({}),
  UnsupportedFileTypeError: class UnsupportedFileTypeError extends Error {},
  ExtractionValidationError: class ExtractionValidationError extends Error {},
}));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({ DEFAULT_USER_ID: "user-1" }),
}));

import { POST, DELETE } from "./route";

function makeRequest(): Request {
  const formData = new FormData();
  formData.append("file", new File([Buffer.from("%PDF-1.4")], "resume.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/profile/resume", { method: "POST", body: formData });
}

beforeEach(async () => {
  extractProfileFromResumeMock.mockReset();
  dbSelectWhereMock.mockReset().mockResolvedValue([]);
  dbDeleteWhereMock.mockReset().mockResolvedValue(undefined);
  dbSelectFromMock.mockClear();
  dbSelectMock.mockClear();
  dbDeleteMock.mockClear();
  dbValuesMock.mockClear();
  dbUpdateMock.mockClear();
  dbInsertMock.mockClear();
  deleteResumeMock.mockReset().mockResolvedValue(undefined);
  const { detectResumeFileType } = await import("@ai-career/ai");
  vi.mocked(detectResumeFileType).mockReset().mockResolvedValue("pdf");
});

describe("POST /api/profile/resume", () => {
  it("returns the extracted draft on success", async () => {
    extractProfileFromResumeMock.mockResolvedValue({ contact: { fullName: "Ada" } });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("extracted");
    expect(body.draft.contact.fullName).toBe("Ada");
  });

  it("returns a failed status without a server error when extraction fails twice", async () => {
    const { ExtractionValidationError } = await import("@ai-career/ai");
    extractProfileFromResumeMock.mockRejectedValue(new ExtractionValidationError("bad output"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(extractProfileFromResumeMock).toHaveBeenCalledTimes(2);
  });

  it("rejects with 400 when no file is provided", async () => {
    const req = new Request("http://localhost/api/profile/resume", {
      method: "POST",
      body: new FormData(),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/no file/i);
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the declared Content-Length exceeds the 10MB cap, before buffering the body", async () => {
    const formData = new FormData();
    formData.append("file", new File([Buffer.from("%PDF-1.4")], "resume.pdf", { type: "application/pdf" }));
    const req = new Request("http://localhost/api/profile/resume", {
      method: "POST",
      body: formData,
      headers: { "content-length": String(11 * 1024 * 1024) },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/10mb/i);
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("rejects with 400 when content-sniffing the file type fails", async () => {
    const { detectResumeFileType, UnsupportedFileTypeError } = await import("@ai-career/ai");
    vi.mocked(detectResumeFileType).mockRejectedValueOnce(new UnsupportedFileTypeError("looks like a PNG"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/looks like a png/i);
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("stores the content-sniffed MIME type, never the client-supplied one", async () => {
    extractProfileFromResumeMock.mockResolvedValue({ contact: { fullName: "Ada" } });
    const formData = new FormData();
    // The client claims a bogus type; detectResumeFileType is mocked to
    // resolve "pdf" regardless, so the stored mimeType must reflect that
    // sniffed result, not this client-supplied value.
    formData.append(
      "file",
      new File([Buffer.from("%PDF-1.4")], "resume.pdf", { type: "application/x-bogus" })
    );
    const req = new Request("http://localhost/api/profile/resume", { method: "POST", body: formData });

    await POST(req);

    expect(dbValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/pdf" })
    );
  });
});

describe("DELETE /api/profile/resume", () => {
  it("deletes the storage object before deleting the DB row, and returns status: deleted", async () => {
    dbSelectWhereMock.mockResolvedValue([{ id: "resume-doc-1", objectKey: "user-1/file.pdf" }]);

    const res = await DELETE();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "deleted" });

    expect(deleteResumeMock).toHaveBeenCalledWith(expect.anything(), "user-1/file.pdf");
    expect(dbDeleteWhereMock).toHaveBeenCalledTimes(1);

    // The storage object must be gone before the DB row is removed, so a
    // crash between the two calls never leaves a DB row pointing at a
    // deleted object.
    const deleteResumeOrder = deleteResumeMock.mock.invocationCallOrder[0];
    const dbDeleteOrder = dbDeleteWhereMock.mock.invocationCallOrder[0];
    expect(deleteResumeOrder).toBeLessThan(dbDeleteOrder);
  });

  it("returns 404 without touching storage when there is no active resume", async () => {
    dbSelectWhereMock.mockResolvedValue([]);

    const res = await DELETE();
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBeTruthy();

    expect(deleteResumeMock).not.toHaveBeenCalled();
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });
});
