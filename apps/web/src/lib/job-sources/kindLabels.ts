import type { JobSourceView } from "./serializeSource";

/** Display names for every source kind (Phase 12 added six ATS boards' worth and eight search providers). */
export const SOURCE_KIND_LABELS: Record<JobSourceView["kind"], string> = {
  greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workable: "Workable", smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee", upload: "File upload", adzuna: "Adzuna", jooble: "Jooble", usajobs: "USAJobs", themuse: "The Muse",
  remotive: "Remotive", remoteok: "Remote OK", arbeitnow: "Arbeitnow", hn_hiring: "HN Who is hiring",
};
