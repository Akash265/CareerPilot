import { describe, it, expect } from "vitest";
import { detectWorkMode } from "./workMode";

describe("detectWorkMode", () => {
  it("prefers the structured value", () => {
    expect(detectWorkMode({ structured: "hybrid", location: "Remote" })).toBe("hybrid");
    expect(detectWorkMode({ structured: "remote" })).toBe("remote");
    expect(detectWorkMode({ structured: "onsite" })).toBe("onsite");
    expect(detectWorkMode({ structured: "on-site" })).toBe("onsite");
  });

  it("falls through when the structured value is unspecified", () => {
    expect(detectWorkMode({ structured: "unspecified", location: "Remote, Bangalore" })).toBe("remote");
    expect(detectWorkMode({ structured: "unspecified" })).toBe("unknown");
  });

  it("reads location keywords (real Greenhouse strings)", () => {
    expect(detectWorkMode({ location: "Remote, United States" })).toBe("remote");
    expect(detectWorkMode({ location: "Remote, Canada; Remote, United Kingdom" })).toBe("remote");
    expect(detectWorkMode({ location: "London (Hybrid)" })).toBe("hybrid");
    expect(detectWorkMode({ location: "Berlin - On-site" })).toBe("onsite");
  });

  it("hybrid beats remote when both appear", () => {
    expect(detectWorkMode({ location: "Hybrid (remote-friendly)" })).toBe("hybrid");
  });

  it("falls back to the title, then to unknown", () => {
    expect(detectWorkMode({ location: "Berlin", title: "Remote Sales Engineer" })).toBe("remote");
    expect(detectWorkMode({ location: "Berlin", title: "Sales Engineer" })).toBe("unknown");
    expect(detectWorkMode({})).toBe("unknown");
  });
});

describe("detectWorkMode — adversarial input (location is untrusted)", () => {
  const cases: Array<[string, string, string]> = [
    ["repeated 'remote '", "remote ".repeat(28_000), "remote"],
    ["200k newlines", "\n".repeat(200_000), "unknown"],
    ["1M letters", "a".repeat(1_000_000), "unknown"],
  ];

  it.each(cases)("%s in a location finishes in under a second", (_name, input, expected) => {
    const started = performance.now();
    const result = detectWorkMode({ location: input });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toBe(expected);
  });
});
