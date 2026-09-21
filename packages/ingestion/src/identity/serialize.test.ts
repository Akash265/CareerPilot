import { describe, it, expect } from "vitest";
import { deserializeNormalized, serializeNormalized } from "./serialize";
import { makeNormalized } from "../testing/factories";

describe("serializeNormalized / deserializeNormalized", () => {
  it("round-trips, including a Date postedAt and a null one, through JSON", () => {
    for (const postedAt of [new Date("2026-05-22T13:16:29.000Z"), null]) {
      const job = makeNormalized({ postedAt, workMode: "remote" });
      const roundTripped = deserializeNormalized(JSON.parse(JSON.stringify(serializeNormalized(job))));
      expect(roundTripped).toEqual(job);
    }
  });
});
