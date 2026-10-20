import { describe, it, expect } from "vitest";
import { toDocumentView, contentDisposition, CONTENT_TYPES } from "./serializeDocument";

describe("toDocumentView", () => {
  it("serializes and builds the download URL", () => {
    const view = toDocumentView({
      id: "d1", userId: "u", jobId: "j", kind: "resume", format: "pdf", resumeOptimizationId: "o", applicationPitchId: null,
      objectKey: "u/x.pdf", byteSize: 1234, contentHash: "h", rendererVersion: "1", downloadFilename: "Jane - Acme - Resume.pdf",
      createdAt: new Date("2026-09-24T00:00:00Z"),
    } as never, 3);
    expect(view).toEqual({
      id: "d1", kind: "resume", format: "pdf", sourceVersion: 3, downloadFilename: "Jane - Acme - Resume.pdf",
      byteSize: 1234, createdAt: "2026-09-24T00:00:00.000Z", downloadUrl: "/api/documents/d1/download", details: null,
    });
    expect(JSON.stringify(view)).not.toContain("u/x.pdf");
  });
});

describe("tailored_resume rows", () => {
  it("passes details through and serves .tex as x-tex", () => {
    const details = { pageCount: 1, pageVerified: true, includedCount: 2, totalCount: 3 };
    const view = toDocumentView({
      id: "d2", userId: "u", jobId: "j", kind: "tailored_resume", format: "tex", resumeOptimizationId: "o", applicationPitchId: null,
      objectKey: "u/x.tex", byteSize: 99, contentHash: "h", rendererVersion: "1", downloadFilename: "Jane - Acme - Resume.tex",
      createdAt: new Date("2026-09-24T00:00:00Z"), details,
    } as never, 2);
    expect(view).toMatchObject({ kind: "tailored_resume", format: "tex", details });
    expect(CONTENT_TYPES.tex).toBe("application/x-tex; charset=utf-8");
  });
});

describe("contentDisposition", () => {
  it("emits an ASCII filename and an encoded filename*", () => {
    expect(contentDisposition("Jane Doe - Acme - Resume.pdf")).toBe(
      `attachment; filename="Jane Doe - Acme - Resume.pdf"; filename*=UTF-8''Jane%20Doe%20-%20Acme%20-%20Resume.pdf`
    );
  });

  it("neutralizes quotes and non-ASCII in the fallback", () => {
    expect(contentDisposition('a"bé.pdf')).toMatch(/^attachment; filename="a_b_\.pdf"; filename\*=UTF-8''a%22b%C3%A9\.pdf$/);
  });
});
