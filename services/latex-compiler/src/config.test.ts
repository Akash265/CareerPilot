import { describe, it, expect } from "vitest";
import { loadCompilerConfig } from "./config";

describe("loadCompilerConfig", () => {
  const token = "x".repeat(32);
  it("reads token, default port and test mode", () => {
    expect(loadCompilerConfig({ LATEX_COMPILER_TOKEN: token })).toEqual({ token, port: 8090, testMode: false });
    expect(loadCompilerConfig({ LATEX_COMPILER_TOKEN: token, PORT: "9000", LATEX_COMPILER_TEST_MODE: "1" })).toEqual({ token, port: 9000, testMode: true });
  });
  it("refuses a missing/short token or bad port", () => {
    expect(() => loadCompilerConfig({})).toThrow(/LATEX_COMPILER_TOKEN/);
    expect(() => loadCompilerConfig({ LATEX_COMPILER_TOKEN: "short" })).toThrow(/LATEX_COMPILER_TOKEN/);
    expect(() => loadCompilerConfig({ LATEX_COMPILER_TOKEN: token, PORT: "abc" })).toThrow(/PORT/);
  });
});
