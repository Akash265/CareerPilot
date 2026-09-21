import { describe, it, expect } from "vitest";
import { extractSponsorship } from "./sponsorship";

describe("extractSponsorship", () => {
  it("detects not_offered phrasings", () => {
    for (const text of [
      "Visa sponsorship is not available.",
      "We are unable to offer visa sponsorship for this role.",
      "No visa sponsorship will be provided.",
      "We cannot sponsor work visas at this time.",
      "Candidates must have the right to work in Ireland by the start date.",
      "You must be able to work without sponsorship.",
    ]) {
      expect(extractSponsorship(text).value).toBe("not_offered");
    }
  });

  it("detects offered phrasings", () => {
    for (const text of [
      "Visa sponsorship is available for this position.",
      "We offer visa sponsorship to qualified candidates.",
      "We can sponsor your visa and help you relocate.",
    ]) {
      expect(extractSponsorship(text).value).toBe("offered");
    }
  });

  it("does not treat unrelated 'sponsor' senses as visa sponsorship (real Stripe text)", () => {
    for (const text of [
      "activating Stripe's global sponsorship portfolio to deliver premium experiences",
      "serving as executive sponsor with key relationships",
      "Represent Stripe in the financial sponsor ecosystem",
      "We do not do event sponsorship.",
    ]) {
      expect(extractSponsorship(text)).toEqual({ value: "unknown", evidence: null, conflict: false });
    }
  });

  it("a negated sentence is not also counted as an offer", () => {
    const r = extractSponsorship("We cannot sponsor work visas.");
    expect(r.value).toBe("not_offered");
    expect(r.conflict).toBe(false);
  });

  it("flags a genuine conflict as unknown with both snippets", () => {
    const r = extractSponsorship("Visa sponsorship is available for some roles. We do not sponsor visas for contractors.");
    expect(r.value).toBe("unknown");
    expect(r.conflict).toBe(true);
    expect(r.evidence).toContain("||");
  });

  it("evidence for a conflict is contiguous text from the posting, on both sides of the '||'", () => {
    for (const text of [
      "Visa sponsorship is available for some roles. We do not sponsor visas for contractors. Also we cannot sponsor work visas for interns.",
      "We can sponsor your visa. Contractors: we cannot sponsor work visas. Interns: no visa sponsorship is offered.",
    ]) {
      const r = extractSponsorship(text);
      expect(r.value).toBe("unknown");
      expect(r.conflict).toBe(true);
      const parts = r.evidence!.split(" || ");
      expect(parts).toHaveLength(2);
      for (const part of parts) expect(text.includes(part)).toBe(true);
    }
  });

  it("evidence for a not_offered-only posting is a contiguous substring", () => {
    const text = "Great team. We cannot sponsor work visas for this role. Apply today.";
    const r = extractSponsorship(text);
    expect(r.value).toBe("not_offered");
    expect(r.conflict).toBe(false);
    expect(text.includes(r.evidence!)).toBe(true);
  });

  it("several negated clauses stay not_offered (a later negation is not read as an offer)", () => {
    for (const text of [
      "We cannot sponsor work visas. We are unable to offer visa sponsorship.",
      "Visa sponsorship is not available. Also, no visa sponsorship for contractors.",
    ]) {
      const r = extractSponsorship(text);
      expect(r.value).toBe("not_offered");
      expect(r.conflict).toBe(false);
    }
  });

  it("returns unknown with no evidence when the posting says nothing", () => {
    expect(extractSponsorship("Build data pipelines.")).toEqual({ value: "unknown", evidence: null, conflict: false });
  });
});

describe("extractSponsorship — adversarial input (posting text is untrusted)", () => {
  const cases: Array<[string, string]> = [
    ["repeated 'not '", "not ".repeat(50_000)],
    ["repeated 'sponsor '", "sponsor ".repeat(25_000)],
    ["repeated 'no visa '", "no visa ".repeat(25_000)],
    ["repeated 'cannot sponsor '", "cannot sponsor ".repeat(14_000)],
    ["repeated 'must be '", "must be ".repeat(25_000)],
    ["200k newlines", "\n".repeat(200_000)],
    ["1M letters", "a".repeat(1_000_000)],
  ];

  it.each(cases)("%s finishes in under a second and finds nothing", (_name, input) => {
    const started = performance.now();
    const result = extractSponsorship(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toEqual({ value: "unknown", evidence: null, conflict: false });
  });

  it("dense repeated negations finish in under a second and stay not_offered", () => {
    const started = performance.now();
    const result = extractSponsorship("We cannot sponsor work visas. ".repeat(6_000));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result.value).toBe("not_offered");
    expect(result.conflict).toBe(false);
  });
});
