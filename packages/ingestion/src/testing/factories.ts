import { companyKey, descriptionHash, locationKey, titleKey } from "../normalize/keys";
import type { NormalizedJob } from "../types";

/** A minimal valid NormalizedJob; keys/hashes are derived from the fields you override. */
export function makeNormalized(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  const companyName = overrides.companyName ?? "Acme";
  const title = overrides.title ?? "Data Engineer";
  const locationRaw = overrides.locationRaw !== undefined ? overrides.locationRaw : "Berlin";
  const descriptionText = overrides.descriptionText ?? "Build data pipelines.";
  const tk = titleKey(title);
  return {
    externalId: "ext-1",
    url: "https://acme.example/jobs/1",
    companyName,
    companyKey: companyKey(companyName),
    title,
    titleKey: tk.titleKey,
    seniority: tk.seniority,
    locationRaw,
    locationKey: locationKey(locationRaw),
    countryCode: null,
    workMode: "unknown",
    employmentType: null,
    descriptionText,
    descriptionHash: descriptionHash(descriptionText),
    salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false },
    minExperience: { years: null, evidence: null },
    sponsorship: { value: "unknown", evidence: null, conflict: false },
    postedAt: null,
    ...overrides,
  };
}
