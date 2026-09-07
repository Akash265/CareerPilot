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
  dbWhereMock,
  dbSetMock,
  dbUpdateMock,
  dbInsertReturningMock,
  dbValuesMock,
  dbInsertMock,
  extractProfileFromResumeMock,
} = vi.hoisted(() => {
  const dbWhereMock = vi.fn().mockResolvedValue(undefined);
  const dbSetMock = vi.fn(() => ({ where: dbWhereMock }));
  const dbUpdateMock = vi.fn(() => ({ set: dbSetMock }));
  const dbInsertReturningMock = vi.fn().mockResolvedValue([{ id: "resume-doc-1" }]);
  const dbValuesMock = vi.fn(() => ({ returning: dbInsertReturningMock }));
  const dbInsertMock = vi.fn(() => ({ values: dbValuesMock }));
  const extractProfileFromResumeMock = vi.fn();
  return {
    dbWhereMock,
    dbSetMock,
    dbUpdateMock,
    dbInsertReturningMock,
    dbValuesMock,
    dbInsertMock,
    extractProfileFromResumeMock,
  };
});

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({}),
  withUserContext: async (_db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn({ update: dbUpdateMock, insert: dbInsertMock }),
  schema: { resumeDocuments: { isActive: "isActive", id: "id" } },
}));

vi.mock("@ai-career/storage", () => ({
  createStorageClient: () => ({}),
  uploadResume: vi.fn().mockResolvedValue({ objectKey: "user-1/file.pdf" }),
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

import { POST } from "./route";

function makeRequest(): Request {
  const formData = new FormData();
  formData.append("file", new File([Buffer.from("%PDF-1.4")], "resume.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/profile/resume", { method: "POST", body: formData });
}

beforeEach(() => {
  extractProfileFromResumeMock.mockReset();
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
});
