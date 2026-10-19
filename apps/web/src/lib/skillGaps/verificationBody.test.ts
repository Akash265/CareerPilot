import { describe, it, expect } from "vitest";
import { SkillVerificationBodySchema } from "./verificationBody";

const ok = (v: unknown) => SkillVerificationBodySchema.safeParse(v).success;

describe("SkillVerificationBodySchema", () => {
  it("accepts the three answers and trims", () => {
    expect(SkillVerificationBodySchema.parse({ status: "have", termDisplay: " CI/CD ", evidence: " Set up GitHub Actions. " }))
      .toEqual({ status: "have", termDisplay: "CI/CD", evidence: "Set up GitHub Actions." });
    expect(ok({ status: "dont_have", termDisplay: "C#" })).toBe(true);
    expect(ok({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "Postgres" })).toBe(true);
  });
  it("rejects a 'have' without evidence, blank or overlong fields, and extra keys", () => {
    expect(ok({ status: "have", termDisplay: "K8s" })).toBe(false);
    expect(ok({ status: "have", termDisplay: "K8s", evidence: "   " })).toBe(false);
    expect(ok({ status: "have", termDisplay: "K8s", evidence: "x".repeat(301) })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "" })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "x".repeat(201) })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "K8s", evidence: "sneaky" })).toBe(false);
    expect(ok({ status: "maybe", termDisplay: "K8s" })).toBe(false);
  });
});
