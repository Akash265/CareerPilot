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
});
