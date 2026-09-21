import { describe, it, expect } from "vitest";
import { ListJobsQuerySchema, escapeLike } from "./listJobs";

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character itself", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("ListJobsQuerySchema", () => {
  it("defaults to open jobs, page 1, and coerces the page number", () => {
    expect(ListJobsQuerySchema.parse({})).toEqual({ status: "open", page: 1 });
    expect(ListJobsQuerySchema.parse({ page: "3", status: "all", q: " data " })).toEqual({ status: "all", page: 3, q: "data" });
  });

  it("rejects an unknown status, a non-positive page and a non-uuid source id", () => {
    expect(ListJobsQuerySchema.safeParse({ status: "weird" }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ sourceId: "nope" }).success).toBe(false);
  });
});
