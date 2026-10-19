import { describe, it, expect } from "vitest";
import { texCompilerFromEnv } from "./texCompiler";

describe("texCompilerFromEnv", () => {
  it("is null unless both URL and token are set", () => {
    expect(texCompilerFromEnv({})).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_URL: "http://127.0.0.1:8090" })).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_TOKEN: "t".repeat(32) })).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_URL: "http://127.0.0.1:8090", LATEX_COMPILER_TOKEN: "t".repeat(32) })).not.toBeNull();
  });
});
