import { describe, it, expect } from "vitest";
import { scoreSponsorship } from "./scoreSponsorship";

describe("scoreSponsorship", () => {
  it("gives full credit when sponsorship is not required", () => {
    expect(scoreSponsorship(false, "not_offered")).toBe(1);
    expect(scoreSponsorship(null, "not_offered")).toBe(1);
  });
  it("gives full credit when required and offered", () => {
    expect(scoreSponsorship(true, "offered")).toBe(1);
  });
  it("gives partial credit when required and unknown", () => {
    expect(scoreSponsorship(true, "unknown")).toBe(0.5);
  });
  it("gives zero when required and explicitly not offered", () => {
    expect(scoreSponsorship(true, "not_offered")).toBe(0);
  });
});
