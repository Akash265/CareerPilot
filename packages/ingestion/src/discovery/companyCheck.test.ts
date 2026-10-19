import { describe, it, expect } from "vitest";
import { checkCompany } from "./companyCheck";

const base = { foundVia: "name_probe" as const, expectedCompany: "Acme Robotics", slug: "acmerobotics", descriptionText: null };

describe("checkCompany (Phase 13a)", () => {
  it("accepts boards from posting links and pastes without checking", () => {
    expect(checkCompany({ ...base, foundVia: "posting_link", companyName: "Someone Else" })).toBe("ok");
    expect(checkCompany({ ...base, foundVia: "pasted", companyName: "Someone Else" })).toBe("ok");
  });

  it("accepts a name that matches after normalization, or where one name starts with the other", () => {
    expect(checkCompany({ ...base, companyName: "Acme Robotics GmbH" })).toBe("ok");
    expect(checkCompany({ ...base, companyName: "ACME" })).toBe("ok");
    expect(checkCompany({ ...base, expectedCompany: "Acme", companyName: "Acme Robotics Inc." })).toBe("ok");
  });

  it("rejects a different company's name", () => {
    expect(checkCompany({ ...base, companyName: "Acmeson Foods" })).toBe("company_mismatch");
    expect(checkCompany({ ...base, foundVia: "web_search", companyName: "Globex" })).toBe("company_mismatch");
  });

  it("treats a missing name (or the slug fallback) as unknown: probes need the description to name the company", () => {
    expect(checkCompany({ ...base, companyName: null })).toBe("company_unverified");
    expect(checkCompany({ ...base, companyName: "acmerobotics" })).toBe("company_unverified");
    expect(checkCompany({ ...base, companyName: null, descriptionText: "At Acme Robotics we build arms." })).toBe("ok");
    expect(checkCompany({ ...base, companyName: null, descriptionText: "We are Acmerobotic fans." })).toBe("company_unverified");
  });

  it("accepts an unnamed web-search board: the search result itself is the evidence", () => {
    expect(checkCompany({ ...base, foundVia: "web_search", companyName: null })).toBe("ok");
  });

  it("accepts any board with no expected company recorded", () => {
    expect(checkCompany({ ...base, expectedCompany: null, companyName: "Globex" })).toBe("ok");
  });
});
