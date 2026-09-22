import { describe, it, expect } from "vitest";
import {
  GreenhouseBoardResponseSchema,
  GreenhouseJobSchema,
  LeverPostingsResponseSchema,
  LeverPostingSchema,
  UploadRowSchema,
} from "./sourceSchemas";
import { greenhouseJobFixture, leverPostingFixture } from "./fixtures";

describe("Greenhouse schemas", () => {
  it("accepts the board envelope and a real-shaped job", () => {
    expect(GreenhouseBoardResponseSchema.safeParse({ jobs: [greenhouseJobFixture], meta: { total: 1 } }).success).toBe(true);
    const job = GreenhouseJobSchema.parse(greenhouseJobFixture);
    expect(job.id).toBe(8556658002);
    expect(job.location?.name).toBe("Remote, United States");
  });

  it("rejects an envelope without a jobs array", () => {
    expect(GreenhouseBoardResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it("rejects a job without a title", () => {
    expect(GreenhouseJobSchema.safeParse({ ...greenhouseJobFixture, title: "" }).success).toBe(false);
  });
});

describe("Lever schemas", () => {
  it("accepts an array envelope and a real-shaped posting", () => {
    expect(LeverPostingsResponseSchema.safeParse([leverPostingFixture]).success).toBe(true);
    const posting = LeverPostingSchema.parse(leverPostingFixture);
    expect(posting.country).toBe("GB");
    expect(posting.categories?.allLocations).toEqual(["London", "Stockholm"]);
  });

  it("rejects the {ok:false} error body Lever returns for an unknown site", () => {
    expect(LeverPostingsResponseSchema.safeParse({ ok: false, error: "Document not found" }).success).toBe(false);
  });
});

describe("UploadRowSchema", () => {
  it("requires title and company, everything else optional", () => {
    expect(UploadRowSchema.safeParse({ title: "Data Engineer", company: "Acme" }).success).toBe(true);
    expect(UploadRowSchema.safeParse({ title: "Data Engineer" }).success).toBe(false);
    expect(UploadRowSchema.safeParse({ company: "Acme", title: "  " }).success).toBe(false);
  });

  // Field caps keep hostile cells out of btree-indexed and display columns. Description is uncapped.
  it.each([
    ["title", 500],
    ["company", 500],
    ["location", 500],
    ["url", 2000],
    ["postedAt", 100],
    ["employmentType", 100],
    ["salary", 200],
  ])("caps %s at %i characters (at the limit passes, one over fails)", (field, max) => {
    const base = { title: "Data Engineer", company: "Acme" };
    expect(UploadRowSchema.safeParse({ ...base, [field]: "x".repeat(max) }).success).toBe(true);
    expect(UploadRowSchema.safeParse({ ...base, [field]: "x".repeat(max + 1) }).success).toBe(false);
  });

  it("does not cap the description", () => {
    const row = { title: "Data Engineer", company: "Acme", description: "d".repeat(1_000_000) };
    expect(UploadRowSchema.safeParse(row).success).toBe(true);
  });

  it.each(["title", "company", "location", "description", "url", "postedAt", "employmentType", "salary"])(
    "rejects a NUL byte in %s, while a normal value still passes",
    (field) => {
      const base = { title: "Data Engineer", company: "Acme" };
      expect(UploadRowSchema.safeParse({ ...base, [field]: `bad\u0000value` }).success).toBe(false);
      expect(UploadRowSchema.safeParse({ ...base, [field]: "a normal value" }).success).toBe(true);
    }
  );

  // A lone surrogate is legal JSON text, so it survives the parser -- but storeUpload's bulk insert has no
  // savepoint, and the jsonb payload column rejects it, aborting a whole 500-row chunk with a raw
  // PostgresError whose .detail carries the offending row's content. Reject it here, at the row level.
  it.each(["title", "company", "location", "description", "url", "postedAt", "employmentType", "salary"])(
    "rejects an unpaired UTF-16 surrogate in %s, while a real emoji (a valid pair) still passes",
    (field) => {
      const base = { title: "Data Engineer", company: "Acme" };
      expect(UploadRowSchema.safeParse({ ...base, [field]: "bad\ud800value" }).success).toBe(false);
      expect(UploadRowSchema.safeParse({ ...base, [field]: "bad\udc00value" }).success).toBe(false);
      expect(UploadRowSchema.safeParse({ ...base, [field]: "a 😀 normal value" }).success).toBe(true);
    }
  );
});
