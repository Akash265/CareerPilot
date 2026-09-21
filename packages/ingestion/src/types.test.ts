import { describe, it, expect } from "vitest";
import { IngestError } from "./types";

describe("IngestError", () => {
  it("marks transient classes retryable and permanent ones not", () => {
    for (const c of ["rate_limited", "server_error", "network", "timeout", "unknown"] as const) {
      expect(new IngestError(c).retryable).toBe(true);
    }
    for (const c of ["consent_missing", "source_disabled", "invalid_slug", "not_found", "http_error", "response_too_large", "schema_mismatch"] as const) {
      expect(new IngestError(c).retryable).toBe(false);
    }
  });

  it("exposes only the class in its message, never free-form detail", () => {
    expect(new IngestError("not_found").message).toBe("not_found");
    expect(new IngestError("not_found").errorClass).toBe("not_found");
  });
});
