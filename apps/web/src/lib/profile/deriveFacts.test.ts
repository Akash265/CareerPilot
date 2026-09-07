import { describe, it, expect } from "vitest";
import { deriveFact } from "./deriveFacts";

describe("deriveFact", () => {
  it("produces a stable content hash for the same text", () => {
    const a = deriveFact("skill", "id-1", "SQL");
    const b = deriveFact("skill", "id-2", "SQL");
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("produces a different content hash for different text", () => {
    const a = deriveFact("skill", "id-1", "SQL");
    const b = deriveFact("skill", "id-1", "Python");
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("carries the sourceType, sourceId, and factText through unchanged", () => {
    const fact = deriveFact("achievement", "id-9", "Shipped v1");
    expect(fact).toMatchObject({ sourceType: "achievement", sourceId: "id-9", factText: "Shipped v1" });
  });
});
