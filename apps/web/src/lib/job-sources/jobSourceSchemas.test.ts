import { describe, it, expect } from "vitest";
import { CreateJobSourceSchema, UpdateJobSourceSchema } from "./jobSourceSchemas";

describe("CreateJobSourceSchema", () => {
  it("accepts a board token and an optional company name, trimming both", () => {
    expect(CreateJobSourceSchema.parse({ kind: "greenhouse", slug: " gitlab ", companyName: " GitLab " })).toEqual({
      kind: "greenhouse", slug: "gitlab", companyName: "GitLab",
    });
    expect(CreateJobSourceSchema.safeParse({ kind: "lever", slug: "Acme_Corp-2" }).success).toBe(true);
  });

  it("rejects upload as a kind, and any slug that could alter a URL", () => {
    expect(CreateJobSourceSchema.safeParse({ kind: "upload", slug: "x" }).success).toBe(false);
    for (const slug of ["", "../etc", "a/b", "a.b", "a:b", "a b", "x".repeat(65)]) {
      expect(CreateJobSourceSchema.safeParse({ kind: "lever", slug }).success, slug).toBe(false);
    }
  });
});

describe("UpdateJobSourceSchema", () => {
  it("requires a boolean enabled, with an optional consentConfirmed", () => {
    expect(UpdateJobSourceSchema.safeParse({ enabled: true, consentConfirmed: true }).success).toBe(true);
    expect(UpdateJobSourceSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateJobSourceSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(UpdateJobSourceSchema.safeParse({}).success).toBe(false);
  });
});
