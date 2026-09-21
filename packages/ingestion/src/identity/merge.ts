import type { NormalizedJob, SalaryPeriod, SourceKind, SponsorshipValue, WorkMode } from "../types";

export interface PostingForMerge {
  id: string;
  sourceKind: SourceKind;
  status: "open" | "closed";
  firstSeenAt: Date;
  lastSeenAt: Date;
  normalized: NormalizedJob;
}

export interface MergedJob {
  companyName: string;
  companyKey: string;
  title: string;
  titleKey: string;
  seniority: string | null;
  locationRaw: string | null;
  locationKey: string;
  countryCode: string | null;
  workMode: WorkMode;
  employmentType: string | null;
  descriptionText: string;
  descriptionHash: string;
  salaryRaw: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  salaryIsParsed: boolean;
  minExperienceYears: number | null;
  minExperienceEvidence: string | null;
  sponsorship: SponsorshipValue;
  sponsorshipEvidence: string | null;
  sponsorshipConflict: boolean;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastVerifiedAt: Date;
  status: "open" | "closed";
  /** field group -> id of the posting that supplied it. */
  fieldProvenance: Record<string, string>;
}

// Structured ATS APIs are more trustworthy than a hand-uploaded file.
const SOURCE_RANK: Record<SourceKind, number> = { greenhouse: 2, lever: 2, upload: 1 };

/** Sort order for "who wins a conflict": open first, then source rank, then most recently seen, then id (stable). */
export function comparePostings(a: PostingForMerge, b: PostingForMerge): number {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  const rank = SOURCE_RANK[b.sourceKind] - SOURCE_RANK[a.sourceKind];
  if (rank !== 0) return rank;
  const seen = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  if (seen !== 0) return seen;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergePostings(postings: PostingForMerge[]): MergedJob {
  if (postings.length === 0) throw new Error("mergePostings requires at least one posting");
  const sorted = [...postings].sort(comparePostings);
  const winner = sorted[0];
  const firstWith = (test: (n: NormalizedJob) => boolean) => sorted.find((p) => test(p.normalized));
  const provenance: Record<string, string> = { identity: winner.id, description: winner.id };

  // Location, country and locationKey travel together: they describe one place.
  const location = firstWith((n) => n.locationKey !== "") ?? winner;
  provenance.location = location.id;
  const mode = firstWith((n) => n.workMode !== "unknown") ?? winner;
  provenance.workMode = mode.id;
  const employment = firstWith((n) => n.employmentType !== null);
  if (employment) provenance.employmentType = employment.id;
  const salary = firstWith((n) => n.salary.isParsed) ?? firstWith((n) => n.salary.raw !== null) ?? winner;
  provenance.salary = salary.id;
  const experience = firstWith((n) => n.minExperience.years !== null);
  if (experience) provenance.minExperience = experience.id;
  const sponsorship =
    firstWith((n) => n.sponsorship.value !== "unknown") ?? firstWith((n) => n.sponsorship.conflict) ?? winner;
  provenance.sponsorship = sponsorship.id;

  // The original posted date is the earliest one any source reports.
  let posted: PostingForMerge | undefined;
  for (const p of postings) {
    const d = p.normalized.postedAt;
    if (d && (!posted || d < (posted.normalized.postedAt as Date))) posted = p;
  }
  if (posted) provenance.postedAt = posted.id;

  const open = postings.filter((p) => p.status === "open");
  const verifiedFrom = open.length > 0 ? open : postings;
  const maxTime = (list: PostingForMerge[]) => new Date(Math.max(...list.map((p) => p.lastSeenAt.getTime())));

  const w = winner.normalized;
  const s = salary.normalized.salary;
  return {
    companyName: w.companyName,
    companyKey: w.companyKey,
    title: w.title,
    titleKey: w.titleKey,
    seniority: w.seniority,
    locationRaw: location.normalized.locationRaw,
    locationKey: location.normalized.locationKey,
    countryCode: location.normalized.countryCode,
    workMode: mode.normalized.workMode,
    employmentType: employment?.normalized.employmentType ?? null,
    descriptionText: w.descriptionText,
    descriptionHash: w.descriptionHash,
    salaryRaw: s.raw,
    salaryMin: s.min,
    salaryMax: s.max,
    salaryCurrency: s.currency,
    salaryPeriod: s.period,
    salaryIsParsed: s.isParsed,
    minExperienceYears: experience?.normalized.minExperience.years ?? null,
    minExperienceEvidence: experience?.normalized.minExperience.evidence ?? null,
    sponsorship: sponsorship.normalized.sponsorship.value,
    sponsorshipEvidence: sponsorship.normalized.sponsorship.evidence,
    sponsorshipConflict: sponsorship.normalized.sponsorship.conflict,
    postedAt: posted?.normalized.postedAt ?? null,
    firstSeenAt: new Date(Math.min(...postings.map((p) => p.firstSeenAt.getTime()))),
    lastVerifiedAt: maxTime(verifiedFrom),
    status: open.length > 0 ? "open" : "closed",
    fieldProvenance: provenance,
  };
}
