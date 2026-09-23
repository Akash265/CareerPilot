import { describe, it, expect } from "vitest";
import { cosineSimilarity, scoreSemanticSimilarity } from "./scoreSemanticSimilarity";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 rather than NaN when a vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("scoreSemanticSimilarity", () => {
  it("returns null when the job has no embedding yet", () => {
    expect(scoreSemanticSimilarity(null, [1, 0])).toBeNull();
  });

  it("returns null when the resume embedding could not be computed", () => {
    expect(scoreSemanticSimilarity([1, 0], null)).toBeNull();
  });

  it("clamps a negative cosine to 0 (no meaningful 'coverage' interpretation below zero)", () => {
    expect(scoreSemanticSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it("returns the cosine similarity for two comparable embeddings", () => {
    expect(scoreSemanticSimilarity([1, 0], [1, 0])).toBe(1);
  });
});
