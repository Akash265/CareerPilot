import type { SponsorshipValue } from "../src/types";

/**
 * A hand-labeled evaluation set for the deterministic extractors (CLAUDE.md §10). Each case is a short
 * excerpt in the exact shape of a real posting (formats observed in ~1,430 live Greenhouse/Lever
 * postings on 2026-09-21; wording trimmed). `undefined` means "this case does not test that field";
 * `null` means "the correct answer is: nothing to extract".
 *
 * ADD A CASE whenever a real posting is mis-read, before fixing the rule.
 */
export interface EvalCase {
  name: string;
  text: string;
  salary?: { min: number; max: number; currency: string; period: "year" | "month" | "hour" } | null;
  minExperience?: number | null;
  sponsorship?: SponsorshipValue;
}

const usd = (min: number, max: number) => ({ min, max, currency: "USD", period: "year" as const });

export const CASES: EvalCase[] = [
  // ---- salary: formats that must parse ----
  { name: "salary: plain annual range", text: "The base salary range for this role is $150,000 - $200,000 per year.", salary: usd(150000, 200000) },
  { name: "salary: monthly MXN, trailing code overrides the $ (Airbnb Mexico)", text: "Mexico Monthly Pay Range\n$43,500 — $48,333 MXN", salary: { min: 522000, max: 579996, currency: "MXN", period: "month" } },
  { name: "salary: R$ is BRL, dot thousands (Airbnb Brazil)", text: "Brazil Monthly Pay Range\nR$14.000 — R$17.500 BRL", salary: { min: 168000, max: 210000, currency: "BRL", period: "month" } },
  { name: "salary: European dot thousands", text: "The annual salary range is €71.000 — €84.000 EUR", salary: { min: 71000, max: 84000, currency: "EUR", period: "year" } },
  { name: "salary: repeated trailing code", text: "The salary range is 296,000 PLN — 350,000 PLN per year", salary: { min: 296000, max: 350000, currency: "PLN", period: "year" } },
  { name: "salary: no separator between amounts (Spotify)", text: "The United States base range for this position is $184,050 $262,928 plus equity.", salary: usd(184050, 262928) },
  { name: "salary: per-unit suffix between amounts (Palantir)", text: "The salary range for this position is estimated to be $28/hour to $47/hour.", salary: { min: 58240, max: 97760, currency: "USD", period: "hour" } },
  { name: "salary: k suffix, period inferred from magnitude", text: "Compensation: $120k - $150k", salary: usd(120000, 150000) },
  { name: "salary: explicit CAD", text: "Pay Range\n$83,000 — $98,000 CAD", salary: { min: 83000, max: 98000, currency: "CAD", period: "year" } },
  { name: "salary: GBP with repeated trailing code", text: "Pay Range\n£46,000 — £54,000 GBP", salary: { min: 46000, max: 54000, currency: "GBP", period: "year" } },
  // ---- salary: things that must NOT parse ----
  { name: "no salary: market-size figures (Stripe)", text: "Businesses processing $20M–$50M in annual payment volume. We are attacking a $100B market and moved $1.4T in annual volume.", salary: null },
  { name: "no salary: bonus and equity amounts", text: "This role is also eligible for a signing bonus of $10,000 and equity.", salary: null },
  { name: "no salary: a benefit, not pay", text: "We offer a $500 learning stipend and free lunch.", salary: null },
  { name: "no salary: conflicting regional ranges are left unparsed", text: "US: the base salary range is $150,000 - $200,000. UK: the base salary range is £100,000 - £130,000.", salary: null },
  { name: "no salary: nothing stated", text: "We are hiring a data engineer to build pipelines.", salary: null },
  // ---- minimum experience ----
  { name: "experience: N+ years of experience", text: "Requirements\n- 5+ years of experience in software engineering", minExperience: 5 },
  { name: "experience: words between years and experience", text: "8+ years of sales experience, preferably in a technical product", minExperience: 8 },
  { name: "experience: range takes the lower bound", text: "2-4 years of experience with SQL", minExperience: 2 },
  { name: "experience: nice-to-have line ignored", text: "- 6+ years of experience in sales\n- 2+ years of hospitality experience (nice to have)", minExperience: 6 },
  { name: "experience: company boast ignored", text: "We have over 15 years of experience serving customers.", minExperience: null },
  { name: "experience: no space before 'years'", text: "Minimum 2years post-qualification experience", minExperience: 2 },
  { name: "experience: years in business is not experience", text: "We have been in business for 10 years.", minExperience: null },
  // ---- sponsorship ----
  { name: "sponsorship: not available (real)", text: "Proficiency in Mandarin is required. Visa sponsorship is not available. Location: fully remote.", sponsorship: "not_offered" },
  { name: "sponsorship: unable to offer", text: "We are unable to offer visa sponsorship for this role.", sponsorship: "not_offered" },
  { name: "sponsorship: right to work (real)", text: "Candidates must have the right to work in Ireland by the start date.", sponsorship: "not_offered" },
  { name: "sponsorship: available", text: "Visa sponsorship is available for this position.", sponsorship: "offered" },
  { name: "sponsorship: can sponsor", text: "We can sponsor your visa and help you relocate.", sponsorship: "offered" },
  { name: "sponsorship: event sponsorship is unrelated (real Stripe)", text: "activating Stripe's global sponsorship portfolio to deliver premium experiences", sponsorship: "unknown" },
  { name: "sponsorship: executive sponsor is unrelated (real Stripe)", text: "serving as executive sponsor with key relationships", sponsorship: "unknown" },
  { name: "sponsorship: financial sponsor is unrelated (real Stripe)", text: "Represent Stripe in the financial sponsor ecosystem", sponsorship: "unknown" },
  { name: "sponsorship: contradictory statements stay unknown", text: "Visa sponsorship is available for some roles. We do not sponsor visas for contractors.", sponsorship: "unknown" },
  { name: "sponsorship: silent", text: "Build data pipelines.", sponsorship: "unknown" },
];
