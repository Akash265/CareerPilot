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

  it("turns an unparseable postedAt string into null instead of an Invalid Date", () => {
    const out = deserializeNormalized({ ...serializeNormalized(makeNormalized()), postedAt: "garbage" });
    expect(out.postedAt).toBeNull();
  });

  it("turns a postedAt of the wrong type into null", () => {
    for (const bad of [12345, {}, true, undefined]) {
      const out = deserializeNormalized({ ...serializeNormalized(makeNormalized()), postedAt: bad });
      expect(out.postedAt).toBeNull();
    }
  });

  it("throws a fixed-message error, with no input content, when the value is not an object", () => {
    for (const bad of [null, undefined, "SECRET-RESUME-TEXT", 42, ["SECRET-RESUME-TEXT"]]) {
      let message = "";
      try {
        deserializeNormalized(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe("invalid normalized snapshot");
    }
  });

  it("throws the same fixed-message error when a stored snapshot is missing a required field", () => {
    const snapshot = serializeNormalized(makeNormalized()) as Record<string, unknown>;
    delete snapshot.companyKey;
    expect(() => deserializeNormalized(snapshot)).toThrow("invalid normalized snapshot");
  });

  it("throws the same fixed-message error when a stored snapshot has an old/foreign enum value", () => {
    const snapshot = { ...serializeNormalized(makeNormalized()), workMode: "banana" };
    expect(() => deserializeNormalized(snapshot)).toThrow("invalid normalized snapshot");
  });
});
