import { describe, it, expect, vi, afterEach } from "vitest";
import { embedTexts, EmbeddingProviderNotImplementedError } from "./embeddings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedTexts", () => {
  it("returns an empty array without calling the API for empty input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await embedTexts(
      { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "key", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
      []
    );
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the Voyage API and returns embeddings for the given texts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) })
    );
    const result = await embedTexts(
      { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "key", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
      ["some fact"]
    );
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it("throws for a non-voyage provider (not yet implemented)", async () => {
    await expect(
      embedTexts(
        { EMBEDDING_PROVIDER: "self-hosted", VOYAGE_API_KEY: undefined, VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
        ["text"]
      )
    ).rejects.toThrow(EmbeddingProviderNotImplementedError);
  });

  it("throws when the Voyage API responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" })
    );
    await expect(
      embedTexts(
        { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "bad", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
        ["text"]
      )
    ).rejects.toThrow(/Voyage embeddings request failed/);
  });
});
